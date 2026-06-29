// pages/api/scrape.js
// Accepts: { url: string }
// Returns: { retailer: string, specs: { [label]: value } } or { error: string }

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
        onlyMainContent: true,
      }),
    })

    const fcData = await fcRes.json()

    if (!fcData.success || !fcData.data?.markdown) {
      return res.status(422).json({ error: 'Firecrawl could not fetch this page', detail: fcData.error || 'No content returned' })
    }

    pageContent = fcData.data.markdown
  } catch (err) {
    return res.status(502).json({ error: 'Firecrawl request failed', detail: err.message })
  }

  // Step 2: Send page content to Claude to extract specs
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are extracting product specifications from a retailer product page.

Below is the page content in markdown format. Extract ONLY the product specifications or tech specs table — the structured data about the product's physical and technical attributes.

Return ONLY a JSON object where:
- Keys are the exact spec labels as they appear on the page (do not rename or normalize)
- Values are the exact spec values as they appear on the page

Example output: {"Brew Capacity (cups)": "12", "Wattage": "1500 W", "Water Tank Capacity": "60 oz"}

Do not include: product descriptions, marketing copy, reviews, price, availability, shipping info, or anything that is not a product specification.
Return ONLY the JSON object, no other text, no markdown code fences.

PAGE CONTENT:
${pageContent.slice(0, 12000)}`
        }],
      }),
    })

    const claudeData = await claudeRes.json()
    const text = claudeData.content?.find(b => b.type === 'text')?.text || ''
    const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/)

    if (!match) {
      return res.status(422).json({ error: 'Could not extract specs from page content' })
    }

    const specs = JSON.parse(match[0])
    return res.status(200).json({ specs })

  } catch (err) {
    return res.status(502).json({ error: 'Claude extraction failed', detail: err.message })
  }
}
