import { useState, useRef } from 'react'
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

function retailerName(url) {
  try {
    const h = new URL(url).hostname.replace('www.', '').split('.')[0]
    return h.charAt(0).toUpperCase() + h.slice(1)
  } catch { return url.slice(0, 20) }
}

// Match a schema spec against a retailer's scraped specs
// Returns { label, value } or null
function matchSpec(spec, liveSpecs) {
  if (!liveSpecs) return null
  const keys = Object.keys(liveSpecs)
  // 1. Exact match on spec label
  if (liveSpecs[spec.label]) return { label: spec.label, value: liveSpecs[spec.label] }
  // 2. Case-insensitive exact
  const lower = spec.label.toLowerCase()
  for (const k of keys) {
    if (k.toLowerCase() === lower) return { label: k, value: liveSpecs[k] }
  }
  // 3. Substring match (spec label contained in retailer label or vice versa)
  for (const k of keys) {
    const kl = k.toLowerCase()
    if (kl.includes(lower) || lower.includes(kl)) {
      return { label: k, value: liveSpecs[k] }
    }
  }
  return null
}

// Find specs that came from retailers but aren't in the schema
function otherSpecs(schema, liveMap) {
  const schemaLabels = new Set()
  for (const g of (schema?.groups || [])) {
    for (const s of g.specs) {
      schemaLabels.add(s.label.toLowerCase())
    }
  }
  const other = {} // label -> { retailer: value }
  for (const [retailer, data] of Object.entries(liveMap)) {
    if (!data?.specs) continue
    for (const [label, value] of Object.entries(data.specs)) {
      const ll = label.toLowerCase()
      // Check if this label is already covered by any schema spec (fuzzy)
      let covered = false
      for (const sl of schemaLabels) {
        if (ll === sl || ll.includes(sl) || sl.includes(ll)) { covered = true; break }
      }
      if (!covered) {
        if (!other[label]) other[label] = {}
        other[label][retailer] = value
      }
    }
  }
  return other
}

function Dot({ s }) {
  const c = { pending: '#d1d5db', loading: '#f59e0b', done: '#10b981', error: '#ef4444' }
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c[s] || '#ddd', flexShrink: 0 }} />
}

function Spin() {
  return <>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid #e5e7eb', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
  </>
}

