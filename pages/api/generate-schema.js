// pages/api/generate-schema.js
// Generates a comprehensive spec schema from Claude's knowledge.
// This never fails — it's Claude's training data, not live scraping.

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category, retailers } = req.body
  if (!category) return res.status(400).json({ error: 'Missing category' })

  const KEY = process.env.ANTHROPIC_API_KEY
  if (!KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        tools: [{
          name: 'schema',
          description: 'Return a comprehensive spec schema for a product category',
          input_schema: {
            type: 'object',
            properties: {
              specGroups: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    group: { type: 'string' },
                    specs: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          concept: { type: 'string' },
                          recommendedLabel: { type: 'string' },
                          importance: { type: 'string', enum: ['high', 'medium', 'low'] },
                          retailerLabels: {
                            type: 'object',
                            additionalProperties: { type: 'string' },
                          },
                        },
                        required: ['concept', 'recommendedLabel', 'importance', 'retailerLabels'],
                      },
                    },
                  },
                  required: ['group', 'specs'],
                },
              },
            },
            required: ['specGroups'],
          },
        }],
        tool_choice: { type: 'tool', name: 'schema' },
        messages: [{
          role: 'user',
          content: `Generate a comprehensive spec schema for "${category}".

Retailers: ${(retailers || []).join(', ')}

For each spec:
- concept: the universal name (e.g. "Cup capacity")
- recommendedLabel: the best database label
- importance: high (shoppers check first), medium (useful), low (minor detail)
- retailerLabels: what each retailer calls this spec on their product pages

Groups: use logical categories like "Capacity & Brewing", "Dimensions & Weight", "Power & Electrical", "Materials & Design", "Included Accessories", "Warranty & Certifications", "Features"

Include 25-40 total specs. Be thorough.`,
        }],
      }),
    })

    const d = await r.json()
    if (r.status !== 200) {
      console.log('Schema generation error:', JSON.stringify(d).slice(0, 300))
      return res.status(502).json({ error: 'Claude API error', detail: d.error?.message })
    }

    const block = d.content?.find(b => b.type === 'tool_use')
    if (!block?.input?.specGroups?.length) {
      return res.status(422).json({ error: 'Empty schema returned' })
    }

    return res.status(200).json({ specGroups: block.input.specGroups })
  } catch (e) {
    return res.status(502).json({ error: 'Schema generation failed', detail: e.message })
  }
}
