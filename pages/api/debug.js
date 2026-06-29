// pages/api/debug.js
// Temporary debug endpoint — lets you see exactly what Firecrawl returns for a URL
// Hit this from your browser: POST /api/debug with { "url": "..." }
// Remove this file before going to production

export const config = {
  maxDuration: 60,
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY
  if (!FIRECRAWL_API_KEY) return res.status(500).json({ error: 'Missing FIRECRAWL_API_KEY' })

  try {
    const fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: false,
        waitFor: 3000,
      }),
    })

    const fcData = await fcRes.json()

    return res.status(200).json({
      firecrawlStatus: fcRes.status,
      success: fcData.success,
      error: fcData.error,
      markdownLength: fcData.data?.markdown?.length || 0,
      // Return first 3000 chars so you can see what came back
      markdownPreview: fcData.data?.markdown?.slice(0, 3000) || null,
    })

  } catch (err) {
    return res.status(502).json({ error: err.message })
  }
}
