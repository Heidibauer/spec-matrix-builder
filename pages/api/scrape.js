// pages/api/scrape.js
//
// REWRITTEN AFTER RESEARCH. Key findings that drove this rewrite:
// 1. Firecrawl's `proxy: "auto"` mode automatically retries blocked/failed
//    scrapes through a stronger stealth/residential-proxy backend. This was
//    never set before, which is the real reason Best Buy kept failing —
//    it was always using the weakest "basic" engine with no escalation.
// 2. Firecrawl's native `formats: ["json"]` + `jsonOptions.schema` extracts
//    structured data SERVER-SIDE with schema validation. This replaces our
//    old approach of manually chunking raw markdown and asking Claude to
//    find specs in each chunk via fragile regex-extracted JSON — which is
//    exactly what caused the "Expected ',' or '}'" crash (unescaped quote
//    marks in spec values like 12.13'' broke our hand-rolled JSON parsing).
//    Firecrawl validates against the schema before ever returning data.

export const config = {
  maxDuration: 60,
}

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    productName: {
      type: 'string',
      description: 'The exact product title/name as shown on the page',
    },
    image: {
      type: 'string',
      description: 'The URL of the main product image on the page',
    },
    specs: {
      type: 'array',
      description: 'Every product specification found on the page — dimensions, weight, capacity, wattage, materials, color, model number, included accessories, certifications, etc. Extract every single spec row found, however many there are.',
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

async function scrapeWithFirecrawl(url, apiKey, proxyMode, timeoutMs) {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['json'],
      onlyMainContent: false,
      waitFor: 3000,
      timeout: timeoutMs,
      proxy: proxyMode,
      jsonOptions: {
        schema: SPEC_SCHEMA,
        prompt: 'Extract the product name, main product image URL, and EVERY product specification listed on this retailer product page. Look in specifications tables, "Product Details" sections, "Tech Specs" sections, dimension lists, and feature bullet lists — specs are sometimes in a collapsed/tabbed section. Only extract specs that are literally present on the page. Do not infer, estimate, or add specs that are not explicitly shown. Copy every label and value exactly as written, with no paraphrasing or unit conversion.',
      },
    }),
  })

  let data
  try {
    data = await res.json()
  } catch (parseErr) {
    // Vercel/Firecrawl returned something that isn't JSON at all (e.g. a
    // gateway timeout error page). Treat this as a clean failure instead
    // of crashing — this is what caused "Unexpected token 'A'" before.
    return { httpStatus: res.status, data: { success: false, error: `Non-JSON response (HTTP ${res.status})` } }
  }
  return { httpStatus: res.status, data }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY
  if (!FIRECRAWL_API_KEY) {
    return res.status(500).json({ error: 'Missing FIRECRAWL_API_KEY environment variable' })
  }

  // IMPORTANT: only ONE Firecrawl call per request. Firecrawl's "auto" proxy
  // mode already retries internally with stealth proxies if basic fails —
  // we don't need to orchestrate that ourselves. Doing two sequential
  // attempts from our side caused two ~55s calls to stack up and blow
  // through Vercel's 60s function ceiling, which is what broke Wayfair/
  // Best Buy last time (the function got killed mid-flight and the
  // frontend received Vercel's own timeout error page instead of JSON).
  const FIRECRAWL_TIMEOUT_MS = 48000 // leaves headroom inside Vercel's 60s limit
  let { httpStatus, data: fcData } = await scrapeWithFirecrawl(url, FIRECRAWL_API_KEY, 'auto', FIRECRAWL_TIMEOUT_MS)

  console.log('Firecrawl auto-proxy attempt for', url, JSON.stringify({
    httpStatus,
    success: fcData.success,
    error: fcData.error,
    hasJson: !!fcData.data?.json,
    specCount: fcData.data?.json?.specs?.length,
  }))

  if (!fcData.success) {
    return res.status(422).json({
      error: 'Firecrawl could not fetch this page even with stealth proxy',
      detail: fcData.error || 'Unknown Firecrawl error',
    })
  }

  const json = fcData.data?.json
  if (!json || !Array.isArray(json.specs) || json.specs.length === 0) {
    return res.status(422).json({
      error: 'No specs found on this page',
      detail: 'Firecrawl scraped the page successfully but found no specification data — this retailer may not list specs for this product, or they are loaded in a way Firecrawl could not reach.',
    })
  }

  // Convert the array of {label, value} into a plain object for easy
  // merging/matrix-building downstream, while preserving order.
  const specs = {}
  for (const item of json.specs) {
    if (item.label && item.value) {
      specs[item.label] = item.value
    }
  }

  const ogImage = fcData.data?.metadata?.ogImage || fcData.data?.metadata?.['og:image'] || null

  return res.status(200).json({
    specs,
    productName: json.productName || 'Unknown product',
    image: ogImage || json.image || null,
    sourceUrl: url,
  })
}
