// api/scraper_bot.js
// Personal Telegram lead-scraper bot — hosted on Vercel
// Works even when your PC is off. Batches through Vercel's serverless
// time limit, remembers everything checked so nothing repeats.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'GET') return res.status(200).send('OK')

  const BOT_TOKEN = process.env.SCRAPER_BOT_TOKEN || ''
  const ADMIN_ID  = process.env.SCRAPER_ADMIN_ID  || ''
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

  const BATCH_SIZE  = 8    // links checked per message — reduced from 12 now that each lead also runs a PageSpeed check
  const CONCURRENCY = 4

  // Your saved URLScan search queries — pick a number instead of retyping
  const SAVED_SEARCHES = {
    '1': { label: 'All myshopify.com (newest first)', query: 'page.domain:myshopify.com' },
    '2': { label: 'Skincare/beauty niche',            query: 'page.domain:myshopify.com AND page.title:(skincare OR beauty OR cosmetics)' },
    '3': { label: 'Jewelry niche',                     query: 'page.domain:myshopify.com AND page.title:jewelry' },
    '4': { label: 'Pet products niche',                query: 'page.domain:myshopify.com AND page.title:pet' },
    '5': { label: 'Fashion/clothing niche',             query: 'page.domain:myshopify.com AND page.title:(fashion OR clothing OR apparel)' },
  }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { return res.status(200).send('OK') } }
  if (!body) return res.status(200).send('OK')

  const PREMIUM_STARS_PRICE = 2  // Telegram Stars for 1 full-detail premium scrape

  async function answerCallback(callbackQueryId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId })
      })
    } catch (e) {}
  }

  async function sendInvoice(chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendInvoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          title: '1 Premium Scrape',
          description: 'Unlock 1 full-detail scrape — name, socials, and contact page included.',
          payload: `premium_scrape_${chatId}_${Date.now()}`,
          currency: 'XTR',
          prices: [{ label: 'Premium Scrape', amount: PREMIUM_STARS_PRICE }]
        })
      })
    } catch (e) {}
  }

  async function answerPreCheckoutQuery(id, ok, errorMessage) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: id, ok, ...(errorMessage ? { error_message: errorMessage } : {}) })
      })
    } catch (e) {}
  }

  async function send(chatId, text) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      })
    } catch (e) {}
  }

  function sendKeyboard(chatId, text, keyboard) {
    return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } })
    }).catch(() => {})
  }

  async function getFileContent(fileId) {
    try {
      const r  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`)
      const d  = await r.json()
      const fr = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${d.result.file_path}`)
      return await fr.text()
    } catch { return '' }
  }

  // ── Upstash Redis REST — real atomic ops, no more overwrite races ──

  async function redis(...args) {
    try {
      const r = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
      })
      const d = await r.json()
      if (d.error) {
        console.error('Redis command error:', d.error, 'args:', args[0])
        return { ok: false, result: null }
      }
      return { ok: true, result: d.result }
    } catch (e) {
      console.error('Redis unreachable:', e.message)
      return { ok: false, result: null }
    }
  }

  // seen-domains hash: field = normalized domain, value = JSON {status,email,checkedAt}
  async function getSeenBatch(keys) {
    if (!keys.length) return {}
    const { result: vals } = await redis('HMGET', 'seen', ...keys)
    const out = {}
    if (vals) keys.forEach((k, i) => { if (vals[i]) out[k] = JSON.parse(vals[i]) })
    return out
  }

  async function markSeenBatch(entries) {
    // entries: [[key, dataObj], ...]
    if (!entries.length) return
    const flat = entries.flatMap(([k, v]) => [k, JSON.stringify(v)])
    await redis('HSET', 'seen', ...flat)
  }

  // per-user session (pending links / results / message-writing state)
  async function getUserQueue(userId) {
    const { result: v } = await redis('GET', `queue:${userId}`)
    return v ? JSON.parse(v) : { pending: [], results: [], awaitingMessages: false, messages: [], awaitingCustomQuery: false }
  }

  async function saveUserQueue(userId, queue) {
    await redis('SET', `queue:${userId}`, JSON.stringify(queue))
  }

  // Filtered-out (blacklisted domain) links from the user's most recent
  // scrape — kept separate from the pending/results queue since that queue
  // gets fully overwritten each new scrape, but these should stick around
  // for later retrieval via /others.
  async function saveFilteredOut(userId, list) {
    await redis('SET', `filtered:${userId}`, JSON.stringify(list))
  }

  async function getFilteredOut(userId) {
    const { result } = await redis('GET', `filtered:${userId}`)
    return result ? JSON.parse(result) : []
  }

  // per-user lock — stops the SAME user's overlapping/double-tapped requests
  // from reading+writing their queue at the same time and clobbering each other.
  // Self-expires after 25s as a safety net in case a request errors/times out
  // without releasing it, so a crash can't permanently lock someone out.
  // IMPORTANT: if Redis itself is unreachable/misconfigured, this FAILS OPEN
  // (proceeds without lock protection) rather than silently blocking every
  // user with no reply — an infra problem should degrade gracefully, not
  // make the whole bot go silent.
  async function acquireLock(userId) {
    const { ok, result } = await redis('SET', `lock:${userId}`, '1', 'NX', 'EX', '25')
    if (!ok) return true  // Redis error — don't block the user for it
    return result === 'OK'
  }

  async function releaseLock(userId) {
    await redis('DEL', `lock:${userId}`)
  }

  // ── Users, referrals, bonus leads ──
  // Full-detail data (name/socials/contact) and file uploads stay
  // admin-only, period. Referrals only ever earn MORE of the same
  // restricted (link+email) leads free users already get — never
  // upgraded access. That's a deliberate choice, not an oversight.

  function today() {
    return new Date().toISOString().slice(0, 10)  // YYYY-MM-DD (UTC)
  }

  const DAY_MS = 24 * 60 * 60 * 1000

  async function getUser(userId) {
    const { result } = await redis('HGETALL', `user:${userId}`)
    const flat = {}
    if (result) for (let i = 0; i < result.length; i += 2) flat[result[i]] = result[i + 1]
    return {
      hasStarted:              flat.hasStarted === '1',
      referredBy:              flat.referredBy || '',
      totalReferrals:          parseInt(flat.totalReferrals || '0', 10),
      referralWindowStart:     parseInt(flat.referralWindowStart || '0', 10),
      referralsInWindow:       parseInt(flat.referralsInWindow || '0', 10),
      bonusLeadsRemaining:     parseInt(flat.bonusLeadsRemaining || '0', 10),
      premiumScrapesRemaining: parseInt(flat.premiumScrapesRemaining || '0', 10),
    }
  }

  async function setUserFields(userId, fields) {
    const flat = Object.entries(fields).flatMap(([k, v]) => [k, String(v)])
    await redis('HSET', `user:${userId}`, ...flat)
  }

  // Credits a successful referral: +10 bonus leads, max 2 per ROLLING 24h
  // window (not a calendar-day reset — that would let someone grab 2 right
  // before midnight UTC and 2 more minutes later after rollover). The
  // window starts at the first referral and expires exactly 24h later.
  // Uses Date.now() on the server — nothing here is ever read from the
  // user's device, so there's no clock to manipulate client-side.
  async function creditReferral(referrerId) {
    const user = await getUser(referrerId)
    const now = Date.now()

    let windowStart = user.referralWindowStart
    let inWindow = user.referralsInWindow
    if (!windowStart || (now - windowStart) >= DAY_MS) {
      windowStart = now
      inWindow = 0
    }

    if (inWindow >= 2) {
      const hoursLeft = Math.ceil((windowStart + DAY_MS - now) / (60 * 60 * 1000))
      await send(referrerId, `Max referrals met (2/24h) — you can refer again in ~${hoursLeft}h.`)
      return
    }

    inWindow += 1
    const totalReferrals = user.totalReferrals + 1
    const bonusLeadsRemaining = user.bonusLeadsRemaining + 10

    await setUserFields(referrerId, {
      referralWindowStart: windowStart, referralsInWindow: inWindow,
      totalReferrals, bonusLeadsRemaining
    })
    await send(referrerId, `🎉 Referral confirmed! +10 bonus leads added (${inWindow}/2 in this 24h window). Use /scout to claim them.`)
  }

  let cachedBotUsername = ''
  async function getBotUsername() {
    if (cachedBotUsername) return cachedBotUsername
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)
      const d = await r.json()
      cachedBotUsername = d.result?.username || ''
    } catch (e) {}
    return cachedBotUsername
  }

  // ══════════════════════════════════════════════
  //  URLSCAN.IO — direct API scraping, no browser needed
  //  Handles "load more" automatically via pagination cursor
  // ══════════════════════════════════════════════

  async function fetchUrlscanPage(query, searchAfter) {
    let apiUrl = `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=100`
    if (searchAfter) apiUrl += `&search_after=${searchAfter}`
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 5000)
      const r = await fetch(apiUrl, { signal: controller.signal })
      clearTimeout(t)
      return await r.json()
    } catch (e) {
      return null
    }
  }

  // Keeps paging DEEPER into URLScan's results (not just page 1) until it
  // collects `wantCount` genuinely new (never-seen, non-blacklisted) leads,
  // or runs out of pages, or hits maxPages — a safety cap so this can't
  // blow past Vercel's execution time limit on a query with huge totals.
  async function scrapeUntilUnseen(query, wantCount, maxPages = 4) {
    const unseenUrls = []
    const filteredOut = []
    const scanTimes = {}
    const seenThisRun = new Set()
    let searchAfter = null
    let total = null
    let newestScanTime = null
    let pagesUsed = 0
    let exhausted = false

    const extraBlacklistSet = await getExtraBlacklistSet()

    for (let page = 0; page < maxPages && unseenUrls.length < wantCount; page++) {
      const data = await fetchUrlscanPage(query, searchAfter)
      if (!data) break
      if (total === null && typeof data.total === 'number') total = data.total
      if (!data.results || !data.results.length) { exhausted = true; break }
      pagesUsed++

      const pageUrls = []
      for (const item of data.results) {
        const domain = item.page?.domain
        const url    = domain ? `https://${domain}` : (item.page?.url || item.task?.url)
        const scanTime = item.task?.time || item.page?.time
        if (url) {
          pageUrls.push(url)
          if (scanTime) scanTimes[url] = scanTime
          if (scanTime && (!newestScanTime || scanTime > newestScanTime)) newestScanTime = scanTime
        }
      }

      const { cleaned, filteredOut: pageFiltered } = partitionLeads(pageUrls, extraBlacklistSet)
      filteredOut.push(...pageFiltered)

      const dedupeKeys = cleaned.map(normalizeForDedupe)
      const seenMap = await getSeenBatch(dedupeKeys)
      for (let i = 0; i < cleaned.length; i++) {
        const key = dedupeKeys[i]
        if (!seenMap[key] && !seenThisRun.has(key)) {
          seenThisRun.add(key)
          unseenUrls.push(cleaned[i])
          if (unseenUrls.length >= wantCount) break
        }
      }

      const last = data.results[data.results.length - 1]
      if (last?.sort) searchAfter = last.sort.join(',')
      else { exhausted = true; break }

      if (data.results.length < 100) { exhausted = true; break }  // URLScan itself has no more
    }

    return {
      urls: unseenUrls.slice(0, wantCount), filteredOut, scanTimes,
      total, newestScanTime, pagesUsed,
      gotEnough: unseenUrls.length >= wantCount,
      exhaustedSource: exhausted
    }
  }

  // ── URL fixing / dedupe / filtering ──

  const LINK_PATTERN = /https?:\/\/[^\s,"'<>]+|[a-zA-Z0-9\-]+\.myshopify\.com[^\s,"'<>]*/g

  function fixUrl(raw) {
    if (!raw || !raw.trim()) return null
    let url = raw.trim().replace(/\|/g, '/').replace(/\s/g, '')
    url = url.replace(/\.myshopi(fy)?\.?c?o?m?$/i, '.myshopify.com')
    if (url && !url.startsWith('http')) {
      if (url.startsWith('//')) url = 'https:' + url
      else if (url.includes('.')) url = 'https://' + url
    }
    const domainMatch = url.match(/https?:\/\/([^/\s]+)/)
    if (!domainMatch) return null
    let domain = domainMatch[1].toLowerCase()
    if (!domain.includes('.') && domain.length > 3) return `https://${domain}.myshopify.com`
    url = url.split('?')[0].replace(/\/$/, '')
    return url
  }

  function normalizeForDedupe(url) {
    let u = url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
    u = u.split('/')[0].split('?')[0].replace(/\.$/, '')
    return u
  }

  const NEVER_LEADS = ['wikipedia.org','google.com','youtube.com','facebook.com','twitter.com',
    'x.com','instagram.com','reddit.com','github.com','letsencrypt.org','apple.com',
    'microsoft.com','.gov','.edu','amazon.com','linkedin.com','tiktok.com','pinterest.com',
    'cloudflare.com','mozilla.org','w3.org','adobe.com']

  // Admin-grown blacklist (e.g. known fake-shop domain lists) stored in
  // Redis so it persists and can be extended via /black without a redeploy.
  async function getExtraBlacklistSet() {
    const { result } = await redis('SMEMBERS', 'blacklist:extra')
    return new Set(result || [])
  }

  async function addToBlacklist(domains) {
    if (!domains.length) return 0
    await redis('SADD', 'blacklist:extra', ...domains)
    return domains.length
  }

  // Parses common domain-blocklist formats defensively: plain domain-per-line,
  // hosts-file format ("0.0.0.0 domain.com"), adblock ("||domain.com^"),
  // and wildcard-prefixed ("*.domain.com") — since public blocklists vary
  // in format and we don't want to hardcode assumptions about exactly which
  // one a given URL uses.
  function parseBlacklistText(text) {
    const domains = new Set()
    for (let raw of text.split('\n')) {
      let line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith(';')) continue
      line = line.replace(/^\|\|/, '').replace(/\^$/, '').replace(/^\*\./, '')
      line = line.split(/\s+/).pop()  // last token handles "0.0.0.0 domain.com" hosts format
      if (line && line.includes('.') && !line.includes('/') && !line.includes('*')) {
        domains.add(line.toLowerCase().replace(/^www\./, ''))
      }
      if (domains.size >= 20000) break  // safety cap
    }
    return [...domains]
  }

  // Checks the hostname AND its parent domains against the extra blacklist
  // Set (O(1) lookups, not a substring scan) so a list of thousands of
  // domains doesn't slow down filtering — sub.scam.com correctly matches
  // a blacklisted scam.com entry too.
  function looksLikeValidLead(url, extraBlacklistSet) {
    const u = url.toLowerCase()
    if (NEVER_LEADS.some(d => u.includes(d))) return false
    if (extraBlacklistSet && extraBlacklistSet.size) {
      const host = normalizeForDedupe(url)
      const parts = host.split('.')
      for (let i = 0; i < parts.length - 1; i++) {
        if (extraBlacklistSet.has(parts.slice(i).join('.'))) return false
      }
    }
    return true
  }

  // Splits fixed/deduped links into valid leads vs blacklisted ones (github,
  // facebook, fake-shop lists, etc.) — the blacklisted ones used to just
  // vanish; now they're returned too so they can be shown as clickable links
  // for manual review, in case the filter ever tosses something worth checking.
  function partitionLeads(rawLinks, extraBlacklistSet) {
    const fixed = [...new Set(rawLinks.map(fixUrl).filter(Boolean))]
    const cleaned = fixed.filter(u => looksLikeValidLead(u, extraBlacklistSet))
    const filteredOut = fixed.filter(u => !looksLikeValidLead(u, extraBlacklistSet))
    return { cleaned, filteredOut }
  }

  function extractAndCleanLinks(rawText, extraBlacklistSet) {
    const found = rawText.match(LINK_PATTERN) || []
    const fixed = found.map(fixUrl).filter(Boolean).filter(u => looksLikeValidLead(u, extraBlacklistSet))
    const seenKeys = new Map()
    for (const u of fixed) {
      const key = normalizeForDedupe(u)
      if (!seenKeys.has(key) || u.length < seenKeys.get(key).length) {
        seenKeys.set(key, u)
      }
    }
    return [...seenKeys.values()]
  }

  // ── Email + contact validation + social links ──

  function cleanEmails(text) {
    const emailPat = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
    const junk = ['example','domain','sentry','shopify','wixpress','schema','pixel',
                  '.png','.jpg','yourstore','youremail','test@','user@','noreply','no-reply']
    const matches = text.match(emailPat) || []
    return matches.map(e => e.toLowerCase()).filter(e => !junk.some(j => e.includes(j)))
  }

  function bestEmail(emails) {
    const priority = emails.find(e => ['contact','info','hello','support','admin','help','sales','store','hi']
      .some(x => e.includes(x)))
    return priority || emails[0]
  }

  function isGenericEmail(email) {
    const generic = ['contact@','info@','support@','hello@','admin@','sales@','help@','hi@']
    return generic.some(p => email.startsWith(p))
  }

  function extractSocials(text) {
    const socials = {}
    const patterns = {
      facebook:  /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9_.\-]+/,
      instagram: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9_.\-]+/,
      twitter:   /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[a-zA-Z0-9_.\-]+/,
      linkedin:  /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[a-zA-Z0-9_.\-]+/,
    }
    for (const [key, pat] of Object.entries(patterns)) {
      const m = text.match(pat)
      if (m) socials[key] = m[0]
    }
    return socials
  }

  async function getSpeedIndexSeconds(url) {
    try {
      const psKey = process.env.PAGESPEED_API_KEY || ''
      let apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance`
      if (psKey) apiUrl += `&key=${psKey}`
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 4500)
      const r = await fetch(apiUrl, { signal: controller.signal })
      clearTimeout(t)
      const data = await r.json()
      const ms = data?.lighthouseResult?.audits?.['speed-index']?.numericValue
      return typeof ms === 'number' ? ms / 1000 : null
    } catch (e) {
      return null
    }
  }

  // Scores real pain-point signals your bot actually has data for — adapted
  // from the "no SSL / slow site / digitally active but neglected" idea,
  // using SSL validity, PageSpeed load time, and social presence instead of
  // data sources (Google ratings, Instagram post frequency) this bot doesn't
  // collect. 70+ = worth prioritizing for outreach.
  function scoreLead(r) {
    if (r.status !== 'OK') return { score: 0, reasons: [] }
    let score = 0
    const reasons = []

    if (r.sslValid === false) { score += 25; reasons.push('no SSL (http only)') }

    if (typeof r.loadSeconds === 'number') {
      if (r.loadSeconds >= 8) { score += 45; reasons.push(`very slow site (${r.loadSeconds.toFixed(1)}s load)`) }
      else if (r.loadSeconds >= 5) { score += 30; reasons.push(`slow site (${r.loadSeconds.toFixed(1)}s load)`) }
    }

    const socialCount = Object.keys(r.socials || {}).length
    if (socialCount >= 1) { score += 15; reasons.push('active on social media') }

    if (r.email === 'no email' && (r.contact_page || socialCount)) {
      score += 10; reasons.push('hard to reach directly — likely small/DIY setup')
    }

    return { score, reasons }
  }

  function auditHookLine(r) {
    if (typeof r.loadSeconds === 'number') {
      return `Your mobile site takes ${r.loadSeconds.toFixed(1)}s to load — most visitors leave after 3s.`
    }
    if (r.sslValid === false) {
      return `Your site loads over plain HTTP — no SSL certificate, which browsers flag as "Not Secure."`
    }
    return null
  }

  // Personalized outreach message using only fields this bot can actually
  // fill in honestly — no fake first-name guessing (Shopify scraping
  // doesn't surface an owner's name), no fabricated "X spots left" claims.
  function personalizedMessage(r, niche) {
    const hook = auditHookLine(r) || `noticed a couple of quick technical wins on your site`
    return `Hey! Love ${r.store_name || 'your store'} 👋\n\n` +
      `Quick one — ${hook}\n\n` +
      `I help ${niche} brands fix exactly that kind of thing. Running a free pilot for a couple of stores this week — want a 30-sec look?`
  }

  async function checkOneStore(url) {
    const result = {
      url, store_name: '', email: 'no email', email_is_generic: false,
      contact_page: '', store_type: '', socials: {}, status: 'dead',
      sslValid: null, loadSeconds: null, score: 0, scoreReasons: [],
      isPasswordProtected: false
    }
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 5000)
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: controller.signal,
        redirect: 'follow',
      })
      clearTimeout(t)
      if (![200,401,403].includes(r.status)) return result
      result.status = 'OK'
      // SSL is free to determine here: this fetch already succeeded, and
      // fetch() throws on invalid/self-signed certs — so if we got here AND
      // the URL is https, the cert is valid. If it's plain http, there's no
      // SSL at all. No extra network call needed for this one.
      result.sslValid = url.startsWith('https://')

      // Kick off the speed check now WITHOUT awaiting — it runs concurrently
      // with the rest of this function's work below (parsing, fallback page
      // checks) instead of adding fully sequential latency on top.
      const speedPromise = getSpeedIndexSeconds(url)

      const html = await r.text()

      if (html.includes('myshopify.com') || html.includes('cdn.shopify.com')) result.store_type = 'Shopify'
      else if (html.includes('woocommerce')) result.store_type = 'WooCommerce'
      else if (html.includes('wp-content')) result.store_type = 'WordPress'
      else if (html.includes('wixsite.com') || html.includes('wixstatic.com')) result.store_type = 'Wix'
      else if (html.includes('squarespace.com')) result.store_type = 'Squarespace'
      else result.store_type = 'Custom/Other'

      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      if (titleMatch) result.store_name = titleMatch[1].split(/[–|—]/)[0].trim().slice(0, 60)

      // Password-protected / "coming soon" Shopify storefronts return HTTP
      // 401 and serve a gate page instead of real content — no point trying
      // to scrape emails/socials off that, since it's not the real site.
      const finalUrl = r.url || url
      result.isPasswordProtected = (
        r.status === 401 ||
        finalUrl.includes('/password') ||
        html.includes('shopify-section-password') ||
        /this (store|shop) (will be back soon|is currently password protected)/i.test(html) ||
        /enter (using )?password/i.test(html) ||
        /opening soon/i.test(html)
      )

      if (result.isPasswordProtected) {
        result.socials = extractSocials(html)  // occasionally still present in the page header/footer
        const { score, reasons } = scoreLead(result)
        result.score = score
        result.scoreReasons = reasons
        return result  // don't waste calls scraping a page that isn't the real site
      }

      result.socials = extractSocials(html)

      const homeEmails = cleanEmails(html)

      if (homeEmails.length) {
        const chosen = bestEmail(homeEmails)
        result.email = chosen
        result.email_is_generic = isGenericEmail(chosen)
        if (result.email_is_generic) {
          result.contact_page = url.replace(/\/$/, '') + '/pages/contact'
        }
      } else {
        // No email on homepage — check several common pages IN PARALLEL
        // (not one at a time) so this stays fast even though it's more
        // thorough. This is what catches emails Shopify stores often put
        // on their privacy policy / about / contact-us pages instead of
        // the homepage — exactly what was being missed before.
        const base = url.replace(/\/$/, '')
        const fallbackPages = [
          base + '/pages/contact',
          base + '/pages/contact-us',
          base + '/pages/about',
          base + '/policies/privacy-policy',
          base + '/policies/refund-policy',
        ]

        const fallbackResults = await Promise.all(
          fallbackPages.map(async (pageUrl) => {
            try {
              const r = await fetch(pageUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(3500),
              })
              if (!r.ok) return { pageUrl, emails: [], exists: false }
              const pageHtml = await r.text()
              return { pageUrl, emails: cleanEmails(pageHtml), exists: true }
            } catch {
              return { pageUrl, emails: [], exists: false }
            }
          })
        )

        // Use the first page that actually had an email
        const withEmail = fallbackResults.find(r => r.emails.length > 0)
        if (withEmail) {
          result.email = bestEmail(withEmail.emails)
          result.email_is_generic = isGenericEmail(result.email)
          result.email_source = withEmail.pageUrl
        } else {
          // Still nothing — but note a contact page if one exists, so the
          // person can still be reached, just not by direct email
          const anyContactPage = fallbackResults.find(r => r.exists && r.pageUrl.includes('contact'))
          if (anyContactPage) result.contact_page = anyContactPage.pageUrl
        }
      }

      result.loadSeconds = await speedPromise
    } catch (e) {}

    const { score, reasons } = scoreLead(result)
    result.score = score
    result.scoreReasons = reasons

    return result
  }

  async function processBatch(urls) {
    const results = []
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const chunk = urls.slice(i, i + CONCURRENCY)
      const chunkResults = await Promise.all(chunk.map(checkOneStore))
      results.push(...chunkResults)
    }
    return results
  }

  // ══════════════════════════════════════════════
  //  TELEGRAM STARS PAYMENTS — must be handled before body.message/
  //  body.callback_query checks below, since these are their own
  //  distinct update types.
  // ══════════════════════════════════════════════

  if (body.pre_checkout_query) {
    // Always approve — Stars payments for a fixed-price digital good
    // don't need stock/availability checks.
    await answerPreCheckoutQuery(body.pre_checkout_query.id, true)
    return res.status(200).send('OK')
  }

  if (body.message?.successful_payment) {
    const payerId = String(body.message.from?.id || '')
    const payerChatId = body.message.chat.id
    const user = await getUser(payerId)
    await setUserFields(payerId, { premiumScrapesRemaining: user.premiumScrapesRemaining + 1 })
    await send(payerChatId, `✓ Payment received — +1 premium scrape unlocked. Use /scout to spend it.`)
    return res.status(200).send('OK')
  }

  // ══════════════════════════════════════════════
  //  CALLBACK BUTTONS (must be handled before the body.message
  //  check below — button taps arrive as body.callback_query,
  //  which has no top-level body.message)
  // ══════════════════════════════════════════════

  if (body.callback_query) {
    const cbChatId = body.callback_query.message.chat.id
    const cbUserId = String(body.callback_query.from?.id || '')
    const data     = body.callback_query.data || ''
    const cbId     = body.callback_query.id

    await answerCallback(cbId)  // stops the button's loading spinner

    const cbLocked = await acquireLock(cbUserId)
    if (!cbLocked) return res.status(200).send('OK')

    try {
      // ── Universal: answers the "include locked/password-protected
      // stores?" prompt that follows every lead-count entry, regardless
      // of role, then dispatches to the actual scrape. ──
      if (data === 'lockedyes' || data === 'lockedno') {
        const q = await getUserQueue(cbUserId)
        const search = q.pendingSearch
        q.awaitingLockedFilter = false
        q.pendingSearch = null
        await saveUserQueue(cbUserId, q)
        if (!search) return res.status(200).send('OK')
        return await executeSearch(cbChatId, cbUserId, search, data === 'lockedyes')
      }

      // ── ADMIN — picking a search now asks how many NEW leads to fetch,
      // instead of always grabbing a fixed 100 and re-hitting the same
      // already-seen results. The FIRST scout of the day also splits the
      // batch into the shared free pool (see adminScoutAndFillPoolIfNeeded).
      if (cbUserId === ADMIN_ID) {
        if (data === 'scout_custom') {
          await send(cbChatId, 'Send your custom search query now (e.g. myshopify.com AND candles).')
          const q = await getUserQueue(cbUserId)
          q.awaitingCustomQuery = true
          await saveUserQueue(cbUserId, q)
          return res.status(200).send('OK')
        }
        if (data.startsWith('scout_')) {
          const key = data.replace('scout_', '')
          const search = SAVED_SEARCHES[key]
          if (!search) return res.status(200).send('OK')
          const q = await getUserQueue(cbUserId)
          q.pendingSearch = { query: search.query, label: search.label, isPremium: false }
          q.awaitingLeadCount = true
          await saveUserQueue(cbUserId, q)
          await send(cbChatId, `How many NEW (never-seen) leads do you want? Reply with a number, e.g. 30. Max 300.`)
          return res.status(200).send('OK')
        }
        return res.status(200).send('OK')
      }

      // ── PREMIUM (Stars-purchased) — same live-search flow as admin, full
      // detail. Credit is only spent once the scrape actually runs (after
      // the count is given), not the moment the button's tapped. ──
      if (data === 'pscout_custom') {
        const user = await getUser(cbUserId)
        if (user.premiumScrapesRemaining <= 0) {
          await send(cbChatId, 'No premium scrapes left. Buy one for 2 Stars via /scout.')
          return res.status(200).send('OK')
        }
        await send(cbChatId, 'Send your custom search query now.')
        const q = await getUserQueue(cbUserId)
        q.awaitingCustomQuery = true
        q.customQueryIsPremium = true
        await saveUserQueue(cbUserId, q)
        return res.status(200).send('OK')
      }
      if (data.startsWith('pscout_')) {
        const key = data.replace('pscout_', '')
        const search = SAVED_SEARCHES[key]
        if (!search) return res.status(200).send('OK')
        const user = await getUser(cbUserId)
        if (user.premiumScrapesRemaining <= 0) {
          await send(cbChatId, 'No premium scrapes left. Buy one for 2 Stars via /scout.')
          return res.status(200).send('OK')
        }
        const q = await getUserQueue(cbUserId)
        q.pendingSearch = { query: search.query, label: search.label, isPremium: true }
        q.awaitingLeadCount = true
        await saveUserQueue(cbUserId, q)
        await send(cbChatId, `How many NEW (never-seen) leads do you want? Reply with a number, e.g. 30. Max 300.`)
        return res.status(200).send('OK')
      }

      // ── Everyone else — restricted (link+email) claims only. Full-detail
      // access via referrals never happens — only via a purchased premium
      // scrape (Stars now, real-money coming soon). ──
      if (data === 'claim_pool') {
        return await claimFromPool(cbChatId, cbUserId)
      }

      if (data === 'claim_bonus') {
        return await claimBonusLeads(cbChatId, cbUserId)
      }

      if (data === 'buy_premium') {
        await sendInvoice(cbChatId)
        return res.status(200).send('OK')
      }

      if (data === 'pay_money') {
        await send(cbChatId, '💵 Card/bank payment — coming soon!')
        return res.status(200).send('OK')
      }

      return res.status(200).send('OK')
    } finally {
      await releaseLock(cbUserId)
    }
  }

  // ══════════════════════════════════════════════
  //  Everything below here is for normal text/document
  //  messages only (body.message)
  // ══════════════════════════════════════════════

  const msg = body.message
  if (!msg) return res.status(200).send('OK')

  const chatId = msg.chat.id
  const userId = String(msg.from?.id || '')
  const text   = (msg.text || '').trim()
  const doc    = msg.document

  // No blanket gate anymore — /start, /invite, and /scout are role-aware
  // internally. File uploads (the one feature that's unlimited/full-detail)
  // get their own premium check right where they're handled below.

  // ══════════════════════════════════════════════
  //  COMMANDS
  // ══════════════════════════════════════════════

  if (text.startsWith('/start')) {
    const payload = text.split(' ')[1] || ''
    const isFreshUser = !(await getUser(userId)).hasStarted

    if (isFreshUser) {
      await setUserFields(userId, { hasStarted: '1' })
      if (payload.startsWith('ref_')) {
        const referrerId = payload.replace('ref_', '')
        if (referrerId && referrerId !== userId) {
          await setUserFields(userId, { referredBy: referrerId })
          await creditReferral(referrerId)
        }
      }
    }

    const introText = userId === ADMIN_ID
      ? `👋 <b>Lead Scraper Bot</b>\n\n` +
        `Works even when your PC is off.\n\n` +
        `<b>Two ways to feed it links:</b>\n` +
        `📄 Send a .txt/.csv file — I extract, dedupe, check it\n` +
        `🔍 /scout — full search menu\n` +
        `🚫 /others — see blacklisted links filtered from your last search\n` +
        `🔒 /black &lt;url&gt; — grow the blacklist from any raw domain-list URL\n` +
        `🕵️ /scoutlist &lt;url&gt; — scan any domain-list URL as leads directly\n` +
        `⚡ /autopitch — auto-generate personalized messages for 70+ scored leads\n\n` +
        `Already-checked links are never re-checked, ever.\n\n` +
        `When done, send your outreach messages separated by /\n` +
        `and I'll pair each one with an email for you to copy & send.`
      : `👋 <b>Lead Scraper Bot</b>\n\n` +
        `🎁 /scout — claim today's free leads (link + email)\n` +
        `🔗 /invite — get your referral link, earn +10 bonus leads per friend who joins (max 2/day)\n\n` +
        `Already-checked links are never shown to you twice.`

    await send(chatId, introText)
    return res.status(200).send('OK')
  }

  if (text === '/invite') {
    const user = await getUser(userId)
    const username = await getBotUsername()
    const link = username ? `https://t.me/${username}?start=ref_${userId}` : '(could not fetch bot link — try again)'

    const now = Date.now()
    const windowActive = user.referralWindowStart && (now - user.referralWindowStart) < DAY_MS
    const usedInWindow = windowActive ? user.referralsInWindow : 0
    const resetNote = windowActive
      ? ` (resets in ~${Math.ceil((user.referralWindowStart + DAY_MS - now) / (60 * 60 * 1000))}h)`
      : ''

    await send(chatId,
      `🔗 <b>Your referral link:</b>\n${link}\n\n` +
      `Referrals used: ${usedInWindow}/2${resetNote}\n` +
      `Total referrals ever: ${user.totalReferrals}\n` +
      `Bonus leads available: ${user.bonusLeadsRemaining}\n\n` +
      `Each friend who taps Start with your link gives you +10 bonus leads ` +
      `(link + email, from live search — not the shared pool). Max 2 per rolling 24h window.`
    )
    return res.status(200).send('OK')
  }

  if (text === '/others') {
    const filtered = await getFilteredOut(userId)
    if (!filtered.length) {
      await send(chatId, `No filtered links saved yet — these show up after a /scout run finds any blacklisted domains (github, facebook, etc).`)
      return res.status(200).send('OK')
    }
    const shown = filtered.slice(0, 30)
    const more = filtered.length > shown.length ? `\n…and ${filtered.length - shown.length} more` : ''
    await send(chatId,
      `🚫 <b>Filtered links from your last search</b> — ${filtered.length} total, tap to check manually:\n\n` +
      shown.join('\n') + more
    )
    return res.status(200).send('OK')
  }

  // ── /black <url> — grow the persistent blacklist from a domain list ──
  if (text.startsWith('/black')) {
    if (userId !== ADMIN_ID) return res.status(200).send('OK')

    const url = text.split(' ')[1]
    if (!url || !url.startsWith('http')) {
      await send(chatId, `Usage: /black <url to a raw domain-list file>\ne.g. /black https://example.com/list.txt`)
      return res.status(200).send('OK')
    }

    await send(chatId, `📥 Fetching blacklist from that URL...`)
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 8000)
      const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      clearTimeout(t)
      if (!r.ok) {
        await send(chatId, `Fetch failed (HTTP ${r.status}) — make sure this is a direct raw-text link, not a webpage.`)
        return res.status(200).send('OK')
      }
      const rawText = await r.text()
      const domains = parseBlacklistText(rawText)
      if (!domains.length) {
        await send(chatId, `Fetched the URL but found no parseable domains in it — check the format.`)
        return res.status(200).send('OK')
      }
      const added = await addToBlacklist(domains)
      await send(chatId, `✓ Blacklist updated: ${added} domain(s) processed from the list (merged with existing, duplicates ignored). This applies to all future scrapes.`)
    } catch (e) {
      await send(chatId, `Couldn't fetch that URL — it may block automated requests, or isn't a direct raw-text link. Try downloading it and hosting it somewhere else (e.g. a GitHub Gist raw link), or paste the domains directly and I'll add a way to accept that instead.`)
    }
    return res.status(200).send('OK')
  }

  // ── /scoutlist <url> — scan any domain-list URL as leads (bypasses
  // the blacklist entirely, since checking a blacklist-source list is
  // exactly the point) ──
  if (text.startsWith('/scoutlist')) {
    let isPremiumRun = false
    if (userId !== ADMIN_ID) {
      const user = await getUser(userId)
      if (user.premiumScrapesRemaining <= 0) {
        await send(chatId, `Scanning a domain list needs a premium scrape. Buy one for ${PREMIUM_STARS_PRICE} Stars via /scout.`)
        return res.status(200).send('OK')
      }
      isPremiumRun = true  // credit deducted after they confirm a count, not now
    }

    const url = text.split(' ')[1]
    if (!url || !url.startsWith('http')) {
      await send(chatId, `Usage: /scoutlist <url to a raw domain-list file>\ne.g. /scoutlist https://example.com/list.txt`)
      return res.status(200).send('OK')
    }

    await send(chatId, `📥 Fetching domain list...`)
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 8000)
      const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      clearTimeout(t)
      if (!r.ok) {
        await send(chatId, `Fetch failed (HTTP ${r.status}) — make sure this is a direct raw-text link, not a webpage.`)
        return res.status(200).send('OK')
      }
      const rawText = await r.text()
      const domains = parseBlacklistText(rawText)
      if (!domains.length) {
        await send(chatId, `Fetched the URL but found no parseable domains in it — check the format.`)
        return res.status(200).send('OK')
      }
      const rawLinks = domains.map(d => `https://${d}`)

      const q = await getUserQueue(userId)
      q.pendingSearch = { rawLinks, label: 'domain list', isPremium: isPremiumRun, isDirectList: true }
      q.awaitingLeadCount = true
      await saveUserQueue(userId, q)
      await send(chatId,
        `✓ Parsed ${rawLinks.length} domains from the list.\n` +
        `How many do you want to check? Reply with a number, e.g. 30. Max 300 per request.`
      )
    } catch (e) {
      await send(chatId, `Couldn't fetch that URL — it may block automated requests, or isn't a direct raw-text link.`)
    }
    return res.status(200).send('OK')
  }

  // ── /scout — role-based menu ──
  if (text === '/scout') {
    if (userId === ADMIN_ID) {
      const keyboard = Object.entries(SAVED_SEARCHES).map(([key, s]) =>
        [{ text: s.label, callback_data: `scout_${key}` }]
      )
      keyboard.push([{ text: '✏️ Custom search term', callback_data: 'scout_custom' }])
      await sendKeyboard(chatId, 'Which search do you want to run?', keyboard)
      return res.status(200).send('OK')
    }

    const user = await getUser(userId)
    const keyboard = []

    if (user.premiumScrapesRemaining > 0) {
      keyboard.push(...Object.entries(SAVED_SEARCHES).map(([key, s]) =>
        [{ text: `💎 ${s.label}`, callback_data: `pscout_${key}` }]
      ))
      keyboard.push([{ text: '💎 ✏️ Custom search', callback_data: 'pscout_custom' }])
    }
    if (user.bonusLeadsRemaining > 0) {
      keyboard.push([{ text: `🔗 Claim bonus leads (${user.bonusLeadsRemaining})`, callback_data: 'claim_bonus' }])
    }
    keyboard.push([{ text: "🎁 Claim today's free leads", callback_data: 'claim_pool' }])
    keyboard.push([{ text: `💫 Buy premium scrape (${PREMIUM_STARS_PRICE} Stars)`, callback_data: 'buy_premium' }])
    keyboard.push([{ text: '💵 Pay with card', callback_data: 'pay_money' }])

    const intro = user.premiumScrapesRemaining > 0
      ? `💎 You have ${user.premiumScrapesRemaining} premium scrape(s) — full details (name, socials, contact).\n\n`
      : `Free/bonus leads are link + email only. Buy a premium scrape for full details.\n\n`

    await sendKeyboard(chatId, intro + 'What would you like to do?', keyboard)
    return res.status(200).send('OK')
  }

  // Lock this user's session for the rest of this request — stops two
  // overlapping requests from the same user (e.g. impatient double-tapping
  // "continue") from reading the same queue state and writing back over
  // each other. Self-expires in 25s if something crashes before release.
  const locked = await acquireLock(userId)
  if (!locked) {
    await send(chatId, '⏳ Still working on your last request — one sec.')
    return res.status(200).send('OK')
  }

  try {
    const userQueue = await getUserQueue(userId)

    // ── Awaiting a custom search query typed by the user ──
    if (userQueue.awaitingCustomQuery) {
      userQueue.awaitingCustomQuery = false
      userQueue.pendingSearch = { query: text, label: 'Custom search', isPremium: !!userQueue.customQueryIsPremium }
      userQueue.customQueryIsPremium = false
      userQueue.awaitingLeadCount = true
      await saveUserQueue(userId, userQueue)
      await send(chatId, `How many NEW (never-seen) leads do you want? Reply with a number, e.g. 30. Max 300.`)
      return res.status(200).send('OK')
    }

    // ── Awaiting how many NEW leads they want, for the search picked above ──
    if (userQueue.awaitingLeadCount) {
      const n = parseInt(text.replace(/[^0-9]/g, ''), 10)
      if (!n || n < 1) {
        await send(chatId, `Please reply with just a number, e.g. 30.`)
        return res.status(200).send('OK')
      }
      const wantCount = Math.min(n, 300)  // safety cap so a huge ask can't blow past Vercel's time limit

      userQueue.awaitingLeadCount = false
      userQueue.pendingSearch.wantCount = wantCount
      userQueue.awaitingLockedFilter = true
      await saveUserQueue(userId, userQueue)

      await sendKeyboard(chatId,
        `🔐 Include password-protected / "coming soon" stores in results? They won't have email/socials, but you'll get the name + link to search social media manually.`,
        [
          [{ text: '✅ Yes, show them', callback_data: 'lockedyes' }],
          [{ text: '🚫 No, skip them', callback_data: 'lockedno' }]
        ]
      )
      return res.status(200).send('OK')
    }

    // ── File upload — admin, or a purchased premium scrape ──
    if (doc) {
      if (userId !== ADMIN_ID) {
        const user = await getUser(userId)
        if (user.premiumScrapesRemaining <= 0) {
          await send(chatId, `📄 File uploads need a premium scrape. Buy one for ${PREMIUM_STARS_PRICE} Stars via /scout, or use /scout to claim free/bonus leads.`)
          return res.status(200).send('OK')
        }
        await setUserFields(userId, { premiumScrapesRemaining: user.premiumScrapesRemaining - 1 })
      }
      await send(chatId, '📄 Reading file...')
      const content = await getFileContent(doc.file_id)
      const extraBlacklistSet = await getExtraBlacklistSet()
      const rawLinks = extractAndCleanLinks(content, extraBlacklistSet)
      return await startBatchJob(chatId, userId, rawLinks, `file (${rawLinks.length} links)`)
    }

    // ── /autopitch — auto-generate personalized messages for hot (70+
    // scored) leads instead of typing each one by hand ──
    if (text === '/autopitch') {
      const usable = userQueue.results.filter(r => r.status === 'OK' && r.email !== 'no email' && (r.score || 0) >= 70)
      if (!usable.length) {
        await send(chatId,
          `No leads scoring 70+ with an email in your current results yet.\n` +
          `Run /scout first — score is based on SSL, site speed, and social presence. ` +
          `Quality filter is intentional: only the strongest pain-point matches get auto-pitched.`
        )
        return res.status(200).send('OK')
      }
      const niche = (userQueue.label || '').replace(/ niche$/i, '').toLowerCase() || 'ecommerce'
      const messages = usable.map(r => personalizedMessage(r, niche))
      await sendFinalPairs(chatId, usable, messages)

      userQueue.awaitingMessages = false
      userQueue.pending = []
      userQueue.results = []
      userQueue.messages = []
      await saveUserQueue(userId, userQueue)
      return res.status(200).send('OK')
    }

    // ── Awaiting outreach messages ──
    if (userQueue.awaitingMessages) {
      const withEmail = userQueue.results.filter(r => r.email !== 'no email')
      const parts = text.split('/').map(s => s.trim()).filter(Boolean)
      userQueue.messages.push(...parts)
      await saveUserQueue(userId, userQueue)

      const have = userQueue.messages.length
      const need = withEmail.length

      if (have < need) {
        await send(chatId,
          `Got ${have} message(s) so far. Need ${need - have} more ` +
          `(separate with /) for the ${need} leads with emails.`
        )
        return res.status(200).send('OK')
      }

      await sendFinalPairs(chatId, withEmail, userQueue.messages)
      userQueue.awaitingMessages = false
      userQueue.pending = []
      userQueue.results = []
      userQueue.messages = []
      await saveUserQueue(userId, userQueue)
      return res.status(200).send('OK')
    }

    // ── Any other message = continue processing next batch ──
    if (userQueue.pending.length > 0) {
      return await runBatch(chatId, userId, userQueue)
    }

    if (userQueue.results.length > 0 && !userQueue.awaitingMessages) {
      const withEmail = userQueue.results.filter(r => r.email !== 'no email')
      userQueue.awaitingMessages = true
      await saveUserQueue(userId, userQueue)
      await send(chatId,
        `✓ All done! ${userQueue.results.length} processed, ${withEmail.length} have emails.\n\n` +
        `Send your outreach messages now, separated by /.\n` +
        `Need at least ${withEmail.length} messages.`
      )
      return res.status(200).send('OK')
    }

    await send(chatId, 'Send a .txt/.csv file, or use /scout to pull fresh leads.')
    return res.status(200).send('OK')
  } finally {
    await releaseLock(userId)
  }

  // ══════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════

  function timeAgo(isoString) {
    if (!isoString) return 'unknown'
    const diffMs = Date.now() - new Date(isoString).getTime()
    const hours = diffMs / (1000 * 60 * 60)
    if (hours < 1) return 'less than an hour ago'
    if (hours < 24) return `${Math.floor(hours)}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  // Admin's FIRST /scout of the day also fills the shared free pool with up
  // to 30 leads — but admin still sees the FULL list either way, just with
  // whichever of those links are (still) sitting in today's pool flagged.
  // Dispatches a pendingSearch (built by /scout or /scoutlist) to the right
  // execution path, once both the lead count AND the locked-store
  // preference have been collected.
  async function executeSearch(chatId, userId, search, includeLocked) {
    const wantCount = search.wantCount

    if (search.isDirectList) {
      if (search.isPremium) {
        const user = await getUser(userId)
        if (user.premiumScrapesRemaining <= 0) {
          await send(chatId, `No premium scrapes left. Buy one for ${PREMIUM_STARS_PRICE} Stars via /scout.`)
          return res.status(200).send('OK')
        }
        await setUserFields(userId, { premiumScrapesRemaining: user.premiumScrapesRemaining - 1 })
      }
      const batchLinks = search.rawLinks.slice(0, wantCount)
      return await startBatchJob(chatId, userId, batchLinks, search.label, null, null, includeLocked)
    }

    if (search.isPremium) {
      const user = await getUser(userId)
      if (user.premiumScrapesRemaining <= 0) {
        await send(chatId, `No premium scrapes left. Buy one for ${PREMIUM_STARS_PRICE} Stars via /scout.`)
        return res.status(200).send('OK')
      }
      await setUserFields(userId, { premiumScrapesRemaining: user.premiumScrapesRemaining - 1 })
      return await startScoutJob(chatId, userId, search.query, search.label, wantCount, includeLocked)
    }

    return await adminScoutAndFillPoolIfNeeded(chatId, userId, search.query, search.label, wantCount, includeLocked)
  }

  async function adminScoutAndFillPoolIfNeeded(chatId, userId, query, label, wantCount, includeLocked) {
    const date = today()
    const { result: filledDate } = await redis('GET', 'poolFilledDate')

    await send(chatId, `🔍 Searching for ${wantCount} fresh leads — "${label}"... (paging until found or exhausted)`)
    const { urls: cleaned, filteredOut, scanTimes, total, newestScanTime, pagesUsed, gotEnough, exhaustedSource } =
      await scrapeUntilUnseen(query, wantCount, 4)

    if (total !== null) {
      await send(chatId,
        `📊 Found ${cleaned.length} new of ${wantCount} requested (searched ${pagesUsed} page(s), ${total} total matches on URLScan).` +
        (!gotEnough && exhaustedSource ? ` That's everything currently unseen for this niche — more appears as new sites get scanned.` : '') +
        (!gotEnough && !exhaustedSource ? ` Stopped early to stay within processing limits — try again for more, or ask for a smaller number.` : '') +
        (newestScanTime ? `\nMost recent scan seen: ${timeAgo(newestScanTime)}.` : '')
      )
    }

    if (filteredOut.length) {
      await saveFilteredOut(userId, filteredOut)
      const shown = filteredOut.slice(0, 20)
      const more = filteredOut.length > shown.length ? `\n…and ${filteredOut.length - shown.length} more` : ''
      await send(chatId,
        `🚫 <b>Filtered out</b> (blacklisted domains) — ${filteredOut.length} link(s), tap to check manually:\n\n` +
        shown.join('\n') + more + `\n\nSaved — retrieve anytime with /others.`
      )
    }

    if (filledDate !== date) {
      const forPool = cleaned.slice(0, 30)

      if (forPool.length) {
        await redis('RPUSH', `pool:${date}`, ...forPool)
        await redis('EXPIRE', `pool:${date}`, 172800)  // auto-clears in 2 days, no manual cleanup needed
      }
      await redis('SET', 'poolFilledDate', date)

      await send(chatId, `✓ Today's free pool refilled with ${forPool.length} leads (flagged 🔒 below).`)
    }

    // Whatever's currently still sitting in today's pool gets flagged in
    // admin's own list — this naturally shrinks over the day as free users
    // claim from it, which is accurate: it always shows what's STILL shared.
    const { result: poolNow } = await redis('LRANGE', `pool:${date}`, '0', '-1')
    const poolSet = new Set((poolNow || []).map(normalizeForDedupe))

    return await startBatchJob(chatId, userId, cleaned, label, poolSet, scanTimes, includeLocked)
  }

  // Free users pull straight from today's shared pool — no live search
  // access, no queue/continue flow, just one immediate capped batch per
  // tap. Restricted fields only: link + email, no name/socials/contact.
  async function claimFromPool(chatId, userId) {
    const date = today()
    const { result: popped } = await redis('LPOP', `pool:${date}`, String(BATCH_SIZE))

    if (!popped || !popped.length) {
      await send(chatId,
        `😔 Today's free leads are all claimed.\n` +
        `Check back tomorrow, or refer friends (/invite) for +10 bonus leads each.`
      )
      return res.status(200).send('OK')
    }

    const dedupeKeys = popped.map(normalizeForDedupe)
    const seenMap = await getSeenBatch(dedupeKeys)
    const fresh = popped.filter((u, i) => !seenMap[dedupeKeys[i]])

    const results = fresh.length ? await processBatch(fresh) : []
    const seenEntries = results.map(r => [
      normalizeForDedupe(r.url),
      { status: r.status, email: r.email, checkedAt: new Date().toISOString() }
    ])
    await markSeenBatch(seenEntries)

    const withEmail = results.filter(r => r.email !== 'no email')
    let reply = `🎁 <b>Free leads:</b> ${results.length} checked, ${withEmail.length} have emails.`
    withEmail.forEach((r, i) => {
      reply += `\n\n<b>${i + 1}.</b> ${r.url}\n    📧 ${r.email}`
    })

    const { result: remaining } = await redis('LLEN', `pool:${date}`)
    reply += (remaining && remaining > 0)
      ? `\n\n────────\n${remaining} free leads left today. Send /scout again to claim more.`
      : `\n\n────────\nThat's it — today's free pool is fully claimed. New leads tomorrow, or refer friends (/invite) for +10 bonus leads each.`

    await send(chatId, reply)
    return res.status(200).send('OK')
  }

  // Referral-earned bonus leads — a personal top-up separate from the shared
  // pool (so one referrer claiming theirs doesn't eat into what's left for
  // everyone else). Still restricted format: link + email only, never
  // full-detail — that stays admin-only regardless of referrals.
  async function claimBonusLeads(chatId, userId) {
    const user = await getUser(userId)
    if (user.bonusLeadsRemaining <= 0) {
      await send(chatId, `No bonus leads left. Refer more friends (/invite) to earn +10 each.`)
      return res.status(200).send('OK')
    }

    const want = Math.min(BATCH_SIZE, user.bonusLeadsRemaining)
    await send(chatId, `🔍 Pulling your bonus leads...`)

    const { urls: batch } = await scrapeUntilUnseen(SAVED_SEARCHES['1'].query, want, 4)

    if (!batch.length) {
      await send(chatId, `Couldn't find any new leads right now — try again shortly.`)
      return res.status(200).send('OK')
    }

    const results = await processBatch(batch)
    const seenEntries = results.map(r => [
      normalizeForDedupe(r.url),
      { status: r.status, email: r.email, checkedAt: new Date().toISOString() }
    ])
    await markSeenBatch(seenEntries)

    const newRemaining = user.bonusLeadsRemaining - batch.length
    await setUserFields(userId, { bonusLeadsRemaining: newRemaining })

    const withEmail = results.filter(r => r.email !== 'no email')
    let reply = `⭐ <b>Bonus leads:</b> ${results.length} checked, ${withEmail.length} have emails.`
    withEmail.forEach((r, i) => {
      reply += `\n\n<b>${i + 1}.</b> ${r.url}\n    📧 ${r.email}`
    })

    reply += newRemaining > 0
      ? `\n\n────────\n${newRemaining} bonus leads left. Send /scout again to claim more.`
      : `\n\n────────\nAll bonus leads claimed! Refer more friends (/invite) to earn more.`

    await send(chatId, reply)
    return res.status(200).send('OK')
  }

  async function startScoutJob(chatId, userId, query, label, wantCount, includeLocked) {
    await send(chatId, `🔍 Searching for ${wantCount} fresh leads — "${label}"... (paging until found or exhausted)`)
    const { urls: cleaned, filteredOut, scanTimes, total, newestScanTime, pagesUsed, gotEnough, exhaustedSource } =
      await scrapeUntilUnseen(query, wantCount, 4)

    if (total !== null) {
      await send(chatId,
        `📊 Found ${cleaned.length} new of ${wantCount} requested (searched ${pagesUsed} page(s), ${total} total matches on URLScan).` +
        (!gotEnough && exhaustedSource ? ` That's everything currently unseen for this niche.` : '') +
        (!gotEnough && !exhaustedSource ? ` Stopped early to stay within processing limits — try again for more.` : '') +
        (newestScanTime ? `\nMost recent scan seen: ${timeAgo(newestScanTime)}.` : '')
      )
    }

    if (filteredOut.length) {
      await saveFilteredOut(userId, filteredOut)
      const shown = filteredOut.slice(0, 20)
      const more = filteredOut.length > shown.length ? `\n…and ${filteredOut.length - shown.length} more` : ''
      await send(chatId,
        `🚫 <b>Filtered out</b> (blacklisted domains) — ${filteredOut.length} link(s), tap to check manually:\n\n` +
        shown.join('\n') + more + `\n\nSaved — retrieve anytime with /others.`
      )
    }

    return await startBatchJob(chatId, userId, cleaned, label, null, scanTimes, includeLocked)
  }

  async function startBatchJob(chatId, userId, rawLinks, sourceLabel, poolSet, scanTimes, includeLocked) {
    if (!rawLinks.length) {
      await send(chatId, `No links found from ${sourceLabel}.`)
      return res.status(200).send('OK')
    }

    const dedupeKeys = rawLinks.map(normalizeForDedupe)
    const seenMap = await getSeenBatch(dedupeKeys)
    const newLinks = rawLinks.filter((u, i) => !seenMap[dedupeKeys[i]])
    const alreadySeen = rawLinks.length - newLinks.length

    if (!newLinks.length) {
      await send(chatId, `✓ Got ${rawLinks.length} from ${sourceLabel} — all already checked before. Nothing new.`)
      return res.status(200).send('OK')
    }

    const userQueue = {
      pending: newLinks, results: [], awaitingMessages: false, messages: [],
      poolUrls: poolSet ? [...poolSet] : [],
      scanTimes: scanTimes || {},
      label: sourceLabel || '',
      includeLocked: !!includeLocked
    }
    await saveUserQueue(userId, userQueue)

    await send(chatId,
      `✓ ${sourceLabel}: found ${rawLinks.length} links (${alreadySeen} already seen, skipped).\n` +
      `${newLinks.length} new to process.\n\nProcessing first batch of ${BATCH_SIZE}...`
    )

    return await runBatch(chatId, userId, userQueue)
  }

  async function runBatch(chatId, userId, userQueue) {
    const batch = userQueue.pending.slice(0, BATCH_SIZE)
    userQueue.pending = userQueue.pending.slice(BATCH_SIZE)

    const results = await processBatch(batch)
    userQueue.results.push(...results)

    const seenEntries = results.map(r => [
      normalizeForDedupe(r.url),
      { status: r.status, email: r.email, checkedAt: new Date().toISOString() }
    ])
    await markSeenBatch(seenEntries)
    await saveUserQueue(userId, userQueue)

    const includeLocked = !!userQueue.includeLocked

    const usable = results
      .filter(r => r.status === 'OK' && (
        r.isPasswordProtected
          ? includeLocked
          : (r.email !== 'no email' || r.contact_page || Object.keys(r.socials || {}).length)
      ))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
    const remaining = userQueue.pending.length
    const poolUrlSet = new Set(userQueue.poolUrls || [])
    const scanTimeMap = userQueue.scanTimes || {}

    const lockedCount = usable.filter(r => r.isPasswordProtected).length
    const hotCount = usable.filter(r => r.score >= 70).length
    let reply = `✓ <b>Batch done:</b> ${results.length} checked, ${usable.length} reachable, ${hotCount} 🔥 hot (70+)` +
      (lockedCount ? `, ${lockedCount} 🔐 locked` : '') + `.\n`
    let leadNum = 0
    usable.forEach(r => {
      leadNum++
      const inPool = poolUrlSet.has(normalizeForDedupe(r.url))
      const poolFlag = inPool ? `\n    🔒 <b>IN FREE POOL</b> — also shown to free users` : ''
      const nameLine = r.store_name ? `${r.store_name}\n    🔗 ${r.url}` : `🔗 ${r.url}`
      const scanTime = scanTimeMap[r.url]
      const scanNote = scanTime ? `\n    🕐 site scanned: ${timeAgo(scanTime)}` : ''

      if (r.isPasswordProtected) {
        reply += `\n\n<b>${leadNum}.</b> ${nameLine}\n    🔐 <b>PASSWORD PROTECTED / NOT OPEN YET</b> — no email/socials from the site itself. Search "${r.store_name || 'this store'}" on social media manually.${scanNote}${poolFlag}`
        return
      }

      const socialsList = Object.entries(r.socials || {}).map(([k, v]) => `${k}: ${v}`).join('\n              ')
      const socialsNote = socialsList ? `\n    💬 social: ${socialsList}` : ''

      const contactNote = r.contact_page ? `\n    🌐 contact page: ${r.contact_page}` : ''

      const genericNote = r.email_is_generic ? ' (generic)' : ''
      const emailNote = r.email !== 'no email' ? `\n    📧 ${r.email}${genericNote} (in case)` : ''

      const hotTag = r.score >= 70 ? ' 🔥' : ''
      const scoreNote = `\n    📊 score: ${r.score}${hotTag}` + (r.scoreReasons?.length ? ` (${r.scoreReasons.join(', ')})` : '')

      const hook = auditHookLine(r)
      const hookNote = hook ? `\n    💡 ${hook}` : ''

      reply += `\n\n<b>${leadNum}.</b> ${nameLine}${scoreNote}${hookNote}${socialsNote}${contactNote}${emailNote}${scanNote}${poolFlag}`
    })

    if (remaining > 0) {
      reply += `\n\n────────\n${remaining} links remaining. Send anything to continue.`
    } else {
      const totalUsable = userQueue.results.filter(r => r.status === 'OK' && (r.email !== 'no email' || r.contact_page || Object.keys(r.socials || {}).length)).length
      reply += `\n\n────────\n✓ ALL DONE! ${userQueue.results.length} total processed, ${totalUsable} reachable.\n` +
               `Send anything to move to the message-writing step.`
    }

    await send(chatId, reply)
    return res.status(200).send('OK')
  }

  async function sendFinalPairs(chatId, leads, messages) {
    const lines = []
    leads.forEach((lead, i) => {
      const msg = messages[i % messages.length]
      lines.push(`${lead.email}\n${msg}`)
    })

    let chunk = `📋 <b>Ready to send — copy each pair:</b>\n\n`
    for (const line of lines) {
      if ((chunk + line + '\n\n').length > 3800) {
        await send(chatId, chunk)
        chunk = ''
      }
      chunk += line + '\n\n'
    }
    if (chunk.trim()) await send(chatId, chunk)
  }
}
