import { useState, useRef } from 'react'
import Head from 'next/head'

// ── Helpers ──────────────────────────────────────────────────────────────────
function retailerName(url) {
  try {
    const h = new URL(url).hostname.replace('www.','').split('.')[0]
    return h.charAt(0).toUpperCase() + h.slice(1)
  } catch { return url.slice(0,20) }
}

function matchLiveSpec(spec, liveSpecs) {
  if (!liveSpecs) return null
  const keys = Object.keys(liveSpecs)
  // 1. Exact match on concept
  if (liveSpecs[spec.concept]) return { label: spec.concept, value: liveSpecs[spec.concept] }
  // 2. Known retailer label
  const kl = spec.retailerLabels
  for (const [, label] of Object.entries(kl || {})) {
    if (label && liveSpecs[label]) return { label, value: liveSpecs[label] }
  }
  // 3. Case-insensitive substring match
  const cl = spec.concept.toLowerCase()
  for (const k of keys) {
    if (k.toLowerCase().includes(cl) || cl.includes(k.toLowerCase())) {
      return { label: k, value: liveSpecs[k] }
    }
  }
  return null
}

function toCSV(specGroups, liveData, retailers) {
  const rows = [['Group','Spec','Recommended Label','Importance',
    ...retailers.map(r=>`${r} Label`),...retailers.map(r=>`${r} Value`)]]
  for (const g of specGroups) {
    for (const s of g.specs) {
      const matches = retailers.map(r => matchLiveSpec(s, liveData[r]?.specs))
      rows.push([
        g.group, s.concept, s.recommendedLabel, s.importance,
        ...matches.map(m => m?.label || s.retailerLabels?.[retailers[matches.indexOf(m)]] || '—'),
        ...matches.map(m => m?.value || '—'),
      ])
    }
  }
  return rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n')
}

const IMP = { high:'#dc2626', medium:'#d97706', low:'#9ca3af' }

// ── Components ───────────────────────────────────────────────────────────────
function Dot({ s }) {
  const c = { pending:'#d1d5db',loading:'#f59e0b',done:'#10b981',error:'#ef4444' }
  return <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:c[s]||'#ddd', flexShrink:0 }} />
}

