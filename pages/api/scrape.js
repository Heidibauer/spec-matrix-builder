// pages/api/scrape.js
// Fetches a product page via Firecrawl, then extracts specs with Claude.
// Anti-hallucination design: Claude is only ever shown real page text and is
// explicitly instructed to return {} rather than invent anything.

export const config = {
  maxDuration: 60,
}

async function extractSpecsFromChunk(chunk, anthropicKey) {
  const requestBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are extracting product specifications from a retailer's product page content below.

CRITICAL RULES — DO NOT BREAK THESE:
1. Only extract specs that are LITERALLY PRESENT in the text below. Never infer, guess, estimate, or fill in a spec that is not explicitly stated in the text.
2. Copy spec labels and values EXACTLY as written on the page — do not paraphrase, reformat, convert units, or normalize them.
3. Do not use general knowledge about this type of product to fill in "typical" specs. Only what is literally in the text below counts.
4. If this chunk of the page contains no specifications section, return exactly: {}

Search this page content for a specifications table, "Product Details" section, "Dimensions" section, "Tech Specs" section, or a bullet/definition list of technical attributes (size, weight, capacity, wattage, materials, color, model number, etc).

Return ONLY a valid JSON object where keys are exact spec labels and values are exact spec values, copied verbatim.

Example: {"Brew Capacity": "12 cups", "Wattage": "1500W", "Dimensions": "14 x 8 x 12 in"}

Return ONLY the JSON object. No prose, no code fences, no explanation.

PAGE CONTENT:
${chunk}`,
    }],
  }

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  })

  const claudeData = await claudeRes.json()

  if (claudeRes.status !== 200) {
    console.log('Claude error:', JSON.stringify(claudeData))
    return { error: claudeData.error?.message || claudeData.error?.type || 'Claude API error' }
  }

  const text = claudeData.content?.find(b => b.type === 'text')?.text || ''
  const cleaned = text.replace(/```json|```/g, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)

  if (!match) return { specs: {} }

  try {
    return { specs: JSON.parse(match[0]) }
  } catch {
    return { specs: {} }
  }
}

async function extractProductName(pageContent, anthropicKey) {
  // Pull just the product title from the top of the page — cheap, fast, separate call
  const titleChunk = pageContent.slice(0, 3000)
  const requestBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `What is the exact product name/title shown on this retailer page? Return ONLY the product name as plain text, nothing else, copied exactly as it appears. If you cannot find a clear product name, return exactly: Unknown product

PAGE CONTENT:
${titleChunk}`,
    }],
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    })
    const data = await res.json()
    const text = data.content?.find(b => b.type === 'text')?.text?.trim()
    return text || 'Unknown product'
  } catch {
    return 'Unknown product'
  }
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
        onlyMainContent: false,
        waitFor: 3000,
        timeout: 45000,
      }),
    })

    const fcData = await fcRes.json()

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

  // Clean control characters once, up front
  const cleanContent = pageContent.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

  // Step 2: Extract product name (separate, cheap call)
  const productName = await extractProductName(cleanContent, ANTHROPIC_API_KEY)

  // Step 3: Extract specs — search the page in overlapping chunks instead of
  // guessing where the spec section is. Retailer pages put specs anywhere
  // from char 5,000 to char 100,000+ depending on the site.
  const CHUNK_SIZE = 40000
  const OVERLAP = 3000
  const chunks = []
  for (let i = 0; i < cleanContent.length && i < 140000; i += (CHUNK_SIZE - OVERLAP)) {
    chunks.push(cleanContent.slice(i, i + CHUNK_SIZE))
  }
  // Always check at least one chunk even on short pages
  if (chunks.length === 0) chunks.push(cleanContent)

  console.log(`Searching ${chunks.length} chunk(s) for specs, total content length ${cleanContent.length}`)

  let mergedSpecs = {}
  let lastError = null

  for (let i = 0; i < chunks.length; i++) {
    const result = await extractSpecsFromChunk(chunks[i], ANTHROPIC_API_KEY)
    if (result.error) {
      lastError = result.error
      continue
    }
    const found = Object.keys(result.specs).length
    console.log(`Chunk ${i + 1}/${chunks.length}: found ${found} specs`)
    mergedSpecs = { ...mergedSpecs, ...result.specs }

    // If we already found a solid number of specs, no need to keep burning calls
    if (Object.keys(mergedSpecs).length >= 8) break
  }

  if (Object.keys(mergedSpecs).length === 0) {
    if (lastError) {
      return res.status(502).json({ error: 'Claude API error', detail: lastError })
    }
    return res.status(422).json({
      error: 'No specs found on this page',
      detail: 'Searched the full page content and found no specifications section',
    })
  }

  return res.status(200).json({
    specs: mergedSpecs,
    productName,
    sourceUrl: url,
  })
}
