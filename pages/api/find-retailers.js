// pages/api/find-retailers.js
// Uses SerpApi Google Shopping to find real product URLs from top retailers
// for a given category. Returns up to 8 retailer URLs with direct links.

export const config = { maxDuration: 30 }

// Retailers to target per category type — Claude picks the right ones
const RETAILER_TIERS = {
  appliance:  ['wayfair.com', 'ajmadison.com', 'bestbuy.com', 'homedepot.com', 'lowes.com', 'costco.com', 'target.com'],
  electronics:['bestbuy.com', 'target.com', 'costco.com', 'bhphotovideo.com', 'amazon.com', 'walmart.com', 'crutchfield.com'],
  outdoor:    ['rei.com', 'backcountry.com', 'evo.com', 'dickssportinggoods.com', 'moosejaw.com', 'target.com'],
  golf:       ['golfgalaxy.com', 'pgatoursuperstore.com', 'dickssportinggoods.com', 'callaway.com', 'amazon.com'],
  furniture:  ['wayfair.com', 'target.com', 'westelm.com', 'crateandbarrel.com', 'cb2.com', 'potterybarn.com'],
  fashion:    ['target.com', 'nordstrom.com', 'zappos.com', 'macys.com', 'amazon.com'],
  default:    ['wayfair.com', 'target.com', 'bestbuy.com', 'amazon.com', 'walmart.com', 'costco.com', 'homedepot.com'],
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category } = req.body
  if (!category) return res.status(400).json({ error: 'Missing category' })

  const SERP_KEY = process.env.SERPAPI_KEY
  if (!SERP_KEY) return res.status(500).json({ error: 'Missing SERPAPI_KEY — add it to Vercel environment variables' })

  const categoryType = getCategoryType(category)
  const targetRetailers = RETAILER_TIERS[categoryType]

  console.log(`[FR1] Searching for "${category}" (type: ${categoryType}) across ${targetRetailers.length} retailers`)

  try {
    // Single Google Shopping search — returns results from many retailers at once
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: category,
      gl: 'us',
      hl: 'en',
      num: '40',  // Get enough results to find multiple retailers
      api_key: SERP_KEY,
    })

    const r = await fetch(`https://serpapi.com/search.json?${params}`)
    const data = await r.json()

    if (!r.ok || data.error) {
      console.log(`[FR2] SerpApi error:`, data.error)
      return res.status(502).json({ error: 'SerpApi search failed', detail: data.error })
    }

    const results = data.shopping_results || []
    console.log(`[FR3] Got ${results.length} shopping results`)

    // Pick the best product URL per target retailer
    // We want one real product page per retailer, prioritizing results
    // with more reviews (more established products = better spec coverage)
    const found = {}

    for (const item of results) {
      const link = item.link || ''
      const source = (item.source || '').toLowerCase()

      for (const domain of targetRetailers) {
        if (found[domain]) continue // already found one for this retailer

        // Match by domain in link URL or source name
        const domainBase = domain.replace('.com', '')
        if (link.includes(domain) || source.includes(domainBase)) {
          // Skip marketplace sellers, used/refurbished, and non-product pages
          if (link.includes('/search') || link.includes('/s?') || link.includes('?k=')) continue
          if (item.second_hand_condition) continue
          found[domain] = {
            retailer: item.source || domainBase.charAt(0).toUpperCase() + domainBase.slice(1),
            url: link,
            title: item.title,
            price: item.price,
            thumbnail: item.thumbnail,
          }
        }
      }

      if (Object.keys(found).length >= 6) break // enough retailers found
    }

    const retailers = Object.values(found)
    console.log(`[FR4] Found ${retailers.length} retailers:`, retailers.map(r => r.retailer))

    if (retailers.length === 0) {
      return res.status(422).json({
        error: 'No retailer product pages found',
        detail: `Google Shopping returned ${results.length} results but none matched target retailers`,
      })
    }

    return res.status(200).json({ retailers })

  } catch (e) {
    console.log(`[FR5] Exception:`, e.message)
    return res.status(502).json({ error: 'Retailer search failed', detail: e.message })
  }
}
