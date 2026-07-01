import { useState, useRef } from 'react'
import Head from 'next/head'

function retailerName(url) {
  try {
    const h = new URL(url).hostname.replace('www.', '').split('.')[0]
    return h.charAt(0).toUpperCase() + h.slice(1)
  } catch { return url.slice(0, 20) }
}

function Dot({ s }) {
  const c = { pending: '#d1d5db', loading: '#f59e0b', done: '#10b981', error: '#ef4444', skipped: '#9ca3af' }
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c[s] || '#ddd', flexShrink: 0 }} />
}

function Spinner() {
  return <>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    <span style={{ display: 'inline-block', width: 15, height: 15, border: '2px solid #e5e7eb', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
  </>
}

const importanceColors = { high: '#dc2626', medium: '#d97706', low: '#9ca3af' }

function toCSV(specGroups, liveData, retailers) {
  const rows = [['Group', 'Spec', 'Recommended Label', 'Importance', ...retailers.map(r => r + ' (live)'), ...retailers.map(r => r + ' (expected label)')]]
  for (const g of specGroups) {
    for (const s of g.specs) {
      const liveVals = retailers.map(r => liveData[r]?.specs?.[s.concept] || liveData[r]?.specs?.[s.knownRetailerLabels?.[r]] || '—')
      const expectedLabels = retailers.map(r => s.knownRetailerLabels?.[r] || '—')
      rows.push([g.group, s.concept, s.recommendedLabel, s.importance, ...liveVals, ...expectedLabels])
    }
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
}

export default function App() {
  const [step, setStep] = useState(1)
  const [category, setCategory] = useState('')
  const [urlInputs, setUrlInputs] = useState(['', '', ''])
  const [err, setErr] = useState('')
  const [phase, setPhase] = useState('') // 'schema' | 'scraping' | 'done'
  const [schemaData, setSchemaData] = useState(null)
  const [liveData, setLiveData] = useState({}) // retailer -> { specs, productName, image, status, error }
  const [csvCopied, setCsvCopied] = useState(false)
  const [jsonCopied, setJsonCopied] = useState(false)
  const liveRef = useRef({})

  function addUrl() { setUrlInputs(p => [...p, '']) }
  function delUrl(i) { setUrlInputs(p => p.filter((_, j) => j !== i)) }
  function setUrl(i, v) { setUrlInputs(p => p.map((x, j) => j === i ? v : x)) }

  function updateLive(retailer, patch) {
    liveRef.current[retailer] = { ...(liveRef.current[retailer] || {}), ...patch }
    setLiveData({ ...liveRef.current })
  }

  async function run() {
    const urls = urlInputs.map(u => u.trim()).filter(Boolean)
    if (!category.trim()) { setErr('Enter a product category.'); return }
    if (urls.length < 1) { setErr('Add at least 1 URL.'); return }
    setErr('')

    const retailers = urls.map(retailerName)
    urls.forEach((url, i) => {
      updateLive(retailers[i], { url, status: 'pending', specs: null, productName: null, image: null, error: null })
    })

    setStep(2)
    setPhase('schema')

    // PHASE 1: Generate schema from Claude knowledge — instant, never fails
    let schema = null
    try {
      const r = await fetch('/api/generate-schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, retailers }),
      })
      const d = await r.json()
      if (r.ok && d.specGroups) {
        schema = d
        setSchemaData(d)
      }
    } catch {}

    // PHASE 2: Scrape live data from each retailer URL concurrently
    setPhase('scraping')

    await Promise.all(urls.map(async (url, i) => {
      const retailer = retailers[i]
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
        updateLive(retailer, { status: 'done', specs: d.specs, productName: d.productName, image: d.image, specCount: Object.keys(d.specs).length })
      } catch (e) {
        updateLive(retailer, { status: 'error', error: e.message })
      }
    }))

    setPhase('done')
    setStep(3)
  }

  function reset() {
    setStep(1); setCategory(''); setUrlInputs(['', '', ''])
    setSchemaData(null); liveRef.current = {}; setLiveData({})
    setErr(''); setPhase('')
  }

  const retailers = urlInputs.map(u => u.trim()).filter(Boolean).map(retailerName)

  // Match live specs to schema concepts
  function getLiveValue(retailer, spec) {
    const live = liveData[retailer]
    if (!live?.specs) return null
    // Try exact match on concept name
    if (live.specs[spec.concept]) return { label: spec.concept, value: live.specs[spec.concept] }
    // Try known retailer label
    const knownLabel = spec.knownRetailerLabels?.[retailer]
    if (knownLabel && live.specs[knownLabel]) return { label: knownLabel, value: live.specs[knownLabel] }
    // Try fuzzy match (lowercase, partial)
    const conceptLower = spec.concept.toLowerCase()
    for (const [k, v] of Object.entries(live.specs)) {
      if (k.toLowerCase().includes(conceptLower) || conceptLower.includes(k.toLowerCase())) {
        return { label: k, value: v }
      }
    }
    return null
  }

  function getDevJSON() {
    if (!schemaData) return ''
    return JSON.stringify({
      category,
      specFields: schemaData.specGroups.flatMap(g =>
        g.specs.map(s => ({
          key: s.recommendedLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          label: s.recommendedLabel,
          group: g.group,
          importance: s.importance,
        }))
      ),
    }, null, 2)
  }

  function copyCSV() {
    if (!schemaData) return
    navigator.clipboard.writeText(toCSV(schemaData.specGroups, liveData, retailers))
      .then(() => { setCsvCopied(true); setTimeout(() => setCsvCopied(false), 1500) })
  }

  function copyJSON() {
    navigator.clipboard.writeText(getDevJSON())
      .then(() => { setJsonCopied(true); setTimeout(() => setJsonCopied(false), 1500) })
  }

  function downloadCSV() {
    if (!schemaData) return
    const blob = new Blob([toCSV(schemaData.specGroups, liveData, retailers)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `${category.replace(/\s+/g, '_')}_specs.csv`; a.click()
  }

  const liveList = Object.entries(liveData)
  const allScraped = liveList.length > 0 && liveList.every(([, v]) => v.status === 'done' || v.status === 'error')

  return (
    <>
      <Head><title>Spec Matrix Builder</title></Head>
      <style>{`* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: system-ui, -apple-system, sans-serif; background: #f7f8fa; } input, button { font-family: inherit; }`}</style>
      <div style={{ minHeight: '100vh', padding: '2rem 1rem' }}>
        <div style={{ maxWidth: 1300, margin: '0 auto' }}>

          <div style={{ marginBottom: '1.5rem' }}>
            <h1 style={{ fontSize: 21, fontWeight: 700, color: '#111' }}>Spec Matrix Builder</h1>
            <p style={{ fontSize: 13, color: '#6b7280', marginTop: 3 }}>Claude generates the spec schema → live retailer data verifies it automatically</p>
          </div>

          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '1.75rem', boxShadow: '0 1px 3px rgba(0,0,0,.05)' }}>

            {/* STEP 1 */}
            {step === 1 && (
              <div>
                <label style={lbl}>Product category</label>
                <input value={category} onChange={e => setCategory(e.target.value)} onKeyDown={e => e.key === 'Enter' && run()}
                  placeholder="e.g. coffee maker, dishwasher, skis…"
                  style={{ ...inp, width: '100%', marginBottom: 20 }} />

                <label style={lbl}>Retailer URLs — one per retailer (same or similar product)</label>
                {urlInputs.map((v, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input type="url" value={v} onChange={e => setUrl(i, e.target.value)} placeholder="https://…" style={{ ...inp, flex: 1 }} />
                    {urlInputs.length > 1 && <button onClick={() => delUrl(i)} style={ghost}>✕</button>}
                  </div>
                ))}
                <button onClick={addUrl} style={{ ...ghost, marginTop: 4, marginBottom: 16 }}>+ Add retailer</button>

                <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16, lineHeight: 1.6 }}>
                  Claude generates the full spec schema from knowledge first — instantly. Then we automatically pull live specs from each URL to verify. If a site blocks scraping, you still get Claude's schema.
                </p>
                {err && <p style={{ fontSize: 13, color: '#ef4444', marginBottom: 10 }}>{err}</p>}
                <button onClick={run} style={primary}>Build spec matrix →</button>
              </div>
            )}

            {/* STEP 2: Progress */}
            {step === 2 && (
              <div>
                {/* Phase 1: Schema generation */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  {phase === 'schema' ? <Spinner /> : <Dot s="done" />}
                  <span style={{ fontSize: 14, fontWeight: 500, color: '#111' }}>
                    {phase === 'schema' ? 'Generating spec schema from Claude knowledge…' : `✓ Spec schema generated for "${category}"`}
                  </span>
                </div>

                {/* Phase 2: Live scraping */}
                {(phase === 'scraping' || phase === 'done') && (
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 10 }}>
                      {allScraped ? 'Live data fetched:' : 'Fetching live data from retailers…'}
                    </p>
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                      {liveList.map(([retailer, d]) => (
                        <div key={retailer} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}>
                          <Dot s={d.status} />
                          <span style={{ minWidth: 110, fontSize: 13, fontWeight: 500 }}>{retailer}</span>
                          <span style={{ fontSize: 12, color: d.status === 'done' ? '#10b981' : d.status === 'error' ? '#ef4444' : '#9ca3af' }}>
                            {d.status === 'pending' && 'Waiting…'}
                            {d.status === 'loading' && 'Fetching… (up to 2 min)'}
                            {d.status === 'done' && `✓ ${d.specCount} live specs found`}
                            {d.status === 'error' && (d.error || 'Could not fetch')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* STEP 3: Results */}
            {step === 3 && schemaData && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <h2 style={{ fontSize: 15, fontWeight: 600, color: '#111' }}>{category} — spec matrix</h2>
                    <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                      Schema from Claude · Live data from {Object.values(liveData).filter(d => d.status === 'done').length}/{liveList.length} retailers
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={downloadCSV} style={ghost}>⬇ CSV</button>
                    <button onClick={copyCSV} style={ghost}>{csvCopied ? 'Copied!' : 'Copy for Excel'}</button>
                    <button onClick={copyJSON} style={ghost}>{jsonCopied ? 'Copied!' : 'Copy JSON'}</button>
                    <button onClick={reset} style={ghost}>Start over</button>
                  </div>
                </div>

                {/* Failed retailers */}
                {Object.values(liveData).some(d => d.status === 'error') && (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#991b1b' }}>
                    Could not fetch live data for: {Object.entries(liveData).filter(([, d]) => d.status === 'error').map(([r, d]) => `${r} (${d.error})`).join(' · ')}
                    {' '}— Claude's schema is still shown for these.
                  </div>
                )}

                <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                    <thead>
                      <tr>
                        <th style={{ ...TH, position: 'sticky', left: 0, zIndex: 2, minWidth: 160, background: '#f1f5f9' }}>Spec</th>
                        {retailers.map(r => {
                          const d = liveData[r]
                          return (
                            <th key={r} style={{ ...TH, minWidth: 170, verticalAlign: 'top', whiteSpace: 'normal' }}>
                              <div style={{ fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', fontSize: 10, letterSpacing: .5, marginBottom: 3 }}>{r}</div>
                              {d?.image && <img src={d.image} alt="" style={{ width: 32, height: 32, objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff', marginBottom: 3, display: 'block' }} />}
                              {d?.productName && <div style={{ fontSize: 10.5, fontWeight: 500, color: '#374151', lineHeight: 1.3, marginBottom: 3 }}>{d.productName}</div>}
                              {d?.url && <a href={d.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: '#3b82f6', textDecoration: 'none' }}>View page ↗</a>}
                              {d?.status === 'error' && <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2 }}>Live data unavailable</div>}
                            </th>
                          )
                        })}
                        <th style={{ ...TH, minWidth: 170, background: '#eff6ff', color: '#1e40af' }}>✓ Recommended</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schemaData.specGroups.map((g, gi) => (
                        <>
                          <tr key={`g${gi}`}>
                            <td colSpan={retailers.length + 2} style={{ padding: '7px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: .5 }}>
                              {g.group}
                            </td>
                          </tr>
                          {g.specs.map((spec, si) => {
                            const rowBg = si % 2 === 0 ? '#fff' : '#f9fafb'
                            return (
                              <tr key={`${gi}-${si}`} style={{ background: rowBg }}>
                                <td style={{ ...TD, fontWeight: 600, position: 'sticky', left: 0, background: rowBg, zIndex: 1, color: '#374151' }}>
                                  <div>{spec.concept}</div>
                                  <span style={{ fontSize: 9.5, color: importanceColors[spec.importance], fontWeight: 700, textTransform: 'uppercase' }}>{spec.importance}</span>
                                </td>
                                {retailers.map(r => {
                                  const match = getLiveValue(r, spec)
                                  const d = liveData[r]
                                  return (
                                    <td key={r} style={{ ...TD }}>
                                      {match ? (
                                        <>
                                          <span style={{ fontSize: 10, color: '#9ca3af', display: 'block' }}>{match.label}</span>
                                          <span style={{ color: '#111' }}>{match.value}</span>
                                        </>
                                      ) : d?.status === 'done' ? (
                                        <span style={{ color: '#d1d5db' }}>—</span>
                                      ) : d?.status === 'error' ? (
                                        <span style={{ fontSize: 10.5, color: '#9ca3af', fontStyle: 'italic' }}>{spec.knownRetailerLabels?.[r] || '—'}</span>
                                      ) : (
                                        <span style={{ color: '#d1d5db' }}>—</span>
                                      )}
                                    </td>
                                  )
                                })}
                                <td style={{ ...TD, background: '#eff6ff' }}>
                                  <span style={{ fontSize: 10, color: '#3b82f6', display: 'block' }}>{spec.recommendedLabel}</span>
                                  <span style={{ color: '#1e40af', fontWeight: 500, fontSize: 12 }}>
                                    {(() => {
                                      // Find best live value for recommended column
                                      for (const r of retailers) {
                                        const m = getLiveValue(r, spec)
                                        if (m) return m.value
                                      }
                                      return <span style={{ color: '#c7d2fe', fontStyle: 'italic', fontWeight: 400 }}>not yet fetched</span>
                                    })()}
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 10, lineHeight: 1.6 }}>
                  Schema generated by Claude · Live values fetched verbatim from retailer pages via Zyte · Blank cells = spec not found on that page · Italic cells = live data unavailable, showing expected label only
                </p>
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  )
}

const lbl = { fontSize: 13, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 7 }
const inp = { padding: '9px 11px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, color: '#111', background: '#fff', outline: 'none' }
const primary = { padding: '10px 20px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13.5, fontWeight: 500, cursor: 'pointer' }
const ghost = { padding: '6px 13px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12.5, color: '#374151', cursor: 'pointer' }
const TH = { textAlign: 'left', padding: '10px 12px', borderBottom: '1.5px solid #e5e7eb', fontSize: 11, color: '#6b7280', fontWeight: 600, background: '#f9fafb' }
const TD = { padding: '9px 12px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top', fontSize: 12.5, lineHeight: 1.4, wordBreak: 'break-word', maxWidth: 170 }
