(function(){
  const TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  const DOMAIN = (location.hostname && location.hostname.endsWith('twitter.com')) ? 'twitter.com' : 'x.com'
  const GQL = {
    USER_BY_SCREEN_NAME: `https://${DOMAIN}/i/api/graphql/NimuplG1OB7Fd2btCLdBOw/UserByScreenName`
  }
  const V11 = {
    FOLLOWERS_LIST: `https://api.${DOMAIN}/1.1/followers/list.json`,
    FRIENDS_LIST: `https://api.${DOMAIN}/1.1/friends/list.json`,
    FOLLOWERS_IDS: `https://api.${DOMAIN}/1.1/followers/ids.json`,
    FRIENDS_IDS: `https://api.${DOMAIN}/1.1/friends/ids.json`
  }
  function getCt0(){
    const m = document.cookie.match(/(?:^|; )ct0=([^;]+)/)
    return m ? decodeURIComponent(m[1]) : ''
  }
  function baseHeaders(){
    const lang = document.documentElement.lang || 'en-US'
    const headers = {
      'authorization': `Bearer ${TOKEN}`,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': lang,
      'referer': 'https://x.com/'
    }
    const ct0 = getCt0()
    if(ct0) headers['x-csrf-token'] = ct0
    return headers
  }
  async function httpGet(url, params){
    const q = params ? '?' + new URLSearchParams(params).toString() : ''
    const res = await fetch(url + q, { credentials: 'include', cache: 'no-cache', mode: 'cors', headers: baseHeaders() })
    if(!res.ok){
      const text = await res.text()
      window.postMessage({ source:'twikit-exporter', type:'progress', text: `HTTP ${res.status}` }, '*')
      throw new Error(text || String(res.status))
    }
    return res.json()
  }
  async function gqlGet(url, variables, features, extra){
    const params = { variables: JSON.stringify(variables) }
    if(features) params.features = JSON.stringify(features)
    if(extra) Object.assign(params, extra)
    return httpGet(url, params)
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
    responsive_web_graphql_timeline_navigation_enabled: true
  }
  async function getUserIdByScreenName(screenName){
    const variables = { screen_name: screenName, withSafetyModeUserFields: false }
    const extra = { fieldToggles: JSON.stringify({ withAuxiliaryUserLabels: false }) }
    const json = await gqlGet(GQL.USER_BY_SCREEN_NAME, variables, USER_FEATURES, extra)
    const result = json && json.data && json.data.user && json.data.user.result
    const id = result && result.rest_id
    return id || null
  }
  async function exportIds(kind, screenName, userId, maxCount){
    const url = kind === 'followers' ? V11.FOLLOWERS_IDS : V11.FRIENDS_IDS
    let cursor = '-1'
    const ids = []
    window.postMessage({ source:'twikit-exporter', type:'progress', text: `Fetched 0/${maxCount} IDs` }, '*')
    while(cursor !== '0' && ids.length < maxCount){
      const params = { count: 5000 }
      if(userId) params.user_id = userId; else params.screen_name = screenName
      if(cursor !== '-1') params.cursor = cursor
      const json = await httpGet(url, params)
      if(Array.isArray(json.ids)){
        const room = maxCount - ids.length
        ids.push(...json.ids.slice(0, room))
      }
      const next = (json.next_cursor_str !== undefined ? json.next_cursor_str : String(json.next_cursor ?? '0'))
      cursor = next
      window.postMessage({ source:'twikit-exporter', type:'progress', text: `Fetched ${ids.length}/${maxCount} IDs` }, '*')
      if(ids.length >= maxCount) break
    }
    return ids
  }
  async function exportDetails(kind, screenName, userId, maxCount){
    const url = kind === 'followers' ? V11.FOLLOWERS_LIST : V11.FRIENDS_LIST
    let cursor = '-1'
    const users = []
    window.postMessage({ source:'twikit-exporter', type:'progress', text: `Fetched 0/${maxCount} users` }, '*')
    while(cursor !== '0' && users.length < maxCount){
      const params = { count: 200 }
      if(userId) params.user_id = userId; else params.screen_name = screenName
      if(cursor !== '-1') params.cursor = cursor
      const json = await httpGet(url, params)
      const arr = json.users || []
      for(const u of arr){
        if(users.length >= maxCount) break
        const website = (u.entities && u.entities.url && Array.isArray(u.entities.url.urls) && u.entities.url.urls.length ? (u.entities.url.urls[0].expanded_url || u.entities.url.urls[0].url) : (u.url || ''))
        users.push({
          name: u.name,
          user_name: u.screen_name,
          user_id: u.id_str || String(u.id),
          created_at: (u.created_at || '').replace(' +0000',''),
          bio: u.description,
          tweets_count: u.statuses_count,
          followers_count: u.followers_count,
          following_count: u.friends_count,
          favourites_count: u.favourites_count,
          location: u.location,
          website,
          profile_url: `https://${DOMAIN}/${u.screen_name}`,
          profile_banner_url: u.profile_banner_url || '',
          avatar_url: u.profile_image_url_https || u.profile_image_url || '',
          verified: !!u.verified
        })
      }
      const next = (json.next_cursor_str !== undefined ? json.next_cursor_str : String(json.next_cursor ?? '0'))
      cursor = next
      window.postMessage({ source:'twikit-exporter', type:'progress', text: `Fetched ${users.length}/${maxCount} users` }, '*')
      if(users.length >= maxCount) break
    }
    return users
  }
  async function start(payload){
    try{
      const { screenName, type, mode, format } = payload
      const maxCount = Math.max(1, parseInt(payload.maxCount || 1000, 10))
      window.postMessage({ source:'twikit-exporter', type:'progress', text: 'Resolving user...' }, '*')
      let sn = screenName
      if(!sn){
        const path = location.pathname.split('/').filter(Boolean)
        if(path.length){
          const first = path[0]
          if(!['home','explore','notifications','messages','i'].includes(first)) sn = first
        }
      }
      if(!sn){
        window.postMessage({ source:'twikit-exporter', type:'progress', text: 'Please open a user profile page, or enter a screen name in the popup' }, '*')
        return
      }
      let userId = null
      const result = mode === 'ids' ? await exportIds(type, sn, userId, maxCount) : await exportDetails(type, sn, userId, maxCount)
      window.postMessage({ source:'twikit-exporter', type:'result', payload: { screenName: sn, type, mode, format, result } }, '*')
    }catch(e){
      window.postMessage({ source:'twikit-exporter', type:'progress', text: String(e && e.message || e) }, '*')
    }
  }
  window.addEventListener('message', async (event)=>{
    const msg = event.data
    if(!msg || msg.type !== 'twikit-export-start') return
    const payload = msg.payload
    await start(payload)
  })
  try{
    window.postMessage({ source:'twikit-exporter', type:'ready' }, '*')
  }catch(e){}
})();
