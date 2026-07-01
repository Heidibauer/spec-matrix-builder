// pages/api/scrape.js — CLEAN REBUILD
//
// WHAT THE LOGS ACTUALLY SHOWED:
// - AJ Madison: SUCCESS via Zyte product extraction (9 specs, HTTP 200)
// - Target: 4 specs from product, then browserHtml returned HTTP 400
// - Wayfair: Timed out on product, browserHtml returned HTTP 400
//
// ROOT CAUSES:
// 1. Wayfair URLs had tracking params with encoded JSON (%7B%22adType%22...)
//    making URLs malformed — Zyte returned 400. Fix: strip tracking params.
// 2. Zyte `product` extraction works but returns few specs because
//    `additionalProperties` is limited. Fix: also check `description`
//    and use Claude to extract from product metadata.
// 3. browserHtml + actions returning 400 — likely URL issue, not code.
//    Fix: clean URL first, then try browserHtml without actions (simpler).
//
// ARCHITECTURE:
// Step 1: Clean the URL (strip tracking params)
// Step 2: Try Zyte product extraction (fast path)
// Step 3: If < 8 specs, try Zyte browserHtml (no actions, just clean render)
// Step 4: Send whatever HTML we got to Claude for thorough extraction
// Step 5: Return merged best result

export const config = { maxDuration: 300 }

function cleanUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    // Remove known tracking/auction params that confuse scrapers
    const junk = ['auctionId','trackingId','adTypeId','utm_source','utm_medium',
                   'utm_campaign','utm_content','utm_term','ref','_ga','fbclid',
                   'gclid','msclkid','preselect','piid']
    junk.forEach(p => u.searchParams.delete(p))
    // Remove hash fragments
    u.hash = ''
    return u.toString()
  } catch {
    return rawUrl
  }
}

function b64(s) { return Buffer.from(s).toString('base64') }

async function zytePost(body, key, ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + b64(key + ':'),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    let d
    try { d = await r.json() } catch { d = {} }
    return { ok: r.status === 200, status: r.status, d }
  } catch(e) {
    return { ok: false, status: 0, d: {}, error: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(t)
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"')
    .replace(/\s+/g,' ').trim()
}

async function claudeExtract(text, key, timeoutMs = 40000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
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
                    label: { type: 'string', description: 'Exact spec label as written on page' },
                    value: { type: 'string', description: 'Exact spec value as written on page' },
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
          content: `Extract the product name and EVERY product specification from this retailer page. Only include specs literally present — never invent. Be exhaustive: spec tables, "Product Details", "Tech Specs", dimensions, materials, certifications, accessories, warranty.\n\nPAGE TEXT:\n${text.slice(0, 45000)}`,
        }],
      }),
      signal: ctrl.signal,
    })
    const d = await r.json()
    const block = d.content?.find(b => b.type === 'tool_use')
    return block?.input || null
  } catch { return null } finally { clearTimeout(t) }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url: rawUrl } = req.body
  if (!rawUrl) return res.status(400).json({ error: 'Missing url' })

  const ZYTE = process.env.ZYTE_API_KEY
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY
  if (!ZYTE) return res.status(500).json({ error: 'Missing ZYTE_API_KEY' })
  if (!ANTHROPIC) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  // Step 1: Clean the URL
  const url = cleanUrl(rawUrl)
  console.log(`[1] URL cleaned: ${rawUrl.length} -> ${url.length} chars`)
  console.log(`[2] Clean URL: ${url}`)

  let productName = 'Unknown product'
  let image = null
  let specs = {}
  let html = null

  // Step 2: Zyte product extraction (fast, structured)
  console.log(`[3] Trying Zyte product extraction`)
  const pa = await zytePost({ url, product: true }, ZYTE, 40000)
  console.log(`[4] Product result: status=${pa.status}, props=${pa.d?.product?.additionalProperties?.length ?? 0}, name="${pa.d?.product?.name}"`)

  if (pa.ok && pa.d.product) {
    const p = pa.d.product
    if (p.name) productName = p.name
    if (p.images?.[0]?.url) image = p.images[0].url
    for (const s of (p.additionalProperties || [])) {
      if (s.name && s.value) specs[s.name] = s.value
    }
  }

  // Step 3: Zyte browserHtml (clean render, no actions)
  // Always do this to get complete HTML for Claude extraction
  console.log(`[5] Trying Zyte browserHtml`)
  const pb = await zytePost({ url, browserHtml: true }, ZYTE, 55000)
  console.log(`[6] browserHtml result: status=${pb.status}, length=${pb.d?.browserHtml?.length ?? 0}`)

  if (pb.ok && pb.d.browserHtml) {
    html = pb.d.browserHtml
    // Extract og:image if we don't have one
    if (!image) {
      const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
      if (m) image = m[1]
    }
  }

  // Step 4: Claude extraction from HTML
  if (html) {
    const text = stripHtml(html)
    console.log(`[7] Running Claude extraction on ${text.length} chars`)
    const extracted = await claudeExtract(text, ANTHROPIC)
    console.log(`[8] Claude found: ${extracted?.specs?.length ?? 0} specs, name="${extracted?.productName}"`)

    if (extracted) {
      if (extracted.productName && extracted.productName !== 'Unknown product') {
        productName = extracted.productName
      }
      // Merge Claude specs with product specs (Claude is usually more complete)
      for (const { label, value } of (extracted.specs || [])) {
        if (label && value) specs[label.trim()] = value.trim()
      }
    }
  }

  if (Object.keys(specs).length === 0) {
    console.log(`[9] No specs found after all attempts`)
    return res.status(422).json({
      error: 'No specs found',
      detail: `product=${pa.status} browserHtml=${pb.status} url=${url.slice(0,80)}`,
    })
  }

  console.log(`[10] Final: ${Object.keys(specs).length} specs, "${productName}"`)
  return res.status(200).json({ specs, productName, image })
}
