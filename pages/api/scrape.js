// pages/api/scrape.js v14 — FIXED
//
// THE BUG THAT BROKE EVERYTHING:
// Every version using actions used { type: "scrollBottom" }
// Zyte requires { action: "scrollBottom" } — different key.
// Zyte silently ignored all actions and timed out. Fixed.
//
// TWO-PATH APPROACH:
// Path A: Zyte `product` extraction (fast, no Claude)
// Path B: Zyte `browserHtml` + Claude (fallback)

export const config = { maxDuration: 300 }

function b64(s) { return Buffer.from(s).toString('base64') }

async function zyteRequest(body, key, ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + b64(key + ':'),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const data = await res.json()
    return { status: res.status, data }
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'Timed out' : e.message, data: {} }
  } finally {
    clearTimeout(t)
  }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim()
}

async function claudeExtract(text, key) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 40000)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        tools: [{
          name: 'extract',
          description: 'Extract product name and all specs from page text',
          input_schema: {
            type: 'object',
            properties: {
              productName: { type: 'string' },
              specs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    value: { type: 'string' },
                  },
                  required: ['label', 'value'],
                },
              },
            },
            required: ['productName', 'specs'],
          },
        }],
        tool_choice: { type: 'tool', name: 'extract' },
        messages: [{
          role: 'user',
          content: `Extract the product name and EVERY product specification from this retailer page. Only include specs literally present — never invent. Look for spec tables, "Product Details", "Tech Specs", dimensions, materials, certifications, accessories, warranty.\n\nPAGE TEXT:\n${text.slice(0, 45000)}`,
        }],
      }),
      signal: ctrl.signal,
    })
    const data = await res.json()
    const block = data.content?.find(b => b.type === 'tool_use')
    return block?.input || null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const ZYTE = process.env.ZYTE_API_KEY
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY
  if (!ZYTE) return res.status(500).json({ error: 'Missing ZYTE_API_KEY' })
  if (!ANTHROPIC) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  // PATH A: Zyte product extraction
  console.log(`[A1] Zyte product extraction: ${url}`)
  const a = await zyteRequest({ url, product: true }, ZYTE, 45000)
  console.log(`[A2] status=${a.status} product=${!!a.data?.product} props=${a.data?.product?.additionalProperties?.length ?? 0}`)

  if (a.status === 200 && a.data?.product) {
    const p = a.data.product
    const specs = {}
    for (const s of (p.additionalProperties || [])) {
      if (s.name && s.value) specs[s.name] = s.value
    }
    if (Object.keys(specs).length >= 5) {
      console.log(`[A3] Path A success: ${Object.keys(specs).length} specs`)
      const ogMatch = url.match(/og:image/)
      return res.status(200).json({
        specs,
        productName: p.name || 'Unknown product',
        image: p.images?.[0]?.url || null,
      })
    }
    console.log(`[A4] Path A: only ${Object.keys(specs).length} specs, falling to Path B`)
  } else {
    console.log(`[A5] Path A failed: ${a.error || JSON.stringify(a.data).slice(0, 150)}`)
  }

  // PATH B: Zyte browserHtml + Claude
  // KEY FIX: use {action: "scrollBottom"} not {type: "scrollBottom"}
  console.log(`[B1] Zyte browserHtml: ${url}`)
  const b = await zyteRequest({
    url,
    browserHtml: true,
    actions: [
      { action: 'waitForTimeout', timeout: 2000 }, // CORRECT: "action" not "type"
      { action: 'scrollBottom' },                   // CORRECT: "action" not "type"
      { action: 'waitForTimeout', timeout: 1500 },
    ],
  }, ZYTE, 55000)

  console.log(`[B2] status=${b.status} html=${b.data?.browserHtml?.length ?? 0} chars`)

  if (b.status !== 200 || !b.data?.browserHtml) {
    const msg = b.data?.detail || b.data?.title || b.error || `HTTP ${b.status}`
    return res.status(422).json({
      error: b.status === 520
        ? 'This site blocks automated access — try a different retailer'
        : `Could not fetch this page: ${msg}`,
    })
  }

  const text = htmlToText(b.data.browserHtml)
  console.log(`[B3] Text: ${text.length} chars`)

  const extracted = await claudeExtract(text, ANTHROPIC)
  console.log(`[B4] Claude: ${extracted?.specs?.length ?? 0} specs, "${extracted?.productName}"`)

  if (!extracted?.specs?.length) {
    return res.status(422).json({ error: 'No specs found on this page' })
  }

  const specs = {}
  for (const { label, value } of extracted.specs) {
    if (label && value) specs[label.trim()] = value.trim()
  }

  const ogMatch = b.data.browserHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || b.data.browserHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)

  return res.status(200).json({
    specs,
    productName: extracted.productName || 'Unknown product',
    image: ogMatch?.[1] || null,
  })
}
