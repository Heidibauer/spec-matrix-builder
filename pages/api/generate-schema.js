// pages/api/generate-schema.js
// Step 1: Claude generates a comprehensive spec schema from knowledge.
// This is instant, never fails, and gives us a complete starting point
// even before any live retailer data comes in.

export const config = { maxDuration: 60 }

const TOOL = {
  name: 'generate_spec_schema',
  description: 'Generate a comprehensive spec schema for a product category',
  input_schema: {
    type: 'object',
    properties: {
      specGroups: {
        type: 'array',
        description: 'Specs organized into logical groups',
        items: {
          type: 'object',
          properties: {
            group: { type: 'string', description: 'Group name e.g. "Capacity & Brewing", "Dimensions & Weight"' },
            specs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  concept: { type: 'string', description: 'The spec concept e.g. "Cup capacity"' },
                  recommendedLabel: { type: 'string', description: 'Best label to use in the database' },
                  importance: { type: 'string', enum: ['high', 'medium', 'low'] },
                  knownRetailerLabels: {
                    type: 'object',
                    description: 'What each retailer typically calls this spec',
                    additionalProperties: { type: 'string' },
                  },
                },
                required: ['concept', 'recommendedLabel', 'importance', 'knownRetailerLabels'],
              },
            },
          },
          required: ['group', 'specs'],
        },
      },
    },
    required: ['specGroups'],
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category, retailers } = req.body
  if (!category) return res.status(400).json({ error: 'Missing category' })

  const KEY = process.env.ANTHROPIC_API_KEY
  if (!KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'generate_spec_schema' },
      messages: [{
        role: 'user',
        content: `You are a product data specialist for an e-commerce comparison site.

Generate a comprehensive spec schema for the category: "${category}"

Retailers we are comparing: ${(retailers || []).join(', ')}

For each spec:
- Include every spec a consumer would care about when buying a ${category}
- Group specs logically (e.g. "Capacity & Brewing", "Dimensions & Weight", "Power & Electrical", "Materials & Design", "Included Accessories", "Warranty & Certifications")
- For knownRetailerLabels, include what each of these retailers typically labels this spec on their product pages: ${(retailers || []).join(', ')}
- importance: "high" = spec shoppers check first (size, capacity, key features), "medium" = useful secondary specs, "low" = minor details
- Aim for 25-40 total specs across all groups — be thorough

This will be used as the reference schema to verify against live scraped data from those retailers.`,
      }],
    }),
  })

  const data = await claudeRes.json()

  if (claudeRes.status !== 200) {
    return res.status(502).json({ error: 'Claude API error', detail: data.error?.message })
  }

  const block = data.content?.find(b => b.type === 'tool_use')
  if (!block?.input?.specGroups?.length) {
    return res.status(422).json({ error: 'Claude returned empty schema' })
  }

  return res.status(200).json({ specGroups: block.input.specGroups })
}
