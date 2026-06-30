// pages/api/build-matrix.js v8
//
// [BM-L1] Uses Claude tool-use (not raw text + regex) so the API validates
//   JSON before we see it — eliminates parse crashes from spec values with
//   quote marks like 12.13'' H X 9.33'' W.
// [BM-L2] max_tokens raised to 8000 — earlier 4000 caused empty specRows
//   when Claude's response got cut off mid-generation.
// [BM-L3] recommendedSpecs is a flat list of curated specs with concrete
//   values — never "varies", always a real value from one retailer.
// [BM-L4] Each specRow has a groupLabel for section headers in the table.

export const config = { maxDuration: 60 }

const TOOL = {
  name: 'build_matrix',
  description: 'Build the spec comparison matrix',
  input_schema: {
    type: 'object',
    properties: {
      specRows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            concept:      { type: 'string', description: 'Short name for this spec concept, e.g. "Cup capacity"' },
            group:        { type: 'string', description: 'Section this spec belongs to: "Capacity & Brewing", "Dimensions & Weight", "Power & Electrical", "Materials & Design", "Included Accessories", "Compatibility", "Warranty", or "Other"' },
            byRetailer: {
              type: 'object',
              description: 'Exact "label: value" string from each retailer, verbatim. null if that retailer does not have this spec.',
              additionalProperties: { type: ['string', 'null'] },
            },
          },
          required: ['concept', 'group', 'byRetailer'],
        },
      },
      recommendedSpecs: {
        type: 'array',
        description: 'Curated list of 8-15 specs a shopper actually checks when buying this product. Must be genuinely useful for buying decisions.',
        items: {
          type: 'object',
          properties: {
            label:          { type: 'string', description: 'Clearest real label from the retailer data' },
            value:          { type: 'string', description: 'Concrete value from one specific retailer — never "varies", always real' },
            group:          { type: 'string' },
            fromRetailer:   { type: 'string', description: 'Which retailer this value came from' },
          },
          required: ['label', 'value', 'group', 'fromRetailer'],
        },
      },
    },
    required: ['specRows', 'recommendedSpecs'],
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category, products } = req.body
  if (!category || !Array.isArray(products) || !products.length) {
    return res.status(400).json({ error: 'Missing category or products' })
  }

  const KEY = process.env.ANTHROPIC_API_KEY
  if (!KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  const retailers = products.map(p => p.retailer)
  const trimmed = products.map(p => ({
    retailer: p.retailer,
    productName: p.productName,
    specs: Object.fromEntries(Object.entries(p.specs).slice(0, 50)),
  }))

  console.log(`[BM-1] ${category} — ${products.length} products, ${trimmed.reduce((n, p) => n + Object.keys(p.specs).length, 0)} total specs`)

  let claudeRes, data
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'build_matrix' },
        messages: [{
          role: 'user',
          content: `You are organizing verbatim product specs for a "${category}" buying comparison.

RAW SCRAPED DATA (${products.length} retailers):
${JSON.stringify(trimmed, null, 2)}

TASK 1 — specRows: Match equivalent specs across retailers into rows even when labels differ. For each row:
- concept: short clear label for what this spec measures
- group: one of "Capacity & Brewing", "Dimensions & Weight", "Power & Electrical", "Materials & Design", "Included Accessories", "Compatibility", "Warranty", "Other"
- byRetailer: for EVERY retailer in ${JSON.stringify(retailers)}, include their exact "label: value" string, or null if absent

TASK 2 — recommendedSpecs: Pick 8-15 specs a shopper genuinely checks before buying a ${category}. For each:
- Use a real, concrete value copied from one specific retailer
- Never write "varies" — always pick the most complete/precise real value
- Note which retailer it came from

RULES:
- Never invent values. Every value must come verbatim from the raw data above.
- byRetailer must have a key for every retailer: ${JSON.stringify(retailers)}

Call the build_matrix tool.`,
        }],
      }),
    })
    data = await claudeRes.json()
  } catch (err) {
    return res.status(502).json({ error: 'Claude request failed', detail: err.message })
  }

  if (claudeRes.status !== 200) {
    console.log('[BM-2] Claude error:', JSON.stringify(data).slice(0, 500))
    return res.status(502).json({ error: 'Claude API error', detail: data.error?.message })
  }

  console.log(`[BM-3] stop_reason:${data.stop_reason} output_tokens:${data.usage?.output_tokens}`)

  const block = data.content?.find(b => b.type === 'tool_use' && b.name === 'build_matrix')
  if (!block?.input?.specRows?.length) {
    console.log('[BM-4] No specRows. content:', JSON.stringify(data.content?.map(b => b.type)))
    return res.status(422).json({ error: 'Claude returned empty matrix', detail: `stop_reason: ${data.stop_reason}` })
  }

  console.log(`[BM-5] specRows:${block.input.specRows.length} recommended:${block.input.recommendedSpecs?.length}`)

  return res.status(200).json({
    category,
    products: products.map(p => ({ retailer: p.retailer, productName: p.productName, url: p.url, image: p.image || null })),
    specRows: block.input.specRows,
    recommendedSpecs: block.input.recommendedSpecs || [],
  })
}
