import { useState } from 'react'
import Head from 'next/head'

const QUICK_PICKS = [
  'Coffee Maker', 'Espresso Machine', 'Dishwasher', 'Refrigerator',
  'Washing Machine', 'Air Fryer', 'Blender', 'Microwave',
  'Skis', 'Snowboard', 'Golf Clubs', 'Running Shoes', 'Bicycle',
  'Television', 'Laptop', 'Headphones', 'Camera',
  'Sofa', 'Mattress', 'Office Chair',
]

const IMP_COLOR = { high: '#dc2626', medium: '#d97706', low: '#9ca3af' }
const IMP_BG    = { high: '#fef2f2', medium: '#fffbeb', low: '#ffffff' }
const IMP_DESC  = {
  high: 'First thing shoppers check',
  medium: 'Important secondary spec',
  low: 'Nice to know',
}

export default function Home() {
  const [category, setCategory] = useState('')
  const [loading, setLoading]   = useState(false)
  const [schema, setSchema]     = useState(null)
  const [error, setError]       = useState('')
  const [notice, setNotice]     = useState('')

  async function generate(cat) {
    const c = (cat || category).trim()
    if (!c) { setError('Please enter a product category.'); return }
    setError('')
    setSchema(null)
    setLoading(true)

    try {
      const r = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: c }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || 'Failed')
      setSchema(d)
    } catch (e) {
      setError(e.message || 'Something went wrong. Try again.')
    }
    setLoading(false)
  }

  function flash(msg) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 1500)
  }

  function copyJSON() {
    if (!schema) return
    navigator.clipboard.writeText(JSON.stringify(schema, null, 2)).then(() => flash('JSON copied!'))
  }

  function copyCSV() {
    if (!schema) return
    const rows = [['Group', 'Spec', 'Importance', 'Why It Matters']]
    for (const g of schema.groups) {
      for (const s of g.specs) {
        rows.push([g.name, s.label, s.importance, s.why])
      }
    }
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    navigator.clipboard.writeText(csv).then(() => flash('CSV copied!'))
  }

  const totalSpecs = schema?.groups?.reduce((n, g) => n + g.specs.length, 0) ?? 0

  return (
    <>
      <Head>
        <title>Spec Schema Builder</title>
        <meta name="description" content="Generate buying-decision spec schemas for any product category" />
      </Head>

      <div style={{ maxWidth: 780, margin: '0 auto', padding: '2.5rem 1rem' }}>

        {/* Header */}
        <div style={{ marginBottom: '2rem' }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111', marginBottom: 6 }}>
            Spec Schema Builder
          </h1>
          <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.5 }}>
            Enter a product category to get the specs consumers care about most — grouped, prioritized, and ready for your database.
          </p>
        </div>

        {/* Input card */}
        <div style={card}>
          <label style={lbl}>Product category</label>

          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input
              type="text"
              value={category}
              onChange={e => { setCategory(e.target.value); setError('') }}
              onKeyDown={e => e.key === 'Enter' && generate()}
              placeholder="e.g. coffee maker, dishwasher, skis…"
              style={inp}
              disabled={loading}
            />
            <button
              onClick={() => generate()}
              disabled={loading}
              style={{
                padding: '10px 22px',
                background: loading ? '#93c5fd' : '#1d4ed8',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {loading && (
                <span style={{
                  width: 14, height: 14,
                  border: '2px solid rgba(255,255,255,.35)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'spin .7s linear infinite',
                  display: 'inline-block',
                }} />
              )}
              {loading ? 'Generating…' : 'Generate →'}
            </button>
          </div>

          {/* Quick picks */}
          <div>
            <span style={{ fontSize: 12, color: '#9ca3af', marginRight: 8 }}>Quick picks:</span>
            <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {QUICK_PICKS.map(c => (
                <button
                  key={c}
                  onClick={() => { setCategory(c); setSchema(null); setError(''); generate(c) }}
                  disabled={loading}
                  style={{
                    padding: '4px 11px',
                    background: category === c ? '#eff6ff' : '#f9fafb',
                    border: `1px solid ${category === c ? '#bfdbfe' : '#e5e7eb'}`,
                    borderRadius: 20,
                    fontSize: 12,
                    color: category === c ? '#1d4ed8' : '#6b7280',
                    cursor: loading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <p style={{ fontSize: 13, color: '#ef4444', marginTop: 12 }}>{error}</p>
          )}
        </div>

        {/* Results */}
        {schema && (
          <div>
            {/* Results toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: '#111' }}>{schema.category}</h2>
                <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                  {totalSpecs} specs · {schema.groups.length} groups
                </p>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {notice && <span style={{ fontSize: 12, color: '#10b981', fontWeight: 500 }}>{notice}</span>}
                <button onClick={copyCSV}  style={ghostBtn}>Copy CSV</button>
                <button onClick={copyJSON} style={ghostBtn}>Copy JSON</button>
              </div>
            </div>

            {/* Spec groups */}
            {schema.groups.map((group, gi) => (
              <div key={gi} style={{ ...card, padding: 0, marginBottom: 12, overflow: 'hidden' }}>

                {/* Group header */}
                <div style={{
                  padding: '10px 18px',
                  background: '#f8fafc',
                  borderBottom: '1px solid #e5e7eb',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: .6 }}>
                    {group.name}
                  </span>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{group.specs.length} specs</span>
                </div>

                {/* Spec rows */}
                {group.specs.map((spec, si) => (
                  <div
                    key={si}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 14,
                      padding: '12px 18px',
                      borderBottom: si < group.specs.length - 1 ? '1px solid #f3f4f6' : 'none',
                      background: IMP_BG[spec.importance] || '#fff',
                    }}
                  >
                    {/* Importance dot */}
                    <div style={{ paddingTop: 4, flexShrink: 0 }}>
                      <span style={{
                        display: 'inline-block',
                        width: 8, height: 8,
                        borderRadius: '50%',
                        background: IMP_COLOR[spec.importance] || '#9ca3af',
                      }} />
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{spec.label}</span>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: IMP_COLOR[spec.importance],
                          textTransform: 'uppercase',
                          letterSpacing: .4,
                        }}>
                          {spec.importance}
                        </span>
                      </div>
                      <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>{spec.why}</p>
                    </div>
                  </div>
                ))}
              </div>
            ))}

            {/* Legend */}
            <div style={{ display: 'flex', gap: 20, padding: '10px 16px', background: '#fff', borderRadius: 8, border: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
              {['high', 'medium', 'low'].map(imp => (
                <div key={imp} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: IMP_COLOR[imp], display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    <strong style={{ color: IMP_COLOR[imp] }}>{imp.charAt(0).toUpperCase() + imp.slice(1)}</strong>
                    {' — '}{IMP_DESC[imp]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </>
  )
}

const card = {
  background: '#fff',
  borderRadius: 10,
  border: '1px solid #e5e7eb',
  padding: '1.5rem',
  marginBottom: '1.5rem',
  boxShadow: '0 1px 3px rgba(0,0,0,.05)',
}

const lbl = {
  fontSize: 13, fontWeight: 500, color: '#374151',
  display: 'block', marginBottom: 8,
}

const inp = {
  flex: 1, padding: '10px 12px',
  border: '1px solid #d1d5db', borderRadius: 8,
  fontSize: 14, color: '#111', outline: 'none',
  width: '100%',
}

const ghostBtn = {
  padding: '7px 14px',
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 7,
  fontSize: 12.5,
  color: '#374151',
  cursor: 'pointer',
}
