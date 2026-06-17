export const maxDuration = 60; // Allow up to 1 minute

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'Missing image data' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: 'OpenAI API key not configured',
      details: 'Please ensure OPENAI_API_KEY is defined in your .env.local file.',
    });
  }

  try {
    // Standardize base64 format for OpenAI (needs data:image/...;base64, prefix)
    let cleanImage = image;
    if (!cleanImage.startsWith('data:')) {
      cleanImage = `data:image/jpeg;base64,${cleanImage}`;
    }

    const payload = {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Identify and extract the main headline/title of the article, press release, or document shown in the image. Also, extract 3-5 relevant keywords for search tracking. Output a JSON object in this exact format:
{
  "title": "Clean, exact article headline or title",
  "keywords": "comma, separated, key, terms"
}`
            },
            {
              type: 'image_url',
              image_url: {
                url: cleanImage
              }
            }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 150
    };

    console.log('[OCR] Sending request to OpenAI gpt-4o-mini...');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    console.log('[OCR] Raw response content:', content);
    const result = JSON.parse(content);
    
    return res.status(200).json({
      success: true,
      title: result.title || '',
      keywords: result.keywords || '',
    });

  } catch (err) {
    console.error('[OCR] Error processing image:', err);
    return res.status(500).json({
      error: 'Failed to scan image',
      details: err.message
    });
  }
}
