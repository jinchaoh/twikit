(function(){
  const TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  const DOMAIN = (location.hostname && location.hostname.endsWith('twitter.com')) ? 'twitter.com' : 'x.com'
  const DEFAULT_SEARCH_TIMELINE = `https://${DOMAIN}/i/api/graphql/flaR-PUMshxFWZWPNpq4zA/SearchTimeline`
  const FEATURES = {
    'creator_subscriptions_tweet_preview_api_enabled': true,
    'c9s_tweet_anatomy_moderator_badge_enabled': true,
    'tweetypie_unmention_optimization_enabled': true,
    'responsive_web_edit_tweet_api_enabled': true,
    'graphql_is_translatable_rweb_tweet_is_translatable_enabled': true,
    'view_counts_everywhere_api_enabled': true,
    'longform_notetweets_consumption_enabled': true,
    'responsive_web_twitter_article_tweet_consumption_enabled': true,
    'tweet_awards_web_tipping_enabled': false,
    'longform_notetweets_rich_text_read_enabled': true,
    'longform_notetweets_inline_media_enabled': true,
    'rweb_video_timestamps_enabled': true,
    'responsive_web_graphql_exclude_directive_enabled': true,
    'verified_phone_label_enabled': false,
    'freedom_of_speech_not_reach_fetch_enabled': true,
    'standardized_nudges_misinfo': true,
    'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled': true,
    'responsive_web_media_download_video_enabled': false,
    'responsive_web_graphql_skip_user_profile_image_extensions_enabled': false,
    'responsive_web_graphql_timeline_navigation_enabled': true,
    'responsive_web_enhance_cards_enabled': false
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
      'referer': `https://${DOMAIN}/`
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
      window.postMessage({ source:'twikit-hashtag', type:'progress', text: `HTTP ${res.status}` }, '*')
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

  async function discoverSearchTimelineEndpoint(){
    try{
      // Fetch home to discover client-web scripts
      const res = await fetch(`https://${DOMAIN}/`, { credentials: 'include', cache: 'no-cache' })
      const html = await res.text()
      const scriptUrls = Array.from(html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"]+\.js/gi)).map(m=>m[0])
      for(const url of scriptUrls){
        try{
          const jsRes = await fetch(url, { credentials: 'include', cache: 'no-cache' })
          const js = await jsRes.text()
          const m = js.match(/i\/api\/graphql\/([A-Za-z0-9_-]+)\/SearchTimeline/)
          if(m && m[1]){
            return `https://${DOMAIN}/i/api/graphql/${m[1]}/SearchTimeline`
          }
        }catch(e){/* continue */}
      }
    }catch(e){/* ignore */}
    return DEFAULT_SEARCH_TIMELINE
  }

  function deepFind(obj, key){
    if(!obj) return []
    const out = []
    if(typeof obj === 'object'){
      if(Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key])
      for(const k in obj){
        const v = obj[k]
        if(v && typeof v === 'object') out.push(...deepFind(v, key))
      }
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
        hashtags: hashtags,
        urls: urls,
        media_urls: mediaUrls
      }
    }catch(e){
      return null
    }
  }

  async function searchTweets(query, product, maxCount){
    const SEARCH_TIMELINE = await discoverSearchTimelineEndpoint()
    let cursor = null
    const tweets = []
    while(tweets.length < maxCount){
      const variables = { rawQuery: query, count: 20, querySource: 'typed_query', product }
      if(cursor) variables.cursor = cursor
      let json
      try{
        json = await gqlGet(SEARCH_TIMELINE, variables, FEATURES)
      }catch(e){
        if(product !== 'Latest'){
          window.postMessage({ source:'twikit-hashtag', type:'progress', text: 'Top/Media failed, trying Latest…' }, '*')
          product = 'Latest'
          json = await gqlGet(SEARCH_TIMELINE, { ...variables, product }, FEATURES)
        }else{
          throw e
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
          if(items && items[0] && items[0].content && items[0].content.items){
            items = items[0].content.items
          }else{
            items = []
          }
        }
      }
      let nextCursor = null
      for(const item of items){
        const id = item.entryId || item.entry?.entryId
        if(id && id.startsWith('cursor-bottom')) nextCursor = (item.content && item.content.value) || null
        const isTweet = id && (id.startsWith('tweet') || id.startsWith('search-grid'))
        if(!isTweet) continue
        const t = extractTweetFromItem(item)
        if(t){
          tweets.push(t)
          if(tweets.length >= maxCount) break
        }
      }
      window.postMessage({ source:'twikit-hashtag', type:'progress', text: `Fetched ${tweets.length}/${maxCount} tweets` }, '*')
      if(!nextCursor || tweets.length >= maxCount) break
      cursor = nextCursor
    }
    return tweets
  }

  async function start(payload){
    try{
      const { query, product, format } = payload
      const maxCount = Math.max(1, parseInt(payload.maxCount || 1000, 10))
      window.postMessage({ source:'twikit-hashtag', type:'progress', text: 'Searching...' }, '*')
      const result = await searchTweets(query, product, maxCount)
      window.postMessage({ source:'twikit-hashtag', type:'result', payload: { query, product, format, result } }, '*')
    }catch(e){
      window.postMessage({ source:'twikit-hashtag', type:'progress', text: String(e && e.message || e) }, '*')
    }
  }

  window.addEventListener('message', async (event)=>{
    const msg = event.data
    if(!msg || msg.type !== 'twikit-hashtag-start') return
    const payload = msg.payload
    await start(payload)
  })
  window.postMessage({ source:'twikit-hashtag', type:'ready' }, '*')
})();
