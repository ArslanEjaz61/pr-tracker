// /api/track.js — Serper.dev & Google News RSS hybrid PR coverage tracking
// Searches Google News RSS (free & unlimited) first, then falls back to Serper API.
// Sends each found URL to n8n for AI analysis & MongoDB storage.

export const maxDuration = 300; // Allow up to 5 minutes on Vercel Pro (60s on Hobby)

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const N8N_ANALYZE   = process.env.NEXT_PUBLIC_N8N_ANALYZE;

/**
 * Decode XML entities in RSS feed content
 */
function decodeXmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
}

/**
 * Clean source suffix from title (e.g. "Title - The Verge" -> "Title")
 */
function cleanTitle(title, source) {
  if (!title || !source) return title;
  const suffix = ` - ${source}`;
  if (title.toLowerCase().endsWith(suffix.toLowerCase())) {
    return title.substring(0, title.length - suffix.length).trim();
  }
  return title;
}

/**
 * Resolve Google News redirect URL to the original publisher URL
 * Uses Google's internal batchexecute RPC endpoint
 */
async function resolveGoogleNewsUrl(googleNewsUrl, retries = 3, timeoutMs = 6000) {
  if (!googleNewsUrl || !googleNewsUrl.includes('news.google.com/rss/articles/')) {
    return googleNewsUrl;
  }
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      
      const res = await fetch(googleNewsUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      
      clearTimeout(id);
      
      if (!res.ok) {
        throw new Error(`Page fetch status: ${res.status}`);
      }
      
      const html = await res.text();
      const match = html.match(/<c-wiz[^>]*\bdata-p="([^"]+)"/);
      const dataP = match ? match[1] : null;
      
      if (!dataP) {
        const matchFallback = html.match(/data-p="([^"]+)"/);
        if (!matchFallback) {
          throw new Error('data-p not found');
        }
        return await processDataP(matchFallback[1], timeoutMs);
      }
      
      return await processDataP(dataP, timeoutMs);
    } catch (err) {
      console.log(`[Track] [Resolve Attempt ${attempt}/${retries}] Failed for ${googleNewsUrl.substring(0, 60)}...: ${err.message}`);
      if (attempt === retries) {
        console.error(`[Track] [Resolve Final Failure] for ${googleNewsUrl.substring(0, 60)}...: ${err.message}`);
        return null;
      }
      // Staggered delay for retries to avoid rate-limiting
      await new Promise(r => setTimeout(r, 100 * attempt));
    }
  }
}

/**
 * Handle protobuf parsing and POST request to Google's batchexecute RPC
 */
async function processDataP(dataPVal, timeoutMs) {
  const decodedDataP = dataPVal
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  const rawJson = decodedDataP.replace('%.@.', '["garturlreq",');
  const obj = JSON.parse(rawJson);
  const payload = {
    'f.req': JSON.stringify([[
      ['Fbv4je', JSON.stringify([...obj.slice(0, -6), ...obj.slice(-2)]), 'null', 'generic']
    ]])
  };
  const bodyParams = new URLSearchParams(payload).toString();
  
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  
  const postRes = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: bodyParams
  });
  
  clearTimeout(id);
  
  if (!postRes.ok) throw new Error(`batchexecute status: ${postRes.status}`);
  const text = await postRes.text();
  const cleanedText = text.replace(/^\)\]\}\'\n/, '');
  const outerArr = JSON.parse(cleanedText);
  const arrayString = outerArr[0][2];
  const innerArr = JSON.parse(arrayString);
  return innerArr[1];
}

/**
 * Fetch Google News RSS feed and parse articles
 */
