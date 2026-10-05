// api/scraper_bot.js
// Personal Telegram lead-scraper bot — hosted on Vercel
// v4: admin lock, audit log, /fresh as automatic tick switch, relay-aware age lookups

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'GET') return res.status(200).send('OK')

  const BOT_TOKEN = process.env.SCRAPER_BOT_TOKEN || ''
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

  // Only this Telegram user ID may use the bot. Set SCRAPER_ADMIN_ID in Vercel.
  const ADMIN_ID = process.env.SCRAPER_ADMIN_ID || ''

  // Optional crt.sh relay (Cloudflare Worker) for when Vercel's IPs get blocked.
  const CRTSH_BASE = process.env.CRTSH_RELAY_URL || 'https://crt.sh/json'

  // Optional — lets a /find job trigger the GitHub Actions daemon immediately.
  const GITHUB_DISPATCH_TOKEN = process.env.GITHUB_DISPATCH_TOKEN || ''
  const GITHUB_OWNER = process.env.GITHUB_OWNER || ''
  const GITHUB_REPO  = process.env.GITHUB_REPO  || ''
  const GITHUB_WORKFLOW_FILE = process.env.GITHUB_WORKFLOW_FILE || 'daemon.yml'

  // Free official Companies House API key — developer.company-information.service.gov.uk
  // (register -> create an application -> "Create new key", REST API key type)
  const COMPANIES_HOUSE_API_KEY = process.env.COMPANIES_HOUSE_API_KEY || ''

  const BATCH_SIZE  = 8
  const CONCURRENCY = 4

  const SAVED_SEARCHES = {
    '1': { label: 'All myshopify.com (newest first)', query: 'page.domain:myshopify.com' },
    '2': { label: 'Skincare/beauty niche',            query: 'page.domain:myshopify.com AND page.title:(skincare OR beauty OR cosmetics)' },
    '3': { label: 'Jewelry niche',                     query: 'page.domain:myshopify.com AND page.title:jewelry' },
    '4': { label: 'Pet products niche',                query: 'page.domain:myshopify.com AND page.title:pet' },
    '5': { label: 'Fashion/clothing niche',             query: 'page.domain:myshopify.com AND page.title:(fashion OR clothing OR apparel)' },
  }

  const LEAD_STATUSES = ['new', 'contacted', 'replied', 'interested', 'not_interested', 'do_not_contact', 'client']

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { return res.status(200).send('OK') } }
  if (!body) return res.status(200).send('OK')

  async function answerCallback(callbackQueryId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId })
      })
    } catch (e) { console.error('answerCallback error:', e.message) }
  }

  async function send(chatId, text) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
      })
      const d = await r.json()
      if (!d.ok) console.error('Telegram send failed:', d.description)
    } catch (e) { console.error('Send error:', e.message) }
  }

  function sendKeyboard(chatId, text, keyboard) {
    return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, reply_markup: { inline_keyboard: keyboard } })
    }).catch(e => console.error('Keyboard error:', e.message))
  }

  async function getFileContent(fileId) {
    try {
      const r  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`)
      const d  = await r.json()
      const fr = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${d.result.file_path}`)
      return await fr.text()
    } catch { return '' }
  }

  // ── Redis ──
  async function triggerGithubWorkflow() {
    if (!GITHUB_DISPATCH_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
      console.log('GitHub dispatch not configured — skipping, cron will catch it')
      return false
    }
    try {
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${GITHUB_DISPATCH_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main' })
        }
      )
      if (r.status === 204) return true
      console.error('GitHub dispatch failed:', r.status, await r.text())
      return false
    } catch (e) {
      console.error('GitHub dispatch error:', e.message)
      return false
    }
  }

  async function redis(...args) {
    try {
      const r = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
      })
      const d = await r.json()
      if (d.error) { console.error('Redis error:', d.error); return { ok: false, result: null } }
      return { ok: true, result: d.result }
    } catch (e) {
      console.error('Redis unreachable:', e.message)
      return { ok: false, result: null }
    }
  }

  async function getSeenBatch(keys) {
    if (!keys.length) return {}
    const { result: vals } = await redis('HMGET', 'seen', ...keys)
    const out = {}
    if (vals) keys.forEach((k, i) => { if (vals[i]) out[k] = JSON.parse(vals[i]) })
    return out
  }

  async function markSeenBatch(entries) {
    if (!entries.length) return
    const flat = entries.flatMap(([k, v]) => [k, JSON.stringify(v)])
    await redis('HSET', 'seen', ...flat)
  }

  async function getUserQueue(userId) {
    const { result: v } = await redis('GET', `queue:${userId}`)
    return v ? JSON.parse(v) : { pending: [], results: [], awaitingMessages: false, messages: [], awaitingCustomQuery: false, awaitingReviewCap: false, awaitingCompanyList: false, pendingFindJob: null }
  }

  async function saveUserQueue(userId, queue) {
    await redis('SET', `queue:${userId}`, JSON.stringify(queue))
  }

  async function saveFilteredOut(userId, list) {
    await redis('SET', `filtered:${userId}`, JSON.stringify(list))
  }

  async function getFilteredOut(userId) {
    const { result } = await redis('GET', `filtered:${userId}`)
    return result ? JSON.parse(result) : []
  }

  async function acquireLock(userId) {
    const { ok, result } = await redis('SET', `lock:${userId}`, '1', 'NX', 'EX', '25')
    if (!ok) return true
    return result === 'OK'
  }

  async function releaseLock(userId) {
    await redis('DEL', `lock:${userId}`)
  }

  // ══════════════════════════════════════════════
  //  ACCESS TIERS — owner / paid pass / bring-your-own-cookies
  //  Session-heavy commands (/findco, /find, /scout, /fresh...) run on a
  //  logged-in Google session. A stranger can use them two ways:
  //    paid  — a pass bought from the owner (shared session, shared budget)
  //    byoc  — they uploaded their own google.com cookies (their session,
  //            their own rate budget — the owner's is never touched)
  // ══════════════════════════════════════════════
  const PASS_DAYS = parseInt(process.env.ACCESS_PASS_DAYS || '30')
  const ACCESS_PRICE = process.env.ACCESS_PRICE_TEXT || '$1'
  const PAYMENT_LINK = process.env.PAYMENT_LINK || ''
  const OWNER_SESSION_CMDS = ['/find', '/findco', '/scout', '/fresh', '/freshoff', '/scoutlist', '/autopitch']

  async function passInfo(userId) {
    const { result } = await redis('GET', `pass:${userId}`)
    if (!result) return { valid: false, expires: 0 }
    const exp = parseInt(result) || 0
    return { valid: exp > Date.now(), expires: exp }
  }

  async function cookieInfo(userId) {
    const { result } = await redis('GET', `cookies:${userId}:meta`)
    if (!result) return { present: false, fresh: false, expires: 0 }
    try {
      const m = JSON.parse(result)
      const exp = parseInt(m.expires) || 0
      return { present: true, fresh: exp > Date.now() / 1000 + 86400, expires: exp }
    } catch { return { present: false, fresh: false, expires: 0 } }
  }

  async function tierOf(userId) {
    if (isOwner) return 'owner'
    if ((await passInfo(userId)).valid) return 'paid'
    if ((await cookieInfo(userId)).fresh) return 'byoc'
    return 'none'
  }

  async function grantPass(userId, days = PASS_DAYS) {
    await redis('SET', `pass:${userId}`, String(Date.now() + days * 86400000))
  }

  // Is this uploaded file a cookie export (Cookie-Editor or Playwright)?
  function sniffCookies(text) {
    try {
      const arr = JSON.parse(text)
      if (!Array.isArray(arr) || !arr.length) return null
      if (!arr.every(c => c && typeof c === 'object' && 'name' in c && 'value' in c && 'domain' in c)) return null
      const domains = arr.map(c => String(c.domain || '').toLowerCase())
      if (domains.some(d => d.includes('google.'))) return { kind: 'google' }
      return null
    } catch { return null }
  }

  function cookieExpiry(arr) {
    let exp = 0
    for (const c of arr) {
      const e = parseFloat(c.expirationDate || c.expires || 0)
      if (e > exp) exp = e
    }
    return exp
  }

  async function sendAccessScreen(chatId, userId) {
    const pass = await passInfo(userId)
    const ck = await cookieInfo(userId)
    let status = 'No access yet.'
    if (pass.valid) status = `Paid pass active until ${new Date(pass.expires).toISOString().slice(0, 10)}.`
    else if (ck.present) status = ck.fresh
      ? `Your own cookies are on file (freshest expires ${new Date(ck.expires * 1000).toISOString().slice(0, 10)}).`
      : 'Your saved cookies have expired — re-send the file to refresh.'
    const kb = []
    if (PAYMENT_LINK) kb.push([B(`💳 Get a ${PASS_DAYS}-day pass (${ACCESS_PRICE})`, 'pay:request')])
    kb.push([B('🍪 Use my own Google cookies (free)', 'pay:byoc')])
    kb.push([B('🏠 Main menu', 'menu:main')])
    await tgCall('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text:
        `<b>🔒 This feature runs on a logged-in Google session</b>

` +
        `Two ways in:
` +
        `1️⃣ Pay ${ACCESS_PRICE} → a ${PASS_DAYS}-day pass on the shared session
` +
        `2️⃣ Upload your own google.com cookies (free, your own limits) — export with the ` +
        `Cookie-Editor extension while logged into google.com, then send the .json file here

` +
        `<b>Your status:</b> ${status}`,
      reply_markup: { inline_keyboard: kb }
    })
  }

  async function gateOwnerSession(chatId, userId) {
    if (isOwner) return true
    const tier = await tierOf(userId)
    if (tier === 'paid' || tier === 'byoc') return true
    await sendAccessScreen(chatId, userId)
    return false
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

  async function getExtraBlacklistSet() {
    const { result } = await redis('SMEMBERS', 'blacklist:extra')
    return new Set(result || [])
  }

  async function addToBlacklist(domains) {
    if (!domains.length) return 0
    await redis('SADD', 'blacklist:extra', ...domains)
    return domains.length
  }

  function parseBlacklistText(text) {
    const domains = new Set()
    for (let raw of text.split('\n')) {
      let line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith(';')) continue
      line = line.replace(/^\|\|/, '').replace(/\^$/, '').replace(/^\*\./, '')
      line = line.split(/\s+/).pop()
      if (line && line.includes('.') && !line.includes('/') && !line.includes('*')) {
        domains.add(line.toLowerCase().replace(/^www\./, ''))
      }
      if (domains.size >= 20000) break
    }
    return [...domains]
  }

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

  // ── Email + contact + socials ──
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

  // Official, free Companies House "advanced search" — the one API endpoint
  // that's genuinely built for this (unlike crt.sh's wildcard search, this
  // is a documented, supported query pattern with a real 600-req/5min
  // budget, not something we're working around). Auth is HTTP Basic with
  // the API key as the username and an empty password — that's the
  // spec's own convention, not a workaround.
  async function fetchNewUKCompanies(fromDate, toDate, size) {
    const params = new URLSearchParams({
      incorporated_from: fromDate,
      incorporated_to: toDate,
      size: String(Math.min(Math.max(size, 1), 5000)),
    })
    const url = `https://api.company-information.service.gov.uk/advanced-search/companies?${params}`
    const auth = Buffer.from(`${COMPANIES_HOUSE_API_KEY}:`).toString('base64')
    try {
      const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
      if (!r.ok) {
        console.error('Companies House error:', r.status, await r.text().catch(() => ''))
        return null
      }
      return await r.json()
    } catch (e) {
      console.error('Companies House fetch failed:', e.message)
      return null
    }
  }

  // Parses a pasted or fetched company list into [{name, location, company_number}].
  // Understands "Name, City" / "Name | City" / bare names, numbered lines,
  // raw /newuk output, and even the junk around a sloppy copy-paste
  // (chat headers, browser link-previews, other bot replies). A line only
  // counts as a company if it looks like one — ALL-CAPS or carrying a
  // company suffix — which automatically skips addresses, dates, bot
  // chatter, and link previews. find-and-update links attach their
  // company number to the nearest company name.
  function looksLikeCompany(line) {
    const letters = line.replace(/[^a-zA-Z]/g, '')
    if (letters.length < 3) return false
    const upperRatio = letters.replace(/[^A-Z]/g, '').length / letters.length
    if (/\b(LTD|LIMITED|LLP|PLC|LLC|INC|LP)\b\.?$/.test(line)) return true
    if (upperRatio > 0.85) return true                    // PEAKWOOD LIMITED / WIDGETCO
    const words = line.split(/\s+/)
    const addressish = /\b(farm|road|rd|street|st\b|lane|ln|avenue|ave|court|ct|flat|apartment|apt|house|view|building|drive|dr|close|place|square|terrace|grove|way|park|estate|high\s?street)\b/i
    if (words.length >= 2 && words.length <= 5 && !/\d/.test(line)
        && /^[A-Z][a-zA-Z&'.\-]*(\s+[A-Z][a-zA-Z&'.\-]*)+$/.test(line)
        && !addressish.test(line)) return true            // Title Case names
    return false
  }

  function parseCompanyLines(raw) {
    const JUNK = [/total hits/i, /new UK compan/i, /overview - find/i,
      /free company information/i, /find-and-update/i,
      /company-information\.service\.gov\.uk/i, /job posted/i,
      /scraping google maps/i, /review cap/i, /reply with a number/i,
      /no leads collected/i, /results will land/i, /triggered github/i,
      /what's the max/i, /captcha/i, /^skip$/i, /try again later/i,
      /takes a while/i, /up to \d+ leads/i, /more reviews/i,
      /incorporated:/i, /^ltd\.?$/i]
    const companies = []
    const byName = new Map()
    let pendingNumber = ''
    const attach = (num) => {
      for (let i = companies.length - 1; i >= 0; i--) {
        if (!companies[i].company_number) { companies[i].company_number = num; break }
        break  // only the most recent company is eligible
      }
      pendingNumber = ''   // consumed — never leaks into the next company
    }
    for (let rawLine of raw.split('\n')) {
      const numMatch = rawLine.match(/company\/([A-Z0-9]{6,10})/i)
      if (numMatch) {
        pendingNumber = numMatch[1].toUpperCase()
        attach(pendingNumber)
      }
      let line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      if (/^https?:\/\//.test(line)) continue
      if (line.startsWith('/')) continue                   // pasted bot commands
      line = line.replace(/^[^\w(]+/, '').replace(/^\d+[.)]\s*/, '').trim()
      if (!line) continue
      if (JUNK.some(rx => rx.test(line))) continue
      if (line.length > 70) continue                       // sentences, not names
      if (/^[([\]].*[)\]]?$/.test(line) && line.length < 40) continue
      if (/^[\w.-]+\.[a-z]{2,}(\.[a-z]{2,})?$/.test(line)) continue
      if (/^[^\w]/.test(line)) continue

      let name = line, location = 'UK'
      if (line.includes('|')) {
        const parts = line.split('|').map(s => s.trim())
        name = parts[0]
        if (parts[1]) location = parts.slice(1).join(', ')
      } else if (line.includes(',')) {
        const idx = line.lastIndexOf(',')
        const maybeLoc = line.slice(idx + 1).trim()
        if (maybeLoc && maybeLoc.length <= 60 && !/^\d+$/.test(maybeLoc)
            && !/^(ltd|limited|llp|plc|inc|llc|uk)$/i.test(maybeLoc)) {
          name = line.slice(0, idx).trim()
          location = maybeLoc
        }
      }
      if (!looksLikeCompany(name)) continue
      const key = name.toLowerCase().replace(/\s+/g, ' ').trim()
      if (byName.has(key)) {
        const e = byName.get(key)
        if (pendingNumber && !e.company_number) e.company_number = pendingNumber
        if (e.location === 'UK' && location !== 'UK') e.location = location
      } else {
        const entry = { name, location, company_number: pendingNumber }
        companies.push(entry)
        byName.set(key, entry)
      }
      pendingNumber = ''
      if (companies.length >= 500) break
    }
    return companies
  }

  async function postDiscoveryJob(chatId, userId, companies) {
    const jobId = `co-${Date.now()}`
    await redis('RPUSH', 'jobs:find', JSON.stringify({
      type: 'discovery', chat_id: chatId, job_id: jobId, companies, max: 40,
      user_id: userId          // empty for owner; daemon loads THEIR cookies if set
    }))
    const dispatched = await triggerGithubWorkflow()
    await send(chatId,
      `✅ Discovery job posted: ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} ` +
      `(job ${jobId}).\n` +
      (dispatched
        ? `Triggered GitHub Actions immediately — should start within a minute or two.\n`
        : `Make sure the daemon is running, or wait for the next scheduled run.\n`) +
      `Per company: Companies House directors → Google (name, town, contact, socials) → their website → Maps (name only) → each director on Google/LinkedIn. ` +
      `~15-25 companies/hour (shared Google budget), cached 30 days; leftovers resume automatically. Results arrive here as they're found.`)
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
    } catch (e) { return null }
  }

  // A store's real age = its EARLIEST certificate ever (including expired
  // ones) — not the "Not Before" of whichever cert crt.sh shows first, which
  // is just the latest ~90-day renewal. Only myshopify.com hosts qualify,
  // and since a store's birthday never changes we cache it in Redis forever.
  // Failures are cached for 6h (-1) so a flaky crt.sh doesn't stall every
  // future batch on the same domain. Uses CRTSH_RELAY_URL when set.
  async function getStoreAgeDays(url) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
    if (!host.endsWith('.myshopify.com')) return null
    const cacheKey = `age:${host}`
    const { result: cached } = await redis('GET', cacheKey)
    if (cached !== null && cached !== undefined) {
      const v = JSON.parse(cached)
      return v === -1 ? null : v
    }
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 6000)
      const r = await fetch(`${CRTSH_BASE}?q=${encodeURIComponent(host)}`, {
        signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' }
      })
      clearTimeout(t)
      if (!r.ok) { await redis('SET', cacheKey, '-1', 'EX', 21600); return null }
      const rows = await r.json()
      let earliest = null
      for (const row of rows || []) {
        const nb = row.not_before ? Date.parse(row.not_before) : NaN
        if (!isNaN(nb) && (earliest === null || nb < earliest)) earliest = nb
      }
      if (earliest === null) { await redis('SET', cacheKey, '-1', 'EX', 21600); return null }
      const age = Math.floor((Date.now() - earliest) / 86400000)
      await redis('SET', cacheKey, JSON.stringify(age))
      return age
    } catch { return null }
  }

  function scoreLead(r) {
    if (r.status !== 'OK') return { score: 0, reasons: [] }
    let score = 0
    const reasons = []

    if (r.sslValid === false) { score += 25; reasons.push('no SSL (http only)') }

    if (typeof r.ageDays === 'number') {
      if (r.ageDays <= 30) { score += 20; reasons.push(`brand-new store (${r.ageDays}d old)`) }
      else if (r.ageDays <= 90) { score += 10; reasons.push(`new store (${r.ageDays}d old)`) }
    }

    if (typeof r.loadSeconds === 'number') {
      if (r.loadSeconds >= 8) { score += 45; reasons.push(`very slow site (${r.loadSeconds.toFixed(1)}s load)`) }
      else if (r.loadSeconds >= 5) { score += 30; reasons.push(`slow site (${r.loadSeconds.toFixed(1)}s load)`) }
    }

    const socialCount = Object.keys(r.socials || {}).length
    if (socialCount >= 1) { score += 15; reasons.push('active on social media') }

    if (r.email === 'no email' && (r.contact_page || socialCount)) {
      score += 10; reasons.push('hard to reach directly — likely small/DIY setup')
    }

    return { score: Math.min(score, 100), reasons }
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
      sslValid: null, loadSeconds: null, ageDays: null, score: 0, scoreReasons: [],
      isPasswordProtected: false
    }
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 5000)
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: controller.signal, redirect: 'follow',
      })
      clearTimeout(t)
      if (![200,401,403].includes(r.status)) return result
      result.status = 'OK'
      result.sslValid = url.startsWith('https://')
      const speedPromise = getSpeedIndexSeconds(url)
      const agePromise = getStoreAgeDays(url)
      const html = await r.text()

      if (html.includes('myshopify.com') || html.includes('cdn.shopify.com')) result.store_type = 'Shopify'
      else if (html.includes('woocommerce')) result.store_type = 'WooCommerce'
      else if (html.includes('wp-content')) result.store_type = 'WordPress'
      else if (html.includes('wixsite.com') || html.includes('wixstatic.com')) result.store_type = 'Wix'
      else if (html.includes('squarespace.com')) result.store_type = 'Squarespace'
      else result.store_type = 'Custom/Other'

      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      if (titleMatch) result.store_name = titleMatch[1].split(/[–|—]/)[0].trim().slice(0, 60)

      const finalUrl = r.url || url
      result.isPasswordProtected = (
        r.status === 401 || finalUrl.includes('/password') ||
        html.includes('shopify-section-password') ||
        /this (store|shop) (will be back soon|is currently password protected)/i.test(html) ||
        /enter (using )?password/i.test(html) || /opening soon/i.test(html)
      )

      result.socials = extractSocials(html)
      const homeEmails = cleanEmails(html)

      if (homeEmails.length) {
        const chosen = bestEmail(homeEmails)
        result.email = chosen
        result.email_is_generic = isGenericEmail(chosen)
        if (result.email_is_generic) result.contact_page = url.replace(/\/$/, '') + '/pages/contact'
      } else {
        const base = url.replace(/\/$/, '')
        const fallbackPages = [base + '/pages/contact', base + '/pages/contact-us', base + '/pages/about', base + '/policies/privacy-policy']
        const fallbackResults = await Promise.all(fallbackPages.map(async (pageUrl) => {
          try {
            const r = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(3500) })
            if (!r.ok) return { pageUrl, emails: [], exists: false }
            const pageHtml = await r.text()
            return { pageUrl, emails: cleanEmails(pageHtml), exists: true }
          } catch { return { pageUrl, emails: [], exists: false } }
        }))
        const withEmail = fallbackResults.find(r => r.emails.length > 0)
        if (withEmail) {
          result.email = bestEmail(withEmail.emails)
          result.email_is_generic = isGenericEmail(result.email)
          result.email_source = withEmail.pageUrl
        } else {
          const anyContactPage = fallbackResults.find(r => r.exists && r.pageUrl.includes('contact'))
          if (anyContactPage) result.contact_page = anyContactPage.pageUrl
        }
      }

      result.loadSeconds = await speedPromise
      result.ageDays = await agePromise
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
      const chunkResults = await Promise.all(chunk.map(url => checkOneStore(url)))
      results.push(...chunkResults)
    }
    return results
  }

  function timeAgo(isoString) {
    if (!isoString) return 'unknown'
    const diffMs = Date.now() - new Date(isoString).getTime()
    const hours = diffMs / (1000 * 60 * 60)
    if (hours < 1) return 'less than an hour ago'
    if (hours < 24) return `${Math.floor(hours)}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  // ── URLSCAN.IO ──
  async function fetchUrlscanPage(query, searchAfter) {
    let apiUrl = `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=100`
    if (searchAfter) apiUrl += `&search_after=${searchAfter}`
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 5000)
      const r = await fetch(apiUrl, { signal: controller.signal })
      clearTimeout(t)
      return await r.json()
    } catch (e) { return null }
  }

  async function scrapeUntilUnseen(query, wantCount, maxPages = 4) {
    const unseenUrls = []
    const filteredOut = []
    const scanTimes = {}
    const seenThisRun = new Set()
    let searchAfter = null, total = null, newestScanTime = null, pagesUsed = 0, exhausted = false
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
        const url = domain ? `https://${domain}` : (item.page?.url || item.task?.url)
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
      if (data.results.length < 100) { exhausted = true; break }
    }

    return { urls: unseenUrls.slice(0, wantCount), filteredOut, scanTimes, total, newestScanTime, pagesUsed, gotEnough: unseenUrls.length >= wantCount, exhaustedSource: exhausted }
  }

  async function startScoutJob(chatId, userId, query, label, wantCount, includeLocked) {
    await send(chatId, `🔍 Searching for ${wantCount} fresh leads — "${label}"...`)
    const { urls: cleaned, filteredOut, scanTimes, total, newestScanTime, pagesUsed, gotEnough, exhaustedSource } =
      await scrapeUntilUnseen(query, wantCount, 4)

    if (total !== null) {
      await send(chatId,
        `📊 Found ${cleaned.length} new of ${wantCount} requested (searched ${pagesUsed} page(s), ${total} total matches).` +
        (!gotEnough && exhaustedSource ? ` That's everything currently unseen.` : '') +
        (!gotEnough && !exhaustedSource ? ` Stopped early to stay within limits.` : '') +
        (newestScanTime ? `\nMost recent scan: ${timeAgo(newestScanTime)}.` : '')
      )
    }

    if (filteredOut.length) {
      await saveFilteredOut(userId, filteredOut)
      const shown = filteredOut.slice(0, 20)
      const more = filteredOut.length > shown.length ? `\n…and ${filteredOut.length - shown.length} more` : ''
      await send(chatId, `🚫 Filtered out — ${filteredOut.length} link(s):\n\n` + shown.join('\n') + more + `\n\nSaved — retrieve with /others.`)
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
      await send(chatId, `✓ ${rawLinks.length} from ${sourceLabel} — all already checked. Nothing new.`)
      return res.status(200).send('OK')
    }

    const userQueue = { pending: newLinks, results: [], awaitingMessages: false, messages: [], awaitingCustomQuery: false, label: sourceLabel || '', includeLocked: !!includeLocked }
    await saveUserQueue(userId, userQueue)

    await send(chatId, `✓ ${sourceLabel}: found ${rawLinks.length} links (${alreadySeen} already seen, skipped).\n${newLinks.length} new to process.\n\nProcessing first batch of ${BATCH_SIZE}...`)
    return await runBatch(chatId, userId, userQueue)
  }

  async function runBatch(chatId, userId, userQueue) {
    const batch = userQueue.pending.slice(0, BATCH_SIZE)
    userQueue.pending = userQueue.pending.slice(BATCH_SIZE)

    const results = await processBatch(batch)
    userQueue.results.push(...results)

    const seenEntries = results.map(r => [normalizeForDedupe(r.url), { status: r.status, email: r.email, checkedAt: new Date().toISOString() }])
    await markSeenBatch(seenEntries)
    await saveUserQueue(userId, userQueue)

    const includeLocked = !!userQueue.includeLocked
    const usable = results.filter(r => r.status === 'OK' && (r.isPasswordProtected ? includeLocked : (r.email !== 'no email' || r.contact_page || Object.keys(r.socials || {}).length))).sort((a, b) => (b.score || 0) - (a.score || 0))
    const remaining = userQueue.pending.length

    const lockedCount = usable.filter(r => r.isPasswordProtected).length
    const hotCount = usable.filter(r => r.score >= 70).length
    let reply = `✓ Batch done: ${results.length} checked, ${usable.length} reachable, ${hotCount} 🔥 hot` + (lockedCount ? `, ${lockedCount} 🔐 locked` : '') + `.`
    let leadNum = 0
    usable.forEach(r => {
      leadNum++
      const nameLine = r.store_name ? `${r.store_name}\n    🔗 ${r.url}` : `🔗 ${r.url}`
      const socialsList = Object.entries(r.socials || {}).map(([k, v]) => `${k}: ${v}`).join('\n              ')
      const socialsNote = socialsList ? `\n    💬 social: ${socialsList}` : ''
      const contactNote = r.contact_page ? `\n    🌐 contact page: ${r.contact_page}` : ''
      const genericNote = r.email_is_generic ? ' (generic)' : ''
      const emailNote = r.email !== 'no email' ? `\n    📧 ${r.email}${genericNote}` : ''
      const hotTag = r.score >= 70 ? ' 🔥' : ''
      const scoreNote = `\n    📊 score: ${r.score}${hotTag}` + (r.scoreReasons?.length ? ` (${r.scoreReasons.join(', ')})` : '')
      const ageNote = (typeof r.ageDays === 'number') ? `\n    🎂 age: ${r.ageDays}d${r.ageDays <= 30 ? ' 🔥' : ''}` : ''
      const hook = auditHookLine(r)
      const hookNote = hook ? `\n    💡 ${hook}` : ''
      reply += `\n\n${leadNum}. ${nameLine}${scoreNote}${ageNote}${hookNote}${socialsNote}${contactNote}${emailNote}`
    })

    if (remaining > 0) {
      reply += `\n\n────────\n${remaining} links remaining. Send anything to continue.`
    } else {
      const totalUsable = userQueue.results.filter(r => r.status === 'OK' && (r.email !== 'no email' || r.contact_page || Object.keys(r.socials || {}).length)).length
      reply += `\n\n────────\n✓ ALL DONE! ${userQueue.results.length} total, ${totalUsable} reachable.\nSend anything to move to the message-writing step.`
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
    let chunk = `📋 Ready to send — copy each pair:\n\n`
    for (const line of lines) {
      if ((chunk + line + '\n\n').length > 3800) { await send(chatId, chunk); chunk = '' }
      chunk += line + '\n\n'
    }
    if (chunk.trim()) await send(chatId, chunk)
  }


  // ══════════════════════════════════════════════
  //  MENU LAYER — button screens, "/" command list, guided flows
  // ══════════════════════════════════════════════

  // Set PUBLIC_ACCESS=true in Vercel to let other people use the SAFE features.
  // Everything that spends the owner's Google account / GitHub minutes / shared
  // lead database stays owner-only (see PUBLIC_CMDS).
  const PUBLIC_ACCESS = process.env.PUBLIC_ACCESS === 'true'
  const PUBLIC_CMDS = ['/start', '/menu', '/help', '/cancel', '/newuk']
  const actorId = String(body.callback_query?.from?.id || body.message?.from?.id || '')
  const isOwner = !ADMIN_ID || actorId === ADMIN_ID

  const B = (text, data) => ({ text, callback_data: data })

  function screenFor(name, owner) {
    const go = (label, data) => (owner || PUBLIC_ACCESS) ? B(label, data) : B('🔒 ' + label, 'locked')
    const nav = (back) => [B('⬅️ Back', back || 'menu:main'), B('🏠 Main menu', 'menu:main')]

    switch (name) {
      case 'uk':
        return {
          text:
            `<b>🇬🇧 New UK Companies</b>\n\n` +
            `<b>What it does:</b> pulls brand-new companies from Companies House, the official UK register. Free and 100% real.\n\n` +
            `<b>Why it's useful:</b> a company this new has no suppliers, website or marketing yet — the perfect moment to pitch it.\n\n` +
            `<b>Pick how far back to look</b> (more days = bigger list):`,
          kb: [
            [B('📅 Today · 20', 'run:/newuk 1 20'), B('📅 3 days · 50', 'run:/newuk 3 50')],
            [B('📅 7 days · 100', 'run:/newuk 7 100'), B('📅 30 days · 100', 'run:/newuk 30 100')],
            [go('🕵️ Next step: find their contacts', 'menu:findco')],
            nav()
          ]
        }
      case 'findco':
        return {
          text:
            `<b>🕵️ Find Contacts</b>\n\n` +
            `Turns a list of company names into ways to reach them.\n\n` +
            `<b>3 easy steps</b>\n` +
            `1️⃣ Get a list from 🇬🇧 New UK Companies\n` +
            `2️⃣ Tap ▶️ Start below\n` +
            `3️⃣ Copy that whole list and paste it here\n\n` +
            `<b>For each company I check:</b> its directors (the founders) → Google → its website → Google Maps → each director's LinkedIn, Instagram and Facebook.\n\n` +
            `⏱ Roughly 15–25 companies per hour. Results arrive here as they're found; anything left continues automatically.\n\n` +
            `💡 A company only a day old often has nothing online yet. When that happens, the directors' profiles are your best lead.`,
          kb: [
            [go('▶️ Start — I\'ll paste my list', 'run:/findco')],
            [B('🇬🇧 Get a list first', 'menu:uk')],
            nav()
          ]
        }
      case 'local':
        return {
          text:
            `<b>🗺️ Local Businesses</b>\n\n` +
            `Finds real businesses in any city from Google Maps — restaurants, salons, gyms, car repair, real estate — with phone, website and email when available. You get a .txt report.\n\n` +
            `Tap Start and I'll ask 3 quick questions:\n` +
            `<b>city → type of business → how many</b>\n\n` +
            `Good to know: every run is fresh — businesses you already have are skipped.`,
          kb: [
            [go('▶️ Start guided search', 'wiz:find')],
            nav()
          ]
        }
      case 'shopify':
        return {
          text:
            `<b>🛍️ Shopify Stores</b>\n\n` +
            `Find online stores built on Shopify, check they're live, and grab their contact email.\n\n` +
            `🔍 <b>Search</b> — look for stores by niche (skincare, jewelry, pets…)\n` +
            `🌱 <b>Watch</b> — get a message the moment a brand-new store appears\n` +
            `📄 <b>Have your own list?</b> Just send me a .txt file of links and I'll check them all.`,
          kb: [
            [go('🔍 Search stores', 'run:/scout')],
            [go('🌱 Watch for new stores', 'run:/fresh 30'), go('🛑 Stop watching', 'run:/freshoff')],
            nav()
          ]
        }
      case 'leads':
        return {
          text:
            `<b>📂 My Leads</b>\n\n` +
            `Every lead has a status so you never contact the same person twice:\n` +
            `new → contacted → replied → interested → client\n` +
            `(or not interested / do not contact)\n\n` +
            `<b>To change one:</b> after any report, type /mark 3 contacted (3 = the number in the report).\n\n` +
            `<b>See your leads by status:</b>`,
          kb: [
            [go('🆕 New', 'run:/leads new'), go('📨 Contacted', 'run:/leads contacted')],
            [go('💬 Replied', 'run:/leads replied'), go('⭐ Interested', 'run:/leads interested')],
            [go('🤝 Clients', 'run:/leads client'), go('🚷 Do not contact', 'run:/leads do_not_contact')],
            [go('📋 My campaigns', 'run:/campaigns')],
            nav()
          ]
        }
      case 'tools':
        return {
          text:
            `<b>🧰 Tools</b>\n\nHandy extras and an emergency reset.\n\n` +
            `🧹 <b>Cancel / reset</b> — use this if the bot seems stuck waiting for something.`,
          kb: [
            [go('🚫 Blacklisted links', 'run:/others'), go('🧾 Activity log', 'run:/audit')],
            [B('🧹 Cancel / reset', 'run:/cancel')],
            [B('📜 All commands', 'menu:cmds')],
            nav()
          ]
        }
      case 'help':
        return {
          text:
            `<b>❓ How this bot works</b>\n\n` +
            `In one line: it finds new businesses, then finds a way to contact them.\n\n` +
            `<b>The easiest path</b>\n` +
            `1️⃣ 🇬🇧 New UK Companies — get a fresh list\n` +
            `2️⃣ 🕵️ Find Contacts — paste the list; get websites, emails, phones, socials and the owners' LinkedIn\n` +
            `3️⃣ Reach out, then track it in 📂 My Leads\n\n` +
            `<b>Words used here</b>\n` +
            `• <b>Lead</b> — a business you could sell to\n` +
            `• <b>Director</b> — the person who started the company (the founder)\n\n` +
            `Stuck? Tap 🧹 Cancel in Tools, or send /start.`,
          kb: [
            [B('🇬🇧 Start with UK companies', 'menu:uk')],
            [B('📜 All commands', 'menu:cmds')],
            nav()
          ]
        }
      case 'cmds':
        return {
          text:
            `<b>📜 All commands</b>\n(You can also just tap the buttons — no typing needed.)\n\n` +
            `/start — main menu\n` +
            `/newuk [days] [count] — new UK companies\n` +
            `/findco — find contacts for a pasted company list\n` +
            `/find &lt;city&gt; &lt;niche&gt; [count] — Google Maps businesses\n` +
            `/scout — search Shopify stores\n` +
            `/fresh [age_days] [count] — watch for new Shopify stores\n` +
            `/freshoff — stop watching\n` +
            `/campaigns — your campaigns\n` +
            `/leads &lt;status&gt; — leads by status\n` +
            `/mark &lt;number&gt; &lt;status&gt; — update a lead\n` +
            `/others — blacklisted links\n` +
            `/black &lt;url&gt; — add to the blacklist\n` +
            `/scoutlist &lt;url&gt; — scan a domain list\n` +
            `/audit — activity log\n` +
            `/cancel — stop whatever I'm waiting for\n\n` +
            `📄 Send a .txt file of links and I'll extract, dedupe and check them.\n` +
            `When a scout finishes, send outreach messages separated by / and I'll pair them with emails.`,
          kb: [nav('menu:tools')]
        }
      case 'main':
      default:
        return {
          text:
            `<b>👋 Lead Scraper Bot</b>\n\n` +
            `Find businesses that need your services — and the contact details to reach them.\n\n` +
            `<b>New here?</b> Tap 🇬🇧 New UK Companies, then 🕵️ Find Contacts. That's the whole flow.\n\n` +
            (owner ? '' : `🔒 = owner-only for now.\n\n`) +
            `<b>What do you want to do?</b>`,
          kb: [
            [B('🇬🇧 New UK Companies', 'menu:uk'), go('🕵️ Find Contacts', 'menu:findco')],
            [go('🗺️ Local Businesses', 'menu:local'), go('🛍️ Shopify Stores', 'menu:shopify')],
            [go('📂 My Leads', 'menu:leads'), B('🧰 Tools', 'menu:tools')],
            [B('❓ How it works', 'menu:help')]
          ]
        }
    }
  }

  async function tgCall(method, payload) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      return await r.json()
    } catch (e) { console.error(method, 'error:', e.message); return null }
  }

  // Replace the menu in place (like BasedBot). Falls back to a new message.
  async function showScreen(chatId, messageId, name, owner) {
    const s = screenFor(name, owner)
    const base = { chat_id: chatId, text: s.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: s.kb }, disable_web_page_preview: true }
    if (messageId) {
      const d = await tgCall('editMessageText', { ...base, message_id: messageId })
      if (d && (d.ok || /not modified/i.test(d.description || ''))) return
    }
    await tgCall('sendMessage', base)
  }

  async function answerCb(id, text, alert) {
    await tgCall('answerCallbackQuery', { callback_query_id: id, ...(text ? { text, show_alert: !!alert } : {}) })
  }

  // Makes the "/" list in Telegram show /start (and the rest) + the Menu button.
  async function registerCommands(ownerChatId) {
    const pub = [
      ['start', '🏠 Open the main menu'], ['menu', '🏠 Main menu'], ['newuk', '🇬🇧 New UK companies'],
      ['help', '❓ How this bot works'], ['cancel', '🧹 Stop what I\'m waiting for']
    ]
    const all = [
      ['start', '🏠 Open the main menu'], ['menu', '🏠 Main menu'], ['help', '❓ How this bot works'],
      ['newuk', '🇬🇧 New UK companies'], ['findco', '🕵️ Find contacts for companies'],
      ['find', '🗺️ Local businesses (Google Maps)'], ['scout', '🛍️ Search Shopify stores'],
      ['fresh', '🌱 Watch for brand-new stores'], ['freshoff', '🛑 Stop watching new stores'],
      ['campaigns', '📋 Your campaigns'], ['leads', '📂 Leads by status'], ['mark', '✅ Update a lead\'s status'],
      ['others', '🚫 Blacklisted links'], ['black', '🔒 Add to blacklist'], ['scoutlist', '🕵️ Scan a domain list'],
      ['audit', '🧾 Activity log'], ['cancel', '🧹 Stop what I\'m waiting for'],
      ['access', '🔑 My access status'], ['grant', '✅ Give a user access (owner)']
    ].map(([command, description]) => ({ command, description }))
    await tgCall('setMyCommands', { commands: pub.map(([command, description]) => ({ command, description })) })
    await tgCall('setMyCommands', { commands: all, scope: { type: 'chat', chat_id: ownerChatId } })
    await tgCall('setChatMenuButton', { menu_button: { type: 'commands' } })
  }

  // ── Menu / guided-flow button presses (menu:, run:, wiz:, locked) ──
  if (body.callback_query && /^(menu:|run:|wiz:|locked|pay)/.test(body.callback_query.data || '')) {
    const cq = body.callback_query
    const d = cq.data
    const cbChat = cq.message.chat.id
    const cbMsg = cq.message.message_id

    if (!isOwner && !PUBLIC_ACCESS) {
      await answerCb(cq.id, 'Private bot.', true)
      return res.status(200).send('OK')
    }
    if (d === 'locked') {
      await answerCb(cq.id, '🔒 Owner-only for now — this feature uses private accounts and limits.', true)
      return res.status(200).send('OK')
    }

    if (d.startsWith('menu:')) {
      await answerCb(cq.id)
      const wq = await getUserQueue(actorId)
      if (wq.wizard) { wq.wizard = null; await saveUserQueue(actorId, wq) }
      await showScreen(cbChat, cbMsg, d.slice(5), isOwner)
      return res.status(200).send('OK')
    }

    if (d.startsWith('wiz:')) {
      if (!isOwner) { await answerCb(cq.id, '🔒 Owner-only for now.', true); return res.status(200).send('OK') }
      await answerCb(cq.id)
      const wq = await getUserQueue(actorId)
      const parts = d.split(':')
      if (parts[1] === 'find' && !parts[2]) {
        wq.wizard = { cmd: 'find', step: 'city' }
        await saveUserQueue(actorId, wq)
        await tgCall('sendMessage', { chat_id: cbChat, parse_mode: 'HTML',
          text: `<b>🗺️ Step 1 of 3 — Where?</b>\n\nType the city or area.\nExamples: <i>Austin</i> · <i>Lagos Nigeria</i> · <i>banana island lagos</i>\n\n(Changed your mind? /cancel)` })
        return res.status(200).send('OK')
      }
      if (parts[1] === 'niche' && wq.wizard) {
        if (parts[2] === 'other') {
          wq.wizard.step = 'niche_text'
          await saveUserQueue(actorId, wq)
          await tgCall('sendMessage', { chat_id: cbChat, text: 'Type the business type as ONE word (e.g. dentist, barber, plumber).' })
          return res.status(200).send('OK')
        }
        wq.wizard.niche = parts[2]; wq.wizard.step = 'count'
        await saveUserQueue(actorId, wq)
        await tgCall('sendMessage', { chat_id: cbChat, parse_mode: 'HTML',
          text: `<b>🗺️ Step 3 of 3 — How many?</b>\n\n${wq.wizard.niche.replace(/_/g, ' ')} in ${wq.wizard.city}`,
          reply_markup: { inline_keyboard: [[B('10', 'wiz:count:10'), B('20', 'wiz:count:20'), B('50', 'wiz:count:50')]] } })
        return res.status(200).send('OK')
      }
      if (parts[1] === 'count' && wq.wizard && wq.wizard.city && wq.wizard.niche) {
        const cmd = `/find ${wq.wizard.city} ${wq.wizard.niche} ${parseInt(parts[2]) || 20}`
        wq.wizard = null
        await saveUserQueue(actorId, wq)
        body = { message: { chat: cq.message.chat, from: cq.from, text: cmd } }   // fall through as if typed
      } else {
        await tgCall('sendMessage', { chat_id: cbChat, text: 'That guided search expired — open 🗺️ Local Businesses to start again.' })
        return res.status(200).send('OK')
      }
    }

    if (d === 'pay:request') {
      await answerCb(cq.id)
      const who = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ') || ''
      await redis('SET', `payreq:${actorId}`, String(Date.now()))
      if (ADMIN_ID) {
        await tgCall('sendMessage', {
          chat_id: ADMIN_ID, parse_mode: 'HTML',
          text:
            `💳 <b>Access request</b>
User ID: <code>${actorId}</code>${who ? '\nName: ' + who : ''}
` +
            `Price: ${ACCESS_PRICE}${PAYMENT_LINK ? ' → ' + PAYMENT_LINK : ' (set PAYMENT_LINK in Vercel to auto-link)'}

` +
            `Approve grants ${PASS_DAYS} days on YOUR shared session.`,
          reply_markup: { inline_keyboard: [[B(`✅ Grant ${PASS_DAYS} days`, `payok:${actorId}`), B('❌ Deny', `payno:${actorId}`)]] }
        })
      }
      await tgCall('sendMessage', {
        chat_id: cbChat, parse_mode: 'HTML',
        text: `💳 <b>Access pass — ${ACCESS_PRICE} for ${PASS_DAYS} days</b>\n\n` +
          (PAYMENT_LINK
            ? `Pay here — your access switches on as soon as it's confirmed:`
            : `Payment details will follow from the bot owner.`),
        reply_markup: PAYMENT_LINK ? { inline_keyboard: [[{ text: `💳 Pay ${ACCESS_PRICE}`, url: PAYMENT_LINK }]] } : undefined
      })
      return res.status(200).send('OK')
    }

    if (d === 'pay:byoc') {
      await answerCb(cq.id)
      await tgCall('sendMessage', {
        chat_id: cbChat, parse_mode: 'HTML',
        text:
          `<b>🍪 Bring your own session (free)</b>\n\n` +
          `1. In Chrome, log into <b>your</b> Google account and open google.com\n` +
          `2. Install the <b>Cookie-Editor</b> extension\n` +
          `3. Click Export — it copies the cookies JSON to your clipboard\n` +
          `4. Paste into a file named <code>cookies.json</code> and send it here as a document\n\n` +
          `From then on, /findco and /find run with YOUR cookies and YOUR limits — ` +
          `the shared session is never touched. Re-send the file anytime to refresh ` +
          `(Google kills sessions every few weeks).`
      })
      return res.status(200).send('OK')
    }

    if (d.startsWith('payok:') || d.startsWith('payno:')) {
      if (!isOwner) { await answerCb(cq.id, 'Owner only.', true); return res.status(200).send('OK') }
      const target = d.split(':')[1]
      if (d.startsWith('payok:')) {
        await grantPass(target)
        await tgCall('sendMessage', {
          chat_id: target,
          text: `✅ Your ${PASS_DAYS}-day access pass is active! /findco, /find, /scout and /fresh now work for you until ${new Date(Date.now() + PASS_DAYS * 86400000).toISOString().slice(0, 10)}. Send /access anytime to check your status.`
        })
        await answerCb(cq.id, `Granted ${target} ${PASS_DAYS} days.`)
      } else {
        await tgCall('sendMessage', { chat_id: target, text: 'Your access request was declined. If you already paid, message the bot owner with your proof.' })
        await answerCb(cq.id, 'Denied.')
      }
      return res.status(200).send('OK')
    }

    if (d.startsWith('run:')) {
      const cmd = d.slice(4)
      const base = cmd.split(' ')[0].toLowerCase()
      if (!isOwner && !PUBLIC_CMDS.includes(base) && !OWNER_SESSION_CMDS.includes(base)) {
        await answerCb(cq.id, '🔒 Owner-only for now.', true)
        return res.status(200).send('OK')
      }
      await answerCb(cq.id)
      body = { message: { chat: cq.message.chat, from: cq.from, text: cmd } }   // fall through as if typed
    }
  }

  // ══════════════════════════════════════════════
  //  CALLBACK BUTTONS
  // ══════════════════════════════════════════════

  if (body.callback_query) {
    const cbChatId = body.callback_query.message.chat.id
    const cbUserId = String(body.callback_query.from?.id || '')
    const data     = body.callback_query.data || ''
    const cbId     = body.callback_query.id

    await answerCallback(cbId)

    // Audit log
    await redis('RPUSH', 'audit:commands', JSON.stringify({ ts: new Date().toISOString(), user: cbUserId, text: '/cb ' + data.slice(0, 90) }))
    await redis('LTRIM', 'audit:commands', 0, 499)

    // Admin lock
    if (ADMIN_ID && cbUserId !== ADMIN_ID) {
      await send(cbChatId, 'Private bot.')
      return res.status(200).send('OK')
    }

    const cbLocked = await acquireLock(cbUserId)
    if (!cbLocked) return res.status(200).send('OK')

    try {
      if (data === 'lockedyes' || data === 'lockedno') {
        const q = await getUserQueue(cbUserId)
        const search = q.pendingSearch
        q.awaitingLockedFilter = false
        q.pendingSearch = null
        await saveUserQueue(cbUserId, q)
        if (!search) return res.status(200).send('OK')
        const includeLocked = data === 'lockedyes'
        if (search.isDirectList) {
          const batchLinks = search.rawLinks.slice(0, search.wantCount)
          return await startBatchJob(cbChatId, cbUserId, batchLinks, search.label, null, null, includeLocked)
        }
        return await startScoutJob(cbChatId, cbUserId, search.query, search.label, search.wantCount, includeLocked)
      }

      if (data === 'scout_custom') {
        await send(cbChatId, 'Send your custom search query now.')
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
        q.pendingSearch = { query: search.query, label: search.label }
        q.awaitingLeadCount = true
        await saveUserQueue(cbUserId, q)
        await send(cbChatId, `How many NEW leads? Reply with a number (max 300).`)
        return res.status(200).send('OK')
      }

      return res.status(200).send('OK')
    } finally {
      await releaseLock(cbUserId)
    }
  }

  // ══════════════════════════════════════════════
  //  NORMAL MESSAGES
  // ══════════════════════════════════════════════

  const msg = body.message
  if (!msg) return res.status(200).send('OK')

  const chatId = msg.chat.id
  const userId = String(msg.from?.id || '')
  const text   = (msg.text || '').trim()
  const doc    = msg.document

  // Audit log — every command ever sent, who sent it, when.
  await redis('RPUSH', 'audit:commands', JSON.stringify({ ts: new Date().toISOString(), user: userId, text: text.slice(0, 100) }))
  await redis('LTRIM', 'audit:commands', 0, 499)

  // Access gate — owner gets everything; strangers get nothing unless PUBLIC_ACCESS=true,
  // and then only the safe commands in PUBLIC_CMDS.
  if (!isOwner) {
    if (!PUBLIC_ACCESS) {
      await send(chatId, 'Private bot.')
      return res.status(200).send('OK')
    }
    const baseCmd = text.split(/[\s@]/)[0].toLowerCase()
    if (!text.startsWith('/')) {
      await send(chatId, 'Tap /start to open the menu 👇')
      return res.status(200).send('OK')
    }
    if (OWNER_SESSION_CMDS.includes(baseCmd)) {
      // paid pass or own-cookies users get in; everyone else sees the access screen
      if (!(await gateOwnerSession(chatId, userId))) return res.status(200).send('OK')
    } else if (!PUBLIC_CMDS.includes(baseCmd)) {
      await tgCall('sendMessage', { chat_id: chatId, text: '🔒 That feature is owner-only for now. Tap below to see what you can use.',
        reply_markup: { inline_keyboard: [[B('🏠 Main menu', 'menu:main')]] } })
      return res.status(200).send('OK')
    }
  }

  // ── Guided flow answers (typed city / niche) ──
  if (text) {
    const wq = await getUserQueue(userId)
    if (wq.wizard) {
      if (text.startsWith('/')) {
        wq.wizard = null
        await saveUserQueue(userId, wq)
      } else {
        const nicheButtons = [
          [B('🍽️ Restaurant', 'wiz:niche:restaurant'), B('💇 Salon', 'wiz:niche:salon')],
          [B('🏋️ Gym', 'wiz:niche:gym'), B('🔧 Auto repair', 'wiz:niche:auto_repair')],
          [B('🏠 Real estate', 'wiz:niche:real_estate'), B('🚚 Food truck', 'wiz:niche:food_truck')],
          [B('✏️ Something else', 'wiz:niche:other')]
        ]
        if (wq.wizard.step === 'city') {
          wq.wizard.city = text.slice(0, 60).replace(/[\n\r]+/g, ' ').trim()
          wq.wizard.step = 'niche'
          await saveUserQueue(userId, wq)
          await tgCall('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
            text: `<b>🗺️ Step 2 of 3 — What kind of business?</b>\n\nIn <i>${wq.wizard.city.replace(/[<>&]/g, '')}</i>. Pick one:`,
            reply_markup: { inline_keyboard: nicheButtons } })
        } else if (wq.wizard.step === 'niche_text') {
          wq.wizard.niche = text.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30)
          if (!wq.wizard.niche) {
            await send(chatId, 'Please type one plain word, like: dentist')
          } else {
            wq.wizard.step = 'count'
            await saveUserQueue(userId, wq)
            await tgCall('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
              text: `<b>🗺️ Step 3 of 3 — How many?</b>\n\n${wq.wizard.niche} in ${wq.wizard.city.replace(/[<>&]/g, '')}`,
              reply_markup: { inline_keyboard: [[B('10', 'wiz:count:10'), B('20', 'wiz:count:20'), B('50', 'wiz:count:50')]] } })
          }
        } else {
          await send(chatId, 'Please tap one of the buttons above — or /cancel to stop.')
        }
        return res.status(200).send('OK')
      }
    }
  }

  // ── /start, /menu, /help ──
  if (/^\/(start|menu)(@\w+)?(\s|$)/.test(text)) {
    if (isOwner) await registerCommands(chatId)     // makes "/" show the command list + Menu button
    await showScreen(chatId, null, 'main', isOwner)
    return res.status(200).send('OK')
  }
  if (/^\/help(@\w+)?$/.test(text)) {
    await showScreen(chatId, null, 'help', isOwner)
    return res.status(200).send('OK')
  }

  // ── /find <city> <niche> [count] [sample] [rescan] ──
  if (/^\/find(@\w+)?(\s|$)/.test(text)) {
    let parts = text.split(' ').slice(1)
    if (parts.length < 2) {
      await send(chatId, 'Usage: /find <city> <niche> [count] [sample] [rescan]\nExample: /find Austin restaurant 20\nExample: /find Austin restaurant 20 sample\nExample: /find Austin restaurant 20 rescan\nExample: /find banana island lagos nigeria restaurants 30\n\nNiches: restaurant, food_truck, salon, gym, auto_repair, real_estate\n\n"sample" = capped, contact-info-masked run (10-20 leads) suitable to hand to a prospective buyer.\n"rescan" = also include businesses you\'ve already scraped before (normally skipped so every run is fresh).')
      return res.status(200).send('OK')
    }
    let sampleMode = false
    let includeSeen = false
    while (parts.length && ['sample', 'rescan'].includes(parts[parts.length - 1].toLowerCase())) {
      const flag = parts.pop().toLowerCase()
      if (flag === 'sample') sampleMode = true
      if (flag === 'rescan') includeSeen = true
    }
    if (parts.length < 2) {
      await send(chatId, 'Usage: /find <city> <niche> [count] [sample] [rescan]')
      return res.status(200).send('OK')
    }
    let count = 20
    let nicheIndex = parts.length - 1
    const lastNum = parseInt(parts[parts.length - 1])
    if (!isNaN(lastNum) && lastNum > 0) {
      count = Math.min(lastNum, 50)
      nicheIndex = parts.length - 2
    }
    if (nicheIndex < 1) {
      await send(chatId, 'Usage: /find <city> <niche> [count] [sample] [rescan]\nExample: /find Austin restaurant 20\nExample: /find banana island lagos nigeria restaurants 30')
      return res.status(200).send('OK')
    }
    const niche = parts[nicheIndex]
    const city = parts.slice(0, nicheIndex).join(' ')

    const q = await getUserQueue(userId)
    q.pendingFindJob = { city, niche, count, sampleMode, includeSeen }
    q.awaitingReviewCap = true
    await saveUserQueue(userId, q)

    const flagsTxt = [sampleMode ? 'SAMPLE mode' : null, includeSeen ? 'including previously-seen' : null].filter(Boolean).join(', ')
    await send(chatId,
      `📍 ${niche} in ${city} (max ${count} results${flagsTxt ? ', ' + flagsTxt : ''})\n\n` +
      `What's the max review count you want to target?\n` +
      `I'll skip any business with MORE reviews than this — lower numbers ` +
      `bias toward newer/smaller businesses, higher numbers include more ` +
      `established ones too.\n\n` +
      `Reply with a number (e.g. 200), or "skip" for no limit.`
    )
    return res.status(200).send('OK')
  }

  // ── /fresh [age_days] [count] — turn ON fresh-store monitoring ──
  // No job is posted. It sets a config in Redis; every daemon run with an
  // empty queue runs one "tick": one crt.sh letter-slice + a batch of
  // age-checks. Full alphabet covered in about a day, all deduped, all
  // spread across cron runs so no single run looks like a burst to crt.sh.
  if (text.startsWith('/fresh')) {
    const nums = text.split(' ').slice(1).map(p => parseInt(p)).filter(n => !isNaN(n) && n > 0)
    const maxAge = Math.min(nums[0] || 30, 90)
    const count  = Math.min(nums[1] || 15, 30)
    await redis('SET', 'fresh:config', JSON.stringify({ chat_id: String(chatId), max_age_days: maxAge, count }), 'EX', 14 * 86400)
    const dispatched = await triggerGithubWorkflow()
    await send(chatId,
      `🌱 Fresh-store monitoring ON for 14 days: crt.sh stores ≤ ${maxAge}d old, up to ${count} reported per tick.\n` +
      (dispatched ? 'First tick starting within a minute or two. ' : 'Ticks run on the cron schedule. ') +
      `A full crt.sh sweep refreshes the candidate pool roughly once every 20 hours; every run in between just age-checks a batch from that pool. Results arrive after each tick.\n\n` +
      `Send /freshoff anytime to stop.`)
    return res.status(200).send('OK')
  }

  if (/^\/cancel(@\w+)?$/.test(text)) {
    const q = await getUserQueue(userId)
    q.awaitingMessages = false; q.awaitingReviewCap = false; q.awaitingCompanyList = false
    q.awaitingCustomQuery = false; q.awaitingLeadCount = false; q.awaitingLockedFilter = false
    q.pendingFindJob = null; q.pending = []; q.results = []; q.messages = []
    await saveUserQueue(userId, q)
    await send(chatId, '🧹 Cleared. The bot is no longer waiting for anything — old scout results and pending batches were dropped.')
    return res.status(200).send('OK')
  }

  if (text === '/freshoff') {
    await redis('DEL', 'fresh:config')
    await send(chatId, '🛑 Fresh-store monitoring stopped.')
    return res.status(200).send('OK')
  }
  // ── /findco — company web discovery via authenticated Google ──
  // Two ways to use:
  //   /findco https://example.com/list.txt   (list hosted online)
  //   /findco                                 then paste the list as your
  //                                            next message (multi-line OK —
  //                                            even raw /newuk output works)
  if (/^\/findco(@\w+)?(\s|$)/.test(text)) {
    const url = text.split(' ')[1]
    if (url && url.startsWith('http')) {
      await send(chatId, `📥 Fetching company list...`)
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 8000)
        const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
        clearTimeout(t)
        if (!r.ok) { await send(chatId, `Fetch failed (HTTP ${r.status}).`); return res.status(200).send('OK') }
        const companies = parseCompanyLines(await r.text())
        if (!companies.length) { await send(chatId, `No parseable companies found.`); return res.status(200).send('OK') }
        return await postDiscoveryJob(chatId, userId, companies)
      } catch (e) { await send(chatId, `Couldn't fetch that URL.`); return res.status(200).send('OK') }
    }
    // Same-message paste: "/findco <blob>" — parse the rest of THIS message
    const inline = text.replace(/^\/findco(@\w+)?\s*/, '')
    if (inline.trim().length > 0) {
      const companies = parseCompanyLines(inline)
      if (!companies.length) {
        await send(chatId, `Couldn't parse any companies from that. Send /findco alone, then paste the list as your next message.`)
        return res.status(200).send('OK')
      }
      return await postDiscoveryJob(chatId, userId, companies)
    }
    // No URL, no paste — arm the paste-catcher and wait for their list
    const q = await getUserQueue(userId)
    q.awaitingReviewCap = false
    q.pendingFindJob = null
    q.awaitingMessages = false
    q.awaitingCompanyList = true
    await saveUserQueue(userId, q)
    await send(chatId,
      `📋 Paste your company list as your next message — one per line.\n\n` +
      `Formats that work:\n` +
      `  Acme Ltd, London\n` +
      `  WidgetCo | Manchester\n` +
      `  SoloCompany\n\n` +
      `You can even paste /newuk output straight in — the extra lines ` +
      `(dates, links, addresses) are ignored automatically.`)
    return res.status(200).send('OK')
  }

  // ── /newuk [days] [count] — newly incorporated UK companies (Companies House) ──
  // Official free API, no daemon needed — this runs straight from Vercel.
  if (text.startsWith('/newuk')) {
    if (!COMPANIES_HOUSE_API_KEY) {
      await send(chatId,
        `🇬🇧 Companies House isn't set up yet.\n\n` +
        `It's free — register at developer.company-information.service.gov.uk, ` +
        `create an application, then "Create new key" (REST API key type). ` +
        `Add it to Vercel as COMPANIES_HOUSE_API_KEY, then redeploy.`)
      return res.status(200).send('OK')
    }
    const parts = text.split(' ').slice(1)
    const days = Math.min(Math.max(parseInt(parts[0]) || 1, 1), 30)
    const count = Math.min(Math.max(parseInt(parts[1]) || 20, 1), 100)

    const today = new Date()
    const fromDate = new Date(today)
    fromDate.setDate(fromDate.getDate() - days)
    const fmt = d => d.toISOString().slice(0, 10)

    await send(chatId, `🇬🇧 Pulling UK companies incorporated in the last ${days} day(s)...`)
    const data = await fetchNewUKCompanies(fmt(fromDate), fmt(today), count)
    if (!data) {
      await send(chatId, `Companies House request failed — check the API key is valid in Vercel, or try again shortly.`)
      return res.status(200).send('OK')
    }

    const items = (data.items || []).slice(0, count)
    if (!items.length) {
      await send(chatId, `No UK companies found for that window (${data.hits || 0} total hits before capping).`)
      return res.status(200).send('OK')
    }

    // Dedup against previously-sent companies, same "seen" hash the /scout flow uses
    const ukScope = isOwner ? '' : `${userId}:`   // public users get their own 'already seen' list
    const dedupeKeys = items.map(it => `ukco:${ukScope}${it.company_number}`)
    const seenMap = await getSeenBatch(dedupeKeys)
    const fresh = items.filter((it, i) => !seenMap[dedupeKeys[i]])
    if (fresh.length) {
      await markSeenBatch(fresh.map(it => [`ukco:${ukScope}${it.company_number}`, { sentAt: new Date().toISOString() }]))
    }

    if (!fresh.length) {
      await send(chatId, `✓ ${items.length} in range — all already sent to you before. Nothing new.`)
      return res.status(200).send('OK')
    }

    let reply = `🇬🇧 ${fresh.length} new UK compan${fresh.length === 1 ? 'y' : 'ies'} (${items.length} in range, ${data.hits || 0} total hits):`
    fresh.forEach((it, i) => {
      const addr = it.registered_office_address || {}
      const addrLine = [addr.address_line_1, addr.locality, addr.postal_code].filter(Boolean).join(', ')
      reply += `\n\n${i + 1}. ${it.company_name}` +
        `\n    📅 Incorporated: ${it.date_of_creation}` +
        `\n    🏢 ${it.company_type || 'unknown type'}` +
        (addrLine ? `\n    📍 ${addrLine}` : '') +
        `\n    🔗 https://find-and-update.company-information.service.gov.uk/company/${it.company_number}`
    })
    await send(chatId, reply)
    await tgCall('sendMessage', { chat_id: chatId, text: 'Next step 👇  Copy the list above, then tap Find Contacts and paste it.',
      reply_markup: { inline_keyboard: [[isOwner ? B('🕵️ Find Contacts', 'menu:findco') : B('🔒 Find Contacts', 'locked')], [B('🏠 Main menu', 'menu:main')]] } })
    return res.status(200).send('OK')
  }

  // ── /access — anyone: check own access status / buy / upload cookies ──
  if (/^\/access(@\w+)?$/.test(text)) {
    await sendAccessScreen(chatId, userId)
    return res.status(200).send('OK')
  }

  // ── /grant <userId> [days] — owner only: activate a paid pass ──
  if (text.startsWith('/grant')) {
    if (!isOwner) { await send(chatId, 'Owner only.'); return res.status(200).send('OK') }
    const parts = text.split(' ').slice(1)
    const target = parts[0] || ''
    const days = Math.min(Math.max(parseInt(parts[1]) || PASS_DAYS, 1), 365)
    if (!/^\d+$/.test(target)) {
      await send(chatId, `Usage: /grant <telegram user id> [days]\ne.g. /grant 123456789 30`)
      return res.status(200).send('OK')
    }
    await grantPass(target, days)
    await tgCall('sendMessage', { chat_id: target, text: `✅ Access granted: ${days} days. Send /access anytime to check your status.` })
    await send(chatId, `✓ ${target} now has ${days} days of access.`)
    return res.status(200).send('OK')
  }

  // ── /campaigns ──
  if (text === '/campaigns') {
    const { result: names } = await redis('SMEMBERS', 'campaigns:all')
    if (!names || !names.length) {
      await send(chatId, `No campaigns yet — they're created automatically the first time you run /find.`)
      return res.status(200).send('OK')
    }
    const lines = []
    for (const name of names) {
      const { result: count } = await redis('SCARD', `campaign:${name}:leads`)
      lines.push(`• ${name} — ${count || 0} lead(s)`)
    }
    await send(chatId, `📋 Campaigns:\n\n` + lines.join('\n'))
    return res.status(200).send('OK')
  }

  // ── /leads <status> ──
  if (text.startsWith('/leads')) {
    const status = text.split(' ')[1]
    if (!status || !LEAD_STATUSES.includes(status)) {
      await send(chatId, `Usage: /leads <status>\nStatuses: ${LEAD_STATUSES.join(', ')}`)
      return res.status(200).send('OK')
    }
    const { result: ids } = await redis('SMEMBERS', `status:${status}`)
    if (!ids || !ids.length) {
      await send(chatId, `No leads with status "${status}" yet.`)
      return res.status(200).send('OK')
    }
    const shown = ids.slice(0, 25)
    const { result: recordsRaw } = await redis('HMGET', 'leads:status', ...shown)
    const lines = shown.map((id, i) => {
      try {
        const r = JSON.parse(recordsRaw[i])
        return `${i + 1}. ${r.name} — ${r.phone || 'no phone'} — ${r.email || 'no email'} (score ${r.score}, ${r.campaign})`
      } catch { return `${i + 1}. (unreadable record)` }
    })
    const more = ids.length > shown.length ? `\n…and ${ids.length - shown.length} more` : ''
    await send(chatId, `📋 ${status} (${ids.length} total):\n\n` + lines.join('\n') + more)
    return res.status(200).send('OK')
  }

  // ── /mark <number> <status> ──
  if (text.startsWith('/mark')) {
    const parts = text.split(' ').slice(1)
    const num = parseInt(parts[0], 10)
    const status = parts[1]
    if (!num || !status || !LEAD_STATUSES.includes(status)) {
      await send(chatId, `Usage: /mark <number> <status>\nNumber = the [N] position from your last .txt report.\nStatuses: ${LEAD_STATUSES.join(', ')}`)
      return res.status(200).send('OK')
    }
    const { result: lastRaw } = await redis('GET', `lastfind:${chatId}`)
    if (!lastRaw) {
      await send(chatId, `No recent /find report to reference — run /find first.`)
      return res.status(200).send('OK')
    }
    let last
    try { last = JSON.parse(lastRaw) } catch { last = [] }
    const entry = last.find(e => e.index === num)
    if (!entry || !entry.dedup_id) {
      await send(chatId, `Couldn't find #${num} in your last report.`)
      return res.status(200).send('OK')
    }
    const { result: existingRaw } = await redis('HGET', 'leads:status', entry.dedup_id)
    let record = existingRaw ? JSON.parse(existingRaw) : { name: entry.name, phone: entry.phone, email: entry.email, score: entry.score, campaign: '' }
    const oldStatus = record.status || 'new'
    record.status = status
    record.updated = new Date().toISOString().slice(0, 16).replace('T', ' ')
    await redis('HSET', 'leads:status', entry.dedup_id, JSON.stringify(record))
    if (oldStatus !== status) {
      await redis('SREM', `status:${oldStatus}`, entry.dedup_id)
      await redis('SADD', `status:${status}`, entry.dedup_id)
    }
    await send(chatId, `✓ ${entry.name} marked as "${status}".`)
    return res.status(200).send('OK')
  }

  // ── /audit — view the command audit log ──
  if (text === '/audit') {
    const { result: entries } = await redis('LRANGE', 'audit:commands', 0, 49)
    if (!entries || !entries.length) {
      await send(chatId, 'Audit log is empty.')
      return res.status(200).send('OK')
    }
    const lines = entries.map(e => { try { const r = JSON.parse(e); return `${r.ts.slice(0, 16)} — ${r.user} — ${r.text}` } catch { return '(unreadable)' } })
    await send(chatId, `🧾 Last ${lines.length} commands:\n\n` + lines.join('\n'))
    return res.status(200).send('OK')
  }

  // ── /others ──
  if (text === '/others') {
    const filtered = await getFilteredOut(userId)
    if (!filtered.length) {
      await send(chatId, `No filtered links saved yet — these show up after a /scout run finds blacklisted domains.`)
      return res.status(200).send('OK')
    }
    const shown = filtered.slice(0, 30)
    const more = filtered.length > shown.length ? `\n…and ${filtered.length - shown.length} more` : ''
    await send(chatId, `🚫 Filtered links — ${filtered.length} total:\n\n` + shown.join('\n') + more)
    return res.status(200).send('OK')
  }

  // ── /black <url> ──
  if (text.startsWith('/black')) {
    const url = text.split(' ')[1]
    if (!url || !url.startsWith('http')) {
      await send(chatId, `Usage: /black <url to raw domain-list>\ne.g. /black https://example.com/list.txt`)
      return res.status(200).send('OK')
    }
    await send(chatId, `📥 Fetching blacklist...`)
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 8000)
      const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      clearTimeout(t)
      if (!r.ok) { await send(chatId, `Fetch failed (HTTP ${r.status}).`); return res.status(200).send('OK') }
      const domains = parseBlacklistText(await r.text())
      if (!domains.length) { await send(chatId, `No parseable domains found.`); return res.status(200).send('OK') }
      const added = await addToBlacklist(domains)
      await send(chatId, `✓ Blacklist updated: ${added} domain(s) added.`)
    } catch (e) { await send(chatId, `Couldn't fetch that URL.`) }
    return res.status(200).send('OK')
  }

  // ── /scoutlist <url> ──
  if (text.startsWith('/scoutlist')) {
    const url = text.split(' ')[1]
    if (!url || !url.startsWith('http')) {
      await send(chatId, `Usage: /scoutlist <url to raw domain-list>\ne.g. /scoutlist https://example.com/list.txt`)
      return res.status(200).send('OK')
    }
    await send(chatId, `📥 Fetching domain list...`)
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 8000)
      const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      clearTimeout(t)
      if (!r.ok) { await send(chatId, `Fetch failed (HTTP ${r.status}).`); return res.status(200).send('OK') }
      const domains = parseBlacklistText(await r.text())
      if (!domains.length) { await send(chatId, `No parseable domains found.`); return res.status(200).send('OK') }
      const rawLinks = domains.map(d => `https://${d}`)
      const q = await getUserQueue(userId)
      q.pendingSearch = { rawLinks, label: 'domain list', isDirectList: true }
      q.awaitingLeadCount = true
      await saveUserQueue(userId, q)
      await send(chatId, `✓ Parsed ${rawLinks.length} domains. How many to check? Reply with a number (max 300).`)
    } catch (e) { await send(chatId, `Couldn't fetch that URL.`) }
    return res.status(200).send('OK')
  }

  // ── /scout ──
  if (text === '/scout') {
    const keyboard = Object.entries(SAVED_SEARCHES).map(([key, s]) =>
      [{ text: s.label, callback_data: `scout_${key}` }]
    )
    keyboard.push([{ text: '✏️ Custom search term', callback_data: 'scout_custom' }])
    await sendKeyboard(chatId, 'Which search do you want to run?', keyboard)
    return res.status(200).send('OK')
  }

  // ══════════════════════════════════════════════
  //  MAIN MESSAGE FLOW (lock protected)
  // ══════════════════════════════════════════════

  const locked = await acquireLock(userId)
  if (!locked) {
    await send(chatId, '⏳ Still working on your last request — one sec.')
    return res.status(200).send('OK')
  }

  try {
    const userQueue = await getUserQueue(userId)

    // ── Awaiting pasted company list for /findco ──
    if (userQueue.awaitingCompanyList) {
      const companies = parseCompanyLines(text)
      userQueue.awaitingCompanyList = false
      await saveUserQueue(userId, userQueue)
      if (!companies.length) {
        await send(chatId, `Couldn't parse any companies from that. One per line, e.g.:\n  Acme Ltd, London\n  WidgetCo, Manchester\nSend /findco to try again.`)
        return res.status(200).send('OK')
      }
      return await postDiscoveryJob(chatId, userId, companies)
    }

    // ── Awaiting review cap for /find ──
    if (userQueue.awaitingReviewCap) {
      if (text.includes('\n') || text.length > 30) {
        await send(chatId, `That doesn't look like a review cap — reply with just a number (e.g. 200) or "skip".`)
        return res.status(200).send('OK')
      }
      const raw = text.trim().toLowerCase()
      let reviewCap = null
      if (raw !== 'skip' && raw !== 'no' && raw !== 'none' && raw !== '0') {
        const n = parseInt(raw.replace(/[^0-9]/g, ''), 10)
        if (!n || n < 1) {
          await send(chatId, `Reply with just a number (e.g. 200), or "skip" for no limit.`)
          return res.status(200).send('OK')
        }
        reviewCap = n
      }
      const job = userQueue.pendingFindJob
      userQueue.awaitingReviewCap = false
      userQueue.pendingFindJob = null
      await saveUserQueue(userId, userQueue)
      if (!job) {
        await send(chatId, `Something went wrong — run /find again.`)
        return res.status(200).send('OK')
      }
      const jobPayload = JSON.stringify({
        chat_id: chatId, city: job.city, niche: job.niche,
        count: job.count, review_cap: reviewCap,
        sample_mode: !!job.sampleMode,
        include_seen: !!job.includeSeen,
        user_id: userId          // empty for owner; daemon loads THEIR cookies if set
      })
      await redis('RPUSH', 'jobs:find', jobPayload)
      const dispatched = await triggerGithubWorkflow()
      await send(chatId,
        `✅ Job posted: ${job.niche} in ${job.city} (max ${job.count}` +
        `${reviewCap ? `, review cap ${reviewCap}` : ', no review cap'}` +
        `${job.sampleMode ? ', SAMPLE mode' : ''}` +
        `${job.includeSeen ? ', including previously-seen' : ''})\n\n` +
        (dispatched
          ? `Triggered GitHub Actions immediately — should start within a minute or two.\n`
          : `Make sure maps_daemon.py is running on your PC, or wait for the next scheduled GitHub Actions run.\n`) +
        `Results will land here as they're found, plus downloadable .txt/.html reports at the end.`
      )
      return res.status(200).send('OK')
    }

    // ── Awaiting custom search query ──
    if (userQueue.awaitingCustomQuery) {
      userQueue.awaitingCustomQuery = false
      userQueue.pendingSearch = { query: text, label: 'Custom search' }
      userQueue.awaitingLeadCount = true
      await saveUserQueue(userId, userQueue)
      await send(chatId, `How many NEW leads? Reply with a number (max 300).`)
      return res.status(200).send('OK')
    }

    // ── Awaiting lead count ──
    if (userQueue.awaitingLeadCount) {
      const n = parseInt(text.replace(/[^0-9]/g, ''), 10)
      if (!n || n < 1) { await send(chatId, `Reply with just a number, e.g. 30.`); return res.status(200).send('OK') }
      const wantCount = Math.min(n, 300)
      userQueue.awaitingLeadCount = false
      userQueue.pendingSearch.wantCount = wantCount
      userQueue.awaitingLockedFilter = true
      await saveUserQueue(userId, userQueue)
      await sendKeyboard(chatId, `🔐 Include password-protected / "coming soon" stores?`, [
        [{ text: '✅ Yes, show them', callback_data: 'lockedyes' }],
        [{ text: '🚫 No, skip them', callback_data: 'lockedno' }]
      ])
      return res.status(200).send('OK')
    }

    // ── File upload: .txt of links, OR a cookie export (.json/.txt) ──
    if (doc) {
      const fname = doc.file_name || ''
      if (fname && !fname.endsWith('.txt') && !/\.json$/i.test(fname)) {
        await send(chatId, 'Only .txt and .json files are supported.')
        return res.status(200).send('OK')
      }
      await send(chatId, '📄 Reading file...')
      const content = await getFileContent(doc.file_id)
      // Cookie export? Store it as THIS user's session instead of scanning links.
      const sniffed = sniffCookies(content)
      if (sniffed) {
        const arr = JSON.parse(content)
        const exp = cookieExpiry(arr)
        await redis('SET', `cookies:${userId}:google`, content)
        await redis('SET', `cookies:${userId}:meta`, JSON.stringify({
          saved_at: Math.floor(Date.now() / 1000), expires: exp, count: arr.length }))
        await send(chatId,
          `🍪 Cookies saved — /findco and /find will now run with YOUR OWN Google session.\n` +
          `${arr.length} cookies, freshest expires ${exp ? new Date(exp * 1000).toISOString().slice(0, 10) : 'unknown'}.\n\n` +
          `Re-send this file anytime to refresh (Google kills sessions every few weeks). Send /access to check status.`)
        return res.status(200).send('OK')
      }
      const extraBlacklistSet = await getExtraBlacklistSet()
      const rawLinks = extractAndCleanLinks(content, extraBlacklistSet)
      return await startBatchJob(chatId, userId, rawLinks, `file (${rawLinks.length} links)`, null, null, true)
    }

    // ── /autopitch ──
    if (text === '/autopitch') {
      const usable = userQueue.results.filter(r => r.status === 'OK' && r.email !== 'no email' && (r.score || 0) >= 70)
      if (!usable.length) {
        await send(chatId, `No 70+ scored leads with emails yet. Run /scout first.`)
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

    // ── A pasted UK company list is never an outreach message ──
    if (userQueue.awaitingMessages && /company-information\.service\.gov\.uk|Incorporated:/i.test(text)) {
      const companies = parseCompanyLines(text)
      if (companies.length) {
        userQueue.awaitingMessages = false
        await saveUserQueue(userId, userQueue)
        return await postDiscoveryJob(chatId, userId, companies)
      }
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
        await send(chatId, `Got ${have} message(s). Need ${need - have} more (separate with /).`)
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

    // ── Continue next batch ──
    if (userQueue.pending.length > 0) {
      return await runBatch(chatId, userId, userQueue)
    }

    if (userQueue.results.length > 0 && !userQueue.awaitingMessages) {
      const withEmail = userQueue.results.filter(r => r.email !== 'no email')
      userQueue.awaitingMessages = true
      await saveUserQueue(userId, userQueue)
      await send(chatId, `✓ All done! ${userQueue.results.length} processed, ${withEmail.length} have emails.\n\nSend outreach messages separated by /. Need ${withEmail.length}.`)
      return res.status(200).send('OK')
    }

    await send(chatId, 'Send a .txt file, use /scout for URLScan leads, /find for Google Maps, or /fresh to monitor new Shopify stores.')
    return res.status(200).send('OK')
  } finally {
    await releaseLock(userId)
  }
}
