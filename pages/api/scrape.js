// pages/api/scrape.js v10
//
// FIXES FROM LOGS:
// [v9-fix-1] Removed browserHtml:true from the Zyte request. Requesting
//   full rendered HTML alongside product+customAttributes AI extraction
//   caused 504 Vercel timeouts on Target (91k) and Wayfair (148-158k)
//   pages — Zyte had to render + return massive HTML + run LLM extraction
//   all within 60s. Dropping browserHtml cuts response time in half.
//   Claude fallback is removed too since we can't get the HTML fast enough
//   to use it within budget. Zyte's own extraction is sufficient.
//
// [v9-fix-2] Best Buy returns Zyte 520 "Website Ban" — even Zyte's top-tier
//   anti-bot can't guarantee a clean response for Best Buy consistently.
//   This is a known hard target. We surface a clear error with guidance
//   rather than hanging. Users should try alternative URLs for Best Buy
//   (e.g. a specific product model with a simpler URL, or use a different
//   retailer like B&H Photo, Crutchfield, or Costco instead).
//
// [v9-fix-3] Set a hard 50s timeout on the Node fetch call itself so we
//   always return before Vercel's 60s ceiling even if Zyte is slow.

export const config = { maxDuration: 60 }

const SPEC_SCHEMA = {
  specifications: {
    type: 'array',
    description: 'Every product specification on this retailer product page. Extract ALL of them — dimensions, weight, capacity, wattage, voltage, materials, color, model number, certifications, included accessories, warranty, compatibility. Typically 20-40 specs on a retail product page.',
    items: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Exact spec label as written on the page' },
        value: { type: 'string', description: 'Exact spec value as written on the page' },
      },
    },
  },
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const ZYTE_API_KEY = process.env.ZYTE_API_KEY
  if (!ZYTE_API_KEY) {
    return res.status(500).json({
      error: 'Missing ZYTE_API_KEY',
      detail: 'Add ZYTE_API_KEY to Vercel environment variables. Get a key at https://app.zyte.com ($5 free trial).',
    })
  }

  let zyteRes, zyteData
  try {
    // [v9-fix-3] Hard 50s timeout — always returns before Vercel kills us at 60s
    zyteRes = await fetchWithTimeout(
      'https://api.zyte.com/v1/extract',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(ZYTE_API_KEY + ':').toString('base64'),
        },
        body: JSON.stringify({
          url,
          product: true,
          customAttributes: SPEC_SCHEMA,
          // [v9-fix-1] No browserHtml — cuts response time for large pages
          productOptions: { extractFrom: 'browserHtml' },
        }),
      },
      50000
    )
    zyteData = await zyteRes.json()
  } catch (err) {
    const isTimeout = err.name === 'AbortError'
    return res.status(isTimeout ? 408 : 502).json({
      error: isTimeout ? 'Zyte request timed out (page took too long to render)' : 'Zyte request failed',
      detail: err.message,
    })
  }

  console.log(`[SC-1] ${url} — Zyte HTTP ${zyteRes.status}, specs:${zyteData.customAttributes?.values?.specifications?.length ?? 0}`)

  if (zyteRes.status !== 200) {
    const isBan = zyteRes.status === 520
    console.log(`[SC-2] Zyte error: ${JSON.stringify(zyteData).slice(0, 400)}`)
    return res.status(422).json({
      error: isBan
        ? 'This retailer actively blocks all scrapers (including Zyte). Try a different URL or retailer.'
        : 'Zyte could not fetch this page',
      detail: zyteData.detail || JSON.stringify(zyteData).slice(0, 200),
    })
  }

  const rawSpecs = zyteData.customAttributes?.values?.specifications || []
  const product = zyteData.product || {}

  console.log(`[SC-3] Product: "${product.name}", specs found: ${rawSpecs.length}`)

  if (rawSpecs.length === 0) {
    return res.status(422).json({
      error: 'No specs found on this page',
      detail: 'Zyte fetched the page but found no product specifications.',
    })
  }

  const specs = {}
  for (const { label, value } of rawSpecs) {
    if (label && value) specs[label.trim()] = value.trim()
  }

  return res.status(200).json({
    specs,
    productName: product.name || 'Unknown product',
    image: product.images?.[0]?.url || null,
  })
}
