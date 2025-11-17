const q = (id) => document.getElementById(id)
const statusEl = q('status')

function setStatus(text){ statusEl.textContent = text }

async function getActiveTab(){
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true})
  return tab
}

async function ensureContentScript(tab){
  try{
    await chrome.tabs.sendMessage(tab.id, { cmd: 'twikit-ping' })
  }catch(e){
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-script.js'] })
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg && msg.type === 'twikit-export-progress'){
    setStatus(msg.text)
  }
  if(msg && msg.type === 'twikit-export-data'){
    const { rows, filename, format } = msg
    try{
      const blob = new Blob([
        format === 'json' ? JSON.stringify(rows, null, 2) : toCSV(rows)
      ], { type: format === 'json' ? 'application/json' : 'text/csv' })
      const url = URL.createObjectURL(blob)
      chrome.downloads.download({ url, filename }, (downloadId)=>{
        if(chrome.runtime.lastError){
          setStatus(`Download failed: ${chrome.runtime.lastError.message}`)
        }else{
          setStatus(`Downloaded: ${filename}`)
        }
      })
    }catch(e){
      setStatus(`Download failed: ${String(e && e.message || e)}`)
    }
  }
})

q('start').addEventListener('click', async ()=>{
  const tab = await getActiveTab()
  if(!tab || !/^https:\/\/(www\.|mobile\.)?(x|twitter)\.com\//.test(tab.url || '')){
    setStatus('Please open x.com or twitter.com and navigate to the target page')
    return
  }
  const query = q('query').value.trim()
  const product = q('product').value
  const format = q('format').value
  const maxCount = Math.max(1, parseInt(q('maxCount').value || '1000', 10))
  if(!query){ setStatus('Please enter a hashtag or query'); return }
  setStatus('Starting...')
  try{
    await ensureContentScript(tab)
    await chrome.tabs.sendMessage(tab.id, {
      cmd: 'twikit-hashtag-start',
      query,
      product,
      format,
      maxCount
    })
  }catch(e){
    setStatus(`Failed to send message: ${e.message || e}`)
  }
})

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
