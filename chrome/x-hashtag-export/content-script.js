// Direct search in content script (no page injection) for robustness
console.log('[x-hashtag-export] content script loaded', { url: location.href })
function inferFilenameBase(query, product){
  const ts = new Date().toISOString().replace(/[:.]/g,'-')
  return `${query.replace(/\s+/g,'_')}-${product}-${ts}`
}

function toCSV(rows){
  if(!rows.length) return ''
  const headers = Object.keys(rows[0])
  const escape = (v)=>{ const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s }
  const lines = [headers.join(',')]
  for(const r of rows){ lines.push(headers.map(h=>escape(r[h])).join(',')) }
  return lines.join('\n')
}

// Helpers for direct fetch
function getCt0(){
  const m = document.cookie.match(/(?:^|; )ct0=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}
async function buildHeaders(){
  const lang = document.documentElement.lang || 'en-US'
  const TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Client-Language': lang,
    'Referer': location.origin + '/',
    'Content-Type': 'application/json',
    'Accept-Language': lang
  }
  const ct0 = getCt0()
  if(ct0){
    headers['X-Csrf-Token'] = ct0
    headers['X-Twitter-Auth-Type'] = 'OAuth2Session'
  }else{
    try{
      const resp = await new Promise((resolve)=>{
        try{
          chrome.runtime.sendMessage({ type: 'twikit-hashtag-get-guest-token' }, (r)=> resolve(r))
        }catch(e){ resolve(null) }
      })
      const gt = resp && resp.guest_token
      if(gt){ headers['X-Guest-Token'] = gt }
    }catch(e){}
  }
  headers['X-Client-Transaction-Id'] = 'twikit-' + Date.now().toString(36)
  return headers
}
// use direct console.log for all logs
const progress = (text)=>{ try{ chrome.runtime.sendMessage({ type: 'twikit-export-progress', text }) }catch(e){} }
async function httpGet(url, params){
  const q = params ? '?' + new URLSearchParams(params).toString() : ''
  console.log('[x-hashtag-export]', 'HTTP GET', url, params); progress(`HTTP GET ${url}`)
  const res = await fetch(url + q, { credentials: 'include', cache: 'no-cache', mode: 'cors', headers: await buildHeaders() })
  console.log('[x-hashtag-export]', 'HTTP STATUS', res.status, 'URL', res.url); progress(`HTTP ${res.status} ${res.url}`)
  if(!res.ok){
    const text = await res.text()
    console.log('[x-hashtag-export]', 'HTTP ERROR BODY', text); progress(`HTTP ERROR BODY: ${String(text).slice(0,180)}`)
    throw new Error(text || String(res.status))
  }
  return res.json()
}
async function httpPost(url, body){
  console.log('[x-hashtag-export]', 'HTTP POST', url, body && Object.keys(body)); progress(`HTTP POST ${url}`)
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-cache',
    mode: 'cors',
    headers: await buildHeaders(),
    body: JSON.stringify(body || {})
  })
  console.log('[x-hashtag-export]', 'HTTP STATUS', res.status, 'URL', res.url); progress(`HTTP ${res.status} ${res.url}`)
  if(!res.ok){
    const text = await res.text()
    console.log('[x-hashtag-export]', 'HTTP ERROR BODY', text); progress(`HTTP ERROR BODY: ${String(text).slice(0,180)}`)
    throw new Error(text || String(res.status))
  }
  return res.json()
}
async function gqlGet(url, variables, features, extra){
  const params = { variables: JSON.stringify(variables) }
  if(features) params.features = JSON.stringify(features)
  if(extra) Object.assign(params, extra)
  console.log('[x-hashtag-export]', 'GQL GET', url, variables, features ? 'features:yes' : 'features:no'); progress(`GQL GET ${url} product=${variables?.product}`)
  try{
    return await httpGet(url, params)
  }catch(e){
    const m = url.match(/\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/SearchTimeline/)
    const queryId = m && m[1]
    if(queryId){
      console.log('[x-hashtag-export]', 'GQL fallback POST', url, 'queryId', queryId)
      return await httpPost(url, { variables, features, queryId })
    }
    throw e
  }
}
async function discoverSearchTimelineEndpoint(){
  const DOMAIN = location.hostname.endsWith('twitter.com') ? 'twitter.com' : 'x.com'
  const DEFAULT = `https://${DOMAIN}/i/api/graphql/flaR-PUMshxFWZWPNpq4zA/SearchTimeline`
  try{
    const bgResp = await new Promise((resolve)=>{
      try{
        chrome.runtime.sendMessage({ type: 'twikit-hashtag-get-endpoint', domain: DOMAIN }, (resp)=>{
          resolve(resp)
        })
      }catch(e){ resolve(null) }
    })
    const ep = bgResp && bgResp.endpoint
    if(ep){ console.log('[x-hashtag-export]', 'Endpoint from background', ep); progress(`Endpoint from background: ${ep}`); return ep }
  }catch(e){ /* ignore */ }
  try{
    const pages = [
      `https://${DOMAIN}/search?q=a&src=typed_query`,
      `https://${DOMAIN}/`
    ]
    for(const p of pages){
      console.log('[x-hashtag-export]', 'Discover page', p); progress(`Discover page: ${p}`)
      const res = await fetch(p, { credentials: 'include', cache: 'no-cache' })
      const html = await res.text()
      const scriptUrls = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/gi)).map(m=>m[1]).filter(u=>/abs\.twimg\.com\/responsive-web\/(client-web|client-web-legacy)\//.test(u))
      console.log('[x-hashtag-export]', 'Found client-web scripts', scriptUrls.length); progress(`Found client-web scripts: ${scriptUrls.length}`)
      for(const s of scriptUrls){
        try{
          console.log('[x-hashtag-export]', 'Fetch client script', s); progress(`Fetch client script: ${s.split('/').pop()}`)
          const jsRes = await fetch(s, { credentials: 'omit', cache: 'no-cache', mode: 'cors', referrerPolicy: 'no-referrer' })
          const js = await jsRes.text()
          const m = js.match(/i\/api\/graphql\/([A-Za-z0-9_-]+)\/SearchTimeline/)
          if(m && m[1]){
            const ep = `https://${DOMAIN}/i/api/graphql/${m[1]}/SearchTimeline`
            console.log('[x-hashtag-export]', 'Discovered endpoint', ep); progress(`Discovered endpoint: ${ep}`)
            return ep
          }
        }catch(e){ console.log('[x-hashtag-export]', 'Script fetch failed', s, e && e.message || e); progress(`Script fetch failed: ${e && e.message || e}`) }
      }
    }
  }catch(e){}
  console.log('[x-hashtag-export]', 'Use default endpoint', DEFAULT); progress(`Use default endpoint: ${DEFAULT}`)
  return DEFAULT
}
function deepFind(obj, key){
  if(!obj) return []
  const out = []
  if(typeof obj === 'object'){
    if(Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key])
    for(const k in obj){ const v = obj[k]; if(v && typeof v === 'object') out.push(...deepFind(v, key)) }
  }
  return out
}
function extractTweetFromItem(item){
  try{
    const base = deepFind(item, 'itemContent')[0] || deepFind(item, 'content')[0]
    const result = deepFind(base, 'tweet_results')[0]?.result || deepFind(base, 'result')[0]
    const legacy = result?.legacy
    const userResult = result?.core?.user_results?.result
    if(!legacy || !userResult) return null
    const entities = legacy.entities || {}
    const hashtags = Array.isArray(entities.hashtags) ? entities.hashtags.map(h=>h.text) : []
    const urls = Array.isArray(entities.urls) ? entities.urls.map(u=>u.expanded_url || u.url).filter(Boolean) : []
    const media = legacy.extended_entities?.media || legacy.entities?.media || []
    const mediaUrls = media.map(m=>m.media_url_https || m.url).filter(Boolean)
    return {
      id: result.rest_id,
      created_at: legacy.created_at,
      screen_name: userResult?.legacy?.screen_name,
      name: userResult?.legacy?.name,
      lang: legacy.lang,
      text: legacy.full_text || legacy.text || '',
      reply_count: legacy.reply_count || 0,
      favorite_count: legacy.favorite_count || 0,
      retweet_count: legacy.retweet_count || 0,
      quote_count: legacy.quote_count || 0,
      hashtags, urls, media_urls: mediaUrls
    }
  }catch(e){ return null }
}
const FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  rweb_video_timestamps_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  premium_content_api_read_enabled: false,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  payments_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  articles_preview_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: false,
  responsive_web_profile_redirect_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  rweb_video_screen_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_analysis_button_from_backend: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true
}
async function directSearchTweets(query, product, maxCount){
  const SEARCH = await discoverSearchTimelineEndpoint()
  console.log('[x-hashtag-export]', 'Search start', { query, product, maxCount, endpoint: SEARCH }); progress(`Search start: product=${product} endpoint=${SEARCH}`)
  let cursor = null
  const tweets = []
  while(tweets.length < maxCount){
    const variables = { rawQuery: query, count: 20, querySource: 'typed_query', product }
    if(cursor) variables.cursor = cursor
    let json
    try{
      json = await gqlGet(SEARCH, variables, FEATURES)
    }catch(e){
      if(product !== 'Latest'){
        console.log('[x-hashtag-export]', 'Fallback to Latest due to error', e && e.message || e); progress(`Fallback to Latest: ${e && e.message || e}`)
        product = 'Latest'
        try{
          json = await gqlGet(SEARCH, { ...variables, product }, FEATURES)
        }catch(e2){
          console.log('[x-hashtag-export]', 'Re-discover endpoint due to error', e2 && e2.message || e2)
          const NEW_SEARCH = await discoverSearchTimelineEndpoint()
          console.log('[x-hashtag-export]', 'Retry with new endpoint', NEW_SEARCH)
          json = await gqlGet(NEW_SEARCH, { ...variables, product }, FEATURES)
        }
      }else{
        console.log('[x-hashtag-export]', 'Re-discover endpoint due to error', e && e.message || e)
        const NEW_SEARCH = await discoverSearchTimelineEndpoint()
        console.log('[x-hashtag-export]', 'Retry with new endpoint', NEW_SEARCH)
        json = await gqlGet(NEW_SEARCH, { ...variables, product }, FEATURES)
      }
    }
    const instructions = deepFind(json, 'instructions')[0]
    if(!instructions) break
    let items = []
    if(product === 'Media' && cursor){
      const mods = deepFind(instructions, 'moduleItems')
      if(mods && mods.length) items = mods[0]
    }else{
      const entries = deepFind(instructions, 'entries')
      if(entries && entries.length) items = entries[0]
      if(product === 'Media'){
        if(items && items[0] && items[0].content && items[0].content.items){ items = items[0].content.items } else { items = [] }
      }
    }
    let nextCursor = null
    for(const item of items){
      const id = item.entryId || item.entry?.entryId
      if(id && id.startsWith('cursor-bottom')) nextCursor = (item.content && item.content.value) || null
      const isTweet = id && (id.startsWith('tweet') || id.startsWith('search-grid'))
      if(!isTweet) continue
      const t = extractTweetFromItem(item)
      if(t){ tweets.push(t); if(tweets.length >= maxCount) break }
    }
    console.log('[x-hashtag-export]', 'Page fetched', { count: tweets.length, nextCursor }); progress(`Page fetched: count=${tweets.length} next=${nextCursor || 'none'}`)
    chrome.runtime.sendMessage({ type: 'twikit-export-progress', text: `Fetched ${tweets.length}/${maxCount} tweets` })
    if(!nextCursor || tweets.length >= maxCount) break
    cursor = nextCursor
  }
  console.log('[x-hashtag-export]', 'Search finished', { total: tweets.length }); progress(`Search finished: total=${tweets.length}`)
  return tweets
}

