// pages/api/build-matrix.js
//
// [BM-R1] Major rework based on feedback:
//   - Recommended column was showing non-answers like "varies" — fixed by
//     always requiring a real, concrete value choice from the actual data.
//   - No category grouping/headers — added groupLabel per spec row so the
//     frontend can render section headers (Capacity & Brewing, Dimensions,
//     Power, etc).
//   - Recommended specs weren't genuinely curated for buying decisions —
//     prompt now explicitly frames this as "what would a shopper actually
//     check before buying" and requires a one-line justification per
//     recommended spec so the curation is auditable, not just a guess.

export const config = {
  maxDuration: 60,
}

const MATRIX_TOOL = {
  name: 'build_spec_matrix',
  description: 'Return the organized, grouped spec comparison matrix with curated buying-decision recommendations',
  input_schema: {
    type: 'object',
    properties: {
      specRows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            concept: { type: 'string', description: 'Short label for what this spec measures, e.g. "Cup capacity"' },
            groupLabel: { type: 'string', description: 'Category this spec belongs to, e.g. "Capacity & Brewing", "Dimensions & Weight", "Power & Electrical", "Materials & Design", "Included Accessories", "Warranty & Certifications", "Other Features"' },
            valuesByRetailer: {
              type: 'object',
              description: 'Map of retailer name to the EXACT label+value from that retailer\'s page, formatted as "label: value". Use null if that retailer does not have this spec. NEVER normalize or rewrite — copy exactly as scraped.',
              additionalProperties: { type: ['string', 'null'] },
            },
          },
          required: ['concept', 'groupLabel', 'valuesByRetailer'],
        },
      },
      recommendedSpecs: {
        type: 'array',
        description: 'The curated final list of specs to show shoppers — the genuinely useful subset that helps someone decide whether to buy this product. NOT every spec from specRows. Think like a product page editor: what would a real shopper actually check?',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The clearest real label, pulled from actual retailer data' },
            value: { type: 'string', description: 'A real, concrete value copied from one retailer\'s actual data. Never "varies" or any non-answer — always pick the most complete/precise real value available.' },
            groupLabel: { type: 'string', description: 'Same category system as specRows' },
            sourceRetailer: { type: 'string', description: 'Which retailer this value was copied from' },
            whyItMatters: { type: 'string', description: 'One short phrase on why a shopper cares about this spec, e.g. "Determines how many cups before refilling"' },
          },
          required: ['label', 'value', 'groupLabel', 'sourceRetailer', 'whyItMatters'],
        },
      },
    },
    required: ['specRows', 'recommendedSpecs'],
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category, products } = req.body
  if (!category || !products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'Missing category or products array' })
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  const SPECS_PER_PRODUCT_CAP = 50 // [BM-R2] raised since dual-pass scraping now finds more real specs
  const trimmedProducts = products.map(p => ({
    retailer: p.retailer,
    productName: p.productName,
    specs: Object.fromEntries(Object.entries(p.specs).slice(0, SPECS_PER_PRODUCT_CAP)),
  }))

  const totalSpecsSent = trimmedProducts.reduce((sum, p) => sum + Object.keys(p.specs).length, 0)
  console.log(`[BM-9] Building matrix for "${category}" — ${products.length} products, ${totalSpecsSent} total specs sent to Claude`)

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        tools: [MATRIX_TOOL],
        tool_choice: { type: 'tool', name: 'build_spec_matrix' },
        messages: [{
          role: 'user',
          content: `You are organizing scraped product specs for a "${category}" buying guide, and separately curating a short list of the specs that actually matter for a buying decision.

RAW DATA — verbatim specs already scraped from ${trimmedProducts.length} retailer pages:
${JSON.stringify(trimmedProducts, null, 2)}

PART 1 — specRows (the full reference matrix):
- Match equivalent spec concepts across retailers even when labeled differently (e.g. "Brew Capacity" and "Number of Cups" are the same concept)
- For each concept, include every retailer's EXACT label and value, verbatim, never normalized or reworded. Format as "label: value" (e.g. "Capacity: 66 oz"). Use null where a retailer doesn't have it.
- Assign each row a groupLabel category: "Capacity & Brewing", "Dimensions & Weight", "Power & Electrical", "Materials & Design", "Included Accessories", "Warranty & Certifications", or "Other Features" (use whichever categories make sense for ${category} — adapt names if needed for this product type).
- valuesByRetailer must have a key for every retailer: ${JSON.stringify(trimmedProducts.map(p => p.retailer))}.

PART 2 — recommendedSpecs (the curated shopper-facing list):
Think like an experienced e-commerce merchandiser writing the "Specifications" box that actually ships on a product page. A shopper deciding whether to buy this ${category} checks maybe 8-15 specs, not 40. Select ONLY those — the ones that actually drive a purchase decision (capacity/size, power, key dimensions, standout features, what's included, compatibility, warranty length). Skip SKUs, model numbers, color-only variants, and minor details no one checks.

CRITICAL RULES:
- NEVER invent a value. Every value in both sections must be traceable to the raw data above, copied exactly.
- recommendedSpecs.value must ALWAYS be a real, concrete value from one specific retailer — never "varies", never blank, never a vague placeholder. If retailers disagree on a value, just pick the clearest/most complete one and cite which retailer it came from in sourceRetailer.
- Do not pad recommendedSpecs to hit a count — only include genuinely decision-relevant specs, even if that's only 8-10 for this product.

Call the build_spec_matrix tool with your result.`,
        }],
      }),
    })

    let data
    try {
      data = await claudeRes.json()
    } catch (parseErr) {
      console.log('[BM-11] Claude response was not valid JSON. Status:', claudeRes.status, parseErr.message)
      return res.status(502).json({ error: 'Claude API returned an unreadable response', detail: `HTTP ${claudeRes.status}` })
    }

    if (claudeRes.status !== 200) {
      console.log('[BM-12] Claude matrix build error:', JSON.stringify(data))
      return res.status(502).json({ error: 'Claude API error', detail: data.error?.message || JSON.stringify(data).slice(0, 500) })
    }

    console.log('[BM-14] stop_reason:', data.stop_reason, '| usage:', JSON.stringify(data.usage))

    const toolUseBlock = data.content?.find(b => b.type === 'tool_use' && b.name === 'build_spec_matrix')
    if (!toolUseBlock) {
      console.log('[BM-15] No tool_use block. content types:', JSON.stringify(data.content?.map(b => b.type)))
      return res.status(422).json({ error: 'Claude did not return a structured matrix', detail: `stop_reason: ${data.stop_reason}` })
    }

    const specRows = toolUseBlock.input?.specRows
    const recommendedSpecs = toolUseBlock.input?.recommendedSpecs

    console.log(`[BM-17] specRows: ${specRows?.length ?? 'n/a'}, recommendedSpecs: ${recommendedSpecs?.length ?? 'n/a'}`)

    if (!specRows || !Array.isArray(specRows) || specRows.length === 0) {
      console.log('[BM-19] specRows empty. Raw input:', JSON.stringify(toolUseBlock.input).slice(0, 1500))
      return res.status(422).json({ error: 'Claude returned an empty spec matrix', detail: `stop_reason: ${data.stop_reason}` })
    }

    const result = {
      category,
      products: products.map(p => ({ retailer: p.retailer, productName: p.productName, url: p.url, image: p.image || null })),
      specRows,
      recommendedSpecs: recommendedSpecs || [],
    }

    console.log(`[BM-20] Success: ${specRows.length} spec rows, ${result.recommendedSpecs.length} recommended specs`)
    return res.status(200).json(result)
  } catch (err) {
    console.log('[BM-21] Matrix build exception:', err.message, err.stack)
    return res.status(502).json({ error: 'Matrix build failed', detail: err.message || 'Unknown error' })
  }
}