function Spin() {
  return <>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    <span style={{ display:'inline-block', width:16, height:16, border:'2px solid #e5e7eb', borderTopColor:'#3b82f6', borderRadius:'50%', animation:'spin .7s linear infinite', flexShrink:0 }} />
  </>
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [step, setStep]         = useState(1)
  const [category, setCategory] = useState('')
  const [urls, setUrls]         = useState(['','',''])
  const [inputErr, setInputErr] = useState('')
  const [schema, setSchema]     = useState(null)   // { specGroups }
  const [schemaErr, setSchemaErr] = useState(null)
  const [live, setLive]         = useState({})     // retailer -> { status, specs, productName, image, error }
  const [phase, setPhase]       = useState('')     // 'schema'|'scraping'|'done'
  const [csvCopied, setCsvCopied] = useState(false)
  const [jsonCopied, setJsonCopied] = useState(false)
  const liveRef = useRef({})

  const validUrls = urls.map(u=>u.trim()).filter(Boolean)
  const retailers = validUrls.map(retailerName)

  function setUrl(i, v) { setUrls(p => p.map((x,j) => j===i ? v : x)) }
  function addUrl() { setUrls(p => [...p,'']) }
  function delUrl(i) { setUrls(p => p.filter((_,j) => j!==i)) }

  function updateLive(retailer, patch) {
    liveRef.current[retailer] = { ...(liveRef.current[retailer]||{}), ...patch }
    setLive({...liveRef.current})
  }

  async function run() {
    if (!category.trim()) { setInputErr('Enter a product category.'); return }
    if (validUrls.length < 1) { setInputErr('Add at least 1 URL.'); return }
    setInputErr('')
    setSchema(null)
    setSchemaErr(null)
    liveRef.current = {}
    setLive({})

    // Init live status
    validUrls.forEach((url, i) => {
      updateLive(retailers[i], { url, status:'pending', specs:null, productName:null, image:null, error:null })
    })

    setStep(2)
    setPhase('schema')

    // PHASE 1: Generate schema from Claude knowledge (parallel with scraping)
    const schemaPromise = fetch('/api/generate-schema', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ category, retailers }),
    }).then(r=>r.json()).then(d => {
      if (d.specGroups?.length) setSchema(d)
      else setSchemaErr('Could not generate schema')
    }).catch(() => setSchemaErr('Schema generation failed'))

    // PHASE 2: Scrape live data concurrently
    setPhase('scraping')

    const scrapePromises = validUrls.map(async (url, i) => {
      const retailer = retailers[i]
      updateLive(retailer, { status:'loading' })
      try {
        const r = await fetch('/api/scrape', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ url }),
        })
        let d
        try { d = await r.json() } catch { throw new Error(`Server error (HTTP ${r.status})`) }
        if (!r.ok || d.error) throw new Error(d.error || 'Fetch failed')
        updateLive(retailer, {
          status:'done',
          specs: d.specs,
          productName: d.productName,
          image: d.image,
          specCount: Object.keys(d.specs||{}).length,
        })
      } catch(e) {
        updateLive(retailer, { status:'error', error: e.message })
      }
    })

    await Promise.all([schemaPromise, ...scrapePromises])
    setPhase('done')
    setStep(3)
  }

  function reset() {
    setStep(1); setCategory(''); setUrls(['','',''])
    setSchema(null); setSchemaErr(null)
    liveRef.current = {}; setLive({})
    setInputErr(''); setPhase('')
    setCsvCopied(false); setJsonCopied(false)
  }

  function copyCSV() {
    if (!schema) return
    navigator.clipboard.writeText(toCSV(schema.specGroups, live, retailers))
      .then(()=>{ setCsvCopied(true); setTimeout(()=>setCsvCopied(false),1500) })
  }

  function downloadCSV() {
    if (!schema) return
    const blob = new Blob([toCSV(schema.specGroups, live, retailers)], {type:'text/csv'})
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${category.replace(/\s+/g,'_')}_specs.csv`
    a.click()
  }

  function copyJSON() {
    if (!schema) return
    const j = JSON.stringify({
      category,
      specFields: schema.specGroups.flatMap(g =>
        g.specs.map(s => ({
          key: s.recommendedLabel.toLowerCase().replace(/[^a-z0-9]+/g,'_'),
          label: s.recommendedLabel,
          group: g.group,
          importance: s.importance,
        }))
      ),
    }, null, 2)
    navigator.clipboard.writeText(j)
      .then(()=>{ setJsonCopied(true); setTimeout(()=>setJsonCopied(false),1500) })
  }

  const liveList = Object.entries(live)
  const successCount = liveList.filter(([,d])=>d.status==='done').length

  return (
    <>
      <Head><title>Spec Matrix Builder</title></Head>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,sans-serif;background:#f7f8fa;color:#111}input,button{font-family:inherit}a{color:#3b82f6}`}</style>
      <div style={{minHeight:'100vh',padding:'2rem 1rem'}}>
        <div style={{maxWidth:1350,margin:'0 auto'}}>

          <div style={{marginBottom:'1.5rem'}}>
            <h1 style={{fontSize:21,fontWeight:700}}>Spec Matrix Builder</h1>
            <p style={{fontSize:13,color:'#6b7280',marginTop:3}}>
              Claude generates the spec schema from knowledge → live retailer data verifies it automatically
            </p>
          </div>

          <div style={{background:'#fff',borderRadius:12,border:'1px solid #e5e7eb',padding:'1.75rem',boxShadow:'0 1px 3px rgba(0,0,0,.05)'}}>

            {/* ── STEP 1: Input ── */}
            {step === 1 && (
              <div>
                <div style={{marginBottom:18}}>
                  <label style={LBL}>Product category</label>
                  <input
                    value={category}
                    onChange={e=>setCategory(e.target.value)}
                    onKeyDown={e=>e.key==='Enter'&&run()}
                    placeholder="e.g. coffee maker, dishwasher, skis, golf clubs…"
                    style={{...INP, width:'100%'}}
                  />
                </div>

                <div>
                  <label style={LBL}>One product page URL per retailer (same or similar product on each site)</label>
                  {urls.map((v,i)=>(
                    <div key={i} style={{display:'flex',gap:8,marginBottom:8}}>
                      <input
                        type="url" value={v}
                        onChange={e=>setUrl(i,e.target.value)}
                        placeholder="https://…"
                        style={{...INP,flex:1}}
                      />
                      {urls.length > 1 && <button onClick={()=>delUrl(i)} style={GHOST}>✕</button>}
                    </div>
                  ))}
                  <button onClick={addUrl} style={{...GHOST,marginTop:4}}>+ Add retailer</button>
                </div>

                <p style={{fontSize:12,color:'#9ca3af',margin:'14px 0',lineHeight:1.6}}>
                  Claude instantly generates a complete spec schema for the category, then automatically pulls
                  live specs from each URL to verify. If a site blocks scraping, Claude's schema still shows.
                  Tracking parameters in URLs are cleaned automatically.
                </p>

                {inputErr && <p style={{fontSize:13,color:'#ef4444',marginBottom:10}}>{inputErr}</p>}
                <button onClick={run} style={PRIMARY}>Build spec matrix →</button>
              </div>
            )}

            {/* ── STEP 2: Progress ── */}
            {step === 2 && (
              <div>
                {/* Schema phase */}
                <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderBottom:'1px solid #f3f4f6',marginBottom:12}}>
                  {phase === 'schema' ? <Spin/> : schema ? <Dot s="done"/> : <Dot s="error"/>}
                  <span style={{fontSize:13,fontWeight:500}}>
                    {phase === 'schema'
                      ? `Generating spec schema for "${category}"…`
                      : schema
                        ? `✓ Spec schema ready (${schema.specGroups?.reduce((n,g)=>n+g.specs.length,0)} specs in ${schema.specGroups?.length} groups)`
                        : `Schema generation ${schemaErr || 'failed'}`
                    }
                  </span>
                </div>

                {/* Scraping phase */}
                <p style={{fontSize:13,fontWeight:500,color:'#374151',marginBottom:8}}>
                  Fetching live data from retailers (up to 2 min each)…
                </p>
                <div style={{border:'1px solid #e5e7eb',borderRadius:8,overflow:'hidden'}}>
                  {liveList.map(([retailer, d])=>(
                    <div key={retailer} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 14px',borderBottom:'1px solid #f3f4f6'}}>
                      <Dot s={d.status}/>
                      <span style={{minWidth:110,fontSize:13,fontWeight:500}}>{retailer}</span>
                      <span style={{fontSize:12,color:d.status==='done'?'#10b981':d.status==='error'?'#ef4444':'#9ca3af'}}>
                        {d.status==='pending'  && 'Waiting…'}
                        {d.status==='loading'  && 'Fetching…'}
                        {d.status==='done'     && `✓ ${d.specCount} specs — ${d.productName}`}
                        {d.status==='error'    && (d.error||'Failed')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── STEP 3: Results ── */}
            {step === 3 && (
              <div>
                {/* Header */}
                <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:8}}>
                  <div>
                    <h2 style={{fontSize:15,fontWeight:600}}>{category} — spec matrix</h2>
                    <p style={{fontSize:12,color:'#9ca3af',marginTop:2}}>
                      {schema ? `${schema.specGroups?.reduce((n,g)=>n+g.specs.length,0)} specs from Claude schema` : 'Schema unavailable'}
                      {' · '}Live data from {successCount}/{liveList.length} retailers
                    </p>
                  </div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    <button onClick={downloadCSV} style={GHOST} disabled={!schema}>⬇ CSV</button>
                    <button onClick={copyCSV}  style={GHOST} disabled={!schema}>{csvCopied  ? 'Copied!':'Copy for Excel'}</button>
                    <button onClick={copyJSON} style={GHOST} disabled={!schema}>{jsonCopied ? 'Copied!':'Copy JSON'}</button>
                    <button onClick={reset}    style={GHOST}>Start over</button>
                  </div>
                </div>

                {/* No schema fallback */}
                {!schema && (
                  <div style={{background:'#fef2f2',border:'1px solid #fecaca',borderRadius:7,padding:'12px 14px',marginBottom:14,fontSize:13,color:'#991b1b'}}>
                    Schema generation failed: {schemaErr}. Try again or check your Anthropic API key.
                  </div>
                )}

                {/* Failed retailers */}
                {liveList.some(([,d])=>d.status==='error') && (
                  <div style={{background:'#fef9c3',border:'1px solid #fde68a',borderRadius:7,padding:'8px 12px',marginBottom:12,fontSize:12,color:'#854d0e'}}>
                    Could not fetch live data from:{' '}
                    {liveList.filter(([,d])=>d.status==='error').map(([r,d])=>`${r} (${d.error})`).join(' · ')}.
                    Claude's schema is shown for these columns.
                  </div>
                )}

                {/* Table */}
                {schema && (
                  <div style={{overflowX:'auto',border:'1px solid #e5e7eb',borderRadius:10}}>
                    <table style={{borderCollapse:'collapse',fontSize:12.5,width:'100%'}}>
                      <thead>
                        <tr>
                          {/* Sticky spec name column */}
                          <th style={{...TH,position:'sticky',left:0,zIndex:2,minWidth:160,background:'#f1f5f9',color:'#475569'}}>Spec</th>

                          {/* One column per retailer */}
                          {retailers.map(r => {
                            const d = live[r]
                            return (
                              <th key={r} style={{...TH,minWidth:175,verticalAlign:'top',whiteSpace:'normal'}}>
                                <div style={{fontWeight:700,color:'#1d4ed8',textTransform:'uppercase',fontSize:10.5,letterSpacing:.4,marginBottom:3}}>{r}</div>
                                {d?.image && <img src={d.image} alt="" style={{width:34,height:34,objectFit:'contain',border:'1px solid #e5e7eb',borderRadius:5,background:'#fff',marginBottom:4,display:'block'}}/>}
                                {d?.productName && d.productName !== 'Unknown product' && (
                                  <div style={{fontSize:10.5,fontWeight:500,color:'#374151',lineHeight:1.3,marginBottom:3}}>{d.productName}</div>
                                )}
                                {d?.url && <a href={d.url} target="_blank" rel="noreferrer" style={{fontSize:10,textDecoration:'none'}}>View page ↗</a>}
                                {d?.status==='error' && <div style={{fontSize:10,color:'#ef4444',marginTop:2}}>Live data unavailable</div>}
                              </th>
                            )
                          })}

                          {/* Recommended column */}
                          <th style={{...TH,minWidth:175,background:'#eff6ff',color:'#1e40af'}}>✓ Recommended</th>
                        </tr>
                      </thead>
                      <tbody>
                        {schema.specGroups.map((g, gi) => (
                          <>
                            {/* Group header */}
                            <tr key={`gh${gi}`}>
                              <td colSpan={retailers.length + 2} style={{
                                padding:'7px 12px',
                                background:'#f8fafc',
                                borderBottom:'1px solid #e2e8f0',
                                fontSize:11,fontWeight:700,
                                color:'#1d4ed8',
                                textTransform:'uppercase',
                                letterSpacing:.5,
                              }}>
                                {g.group}
                              </td>
                            </tr>

                            {/* Spec rows */}
                            {g.specs.map((spec, si) => {
                              const bg = si%2===0?'#fff':'#f9fafb'
                              // Find best live value for recommended column
                              let bestMatch = null
                              for (const r of retailers) {
                                const m = matchLiveSpec(spec, live[r]?.specs)
                                if (m && (!bestMatch || m.value.length > bestMatch.value.length)) bestMatch = m
                              }

                              return (
                                <tr key={`${gi}-${si}`} style={{background:bg}}>
                                  {/* Spec name */}
                                  <td style={{...TD,fontWeight:600,position:'sticky',left:0,background:bg,zIndex:1,color:'#374151'}}>
                                    <div>{spec.concept}</div>
                                    <span style={{fontSize:9.5,color:IMP[spec.importance]||'#9ca3af',fontWeight:700,textTransform:'uppercase'}}>{spec.importance}</span>
                                  </td>

                                  {/* Per-retailer columns */}
                                  {retailers.map(r => {
                                    const d = live[r]
                                    const match = matchLiveSpec(spec, d?.specs)
                                    const expectedLabel = spec.retailerLabels?.[r]
                                    return (
                                      <td key={r} style={TD}>
                                        {match ? (
                                          <>
                                            <span style={{fontSize:10,color:'#9ca3af',display:'block',marginBottom:1}}>{match.label}</span>
                                            <span style={{color:'#111'}}>{match.value}</span>
                                          </>
                                        ) : d?.status==='done' ? (
                                          <span style={{color:'#d1d5db'}}>—</span>
                                        ) : d?.status==='error' ? (
                                          expectedLabel
                                            ? <span style={{fontSize:11,color:'#c4b5fd',fontStyle:'italic'}} title="Expected label (live data unavailable)">{expectedLabel}</span>
                                            : <span style={{color:'#d1d5db'}}>—</span>
                                        ) : (
                                          <span style={{color:'#d1d5db'}}>—</span>
                                        )}
                                      </td>
                                    )
                                  })}

                                  {/* Recommended */}
                                  <td style={{...TD,background:'#eff6ff'}}>
                                    {bestMatch ? (
                                      <>
                                        <span style={{fontSize:10,color:'#3b82f6',display:'block',marginBottom:1}}>{spec.recommendedLabel}</span>
                                        <span style={{color:'#1e40af',fontWeight:600}}>{bestMatch.value}</span>
                                      </>
                                    ) : (
                                      <span style={{fontSize:11,color:'#bfdbfe',fontStyle:'italic'}}>{spec.recommendedLabel}</span>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p style={{fontSize:11.5,color:'#9ca3af',marginTop:10,lineHeight:1.6}}>
                  Schema from Claude's knowledge · Live values extracted verbatim from retailer pages · Blank = not found · Purple italic = expected label (live data unavailable)
                </p>
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  )
}

const LBL = { fontSize:13,fontWeight:500,color:'#374151',display:'block',marginBottom:7 }
const INP = { padding:'9px 11px',border:'1px solid #d1d5db',borderRadius:7,fontSize:13,color:'#111',background:'#fff',outline:'none' }
const PRIMARY = { padding:'10px 20px',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:7,fontSize:13.5,fontWeight:500,cursor:'pointer' }
const GHOST = { padding:'6px 13px',background:'#fff',border:'1px solid #e5e7eb',borderRadius:7,fontSize:12.5,color:'#374151',cursor:'pointer' }
const TH = { textAlign:'left',padding:'10px 12px',borderBottom:'1.5px solid #e5e7eb',fontSize:11,color:'#6b7280',fontWeight:600,background:'#f9fafb' }
const TD = { padding:'9px 12px',borderBottom:'1px solid #f3f4f6',verticalAlign:'top',fontSize:12.5,lineHeight:1.4,wordBreak:'break-word',maxWidth:175 }
