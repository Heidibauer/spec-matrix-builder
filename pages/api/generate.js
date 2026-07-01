// pages/api/generate.js
// Calls Claude to generate a buying-decision spec schema for a product category.

export const config = { maxDuration: 120 }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { category } = req.body
  if (!category?.trim()) return res.status(400).json({ error: 'Missing category' })

  const KEY = process.env.ANTHROPIC_API_KEY
  if (!KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY — add it to Vercel environment variables' })

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
        messages: [{
          role: 'user',
          content: `You are a product data specialist for a consumer comparison website.

For the product category "${category.trim()}", identify the most important specs that consumers need when making a buying decision.

Return ONLY a valid JSON object with this exact structure, no other text:
{
  "category": "${category.trim()}",
  "groups": [
    {
      "name": "Group Name",
      "specs": [
        {
          "label": "Spec Name",
          "importance": "high",
          "why": "One sentence on why this matters to a buyer"
        }
      ]
    }
  ]
}

Rules:
- Groups: use logical categories for this specific product type (e.g. "Capacity & Brewing", "Dimensions & Weight", "Power", "Materials & Build", "Included Accessories", "Warranty" — adapt to what makes sense for ${category.trim()})
- importance: "high" = first thing shoppers check, "medium" = important secondary spec, "low" = nice to know
- Include 15-25 specs total across all groups
- Focus only on specs that genuinely help someone decide whether to buy this product
- If dimensions are relevant, list Height, Width, and Depth as three separate specs (do not combine them into one "Dimensions" spec)
- Do NOT include: price, brand, model number, color options, SKU, or marketing copy
- Return ONLY the JSON object, nothing else`,
        }],
      }),
    })

    const data = await r.json()

    if (r.status !== 200) {
      console.log('Claude error:', r.status, JSON.stringify(data).slice(0, 300))
      return res.status(502).json({ error: 'Claude API error', detail: data.error?.message })
    }

    const text = data.content?.find(b => b.type === 'text')?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    const match = clean.match(/\{[\s\S]*\}/)

    if (!match) {
      console.log('No JSON in response:', text.slice(0, 300))
      return res.status(422).json({ error: 'No JSON returned from Claude' })
    }

    const parsed = JSON.parse(match[0])

    if (!parsed.groups?.length) {
      return res.status(422).json({ error: 'Empty schema returned' })
    }

    return res.status(200).json(parsed)

  } catch (e) {
    console.log('Generate error:', e.message)
    return res.status(502).json({ error: 'Failed to generate schema', detail: e.message })
  }
}
