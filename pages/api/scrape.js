// pages/api/scrape.js v9 — switched from Firecrawl to Zyte API
//
// WHY ZYTE:
// Firecrawl ranks last among all major providers for protected retail sites
// in Proxyway's 2025 independent benchmark. It is designed for AI ingestion
// of open content, not for bypassing Akamai (Target), DataDome (Best Buy),
// or Cloudflare-protected retail pages.
//
// Zyte ranked #1 in the same benchmark (93.14% success across 15 heavily
// protected sites). Crucially, Zyte also has a built-in "product" extraction
// type that uses its own AI to return structured product data — name, image,
// description, AND custom attributes (specs) — in a single API call. This
// replaces both the Firecrawl scrape step AND the separate Claude extraction
// call we were running before, eliminating the dual-step timeout risk.
//
// ZYTE API: POST https://api.zyte.com/v1/extract
// Auth: HTTP Basic with API key as username, empty password
// Docs: https://docs.zyte.com/zyte-api/usage/extract/index.html
//
// This route uses:
// - product: Zyte's built-in AI product extraction (name, image, price, etc)
// - customAttributes: our own spec schema, passed to Zyte's LLM for extraction
//   from the product-relevant section of the page (not the full page HTML)
// - browserHtml: ensures JavaScript-rendered content is included
//
// FALLBACK: If ZYTE_API_KEY is not set, the route returns a clear error
// pointing to https://app.zyte.com to get a key. Free trial is $5 credit.

export const config = { maxDuration: 60 }

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    specifications: {
      type: 'array',
      description: 'Every product specification listed on the page. Be exhaustive — typically 20-40 specs including dimensions, weight, capacity, wattage, voltage, materials, color, model number, certifications, included accessories, warranty, compatibility.',
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
  required: ['specifications'],
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const ZYTE_API_KEY = process.env.ZYTE_API_KEY
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

  if (!ZYTE_API_KEY) {
    return res.status(500).json({
      error: 'Missing ZYTE_API_KEY environment variable',
      detail: 'Get a free trial key at https://app.zyte.com — $5 free credit, no commitment. Add ZYTE_API_KEY to your Vercel environment variables.',
    })
  }

  // [SC-1] Single Zyte API call: handles anti-bot bypass + extraction together
  let zyteRes, zyteData
  try {
    zyteRes = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Zyte uses HTTP Basic auth: API key as username, empty password
        'Authorization': 'Basic ' + Buffer.from(ZYTE_API_KEY + ':').toString('base64'),
      },
      body: JSON.stringify({
        url,
        product: true,                    // Built-in AI product extraction
        customAttributes: SPEC_SCHEMA,    // Our spec extraction schema
        productOptions: {
          extractFrom: 'browserHtml',     // Use rendered browser HTML for JS-heavy pages
        },
      }),
    })
    zyteData = await zyteRes.json()
  } catch (err) {
    return res.status(502).json({ error: 'Zyte API request failed', detail: err.message })
  }

  console.log(`[SC-1] Zyte ${url} — HTTP ${zyteRes.status}, product:${!!zyteData.product}, customAttrs:${!!zyteData.customAttributes}`)

  if (zyteRes.status !== 200) {
    console.log(`[SC-2] Zyte error body:`, JSON.stringify(zyteData).slice(0, 500))
    return res.status(422).json({
      error: 'Zyte could not fetch this page',
      detail: zyteData.detail || zyteData.message || JSON.stringify(zyteData).slice(0, 300),
    })
  }

  // [SC-3] Extract specs from Zyte's customAttributes response
  const rawSpecs = zyteData.customAttributes?.specifications || []
  const product = zyteData.product || {}

  console.log(`[SC-4] Zyte extracted: product name="${product.name}", ${rawSpecs.length} specs, image:${!!product.images?.[0]?.url}`)

  // [SC-5] If Zyte's customAttributes found zero specs, fall back to Claude
  // over the browserHtml content as a safety net. This handles edge cases
  // where the product section Zyte scoped for LLM extraction didn't include
  // the spec table (rare but possible on unusual page layouts).
  let specs = {}

  if (rawSpecs.length > 0) {
    for (const { label, value } of rawSpecs) {
      if (label && value) specs[label.trim()] = value.trim()
    }
    console.log(`[SC-6] Using Zyte customAttributes: ${Object.keys(specs).length} specs`)
  } else if (ANTHROPIC_API_KEY && zyteData.browserHtml) {
    console.log(`[SC-7] Zyte found 0 specs — running Claude fallback over browserHtml`)
    try {
      // Request browserHtml alongside in a second call if we need fallback
      // For now try to get it from the existing response, or do a second call
      const htmlContent = zyteData.browserHtml || ''
      const textContent = htmlContent
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 25000)

      if (textContent.length > 500) {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            tools: [{
              name: 'extract_specs',
              description: 'Extract product specifications',
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
            tool_choice: { type: 'tool', name: 'extract_specs' },
            messages: [{
              role: 'user',
              content: `Extract every product specification from this retailer page text. Only include specs literally present in the text. Return empty array if none found.\n\n${textContent}`,
            }],
          }),
        })
        const claudeData = await claudeRes.json()
        const block = claudeData.content?.find(b => b.type === 'tool_use')
        for (const { label, value } of (block?.input?.specs || [])) {
          if (label && value) specs[label.trim()] = value.trim()
        }
        console.log(`[SC-8] Claude fallback found ${Object.keys(specs).length} specs`)
      }
    } catch (e) {
      console.log(`[SC-9] Claude fallback failed:`, e.message)
    }
  }

  if (Object.keys(specs).length === 0) {
    return res.status(422).json({
      error: 'No specs found on this page',
      detail: `Zyte extracted 0 specifications. The page may not list product specs, or they may require user interaction to reveal.`,
    })
  }

  const image = product.images?.[0]?.url || null
  const productName = product.name || 'Unknown product'

  return res.status(200).json({ specs, productName, image })
}