chrome.runtime.onMessage.addListener(async (req, sender, sendResponse)=>{
  if(req && req.cmd === 'twikit-ping'){ sendResponse({ ok: true }); return true }
  if(req && req.cmd === 'twikit-hashtag-start'){
    console.log('[x-hashtag-export]', 'Received start command', req)
    try{
      const result = await directSearchTweets(req.query, req.product, Math.max(1, parseInt(req.maxCount || 1000, 10)))
      const rows = result.map(t => ({
        id: t.id,
        created_at: t.created_at,
        screen_name: t.screen_name,
        name: t.name,
        lang: t.lang,
        text: t.text,
        reply_count: t.reply_count,
        favorite_count: t.favorite_count,
        retweet_count: t.retweet_count,
        quote_count: t.quote_count,
        hashtags: Array.isArray(t.hashtags) ? t.hashtags.join('|') : '',
        urls: Array.isArray(t.urls) ? t.urls.join('|') : '',
        media_urls: Array.isArray(t.media_urls) ? t.media_urls.join('|') : ''
      }))
      const filename = `${inferFilenameBase(req.query, req.product)}.${req.format === 'json' ? 'json' : 'csv'}`
      chrome.runtime.sendMessage({ type: 'twikit-export-data', rows, filename, format: req.format })
    }catch(e){
      chrome.runtime.sendMessage({ type: 'twikit-export-progress', text: String(e && e.message || e) })
      console.log('[x-hashtag-export]', 'Search error', e && e.message || e)
    }
  }
})
