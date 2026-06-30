import { useState, useRef } from 'react'
import Head from 'next/head'

function getRetailerName(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    const n = host.split('.')[0]
    return n.charAt(0).toUpperCase() + n.slice(1)
  } catch {
    return url.slice(0, 20)
  }
}

function StatusDot({ status }) {
  const colors = { pending: '#d1d5db', loading: '#f59e0b', done: '#10b981', error: '#ef4444' }
  return <div style={{ width: 8, height: 8, borderRadius: '50%', background: colors[status] || '#d1d5db', flexShrink: 0, animation: status === 'loading' ? 'pulse 1s infinite' : 'none' }} />
}

function Spinner({ size = 16 }) {
  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }`}</style>
      <div style={{ width: size, height: size, border: '2px solid #e5e7eb', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.75s linear infinite', flexShrink: 0 }} />
    </>
  )
}

// [FE-1] CSV export for the recommended specs — copy/paste straight into Excel
function specsToCSV(recommendedSpecs) {
  const header = ['Spec', 'Value', 'Category', 'Source Retailer', 'Why It Matters']
  const rows = recommendedSpecs.map(s => [s.label, s.value, s.groupLabel, s.sourceRetailer, s.whyItMatters])
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [header, ...rows].map(r => r.map(escape).join(',')).join('\n')
}

export default function Home() {
  const [step, setStep] = useState(1)
  const [category, setCategory] = useState('')
  const [urlInputs, setUrlInputs] = useState(['', '', ''])
  const [inputError, setInputError] = useState('')
  const [statuses, setStatuses] = useState({})
  const [matrixData, setMatrixData] = useState(null)
  const [synthesisMsg, setSynthesisMsg] = useState('Matching specs across retailers…')
  const [synthesizing, setSynthesizing] = useState(false)
  const [copiedCSV, setCopiedCSV] = useState(false)
  const [copiedJSON, setCopiedJSON] = useState(false)
  const [fatalError, setFatalError] = useState('')
  const [activeView, setActiveView] = useState('recommended') // [FE-2] default to the curated view, not the raw matrix
  const statusesRef = useRef({})

  function addUrl() { setUrlInputs(p => [...p, '']) }
  function removeUrl(i) { setUrlInputs(p => p.filter((_, idx) => idx !== i)) }
  function updateUrl(i, v) { setUrlInputs(p => p.map((u, idx) => idx === i ? v : u)) }

  function updateStatus(url, patch) {
    statusesRef.current[url] = { ...statusesRef.current[url], ...patch }
    setStatuses({ ...statusesRef.current })
  }

  async function startFetch() {
    const urls = urlInputs.map(u => u.trim()).filter(Boolean)
    if (!category.trim()) { setInputError('Please enter a product category.'); return }
    if (urls.length < 2) { setInputError('Please add at least 2 URLs.'); return }
    setInputError('')
    setFatalError('')
    setStep(2)

    const initial = {}
    urls.forEach(url => {
      initial[url] = { name: getRetailerName(url), status: 'pending', specCount: 0, content: null, productName: null, image: null }
    })
    statusesRef.current = initial
    setStatuses({ ...initial })

    async function fetchOne(url) {
      updateStatus(url, { status: 'loading' })
      try {
        const res = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
        let data
        try { data = await res.json() } catch { throw new Error(`Server returned an unreadable response (HTTP ${res.status})`) }
        if (!res.ok || data.error) throw new Error(data.error || 'Scrape failed')
        updateStatus(url, { status: 'done', content: data.specs, specCount: Object.keys(data.specs).length, productName: data.productName, image: data.image })
      } catch (e) {
        updateStatus(url, { status: 'error', error: e.message })
      }
    }

    await Promise.all(urls.map(url => fetchOne(url)))

    const successful = urls.filter(u => statusesRef.current[u].content)
    if (successful.length === 0) {
      setFatalError('All pages failed to fetch. Check your URLs and try again.')
      return
    }

    setSynthesizing(true)
    const msgs = ['Grouping specs into categories…', 'Curating the specs that matter for buying decisions…', 'Finalizing the comparison…']
    let mi = 0
    const ticker = setInterval(() => { mi = Math.min(mi + 1, msgs.length - 1); setSynthesisMsg(msgs[mi]) }, 2200)

    const products = successful.map(url => ({
      retailer: statusesRef.current[url].name,
      productName: statusesRef.current[url].productName,
      image: statusesRef.current[url].image,
      url,
      specs: statusesRef.current[url].content,
    }))
    const failed = urls.filter(u => !statusesRef.current[u].content).map(url => ({
      retailer: statusesRef.current[url].name, url, error: statusesRef.current[url].error,
    }))

    try {
      const res = await fetch('/api/build-matrix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, products }) })
      clearInterval(ticker)
      let data
      try { data = await res.json() } catch { throw new Error(`Server returned an unreadable response (HTTP ${res.status})`) }
      if (!res.ok || data.error) throw new Error(data.error || 'Matrix build failed')
      setMatrixData({ ...data, failed })
      setSynthesizing(false)
      setStep(3)
    } catch (e) {
      clearInterval(ticker)
      setSynthesizing(false)
      setFatalError('Failed to build spec matrix: ' + e.message)
    }
  }

  function startOver() {
    setStep(1); setCategory(''); setUrlInputs(['', '', ''])
    setStatuses({}); statusesRef.current = {}; setMatrixData(null)
    setInputError(''); setFatalError(''); setSynthesizing(false); setActiveView('recommended')
  }

  function copyCSV() {
    if (!matrixData?.recommendedSpecs) return
    navigator.clipboard.writeText(specsToCSV(matrixData.recommendedSpecs)).then(() => { setCopiedCSV(true); setTimeout(() => setCopiedCSV(false), 1500) })
  }

  function copyJSON() {
    if (!matrixData) return
    const json = JSON.stringify({
      category: matrixData.category,
      specFields: matrixData.recommendedSpecs.map(s => ({
        key: s.label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        label: s.label,
        value: s.value,
        category: s.groupLabel,
      })),
    }, null, 2)
    navigator.clipboard.writeText(json).then(() => { setCopiedJSON(true); setTimeout(() => setCopiedJSON(false), 1500) })
  }

  function downloadCSV() {
    if (!matrixData?.recommendedSpecs) return
    const blob = new Blob([specsToCSV(matrixData.recommendedSpecs)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${matrixData.category.replace(/[^a-z0-9]+/gi, '_')}_recommended_specs.csv`
    a.click()
  }

  const urls = urlInputs.map(u => u.trim()).filter(Boolean)
  const statusList = Object.entries(statuses)
  const allSettled = statusList.length > 0 && statusList.every(([, s]) => s.status === 'done' || s.status === 'error')

  // [FE-3] group specRows by groupLabel for the "Full matrix" view
  const groupedRows = {}
  if (matrixData?.specRows) {
    for (const row of matrixData.specRows) {
      const g = row.groupLabel || 'Other'
      if (!groupedRows[g]) groupedRows[g] = []
      groupedRows[g].push(row)
    }
  }
  // [FE-4] group recommendedSpecs by groupLabel for the curated view
  const groupedRecommended = {}
  if (matrixData?.recommendedSpecs) {
    for (const spec of matrixData.recommendedSpecs) {
      const g = spec.groupLabel || 'Other'
      if (!groupedRecommended[g]) groupedRecommended[g] = []
      groupedRecommended[g].push(spec)
    }
  }

  return (
    <>
      <Head><title>Spec Matrix Builder</title></Head>
      <div style={{ minHeight: '100vh', background: '#f7f8fa', padding: '2rem 1rem' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>

          <div style={{ marginBottom: '2rem' }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', marginBottom: 4 }}>Spec Matrix Builder</h1>
            <p style={{ fontSize: 14, color: '#6b7280' }}>Paste product page URLs → extract verbatim specs → get a curated, buying-decision spec list for your database</p>
          </div>

          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '2rem', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>

            {step === 1 && (
              <div>
                <Field label="Product category">
                  <input type="text" value={category} onChange={e => setCategory(e.target.value)} onKeyDown={e => e.key === 'Enter' && startFetch()} placeholder="e.g. coffee maker, dishwasher, skis…" style={{ width: '100%' }} />
                </Field>
                <Field label="One product page URL per retailer — same or very similar product across each site" style={{ marginTop: '1.25rem' }}>
                  {urlInputs.map((url, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <input type="url" value={url} onChange={e => updateUrl(i, e.target.value)} placeholder="https://…" style={{ flex: 1 }} />
                      {urlInputs.length > 2 && <button onClick={() => removeUrl(i)} style={ghostBtn}>✕</button>}
                    </div>
                  ))}
                  <button onClick={addUrl} style={{ ...ghostBtn, marginTop: 4 }}>+ Add retailer</button>
                </Field>
                <p style={{ fontSize: 12, color: '#9ca3af', margin: '1rem 0', lineHeight: 1.6 }}>
                  Every spec shown is extracted verbatim from the actual page — nothing is invented. Amazon URLs are often blocked; try Best Buy, Target, Wayfair, AJ Madison, Lowe's first.
                </p>
                {inputError && <p style={{ fontSize: 13, color: '#ef4444', marginBottom: 12 }}>{inputError}</p>}
                <button onClick={startFetch} style={primaryBtn}>Extract specs →</button>
              </div>
            )}

            {step === 2 && (
              <div>
                <p style={{ fontSize: 15, fontWeight: 600, marginBottom: '1rem', color: '#111' }}>
                  {allSettled && synthesizing ? synthesisMsg : `Fetching ${statusList.length} pages…`}
                </p>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  {statusList.map(([url, s]) => (
                    <div key={url} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid #f3f4f6' }}>
                      <StatusDot status={s.status} />
                      <span style={{ minWidth: 120, fontSize: 13, fontWeight: 500, color: '#374151' }}>{s.name}</span>
                      <span style={{ fontSize: 12, color: s.status === 'done' ? '#10b981' : s.status === 'error' ? '#ef4444' : '#9ca3af' }}>
                        {s.status === 'pending' && 'Waiting…'}
                        {s.status === 'loading' && 'Fetching & extracting (dual-pass)…'}
                        {s.status === 'done' && `${s.specCount} specs found`}
                        {s.status === 'error' && (s.error || 'Could not fetch')}
                      </span>
                    </div>
                  ))}
                </div>
                {allSettled && synthesizing && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: '1.25rem', color: '#6b7280', fontSize: 14 }}><Spinner /> {synthesisMsg}</div>
                )}
                {fatalError && (
                  <div style={{ marginTop: '1rem' }}>
                    <p style={{ fontSize: 13, color: '#ef4444', marginBottom: 10 }}>{fatalError}</p>
                    <button onClick={startOver} style={ghostBtn}>← Start over</button>
                  </div>
                )}
              </div>
            )}

            {step === 3 && matrixData && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: 10 }}>
                  <h2 style={{ fontSize: 16, fontWeight: 600, color: '#111' }}>{matrixData.category} — spec comparison</h2>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={downloadCSV} style={ghostBtn}>⬇ Download CSV</button>
                    <button onClick={copyCSV} style={ghostBtn}>{copiedCSV ? 'Copied!' : 'Copy for Excel'}</button>
                    <button onClick={copyJSON} style={ghostBtn}>{copiedJSON ? 'Copied!' : 'Copy JSON'}</button>
                    <button onClick={startOver} style={ghostBtn}>Start over</button>
                  </div>
                </div>

                {matrixData.failed?.length > 0 && (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#991b1b' }}>
                    {matrixData.failed.map(f => `${f.retailer}: ${f.error}`).join(' · ')}
                  </div>
                )}

                {/* Product source row */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                  {matrixData.products.map(p => (
                    <a key={p.retailer} href={p.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 10px' }}>
                      {p.image && <img src={p.image} alt="" style={{ width: 26, height: 26, objectFit: 'contain', borderRadius: 4, background: '#fff', border: '1px solid #e5e7eb' }} />}
                      <div>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase' }}>{p.retailer}</div>
                        <div style={{ fontSize: 10.5, color: '#6b7280', maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.productName}</div>
                      </div>
                    </a>
                  ))}
                </div>

                {/* View toggle */}
                <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: '1.25rem' }}>
                  <button onClick={() => setActiveView('recommended')} style={tabBtn(activeView === 'recommended')}>Recommended specs ({matrixData.recommendedSpecs?.length || 0})</button>
                  <button onClick={() => setActiveView('full')} style={tabBtn(activeView === 'full')}>Full matrix, all retailers</button>
                </div>

                {/* RECOMMENDED VIEW — clean curated list, grouped, no "varies" */}
                {activeView === 'recommended' && (
                  <div>
                    {Object.entries(groupedRecommended).map(([group, specs]) => (
                      <div key={group} style={{ marginBottom: 22 }}>
                        <h3 style={{ fontSize: 12.5, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8, paddingBottom: 6, borderBottom: '2px solid #dbeafe' }}>{group}</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
                          {specs.map((s, i) => (
                            <div key={i} style={{ background: '#fafbfc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px' }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#111', marginBottom: 3 }}>{s.label}</div>
                              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1d4ed8', marginBottom: 6 }}>{s.value}</div>
                              <div style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.4 }}>{s.whyItMatters}</div>
                              <div style={{ fontSize: 10, color: '#c4c9d2', marginTop: 5 }}>via {s.sourceRetailer}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {(!matrixData.recommendedSpecs || matrixData.recommendedSpecs.length === 0) && (
                      <p style={{ fontSize: 13, color: '#9ca3af' }}>No recommended specs were generated.</p>
                    )}
                  </div>
                )}

                {/* FULL MATRIX VIEW — grouped headers, verbatim per-retailer specs */}
                {activeView === 'full' && (
                  <div>
                    {Object.entries(groupedRows).map(([group, rows]) => (
                      <div key={group} style={{ marginBottom: 18 }}>
                        <h3 style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 6px' }}>{group}</h3>
                        <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                            <thead>
                              <tr>
                                <th style={{ ...th, position: 'sticky', left: 0, zIndex: 2, minWidth: 120, maxWidth: 120 }}>Spec</th>
                                {matrixData.products.map(p => <th key={p.retailer} style={{ ...th, minWidth: 150, maxWidth: 170 }}>{p.retailer}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((row, i) => (
                                <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                                  <td style={{ ...td, fontWeight: 500, position: 'sticky', left: 0, background: i % 2 === 0 ? '#fff' : '#f9fafb', zIndex: 1, maxWidth: 120 }}>{row.concept}</td>
                                  {matrixData.products.map(p => {
                                    const val = row.valuesByRetailer?.[p.retailer]
                                    return (
                                      <td key={p.retailer} style={{ ...td, maxWidth: 170 }}>
                                        {val ? <span style={{ color: '#111' }}>{val}</span> : <span style={{ color: '#d1d5db' }}>—</span>}
                                      </td>
                                    )
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 16, lineHeight: 1.6 }}>
                  Every value above was extracted verbatim from the linked product pages — nothing is invented. "Recommended specs" is a curated shortlist for shoppers; "Full matrix" shows every spec from every retailer exactly as listed on their page.
                </p>
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  )
}

function Field({ label, children, style }) {
  return (
    <div style={style}>
      <label style={{ fontSize: 13, color: '#374151', display: 'block', marginBottom: 8, fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  )
}

function tabBtn(active) {
  return { padding: '8px 16px', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer', borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent', color: active ? '#1d4ed8' : '#6b7280', fontWeight: active ? 600 : 400, marginBottom: -1 }
}

const primaryBtn = { padding: '10px 20px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 500, cursor: 'pointer' }
const ghostBtn = { padding: '7px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12.5, color: '#374151', cursor: 'pointer' }
const th = { textAlign: 'left', padding: '9px 12px', borderBottom: '1.5px solid #e5e7eb', fontSize: 11, color: '#6b7280', fontWeight: 600, background: '#f9fafb' }
const td = { padding: '9px 12px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top', fontSize: 12.5, lineHeight: 1.4, wordBreak: 'break-word' }
