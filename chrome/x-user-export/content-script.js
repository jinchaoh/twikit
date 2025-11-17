console.log('[x-user-export] content script loaded', { url: location.href })

function wait(ms){ return new Promise(r=>setTimeout(r, ms)) }
const pacer = { delay: 1200, jitter: 400, last: 0, async next(){ const now = Date.now(); const d = Math.max(0, this.last + this.delay - now); await wait(d + Math.floor(Math.random()*this.jitter)); this.last = Date.now() } }

function toCSV(rows){
  if(!rows.length) return ''
  const headers = Object.keys(rows[0])
  const escape = (v)=>{ const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s }
  const lines = [headers.join(',')]
  for(const r of rows){ lines.push(headers.map(h=>escape(r[h])).join(',')) }
  return lines.join('\n')
}

function getCt0(){ const m = document.cookie.match(/(?:^|; )ct0=([^;]+)/); return m ? decodeURIComponent(m[1]) : '' }

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
      const resp = await new Promise((resolve)=>{ try{ chrome.runtime.sendMessage({ type: 'twikit-user-get-guest-token' }, (r)=> resolve(r)) }catch(e){ resolve(null) } })
      const gt = resp && resp.guest_token
      if(gt){ headers['X-Guest-Token'] = gt }
    }catch(e){}
  }
  headers['X-Client-Transaction-Id'] = 'twikit-' + Date.now().toString(36)
  return headers
}

async function httpGet(url, params){
  const q = params ? '?' + new URLSearchParams(params).toString() : ''
  console.log('[x-user-export]', 'HTTP GET', url, params)
  let attempt = 0
  while(true){
    await pacer.next()
    const res = await fetch(url + q, { credentials: 'include', cache: 'no-cache', mode: 'cors', headers: await buildHeaders() })
    console.log('[x-user-export]', 'HTTP STATUS', res.status, 'URL', res.url)
    if(res.status === 429){
      const reset = res.headers.get('x-rate-limit-reset')
      let waitMs = reset ? Math.max(1000, parseInt(reset,10)*1000 - Date.now()) : (60000 * Math.max(1, attempt+1))
      console.log('[x-user-export]', 'Rate limited, wait', Math.ceil(waitMs/1000), 's')
      chrome.runtime.sendMessage({ type: 'twikit-export-progress', text: `429, waiting ${Math.ceil(waitMs/1000)} seconds` })
      await wait(waitMs)
      attempt++
      continue
    }
    if(!res.ok){ const text = await res.text(); console.log('[x-user-export]', 'HTTP ERROR BODY', text); throw new Error(text || String(res.status)) }
    return res.json()
  }
}

async function httpPost(url, body){
  console.log('[x-user-export]', 'HTTP POST', url)
  let attempt = 0
  while(true){
    await pacer.next()
    const res = await fetch(url, { method:'POST', credentials:'include', cache:'no-cache', mode:'cors', headers: await buildHeaders(), body: JSON.stringify(body || {}) })
    console.log('[x-user-export]', 'HTTP STATUS', res.status, 'URL', res.url)
    if(res.status === 429){
      const reset = res.headers.get('x-rate-limit-reset')
      let waitMs = reset ? Math.max(1000, parseInt(reset,10)*1000 - Date.now()) : (60000 * Math.max(1, attempt+1))
      console.log('[x-user-export]', 'Rate limited, wait', Math.ceil(waitMs/1000), 's')
      chrome.runtime.sendMessage({ type: 'twikit-export-progress', text: `429, waiting ${Math.ceil(waitMs/1000)} seconds` })
      await wait(waitMs)
      attempt++
      continue
    }
    if(!res.ok){ const text = await res.text(); console.log('[x-user-export]', 'HTTP ERROR BODY', text); throw new Error(text || String(res.status)) }
    return res.json()
  }
}

