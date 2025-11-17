const EP_PREFIX = 'twikit:gql:user:'
const EP_TTL_MS = 24 * 60 * 60 * 1000
const GUEST_KEY = 'twikit:guest_token'
const GUEST_TTL_MS = 30 * 60 * 1000

function now(){ return Date.now() }

async function loadEndpoints(domain){
  const key = EP_PREFIX + domain
  const obj = await chrome.storage.local.get(key)
  const rec = obj[key]
  if(rec && rec.map && rec.ts && (now() - rec.ts) < EP_TTL_MS){ return rec.map }
  return null
}

async function saveEndpoints(domain, map){
  const key = EP_PREFIX + domain
  await chrome.storage.local.set({ [key]: { map, ts: now() } })
}

function extract(path){
  const m = path.match(/\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/(UserByScreenName|UserTweets|UserTweetsAndReplies|UserMedia|Likes)/)
  if(!m) return null
  return { id: m[1], name: m[2] }
}

async function discoverViaWebRequest(domain, screenName){
  return new Promise(async (resolve)=>{
    let tabId = null
    let out = {}
    let timer
    const cleanup = async ()=>{
      try{ chrome.webRequest.onCompleted.removeListener(onCompleted) }catch(e){}
      try{ if(tabId != null) await chrome.tabs.remove(tabId) }catch(e){}
      if(timer) clearTimeout(timer)
    }
    const onCompleted = async (details)=>{
      const u = new URL(details.url)
      const ex = extract(u.pathname)
      if(ex){
        const ep = `${u.origin}/i/api/graphql/${ex.id}/${ex.name}`
        out[ex.name] = ep
      }
    }
    const filter = { urls: [
      `https://${domain}/i/api/graphql/*/UserByScreenName*`,
      `https://${domain}/i/api/graphql/*/UserTweets*`,
      `https://${domain}/i/api/graphql/*/UserTweetsAndReplies*`,
      `https://${domain}/i/api/graphql/*/UserMedia*`,
      `https://${domain}/i/api/graphql/*/Likes*`
    ] }
    try{ chrome.webRequest.onCompleted.addListener(onCompleted, filter) }catch(e){}
    try{ const created = await chrome.tabs.create({ url: `https://${domain}/${screenName}`, active: false }); tabId = created.id }catch(e){}
    timer = setTimeout(async ()=>{ await cleanup(); resolve(Object.keys(out).length ? out : null) }, 12000)
  })
}

async function fetchText(url, opts){ const res = await fetch(url, opts || {}); if(!res.ok) throw new Error(String(res.status)); return res.text() }

async function discoverViaScriptScan(domain){
  try{
    const pages = [ `https://${domain}/`, `https://${domain}/home` ]
    const names = ['UserByScreenName','UserTweets','UserTweetsAndReplies','UserMedia','Likes']
    const out = {}
    for(const p of pages){
      const html = await fetchText(p, { credentials: 'include', cache: 'no-cache' })
      const scripts = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/gi)).map(m=>m[1]).filter(u=>/abs\.twimg\.com\/responsive-web\/(client-web|client-web-legacy)\//.test(u))
      for(const s of scripts){
        try{
          const js = await fetchText(s, { credentials: 'omit', cache: 'no-cache' })
          for(const nm of names){
            const m = js.match(new RegExp(`i\\/api\\/graphql\\/([A-Za-z0-9_-]+)\\/${nm}`))
            if(m && m[1]) out[nm] = `https://${domain}/i/api/graphql/${m[1]}/${nm}`
          }
        }catch(e){}
      }
    }
    return Object.keys(out).length ? out : null
  }catch(e){ return null }
}

function defaults(domain){
  return {
    UserByScreenName: `https://${domain}/i/api/graphql/NimuplG1OB7Fd2btCLdBOw/UserByScreenName`,
    UserTweets: `https://${domain}/i/api/graphql/QWF3SzpHmykQHsQMixG0cg/UserTweets`,
    UserTweetsAndReplies: `https://${domain}/i/api/graphql/vMkJyzx1wdmvOeeNG0n6Wg/UserTweetsAndReplies`,
    UserMedia: `https://${domain}/i/api/graphql/2tLOJWwGuCTytDrGBg8VwQ/UserMedia`,
    Likes: `https://${domain}/i/api/graphql/IohM3gxQHfvWePH5E3KuNA/Likes`
  }
}

async function getEndpoints(domain, screenName){
  const cached = await loadEndpoints(domain)
  if(cached) return cached
  const wr = await discoverViaWebRequest(domain, screenName)
  if(wr){ await saveEndpoints(domain, wr); return wr }
  const sc = await discoverViaScriptScan(domain)
  if(sc){ await saveEndpoints(domain, sc); return sc }
  const df = defaults(domain)
  await saveEndpoints(domain, df)
  return df
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg && msg.type === 'twikit-user-get-endpoints'){
    const domain = msg.domain || 'x.com'
    const screenName = msg.screenName || 'home'
    ;(async ()=>{ try{ const ep = await getEndpoints(domain, screenName); sendResponse({ ok: true, endpoints: ep }) }catch(e){ sendResponse({ ok:false, error:String(e && e.message || e) }) } })()
    return true
  }
  if(msg && (msg.type === 'twikit-user-get-guest-token' || msg.type === 'twikit-hashtag-get-guest-token')){
    ;(async ()=>{ try{ const tok = await getGuestToken(); sendResponse({ ok:true, guest_token: tok }) }catch(e){ sendResponse({ ok:false, error:String(e && e.message || e) }) } })()
    return true
  }
})

async function getGuestToken(){
  try{
    const obj = await chrome.storage.local.get(GUEST_KEY)
    const rec = obj[GUEST_KEY]
    if(rec && rec.token && rec.ts && (Date.now() - rec.ts) < GUEST_TTL_MS){ return rec.token }
  }catch(e){}
  const TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  const domain = 'x.com'
  const url = `https://api.${domain}/1.1/guest/activate.json`
  const res = await fetch(url, { method:'POST', headers:{ 'authorization':`Bearer ${TOKEN}`, 'content-type':'application/json', 'accept':'application/json', 'referer':`https://${domain}/` }, body: JSON.stringify({}) })
  if(!res.ok){ const txt = await res.text(); throw new Error(`guest_activate ${res.status} ${txt}`) }
  const json = await res.json()
  const token = json && json.guest_token
  if(!token) throw new Error('no guest_token')
  try{ await chrome.storage.local.set({ [GUEST_KEY]: { token, ts: Date.now() } }) }catch(e){}
  return token
}
