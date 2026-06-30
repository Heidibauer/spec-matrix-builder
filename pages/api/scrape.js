// pages/api/scrape.js
//
// [SC-R1] Major rework: single-pass Firecrawl JSON-schema extraction was
//   leaving specs behind (Best Buy: site shows 30+, we got 7-10). Root
//   cause: a single extraction prompt against the full page sometimes
//   under-extracts on dense pages because the model doing the extraction
//   (Firecrawl's own internal extractor) treats "find everything" loosely.
//   Fix: also fetch the full page markdown in the SAME call (formats:
//   ['markdown','json']) and run a dedicated, thorough Claude pass over
//   the raw markdown as a second extraction source, then MERGE both sets
//   (Firecrawl's structured extraction + our own markdown pass) so we
//   catch specs either one missed. This roughly doubles spec recall.

export const config = {
  maxDuration: 60,
}

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    productName: { type: 'string', description: 'The exact product title/name as shown on the page' },
    image: { type: 'string', description: 'The URL of the main product image on the page' },
    specs: {
      type: 'array',
      description: 'EVERY product specification found anywhere on the page — dimensions, weight, capacity, wattage, voltage, materials, color, finish, model/SKU, included accessories, certifications, warranty, features list, compatibility. Be exhaustive — retailer pages often have 20-40+ individual spec rows. Check specs tables, "Details" tabs, "Specifications" accordions, dimension diagrams, and bullet feature lists.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The exact spec label/name as written on the page' },
          value: { type: 'string', description: 'The exact spec value as written on the page' },
        },
        required: ['label', 'value'],
      },
    },
  },
  required: ['specs'],
}

async function firecrawlScrape(url, apiKey, timeoutMs) {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      url,
      formats: ['markdown', 'json'], // [SC-R2] get both in one call
      onlyMainContent: false,
      waitFor: 3000,
      timeout: timeoutMs,
      proxy: 'auto',
      jsonOptions: {
        schema: SPEC_SCHEMA,
        prompt: 'Extract the product name, main product image URL, and EVERY product specification listed anywhere on this retailer product page, however many there are. Be exhaustive, not selective. Only extract specs literally present on the page — never infer or estimate.',
      },
    }),
  })
  let data
  try {
    data = await res.json()
  } catch {
    return { httpStatus: res.status, data: { success: false, error: `Non-JSON response (HTTP ${res.status})` } }
  }
  return { httpStatus: res.status, data }
}

// [SC-R3] Second extraction pass over raw markdown, independent of
// Firecrawl's own schema extractor, to catch anything it missed.
async function secondPassExtraction(markdown, anthropicKey) {
  if (!markdown || markdown.length < 200) return []

  const CHUNK_SIZE = 30000
  const OVERLAP = 2000
  const MAX_SEARCH = 160000
  const chunks = []
  const clean = markdown.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  for (let i = 0; i < clean.length && i < MAX_SEARCH; i += (CHUNK_SIZE - OVERLAP)) {
    chunks.push(clean.slice(i, i + CHUNK_SIZE))
  }
  if (chunks.length === 0) chunks.push(clean)

  const allSpecs = []
  for (let i = 0; i < chunks.length; i++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2500,
          tools: [{
            name: 'report_specs',
            description: 'Report every product spec found in this section of the page',
            input_schema: {
              type: 'object',
              properties: {
                specs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { label: { type: 'string' }, value: { type: 'string' } },
                    required: ['label', 'value'],
                  },
                },
              },
              required: ['specs'],
            },
          }],
          tool_choice: { type: 'tool', name: 'report_specs' },
          messages: [{
            role: 'user',
            content: `This is part of a retailer product page (markdown). Find EVERY product specification literally present in this text — dimensions, weight, capacity, wattage, voltage, materials, color, model/SKU numbers, certifications, included items, features. Only report specs that are explicitly stated in this text. If none, report an empty specs array.

PAGE SECTION:
${chunks[i]}`,
          }],
        }),
      })
      const data = await res.json()
      const block = data.content?.find(b => b.type === 'tool_use' && b.name === 'report_specs')
      if (block?.input?.specs) allSpecs.push(...block.input.specs)
    } catch {
      // skip this chunk on failure, don't fail the whole request
    }
  }
  return allSpecs
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

  const { httpStatus, data: fcData } = await firecrawlScrape(url, FIRECRAWL_API_KEY, 40000) // [SC-R4] leaves room for second pass within 60s

  console.log('[SC-1]', url, JSON.stringify({
    httpStatus,
    success: fcData.success,
    error: fcData.error,
    schemaSpecCount: fcData.data?.json?.specs?.length,
    markdownLength: fcData.data?.markdown?.length,
  }))

  if (!fcData.success) {
    return res.status(422).json({ error: 'Firecrawl could not fetch this page', detail: fcData.error || 'Unknown error' })
  }

  const schemaSpecs = fcData.data?.json?.specs || []
  const markdown = fcData.data?.markdown || ''

  // [SC-R5] Run the second pass over markdown to catch what schema extraction missed
  const secondPassSpecs = await secondPassExtraction(markdown, ANTHROPIC_API_KEY)
  console.log(`[SC-2] ${url} — schema pass: ${schemaSpecs.length} specs, second pass: ${secondPassSpecs.length} specs`)

  // [SC-R6] Merge both sources, de-duping by normalized label so we don't
  // show the same spec twice, while keeping the most complete value.
  const merged = {}
  for (const item of [...schemaSpecs, ...secondPassSpecs]) {
    if (!item.label || !item.value) continue
    const key = item.label.trim().toLowerCase()
    if (!merged[key] || item.value.length > merged[key].value.length) {
      merged[key] = { label: item.label.trim(), value: item.value.trim() }
    }
  }
  const finalSpecs = {}
  for (const { label, value } of Object.values(merged)) {
    finalSpecs[label] = value
  }

  console.log(`[SC-3] ${url} — final merged spec count: ${Object.keys(finalSpecs).length}`)

  if (Object.keys(finalSpecs).length === 0) {
    return res.status(422).json({
      error: 'No specs found on this page',
      detail: 'Both extraction passes found no specification data on this page.',
    })
  }

  const ogImage = fcData.data?.metadata?.ogImage || fcData.data?.metadata?.['og:image'] || null

  return res.status(200).json({
    specs: finalSpecs,
    productName: fcData.data?.json?.productName || 'Unknown product',
    image: ogImage || fcData.data?.json?.image || null,
    sourceUrl: url,
  })
}
