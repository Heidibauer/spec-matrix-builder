// pages/api/build-matrix.js
//
// REWRITTEN. The old version crashed because it extracted JSON from Claude's
// raw text response using a regex (/\{[\s\S]*\}/), which breaks the instant
// a spec value contains an unescaped quote mark (e.g. 12.13'' H X 9.33'' W —
// literal double-prime/inch marks are extremely common in dimension specs
// and are NOT valid inside a naive regex-matched JSON string).
//
// Fix: use Claude's native tool-use / structured output instead of asking
// for "raw JSON text" and hoping it's parseable. We define a tool schema
// and force Claude to call it — the Anthropic API enforces valid JSON
// against the schema before we ever see it, eliminating this entire class
// of parse failure.

export const config = {
  maxDuration: 60,
}

const MATRIX_TOOL = {
  name: 'build_spec_matrix',
  description: 'Return the organized spec comparison matrix',
  input_schema: {
    type: 'object',
    properties: {
      specRows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            concept: { type: 'string', description: 'Short label for what this spec measures, e.g. "Cup capacity"' },
            valuesByRetailer: {
              type: 'object',
              description: 'Map of retailer name to "label: value" string, or null if that retailer does not have this spec',
              additionalProperties: { type: ['string', 'null'] },
            },
            recommendedLabel: { type: 'string', description: 'The clearest actual label pulled from the real retailer data' },
            recommendedValue: { type: ['string', 'null'], description: 'The best actual value copied from real data, or null if it varies meaningfully across retailers' },
            buyingDecisionImportance: { type: 'string', enum: ['high', 'medium', 'low'] },
            includeInRecommended: { type: 'boolean', description: 'false for model numbers, SKUs, color codes, marketing taglines; true for genuine purchase-decision specs' },
          },
          required: ['concept', 'valuesByRetailer', 'recommendedLabel', 'recommendedValue', 'buyingDecisionImportance', 'includeInRecommended'],
        },
      },
    },
    required: ['specRows'],
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
        tools: [MATRIX_TOOL],
        tool_choice: { type: 'tool', name: 'build_spec_matrix' },
        messages: [{
          role: 'user',
          content: `You are building a buying-decision spec comparison for "${category}" shoppers.

Below are RAW, VERBATIM specs already scraped from ${products.length} retailer product pages. These are real, already-extracted facts. Your job:
1. Identify which spec concepts are the same across products even when labeled differently (e.g. "Brew Capacity" and "Number of Cups" are the same concept)
2. Group all specs into a consistent set of spec rows so they line up across retailers
3. Build one recommended label+value per row representing the best spec a shopper should see

RAW DATA:
${JSON.stringify(products.map(p => ({
  retailer: p.retailer,
  productName: p.productName,
  specs: Object.fromEntries(Object.entries(p.specs).slice(0, 40)),
})), null, 2)}

CRITICAL RULES:
- NEVER invent a spec value. Every value must be traceable to the raw data above, copied exactly.
- Do not average, estimate, or merge differing values into a new number. If retailers disagree, pick one of their actual stated values for the recommended row, or set recommendedValue to null.
- Use product knowledge ONLY to judge which spec concepts matter for buying decisions — never to invent spec values.
- valuesByRetailer must include an entry for every retailer: ${JSON.stringify(products.map(p => p.retailer))}. Use null where that retailer doesn't have the spec.
- Sort specRows by buyingDecisionImportance (high → medium → low), then by how many retailers report that spec (most → fewest).

Call the build_spec_matrix tool with your result.`,
        }],
      }),
    })

    let data
    try {
      data = await claudeRes.json()
    } catch (parseErr) {
      console.log('Claude response was not valid JSON. Status:', claudeRes.status, 'Parse error:', parseErr.message)
      return res.status(502).json({
        error: 'Claude API returned an unreadable response',
        detail: `HTTP ${claudeRes.status}: ${parseErr.message}`,
      })
    }

    if (claudeRes.status !== 200) {
      console.log('Claude matrix build error:', JSON.stringify(data))
      return res.status(502).json({
        error: 'Claude API error',
        detail: data.error?.message || JSON.stringify(data).slice(0, 500),
      })
    }

    // Tool-use responses come back as a structured content block — no
    // regex, no manual parsing, no chance of broken JSON from quote marks.
    const toolUseBlock = data.content?.find(b => b.type === 'tool_use' && b.name === 'build_spec_matrix')

    if (!toolUseBlock || !toolUseBlock.input) {
      console.log('No tool_use block found. Full response:', JSON.stringify(data).slice(0, 1000))
      return res.status(422).json({
        error: 'Claude did not return a structured matrix',
        detail: 'Expected a tool_use block but none was found in the response',
      })
    }

    const result = {
      category,
      products: products.map(p => ({
        retailer: p.retailer,
        productName: p.productName,
        url: p.url,
        image: p.image || null,
      })),
      specRows: toolUseBlock.input.specRows || [],
    }

    return res.status(200).json(result)
  } catch (err) {
    console.log('Matrix build exception:', err.message, err.stack)
    return res.status(502).json({ error: 'Matrix build failed', detail: err.message || 'Unknown error' })
  }
}
