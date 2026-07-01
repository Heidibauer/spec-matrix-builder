import { useState, useRef } from 'react'
import Head from 'next/head'

const QUICK_PICKS = [
  'Coffee Maker','Espresso Machine','Dishwasher','Refrigerator',
  'Washing Machine','Air Fryer','Blender','Microwave',
  'Skis','Snowboard','Golf Clubs','Running Shoes','Bicycle',
  'Television','Laptop','Headphones','Camera',
  'Sofa','Mattress','Office Chair',
]

const IMP_COLOR = { high:'#dc2626', medium:'#d97706', low:'#9ca3af' }
const IMP_BG    = { high:'#fef2f2', medium:'#fffbeb', low:'#ffffff' }

// Fuzzy match: does a scraped spec label match a schema spec label?
function matchSpec(spec, liveSpecs) {
  if (!liveSpecs) return null
  const lower = spec.label.toLowerCase()
  for (const [k, v] of Object.entries(liveSpecs)) {
    const kl = k.toLowerCase()
    if (kl === lower || kl.includes(lower) || lower.includes(kl)) {
      return { label: k, value: v }
    }
  }
  return null
}

// Find retailer specs not covered by the schema
function getOtherSpecs(schema, liveMap) {
  const schemaLabels = new Set(
    (schema?.groups || []).flatMap(g => g.specs.map(s => s.label.toLowerCase()))
  )
  const other = {}
  for (const [retailer, data] of Object.entries(liveMap)) {
    if (data.status !== 'done' || !data.specs) continue
    for (const [label, value] of Object.entries(data.specs)) {
      const ll = label.toLowerCase()
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
  const c = { pending:'#d1d5db', loading:'#f59e0b', done:'#10b981', error:'#ef4444', finding:'#8b5cf6' }
  return <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:c[s]||'#ddd', flexShrink:0 }} />
}

function Spinner({ small }) {
  const sz = small ? 12 : 16
  return <>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    <span style={{ display:'inline-block', width:sz, height:sz, border:`2px solid rgba(255,255,255,.3)`, borderTopColor:'#fff', borderRadius:'50%', animation:'spin .7s linear infinite', flexShrink:0 }} />
  </>
}

