// pages/api/scrape.js v13
//
// KEY FIX: maxDuration raised to 300 (5 minutes).
// Vercel Pro supports up to 900s for serverless functions.
// This eliminates the 60s timeout that was killing Target/Wayfair requests.
//
// With more time available:
// - Zyte uses browserHtml (fully JS-rendered DOM, not raw HTML)
// - Zyte uses actions to scroll + click "Show more specs" buttons
//   before capturing — this is why Target was returning 8 specs instead of 20+
// - Claude gets the full rendered text and extracts everything
// - If spec count is still low after first attempt, we do a targeted
//   second pass focused on the specs section specifically

export const config = { maxDuration: 300 }

function b64(s) { return Buffer.from(s).toString('base64') }

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t))
}

async function zyteGet(url, zyteKey, actions = []) {
  const body = {
    url,
    browserHtml: true,
    actions: [
      { type: 'waitForTimeout', timeout: 3000 },
      { type: 'scrollBottom' },
      { type: 'waitForTimeout', timeout: 2000 },
      ...actions,
    ],
  }

  const res = await fetchWithTimeout(
    'https://api.zyte.com/v1/extract',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + b64(zyteKey + ':'),
      },
      body: JSON.stringify(body),
    },
    90000 // 90s for Zyte — plenty of room within 300s limit
  )

  const data = await res.json()
  return { status: res.status, html: data.browserHtml || null, error: data.detail || data.title }
}

async function claudeExtract(text, anthropicKey) {
  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        tools: [{
          name: 'extract_product_data',
          description: 'Extract product name and all specifications from a retailer page',
          input_schema: {
            type: 'object',
            properties: {
              productName: {
                type: 'string',
                description: 'The exact product title as shown on the page',
              },
              specs: {
                type: 'array',
                description: 'EVERY product specification on this page. Be exhaustive — dimensions, weight, capacity, wattage, voltage, materials, color, model number, certifications, included accessories, warranty, compatibility. Retail pages typically have 15-40 specs. Look in spec tables, "Product Details", "Tech Specs", "Specifications" sections, dimension charts, and feature bullet lists.',
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
            required: ['productName', 'specs'],
          },
        }],
        tool_choice: { type: 'tool', name: 'extract_product_data' },
        messages: [{
          role: 'user',
          content: `Extract the product name and EVERY product specification from this retailer page. Only include specs literally present — never invent or infer. Be exhaustive.

PAGE TEXT:
${text}`,
        }],
      }),
    },
    45000 // 45s for Claude
  )

  const data = await res.json()
  const block = data.content?.find(b => b.type === 'tool_use' && b.name === 'extract_product_data')
  return block?.input || null
}

function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const ZYTE_KEY = process.env.ZYTE_API_KEY
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

  if (!ZYTE_KEY) return res.status(500).json({ error: 'Missing ZYTE_API_KEY' })
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  // Pass 1: Get fully rendered page, scroll to bottom to trigger lazy loads
  console.log(`[SC-1] Fetching ${url} via Zyte browserHtml + scroll`)
  const pass1 = await zyteGet(url, ZYTE_KEY)

  if (pass1.status === 520) {
    return res.status(422).json({
      error: 'This site blocks automated access. Try a different retailer.',
      detail: pass1.error,
    })
  }

  if (pass1.status !== 200 || !pass1.html) {
    return res.status(422).json({
      error: 'Could not fetch this page',
      detail: pass1.error || `HTTP ${pass1.status}`,
    })
  }

  console.log(`[SC-2] Pass 1 HTML length: ${pass1.html.length}`)

  // Extract from pass 1
  const text1 = htmlToText(pass1.html).slice(0, 50000)
  const result1 = await claudeExtract(text1, ANTHROPIC_KEY)

  console.log(`[SC-3] Pass 1 specs: ${result1?.specs?.length ?? 0}`)

  // Pass 2: If we got fewer than 12 specs, try clicking spec sections
  // Many sites (Target, Best Buy) hide specs behind tabs/accordions
  let result = result1
  if ((result1?.specs?.length ?? 0) < 12) {
    console.log(`[SC-4] Low spec count — running pass 2 with click actions`)
    const pass2 = await zyteGet(url, ZYTE_KEY, [
      // Click common "Specifications" tab/section selectors used by major retailers
      { type: 'click', selector: { type: 'css', value: '[data-test="specifications-tab"]' } },
      { type: 'waitForTimeout', timeout: 1500 },
      { type: 'click', selector: { type: 'css', value: 'button[aria-label*="spec" i]' } },
      { type: 'waitForTimeout', timeout: 1500 },
      { type: 'click', selector: { type: 'css', value: '[class*="spec"][class*="tab" i]' } },
      { type: 'waitForTimeout', timeout: 1500 },
      { type: 'click', selector: { type: 'css', value: '[class*="specification"]' } },
      { type: 'waitForTimeout', timeout: 1500 },
      { type: 'click', selector: { type: 'css', value: 'a[href*="spec"]' } },
      { type: 'waitForTimeout', timeout: 1500 },
    ])

    if (pass2.status === 200 && pass2.html) {
      console.log(`[SC-5] Pass 2 HTML length: ${pass2.html.length}`)
      const text2 = htmlToText(pass2.html).slice(0, 50000)
      const result2 = await claudeExtract(text2, ANTHROPIC_KEY)
      console.log(`[SC-6] Pass 2 specs: ${result2?.specs?.length ?? 0}`)

      // Use whichever pass found more specs
      if ((result2?.specs?.length ?? 0) > (result1?.specs?.length ?? 0)) {
        result = result2
        console.log(`[SC-7] Using pass 2 result (more specs)`)
      }
    }
  }

  if (!result?.specs?.length) {
    return res.status(422).json({
      error: 'No specs found on this page',
      detail: 'The page loaded but contained no product specifications.',
    })
  }

  const specs = {}
  for (const { label, value } of result.specs) {
    if (label && value) specs[label.trim()] = value.trim()
  }

  const ogImageMatch = pass1.html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || pass1.html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)

  console.log(`[SC-8] Final: ${Object.keys(specs).length} specs for "${result.productName}"`)

  return res.status(200).json({
    specs,
    productName: result.productName || 'Unknown product',
    image: ogImageMatch?.[1] || null,
  })
}
