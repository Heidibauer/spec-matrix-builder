// pages/api/build-matrix.js
// Builds the final spec matrix: one row per retailer/product (specs exactly as
// scraped, verbatim), plus a final "Recommended" row that picks the best spec
// set for buying decisions. No new specs are invented at this stage — this
// step only organizes and selects from what scrape.js already extracted.

export const config = {
  maxDuration: 60,
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category, products } = req.body
  // products = [{ retailer, url, productName, specs: {label: value} }, ...]
  if (!category || !products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'Missing category or products array' })
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `You are building a buying-decision spec comparison for "${category}" shoppers.

Below are the RAW, VERBATIM specs already scraped from ${products.length} retailer product pages. These are real, already-extracted facts — your job here is NOT to find new specs, but to:
1. Identify which spec concepts are the same across different products even when labeled differently (e.g. "Brew Capacity" and "Number of Cups" are the same concept)
2. Group all specs into a consistent set of spec rows (columns in the final table) so they line up
3. Build ONE recommended row that represents the best spec set a shopper should see to make a buying decision

RAW DATA:
${JSON.stringify(products.map(p => ({ retailer: p.retailer, productName: p.productName, specs: p.specs })), null, 2)}

CRITICAL RULES:
- NEVER invent a spec value. Every value in your output must be traceable to the raw data above, copied exactly.
- Do not average, estimate, or merge differing values into a new number. If retailers disagree, only pick one of their actual stated values for the recommended row, or mark it as varies.
- Use product knowledge ONLY to judge which spec concepts matter for buying decisions (e.g. brew capacity matters, color may not) — not to invent spec values.

Return ONLY a JSON object in this exact structure, no other text:
{
  "category": "${category}",
  "products": [
    { "retailer": "RetailerName", "productName": "exact product name", "url": "the url" }
  ],
  "specRows": [
    {
      "concept": "short label for what this spec measures, e.g. Cup capacity",
      "valuesByRetailer": {
        "RetailerName": "exact label: exact value" 
      },
      "recommendedLabel": "the clearest actual label to use in the database, pulled from the real data",
      "recommendedValue": "the best actual value to show shoppers, copied from real data, or null if it meaningfully varies and there's no single best answer",
      "buyingDecisionImportance": "high" | "medium" | "low",
      "includeInRecommended": true
    }
  ]
}

Rules:
- valuesByRetailer: for each retailer in the input, include their exact label+value as a single string "label: value" if they have this spec concept, or null if they don't have it at all
- includeInRecommended: false for non-decision specs like model numbers, SKUs, color variant codes, marketing taglines; true for genuinely useful purchase-decision specs (capacity, dimensions, power, materials, included accessories, compatibility, etc)
- buyingDecisionImportance: "high" for specs most shoppers check first (capacity, size, power, key features), "medium" for useful but secondary specs, "low" for minor details
- Sort specRows by buyingDecisionImportance (high → medium → low), then by how many retailers report that spec (most → fewest)
- Return ONLY valid JSON, nothing else`,
        }],
      }),
    })

    const data = await claudeRes.json()

    if (claudeRes.status !== 200) {
      console.log('Claude matrix build error:', JSON.stringify(data))
      return res.status(502).json({
        error: 'Claude API error',
        detail: data.error?.message || JSON.stringify(data).slice(0, 500),
      })
    }

    const text = data.content?.find(b => b.type === 'text')?.text || ''
    const cleaned = text.replace(/```json|```/g, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)

    if (!match) {
      return res.status(422).json({
        error: 'Claude did not return valid JSON for the matrix',
        detail: text.slice(0, 300),
      })
    }

    return res.status(200).json(JSON.parse(match[0]))
  } catch (err) {
    return res.status(502).json({ error: 'Matrix build failed', detail: err.message })
  }
}
