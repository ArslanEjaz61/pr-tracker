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
 * Extract 3-4 unique/distinctive phrases from press release text
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
 * Build search queries based on tracking type
 */
function buildSearchQueries(searchType, query) {
  switch (searchType) {
    case 'title':
      return [
        `"${query}"`,
        query,
      ];
    
    case 'keywords':
      return [
        `${query} press release`,
        `${query} announcement news`,
      ];
    
    case 'hashtag': {
      const tag = query.startsWith('#') ? query : `#${query}`;
      const tagNoHash = query.startsWith('#') ? query.slice(1) : query;
      return [
        `"${tag}"`,
        `${tag} press release`,
        `${tagNoHash} press release news`,
      ];
    }
    
    case 'document': {
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
function filterRelevantResults(results) {
  const irrelevantDomains = [
    'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com',
    'linkedin.com/in/', 'youtube.com/channel', 'pinterest.com',
    'google.com', 'bing.com', 'yahoo.com',
  ];
  
  return results.filter(r => {
    if (!r.link) return false;
    const url = r.link.toLowerCase();
    for (const d of irrelevantDomains) {
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
async function analyzeInBatches(urls, batchSize = 5, query) {
  const results = [];
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    console.log(`[Track] Analyzing batch ${Math.floor(i/batchSize) + 1}: ${batch.map(r => r.link).join(', ')}`);
    const batchResults = await Promise.all(batch.map(r => analyzeUrl(r.link, query)));
    results.push(...batchResults);
    
    if (i + batchSize < urls.length) {
      await new Promise(resolve => setTimeout(resolve, 500)); // Reduced delay
    }
  }
  return results;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { searchType, query } = req.body;

  if (!query || !searchType) {
    return res.status(400).json({ error: 'Missing searchType or query' });
  }

  try {
    // Step 1: Build search queries based on tracking type
    const queries = buildSearchQueries(searchType, query);
    console.log(`[Track] Type: ${searchType}, Queries:`, queries);

    // Step 2: Try Google News RSS first
    console.log('[Track] Running Google News RSS search...');
    let rssRawResults = [];
    for (const q of queries) {
      const results = await googleNewsRssSearch(q);
      rssRawResults.push(...results);
    }

    console.log(`[Track] Google News RSS returned ${rssRawResults.length} raw items.`);
    
    let unique = [];
    let searchSourceUsed = 'google-news-rss';
    
    const uniqueRawRss = deduplicateRssRaw(rssRawResults);
    
    if (uniqueRawRss.length > 0) {
      console.log(`[Track] Found ${uniqueRawRss.length} unique RSS items. Resolving URLs...`);
      
      // Resolve top 20 RSS results in parallel with a slight stagger
      const toResolve = uniqueRawRss.slice(0, 20);
      const resolved = await Promise.all(
        toResolve.map(async (item, index) => {
          await new Promise(r => setTimeout(r, index * 50)); // stagger requests gently
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
      
      const filtered = filterRelevantResults(resolved);
      unique = deduplicateResults(filtered);
      console.log(`[Track] After RSS resolution & filtering: ${unique.length} results.`);
    }

    // Step 3: Fallback to Serper if RSS has too few results
    if (unique.length < 5) {
      console.log(`[Track] RSS results (${unique.length}) below threshold. Falling back to Serper...`);
      
      if (!SERPER_API_KEY) {
        if (unique.length > 0) {
          console.warn('[Track] Serper API key is missing. Proceeding with RSS results only.');
        } else {
          return res.status(500).json({
            error: 'Tracking failed',
            details: 'Too few results found on Google News RSS, and SERPER_API_KEY is not configured for fallback search.',
          });
        }
      } else {
        searchSourceUsed = 'serper-fallback';
        let serperRawResults = [];
        
        for (const q of queries) {
          const [webResults, newsResults] = await Promise.all([
            serperSearch(q, 15),
            serperNewsSearch(q, 15),
          ]);
          
          console.log(`[Track] Serper Query "${q}": ${webResults.length} web + ${newsResults.length} news results`);
          
          for (const r of webResults) {
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
        
        const filteredSerper = filterRelevantResults(serperRawResults);
        const uniqueSerper = deduplicateResults(filteredSerper);
        
        // Merge Serper results with RSS results, prioritizing Serper results
        const combined = [...uniqueSerper, ...unique];
        unique = deduplicateResults(combined);
        console.log(`[Track] After merging Serper fallback: ${unique.length} results.`);
      }
    }

    if (unique.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No coverage found for this search.',
        articlesFound: 0,
        articlesAnalyzed: 0,
        results: [],
        searchResults: [],
      });
    }

    // Step 4: Analyze each URL via n8n (limit to top 10 to avoid overloading)
    const toAnalyze = unique.slice(0, 10);
    console.log(`[Track] Will analyze ${toAnalyze.length} URLs via n8n...`);

    const analyzed = await analyzeInBatches(toAnalyze, 5, query);
    const successful = analyzed.filter(a => a !== null).map(a => ({ ...a, search_query: query }));
    console.log(`[Track] Successfully analyzed: ${successful.length}/${toAnalyze.length}`);

    return res.status(200).json({
      success: true,
      message: `Found ${unique.length} publications via ${searchSourceUsed}, analyzed ${successful.length} articles.`,
      articlesFound: unique.length,
      articlesAnalyzed: successful.length,
      results: successful,
      searchResults: unique.slice(0, 20).map(r => ({
        title: r.title,
        link: r.link,
        source: r.source,
        snippet: r.snippet,
      })),
    });

  } catch (err) {
    console.error('[Track] Error:', err);
    return res.status(500).json({
      error: 'Tracking failed',
      details: err.message,
    });
  }
}
