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
  const style = {
    width: 8, height: 8, borderRadius: '50%',
    background: colors[status] || '#d1d5db',
    flexShrink: 0,
    animation: status === 'loading' ? 'pulse 1s infinite' : 'none',
  }
  return <div style={style} />
}

function Spinner({ size = 16 }) {
  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }`}</style>
      <div style={{
        width: size, height: size,
        border: '2px solid #e5e7eb',
        borderTopColor: '#3b82f6',
        borderRadius: '50%',
        animation: 'spin 0.75s linear infinite',
        flexShrink: 0,
      }} />
    </>
  )
}

export default function Home() {
  const [step, setStep] = useState(1)
  const [category, setCategory] = useState('')
  const [urlInputs, setUrlInputs] = useState(['', '', ''])
  const [inputError, setInputError] = useState('')
  const [statuses, setStatuses] = useState({})
  const [specData, setSpecData] = useState(null)
  const [synthesisMsg, setSynthesisMsg] = useState('Matching specs across retailers…')
  const [synthesizing, setSynthesizing] = useState(false)
  const [activeTab, setActiveTab] = useState('table')
  const [copied, setCopied] = useState(false)
  const [fatalError, setFatalError] = useState('')
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
      initial[url] = { name: getRetailerName(url), status: 'pending', specCount: 0, content: null, error: false }
    })
    statusesRef.current = initial
    setStatuses({ ...initial })

    async function fetchOne(url) {
      updateStatus(url, { status: 'loading' })
      try {
        const res = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        })
        const data = await res.json()
        if (!res.ok || data.error) throw new Error(data.error || 'Scrape failed')
        updateStatus(url, { status: 'done', content: data.specs, specCount: Object.keys(data.specs).length })
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
    const msgs = [
      'Matching specs across retailers…',
      'Identifying equivalent specs with different labels…',
      'Selecting best spec name for each row…',
    ]
    let mi = 0
    const ticker = setInterval(() => { mi = Math.min(mi + 1, msgs.length - 1); setSynthesisMsg(msgs[mi]) }, 2200)

    const retailerData = {}
    successful.forEach(url => { retailerData[statusesRef.current[url].name] = statusesRef.current[url].content })

    try {
      const res = await fetch('/api/build-matrix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, retailerData }),
      })
      clearInterval(ticker)
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || 'Matrix build failed')
      setSpecData(data)
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
    setStatuses({}); statusesRef.current = {}; setSpecData(null)
    setActiveTab('table'); setInputError(''); setFatalError('')
    setSynthesizing(false)
  }

  function getDevJSON() {
    if (!specData) return ''
    return JSON.stringify({
      category: specData.category,
      specFields: specData.rows.filter(r => r.include).map(r => ({
        key: r.recommended.label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        label: r.recommended.label,
        type: 'string',
        seenAt: Object.entries(r.retailerSpecs || {}).filter(([, v]) => v !== null).map(([k]) => k),
      })),
    }, null, 2)
  }

  function copyJSON() {
    navigator.clipboard.writeText(getDevJSON()).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    })
  }

  const urls = urlInputs.map(u => u.trim()).filter(Boolean)
  const statusList = Object.entries(statuses)
  const allSettled = statusList.length > 0 && statusList.every(([, s]) => s.status === 'done' || s.status === 'error')

  return (
    <>
      <Head>
        <title>Spec Matrix Builder</title>
        <meta name="description" content="Extract and compare product specs across retailers" />
      </Head>

      <div style={{ minHeight: '100vh', background: '#f7f8fa', padding: '2rem 1rem' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>

          {/* Header */}
          <div style={{ marginBottom: '2rem' }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', marginBottom: 4 }}>Spec Matrix Builder</h1>
            <p style={{ fontSize: 14, color: '#6b7280' }}>
              Paste product page URLs → extract raw specs → get a canonical spec list for your database
            </p>
          </div>

          {/* Card */}
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '2rem', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>

            {/* STEP 1 */}
            {step === 1 && (
              <div>
                <Field label="Product category">
                  <input
                    type="text"
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && startFetch()}
                    placeholder="e.g. coffee maker, dishwasher, skis…"
                    style={{ width: '100%' }}
                  />
                </Field>

                <Field label="One product page URL per retailer — same or very similar product across each site" style={{ marginTop: '1.25rem' }}>
                  {urlInputs.map((url, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <input
                        type="url"
                        value={url}
                        onChange={e => updateUrl(i, e.target.value)}
                        placeholder="https://…"
                        style={{ flex: 1 }}
                      />
                      {urlInputs.length > 2 && (
                        <button onClick={() => removeUrl(i)} style={ghostBtn}>✕</button>
                      )}
                    </div>
                  ))}
                  <button onClick={addUrl} style={{ ...ghostBtn, marginTop: 4 }}>+ Add retailer</button>
                </Field>

                <p style={{ fontSize: 12, color: '#9ca3af', margin: '1rem 0', lineHeight: 1.6 }}>
                  Amazon URLs often get blocked — try Best Buy, Target, AJ Madison, Lowe's, Williams Sonoma, etc. first.
                </p>

                {inputError && <p style={{ fontSize: 13, color: '#ef4444', marginBottom: 12 }}>{inputError}</p>}

                <button onClick={startFetch} style={primaryBtn}>
                  Extract specs →
                </button>
              </div>
            )}

            {/* STEP 2: progress */}
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
                        {s.status === 'loading' && 'Fetching page…'}
                        {s.status === 'done' && `${s.specCount} specs found`}
                        {s.status === 'error' && (s.error || 'Could not fetch — blocked or JS-rendered')}
                      </span>
                    </div>
                  ))}
                </div>

                {allSettled && synthesizing && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: '1.25rem', color: '#6b7280', fontSize: 14 }}>
                    <Spinner /> {synthesisMsg}
                  </div>
                )}

                {fatalError && (
                  <div style={{ marginTop: '1rem' }}>
                    <p style={{ fontSize: 13, color: '#ef4444', marginBottom: 10 }}>{fatalError}</p>
                    <button onClick={startOver} style={ghostBtn}>← Start over</button>
                  </div>
                )}
              </div>
            )}

            {/* STEP 3: results */}
            {step === 3 && specData && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
                  <h2 style={{ fontSize: 16, fontWeight: 600, color: '#111' }}>{specData.category} — spec matrix</h2>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={copyJSON} style={ghostBtn}>{copied ? 'Copied!' : 'Copy JSON'}</button>
                    <button onClick={startOver} style={ghostBtn}>Start over</button>
                  </div>
                </div>

                {/* Tabs */}
                <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: '1.25rem' }}>
                  {['table', 'json'].map(t => (
                    <button key={t} onClick={() => setActiveTab(t)} style={{
                      padding: '8px 16px', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer',
                      borderBottom: activeTab === t ? '2px solid #3b82f6' : '2px solid transparent',
                      color: activeTab === t ? '#1d4ed8' : '#6b7280',
                      fontWeight: activeTab === t ? 600 : 400,
                      marginBottom: -1,
                    }}>
                      {t === 'table' ? 'Spec matrix' : 'JSON for devs'}
                    </button>
                  ))}
                </div>

                {/* Table view */}
                {activeTab === 'table' && (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', minWidth: 600 }}>
                      <thead>
                        <tr>
                          {specData.retailers.map(r => (
                            <th key={r} style={th}>{r}</th>
                          ))}
                          <th style={{ ...th, background: '#eff6ff', color: '#1d4ed8' }}>Use this spec</th>
                        </tr>
                      </thead>
                      <tbody>
                        {specData.rows.filter(r => r.include).map((row, i) => (
                          <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                            {specData.retailers.map(r => {
                              const entry = row.retailerSpecs?.[r]
                              return (
                                <td key={r} style={td}>
                                  {entry ? (
                                    <>
                                      <span style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 2 }}>{entry.label}</span>
                                      <span style={{ color: '#111' }}>{entry.value}</span>
                                    </>
                                  ) : (
                                    <span style={{ color: '#d1d5db' }}>—</span>
                                  )}
                                </td>
                              )
                            })}
                            <td style={{ ...td, background: '#eff6ff' }}>
                              <span style={{ fontSize: 11, color: '#3b82f6', display: 'block', marginBottom: 2 }}>{row.recommended.label}</span>
                              <span style={{ color: '#1d4ed8', fontWeight: 500 }}>
                                {row.recommended.value !== null
                                  ? row.recommended.value
                                  : <span style={{ opacity: 0.5, fontWeight: 400, fontStyle: 'italic' }}>varies</span>}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {specData.rows.filter(r => !r.include).length > 0 && (
                      <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 12 }}>
                        {specData.rows.filter(r => !r.include).length} specs excluded (model numbers, marketing copy, etc.)
                      </p>
                    )}
                  </div>
                )}

                {/* JSON view */}
                {activeTab === 'json' && (
                  <textarea
                    readOnly
                    value={getDevJSON()}
                    style={{ width: '100%', minHeight: 320, fontFamily: 'monospace', fontSize: 12 }}
                  />
                )}

                <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 12, lineHeight: 1.6 }}>
                  Blue column = the spec name and best value to use in your database. Blank cells = that retailer doesn't list that spec. Review, then hand the JSON to your dev team.
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

const primaryBtn = {
  padding: '10px 20px', background: '#1d4ed8', color: '#fff',
  border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 500, cursor: 'pointer',
}
const ghostBtn = {
  padding: '7px 14px', background: '#fff', border: '1px solid #e5e7eb',
  borderRadius: 7, fontSize: 13, color: '#374151', cursor: 'pointer',
}
const th = {
  textAlign: 'left', padding: '10px 14px',
  borderBottom: '1.5px solid #e5e7eb', fontSize: 12,
  color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap', background: '#f9fafb',
}
const td = {
  padding: '10px 14px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top', fontSize: 13,
}