export default function Home() {
  // Phase 1: schema generation
  const [category, setCategory]     = useState('')
  const [loading, setLoading]       = useState(false)
  const [schema, setSchema]         = useState(null)
  const [schemaError, setSchemaError] = useState('')

  // Phase 2: retailer scraping
  const [urlInputs, setUrlInputs]   = useState(['', ''])
  const [scraping, setScraping]     = useState(false)
  const [liveMap, setLiveMap]       = useState({})  // retailer -> { status, specs, productName, image, error }
  const liveRef = useRef({})

  const [notice, setNotice]         = useState('')
  const [csvCopied, setCsvCopied]   = useState(false)

  // ── Phase 1: Generate schema ───────────────────────────────────────────────
  async function generateSchema(cat) {
    const c = (cat || category).trim()
    if (!c) { setSchemaError('Please enter a product category.'); return }
    setSchemaError('')
    setSchema(null)
    setLiveMap({})
    liveRef.current = {}
    setLoading(true)

    try {
      const r = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: c }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || 'Generation failed')
      setSchema(d)
    } catch (e) {
      setSchemaError(e.message || 'Something went wrong. Try again.')
    }
    setLoading(false)
  }

  // ── Phase 2: Scrape retailer URLs ─────────────────────────────────────────
  function updateLive(retailer, patch) {
    liveRef.current[retailer] = { ...(liveRef.current[retailer] || {}), ...patch }
    setLiveMap({ ...liveRef.current })
  }

  async function scrapeUrls() {
    const urls = urlInputs.map(u => u.trim()).filter(Boolean)
    if (!urls.length) return
    setScraping(true)
    liveRef.current = {}

    urls.forEach(url => {
      const name = retailerName(url)
      updateLive(name, { url, status: 'pending', specs: null, productName: null, image: null, error: null })
    })

    await Promise.all(urls.map(async url => {
      const retailer = retailerName(url)
      updateLive(retailer, { status: 'loading' })
      try {
        const r = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        })
        let d
        try { d = await r.json() } catch { throw new Error(`Server error (HTTP ${r.status})`) }
        if (!r.ok || d.error) throw new Error(d.error || 'Scrape failed')
        updateLive(retailer, {
          status: 'done',
          specs: d.specs,
          productName: d.productName,
          image: d.image,
          specCount: Object.keys(d.specs || {}).length,
        })
      } catch (e) {
        updateLive(retailer, { status: 'error', error: e.message })
      }
    }))

    setScraping(false)
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function copyForExcel() {
    if (!schema) return
    const retailers = Object.keys(liveMap)
    const rows = [['Category', 'Spec', 'Importance', 'Why It Matters', ...retailers]]

    for (const g of schema.groups) {
      for (const s of g.specs) {
        const vals = retailers.map(r => {
          const m = matchSpec(s, liveMap[r]?.specs)
          return m ? m.value : ''
        })
        rows.push([g.name, s.label, s.importance, s.why, ...vals])
      }
    }

    // Other specs section
    const other = otherSpecs(schema, liveMap)
    if (Object.keys(other).length) {
      rows.push([])
      rows.push(['Other Specs (from retailers, not in schema)', '', '', '', ...retailers.map(() => '')])
      for (const [label, byRetailer] of Object.entries(other)) {
        const vals = retailers.map(r => byRetailer[r] || '')
        rows.push(['Other', label, '', '', ...vals])
      }
    }

    const tsv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join('\t')).join('\n')
    navigator.clipboard.writeText(tsv).then(() => { setCsvCopied(true); setTimeout(() => setCsvCopied(false), 1500) })
  }

  function flash(msg) { setNotice(msg); setTimeout(() => setNotice(''), 1500) }

  // ── Derived data ──────────────────────────────────────────────────────────
  const retailers = Object.keys(liveMap)
  const hasLiveData = retailers.some(r => liveMap[r]?.status === 'done')
  const other = hasLiveData ? otherSpecs(schema, liveMap) : {}
  const liveList = Object.entries(liveMap)
  const allDone = liveList.length > 0 && liveList.every(([, d]) => d.status === 'done' || d.status === 'error')
  const totalSpecs = schema?.groups?.reduce((n, g) => n + g.specs.length, 0) ?? 0

  return (
    <>
      <Head>
        <title>Spec Schema Builder</title>
      </Head>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '2.5rem 1rem' }}>
        <style>{`* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: system-ui, -apple-system, sans-serif; background: #f7f8fa; color: #111; } input, button { font-family: inherit; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>

        {/* Header */}
        <div style={{ marginBottom: '2rem' }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>Spec Schema Builder</h1>
          <p style={{ fontSize: 14, color: '#6b7280' }}>
            Generate a buying-decision spec schema → validate with live retailer data
          </p>
        </div>

        {/* ── PHASE 1: Category input ── */}
        <div style={CARD}>
          <label style={LBL}>Product category</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input
              type="text"
              value={category}
              onChange={e => { setCategory(e.target.value); setSchemaError('') }}
              onKeyDown={e => e.key === 'Enter' && generateSchema()}
              placeholder="e.g. coffee maker, dishwasher, skis…"
              style={{ ...INP, flex: 1 }}
              disabled={loading}
            />
            <button
              onClick={() => generateSchema()}
              disabled={loading}
              style={{ ...BTN, background: loading ? '#93c5fd' : '#1d4ed8', cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}
            >
              {loading && <Spin />}
              {loading ? 'Generating…' : 'Generate →'}
            </button>
          </div>

          {/* Quick picks */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {QUICK_PICKS.map(c => (
              <button key={c} disabled={loading}
                onClick={() => { setCategory(c); setSchema(null); setSchemaError(''); generateSchema(c) }}
                style={{ padding: '4px 11px', background: category === c ? '#eff6ff' : '#f9fafb', border: `1px solid ${category === c ? '#bfdbfe' : '#e5e7eb'}`, borderRadius: 20, fontSize: 12, color: category === c ? '#1d4ed8' : '#6b7280', cursor: loading ? 'not-allowed' : 'pointer' }}>
                {c}
              </button>
            ))}
          </div>

          {schemaError && <p style={{ fontSize: 13, color: '#ef4444', marginTop: 10 }}>{schemaError}</p>}
        </div>

        {/* ── PHASE 2: Retailer URLs (shown after schema is ready) ── */}
        {schema && (
          <div style={CARD}>
            <label style={LBL}>Retailer product URLs — paste one per retailer to validate against live data (optional)</label>
            <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 10 }}>
              Zyte will fetch each page and extract specs. Works well for Wayfair, Target, AJ Madison, Williams Sonoma, Lowe's. Amazon and Best Buy are often blocked.
            </p>
            {urlInputs.map((v, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input type="url" value={v}
                  onChange={e => setUrlInputs(p => p.map((x, j) => j === i ? e.target.value : x))}
                  placeholder="https://…"
                  style={{ ...INP, flex: 1 }} />
                {urlInputs.length > 1 && (
                  <button onClick={() => setUrlInputs(p => p.filter((_, j) => j !== i))} style={GHOST}>✕</button>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={() => setUrlInputs(p => [...p, ''])} style={GHOST}>+ Add retailer</button>
              <button
                onClick={scrapeUrls}
                disabled={scraping || !urlInputs.some(u => u.trim())}
                style={{ ...BTN, background: scraping ? '#93c5fd' : '#1d4ed8', cursor: scraping ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              >
                {scraping && <Spin />}
                {scraping ? 'Fetching…' : 'Fetch live specs →'}
              </button>
            </div>

            {/* Scraping status */}
            {liveList.length > 0 && (
              <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                {liveList.map(([retailer, d]) => (
                  <div key={retailer} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderBottom: '1px solid #f3f4f6' }}>
                    <Dot s={d.status} />
                    <span style={{ minWidth: 100, fontSize: 13, fontWeight: 500 }}>{retailer}</span>
                    <span style={{ fontSize: 12, color: d.status === 'done' ? '#10b981' : d.status === 'error' ? '#ef4444' : '#9ca3af' }}>
                      {d.status === 'pending' && 'Waiting…'}
                      {d.status === 'loading' && 'Fetching & extracting… (up to 2 min)'}
                      {d.status === 'done' && `✓ ${d.specCount} specs — ${d.productName}`}
                      {d.status === 'error' && (d.error || 'Failed')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── RESULTS ── */}
        {schema && (
          <div>
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 600 }}>{schema.category}</h2>
                <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                  {totalSpecs} specs · {schema.groups.length} groups
                  {hasLiveData && ` · Live data from ${retailers.filter(r => liveMap[r]?.status === 'done').length} retailer${retailers.length > 1 ? 's' : ''}`}
                </p>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {notice && <span style={{ fontSize: 12, color: '#10b981', fontWeight: 500 }}>{notice}</span>}
                <button onClick={copyForExcel} style={GHOST}>{csvCopied ? 'Copied!' : 'Copy for Excel'}</button>
              </div>
            </div>

            {/* Header cards for retailers (if we have live data) */}
            {hasLiveData && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {retailers.filter(r => liveMap[r]?.status === 'done').map(r => {
                  const d = liveMap[r]
                  return (
                    <a key={r} href={d.url} target="_blank" rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, textDecoration: 'none', fontSize: 12 }}>
                      {d.image && <img src={d.image} alt="" style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff' }} />}
                      <div>
                        <div style={{ fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', fontSize: 10, letterSpacing: .4 }}>{r}</div>
                        <div style={{ color: '#6b7280', maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.productName}</div>
                      </div>
                    </a>
                  )
                })}
              </div>
            )}

            {/* ── Main spec table ── */}
            {schema.groups.map((group, gi) => (
              <div key={gi} style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', marginBottom: 12, overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>

                {/* Group header */}
                <div style={{ padding: '10px 18px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: .6 }}>{group.name}</span>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{group.specs.length} specs</span>
                </div>

                {/* Spec rows */}
                {group.specs.map((spec, si) => {
                  const matches = retailers.map(r => matchSpec(spec, liveMap[r]?.specs))
                  return (
                    <div key={si} style={{ display: 'flex', alignItems: 'flex-start', borderBottom: si < group.specs.length - 1 ? '1px solid #f3f4f6' : 'none', background: IMP_BG[spec.importance] || '#fff' }}>

                      {/* Importance dot */}
                      <div style={{ padding: '14px 0 14px 18px', flexShrink: 0 }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: IMP_COLOR[spec.importance] || '#9ca3af', marginTop: 3 }} />
                      </div>

                      {/* Schema spec info */}
                      <div style={{ flex: '0 0 280px', padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#111' }}>{spec.label}</span>
                          <span style={{ fontSize: 9.5, fontWeight: 700, color: IMP_COLOR[spec.importance], textTransform: 'uppercase', letterSpacing: .3 }}>{spec.importance}</span>
                        </div>
                        <p style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>{spec.why}</p>
                      </div>

                      {/* Retailer live values */}
                      {retailers.map((r, ri) => {
                        const m = matches[ri]
                        const d = liveMap[r]
                        return (
                          <div key={r} style={{ flex: 1, padding: '12px 14px', borderLeft: '1px solid #f3f4f6', minWidth: 140 }}>
                            {/* Retailer name header (only show on first row) */}
                            {si === 0 && gi === 0 && (
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: .4, marginBottom: 4 }}>{r}</div>
                            )}
                            {m ? (
                              <>
                                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>{m.label}</div>
                                <div style={{ fontSize: 13, color: '#111', fontWeight: 500 }}>{m.value}</div>
                              </>
                            ) : d?.status === 'done' ? (
                              <span style={{ fontSize: 12, color: '#d1d5db' }}>—</span>
                            ) : d?.status === 'loading' ? (
                              <span style={{ fontSize: 11, color: '#f59e0b' }}>…</span>
                            ) : (
                              <span style={{ fontSize: 12, color: '#e5e7eb' }}>—</span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            ))}

            {/* ── Other specs section ── */}
            {Object.keys(other).length > 0 && (
              <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
                <div style={{ padding: '10px 18px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: .6 }}>Other specs from retailers</span>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{Object.keys(other).length} specs not in schema</span>
                </div>

                {Object.entries(other).map(([label, byRetailer], i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', borderBottom: i < Object.keys(other).length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                    <div style={{ padding: '14px 0 14px 26px', flexShrink: 0 }}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#d1d5db', marginTop: 3 }} />
                    </div>
                    <div style={{ flex: '0 0 280px', padding: '12px 16px' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 500, color: '#374151' }}>{label}</span>
                      <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>From retailer — not in schema</p>
                    </div>
                    {retailers.map(r => (
                      <div key={r} style={{ flex: 1, padding: '12px 14px', borderLeft: '1px solid #f3f4f6', minWidth: 140 }}>
                        {byRetailer[r] ? (
                          <div style={{ fontSize: 13, color: '#374151' }}>{byRetailer[r]}</div>
                        ) : (
                          <span style={{ fontSize: 12, color: '#e5e7eb' }}>—</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Legend */}
            <div style={{ display: 'flex', gap: 20, padding: '10px 16px', background: '#fff', borderRadius: 8, border: '1px solid #e5e7eb', marginTop: 12, flexWrap: 'wrap' }}>
              {['high', 'medium', 'low'].map(imp => (
                <div key={imp} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: IMP_COLOR[imp], display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    <strong style={{ color: IMP_COLOR[imp] }}>{imp.charAt(0).toUpperCase() + imp.slice(1)}</strong>
                    {' — '}{imp === 'high' ? 'first thing shoppers check' : imp === 'medium' ? 'important secondary spec' : 'nice to know'}
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

const CARD = { background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', padding: '1.5rem', marginBottom: '1.25rem', boxShadow: '0 1px 3px rgba(0,0,0,.05)' }
const LBL  = { fontSize: 13, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 8 }
const INP  = { padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13.5, color: '#111', outline: 'none', width: '100%' }
const BTN  = { padding: '10px 20px', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13.5, fontWeight: 600 }
const GHOST = { padding: '7px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12.5, color: '#374151', cursor: 'pointer' }
