// pages/api/generate-schema.js
// Generates a comprehensive spec schema from Claude's knowledge.
// Uses tool_use for structured output, with a text fallback.

export const config = { maxDuration: 120 }

const TOOL = {
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
                  concept:          { type: 'string' },
                  recommendedLabel: { type: 'string' },
                  importance:       { type: 'string', enum: ['high','medium','low'] },
                  retailerLabels:   { type: 'object', additionalProperties: { type: 'string' } },
                },
                required: ['concept','recommendedLabel','importance','retailerLabels'],
              },
            },
          },
          required: ['group','specs'],
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

  const prompt = `Generate a comprehensive spec schema for the product category: "${category}"

Retailers to compare: ${(retailers||[]).join(', ')}

For each spec include:
- concept: universal spec name (e.g. "Cup capacity")
- recommendedLabel: best label for the database
- importance: "high" (first thing shoppers check), "medium" (useful), "low" (minor detail)
- retailerLabels: what each retailer calls this spec on their product pages

Organize into groups: "Capacity & Brewing", "Dimensions & Weight", "Power & Electrical", "Materials & Design", "Included Accessories", "Warranty & Certifications", "Features" (adapt for this category)

Include 20-25 total specs — the most important ones only. Quality over quantity.`

  try {
    // Attempt 1: tool_use for clean structured output
    const r1 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        tools: [TOOL],
        tool_choice: { type:'tool', name:'schema' },
        messages: [{ role:'user', content: prompt }],
      }),
    })

    const d1 = await r1.json()
    console.log('Schema attempt 1 — status:', r1.status, 'stop_reason:', d1.stop_reason, 'types:', d1.content?.map(b=>b.type))

    if (r1.status === 200) {
      const block = d1.content?.find(b => b.type === 'tool_use' && b.name === 'schema')
      if (block?.input?.specGroups?.length) {
        console.log('Schema: tool_use success,', block.input.specGroups.reduce((n,g)=>n+g.specs.length,0), 'specs')
        return res.status(200).json({ specGroups: block.input.specGroups })
      }
      console.log('Schema: tool_use returned no specGroups, trying text fallback')
    } else {
      console.log('Schema attempt 1 error:', JSON.stringify(d1).slice(0,400))
    }

    // Attempt 2: plain text with JSON instruction (fallback)
    const r2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: prompt + `\n\nReturn ONLY a JSON object with this structure, no other text:\n{"specGroups":[{"group":"group name","specs":[{"concept":"...","recommendedLabel":"...","importance":"high|medium|low","retailerLabels":{"RetailerName":"label"}}]}]}`,
        }],
      }),
    })

    const d2 = await r2.json()
    console.log('Schema attempt 2 — status:', r2.status)

    if (r2.status === 200) {
      const text = d2.content?.find(b=>b.type==='text')?.text || ''
      const clean = text.replace(/```json|```/g,'').trim()
      const match = clean.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (parsed.specGroups?.length) {
          console.log('Schema: text fallback success,', parsed.specGroups.reduce((n,g)=>n+g.specs.length,0), 'specs')
          return res.status(200).json({ specGroups: parsed.specGroups })
        }
      }
    }

    console.log('Schema: both attempts failed')
    return res.status(422).json({ error: 'Could not generate schema — both attempts failed' })

  } catch (e) {
    console.log('Schema exception:', e.message)
    return res.status(502).json({ error: 'Schema generation failed', detail: e.message })
  }
}
