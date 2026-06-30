// pages/index.js v8
// Simple, clean table: spec name | retailer cols (verbatim) | Recommended
// Group headers separate the spec categories.

import { useState, useRef } from 'react'
import Head from 'next/head'

function retailerName(url) {
  try {
    const h = new URL(url).hostname.replace('www.', '').split('.')[0]
    return h.charAt(0).toUpperCase() + h.slice(1)
  } catch { return url.slice(0, 20) }
}

function Dot({ s }) {
  const c = { pending: '#d1d5db', loading: '#f59e0b', done: '#10b981', error: '#ef4444' }
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c[s] || '#ddd', flexShrink: 0, animation: s === 'loading' ? 'pulse 1s infinite' : 'none' }} />
}

function Spin() {
  return <>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
    <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid #e5e7eb', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin .75s linear infinite' }} />
  </>
}

// CSV of recommended specs for copy/paste into Excel
function toCSV(recs, category) {
  const rows = [['Spec', 'Value', 'Group', 'Source']]
  for (const r of recs) rows.push([r.label, r.value, r.group, r.fromRetailer])
  return rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
}

export default function App() {
  const [step, setStep]           = useState(1)
  const [category, setCategory]   = useState('')
  const [inputs, setInputs]       = useState(['', '', ''])
  const [inputErr, setInputErr]   = useState('')
  const [statuses, setStatuses]   = useState({})
  const [matrix, setMatrix]       = useState(null)
  const [synMsg, setSynMsg]       = useState('Building matrix…')
  const [syncing, setSyncing]     = useState(false)
  const [fatalErr, setFatalErr]   = useState('')
  const [csvCopied, setCsvCopied] = useState(false)
  const [jsonCopied, setJsonCopied] = useState(false)
  const ref = useRef({})

  const setS = (url, patch) => {
    ref.current[url] = { ...ref.current[url], ...patch }
    setStatuses({ ...ref.current })
  }

  function addInput() { setInputs(p => [...p, '']) }
  function delInput(i) { setInputs(p => p.filter((_, j) => j !== i)) }
  function setInput(i, v) { setInputs(p => p.map((x, j) => j === i ? v : x)) }

  async function run() {
    const urls = inputs.map(u => u.trim()).filter(Boolean)
    if (!category.trim()) { setInputErr('Enter a product category.'); return }
    if (urls.length < 2)  { setInputErr('Add at least 2 URLs.'); return }
    setInputErr(''); setFatalErr('')
    ref.current = {}
    urls.forEach(u => setS(u, { name: retailerName(u), status: 'pending', count: 0, specs: null, productName: null, image: null }))
    setStep(2)

    await Promise.all(urls.map(async url => {
      setS(url, { status: 'loading' })
      try {
        const r = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
        let d
        try { d = await r.json() } catch { throw new Error(`Server error (HTTP ${r.status})`) }
        if (!r.ok || d.error) throw new Error(d.error || 'Scrape failed')
        setS(url, { status: 'done', specs: d.specs, count: Object.keys(d.specs).length, productName: d.productName, image: d.image })
      } catch (e) {
        setS(url, { status: 'error', error: e.message })
      }
    }))

    const ok = urls.filter(u => ref.current[u].specs)
    if (!ok.length) { setFatalErr('All pages failed. Check your URLs and try again.'); return }

    setSyncing(true)
    const synMsgs = ['Matching specs across retailers…', 'Grouping by category…', 'Selecting recommended specs…']
    let mi = 0
    const t = setInterval(() => { mi = Math.min(mi + 1, synMsgs.length - 1); setSynMsg(synMsgs[mi]) }, 2000)

    const products = ok.map(url => ({
      retailer: ref.current[url].name,
      productName: ref.current[url].productName,
      image: ref.current[url].image,
      url,
      specs: ref.current[url].specs,
    }))
    const failed = urls.filter(u => !ref.current[u].specs).map(u => ({ name: ref.current[u].name, error: ref.current[u].error }))

    try {
      const r = await fetch('/api/build-matrix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, products }) })
      clearInterval(t)
      let d
      try { d = await r.json() } catch { throw new Error(`Server error (HTTP ${r.status})`) }
      if (!r.ok || d.error) throw new Error(d.error || 'Matrix build failed')
      setMatrix({ ...d, failed })
      setSyncing(false)
      setStep(3)
    } catch (e) {
      clearInterval(t)
      setSyncing(false)
      setFatalErr('Matrix build failed: ' + e.message)
    }
  }

  function reset() {
    setStep(1); setCategory(''); setInputs(['', '', '']); setStatuses({}); ref.current = {}
    setMatrix(null); setInputErr(''); setFatalErr(''); setSyncing(false)
  }

  function copyCSV() {
    navigator.clipboard.writeText(toCSV(matrix.recommendedSpecs, matrix.category))
      .then(() => { setCsvCopied(true); setTimeout(() => setCsvCopied(false), 1500) })
  }

  function copyJSON() {
    const j = JSON.stringify({
      category: matrix.category,
      specs: matrix.recommendedSpecs.map(s => ({
        key: s.label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        label: s.label, value: s.value, group: s.group,
      }))
    }, null, 2)
    navigator.clipboard.writeText(j).then(() => { setJsonCopied(true); setTimeout(() => setJsonCopied(false), 1500) })
  }

  function downloadCSV() {
    const blob = new Blob([toCSV(matrix.recommendedSpecs)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(matrix.category || 'specs').replace(/\s+/g, '_')}_recommended.csv`
    a.click()
  }

  // Group spec rows by their group label
  const groups = {}
  if (matrix?.specRows) {
    for (const row of matrix.specRows) {
      const g = row.group || 'Other'
      if (!groups[g]) groups[g] = []
      groups[g].push(row)
    }
  }

  const statusList = Object.entries(statuses)
  const allDone = statusList.length > 0 && statusList.every(([, s]) => s.status === 'done' || s.status === 'error')

  return (
    <>
      <Head><title>Spec Matrix Builder</title></Head>
      <div style={{ minHeight: '100vh', background: '#f7f8fa', padding: '2rem 1rem', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>

          <div style={{ marginBottom: '1.5rem' }}>
            <h1 style={{ fontSize: 21, fontWeight: 700, margin: '0 0 4px', color: '#111' }}>Spec Matrix Builder</h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Paste product URLs → extract verbatim specs → compare side-by-side</p>
          </div>

          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '1.75rem', boxShadow: '0 1px 3px rgba(0,0,0,.05)' }}>

            {/* ── STEP 1: Input ── */}
            {step === 1 && (
              <div>
                <label style={lbl}>Product category</label>
                <input value={category} onChange={e => setCategory(e.target.value)} onKeyDown={e => e.key === 'Enter' && run()}
                  placeholder="e.g. coffee maker, dishwasher, skis…" style={{ ...inp, width: '100%', marginBottom: 20, boxSizing: 'border-box' }} />

                <label style={lbl}>One product page URL per retailer (same or similar product on each site)</label>
                {inputs.map((v, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input type="url" value={v} onChange={e => setInput(i, e.target.value)} placeholder="https://…" style={{ ...inp, flex: 1 }} />
                    {inputs.length > 2 && <button onClick={() => delInput(i)} style={ghost}>✕</button>}
                  </div>
                ))}
                <button onClick={addInput} style={{ ...ghost, marginTop: 4, marginBottom: 16 }}>+ Add retailer</button>

                <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 16px', lineHeight: 1.6 }}>
                  All specs are extracted verbatim from the actual page — nothing is invented.
                  Amazon URLs are often blocked; try Best Buy, Target, Wayfair, AJ Madison, Lowe's.
                </p>
                {inputErr && <p style={{ fontSize: 13, color: '#ef4444', margin: '0 0 12px' }}>{inputErr}</p>}
                <button onClick={run} style={primary}>Extract specs →</button>
              </div>
            )}

            {/* ── STEP 2: Fetching ── */}
            {step === 2 && (
              <div>
                <p style={{ fontWeight: 600, fontSize: 15, marginBottom: 14, color: '#111' }}>
                  {allDone && syncing ? synMsg : `Fetching ${statusList.length} pages…`}
                </p>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  {statusList.map(([url, s]) => (
                    <div key={url} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}>
                      <Dot s={s.status} />
                      <span style={{ minWidth: 110, fontSize: 13, fontWeight: 500, color: '#374151' }}>{s.name}</span>
                      <span style={{ fontSize: 12, color: s.status === 'done' ? '#10b981' : s.status === 'error' ? '#ef4444' : '#9ca3af' }}>
                        {s.status === 'pending' && 'Waiting…'}
                        {s.status === 'loading' && 'Fetching…'}
                        {s.status === 'done'    && `${s.count} specs found`}
                        {s.status === 'error'   && (s.error || 'Failed')}
                      </span>
                    </div>
                  ))}
                </div>
                {allDone && syncing && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, color: '#6b7280', fontSize: 14 }}><Spin /> {synMsg}</div>
                )}
                {fatalErr && <div style={{ marginTop: 12 }}>
                  <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 8 }}>{fatalErr}</p>
                  <button onClick={reset} style={ghost}>← Start over</button>
                </div>}
              </div>
            )}

            {/* ── STEP 3: Results ── */}
            {step === 3 && matrix && (() => {
              const prods = matrix.products
              return (
                <div>
                  {/* Top bar */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                    <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: '#111' }}>{matrix.category} — spec comparison</h2>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={downloadCSV} style={ghost}>⬇ CSV</button>
                      <button onClick={copyCSV}  style={ghost}>{csvCopied  ? 'Copied!' : 'Copy for Excel'}</button>
                      <button onClick={copyJSON} style={ghost}>{jsonCopied ? 'Copied!' : 'Copy JSON'}</button>
                      <button onClick={reset}    style={ghost}>Start over</button>
                    </div>
                  </div>

                  {/* Failed retailers warning */}
                  {matrix.failed?.length > 0 && (
                    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#991b1b' }}>
                      {matrix.failed.map(f => `${f.name} could not be fetched (${f.error})`).join(' · ')}
                    </div>
                  )}

                  {/* The table */}
                  <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                      <thead>
                        <tr>
                          {/* Spec name column */}
                          <th style={{ ...TH, position: 'sticky', left: 0, zIndex: 2, minWidth: 130, background: '#f1f5f9' }}>Spec</th>
                          {/* One column per retailer */}
                          {prods.map(p => (
                            <th key={p.retailer} style={{ ...TH, minWidth: 160, verticalAlign: 'top', whiteSpace: 'normal' }}>
                              <div style={{ fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', fontSize: 10.5, letterSpacing: .4, marginBottom: 4 }}>{p.retailer}</div>
                              {p.image && <img src={p.image} alt="" style={{ width: 36, height: 36, objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: 5, background: '#fff', marginBottom: 4 }} />}
                              <div style={{ fontSize: 11, fontWeight: 500, color: '#374151', lineHeight: 1.3, marginBottom: 4, maxWidth: 160 }}>{p.productName}</div>
                              <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 10.5, color: '#3b82f6', textDecoration: 'none' }}>View page ↗</a>
                            </th>
                          ))}
                          {/* Recommended column */}
                          <th style={{ ...TH, minWidth: 160, background: '#eff6ff', color: '#1e40af' }}>✓ Recommended</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(groups).map(([group, rows]) => (
                          <>
                            {/* Group header row */}
                            <tr key={`g-${group}`}>
                              <td colSpan={prods.length + 2} style={{ padding: '8px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: .5 }}>
                                {group}
                              </td>
                            </tr>
                            {/* Spec rows in this group */}
                            {rows.map((row, i) => {
                              const rec = matrix.recommendedSpecs?.find(s => s.label.toLowerCase() === row.concept.toLowerCase() || Object.values(row.byRetailer || {}).some(v => v && s.value && v.includes(s.value)))
                              return (
                                <tr key={`${group}-${i}`} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                                  {/* Spec name */}
                                  <td style={{ ...TD, fontWeight: 600, position: 'sticky', left: 0, background: i % 2 === 0 ? '#fff' : '#f9fafb', zIndex: 1, maxWidth: 130, color: '#374151' }}>
                                    {row.concept}
                                  </td>
                                  {/* Each retailer's verbatim value */}
                                  {prods.map(p => {
                                    const val = row.byRetailer?.[p.retailer]
                                    return (
                                      <td key={p.retailer} style={{ ...TD, maxWidth: 160 }}>
                                        {val
                                          ? <span style={{ color: '#111' }}>{val}</span>
                                          : <span style={{ color: '#d1d5db' }}>—</span>}
                                      </td>
                                    )
                                  })}
                                  {/* Recommended value for this row */}
                                  <td style={{ ...TD, background: '#eff6ff', maxWidth: 160 }}>
                                    {rec
                                      ? <><span style={{ fontSize: 10.5, color: '#3b82f6', display: 'block', marginBottom: 2 }}>{rec.label}</span>
                                         <span style={{ color: '#1e40af', fontWeight: 600 }}>{rec.value}</span></>
                                      : <span style={{ color: '#c7d2fe', fontSize: 11 }}>—</span>}
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
                    Every value is extracted verbatim from the linked pages — nothing is invented. Blank cells mean that retailer's page didn't show that spec.
                    The Recommended column is a curated shortlist for consumers. Use "Copy for Excel" or "⬇ CSV" to export it.
                  </p>
                </div>
              )
            })()}

          </div>
        </div>
      </div>
    </>
  )
}

const lbl = { fontSize: 13, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 7 }
const inp = { padding: '9px 11px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, color: '#111', background: '#fff', outline: 'none' }
const primary = { padding: '10px 20px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13.5, fontWeight: 500, cursor: 'pointer' }
const ghost   = { padding: '6px 13px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12.5, color: '#374151', cursor: 'pointer' }
const TH = { textAlign: 'left', padding: '10px 12px', borderBottom: '1.5px solid #e5e7eb', fontSize: 11, color: '#6b7280', fontWeight: 600, background: '#f9fafb' }
const TD = { padding: '9px 12px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top', fontSize: 12.5, lineHeight: 1.4, wordBreak: 'break-word' }
