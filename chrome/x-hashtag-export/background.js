// Background service worker for robust GraphQL endpoint discovery
const ENDPOINT_KEY_PREFIX = 'twikit:gql:SearchTimeline:'
const ENDPOINT_TTL_MS = 24 * 60 * 60 * 1000 // 1 day
const GUEST_KEY = 'twikit:guest_token'
const GUEST_TTL_MS = 30 * 60 * 1000 // 30 minutes

function now(){ return Date.now() }

async function loadEndpoint(domain){
  const key = ENDPOINT_KEY_PREFIX + domain
  const obj = await chrome.storage.local.get(key)
  const rec = obj[key]
  if(rec && rec.endpoint && rec.ts && (now() - rec.ts) < ENDPOINT_TTL_MS){
    return rec.endpoint
  }
  return null
}

async function saveEndpoint(domain, endpoint){
  const key = ENDPOINT_KEY_PREFIX + domain
  await chrome.storage.local.set({ [key]: { endpoint, ts: now() } })
}

function extractSearchTimeline(url){
  try{
    const u = new URL(url)
    const m = u.pathname.match(/\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/SearchTimeline/) // eslint-disable-line
    if(m && m[1]) return `${u.origin}/i/api/graphql/${m[1]}/SearchTimeline`
  }catch(e){}
  return null
}

async function discoverViaWebRequest(domain){
  return new Promise(async (resolve) => {
    let tabId = null
    let resolved = false
    const cleanup = async () => {
      try{ chrome.webRequest.onCompleted.removeListener(onCompleted) }catch(e){}
      try{ if(tabId != null) await chrome.tabs.remove(tabId) }catch(e){}
    }
    const onCompleted = async (details) => {
      const ep = extractSearchTimeline(details.url)
      if(ep && !resolved){
        resolved = true
        await saveEndpoint(domain, ep)
        await cleanup()
        resolve(ep)
      }
    }
    const filter = { urls: [
      `https://${domain}/i/api/graphql/*/SearchTimeline*`
    ] }
    try{ chrome.webRequest.onCompleted.addListener(onCompleted, filter) }catch(e){ /* ignore */ }
    try{
      const created = await chrome.tabs.create({ url: `https://${domain}/search?q=a&src=typed_query`, active: false })
      tabId = created.id
    }catch(e){ /* ignore */ }
    setTimeout(async ()=>{
      if(!resolved){
        await cleanup()
        resolve(null)
      }
    }, 12000)
  })
}

async function fetchText(url, opts){
  const res = await fetch(url, opts || {})
  if(!res.ok) throw new Error(String(res.status))
  return res.text()
}

async function discoverViaScriptScan(domain){
  try{
    const pages = [
      `https://${domain}/search?q=a&src=typed_query`,
      `https://${domain}/`
    ]
    for(const p of pages){
      const html = await fetchText(p, { credentials: 'include', cache: 'no-cache' })
      const scripts = Array.from(html.matchAll(/<script[^>]+src="([^\"]+)"/gi)).map(m=>m[1])
        .filter(u=>/abs\.twimg\.com\/responsive-web\/(client-web|client-web-legacy)\//.test(u))
      for(const s of scripts){
        try{
          const js = await fetchText(s, { credentials: 'omit', cache: 'no-cache' })
          const m = js.match(/i\/api\/graphql\/([A-Za-z0-9_-]+)\/SearchTimeline/)
          if(m && m[1]){
            const ep = `https://${domain}/i/api/graphql/${m[1]}/SearchTimeline`
            await saveEndpoint(domain, ep)
            return ep
          }
        }catch(e){ /* continue */ }
      }
    }
  }catch(e){ /* ignore */ }
  return null
}

async function getSearchTimelineEndpoint(domain){
  const cached = await loadEndpoint(domain)
  if(cached) return cached
  const ep1 = await discoverViaWebRequest(domain)
  if(ep1) return ep1
  const ep2 = await discoverViaScriptScan(domain)
  if(ep2) return ep2
  return `https://${domain}/i/api/graphql/flaR-PUMshxFWZWPNpq4zA/SearchTimeline`
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg && msg.type === 'twikit-hashtag-get-endpoint'){
    const domain = msg.domain || 'x.com'
    ;(async ()=>{
      try{
        const ep = await getSearchTimelineEndpoint(domain)
        sendResponse({ ok: true, endpoint: ep })
      }catch(e){ sendResponse({ ok: false, error: String(e && e.message || e) }) }
    })()
    return true
  }
  if(msg && msg.type === 'twikit-hashtag-get-guest-token'){
    ;(async ()=>{
      try{
        const tok = await getGuestToken()
        sendResponse({ ok: true, guest_token: tok })
      }catch(e){ sendResponse({ ok: false, error: String(e && e.message || e) }) }
    })()
    return true
  }
})

async function getGuestToken(){
  try{
    const obj = await chrome.storage.local.get(GUEST_KEY)
    const rec = obj[GUEST_KEY]
    if(rec && rec.token && rec.ts && (Date.now() - rec.ts) < GUEST_TTL_MS){
      return rec.token
    }
  }catch(e){}
  const TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  const domain = 'x.com'
  const url = `https://api.${domain}/1.1/guest/activate.json`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'referer': `https://${domain}/`
    },
    body: JSON.stringify({})
  })
  if(!res.ok){
    const txt = await res.text()
    throw new Error(`guest_activate ${res.status} ${txt}`)
  }
  const json = await res.json()
  const token = json && json.guest_token
  if(!token) throw new Error('no guest_token')
  try{ await chrome.storage.local.set({ [GUEST_KEY]: { token, ts: Date.now() } }) }catch(e){}
  return token
}
