// pages/api/build-matrix.js
//
// [BM-1] HISTORY: v1 crashed on regex-extracted JSON breaking on literal
//   quote marks in spec values (e.g. 12.13'' H X 9.33'' W).
// [BM-2] FIX: switched to Claude tool-use so the Anthropic API validates
//   structured output before we see it — eliminates regex/parse failures.
// [BM-3] NEW BUG (this revision): with 4 products and up to 40 specs each,
//   the matrix build returned HTTP 200 but specRows was empty. Root cause
//   suspected: max_tokens=4000 was too small to let Claude finish building
//   a full specRows array across 4 retailers x dozens of concepts, so the
//   tool call likely got cut off (stop_reason: max_tokens) mid-generation,
//   producing an incomplete/empty `input`. This revision fixes that by:
//   (a) raising max_tokens substantially, (b) logging stop_reason and the
//   raw tool input length so we can see this happening in logs going
//   forward instead of silently defaulting to an empty array, and (c)
//   trimming specs sent per product more aggressively to leave more of
//   the token budget for the actual output.

export const config = {
  maxDuration: 60,
}

// [BM-4] Schema definition for the matrix tool call.
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' }) // [BM-5]

  const { category, products } = req.body
  if (!category || !products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'Missing category or products array' }) // [BM-6]
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' }) // [BM-7]

  // [BM-8] Cap specs per product more aggressively (was 40, now 30) to
  // leave more output-token headroom for the actual matrix generation.
  const SPECS_PER_PRODUCT_CAP = 30
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
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000, // [BM-10] raised from 4000 — suspected root cause of empty specRows
        tools: [MATRIX_TOOL],
        tool_choice: { type: 'tool', name: 'build_spec_matrix' },
        messages: [{
          role: 'user',
          content: `You are building a buying-decision spec comparison for "${category}" shoppers.

Below are RAW, VERBATIM specs already scraped from ${trimmedProducts.length} retailer product pages. These are real, already-extracted facts. Your job:
1. Identify which spec concepts are the same across products even when labeled differently (e.g. "Brew Capacity" and "Number of Cups" are the same concept)
2. Group all specs into a consistent set of spec rows so they line up across retailers
3. Build one recommended label+value per row representing the best spec a shopper should see

RAW DATA:
${JSON.stringify(trimmedProducts, null, 2)}

CRITICAL RULES:
- NEVER invent a spec value. Every value must be traceable to the raw data above, copied exactly.
- Do not average, estimate, or merge differing values into a new number. If retailers disagree, pick one of their actual stated values for the recommended row, or set recommendedValue to null.
- Use product knowledge ONLY to judge which spec concepts matter for buying decisions — never to invent spec values.
- valuesByRetailer must include an entry for every retailer: ${JSON.stringify(trimmedProducts.map(p => p.retailer))}. Use null where that retailer doesn't have the spec.
- Sort specRows by buyingDecisionImportance (high → medium → low), then by how many retailers report that spec (most → fewest).
- Aim to cover the most useful 15-25 spec concepts. You do not need to include every minor spec from every retailer — prioritize completeness of the important ones over exhaustiveness of every one.

Call the build_spec_matrix tool with your result.`,
        }],
      }),
    })

    let data
    try {
      data = await claudeRes.json()
    } catch (parseErr) {
      console.log('[BM-11] Claude response was not valid JSON. Status:', claudeRes.status, 'Parse error:', parseErr.message)
      return res.status(502).json({
        error: 'Claude API returned an unreadable response',
        detail: `HTTP ${claudeRes.status}: ${parseErr.message}`,
      })
    }

    if (claudeRes.status !== 200) {
      console.log('[BM-12] Claude matrix build error:', JSON.stringify(data))
      return res.status(502).json({
        error: 'Claude API error',
        detail: data.error?.message || JSON.stringify(data).slice(0, 500),
      })
    }

    // [BM-13] Log stop_reason and usage — this is the key diagnostic that
    // was missing before. If stop_reason is "max_tokens", the tool call
    // got cut off mid-generation, which explains an empty/partial result.
    console.log('[BM-14] Claude stop_reason:', data.stop_reason, '| usage:', JSON.stringify(data.usage))

    const toolUseBlock = data.content?.find(b => b.type === 'tool_use' && b.name === 'build_spec_matrix')

    if (!toolUseBlock) {
      console.log('[BM-15] No tool_use block found at all. Full response content types:', JSON.stringify(data.content?.map(b => b.type)))
      console.log('[BM-16] Full response (truncated):', JSON.stringify(data).slice(0, 2000))
      return res.status(422).json({
        error: 'Claude did not return a structured matrix',
        detail: `No tool_use block found. stop_reason was: ${data.stop_reason}`,
      })
    }

    const specRows = toolUseBlock.input?.specRows

    console.log(`[BM-17] Tool input received. specRows present: ${!!specRows}, length: ${specRows?.length ?? 'n/a'}`)

    if (!specRows || !Array.isArray(specRows) || specRows.length === 0) {
      // [BM-18] This is the exact failure that produced "0 of 0 specs shown"
      // last time, now surfaced as a real error instead of silently
      // returning an empty matrix that looks like success.
      console.log('[BM-19] specRows missing or empty. Raw tool input:', JSON.stringify(toolUseBlock.input).slice(0, 1500))
      return res.status(422).json({
        error: 'Claude returned an empty spec matrix',
        detail: `stop_reason: ${data.stop_reason}. This usually means the response was cut off — try again, or reduce the number of products/specs.`,
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
      specRows,
    }

    console.log(`[BM-20] Success: returning ${specRows.length} spec rows for ${products.length} products`)
    return res.status(200).json(result)
  } catch (err) {
    console.log('[BM-21] Matrix build exception:', err.message, err.stack)
    return res.status(502).json({ error: 'Matrix build failed', detail: err.message || 'Unknown error' })
  }
}
