const q = (id) => document.getElementById(id)
const statusEl = q('status')
const barEl = q('bar')

function setStatus(text){ statusEl.textContent = text }

function setProgress(percent){ if(barEl) barEl.style.width = Math.max(0, Math.min(100, percent)) + '%' }

function updateProgress(text){
  const m = text && text.match(/Fetched\s+(\d+)\/(\d+)/i)
  if(m){
    const cur = parseInt(m[1], 10)
    const tot = parseInt(m[2], 10)
    const pct = tot > 0 ? Math.round((cur / tot) * 100) : 0
    setProgress(pct)
  }
}

async function getActiveTab(){
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true})
  return tab
}

async function ensureContentScript(tab){
  try{
    await chrome.tabs.sendMessage(tab.id, { cmd: 'twikit-ping' })
  }catch(e){
    try{
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-script.js'] })
    }catch(ex){
      setStatus(`Unable to inject content script: ${ex.message || ex}`)
      throw ex
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg && msg.type === 'twikit-export-progress'){
    const txt = msg.text || ''
    if(/Fetched\s+\d+\/\d+/i.test(txt)){
      setStatus(txt)
      updateProgress(txt)
    } // Ignore non-Fetched progress messages for status and progress bar
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
          setProgress(100)
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
    setStatus('Please open x.com or twitter.com and navigate to the target user profile page')
    return
  }
  const screenName = q('useCurrent').checked ? null : q('screenName').value.trim()
  const type = q('type').value
  const mode = q('mode').value
  const format = q('format').value
  const maxCountInput = q('maxCount').value
  const maxCount = Math.max(1, parseInt(maxCountInput || '1000', 10))
  setStatus(`Fetched 0/${maxCount} ${mode === 'ids' ? 'IDs' : 'users'}`)
  setProgress(0)
  try{
    await ensureContentScript(tab)
    await chrome.tabs.sendMessage(tab.id, {
      cmd: 'twikit-export-start',
      screenName,
      type,
      mode,
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

// Disable input when using current tab profile
function syncUserNameInput(){
  const use = q('useCurrent').checked
  q('screenName').disabled = use
  if(use){ q('screenName').placeholder = 'Using current tab profile' }
  else{ q('screenName').placeholder = 'e.g. elonmusk' }
}
document.addEventListener('DOMContentLoaded', syncUserNameInput)
q('useCurrent').addEventListener('change', syncUserNameInput)
