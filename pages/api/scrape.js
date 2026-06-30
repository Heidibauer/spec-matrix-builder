// pages/api/scrape.js v8
// 
// KEY LESSONS FROM PREVIOUS FAILURES:
// [SC-L1] dual-pass (Firecrawl + separate Claude markdown pass) caused 504
//   timeouts on pages with 90k-158k markdown — too many sequential calls
//   inside a single 60s Vercel function. REMOVED. Single Firecrawl call only.
// [SC-L2] proxy:"auto" sometimes returns 408 on slow pages. Using
//   proxy:"stealth" which is Firecrawl's dedicated anti-bot tier.
// [SC-L3] Firecrawl timeout set to 45s, leaving 15s for the rest of the
//   function (JSON parsing, response). Well inside Vercel's 60s ceiling.
// [SC-L4] formats:["json"] only — no markdown fetch reduces payload size
//   and Firecrawl processing time significantly.

export const config = { maxDuration: 60 }

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    productName: {
      type: 'string',
      description: 'Exact product title as shown on the page',
    },
    image: {
      type: 'string',
      description: 'URL of the main product image',
    },
    specs: {
      type: 'array',
      description: 'Every product specification found on the page. Be exhaustive — retail product pages typically have 20-40 specs covering dimensions, weight, capacity, power, materials, color, model numbers, certifications, included accessories, and warranty. Look in spec tables, "Product Details" sections, "Tech Specs" accordions, and dimension lists.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Exact spec label as written on the page' },
          value: { type: 'string', description: 'Exact spec value as written on the page' },
        },
        required: ['label', 'value'],
      },
    },
  },
  required: ['specs'],
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const FC = process.env.FIRECRAWL_API_KEY
  if (!FC) return res.status(500).json({ error: 'Missing FIRECRAWL_API_KEY' })

  let fcRes, fcData
  try {
    fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FC}` },
      body: JSON.stringify({
        url,
        formats: ['json'],           // [SC-L4] json only — no markdown
        onlyMainContent: false,
        waitFor: 3000,
        timeout: 45000,              // [SC-L3] 45s leaves 15s headroom
        proxy: 'stealth',            // [SC-L2] dedicated anti-bot tier
        jsonOptions: {
          schema: SPEC_SCHEMA,
          prompt: 'Extract the product name, main product image URL, and EVERY product specification on this retailer product page. Be exhaustive — include all specs from spec tables, "Product Details", "Tech Specs" sections, dimension lists, and feature bullet lists. Only include specs literally present on the page, copied exactly as written.',
        },
      }),
    })
    fcData = await fcRes.json()
  } catch (err) {
    return res.status(502).json({ error: 'Firecrawl request failed', detail: err.message })
  }

  console.log(`[SC-1] ${url} — HTTP ${fcRes.status}, success:${fcData.success}, specs:${fcData.data?.json?.specs?.length ?? 0}, err:${fcData.error ?? 'none'}`)

  if (!fcData.success) {
    return res.status(422).json({
      error: 'Firecrawl could not fetch this page',
      detail: fcData.error || 'Unknown error',
    })
  }

  const json = fcData.data?.json
  if (!json?.specs?.length) {
    return res.status(422).json({
      error: 'No specs found on this page',
      detail: 'Firecrawl fetched the page but found no specifications.',
    })
  }

  const specs = {}
  for (const { label, value } of json.specs) {
    if (label && value) specs[label.trim()] = value.trim()
  }

  const ogImage = fcData.data?.metadata?.ogImage
    || fcData.data?.metadata?.['og:image']
    || json.image
    || null

  return res.status(200).json({
    specs,
    productName: json.productName || 'Unknown product',
    image: ogImage,
  })
}
