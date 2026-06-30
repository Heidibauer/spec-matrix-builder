// pages/api/scrape.js
// Fetches a product page via Firecrawl, then extracts specs, product name,
// and product image with Claude. Anti-hallucination: Claude only ever sees
// real page text and is told to return {} rather than invent anything.

export const config = {
  maxDuration: 60,
}

async function extractSpecsFromChunk(chunk, anthropicKey, chunkIndex) {
  const requestBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are extracting product specifications from PART OF a retailer's product page (this may be a middle section, not the start).

CRITICAL RULES:
1. Only extract specs LITERALLY PRESENT in the text below. Never infer, guess, or fill in a spec that is not explicitly stated.
2. Copy spec labels and values EXACTLY as written — no paraphrasing, no unit conversion, no reformatting.
3. Do not use general product knowledge to invent "typical" specs. Only what is in this text counts.
4. Look for ANY structured product attribute data: a specs table, "Product Details", "Dimensions", "What's Included", bullet lists of attributes (size, weight, capacity, wattage, voltage, materials, color, finish, model/SKU numbers, warranty length, certifications), even if scattered or informally formatted.
5. If this section genuinely contains no such data, return exactly: {}

Return ONLY a valid JSON object, labels as keys, values as values, copied verbatim.
Example: {"Brew Capacity": "12 cups", "Wattage": "1500W"}
Return ONLY the JSON object. No prose, no code fences.

PAGE CONTENT (section ${chunkIndex}):
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
    console.log(`Chunk ${chunkIndex} Claude error:`, JSON.stringify(claudeData).slice(0, 300))
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

async function extractMetadata(pageContent, anthropicKey) {
  // Pull product name + a real image URL from the top of the page in one call
  const topChunk = pageContent.slice(0, 6000)
  const requestBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Below is the start of a retailer product page (markdown format, image links appear as ![alt](url)).

Return ONLY a JSON object:
{"productName": "exact product title from the page, or null if not found", "image": "the most likely main product image URL from the page (a real URL copied exactly from the text), or null if none found"}

Pick an image URL that looks like a real product photo (not a logo, icon, or tracking pixel) — usually the first large image near the title. Return ONLY the JSON object, no other text.

PAGE CONTENT:
${topChunk}`,
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
    const text = data.content?.find(b => b.type === 'text')?.text || ''
    const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/)
    if (!match) return { productName: 'Unknown product', image: null }
    const parsed = JSON.parse(match[0])
    return {
      productName: parsed.productName || 'Unknown product',
      image: parsed.image || null,
    }
  } catch {
    return { productName: 'Unknown product', image: null }
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
  let ogImage = null
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
        waitFor: 6000,
        timeout: 60000,
        mobile: false,
        actions: [
          { type: 'wait', milliseconds: 2000 },
          // Many retailers (Best Buy especially) hide specs behind a
          // collapsed "Specifications" tab/accordion that only loads
          // into the DOM after a click. Scroll down to trigger lazy-load
          // sections, since blind clicks on a selector that may not
          // exist would fail the whole request.
          { type: 'scroll', direction: 'down' },
          { type: 'wait', milliseconds: 1500 },
          { type: 'scroll', direction: 'down' },
          { type: 'wait', milliseconds: 1500 },
        ],
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
    // Firecrawl often returns og:image in metadata — reliable, real image
    ogImage = fcData.data?.metadata?.ogImage || fcData.data?.metadata?.['og:image'] || null

    if (!pageContent || pageContent.length < 100) {
      return res.status(422).json({
        error: 'Page returned no content — likely bot-protected',
        detail: `Content length: ${pageContent.length}`,
      })
    }
  } catch (err) {
    return res.status(502).json({ error: 'Firecrawl request failed', detail: err.message })
  }

  const cleanContent = pageContent.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

  // Step 2: Extract product name + fallback image (only used if Firecrawl had no og:image)
  const metadata = await extractMetadata(cleanContent, ANTHROPIC_API_KEY)
  const finalImage = ogImage || metadata.image

  // Step 3: Search the FULL page in overlapping chunks for specs.
  // Increased chunk count + smaller chunks = more reliable on dense sites
  // like Best Buy / Target where specs can be deeply nested or repeated
  // amid huge amounts of unrelated content (reviews, recs, nav).
  const CHUNK_SIZE = 25000
  const OVERLAP = 2000
  const MAX_SEARCH = 180000
  const chunks = []
  for (let i = 0; i < cleanContent.length && i < MAX_SEARCH; i += (CHUNK_SIZE - OVERLAP)) {
    chunks.push(cleanContent.slice(i, i + CHUNK_SIZE))
  }
  if (chunks.length === 0) chunks.push(cleanContent)

  console.log(`Searching ${chunks.length} chunk(s) for specs on ${url}, total content length ${cleanContent.length}`)

  let mergedSpecs = {}
  let lastError = null
  let chunksChecked = 0

  for (let i = 0; i < chunks.length; i++) {
    const result = await extractSpecsFromChunk(chunks[i], ANTHROPIC_API_KEY, i + 1)
    chunksChecked++
    if (result.error) {
      lastError = result.error
      continue
    }
    const found = Object.keys(result.specs).length
    console.log(`Chunk ${i + 1}/${chunks.length} on ${url}: found ${found} specs`)
    mergedSpecs = { ...mergedSpecs, ...result.specs }

    // Stop early once we have a strong result — saves time/cost
    if (Object.keys(mergedSpecs).length >= 10) break
  }

  console.log(`Final result for ${url}: ${Object.keys(mergedSpecs).length} specs after checking ${chunksChecked} chunk(s)`)

  if (Object.keys(mergedSpecs).length === 0) {
    if (lastError) {
      return res.status(502).json({ error: 'Claude API error', detail: lastError })
    }
    return res.status(422).json({
      error: 'No specs found after searching the full page',
      detail: `Checked ${chunksChecked} section(s) of ${cleanContent.length} total characters`,
    })
  }

  return res.status(200).json({
    specs: mergedSpecs,
    productName: metadata.productName,
    image: finalImage,
    sourceUrl: url,
  })
}
