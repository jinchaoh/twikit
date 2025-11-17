let injected = false
let ready = false
let readyResolvers = []
let startRequested = false
let postedOnReady = false
let lastPayload = null

function injectPageExporter(){
  if(injected) return
  const s = document.createElement('script')
  s.src = chrome.runtime.getURL('page-exporter.js')
  s.onload = () => { s.remove(); injected = true }
  (document.head || document.documentElement).appendChild(s)
}

function waitForReady(){
  if(ready) return Promise.resolve()
  return new Promise((resolve)=>{
    readyResolvers.push(resolve)
  })
}

async function ensureInjectedReady(timeoutMs = 3000){
  injectPageExporter()
  let timeoutId
  const timeout = new Promise((resolve)=>{
    timeoutId = setTimeout(resolve, timeoutMs)
  })
  try{
    await Promise.race([waitForReady(), timeout])
  }finally{
    if(timeoutId) clearTimeout(timeoutId)
  }
}

function inferScreenNameFromLocation(){
  const path = location.pathname.split('/').filter(Boolean)
  if(path.length >= 1){
    const name = path[0]
    if(!['home','explore','notifications','messages','i'].includes(name)) return name
  }
  return null
}

function toCSV(rows){
  if(!rows.length) return ''
  const headers = Object.keys(rows[0])
  const escape = (v)=>{
    const s = v == null ? '' : String(v)
    if(/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"'
    return s
  }
  const lines = [headers.join(',')]
  for(const r of rows){
    lines.push(headers.map(h=>escape(r[h])).join(','))
  }
  return lines.join('\n')
}

// Delegate downloading to the extension popup (content scripts have limited API access)
async function sendDataToPopup(rows, filename, format){
  try{
    chrome.runtime.sendMessage({ type: 'twikit-export-data', rows, filename, format })
  }catch(e){
    try{
      const blob = new Blob([
        format === 'json' ? JSON.stringify(rows, null, 2) : toCSV(rows)
      ], { type: format === 'json' ? 'application/json' : 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url) }, 0)
    }catch(ex){}
  }
}

function buildFilename(screenName, type, mode, format){
  const ts = new Date().toISOString().replace(/[:.]/g,'-')
  const ext = format === 'json' ? 'json' : 'csv'
  return `${screenName || 'profile'}-${type}-${mode}-${ts}.${ext}`
}

window.addEventListener('message', async (event)=>{
  const msg = event.data
  if(!msg || msg.source !== 'twikit-exporter') return
  if(msg.type === 'ready'){
    ready = true
    for(const r of readyResolvers){ try{ r() }catch(e){} }
    readyResolvers = []
    if(startRequested && !postedOnReady){
      // Re-post start to ensure the page script receives it
      window.postMessage({ type: 'twikit-export-start', payload: lastPayload }, '*')
      postedOnReady = true
    }
    return
  }
  if(msg.type === 'progress'){
    chrome.runtime.sendMessage({ type: 'twikit-export-progress', text: msg.text })
  }
  if(msg.type === 'result'){
    const { screenName, type, mode, format, result } = msg.payload
    let rows
    if(mode === 'ids'){
      rows = result.map(id => ({ id }))
    }else{
      rows = result
    }
    const filename = buildFilename(screenName, type, mode, format)
    await sendDataToPopup(rows, filename, format)
  }
})

chrome.runtime.onMessage.addListener(async (req, sender, sendResponse)=>{
  if(req && req.cmd === 'twikit-ping'){
    sendResponse({ ok: true })
    return true
  }
  if(req && req.cmd === 'twikit-export-start'){
    // Ensure the exporter is injected; if the ready handshake fails, continue after a small timeout
    await ensureInjectedReady()
    const screenName = req.screenName || inferScreenNameFromLocation()
    const payload = { screenName, type: req.type, mode: req.mode, format: req.format, maxCount: req.maxCount }
    window.postMessage({ type: 'twikit-export-start', payload }, '*')
    startRequested = true
    postedOnReady = false
    lastPayload = payload
  }
})