async function googleNewsRssSearch(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) {
      console.error(`[Track] RSS fetch failed: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    const items = [];
    while ((match = itemRegex.exec(xml)) !== null) {
      const itemContent = match[1];
      const titleMatch = itemContent.match(/<title>([\s\S]*?)<\/title>/);
      const linkMatch = itemContent.match(/<link>([\s\S]*?)<\/link>/);
      const pubDateMatch = itemContent.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const sourceMatch = itemContent.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      
      const title = titleMatch ? decodeXmlEntities(titleMatch[1]) : '';
      const link = linkMatch ? linkMatch[1] : '';
      const pubDate = pubDateMatch ? pubDateMatch[1] : '';
      const source = sourceMatch ? decodeXmlEntities(sourceMatch[1]) : '';
      
      if (link) {
        items.push({
          title,
          link,
          pubDate,
          source
        });
      }
    }
    return items;
  } catch (err) {
    console.error(`[Track] RSS Search error for "${query}":`, err.message);
    return [];
  }
}

/**
 * Search Google via Serper.dev Web API
 */
async function serperSearch(query, num = 20) {
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[Track] Serper Web API error:', res.status, text);
      return [];
    }

    const data = await res.json();
    return data.organic || [];
  } catch (err) {
    console.error('[Track] Serper Web search error:', err.message);
    return [];
  }
}

/**
 * Search Google News via Serper.dev News API
 */
async function serperNewsSearch(query, num = 20) {
  try {
    const res = await fetch('https://google.serper.dev/news', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[Track] Serper News API error:', res.status, text);
      return [];
    }

    const data = await res.json();
    return data.news || [];
  } catch (err) {
    console.error('[Track] Serper News search error:', err.message);
    return [];
  }
}

/**
 * Extract key proper nouns/entities from a document using OpenAI
 */
async function extractEntitiesWithAi(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const payload = {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: `Analyze the following press release/text and extract the 3 most unique proper nouns (e.g. specific person names, unique brand/company names, or rare event names). Do not extract generic words like "announcement", "Pakistan", "media", or "press release". Return a JSON object:
{
  "entities": ["entity1", "entity2", "entity3"]
}

Text:
${text.substring(0, 3000)}`
        }
      ],
      temperature: 0.1,
      max_tokens: 100
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    const content = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return content.entities || null;
  } catch (err) {
    console.error('[Track] AI Entity extraction failed:', err.message);
    return null;
  }
}

/**
 * Extract 3-4 unique/distinctive phrases from press release text (Fallback)
 */
function extractKeyPhrases(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 30 && s.length < 200);
  
  if (sentences.length === 0) {
    const words = clean.split(' ');
    const phrases = [];
    for (let i = 0; i < Math.min(words.length, 40); i += 8) {
      const phrase = words.slice(i, i + 8).join(' ');
      if (phrase.length > 20) phrases.push(phrase);
    }
    return phrases.slice(0, 3);
  }
  
  const scored = sentences.map(s => ({
    text: s,
    score: (s.match(/[A-Z][a-z]+/g) || []).length * 2 
         + (s.match(/\d+/g) || []).length * 3
         + (s.match(/"/g) || []).length
         + (s.length > 50 ? 1 : 0),
  }));
  
  scored.sort((a, b) => b.score - a.score);
  
  const selected = scored.slice(0, 3).map(s => {
    const words = s.text.split(' ');
    return words.slice(0, 10).join(' ');
  });
  
  return selected;
}

/**
 * Use AI to expand a hashtag into its full name and related search terms.
 * e.g. "#60SIFF" -> { fullName: "60 Second International Film Festival", aliases: ["60SIFF", "60 sec film fest"], relatedTerms: ["short film festival Pakistan"] }
 */
async function expandHashtagWithAi(hashtag) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const payload = {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: `You are a research assistant. Given the hashtag "${hashtag}", identify what it refers to and return a JSON object with:
{
  "fullName": "the full official name this hashtag represents",
  "aliases": ["list of 3-5 alternative names, abbreviations, or spellings people use for this"],
  "relatedTerms": ["2-3 broader contextual search terms that would find articles about this"]
}

For example:
- "#60SIFF" -> {"fullName": "60 Second International Film Festival", "aliases": ["60SIFF", "60 Second Film Festival", "60 sec film fest", "60 Second Intl Film Festival"], "relatedTerms": ["short film festival", "60 second film competition"]}
- "#UNFPA" -> {"fullName": "United Nations Population Fund", "aliases": ["UNFPA", "UN Population Fund"], "relatedTerms": ["UN agency reproductive health"]}
- "#COP28" -> {"fullName": "28th Conference of the Parties", "aliases": ["COP28", "COP 28", "UN Climate Conference 2023"], "relatedTerms": ["climate summit Dubai", "UN climate change conference"]}

If you cannot identify the hashtag, return: {"fullName": "", "aliases": [], "relatedTerms": []}`
        }
      ],
      temperature: 0.1,
      max_tokens: 300
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    const content = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    console.log('[Track] AI hashtag expansion:', JSON.stringify(content));
    return content;
  } catch (err) {
    console.error('[Track] AI hashtag expansion failed:', err.message);
    return null;
  }
}

/**
 * Build search queries based on tracking type
 */
async function buildSearchQueries(searchType, query) {
  switch (searchType) {
    case 'title': {
      const words = query.split(/\s+/).filter(w => w.length > 2);
      const queries = [
        `"${query}"`,
        query,
      ];
      // If title has 5+ words, also try first 5 and last 5 words
      if (words.length >= 6) {
        queries.push(words.slice(0, 5).join(' '));
        queries.push(words.slice(-5).join(' '));
      }
      return queries;
    }
    
    case 'keywords': {
      const queries = [
        `"${query}"`,
        query,
      ];
      // If multiple keywords (comma or space separated), search each individually too
      const parts = query.split(/[,;]+/).map(s => s.trim()).filter(s => s.length > 2);
      if (parts.length > 1) {
        for (const p of parts) {
          queries.push(`"${p}"`);
          queries.push(p);
        }
      }
      return queries;
    }
    
    case 'hashtag': {
      const tag = query.startsWith('#') ? query : `#${query}`;
      const tagNoHash = query.startsWith('#') ? query.slice(1) : query;
      // Split camelCase/numbers: "60SIFF" -> "60 SIFF"
      const expanded = tagNoHash.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/(\d+)([A-Za-z])/g, '$1 $2');
      
      // Start with basic queries
      const queries = [
        `"${tag}"`,
        `"${tagNoHash}"`,
        tagNoHash,
        `${tagNoHash} news`,
        `${tagNoHash} article`,
        `${tagNoHash} press release`,
        `${tag} site:instagram.com OR site:facebook.com OR site:twitter.com OR site:x.com`,
      ];
      
      // Add expanded version if different from original
      if (expanded !== tagNoHash) {
        queries.push(`"${expanded}"`);
        queries.push(expanded);
      }
      
      // Use AI to get the full name and related terms
      const aiExpansion = await expandHashtagWithAi(tag);
      if (aiExpansion) {
        // Add full official name (most important for finding articles)
        if (aiExpansion.fullName) {
          queries.push(`"${aiExpansion.fullName}"`);
          queries.push(aiExpansion.fullName);
          queries.push(`${aiExpansion.fullName} news`);
          queries.push(`${aiExpansion.fullName} article`);
        }
        // Add aliases
        if (aiExpansion.aliases && aiExpansion.aliases.length > 0) {
          for (const alias of aiExpansion.aliases) {
            if (alias.toLowerCase() !== tagNoHash.toLowerCase()) {
              queries.push(`"${alias}"`);
              queries.push(alias);
            }
          }
        }
        // Add related contextual terms
        if (aiExpansion.relatedTerms && aiExpansion.relatedTerms.length > 0) {
          for (const term of aiExpansion.relatedTerms) {
            queries.push(term);
          }
        }
      }
      
      return queries;
    }
    
    case 'document': {
      // Try AI entity extraction first
      const aiEntities = await extractEntitiesWithAi(query);
      if (aiEntities && aiEntities.length > 0) {
        console.log('[Track] AI extracted entities for document search:', aiEntities);
        const fullIntersection = aiEntities.map(e => `"${e}"`).join(' ');
        const queries = [fullIntersection];
        if (aiEntities.length >= 2) {
          queries.push(`"${aiEntities[0]}" "${aiEntities[1]}"`);
        }
        // Also search each entity individually
        for (const entity of aiEntities) {
          queries.push(`"${entity}"`);
        }
        return queries;
      }
      // Fallback to old sentence match
      const phrases = extractKeyPhrases(query);
      return phrases.map(p => `"${p}"`).concat(phrases.map(p => `${p}`));
    }
    
    default:
      return [query];
  }
}

