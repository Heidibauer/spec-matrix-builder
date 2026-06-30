// pages/api/scrape.js

export const config = {
  maxDuration: 60, // Vercel max for hobby/pro plans
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

  if (!FIRECRAWL_API_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing API keys — check environment variables' })
  }

  // Step 1: Fetch the page content via Firecrawl
  let pageContent = ''
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
        onlyMainContent: false, // false = get full page, better for spec tables
        waitFor: 3000, // wait 3s for JS to render
        timeout: 45000, // 45s — retail pages with heavy JS need more than Firecrawl's default
      }),
    })

    const fcData = await fcRes.json()

    // Log the raw Firecrawl response for debugging
    console.log('Firecrawl response for', url, JSON.stringify({
      success: fcData.success,
      error: fcData.error,
      hasMarkdown: !!fcData.data?.markdown,
      markdownLength: fcData.data?.markdown?.length,
    }))

    if (!fcData.success) {
      return res.status(422).json({
        error: 'Firecrawl could not fetch this page',
        detail: fcData.error || 'Unknown Firecrawl error',
      })
    }

    // Try markdown first, fall back to html-derived content
    pageContent = fcData.data?.markdown || fcData.data?.content || ''

    if (!pageContent || pageContent.length < 100) {
      return res.status(422).json({
        error: 'Page returned no content — likely bot-protected',
        detail: `Content length: ${pageContent.length}`,
      })
    }

  } catch (err) {
    return res.status(502).json({ error: 'Firecrawl request failed', detail: err.message })
  }

  // Step 2: Send page content to Claude to extract specs
  try {
    // Cap content size — markdown from heavy retail pages can be 150k+ chars,
    // which bloats the request. 15k chars is plenty for a spec table.
    let contentSlice = pageContent.slice(0, 15000)

    // Strip characters that can break JSON string encoding in the request body
    contentSlice = contentSlice.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

    const requestBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are extracting product specifications from a retailer product page.

Below is the page content. Find the product specifications, tech specs, or product details section — the structured list of a product's technical and physical attributes.

Return ONLY a valid JSON object where:
- Keys = exact spec labels as shown on the page
- Values = exact spec values as shown on the page

Example: {"Brew Capacity": "12 cups", "Wattage": "1500W", "Dimensions": "14 x 8 x 12 in"}

If you find NO specs at all, return exactly: {}

Do not include: descriptions, marketing copy, reviews, prices, availability, shipping, or anything non-spec.
Return ONLY the JSON object. No prose, no code fences, no explanation.

PAGE CONTENT:
${contentSlice}`,
      }],
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    })

    const claudeData = await claudeRes.json()

    // Log full response details for debugging — this is the critical part
    console.log('Claude response status:', claudeRes.status)
    if (claudeRes.status !== 200) {
      console.log('Claude FULL error body:', JSON.stringify(claudeData))
      console.log('Content length sent:', contentSlice.length)
    }

    if (claudeRes.status !== 200) {
      return res.status(502).json({
        error: 'Claude API error',
        detail: claudeData.error?.message || claudeData.error?.type || JSON.stringify(claudeData).slice(0, 500),
      })
    }

    const text = claudeData.content?.find(b => b.type === 'text')?.text || ''
    const cleaned = text.replace(/```json|```/g, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)

    if (!match) {
      return res.status(422).json({
        error: 'Could not extract specs from page content',
        detail: `Claude returned: ${text.slice(0, 200)}`,
      })
    }

    const specs = JSON.parse(match[0])

    if (Object.keys(specs).length === 0) {
      return res.status(422).json({
        error: 'No specs found on this page',
        detail: 'Claude found no product specifications in the page content',
      })
    }

    return res.status(200).json({ specs })

  } catch (err) {
    return res.status(502).json({ error: 'Claude extraction failed', detail: err.message })
  }
}
