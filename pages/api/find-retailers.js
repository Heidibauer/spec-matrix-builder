// pages/api/find-retailers.js
//
// ROOT CAUSE OF PREVIOUS FAILURES:
// Serper's /shopping endpoint returns Google Shopping listing links
// (https://www.google.com/search?ibp=oshop...) NOT direct retailer URLs.
// There is no retailer product URL in those results to pass to Zyte.
//
// CORRECT APPROACH:
// Use Serper's /search endpoint with site: operator.
// Search "coffee maker site:wayfair.com" -> returns real Wayfair product URLs.
// One search per retailer, run in parallel. Fast, reliable, direct URLs.
//
// This uses ~5-6 Serper searches per category run.
// Serper pricing: $50/month for 50k searches = essentially free for this use case.

export const config = { maxDuration: 60 }

// Per-category retailer priority lists
const RETAILER_TIERS = {
  appliance:   ['wayfair.com','ajmadison.com','homedepot.com','lowes.com','target.com','costco.com'],
  electronics: ['bestbuy.com','target.com','costco.com','bhphotovideo.com','crutchfield.com','walmart.com'],
  outdoor:     ['rei.com','backcountry.com','evo.com','dickssportinggoods.com','moosejaw.com'],
  golf:        ['golfgalaxy.com','pgatoursuperstore.com','dickssportinggoods.com','2ndswing.com','globalgolf.com'],
  furniture:   ['wayfair.com','target.com','westelm.com','crateandbarrel.com','potterybarn.com'],
  fashion:     ['zappos.com','nordstrom.com','target.com','macys.com','dickssportinggoods.com'],
  default:     ['wayfair.com','target.com','homedepot.com','walmart.com','costco.com','lowes.com'],
}

function getCategoryType(category) {
  const c = category.toLowerCase()
  if (/dishwasher|washer|dryer|fridge|refrigerator|oven|range|microwave|coffee|espresso|blender|air.?fryer|toaster|kettle/.test(c)) return 'appliance'
  if (/tv|television|laptop|computer|headphone|speaker|camera|phone|tablet|monitor/.test(c)) return 'electronics'
  if (/ski|snowboard|hik|camp|kayak|paddleboard|tent|backpack|bike|bicycle/.test(c)) return 'outdoor'
  if (/golf/.test(c)) return 'golf'
  if (/sofa|couch|chair|desk|bed|dresser|table|furniture|mattress/.test(c)) return 'furniture'
  if (/shoe|boot|sneaker|shirt|dress|jacket|coat|pants|jeans/.test(c)) return 'fashion'
  return 'default'
}

// Search one retailer for a product URL using site: operator
async function searchRetailer(category, domain, serperKey) {
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': serperKey,
      },
      body: JSON.stringify({
        q: `${category} site:${domain}`,
        gl: 'us',
        hl: 'en',
        num: 5,
      }),
    })

    if (!r.ok) {
      console.log(`[FR] ${domain}: HTTP ${r.status}`)
      return null
    }

    const data = await r.json()
    const results = data.organic || []

    // Find the first result that looks like a real product page
    // (not a category page, search page, or homepage)
    for (const result of results) {
      const url = result.link || ''
      const title = result.title || ''

      // Skip non-product pages
      if (!url) continue
      if (url.endsWith('.com') || url.endsWith('.com/')) continue
      if (url.includes('/search') || url.includes('/category') || url.includes('/c/')) continue
      if (url.includes('/browse') || url.includes('/catalog') || url.includes('/shop?')) continue
      if (url === `https://www.${domain}` || url === `https://${domain}`) continue

      console.log(`[FR] ${domain}: found "${title.slice(0, 50)}" -> ${url.slice(0, 80)}`)
      return {
        retailer: domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1),
        url,
        title,
        thumbnail: result.thumbnail || null,
      }
    }

    console.log(`[FR] ${domain}: no product page found in ${results.length} results`)
    return null
  } catch (e) {
    console.log(`[FR] ${domain}: error ${e.message}`)
    return null
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category } = req.body
  if (!category) return res.status(400).json({ error: 'Missing category' })

  const SERPER_KEY = process.env.SERPER_API_KEY
  if (!SERPER_KEY) {
    return res.status(500).json({
      error: 'Missing SERPER_API_KEY',
      detail: 'Add your Serper.dev API key to Vercel environment variables as SERPER_API_KEY',
    })
  }

  const categoryType = getCategoryType(category)
  const domains = RETAILER_TIERS[categoryType]

  console.log(`[FR1] Finding "${category}" products on ${domains.length} retailer sites`)

  // Search all retailers concurrently — each uses site: operator
  // to get real product page URLs directly
  const results = await Promise.all(
    domains.map(domain => searchRetailer(category, domain, SERPER_KEY))
  )

  const retailers = results.filter(Boolean)
  console.log(`[FR2] Found product URLs for ${retailers.length}/${domains.length} retailers`)

  if (retailers.length === 0) {
    return res.status(422).json({
      error: 'No retailer product pages found',
      detail: `Searched ${domains.length} retailers for "${category}" but found no matching product pages`,
    })
  }

  return res.status(200).json({ retailers })
}