/**
 * Deduplicate raw RSS search items by Google News link and title
 */
function deduplicateRssRaw(results) {
  const seenLinks = new Set();
  const seenTitles = new Set();
  return results.filter(r => {
    if (!r.link) return false;
    if (seenLinks.has(r.link)) return false;
    seenLinks.add(r.link);
    
    const normalizedTitle = (r.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedTitle && seenTitles.has(normalizedTitle)) return false;
    seenTitles.add(normalizedTitle);
    
    return true;
  });
}

/**
 * Deduplicate results by URL domain+path
 */
function deduplicateResults(results) {
  const seen = new Set();
  return results.filter(r => {
    if (!r.link) return false;
    try {
      const url = new URL(r.link);
      const key = (url.hostname + url.pathname).toLowerCase().replace(/\/+$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    } catch {
      return true;
    }
  });
}

/**
 * Filter out irrelevant results (social media profiles, search engines, etc.)
 */
function filterRelevantResults(results, keepSocial = false) {
  // Core domains to always exclude (search engines only)
  const alwaysExclude = [
    'google.com/search', 'bing.com/search', 'yahoo.com/search',
  ];
  
  // Social domains to optionally exclude
  const socialDomains = [
    'linkedin.com/in/', 'youtube.com/channel', 'pinterest.com',
  ];
  
  const excludeList = keepSocial ? alwaysExclude : [...alwaysExclude, ...socialDomains];
  
  return results.filter(r => {
    if (!r.link) return false;
    const url = r.link.toLowerCase();
    for (const d of excludeList) {
      if (url.includes(d)) return false;
    }
    return true;
  });
}

/**
 * Analyze a single URL via n8n webhook
 */
async function analyzeUrl(url, query) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout per URL
    
    const res = await fetch(N8N_ANALYZE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, search_query: query }),
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!res.ok) {
      console.error(`[Track] n8n analyze failed for ${url}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`[Track] Error analyzing ${url}:`, err.message);
    return null;
  }
}

/**
 * Analyze URLs in batches to avoid overwhelming n8n
 */
async function analyzeInBatches(urls, batchSize = 25, query, onProgress) {
  const results = [];
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    console.log(`[Track] Analyzing batch ${Math.floor(i/batchSize) + 1}: ${batch.map(r => r.link).join(', ')}`);
    const batchResults = await Promise.all(batch.map(r => analyzeUrl(r.link, query)));
    results.push(...batchResults);
    
    if (onProgress) {
      onProgress(Math.min(i + batchSize, urls.length), urls.length);
    }
    
    if (i + batchSize < urls.length) {
      await new Promise(resolve => setTimeout(resolve, 200)); // Reduced delay for faster processing
    }
  }
  return results;
}

/**
 * Quick URL verification to filter out fake/hallucinated links
 */
async function verifyUrlExists(url) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { 
      method: 'HEAD', 
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    clearTimeout(id);
    return res.ok || res.status === 403 || res.status === 401 || res.status === 405; 
  } catch (e) {
    return false;
  }
}

/**
 * Ask ChatGPT to find online articles
 */
async function searchWithChatGPT(query) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  try {
    const payload = {
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: `Find real, authentic online articles, news, and press releases about "${query}". 
Return ONLY a JSON object containing an array of objects under the key "articles". 
Each object must have "title", "link", and "source".
IMPORTANT: Do not make up or hallucinate URLs. Only provide URLs that you are highly confident actually exist. Provide as many as you can find.`
        }
      ],
      temperature: 0.2,
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    const content = JSON.parse(data.choices?.[0]?.message?.content || '{"articles":[]}');
    
    const articles = content.articles || [];
    const validArticles = [];
    
    for (const a of articles) {
      if (a.link && a.link.startsWith('http')) {
        validArticles.push(a);
      }
    }
    
    console.log(`[Track] ChatGPT suggested ${validArticles.length} potential articles for "${query}"`);
    return validArticles;
  } catch (err) {
    console.error('[Track] ChatGPT search failed:', err.message);
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Set up SSE headers for real-time streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Prevent Nginx buffering
  
  const sendProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const { searchType, query, targets } = req.body;

  let activeTargets = [];
  if (targets && Array.isArray(targets)) {
    activeTargets = targets.filter(t => t.query && t.query.trim());
  } else if (searchType && query) {
    activeTargets = [{ type: searchType, query }];
  }

  if (activeTargets.length === 0) {
    sendProgress({ type: 'error', error: 'Missing searchType, query or targets' });
    return res.end();
  }

  // Combine query titles/keywords for campaign tracking label
  const combinedQuery = activeTargets.map(t => t.query.trim()).join(' | ');

  try {
    sendProgress({ type: 'progress', message: 'Generating search queries...' });
    // Step 1: Build search queries based on tracking targets
    let targetQueriesList = [];
    for (const target of activeTargets) {
      const tQueries = await buildSearchQueries(target.type, target.query.trim());
      targetQueriesList.push({ type: target.type, original: target.query.trim(), queries: tQueries });
    }

    // Generate combined queries
    let queries = [];
    if (targetQueriesList.length === 1) {
      queries = targetQueriesList[0].queries;
    } else {
      // 1. Full AND intersection of all targets using their most specific exact match query (first query element)
      const intersectionParts = targetQueriesList.map(t => t.queries[0]);
      const fullIntersection = intersectionParts.join(' ');
      queries.push(fullIntersection);

      // 2. Pairwise intersections if there are 3 or more targets
      if (targetQueriesList.length >= 3) {
        for (let i = 0; i < targetQueriesList.length; i++) {
          for (let j = i + 1; j < targetQueriesList.length; j++) {
            queries.push(`${targetQueriesList[i].queries[0]} ${targetQueriesList[j].queries[0]}`);
          }
        }
      }

      // 3. Fallback to the individual queries of the first target (assuming first target is the main topic like Hashtag/Title)
      queries.push(...targetQueriesList[0].queries);
    }

    // Deduplicate query list
    queries = [...new Set(queries)];
    console.log(`[Track] Targets:`, activeTargets, `Final Search Queries:`, queries);

    sendProgress({ type: 'progress', message: 'Searching Google News and Web in parallel...' });

    // Step 2: Run Google News RSS + Serper in PARALLEL (not fallback)
    console.log('[Track] Running Google News RSS + Serper searches in parallel...');
    
    // --- RSS Search ---
    const rssPromise = (async () => {
      let rssRawResults = [];
      for (const q of queries) {
        const results = await googleNewsRssSearch(q);
        rssRawResults.push(...results);
      }
      console.log(`[Track] Google News RSS returned ${rssRawResults.length} raw items.`);
      const uniqueRawRss = deduplicateRssRaw(rssRawResults);
      
      if (uniqueRawRss.length === 0) return [];
      
      console.log(`[Track] Found ${uniqueRawRss.length} unique RSS items. Resolving URLs...`);
      const toResolve = uniqueRawRss.slice(0, 50); // Resolve up to 50
      const resolved = await Promise.all(
        toResolve.map(async (item, index) => {
          await new Promise(r => setTimeout(r, index * 30)); // lighter stagger
          const realUrl = await resolveGoogleNewsUrl(item.link, 3, 6000);
          return {
            link: realUrl || item.link,
            title: cleanTitle(item.title, item.source),
            snippet: item.title,
            source: item.source,
            date: item.pubDate
          };
        })
      );
      return filterRelevantResults(resolved, true);
    })();
    
    // --- Serper Search (runs in parallel, not as fallback) ---
    const serperPromise = (async () => {
      if (!SERPER_API_KEY) {
        console.warn('[Track] SERPER_API_KEY not set — skipping Serper search.');
        return [];
      }
      try {
        let serperRawResults = [];
        
        for (const q of queries) {
          const cleanQ = q.replace(/"/g, '');
          // Run web search, news search, and page 2 of web search in parallel
          const [webResults, newsResults, webPage2] = await Promise.all([
            serperSearch(cleanQ, 40).catch(err => { console.error(`[Track] Serper Web error:`, err.message); return []; }),
            serperNewsSearch(cleanQ, 40).catch(err => { console.error(`[Track] Serper News error:`, err.message); return []; }),
            serperSearch(cleanQ + ' site:*.com', 30).catch(() => []),
          ]);
          
          console.log(`[Track] Serper Query "${cleanQ}": ${webResults.length} web + ${newsResults.length} news + ${webPage2.length} web2 results`);
          
          for (const r of [...webResults, ...webPage2]) {
            let source = '';
            try { source = new URL(r.link).hostname.replace('www.', ''); } catch {}
            serperRawResults.push({
              link: r.link,
              title: r.title || '',
              snippet: r.snippet || '',
              source: source,
              date: r.date || '',
            });
          }
          
          for (const r of newsResults) {
            serperRawResults.push({
              link: r.link,
              title: r.title || '',
              snippet: r.snippet || '',
              source: r.source || '',
              date: r.date || '',
            });
          }
        }
        
        return filterRelevantResults(serperRawResults, true);
      } catch (err) {
        console.error('[Track] Serper search failed:', err.message);
        return [];
      }
    })();
    
    // --- ChatGPT Search ---
    const chatGptPromise = (async () => {
      const gptResults = await searchWithChatGPT(combinedQuery);
      
      // Verify URLs concurrently to remove hallucinations
      console.log(`[Track] Verifying ${gptResults.length} ChatGPT URLs to remove fake links...`);
      const verificationResults = await Promise.all(gptResults.map(async (r) => {
         const exists = await verifyUrlExists(r.link);
         return { ...r, exists };
      }));
      
      const verified = verificationResults.filter(r => r.exists);
      console.log(`[Track] ChatGPT verified ${verified.length} authentic URLs out of ${gptResults.length}.`);
      
      return filterRelevantResults(verified.map(r => ({
        link: r.link,
        title: r.title || '',
        snippet: 'Found via ChatGPT Search',
        source: r.source || 'ChatGPT',
        date: ''
      })), true);
    })();
    
    // Wait for all three sources to complete
    const [rssResults, serperResults, chatGptResults] = await Promise.all([rssPromise, serperPromise, chatGptPromise]);
    
    // Merge all results: Serper first, then ChatGPT, then RSS
    const allResults = [...serperResults, ...chatGptResults, ...rssResults];
    let unique = deduplicateResults(allResults);
    
    let searchSourceUsed = [];
    if (serperResults.length > 0) searchSourceUsed.push('Google Search');
    if (rssResults.length > 0) searchSourceUsed.push('Google News');
    if (chatGptResults.length > 0) searchSourceUsed.push('ChatGPT AI');
    const searchSourceStr = searchSourceUsed.join(' + ') || 'Google News';
    
    sendProgress({ type: 'progress', message: `Found ${unique.length} unique articles. Preparing for AI analysis...` });
    
    console.log(`[Track] Combined: ${rssResults.length} RSS + ${serperResults.length} Serper + ${chatGptResults.length} ChatGPT = ${unique.length} unique results.`);

    if (unique.length === 0) {
      sendProgress({
        type: 'done',
        success: true,
        message: 'No coverage found for this search.',
        articlesFound: 0,
        articlesAnalyzed: 0,
        results: [],
        searchResults: [],
      });
      return res.end();
    }

    // Step 3: Analyze ALL found URLs via n8n (UNLIMITED)
    const toAnalyze = unique;
    console.log(`[Track] Will analyze ALL ${toAnalyze.length} URLs via n8n...`);

    const analyzed = await analyzeInBatches(toAnalyze, 25, combinedQuery, (completed, total) => {
      sendProgress({ type: 'progress', message: `Analyzing articles with AI: ${completed} of ${total} completed...` });
    });
    
    const successful = analyzed.filter(a => a !== null).map(a => ({ ...a, search_query: combinedQuery }));
    console.log(`[Track] Successfully analyzed: ${successful.length}/${toAnalyze.length}`);

    sendProgress({
      type: 'done',
      success: true,
      message: `Found ${unique.length} publications via ${searchSourceStr}, analyzed ${successful.length} articles.`,
      articlesFound: unique.length,
      articlesAnalyzed: successful.length,
      results: successful,
      searchResults: unique.slice(0, 200).map(r => ({
        title: r.title,
        link: r.link,
        source: r.source,
        snippet: r.snippet,
      })),
    });
    return res.end();

  } catch (err) {
    console.error('[Track] Error:', err);
    sendProgress({
      type: 'error',
      error: 'Tracking failed',
      details: err.message,
    });
    return res.end();
  }
}
