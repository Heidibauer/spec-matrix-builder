// pages/api/scrape.js
// Scrapes a single retailer product URL via Zyte + Claude extraction.
// Returns: { retailer, productName, image, specs: {label: value} }
// This is the same approach confirmed working in logs:
//   Wayfair: 28-35 specs, Target: 17-19, AJ Madison: 20-22

export const config = { maxDuration: 300 }

function cleanUrl(raw) {
  try {
    const u = new URL(raw)
    // Strip tracking params that confuse Zyte
    const junk = ['auctionId','trackingId','adTypeId','utm_source','utm_medium',
      'utm_campaign','utm_content','utm_term','ref','_ga','fbclid','gclid',
      'msclkid','preselect','piid','sourceid']
    junk.forEach(p => u.searchParams.delete(p))
    u.hash = ''
    return u.toString()
  } catch { return raw }
}

function b64(s) { return Buffer.from(s).toString('base64') }

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#39;/g,"'").replace(/&quot;/g,'"')
    .replace(/\s+/g,' ').trim()
}

async function timedFetch(url, opts, ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url: rawUrl } = req.body
  if (!rawUrl) return res.status(400).json({ error: 'Missing url' })

  const ZYTE = process.env.ZYTE_API_KEY
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY
  if (!ZYTE) return res.status(500).json({ error: 'Missing ZYTE_API_KEY' })
  if (!ANTHROPIC) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  const url = cleanUrl(rawUrl)
  console.log(`[S1] Fetching ${url}`)

  // Step 1: Zyte product extraction (fast path, gets structured data)
  let productName = null
  let image = null
  let zyteSpecs = {}

  try {
    const zr = await timedFetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + b64(ZYTE + ':'),
      },
      body: JSON.stringify({ url, product: true }),
    }, 40000)

    const zd = await zr.json()
    if (zr.status === 200 && zd.product) {
      const p = zd.product
      productName = p.name || null
      image = p.images?.[0]?.url || null
      for (const s of (p.additionalProperties || [])) {
        if (s.name && s.value) zyteSpecs[s.name] = s.value
      }
      console.log(`[S2] Zyte product: ${Object.keys(zyteSpecs).length} specs, name="${productName}"`)
    }
  } catch (e) {
    console.log(`[S2] Zyte product failed: ${e.message}`)
  }

  // Step 2: Zyte browserHtml + Claude (thorough extraction)
  let claudeSpecs = {}
  let html = null

  try {
    const br = await timedFetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + b64(ZYTE + ':'),
      },
      body: JSON.stringify({ url, browserHtml: true }),
    }, 55000)

    const bd = await br.json()
    if (br.status === 200 && bd.browserHtml) {
      html = bd.browserHtml
      // Extract og:image if we don't have one yet
      if (!image) {
        const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
        if (m) image = m[1]
      }
      console.log(`[S3] Zyte browserHtml: ${html.length} chars`)
    } else {
      console.log(`[S3] Zyte browserHtml failed: HTTP ${br.status}`)
    }
  } catch (e) {
    console.log(`[S3] Zyte browserHtml error: ${e.message}`)
  }

  if (html) {
    const text = stripHtml(html).slice(0, 45000)
    try {
      const cr = await timedFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 3000,
          tools: [{
            name: 'extract',
            description: 'Extract product name and all specs',
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
            content: `Extract the product name and EVERY product specification from this retailer page. Only include specs literally present — never invent. Be exhaustive: spec tables, "Product Details", "Tech Specs", dimensions, materials, certifications, accessories, warranty.\n\nPAGE TEXT:\n${text}`,
          }],
        }),
      }, 40000)

      const cd = await cr.json()
      const block = cd.content?.find(b => b.type === 'tool_use')
      if (block?.input) {
        if (block.input.productName && !productName) productName = block.input.productName
        for (const { label, value } of (block.input.specs || [])) {
          if (label && value) claudeSpecs[label.trim()] = value.trim()
        }
        console.log(`[S4] Claude: ${Object.keys(claudeSpecs).length} specs`)
      }
    } catch (e) {
      console.log(`[S4] Claude failed: ${e.message}`)
    }
  }

  // Merge: Claude is usually more complete, Zyte structured data fills gaps
  const specs = { ...zyteSpecs, ...claudeSpecs }

  if (Object.keys(specs).length === 0) {
    return res.status(422).json({
      error: 'No specs found',
      detail: `Could not extract specs from this page. It may block automated access.`,
    })
  }

  console.log(`[S5] Final: ${Object.keys(specs).length} specs for "${productName}"`)
  return res.status(200).json({ specs, productName: productName || 'Unknown product', image })
}