async function gqlGet(url, variables, features, extra){
  const params = { variables: JSON.stringify(variables) }
  if(features) params.features = JSON.stringify(features)
  if(extra) Object.assign(params, extra)
  console.log('[x-user-export]', 'GQL GET', url, variables)
  try{ return await httpGet(url, params) }
  catch(e){ const m = url.match(/\/i\/api\/graphql\/([A-Za-z0-9_-]+)\//); const queryId = m && m[1]; if(queryId){ console.log('[x-user-export]', 'GQL fallback POST', url, 'queryId', queryId); return await httpPost(url, { variables, features, queryId }) } throw e }
}

function deepFind(obj, key){ if(!obj) return []; const out = []; if(typeof obj === 'object'){ if(Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key]); for(const k in obj){ const v = obj[k]; if(v && typeof v === 'object') out.push(...deepFind(v, key)) } } return out }

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

const USER_FEATURES = {
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  payments_enabled: false,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: false,
  subscriptions_feature_can_gift_premium: false
}

async function getEndpoints(domain, screenName){
  return await new Promise((resolve)=>{ try{ chrome.runtime.sendMessage({ type:'twikit-user-get-endpoints', domain, screenName }, (r)=> resolve(r && r.endpoints ? r.endpoints : null)) }catch(e){ resolve(null) } })
}

async function userIdByScreenName(epUserByScreenName, screenName){
  const variables = { screen_name: screenName, withSafetyModeUserFields: false }
  const extra = { fieldToggles: JSON.stringify({ withAuxiliaryUserLabels: false }) }
  const json = await gqlGet(epUserByScreenName, variables, USER_FEATURES, extra)
  const result = deepFind(json, 'user')[0]?.result || json?.data?.user?.result
  const id = result?.rest_id || result?.id
  if(!id) throw new Error('Unable to resolve user ID')
  return id
}

function entryIsTweet(entry){ const id = entry.entryId || entry.entry?.entryId; return id && (id.startsWith('tweet') || id.startsWith('profile-conversation') || id.startsWith('profile-grid')) }

async function exportUserContent(screenName, view, maxCount){
  const domain = location.hostname.endsWith('twitter.com') ? 'twitter.com' : 'x.com'
  const eps = await getEndpoints(domain, screenName)
  const map = eps || {
    UserByScreenName: `https://${domain}/i/api/graphql/NimuplG1OB7Fd2btCLdBOw/UserByScreenName`,
    UserTweets: `https://${domain}/i/api/graphql/QWF3SzpHmykQHsQMixG0cg/UserTweets`,
    UserTweetsAndReplies: `https://${domain}/i/api/graphql/vMkJyzx1wdmvOeeNG0n6Wg/UserTweetsAndReplies`,
    UserMedia: `https://${domain}/i/api/graphql/2tLOJWwGuCTytDrGBg8VwQ/UserMedia`,
    Likes: `https://${domain}/i/api/graphql/IohM3gxQHfvWePH5E3KuNA/Likes`
  }
  const ep = view === 'Tweets' ? map.UserTweets : view === 'TweetsAndReplies' ? map.UserTweetsAndReplies : view === 'Media' ? map.UserMedia : map.Likes
  const userId = await userIdByScreenName(map.UserByScreenName, screenName)
  let cursor = null
  const tweets = []
  while(tweets.length < maxCount){
    const variables = { userId, count: 40, includePromotedContent: true, withQuickPromoteEligibilityTweetFields: true, withVoice: true, withV2Timeline: true }
    if(cursor) variables.cursor = cursor
    let json
    try{ json = await gqlGet(ep, variables, FEATURES) }
    catch(e){ const eps2 = await getEndpoints(domain, screenName) || map; const ep2 = view === 'Tweets' ? eps2.UserTweets : view === 'TweetsAndReplies' ? eps2.UserTweetsAndReplies : view === 'Media' ? eps2.UserMedia : eps2.Likes; json = await gqlGet(ep2, variables, FEATURES) }
    const instructions = deepFind(json, 'instructions')[0]
    if(!instructions) break
    const entries = deepFind(instructions, 'entries')[0] || []
    let nextCursor = null
    for(const item of entries){
      const id = item.entryId || item.entry?.entryId
      if(id && id.startsWith('cursor-bottom')) nextCursor = (item.content && item.content.value) || null
      if(!entryIsTweet(item)) continue
      const t = extractTweetFromItem(item)
      if(t){ tweets.push(t); if(tweets.length >= maxCount) break }
    }
    console.log('[x-user-export]', 'Page fetched', { count: tweets.length, nextCursor })
    chrome.runtime.sendMessage({ type: 'twikit-export-progress', text: `Fetched ${tweets.length}/${maxCount} tweets` })
    if(!nextCursor || tweets.length >= maxCount) break
    await wait(1200)
    cursor = nextCursor
  }
  console.log('[x-user-export]', 'Export finished', { total: tweets.length })
  return tweets
}

function inferFilenameBase(screenName, view){ const ts = new Date().toISOString().replace(/[:.]/g,'-'); return `${screenName}-${view}-${ts}` }

chrome.runtime.onMessage.addListener(async (req, sender, sendResponse)=>{
  if(req && req.cmd === 'twikit-ping'){ sendResponse({ ok: true }); return true }
  if(req && req.cmd === 'twikit-user-start'){
    console.log('[x-user-export]', 'Received start command', req)
    try{
      const result = await exportUserContent(req.screenName, req.view, Math.max(1, parseInt(req.maxCount || 1000, 10)))
      const rows = result.map(t => ({
        id: t.id,
        created_at: (t.created_at || '').replace(' +0000',''),
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
      const filename = `${inferFilenameBase(req.screenName, req.view)}.${req.format === 'json' ? 'json' : 'csv'}`
      chrome.runtime.sendMessage({ type: 'twikit-export-data', rows, filename, format: req.format })
    }catch(e){ chrome.runtime.sendMessage({ type: 'twikit-export-progress', text: String(e && e.message || e) }); console.log('[x-user-export]', 'Export error', e && e.message || e) }
  }
})
