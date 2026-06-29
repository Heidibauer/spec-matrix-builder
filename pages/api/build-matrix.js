// pages/api/build-matrix.js

export const config = {
  maxDuration: 60,
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category, retailerData } = req.body
  if (!category || !retailerData) return res.status(400).json({ error: 'Missing category or retailerData' })

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  const retailers = Object.keys(retailerData)

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
          content: `You are building a product spec database schema for "${category}".

Here are the raw specs extracted from ${retailers.length} retailer product pages, with the exact labels and values as they appear on each site:

${JSON.stringify(retailerData, null, 2)}

Match equivalent specs across retailers into rows, even when labels differ (e.g. "Brew Capacity (cups)" and "Number of Cups" are the same spec).

Return ONLY a JSON object in this exact structure, no other text, no code fences:
{
  "category": "${category}",
  "retailers": ${JSON.stringify(retailers)},
  "rows": [
    {
      "concept": "what this spec measures (short, e.g. Cup capacity)",
      "retailerSpecs": {
        "RetailerName": { "label": "exact label from that page", "value": "exact value from that page" }
      },
      "recommended": {
        "label": "the best clearest label from the actual retailer labels",
        "value": "the most complete or precise value across all retailers, or null if values meaningfully differ"
      },
      "include": true
    }
  ]
}

Rules:
- retailerSpecs: for EVERY retailer in ${JSON.stringify(retailers)}, include the entry if present, or set to null if that retailer does not have this spec
- recommended.label: pick the clearest label from the actual retailer labels — do not invent new labels
- recommended.value: pick the most informative value if they agree or are close equivalents; set to null if they meaningfully differ
- include: true for useful purchase-decision specs; false for model numbers, SKUs, color variant names, marketing copy, warranty fine print
- Sort rows: include=true first (most retailers → fewest); include=false at bottom
- Return ONLY valid JSON, nothing else`,
        }],
      }),
    })

    const data = await claudeRes.json()

    if (claudeRes.status !== 200) {
      return res.status(502).json({
        error: 'Claude API error',
        detail: data.error?.message || JSON.stringify(data),
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