export default function Home() {
  const [category, setCategory]   = useState('')
  const [schema, setSchema]       = useState(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaErr, setSchemaErr] = useState('')

  const [phase, setPhase]         = useState('')  // '' | 'finding' | 'scraping' | 'done'
  const [liveMap, setLiveMap]     = useState({})  // retailer -> { url, status, specs, productName, image, title }
  const liveRef = useRef({})

  const [notice, setNotice]       = useState('')
  const [copied, setCopied]       = useState(false)
  const [findErr, setFindErr]     = useState('')

  // ── Generate schema ──────────────────────────────────────────────────────
  async function generateSchema(cat) {
    const c = (cat || category).trim()
    if (!c) { setSchemaErr('Enter a product category.'); return }
    setSchemaErr('')
    setSchema(null)
    setLiveMap({})
    liveRef.current = {}
    setPhase('')
    setSchemaLoading(true)

    try {
      const r = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ category: c }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || 'Generation failed')
      setSchema(d)
    } catch (e) {
      setSchemaErr(e.message || 'Something went wrong.')
    }
    setSchemaLoading(false)
  }

  // ── Find retailers + scrape automatically ────────────────────────────────
  function updateLive(key, patch) {
    liveRef.current[key] = { ...(liveRef.current[key] || {}), ...patch }
    setLiveMap({ ...liveRef.current })
  }

  const [findErr, setFindErr] = useState('')

  async function findAndScrape() {
    const c = category.trim()
    if (!c || !schema) return
    setPhase('finding')
    setFindErr('')
    liveRef.current = {}
    setLiveMap({})

    // Step 1: Serper finds retailer product URLs via site: search
    let retailers = []
    try {
      const r = await fetch('/api/find-retailers', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ category: c }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.detail || d.error || 'Search failed')
      retailers = d.retailers
    } catch (e) {
      setPhase('error')
      setFindErr(e.message || 'Could not find retailers')
      return
    }

    // Init status for each retailer found
    retailers.forEach(({ retailer, url, title, thumbnail }) => {
      updateLive(retailer, { url, title, thumbnail, status:'pending', specs:null, productName:null, image:null })
    })

    setPhase('scraping')

    // Step 2: Scrape each URL concurrently
    await Promise.all(retailers.map(async ({ retailer, url }) => {
      updateLive(retailer, { status:'loading' })
      try {
        const r = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
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
        updateLive(retailer, { status:'error', error: e.message })
      }
    }))

    setPhase('done')
  }

  // ── Copy for Excel ───────────────────────────────────────────────────────
  function copyForExcel() {
    if (!schema) return
    const doneRetailers = Object.entries(liveMap).filter(([,d]) => d.status==='done').map(([r]) => r)
    const rows = [['Category','Spec','Importance','Why It Matters', ...doneRetailers]]

    for (const g of schema.groups) {
      for (const s of g.specs) {
        const vals = doneRetailers.map(r => {
          const m = matchSpec(s, liveMap[r]?.specs)
          return m ? m.value : ''
        })
        rows.push([g.name, s.label, s.importance, s.why, ...vals])
      }
    }

    const other = getOtherSpecs(schema, liveMap)
    if (Object.keys(other).length) {
      rows.push([])
      rows.push(['Other Specs','','','', ...doneRetailers.map(() => '')])
      for (const [label, byRetailer] of Object.entries(other)) {
        rows.push(['', label, '', '', ...doneRetailers.map(r => byRetailer[r] || '')])
      }
    }

    const tsv = rows.map(r => r.map(v => `"${String(v??'').replace(/"/g,'""')}"`).join('\t')).join('\n')
    navigator.clipboard.writeText(tsv).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  // ── Derived ──────────────────────────────────────────────────────────────
  const liveList      = Object.entries(liveMap)
  const doneRetailers = liveList.filter(([,d]) => d.status==='done').map(([r]) => r)
  const allRetailers  = liveList.map(([r]) => r)
  const hasLive       = doneRetailers.length > 0
  const other         = hasLive ? getOtherSpecs(schema, liveMap) : {}
  const totalSpecs    = schema?.groups?.reduce((n,g) => n+g.specs.length, 0) ?? 0
  const isRunning = phase === 'finding' || phase === 'scraping' || schemaLoading

  return (
    <>
      <Head><title>Spec Schema Builder</title></Head>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,sans-serif;background:#f7f8fa;color:#111}input,button{font-family:inherit}`}</style>
      <div style={{ maxWidth:1150, margin:'0 auto', padding:'2.5rem 1rem' }}>

        {/* ── Header ── */}
        <div style={{ marginBottom:'1.75rem' }}>
          <h1 style={{ fontSize:23, fontWeight:700, marginBottom:5 }}>Spec Schema Builder</h1>
          <p style={{ fontSize:14, color:'#6b7280' }}>Enter a category → Claude generates the spec schema → top retailers are found and scraped automatically</p>
        </div>

        {/* ── Step 1: Category input ── */}
        <div style={CARD}>
          <label style={LBL}>Product category</label>
          <div style={{ display:'flex', gap:8, marginBottom:14 }}>
            <input
              value={category}
              onChange={e => { setCategory(e.target.value); setSchemaErr('') }}
              onKeyDown={e => e.key==='Enter' && generateSchema()}
              placeholder="e.g. coffee maker, dishwasher, skis…"
              style={{ ...INP, flex:1 }}
              disabled={isRunning}
            />
            <button
              onClick={() => generateSchema()}
              disabled={isRunning}
              style={{ ...BTN_PRIMARY, opacity: isRunning ? .6 : 1, cursor: isRunning ? 'not-allowed' : 'pointer', display:'flex', alignItems:'center', gap:8, whiteSpace:'nowrap' }}
            >
              {schemaLoading && <Spinner />}
              {schemaLoading ? 'Generating…' : 'Generate schema →'}
            </button>
          </div>

          <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
            {QUICK_PICKS.map(c => (
              <button key={c} disabled={isRunning}
                onClick={() => { setCategory(c); setSchema(null); setSchemaErr(''); generateSchema(c) }}
                style={{ padding:'4px 11px', background:category===c?'#eff6ff':'#f9fafb', border:`1px solid ${category===c?'#bfdbfe':'#e5e7eb'}`, borderRadius:20, fontSize:12, color:category===c?'#1d4ed8':'#6b7280', cursor:isRunning?'not-allowed':'pointer' }}>
                {c}
              </button>
            ))}
          </div>
          {schemaErr && <p style={{ fontSize:13, color:'#ef4444', marginTop:10 }}>{schemaErr}</p>}
        </div>

        {/* ── Step 2: Auto-find retailers (shown after schema ready) ── */}
        {schema && !isRunning && phase === '' && (
          <div style={{ ...CARD, display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
            <div>
              <p style={{ fontSize:14, fontWeight:500, color:'#111' }}>Schema ready — now fetch live specs from top retailers</p>
              <p style={{ fontSize:12, color:'#9ca3af', marginTop:3 }}>SerpApi finds the best product URLs for "{category}", then Zyte extracts specs from each one automatically.</p>
            </div>
            <button
              onClick={findAndScrape}
              style={{ ...BTN_PRIMARY, display:'flex', alignItems:'center', gap:8, whiteSpace:'nowrap' }}
            >
              Find retailers & fetch specs →
            </button>
          </div>
        )}

        {/* ── Progress ── */}
        {(phase === 'finding' || phase === 'error' || (phase === 'scraping' && liveList.length > 0) || phase === 'done') && (
          <div style={CARD}>
            {phase === 'finding' && (
              <div style={{ display:'flex', alignItems:'center', gap:10, color:'#6b7280', fontSize:14 }}>
                <div style={{ width:16, height:16, border:'2px solid #e5e7eb', borderTopColor:'#8b5cf6', borderRadius:'50%', animation:'spin .7s linear infinite', flexShrink:0 }} />
                Searching for "{category}" product pages on top retailers…
              </div>
            )}
            {phase === 'error' && (
              <div>
                <p style={{ fontSize:13, color:'#ef4444', marginBottom:10 }}>
                  Could not find retailer pages: {findErr}
                </p>
                <button onClick={findAndScrape} style={{ ...BTN_PRIMARY, fontSize:13 }}>Try again →</button>
              </div>
            )}
            {liveList.length > 0 && (
              <div style={{ border:'1px solid #e5e7eb', borderRadius:8, overflow:'hidden', marginTop: phase==='finding' ? 12 : 0 }}>
                {liveList.map(([retailer, d]) => (
                  <div key={retailer} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', borderBottom:'1px solid #f3f4f6' }}>
                    <Dot s={d.status} />
                    {d.thumbnail && <img src={d.thumbnail} alt="" style={{ width:28, height:28, objectFit:'contain', borderRadius:4, border:'1px solid #e5e7eb', background:'#fff' }} />}
                    <div style={{ flex:1 }}>
                      <span style={{ fontSize:13, fontWeight:600 }}>{retailer}</span>
                      {d.title && <span style={{ fontSize:11, color:'#9ca3af', marginLeft:8 }}>{d.title.slice(0,60)}{d.title.length>60?'…':''}</span>}
                    </div>
                    <span style={{ fontSize:12, color: d.status==='done'?'#10b981': d.status==='error'?'#ef4444':'#9ca3af' }}>
                      {d.status==='pending' && 'Queued'}
                      {d.status==='loading' && 'Fetching specs… (up to 2 min)'}
                      {d.status==='done'    && `✓ ${d.specCount} specs`}
                      {d.status==='error'   && (d.error || 'Failed')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Results ── */}
        {schema && (
          <div>
            {/* Toolbar */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:8 }}>
              <div>
                <h2 style={{ fontSize:16, fontWeight:600 }}>{schema.category}</h2>
                <p style={{ fontSize:12, color:'#9ca3af', marginTop:2 }}>
                  {totalSpecs} specs · {schema.groups.length} groups
                  {hasLive && ` · Live data from ${doneRetailers.length} retailer${doneRetailers.length!==1?'s':''}`}
                </p>
              </div>
              <button onClick={copyForExcel} style={{ ...BTN_GHOST }}>{copied ? '✓ Copied!' : 'Copy for Excel'}</button>
            </div>

            {/* Retailer product cards */}
            {hasLive && (
              <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
                {doneRetailers.map(r => {
                  const d = liveMap[r]
                  return (
                    <a key={r} href={d.url} target="_blank" rel="noreferrer"
                      style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 12px', background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, textDecoration:'none' }}>
                      {d.image && <img src={d.image} alt="" style={{ width:26, height:26, objectFit:'contain', borderRadius:4, border:'1px solid #e5e7eb', background:'#fff' }} />}
                      <div>
                        <div style={{ fontSize:10, fontWeight:700, color:'#1d4ed8', textTransform:'uppercase', letterSpacing:.4 }}>{r}</div>
                        <div style={{ fontSize:11, color:'#6b7280', maxWidth:180, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{d.productName || d.title}</div>
                      </div>
                    </a>
                  )
                })}
              </div>
            )}

            {/* ── Spec groups (main table) ── */}
            {schema.groups.map((group, gi) => (
              <div key={gi} style={{ background:'#fff', borderRadius:10, border:'1px solid #e5e7eb', marginBottom:10, overflow:'hidden', boxShadow:'0 1px 2px rgba(0,0,0,.04)' }}>

                {/* Group header */}
                <div style={{ padding:'9px 18px', background:'#f8fafc', borderBottom:'1px solid #e5e7eb', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:11.5, fontWeight:700, color:'#1d4ed8', textTransform:'uppercase', letterSpacing:.6 }}>{group.name}</span>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>{group.specs.length} specs</span>
                </div>

                {/* Spec rows */}
                {group.specs.map((spec, si) => {
                  const matches = allRetailers.map(r => matchSpec(spec, liveMap[r]?.specs))
                  return (
                    <div key={si} style={{ display:'flex', alignItems:'flex-start', borderBottom: si < group.specs.length-1 ? '1px solid #f3f4f6' : 'none', background: IMP_BG[spec.importance]||'#fff' }}>

                      {/* Dot */}
                      <div style={{ padding:'14px 8px 14px 18px', flexShrink:0 }}>
                        <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:IMP_COLOR[spec.importance]||'#9ca3af', marginTop:4 }} />
                      </div>

                      {/* Schema info */}
                      <div style={{ flex:'0 0 260px', padding:'11px 14px 11px 6px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:3, flexWrap:'wrap' }}>
                          <span style={{ fontSize:13.5, fontWeight:600, color:'#111' }}>{spec.label}</span>
                          <span style={{ fontSize:9.5, fontWeight:700, color:IMP_COLOR[spec.importance], textTransform:'uppercase', letterSpacing:.3 }}>{spec.importance}</span>
                        </div>
                        <p style={{ fontSize:12, color:'#6b7280', lineHeight:1.5 }}>{spec.why}</p>
                      </div>

                      {/* Retailer value columns */}
                      {allRetailers.map((r, ri) => {
                        const m = matches[ri]
                        const d = liveMap[r]
                        return (
                          <div key={r} style={{ flex:1, padding:'11px 12px', borderLeft:'1px solid #f0f0f0', minWidth:130 }}>
                            {/* Retailer header — only on very first row */}
                            {si === 0 && gi === 0 && (
                              <div style={{ fontSize:9.5, fontWeight:700, color:'#1d4ed8', textTransform:'uppercase', letterSpacing:.4, marginBottom:4 }}>{r}</div>
                            )}
                            {m ? (
                              <>
                                <div style={{ fontSize:10, color:'#9ca3af', marginBottom:2, lineHeight:1.3 }}>{m.label}</div>
                                <div style={{ fontSize:13, color:'#111', fontWeight:500, lineHeight:1.4 }}>{m.value}</div>
                              </>
                            ) : d?.status==='done' ? (
                              <span style={{ color:'#e5e7eb', fontSize:13 }}>—</span>
                            ) : d?.status==='loading' ? (
                              <span style={{ color:'#fcd34d', fontSize:11 }}>…</span>
                            ) : (
                              <span style={{ color:'#f3f4f6', fontSize:13 }}>—</span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            ))}

            {/* ── Other specs ── */}
            {Object.keys(other).length > 0 && (
              <div style={{ background:'#fff', borderRadius:10, border:'1px solid #e5e7eb', overflow:'hidden', marginBottom:10, boxShadow:'0 1px 2px rgba(0,0,0,.04)' }}>
                <div style={{ padding:'9px 18px', background:'#f8fafc', borderBottom:'1px solid #e5e7eb', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:11.5, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:.6 }}>Other specs from retailers</span>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>{Object.keys(other).length} not in schema</span>
                </div>
                {Object.entries(other).map(([label, byRetailer], i, arr) => (
                  <div key={i} style={{ display:'flex', alignItems:'flex-start', borderBottom: i<arr.length-1?'1px solid #f3f4f6':'none' }}>
                    <div style={{ padding:'14px 8px 14px 26px', flexShrink:0 }}>
                      <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:'#d1d5db', marginTop:4 }} />
                    </div>
                    <div style={{ flex:'0 0 260px', padding:'11px 14px 11px 6px' }}>
                      <span style={{ fontSize:13.5, fontWeight:500, color:'#374151' }}>{label}</span>
                      <p style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>From retailer · not in schema</p>
                    </div>
                    {allRetailers.map(r => (
                      <div key={r} style={{ flex:1, padding:'11px 12px', borderLeft:'1px solid #f0f0f0', minWidth:130 }}>
                        {byRetailer[r] ? (
                          <div style={{ fontSize:13, color:'#374151', lineHeight:1.4 }}>{byRetailer[r]}</div>
                        ) : (
                          <span style={{ color:'#f3f4f6', fontSize:13 }}>—</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Legend */}
            {totalSpecs > 0 && (
              <div style={{ display:'flex', gap:20, padding:'10px 14px', background:'#fff', borderRadius:8, border:'1px solid #e5e7eb', flexWrap:'wrap' }}>
                {['high','medium','low'].map(imp => (
                  <div key={imp} style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{ width:7, height:7, borderRadius:'50%', background:IMP_COLOR[imp], display:'inline-block', flexShrink:0 }} />
                    <span style={{ fontSize:12, color:'#6b7280' }}>
                      <strong style={{ color:IMP_COLOR[imp] }}>{imp.charAt(0).toUpperCase()+imp.slice(1)}</strong>
                      {' — '}{imp==='high'?'first thing shoppers check':imp==='medium'?'important secondary spec':'nice to know'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

const CARD       = { background:'#fff', borderRadius:10, border:'1px solid #e5e7eb', padding:'1.5rem', marginBottom:'1.25rem', boxShadow:'0 1px 3px rgba(0,0,0,.05)' }
const LBL        = { fontSize:13, fontWeight:500, color:'#374151', display:'block', marginBottom:8 }
const INP        = { padding:'10px 12px', border:'1px solid #d1d5db', borderRadius:8, fontSize:13.5, color:'#111', outline:'none' }
const BTN_PRIMARY= { padding:'10px 20px', background:'#1d4ed8', color:'#fff', border:'none', borderRadius:8, fontSize:13.5, fontWeight:600, cursor:'pointer' }
const BTN_GHOST  = { padding:'8px 16px', background:'#fff', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, color:'#374151', cursor:'pointer' }
