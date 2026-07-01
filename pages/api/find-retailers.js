// pages/api/find-retailers.js
// Uses Serper.dev Google Shopping to find real product URLs from top retailers.
// Serper returns Google redirect URLs, so we extract the actual retailer URL
// from the redirect's ?q= parameter.

export const config = { maxDuration: 30 }

const RETAILER_TIERS = {
  appliance:   ['wayfair.com','ajmadison.com','bestbuy.com','homedepot.com','lowes.com','costco.com','target.com'],
  electronics: ['bestbuy.com','target.com','costco.com','bhphotovideo.com','walmart.com','crutchfield.com','amazon.com'],
  outdoor:     ['rei.com','backcountry.com','evo.com','dickssportinggoods.com','moosejaw.com','target.com','amazon.com'],
  golf:        ['golfgalaxy.com','pgatoursuperstore.com','dickssportinggoods.com','callaway.com','amazon.com','2ndswing.com'],
  furniture:   ['wayfair.com','target.com','westelm.com','crateandbarrel.com','potterybarn.com','article.com'],
  fashion:     ['target.com','nordstrom.com','zappos.com','macys.com','amazon.com','dickssportinggoods.com'],
  default:     ['wayfair.com','target.com','bestbuy.com','walmart.com','costco.com','homedepot.com','amazon.com'],
}

function getCategoryType(category) {
  const c = category.toLowerCase()
  if (/dishwasher|washer|dryer|fridge|refrigerator|oven|range|microwave|coffee|espresso|blender|air.?fryer|toaster/.test(c)) return 'appliance'
  if (/tv|television|laptop|computer|headphone|speaker|camera|phone|tablet|monitor/.test(c)) return 'electronics'
  if (/ski|snowboard|hik|camp|kayak|paddleboard|tent|backpack/.test(c)) return 'outdoor'
  if (/golf/.test(c)) return 'golf'
  if (/sofa|couch|chair|desk|bed|dresser|table|furniture|mattress/.test(c)) return 'furniture'
  if (/shoe|boot|sneaker|shirt|dress|jacket|coat|pants|jeans/.test(c)) return 'fashion'
  return 'default'
}

// Serper returns Google redirect URLs like /url?q=https://wayfair.com/...
// This extracts the real retailer URL from the redirect
function extractDirectUrl(serperLink) {
  if (!serperLink) return null
  try {
    // Handle /url?q=https://... format
    if (serperLink.includes('/url?')) {
      const u = new URL('https://google.com' + serperLink)
      const q = u.searchParams.get('q')
      if (q && q.startsWith('http')) return q
    }
    // Handle full URLs that are already direct
    if (serperLink.startsWith('http')) return serperLink
    return null
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category } = req.body
  if (!category) return res.status(400).json({ error: 'Missing category' })

  const SERPER_KEY = process.env.SERPER_API_KEY
  if (!SERPER_KEY) return res.status(500).json({ error: 'Missing SERPER_API_KEY — add it to Vercel environment variables' })

  const categoryType = getCategoryType(category)
  const targetRetailers = RETAILER_TIERS[categoryType]

  console.log(`[FR1] Searching for "${category}" (type: ${categoryType})`)

  try {
    const r = await fetch('https://google.serper.dev/shopping', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': SERPER_KEY,
      },
      body: JSON.stringify({
        q: category,
        gl: 'us',
        hl: 'en',
        num: 40,
      }),
    })

    const data = await r.json()

    if (!r.ok || data.error) {
      console.log(`[FR2] Serper error:`, data.error || r.status)
      return res.status(502).json({ error: 'Serper search failed', detail: data.error || `HTTP ${r.status}` })
    }

    const results = data.shopping || []
    console.log(`[FR3] Got ${results.length} shopping results`)

    // Pick one product URL per target retailer
    const found = {}

    for (const item of results) {
      // Serper shopping results have: title, source, link, price, imageUrl
      const rawLink = item.link || ''
      const source  = (item.source || '').toLowerCase()
      const directUrl = extractDirectUrl(rawLink) || rawLink

      for (const domain of targetRetailers) {
        if (found[domain]) continue

        const domainBase = domain.replace('.com', '')
        if (directUrl.includes(domain) || source.includes(domainBase) || source.replace(/\s+/g,'').toLowerCase().includes(domainBase)) {
          // Skip search pages, non-product pages, used/refurbished
          if (directUrl.includes('/search') || directUrl.includes('/s?') || directUrl.includes('?k=')) continue
          if ((item.condition || '').toLowerCase().includes('used')) continue
          if ((item.condition || '').toLowerCase().includes('refurb')) continue

          found[domain] = {
            retailer: item.source || (domainBase.charAt(0).toUpperCase() + domainBase.slice(1)),
            url: directUrl,
            title: item.title,
            price: item.price,
            thumbnail: item.imageUrl || item.thumbnailUrl || null,
          }
        }
      }

      if (Object.keys(found).length >= 6) break
    }

    const retailers = Object.values(found)
    console.log(`[FR4] Found ${retailers.length} retailers:`, retailers.map(r => r.retailer).join(', '))

    if (retailers.length === 0) {
      return res.status(422).json({
        error: 'No retailer product pages found',
        detail: `Serper returned ${results.length} results but none matched target retailers for "${category}"`,
      })
    }

    return res.status(200).json({ retailers })

  } catch (e) {
    console.log(`[FR5] Exception:`, e.message)
    return res.status(502).json({ error: 'Retailer search failed', detail: e.message })
  }
}
