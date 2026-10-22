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
    '1': { label: 'All Shopify stores (newest first)', query: 'page.domain:myshopify.com' },
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
    return v ? JSON.parse(v) : { pending: [], results: [], awaitingMessages: false, messages: [], awaitingCustomQuery: false, awaitingReviewCap: false, awaitingCompanyList: false, pendingFindJob: null, answeringGift: null, giftDraft: null, awaitingStartText: false, awaitingBroadcast: false }
  }

  async function saveUserQueue(userId, queue) {
    await redis('SET', `queue:${userId}`, JSON.stringify(queue))
  }

  // True while the user is mid-answer in ANY user-facing flow. Admin-edit
  // flags (payment contact/price, trial size, start text, broadcast, gift
  // draft) are deliberately NOT listed — they're guarded separately, below.
  // Without this, a stuck admin-edit flag silently swallows every plain
  // message the user sends afterwards (e.g. "20" meant for /scout getting
  // interpreted as a payment contact).
  function activeFlowFlags(q) {
    return !!(q && (q.awaitingReviewCap || q.awaitingCompanyList || q.awaitingMessages ||
      q.awaitingCustomQuery || q.awaitingLeadCount || q.awaitingLockedFilter ||
      q.wizard || q.answeringGift))
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
  let PASS_DAYS = parseInt(process.env.ACCESS_PASS_DAYS || '30')
  let ACCESS_PRICE = process.env.ACCESS_PRICE_TEXT || '$1'
  let PAY_CONTACT = process.env.PAY_CONTACT || ''     // e.g. "@zammynn" or a full payment link
  let PAYMENT_LINK = process.env.PAYMENT_LINK || ''   // legacy raw-URL env var, still honoured
  const OWNER_SESSION_CMDS = ['/find', '/findco', '/scout', '/fresh', '/freshoff', '/scoutlist', '/autopitch']
  // Of those, only these three are bounded, one-shot searches a free credit can safely
  // cover — /fresh turns on INDEFINITE background monitoring (not a search that finishes),
  // /freshoff/scoutlist/autopitch stay paid/owner-only too.
  const FREE_TIER_CMDS = ['/find', '/findco', '/scout']

  // "@name" -> a clickable t.me link; a full URL is used as-is.
  function payUrlFrom(contact) {
    const c = (contact || '').trim()
    if (!c) return ''
    return /^https?:\/\//i.test(c) ? c : 'https://t.me/' + c.replace(/^@/, '')
  }

  // Pay contact/price/pass-length are owner-editable from inside the bot (🧰 Tools →
  // 👥 Access requests) — stored in Redis so no Vercel redeploy is ever needed.
  // The env vars above are only the very-first-run default.
  // ON by default now — set AUTO_TRIAL=false in Vercel to switch the free trial off.
  let AUTO_TRIAL = process.env.AUTO_TRIAL !== 'false'
  let START_TEXT = ''   // custom /start message (owner-editable via /admin)
  let TRIAL_SIZE = parseInt(process.env.AUTO_TRIAL_SIZE || '2') || 2   // free searches per new account
  const FREE_RESULT_CAP = parseInt(process.env.FREE_RESULT_CAP || '10') || 10   // max results per free (one-time) search
  const DAILY_RESULT_CAP = parseInt(process.env.DAILY_RESULT_CAP || '5') || 5   // max results for the ongoing once-a-day free search
  const RESULTS_ARE_YOURS_LINE =
    `🔥 These are pulled live, right now, just for you — nobody else gets your run, and tomorrow's pull is a whole new batch.`
  // UTC calendar date, e.g. "2026-10-15" — the daily free search resets at midnight UTC,
  // not the person's local time.
  function todayKey() {
    return new Date().toISOString().slice(0, 10)
  }

  // A free-tier user picking "50" would just get silently capped anyway — showing
  // the real number up front is more honest than offering choices that don't apply.
  function countButtons(tier) {
    if (tier === 'daily') return [[B(`🎁 Free search (${DAILY_RESULT_CAP})`, `wiz:count:${DAILY_RESULT_CAP}`)]]
    if (tier === 'onetime') return [[B(`🎁 Free search (${FREE_RESULT_CAP})`, `wiz:count:${FREE_RESULT_CAP}`)]]
    return [[B('10', 'wiz:count:10'), B('20', 'wiz:count:20'), B('50', 'wiz:count:50')]]
  }
  async function loadPayConfig() {
    const [{ result: c }, { result: p }, { result: d }, { result: at }, { result: ts }, { result: stx }] = await Promise.all([
      redis('GET', 'config:pay_contact'),
      redis('GET', 'config:pay_price'),
      redis('GET', 'config:pay_days'),
      redis('GET', 'config:auto_trial'),
      redis('GET', 'config:trial_size'),
      redis('GET', 'config:start_text')
    ])
    if (c) PAY_CONTACT = c
    if (p) ACCESS_PRICE = p
    if (d && parseInt(d) > 0) PASS_DAYS = parseInt(d)
    if (at !== null && at !== undefined) AUTO_TRIAL = at === 'true'
    if (ts && parseInt(ts) > 0) TRIAL_SIZE = parseInt(ts)
    if (stx) START_TEXT = stx
    if (PAY_CONTACT) PAYMENT_LINK = payUrlFrom(PAY_CONTACT)
  }
  await loadPayConfig()

  // Every pay:request is logged here so the owner can review it anytime from
  // 👥 Access requests, instead of relying only on catching the DM ping live.
  async function addPendingRequest(uid, who) {
    await redis('HSET', 'access:pending', uid, JSON.stringify({ who: who || '', ts: Date.now() }))
  }
  async function removePendingRequest(uid) {
    await redis('HDEL', 'access:pending', uid)
  }
  async function listPendingRequests() {
    const { result } = await redis('HGETALL', 'access:pending')
    const out = []
    if (Array.isArray(result)) {
      for (let i = 0; i < result.length; i += 2) {
        try { out.push({ id: result[i], ...JSON.parse(result[i + 1]) }) } catch {}
      }
    }
    return out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  }
  async function listGrantedPasses() {
    const { result: ids } = await redis('SMEMBERS', 'access:granted:ids')
    if (!ids || !ids.length) return []
    const out = []
    for (const gid of ids) {
      const info = await passInfo(gid)
      const { result: metaRaw } = await redis('GET', `access:meta:${gid}`)
      let who = ''
      if (metaRaw) { try { who = JSON.parse(metaRaw).who || '' } catch {} }
      out.push({ id: gid, who, ...info })
    }
    return out.sort((a, b) => b.expires - a.expires)
  }

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

  async function oneTimeInfo(userId) {
    const { result } = await redis('GET', `onetime:${userId}`)
    return { remaining: parseInt(result) || 0 }
  }

  async function tierOf(userId) {
    if (isOwner) return 'owner'
    if ((await passInfo(userId)).valid) return 'paid'
    if ((await oneTimeInfo(userId)).remaining > 0) return 'onetime'
    // Once someone's used up their lifetime trial, they graduate to one free
    // /find or /findco a day (capped at DAILY_RESULT_CAP) for as long as the
    // owner keeps the free program (AUTO_TRIAL) switched on.
    if (AUTO_TRIAL) {
      const { result: everUsed } = await redis('GET', `trial:used:${userId}`)
      if (everUsed) {
        const { result: usedToday } = await redis('GET', `daily:used:${userId}:${todayKey()}`)
        if (!usedToday) return 'daily'
      }
    }
    if ((await cookieInfo(userId)).fresh) return 'byoc'
    return 'none'
  }

  async function grantPass(userId, days = PASS_DAYS, who = '') {
    await redis('SET', `pass:${userId}`, String(Date.now() + days * 86400000))
    await redis('SADD', 'access:granted:ids', userId)
    if (who) await redis('SET', `access:meta:${userId}`, JSON.stringify({ who }))
    await removePendingRequest(userId)
  }

  // A "once in a lifetime" search — exactly one /find or /findco run on the
  // shared session, spent the moment the job actually gets queued (not merely
  // when they start the command), so an abandoned flow never burns the credit.
  async function grantOneTime(userId, count = 1, who = '') {
    const { result } = await redis('INCRBY', `onetime:${userId}`, String(count))
    await redis('SADD', 'access:onetime:ids', userId)
    if (who) await redis('SET', `access:meta:${userId}`, JSON.stringify({ who }))
    await removePendingRequest(userId)
    return parseInt(result) || count
  }

  // ══════════════════════════════════════════════
  //  GIFT SYSTEM — owner-created gifts of searches or time-passes.
  //  A gift = a prize (N searches with a result cap, OR a days-pass)
  //  + an optional personal message + one of three distribution modes:
  //    everyone — every user can claim it once (optional max-claims cap)
  //    first    — exactly one winner: whoever taps Claim first
  //    quiz     — the gift shows a question; first correct answer wins
  //               (owner can also review attempts and award by hand)
  //  Winners are granted one-time credits (with a per-user result-cap
  //  override stored in giftcap:<uid>) or a pass, and get the gift
  //  message delivered by DM.
  // ══════════════════════════════════════════════
  async function resultCapFor(uid, base) {
    // A gift can raise a user's per-search result cap; it never lowers it.
    const { result } = await redis('GET', `giftcap:${uid}`)
    const g = parseInt(result) || 0
    return Math.max(base, g)
  }
  async function giftIds() {
    const { result } = await redis('ZRANGE', 'gifts:index', 0, -1)
    return result || []
  }
  async function getGift(id) {
    const { result } = await redis('GET', `gift:${id}`)
    if (!result) return null
    try { return JSON.parse(result) } catch { return null }
  }
  async function saveGift(g) {
    await redis('SET', `gift:${g.id}`, JSON.stringify(g))
    await redis('ZADD', 'gifts:index', String(g.created || Date.now()), g.id)
  }
  function normAnswer(s) {
    return String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  }
  function giftPrizeText(g) {
    if (g.kind === 'pass') return `${g.days || 30} days of full access`
    const n = g.searches || 1
    return `${n} search${n === 1 ? '' : 'es'} (up to ${g.cap || FREE_RESULT_CAP} results each)`
  }
  async function awardGiftTo(g, uid) {
    if (g.kind === 'pass') {
      await grantPass(uid, g.days || 30, '')
    } else {
      await redis('INCRBY', `onetime:${uid}`, String(g.searches || 1))
      await redis('SADD', 'access:onetime:ids', uid)
      const want = parseInt(g.cap) || 0
      if (want > FREE_RESULT_CAP) {
        const { result: cur } = await redis('GET', `giftcap:${uid}`)
        if ((parseInt(cur) || 0) < want) await redis('SET', `giftcap:${uid}`, String(want))
      }
    }
  }
  async function deliverGift(uid, g, extra) {
    await send(uid,
      `🎁 You won a gift!\n\n🎟️ ${giftPrizeText(g)}` +
      (g.message ? `\n\n💌 Message from the owner:\n${g.message}` : '') +
      (extra ? `\n\n${extra}` : '') +
      `\n\nSend /access anytime to check your status.`)
  }
  async function notifyOwnerGiftLine(g, uid, what) {
    if (!ADMIN_ID) return
    await tgCall('sendMessage', { chat_id: ADMIN_ID,
      text: `🎁 Gift "${(g.label || g.id).slice(0, 40)}" — ${what} — user ${uid}.` })
  }
  async function openGiftList() {
    const ids = await giftIds()
    const out = []
    for (const id of ids.slice(-30)) {
      const g = await getGift(id)
      if (g && g.status === 'open') out.push(g)
    }
    return out.reverse()
  }
  async function claimGift(chatId, uid, giftId) {
    const g = await getGift(giftId)
    if (!g || g.status !== 'open') { await send(chatId, `That gift is no longer available.`); return }
    if (g.mode === 'quiz') { await send(chatId, `That one needs you to answer its question first — tap it in 🎁 Gifts and send your answer.`); return }
    if ((g.winners || []).some(w => w.uid === uid)) { await send(chatId, `You already claimed this one 🎁`); return }
    if (g.mode === 'first' && (g.winners || []).length >= 1) { await send(chatId, `Someone already grabbed this one — check the other open gifts!`); return }
    if (g.mode === 'everyone' && g.maxClaims > 0 && (g.winners || []).length >= g.maxClaims) { await send(chatId, `This gift is all claimed out — check back for the next one!`); return }
    g.winners = g.winners || []
    g.winners.push({ uid, ts: Date.now() })
    if (g.mode === 'first') g.status = 'closed'
    await saveGift(g)
    await awardGiftTo(g, uid)
    await deliverGift(uid, g)
    await notifyOwnerGiftLine(g, uid, 'claimed')
    await send(chatId, `🎁 Gift claimed — check your DMs from the bot!`)
  }
  async function answerGift(chatId, uid, giftId, text) {
    const g = await getGift(giftId)
    if (!g || g.status !== 'open') { await send(chatId, `That gift is no longer available.`); return }
    if ((g.winners || []).length >= 1) { await send(chatId, `Someone already won this one!`); return }
    g.attempts = g.attempts || {}
    g.attempts[String(uid)] = text.slice(0, 200)
    await saveGift(g)
    if (normAnswer(text) === normAnswer(g.answer)) {
      g.winners = [{ uid, ts: Date.now() }]
      g.status = 'closed'
      await saveGift(g)
      await awardGiftTo(g, uid)
      await deliverGift(uid, g)
      await notifyOwnerGiftLine(g, uid, 'WON (correct answer)')
      await send(chatId, `🎉 Correct! You won — the gift is in your DMs.`)
    } else {
      await send(chatId, `❌ Not quite — think it over and send another answer. (Wrong answers land on the owner's screen, who can also award the gift by hand.)`)
    }
  }

  // ── User tracking (stats) ──
  async function trackUser(uid) {
    if (!uid) return
    await redis('SADD', 'bot:users', uid)
    const dk = `bot:active:${todayKey()}`
    await redis('SADD', dk, uid)
    await redis('EXPIRE', dk, '172800')
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
    const ot = await oneTimeInfo(userId)
    const ck = await cookieInfo(userId)
    let status = `No access yet${AUTO_TRIAL ? ' — try /find or /findco to start your free trial' : ''}.`
    if (pass.valid) {
      status = `Paid pass active until ${new Date(pass.expires).toISOString().slice(0, 10)}.`
    } else if (ot.remaining > 0) {
      status = `🎟️ ${ot.remaining} free search${ot.remaining === 1 ? '' : 'es'} left (covers /find, /findco or /scout, max ${FREE_RESULT_CAP} results each).`
    } else if (AUTO_TRIAL) {
      const { result: everUsed } = await redis('GET', `trial:used:${userId}`)
      if (everUsed) {
        const { result: usedToday } = await redis('GET', `daily:used:${userId}:${todayKey()}`)
        status = usedToday
          ? `⏳ Today's free search is used — resets at midnight UTC.`
          : `🎁 Your free daily search is ready — /find, /findco or /scout, max ${DAILY_RESULT_CAP} results.`
      }
    }
    if (status.startsWith('No access') && ck.present) {
      status = ck.fresh
        ? `Your own connection is active (refreshes until ${new Date(ck.expires * 1000).toISOString().slice(0, 10)}).`
        : 'Your connection has expired — re-send your session file to refresh.'
    }
    const kb = []
    if (PAYMENT_LINK) kb.push([B(`💳 Go unlimited — ${PASS_DAYS} days (${ACCESS_PRICE})`, 'pay:request')])
    kb.push([B('🔌 Connect my own account (free)', 'pay:byoc')])
    kb.push([B('🏠 Main menu', 'menu:main')])
    await tgCall('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text:
        `<b>💎 This feature is part of the full version</b>\n\n` +
        (AUTO_TRIAL ? `🎁 Free plan: your first ${TRIAL_SIZE} searches are on us (up to ${FREE_RESULT_CAP} fresh results each) — ` +
                      `no card and no request needed, just run /find, /findco or /scout. After that you get one free ` +
                      `search every day (up to ${DAILY_RESULT_CAP} results), forever. ${RESULTS_ARE_YOURS_LINE}\n\n` : '') +
        `To unlock everything:\n` +
        `1️⃣ ${PASS_DAYS}-day all-access pass — ${ACCESS_PRICE}, every feature, no result caps\n` +
        `2️⃣ Ask the owner for extra one-time searches\n` +
        `3️⃣ Connect your own account (free) and search on your own private connection\n\n` +
        `Searches run one at a time so every result stays accurate — if there's a line, ` +
        `I'll hold your spot and message you the moment yours starts.\n\n` +
        `<b>Your status:</b> ${status}`,
      reply_markup: { inline_keyboard: kb }
    })
  }

  // cmdBase lets a one-time credit cover exactly what it's meant to (/find,
  // /findco) without also unlocking /scout, /fresh, etc. for free.
  async function gateOwnerSession(chatId, userId, cmdBase, who) {
    if (isOwner) return true
    const tier = await tierOf(userId)
    if (tier === 'paid' || tier === 'byoc') return true
    // The lifetime trial and the once-a-day follow-on both only ever cover /find and
    // /findco — never /scout, /fresh (which turns on INDEFINITE background monitoring,
    // not a bounded search), /freshoff, /scoutlist or /autopitch. Those stay paid/owner-only.
    if ((tier === 'onetime' || tier === 'daily') && FREE_TIER_CMDS.includes(cmdBase)) return true
    if (tier === 'none' && AUTO_TRIAL && FREE_TIER_CMDS.includes(cmdBase)) {
      // One free search per Telegram account, ever — trial:used is permanent, so
      // flipping auto-trial off/on or even revoking someone never hands out a second.
      const { result: used } = await redis('GET', `trial:used:${userId}`)
      if (!used) {
        await grantOneTime(userId, TRIAL_SIZE, who || '')
        await redis('SET', `trial:used:${userId}`, '1')
        await send(chatId, `🎁 You've got ${TRIAL_SIZE} free search${TRIAL_SIZE === 1 ? '' : 'es'} on the house — go ahead, ` +
          `each covers one /find, /findco or /scout run (max ${FREE_RESULT_CAP} results). After that you'll get one free ` +
          `search a day instead (max ${DAILY_RESULT_CAP} results), or get a pass for unlimited. ${RESULTS_ARE_YOURS_LINE}`)
        return true
      }
      // Already had the lifetime trial — are they just between daily uses?
      const { result: usedToday } = await redis('GET', `daily:used:${userId}:${todayKey()}`)
      if (usedToday) {
        await send(chatId,
          `⏳ You've already used today's free search (${DAILY_RESULT_CAP} results, /find, /findco or /scout). ` +
          `One free shot per account per day — resets at midnight UTC. Grab a pass for unlimited any time: /access`)
        return false
      }
    }
    await sendAccessScreen(chatId, userId)
    return false
  }

  // One shared Google session -> one job at a time. This both stops a person
  // flooding the queue with several requests and gives everyone a straight
  // answer: their place in line, and a ping the moment their turn comes.
  // Spends one unit of free access at the exact moment a search actually runs —
  // not just when the command starts — so an abandoned flow never burns a credit.
  // Shared by every FREE_TIER_CMDS entry: /find and /findco spend it right before
  // queueing (queueJob below); /scout, which never touches the job queue at all,
  // spends it right before its own search actually executes.
  async function spendFreeCredit(chatId, tier, userId) {
    if (tier === 'onetime') {
      const { result } = await redis('DECRBY', `onetime:${userId}`, '1')
      if ((parseInt(result) || 0) < 0) {
        await redis('SET', `onetime:${userId}`, '0')
        await send(chatId, `Your one-time search credit has already been used. Send /access to see other ways in.`)
        return false
      }
      return true
    }
    if (tier === 'daily') {
      // Atomic claim via SET...NX: two near-simultaneous taps can't both slip
      // through and double-spend the same day's single free use.
      const { result: claimed } = await redis('SET', `daily:used:${userId}:${todayKey()}`, '1', 'NX', 'EX', '172800')
      if (claimed !== 'OK') {
        await send(chatId, `Your free daily search was just used — come back tomorrow, or grab a pass: /access`)
        return false
      }
      return true
    }
    return true   // owner / paid / byoc -> nothing to spend
  }

  async function queueJob(chatId, userId, payload, description) {
    const ownerRunning = !ADMIN_ID || userId === ADMIN_ID
    let tier = null
    if (!ownerRunning) {
      // Self-healing inflight check. The marker is JSON {job, ts} with a 2h TTL;
      // anything older than 90 minutes (jobs are hard-capped at 30 min) is a
      // leftover from a crashed/interrupted run and gets reclaimed instead of
      // locking the user out forever. Legacy bare-job-id markers (written
      // before timestamps existed) are reclaimed once their job has left the
      // queue — if it's not queued anymore, it's not coming back.
      const { result: existing } = await redis('GET', `inflight:${userId}`)
      if (existing) {
        let stale = false
        try {
          const rec = JSON.parse(existing)
          stale = !rec.ts || (Date.now() - rec.ts) > 90 * 60 * 1000
        } catch {
          const { result: queued } = await redis('LRANGE', 'jobs:find', 0, -1)
          stale = !(queued || []).some(j => String(j).includes(existing))
        }
        if (!stale) {
          await send(chatId,
            `⏳ You already have a request queued or running — I'll message you the moment it starts, ` +
            `and again when it's done. Send another after that; one at a time keeps the queue moving for everyone.`)
          return false
        }
        await redis('DEL', `inflight:${userId}`)   // reclaim the stale marker
      }
      tier = await tierOf(userId)
      if (!(await spendFreeCredit(chatId, tier, userId))) return false
    }
    if (!payload.job_id) payload.job_id = `job-${Date.now()}`
    if (!ownerRunning) {
      // user_id rides on EVERY non-owner job (not just BYOC) so the daemon can
      // clear this person's inflight marker in its finally block the moment the
      // job ends. Before this, paid/trial/daily jobs ran without user_id, the
      // marker was never cleared, and those users were locked out permanently
      // with "already have a request queued or running". Only BYOC users also
      // get byoc:true (the daemon uses THEIR cookies and THEIR hourly budget).
      payload.user_id = userId
      if (tier === 'byoc') payload.byoc = true
    }
    await redis('RPUSH', 'jobs:find', JSON.stringify(payload))
    if (!ownerRunning) {
      await redis('SET', `inflight:${userId}`, JSON.stringify({ job: payload.job_id, ts: Date.now() }), 'EX', String(2 * 60 * 60))
      const { result: len } = await redis('LLEN', 'jobs:find')
      const position = parseInt(len) || 1
      if (position > 1) {
        await send(chatId,
          `🔎 You're #${position} in line (${position - 1} request${position - 1 === 1 ? '' : 's'} ahead of you${description ? ' — ' + description : ''}). ` +
          `Only one search runs at a time so results stay accurate — I'll message you the moment yours starts.`)
      } else {
        await send(chatId, `🔎 You're next in line${description ? ' — ' + description : ''} — should start within a minute or two.`)
      }
    }
    return true
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
    // queueJob attaches user_id to every non-owner job (so the daemon can clear
    // their inflight marker when the job ends) and byoc:true only for genuine
    // BYOC users, whose own cookies + own hourly budget the discovery run then
    // uses. Everyone else borrows the owner's shared session.
    const tier = await tierOf(userId)
    // A free search (lifetime trial, or the once-a-day follow-on) is capped —
    // unlimited is what the paid pass is for.
    const cap = tier === 'onetime' ? await resultCapFor(userId, FREE_RESULT_CAP) : tier === 'daily' ? DAILY_RESULT_CAP : null
    let capped = false
    if (cap && companies.length > cap) {
      companies = companies.slice(0, cap)
      capped = true
    }
    const payload = {
      type: 'discovery', chat_id: chatId, job_id: jobId, companies, max: 40
    }
    const label = `${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`
    const queued = await queueJob(chatId, userId, payload, label)
    if (!queued) return
    const dispatched = await triggerGithubWorkflow()
    await send(chatId,
      `✅ Discovery job posted: ${label} (job ${jobId}).\n` +
      (capped ? `🎟️ You're on the free trial — capped at ${cap} companies per search, so only the first ${cap} from your list are included. ` +
                `${tier === 'daily' ? RESULTS_ARE_YOURS_LINE + ' ' : ''}Get a pass (/access) for the full list.\n` : '') +
      (dispatched
        ? `⚡ Starting now — first results land here within a couple of minutes.\n`
        : `⏳ Queued — it starts automatically on the next pass.\n`) +
      `⏱️ Give it a few minutes per company (~15-25/hour) — each one gets a full live profile built from scratch: ` +
      `the people behind the company, their website, phone and location, socials, and the best way to reach them. ` +
      `Nothing comes from a stale database; leftovers continue automatically and results arrive here as they're found.`)
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

  // A store's real age = its EARLIEST birthday signal across INDEPENDENT
  // sources. crt.sh alone lies: its history has gaps, so an old store's
  // renewal cert can compute as "12 days old". So we ask several free
  // sources and take the OLDEST answer — proof of old always wins:
  //   1. crt.sh + CertSpotter (two independent certificate indexes, so a
  //      gap in one is caught by the other)
  //   2. Wayback Machine first snapshot
  //   3. urlscan.io first sighting
  // Only myshopify.com hosts qualify; birthdays never change, so the final
  // answer is cached in Redis forever under a NEW key (age2:) — any wrong
  // "young" ages cached by the old buggy version are simply ignored.
  // "No source answered" is cached for 6h (-1) so a flaky day doesn't
  // stall every future batch. Uses CRTSH_RELAY_URL for the crt.sh leg.
  async function waybackFirstSeenMs(host) {
    try {
      const r = await fetch(
        `https://web.archive.org/cdx/search/cdx?url=${host}&matchType=domain&output=json&fl=timestamp&filter=statuscode:200&limit=1`,
        { signal: AbortSignal.timeout(6000) })
      if (!r.ok) return null
      const data = await r.json()
      if (!Array.isArray(data) || data.length < 2) return null
      const m = String(data[1][0] || '').match(/^(\d{4})(\d{2})(\d{2})/)
      return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : null
    } catch { return null }
  }

  async function urlscanFirstSeenMs(host) {
    try {
      const r = await fetch(
        `https://urlscan.io/api/v1/search/?q=domain:${encodeURIComponent(host)}&size=1&sort=_time:asc`,
        { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'lead-scraper-bot (shopify fresh-store watcher)' } })
      if (!r.ok) return null
      const t = (await r.json())?.results?.[0]?.task?.time
      return t ? Date.parse(t) : null
    } catch { return null }
  }

  async function productsJsonFirstSeenMs(host) {
    try {
      const r = await fetch(`https://${host}/products.json?limit=250`,
        { signal: AbortSignal.timeout(6000) })
      if (!r.ok) return null
      const data = await r.json()
      let earliest = null
      for (const p of data?.products || []) {
        const t = p.created_at ? Date.parse(p.created_at) : NaN
        if (!isNaN(t) && (earliest === null || t < earliest)) earliest = t
      }
      return earliest
    } catch { return null }
  }

  async function certspotterFirstSeenMs(host) {
    try {
      const r = await fetch(
        `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(host)}&include_subdomains=false`,
        { signal: AbortSignal.timeout(6000) })
      if (!r.ok) return null
      const rows = await r.json()
      let earliest = null
      for (const row of rows || []) {
        const nb = row.not_before ? Date.parse(row.not_before) : NaN
        if (!isNaN(nb) && (earliest === null || nb < earliest)) earliest = nb
      }
      return earliest
    } catch { return null }
  }

  async function getStoreAgeDays(url) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
    if (!host.endsWith('.myshopify.com')) return null
    const cacheKey = `age2:${host}`
    const { result: cached } = await redis('GET', cacheKey)
    if (cached !== null && cached !== undefined) {
      const v = JSON.parse(cached)
      return v === -1 ? null : v
    }
    const signals = []
    // 1. crt.sh (via relay when configured)
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 6000)
      const r = await fetch(`${CRTSH_BASE}?q=${encodeURIComponent(host)}`, {
        signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' }
      })
      clearTimeout(t)
      if (r.ok) {
        const rows = await r.json()
        for (const row of rows || []) {
          const nb = row.not_before ? Date.parse(row.not_before) : NaN
          if (!isNaN(nb)) signals.push(nb)
        }
      }
    } catch {}
    // 2–4. independent sources (each silently returns null on failure)
    const cs = await certspotterFirstSeenMs(host)
    if (cs) signals.push(cs)
    const wb = await waybackFirstSeenMs(host)
    if (wb) signals.push(wb)
    const us = await urlscanFirstSeenMs(host)
    if (us) signals.push(us)
    const pj = await productsJsonFirstSeenMs(host)
    if (pj) signals.push(pj)
    if (!signals.length) { await redis('SET', cacheKey, '-1', 'EX', 21600); return null }
    const earliest = Math.min(...signals)   // oldest answer = the truth
    const age = Math.floor((Date.now() - earliest) / 86400000)
    await redis('SET', cacheKey, JSON.stringify(age))
    return age
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
    await send(chatId, `🔍 Searching for ${wantCount} fresh leads — "${label}"...\n\n` +
      `⏱️ This takes a few minutes: every store is checked live, right now — fetched, opened, scanned for ` +
      `emails/socials/page speed, and cross-checked against everything you've already seen so what's ` +
      `returned is genuinely new. Nothing comes from a cached list.`)
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
  const PUBLIC_CMDS = ['/start', '/menu', '/help', '/cancel', '/newuk', '/access']
  const actorId = String(body.callback_query?.from?.id || body.message?.from?.id || '')
  await trackUser(actorId)
  const isOwner = !ADMIN_ID || actorId === ADMIN_ID
  // The SAME tier check /find and /findco use (gateOwnerSession), computed once
  // and reused everywhere a button or menu screen needs to know "can this
  // specific person actually use the paid/granted features" — not just
  // "is the free preview switched on." A granted user is never blocked by
  // PUBLIC_ACCESS being off, and never sees a 🔒 on something they can use.
  const actorTier = isOwner ? 'owner' : await tierOf(actorId)
  // The bot is open to everyone by default — nobody has to request access or
  // upload cookies just to reach the menu or try /find, /findco, /scout. The
  // ACTUAL enforcement (2 lifetime free searches, then 1/day, caps, and the
  // lock once that's used up) still lives entirely in gateOwnerSession below,
  // which checks actorTier directly — that logic is unchanged. This flag only
  // ever controlled whether someone could REACH a command at all, not what
  // they're allowed to do once there, so opening it up here doesn't loosen
  // any of the trial/daily/cap rules — it just removes a second, separate
  // wall that used to sit in front of all of them.
  const hasAccess = true

  const B = (text, data) => ({ text, callback_data: data })

  function screenFor(name, owner, hasAccessFlag) {
    const go = (label, data) => hasAccessFlag ? B(label, data) : B('🔒 ' + label, 'locked')
    const nav = (back) => [B('⬅️ Back', back || 'menu:main'), B('🏠 Main menu', 'menu:main')]

    switch (name) {
      case 'uk':
        return {
          text:
            `<b>🇬🇧 New UK Companies</b>\n\n` +
            `<b>What it does:</b> pulls brand-new companies straight from the official UK company register. Free and 100% real.\n\n` +
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
            `<b>For each company I check:</b> the people behind it (the founders) → their website → their business listing → each person's LinkedIn, Instagram and Facebook.\n\n` +
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
            `Finds real businesses in any city — restaurants, salons, gyms, car repair, real estate — with phone, website and email when available. You get a .txt report.\n\n` +
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
            // Owner-only, deliberately — this is the real admin screen (grant/revoke/pricing),
            // so it checks true isOwner, never the broader "has access" flag.
            [owner ? B('👥 Access requests', 'menu:accesslist') : B('🔒 Access requests', 'locked')],
            [B('🧹 Cancel / reset', 'run:/cancel')],
            [B('📜 All commands', 'menu:cmds')],
            nav()
          ]
        }
      case 'help':
        return {
          text:
            `<b>❓ How this bot works</b>\n\n` +
            `In one line: it finds businesses around the world — then finds a way to contact them.\n\n` +
            `<b>The main paths</b>\n` +
            `1️⃣ 🗺️ Local Businesses — scout any city worldwide; each lead comes with phone, website, email, reviews, socials and an opportunity score\n` +
            `2️⃣ 🇬🇧 New UK Companies — freshly incorporated UK companies, straight from the official register\n` +
            `3️⃣ 🕵️ Find Contacts — paste any company list; get websites, emails, phones, socials and the owners' LinkedIn\n\n` +
            `<b>Words used here</b>\n` +
            `• <b>Lead</b> — a business you could sell to\n` +
            `• <b>Director</b> — the person who started the company (the founder)\n\n` +
            `Stuck? Tap 🧹 Cancel in Tools, or send /start.`,
          kb: [
            [B('🗺️ Start with Local Businesses', 'menu:local')],
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
            `/find &lt;city&gt; &lt;niche&gt; [count] — local businesses\n` +
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
            `/cancel — stop whatever I'm waiting for\n` +
            `/gift — open the gift box (free searches/passes from the owner)\n` +
            `/admin — owner admin panel\n\n` +
            `📄 Send a .txt file of links and I'll extract, dedupe and check them.\n` +
            `When a scout finishes, send outreach messages separated by / and I'll pair them with emails.`,
          kb: [nav('menu:tools')]
        }
      case 'main':
      default: {
        const custom = START_TEXT
        return {
          text: custom
            ? (custom + (hasAccessFlag ? '' : `\n\n🔒 = needs access — tap 💳 Get Access below.`))
            : (
            `<b>👋 Lead Scraper Bot</b>\n\n` +
            `Find businesses around the world — their contact info, reviews, socials, and everything you need to reach them.\n\n` +
            `<b>New here?</b> Try 🗺️ Local Businesses to scout any city on Earth, or 🕵️ Find Contacts to turn a company list into real emails, phones and socials.\n\n` +
            (hasAccessFlag ? '' : `🔒 = needs access — tap 💳 Get Access below.\n\n`) +
            `<b>What do you want to do?</b>`),
          kb: [
            [go('🗺️ Local Businesses', 'menu:local'), go('🕵️ Find Contacts', 'menu:findco')],
            [B('🇬🇧 New UK Companies', 'menu:uk'), go('🛍️ Shopify Stores', 'menu:shopify')],
            [go('📂 My Leads', 'menu:leads'), B('🎁 Gifts', 'menu:gifts')],
            [B('🧰 Tools', 'menu:tools'), B('❓ How it works', 'menu:help')],
            owner ? [B('🛠 Admin', 'menu:admin')] : [B('💳 Get Access', 'run:/access')]
          ]
        }
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
  async function pushScreen(chatId, messageId, s) {
    const base = { chat_id: chatId, text: s.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: s.kb }, disable_web_page_preview: true }
    if (messageId) {
      const d = await tgCall('editMessageText', { ...base, message_id: messageId })
      if (d && (d.ok || /not modified/i.test(d.description || ''))) return
    }
    await tgCall('sendMessage', base)
  }
  async function showScreen(chatId, messageId, name, owner, hasAccessFlag) {
    await pushScreen(chatId, messageId, screenFor(name, owner, hasAccessFlag))
  }

  // Owner-only: who's waiting, who's already in, one tap to approve/deny/revoke,
  // and the two editable fields (contact + price) right at the top.
  async function listOneTimeHolders() {
    const { result: ids } = await redis('SMEMBERS', 'access:onetime:ids')
    if (!ids || !ids.length) return []
    const out = []
    for (const oid of ids) {
      const { remaining } = await oneTimeInfo(oid)
      if (remaining <= 0) continue
      const { result: metaRaw } = await redis('GET', `access:meta:${oid}`)
      let who = ''
      if (metaRaw) { try { who = JSON.parse(metaRaw).who || '' } catch {} }
      out.push({ id: oid, who, remaining })
    }
    return out
  }

  async function buildAccessListScreen() {
    const pending = await listPendingRequests()
    const granted = (await listGrantedPasses()).filter(g => g.valid)
    const oneTime = await listOneTimeHolders()
    let text =
      `<b>👥 Access requests</b>\n\n` +
      `💳 Price shown to people: <b>${ACCESS_PRICE}</b>\n` +
      `📇 Payment contact: <b>${PAY_CONTACT ? PAY_CONTACT.replace(/[<>&]/g, '') : '(not set — tap below to add one)'}</b>\n` +
      `⏳ Pass length: ${PASS_DAYS} days · 🎟️ one-time credit covers 1 search\n` +
      `🎁 Free trial (${TRIAL_SIZE} search${TRIAL_SIZE === 1 ? '' : 'es'}/account, max ${FREE_RESULT_CAP} results each, automatic): <b>${AUTO_TRIAL ? 'ON' : 'OFF'}</b>\n` +
      `📅 After that, free daily search: max ${DAILY_RESULT_CAP} results, once per account per day, same ${AUTO_TRIAL ? 'ON' : 'OFF'} switch, resets midnight UTC\n`
    const kb = []
    if (pending.length) {
      text += `\n<b>⏳ Pending (${pending.length})</b>\n`
      for (const p of pending.slice(0, 10)) {
        const age = Math.max(0, Math.round((Date.now() - (p.ts || 0)) / 3600000))
        const label = (p.who || p.id).replace(/[<>&]/g, '')
        text += `• <code>${p.id}</code>${p.who ? ' — ' + label : ''} (${age}h ago)\n`
        kb.push([B(`🎟️ 1 search`, `pay1:${p.id}`), B(`✅ ${PASS_DAYS}d pass`, `payok:${p.id}`), B('❌ Deny', `payno:${p.id}`)])
      }
      if (pending.length > 10) text += `…and ${pending.length - 10} more\n`
    } else {
      text += `\nNo pending requests right now.\n`
    }
    if (granted.length) {
      text += `\n<b>✅ Active passes (${granted.length})</b>\n`
      for (const g of granted.slice(0, 10)) {
        const label = (g.who || g.id).replace(/[<>&]/g, '')
        text += `• <code>${g.id}</code>${g.who ? ' — ' + label : ''} — until ${new Date(g.expires).toISOString().slice(0, 10)}\n`
        kb.push([B(`🚫 Revoke ${label}`.slice(0, 30), `payrevoke:${g.id}`)])
      }
    }
    if (oneTime.length) {
      text += `\n<b>🎟️ One-time credits (${oneTime.length})</b>\n`
      for (const o of oneTime.slice(0, 10)) {
        const label = (o.who || o.id).replace(/[<>&]/g, '')
        text += `• <code>${o.id}</code>${o.who ? ' — ' + label : ''} — ${o.remaining} remaining\n`
        kb.push([B(`🚫 Revoke ${label}`.slice(0, 30), `pay1revoke:${o.id}`)])
      }
    }
    kb.push([B('✏️ Change contact', 'payset:contact'), B('✏️ Change price', 'payset:price')])
    kb.push([B(AUTO_TRIAL ? '🎁 Turn free trial OFF' : '🎁 Turn free trial ON', 'payset:trial'), B('✏️ Change trial size', 'payset:trialsize')])
    kb.push([B('⬅️ Back', 'menu:tools'), B('🏠 Main menu', 'menu:main')])
    return { text, kb }
  }


  // ── Admin panel + gift screens (async builders, like buildAccessListScreen) ──
  async function buildAdminScreen() {
    const [{ result: qlen }, pending, granted, oneTime, giftsOpen] = await Promise.all([
      redis('LLEN', 'jobs:find'),
      listPendingRequests(),
      listGrantedPasses(),
      listOneTimeHolders(),
      openGiftList()
    ])
    const activePasses = (granted || []).filter(g => g.valid).length
    const text =
      `<b>🛠 Admin panel</b>\n\n` +
      `📊 Queue: ${parseInt(qlen) || 0} job(s) waiting · ⏳ ${(pending || []).length} access request(s)\n` +
      `✅ ${activePasses} active pass(es) · 🎟️ ${(oneTime || []).length} one-time holder(s)\n` +
      `🎁 ${(giftsOpen || []).length} open gift(s)\n\n` +
      `Everything owner-only lives here. Tap a section:`
    const kb = [
      [B('👥 Access requests', 'menu:accesslist')],
      [B('🎁 Gifts', 'menu:admingifts')],
      [B('📈 Stats', 'menu:stats'), B('📣 Broadcast', 'adminedit:broadcast')],
      [B('📜 Command reference', 'menu:admincmds')],
      [B('✏️ Edit /start message', 'adminedit:start')],
      [B('⬅️ Back', 'menu:tools'), B('🏠 Main menu', 'menu:main')]
    ]
    return { text, kb }
  }

  async function buildGiftAdminScreen() {
    const ids = (await giftIds()).slice(-20).reverse()
    let text =
      `<b>🎁 Gift admin</b>\n\n` +
      `A gift = a bundle of searches (with a result cap) or a days-pass, plus an optional personal message.\n` +
      `Modes: 👥 everyone (each user claims once) · ⚡ first (one winner, first tap) · ❓ quiz (question — first correct answer wins, or you pick the winner yourself).\n`
    const kb = [[B('➕ Create a gift', 'giftnew')]]
    for (const id of ids) {
      const g = await getGift(id)
      if (!g) continue
      const claims = (g.winners || []).length
      text += `\n• <code>${g.id}</code> — ${g.status === 'open' ? '🟢 open' : '🔴 closed'} — ${g.mode} — ${giftPrizeText(g)} — ${claims} winner(s)`
      if (g.message) text += `\n   💌 "${g.message.slice(0, 60)}"`
      if (g.mode === 'quiz' && g.question) text += `\n   ❓ ${g.question.slice(0, 80)}`
      if (g.status === 'open') kb.push([B(`🔒 Close ${g.id}`, `giftclose:${g.id}`)])
      if (g.mode === 'quiz') kb.push([B(`📝 Attempts (${Object.keys(g.attempts || {}).length})`, `giftatt:${g.id}`)])
    }
    if (ids.length === 0) text += `\n\nNo gifts yet — tap ➕ Create a gift.`
    kb.push([B('⬅️ Back', 'menu:admin'), B('🏠 Main menu', 'menu:main')])
    return { text, kb }
  }

  async function buildGiftAttemptsScreen(gid) {
    const g = await getGift(gid)
    if (!g) return null
    const attempts = g.attempts || {}
    const uids = Object.keys(attempts)
    let text = `<b>📝 Attempts — ${gid}</b>\n\n❓ ${g.question || ''}\n✅ Correct answer: ${g.answer || ''}\n`
    const kb = []
    if (!uids.length) text += `\nNo attempts yet.`
    for (const uid of uids.slice(-20)) {
      const won = (g.winners || []).some(w => w.uid === uid)
      text += `\n• <code>${uid}</code>: "${String(attempts[uid]).slice(0, 80)}" ${won ? '🏆 winner' : ''}`
      if (!won && g.status === 'open') kb.push([B(`🏆 Mark ${uid} as winner`, `giftwin:${gid}:${uid}`)])
    }
    kb.push([B('⬅️ Back', 'menu:admingifts')])
    return { text, kb }
  }

  async function buildGiftsScreen(userId) {
    const open = await openGiftList()
    if (!open.length) {
      return { text: `<b>🎁 Gifts</b>\n\nNo open gifts right now — check back soon!`, kb: [[B('🏠 Main menu', 'menu:main')]] }
    }
    let text = `<b>🎁 Open gifts</b>\n\nFirst come, first served — tap to claim.`
    const kb = []
    for (const g of open) {
      const mine = (g.winners || []).some(w => w.uid === userId)
      const taken = g.mode === 'first' && (g.winners || []).length >= 1
      const exhausted = g.mode === 'everyone' && g.maxClaims > 0 && (g.winners || []).length >= g.maxClaims
      text += `\n\n🎁 <b>${giftPrizeText(g)}</b>`
      if (g.message) text += `\n💌 ${g.message}`
      if (g.mode === 'quiz') text += `\n❓ ${g.question}`
      if (mine) { text += `\n✅ You already claimed this one.`; continue }
      if (taken || exhausted) { text += `\n🔴 Already taken.`; continue }
      kb.push(g.mode === 'quiz'
        ? [B(`✏️ Answer for: ${giftPrizeText(g)}`, `giftans:${g.id}`)]
        : [B(`🎁 Claim: ${giftPrizeText(g)}`, `giftclaim:${g.id}`)])
    }
    kb.push([B('🏠 Main menu', 'menu:main')])
    return { text, kb }
  }

  function adminCommandsScreen() {
    return {
      text:
        `<b>📜 Admin command reference</b>\n\n` +
        `<b>/admin</b> — this panel (stats + shortcuts)\n` +
        `<b>/accesslist</b> — pending requests, active passes, one-time credits — approve / deny / revoke with buttons\n` +
        `<b>/grant &lt;user id&gt; [days]</b> — give a user a paid pass (default ${PASS_DAYS}d)\n` +
        `<b>/grant1 &lt;user id&gt; [count]</b> — give one-time search credits\n` +
        `<b>/revoke &lt;user id&gt;</b> — strip pass + credits and block their free trial\n\n` +
        `<b>🎁 Gifts</b> (also: /gift → 🎁 Gifts)\n` +
        `Create a gift in 4 taps: prize (searches with a result cap, or a days-pass) → who gets it (everyone / first claim / quiz question) → optional personal message. Winners get it by DM; you get a DM on every claim. For quiz gifts, open 📝 Attempts to read answers and 🏆 mark a winner by hand.\n\n` +
        `<b>✏️ Text editing</b>\n` +
        `✏️ Edit /start message — replace the welcome text shown on /start for everyone ("clear" resets it)\n\n` +
        `<b>Other owner tools</b>\n` +
        `<b>/audit</b> — last 50 commands, who & when\n` +
        `<b>/others</b> — links filtered out of the last scout\n` +
        `<b>/black &lt;url&gt;</b> — import a raw domain blacklist\n` +
        `<b>/scoutlist &lt;url&gt;</b> — check a hosted domain list as leads`,
      kb: [[B('⬅️ Back', 'menu:admin'), B('🏠 Main menu', 'menu:main')]]
    }
  }

  async function buildStatsScreen() {
    const [{ result: total }, { result: starts }] = await Promise.all([
      redis('SCARD', 'bot:users'),
      redis('GET', 'stats:starts')
    ])
    const keys = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      keys.push(`bot:active:${d}`)
    }
    await redis('SUNIONSTORE', 'bot:active:7d_tmp', ...keys)
    const { result: active7 } = await redis('SCARD', 'bot:active:7d_tmp')
    await redis('DEL', 'bot:active:7d_tmp')
    const { result: activeToday } = await redis('SCARD', `bot:active:${todayKey()}`)
    const text =
      `<b>📈 Bot stats</b>\n\n` +
      `👥 Total users (ever interacted): <b>${parseInt(total) || 0}</b>\n` +
      `🚀 /start clicks (all time): <b>${parseInt(starts) || 0}</b>\n` +
      `📅 Active today: <b>${parseInt(activeToday) || 0}</b>\n` +
      `🗓 Active in the last 7 days: <b>${parseInt(active7) || 0}</b>\n\n` +
      `A "user" is anyone who has ever sent a message or tapped a button.`
    return { text, kb: [
      [B('📣 Broadcast to all users', 'adminedit:broadcast')],
      [B('⬅️ Back', 'menu:admin'), B('🏠 Main menu', 'menu:main')]
    ] }
  }

  async function broadcastMessage(fromChatId, text) {
    const { result: ids } = await redis('SMEMBERS', 'bot:users')
    if (!ids || !ids.length) { await send(fromChatId, 'No users to broadcast to yet.'); return }
    let ok = 0, failed = 0
    for (const uid of ids) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: uid, text: text.slice(0, 4096), disable_web_page_preview: true })
        })
        const d = await r.json()
        if (d.ok) ok++; else failed++
      } catch { failed++ }
      await new Promise(r => setTimeout(r, 35))
    }
    await send(fromChatId,
      `📣 Broadcast done — delivered to <b>${ok}</b> user(s)` +
      (failed ? `, ${failed} failed (they blocked the bot or deleted the chat)` : '') + `.`)
  }

  async function answerCb(id, text, alert) {
    await tgCall('answerCallbackQuery', { callback_query_id: id, ...(text ? { text, show_alert: !!alert } : {}) })
  }

  // Makes the "/" list in Telegram show /start (and the rest) + the Menu button.
  async function registerCommands(ownerChatId) {
    const pub = [
      ['start', '🏠 Open the main menu'], ['menu', '🏠 Main menu'], ['newuk', '🇬🇧 New UK companies'],
      ['access', '💳 Get access / check status'], ['gift', '🎁 Open the gift box'],
      ['help', '❓ How this bot works'], ['cancel', '🧹 Stop what I\'m waiting for']
    ]
    const all = [
      ['start', '🏠 Open the main menu'], ['menu', '🏠 Main menu'], ['help', '❓ How this bot works'],
      ['newuk', '🇬🇧 New UK companies'], ['findco', '🕵️ Find contacts for companies'],
      ['find', '🗺️ Local businesses'], ['scout', '🛍️ Search Shopify stores'],
      ['fresh', '🌱 Watch for brand-new stores'], ['freshoff', '🛑 Stop watching new stores'],
      ['campaigns', '📋 Your campaigns'], ['leads', '📂 Leads by status'], ['mark', '✅ Update a lead\'s status'],
      ['others', '🚫 Blacklisted links'], ['black', '🔒 Add to blacklist'], ['scoutlist', '🕵️ Scan a domain list'],
      ['audit', '🧾 Activity log'], ['cancel', '🧹 Stop what I\'m waiting for'],
      ['gift', '🎁 Gifts (manage, owner)'], ['admin', '🛠 Admin panel (owner)'],
      ['access', '🔑 My access status'], ['grant', '✅ Give a user a day-pass (owner)'],
      ['grant1', '🎟️ Give a user 1 search (owner)'], ['accesslist', '👥 Pending + active access (owner)']
    ].map(([command, description]) => ({ command, description }))
    await tgCall('setMyCommands', { commands: pub.map(([command, description]) => ({ command, description })) })
    await tgCall('setMyCommands', { commands: all, scope: { type: 'chat', chat_id: ownerChatId } })
    await tgCall('setChatMenuButton', { menu_button: { type: 'commands' } })
  }

  // ── Menu / guided-flow button presses (menu:, run:, wiz:, locked) ──
  if (body.callback_query && /^(menu:|run:|wiz:|locked|pay|gift|adminedit)/.test(body.callback_query.data || '')) {
    const cq = body.callback_query
    const d = cq.data
    const cbChat = cq.message.chat.id
    const cbMsg = cq.message.message_id

    const isPayCb = d === 'pay:request' || d === 'pay:byoc'
    // Same rule as the text gate: a granted user's taps always work, whether or
    // not PUBLIC_ACCESS is on — that toggle only governs a totally un-granted stranger.
    if (!isOwner && !PUBLIC_ACCESS && !isPayCb && !hasAccess) {
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
      const screenName = d.slice(5)
      if (screenName === 'accesslist') {
        if (!isOwner) { await answerCb(cq.id, '🔒 Owner-only.', true); return res.status(200).send('OK') }
        await pushScreen(cbChat, cbMsg, await buildAccessListScreen())
        return res.status(200).send('OK')
      }
      if (screenName === 'gifts') {
        await pushScreen(cbChat, cbMsg, await buildGiftsScreen(actorId))
        return res.status(200).send('OK')
      }
      if (screenName === 'admin' || screenName === 'admingifts' || screenName === 'admincmds' || screenName === 'stats') {
        if (!isOwner) { await answerCb(cq.id, '🔒 Owner-only.', true); return res.status(200).send('OK') }
        if (screenName === 'admin') await pushScreen(cbChat, cbMsg, await buildAdminScreen())
        else if (screenName === 'admingifts') await pushScreen(cbChat, cbMsg, await buildGiftAdminScreen())
        else if (screenName === 'stats') await pushScreen(cbChat, cbMsg, await buildStatsScreen())
        else await pushScreen(cbChat, cbMsg, adminCommandsScreen())
        return res.status(200).send('OK')
      }
      await showScreen(cbChat, cbMsg, screenName, isOwner, hasAccess)
      return res.status(200).send('OK')
    }

    if (d.startsWith('wiz:')) {
      if (!hasAccess) { await answerCb(cq.id, '🔒 Tap 💳 Get Access first.', true); return res.status(200).send('OK') }
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
          reply_markup: { inline_keyboard: countButtons(actorTier) } })
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
      const who = [cq.from?.first_name, cq.from?.last_name, cq.from?.username ? '@' + cq.from.username : '']
        .filter(Boolean).join(' ')
      await addPendingRequest(actorId, who)
      if (ADMIN_ID) {
        await tgCall('sendMessage', {
          chat_id: ADMIN_ID, parse_mode: 'HTML',
          text:
            `💳 <b>Access request</b>\n` +
            `User ID: <code>${actorId}</code>${who ? '\nName: ' + who.replace(/[<>&]/g, '') : ''}\n` +
            `Price: ${ACCESS_PRICE}${PAY_CONTACT ? ' → pay to ' + PAY_CONTACT : ' (set a payment contact in 👥 Access requests)'}\n\n` +
            `🎟️ 1 search = exactly one /find or /findco run, then they're done.\n` +
            `✅ ${PASS_DAYS} days = unlimited runs until it expires.\n` +
            `This also sits under 🧰 Tools → 👥 Access requests if you miss it here.`,
          reply_markup: { inline_keyboard: [
            [B(`🎟️ 1 search`, `pay1:${actorId}`), B(`✅ ${PASS_DAYS} days`, `payok:${actorId}`)],
            [B('❌ Deny', `payno:${actorId}`)]
          ] }
        })
      }
      await tgCall('sendMessage', {
        chat_id: cbChat, parse_mode: 'HTML',
        text: `💳 <b>Access pass — ${ACCESS_PRICE} for ${PASS_DAYS} days</b>\n\n` +
          (PAYMENT_LINK
            ? `Pay ${PAY_CONTACT ? PAY_CONTACT.replace(/[<>&]/g, '') : 'here'} — once the owner confirms it, your access switches on:`
            : `The bot owner hasn't set up a payment contact yet — your request has been sent to them directly.`),
        reply_markup: PAYMENT_LINK ? { inline_keyboard: [[{ text: `💳 Pay ${ACCESS_PRICE}`, url: PAYMENT_LINK }]] } : undefined
      })
      return res.status(200).send('OK')
    }

    if (d === 'pay:byoc') {
      await answerCb(cq.id)
      await tgCall('sendMessage', {
        chat_id: cbChat, parse_mode: 'HTML',
        text:
          `<b>🔌 Connect your own account (free)</b>\n\n` +
          `1. In your browser, log into the account you normally search with\n` +
          `2. Export your session file with any cookie-export extension and save it as <code>cookies.json</code>\n` +
          `3. Send the file here as a document\n\n` +
          `From then on, your searches run privately through your own connection with your own ` +
          `limits — the shared one is never touched. Re-send the file anytime to refresh ` +
          `(sessions expire every few weeks).`
      })
      return res.status(200).send('OK')
    }

    if (d.startsWith('payok:') || d.startsWith('payno:')) {
      if (!isOwner) { await answerCb(cq.id, 'Owner only.', true); return res.status(200).send('OK') }
      const target = d.split(':')[1]
      const match = (await listPendingRequests()).find(p => p.id === target)
      if (d.startsWith('payok:')) {
        await grantPass(target, PASS_DAYS, match?.who || '')
        await tgCall('sendMessage', {
          chat_id: target,
          text: `✅ Your ${PASS_DAYS}-day access pass is active! /findco, /find, /scout and /fresh now work for you until ${new Date(Date.now() + PASS_DAYS * 86400000).toISOString().slice(0, 10)}. Send /access anytime to check your status.`
        })
        await answerCb(cq.id, `Granted ${target} ${PASS_DAYS} days.`)
      } else {
        await removePendingRequest(target)
        await tgCall('sendMessage', { chat_id: target, text: 'Your access request was declined. If you already paid, message the bot owner with your proof.' })
        await answerCb(cq.id, 'Denied.')
      }
      return res.status(200).send('OK')
    }

    if (d.startsWith('payrevoke:')) {
      if (!isOwner) { await answerCb(cq.id, 'Owner only.', true); return res.status(200).send('OK') }
      const target = d.split(':')[1]
      await redis('DEL', `pass:${target}`)
      await redis('SREM', 'access:granted:ids', target)
      await redis('SET', `trial:used:${target}`, '1')  // a revoke is a full block — no auto-trial fallback in
      await tgCall('sendMessage', { chat_id: target, text: 'Your access pass was revoked by the bot owner.' })
      await pushScreen(cbChat, cbMsg, await buildAccessListScreen())
      await answerCb(cq.id, `Revoked ${target}.`)
      return res.status(200).send('OK')
    }

    if (d.startsWith('pay1revoke:')) {
      if (!isOwner) { await answerCb(cq.id, 'Owner only.', true); return res.status(200).send('OK') }
      const target = d.split(':')[1]
      await redis('SET', `onetime:${target}`, '0')
      await redis('SREM', 'access:onetime:ids', target)
      await redis('SET', `trial:used:${target}`, '1')  // a revoke is a full block — no auto-trial fallback in
      await tgCall('sendMessage', { chat_id: target, text: 'Your one-time search credit was revoked by the bot owner.' })
      await pushScreen(cbChat, cbMsg, await buildAccessListScreen())
      await answerCb(cq.id, `Revoked ${target}'s credit.`)
      return res.status(200).send('OK')
    }

    if (d.startsWith('pay1:')) {
      if (!isOwner) { await answerCb(cq.id, 'Owner only.', true); return res.status(200).send('OK') }
      const target = d.split(':')[1]
      const match = (await listPendingRequests()).find(p => p.id === target)
      await grantOneTime(target, 1, match?.who || '')
      await tgCall('sendMessage', {
        chat_id: target,
        text: `✅ You've been granted one search! Send /find or /findco whenever you're ready — it covers exactly one of those, then it's used up. Send /access anytime to check your status.`
      })
      await pushScreen(cbChat, cbMsg, await buildAccessListScreen())
      await answerCb(cq.id, `Granted ${target} 1 search.`)
      return res.status(200).send('OK')
    }

    if (d === 'payset:trial') {
      if (!isOwner) { await answerCb(cq.id, '🔒 Owner-only.', true); return res.status(200).send('OK') }
      AUTO_TRIAL = !AUTO_TRIAL
      await redis('SET', 'config:auto_trial', AUTO_TRIAL ? 'true' : 'false')
      await pushScreen(cbChat, cbMsg, await buildAccessListScreen())
      await answerCb(cq.id, `Free trial turned ${AUTO_TRIAL ? 'ON' : 'OFF'}.`)
      return res.status(200).send('OK')
    }

    if (d === 'payset:contact' || d === 'payset:price' || d === 'payset:trialsize') {
      if (!isOwner) { await answerCb(cq.id, '🔒 Owner-only.', true); return res.status(200).send('OK') }
      await answerCb(cq.id)
      const pq = await getUserQueue(actorId)
      if (d === 'payset:contact') {
        pq.awaitingPayPrice = false; pq.awaitingTrialSize = false
        pq.awaitingPayContact = true
        await saveUserQueue(actorId, pq)
        await tgCall('sendMessage', {
          chat_id: cbChat, parse_mode: 'HTML',
          text: `<b>✏️ New payment contact</b>\n\nSend a Telegram username (e.g. <code>@zammynn</code>) or a full payment link ` +
                `(PayPal.me, bank link, etc).\n\nCurrent: ${PAY_CONTACT ? PAY_CONTACT.replace(/[<>&]/g, '') : '(not set)'}\n\n(/cancel to stop)`
        })
      } else if (d === 'payset:price') {
        pq.awaitingPayContact = false; pq.awaitingTrialSize = false
        pq.awaitingPayPrice = true
        await saveUserQueue(actorId, pq)
        await tgCall('sendMessage', {
          chat_id: cbChat, parse_mode: 'HTML',
          text: `<b>✏️ New price</b>\n\nSend the price text to show people, e.g. <code>$1</code> or <code>£2.50</code>.\n\nCurrent: ${ACCESS_PRICE}\n\n(/cancel to stop)`
        })
      } else {
        pq.awaitingPayContact = false; pq.awaitingPayPrice = false
        pq.awaitingTrialSize = true
        await saveUserQueue(actorId, pq)
        await tgCall('sendMessage', {
          chat_id: cbChat, parse_mode: 'HTML',
          text: `<b>✏️ Free searches per new account</b>\n\nSend a number, e.g. <code>2</code>.\n\nCurrent: ${TRIAL_SIZE}\n\n(/cancel to stop)`
        })
      }
      return res.status(200).send('OK')
    }

    if (d.startsWith('giftclaim:')) {
      await answerCb(cq.id)
      await claimGift(cbChat, actorId, d.slice(12))
      return res.status(200).send('OK')
    }

    if (d.startsWith('giftans:')) {
      await answerCb(cq.id)
      const gid = d.slice(9)
      const g0 = await getGift(gid)
      if (!g0 || g0.status !== 'open') { await send(cbChat, 'That gift is no longer available.'); return res.status(200).send('OK') }
      const gq2 = await getUserQueue(actorId)
      gq2.answeringGift = gid
      await saveUserQueue(actorId, gq2)
      await send(cbChat, `✏️ Send your answer as a normal message (one message = one answer).\n\n❓ ${g0.question}`)
      return res.status(200).send('OK')
    }

    if (d === 'giftnew') {
      if (!isOwner) { await answerCb(cq.id, 'Owner only.', true); return res.status(200).send('OK') }
      await answerCb(cq.id)
      const gq3 = await getUserQueue(actorId)
      gq3.giftDraft = { step: 'kind' }
      await saveUserQueue(actorId, gq3)
      await tgCall('sendMessage', { chat_id: cbChat, parse_mode: 'HTML',
        text: `<b>➕ New gift — step 1 of 4</b>\n\nWhat does the winner get?`,
        reply_markup: { inline_keyboard: [
          [B('🎟️ A bundle of searches', 'gifttype:credits'), B('⏳ A days-pass', 'gifttype:pass')]
        ] } })
      return res.status(200).send('OK')
    }

    if (d.startsWith('gifttype:') || d.startsWith('giftmode:')) {
      if (!isOwner) { await answerCb(cq.id, 'Owner only.', true); return res.status(200).send('OK') }
      await answerCb(cq.id)
      const gq5 = await getUserQueue(actorId)
      if (!gq5.giftDraft) return res.status(200).send('OK')
      if (d.startsWith('gifttype:')) {
        gq5.giftDraft.kind = d.split(':')[1]
        gq5.giftDraft.step = gq5.giftDraft.kind === 'pass' ? 'days' : 'searches'
        await saveUserQueue(actorId, gq5)
        await send(cbChat, gq5.giftDraft.kind === 'pass'
          ? `➕ How many days should the pass last? Send a number 1–365.`
          : `➕ How many searches should the gift include? Send a number 1–100.`)
        return res.status(200).send('OK')
      }
      const mode = d.split(':')[1]
      gq5.giftDraft.mode = mode
      if (mode === 'everyone') {
        gq5.giftDraft.step = 'maxclaims'
        await saveUserQueue(actorId, gq5)
        await send(cbChat, `👥 Max number of claims? Send 0 for unlimited, or a number (e.g. 10).`)
      } else if (mode === 'quiz') {
        gq5.giftDraft.step = 'question'
        await saveUserQueue(actorId, gq5)
        await send(cbChat, `❓ Send the quiz question as one message.`)
      } else {
        gq5.giftDraft.step = 'message'
        await saveUserQueue(actorId, gq5)
        await send(cbChat, `⚡ First claim wins.\n\nAttach a personal message for the winner? Send it now, or reply "skip".`)
      }
      return res.status(200).send('OK')
    }

    if (d.startsWith('giftclose:') || d.startsWith('giftatt:') || d.startsWith('giftwin:')) {
      if (!isOwner) { await answerCb(cq.id, 'Owner only.', true); return res.status(200).send('OK') }
      await answerCb(cq.id)
      const parts = d.split(':')
      const gid = parts[1]
      if (parts[0] === 'giftclose') {
        const g = await getGift(gid)
        if (g) { g.status = 'closed'; await saveGift(g) }
        await pushScreen(cbChat, cbMsg, await buildGiftAdminScreen())
      } else if (parts[0] === 'giftatt') {
        const s = await buildGiftAttemptsScreen(gid)
        if (s) await pushScreen(cbChat, cbMsg, s)
      } else {
        const uid2 = parts.slice(2).join(':')
        const g = await getGift(gid)
        if (g && g.status === 'open' && !(g.winners || []).some(w => w.uid === uid2)) {
          g.winners = g.winners || []
          g.winners.push({ uid: uid2, ts: Date.now() })
          g.status = 'closed'
          await saveGift(g)
          await awardGiftTo(g, uid2)
          await deliverGift(uid2, g, '🏆 Awarded by the owner.')
          await notifyOwnerGiftLine(g, uid2, 'awarded manually')
        }
        await pushScreen(cbChat, cbMsg, await buildGiftAdminScreen())
      }
      return res.status(200).send('OK')
    }

    if (d === 'adminedit:start' || d === 'adminedit:broadcast') {
      if (!isOwner) { await answerCb(cq.id, '🔒 Owner-only.', true); return res.status(200).send('OK') }
      await answerCb(cq.id)
      const gq6 = await getUserQueue(actorId)
      if (d === 'adminedit:start') {
        gq6.awaitingBroadcast = false
        gq6.awaitingStartText = true
        await saveUserQueue(actorId, gq6)
        await tgCall('sendMessage', { chat_id: cbChat, parse_mode: 'HTML',
          text: `<b>✏️ Edit the /start message</b>\n\nSend the new welcome text (plain text, up to ~900 characters) — it replaces the default intro shown to everyone on /start.\n\nCurrent: ${START_TEXT ? '"' + START_TEXT.slice(0, 120) + '"' : '(default)'}\n\nSend "clear" via this same button to reset to default. (/cancel to stop)` })
      } else {
        gq6.awaitingStartText = false
        gq6.awaitingBroadcast = true
        await saveUserQueue(actorId, gq6)
        await tgCall('sendMessage', { chat_id: cbChat, parse_mode: 'HTML',
          text: `<b>📣 Broadcast</b>\n\nSend the message you want delivered to EVERY user of the bot.\n\nPlain text only (no photos/documents), up to ~4000 characters. Everyone gets it exactly as you send it. (/cancel to stop)` })
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

    // This block is the /scout flow only — same access rule as everywhere else:
    // owner always in, anyone else needs an actual tier (paid/trial/daily/byoc),
    // independent of whether PUBLIC_ACCESS happens to be on.
    if (!isOwner && !hasAccess) {
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
        // /scout doesn't go through the shared job queue (it runs right here, hitting
        // URLScan.io directly) — so this is the actual "the search is happening now"
        // moment, same role as queueJob plays for /find and /findco.
        if (!isOwner) {
          const scoutTier = await tierOf(cbUserId)
          if (!(await spendFreeCredit(cbChatId, scoutTier, cbUserId))) return res.status(200).send('OK')
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
  // and then only the safe commands in PUBLIC_CMDS. /access is the one exception: it's
  // the paid door in, so it always works even while the rest of the bot stays private.
  const isAccessCmd = /^\/access(@\w+)?$/.test(text)
  const isGiftCmd = /^\/gift(@\w+)?$/.test(text)
  // A non-command reply (pasting a company list, answering "what's the review cap?",
  // a wizard answer, a cookies.json upload...) must NOT hit the "type a command"
  // wall below — those flows only ever start after the real gate already passed,
  // so a reply to one of them is always legitimate, command or not.
  const midFlowQueue = (!isOwner && text && !text.startsWith('/')) ? await getUserQueue(userId) : null
  const midFlow = !!(midFlowQueue && (
    midFlowQueue.awaitingCompanyList || midFlowQueue.awaitingReviewCap ||
    midFlowQueue.awaitingMessages || midFlowQueue.awaitingCustomQuery ||
    midFlowQueue.awaitingLeadCount || midFlowQueue.awaitingLockedFilter ||
    midFlowQueue.wizard || midFlowQueue.answeringGift
  ))
  if (!isOwner && !isAccessCmd && !isGiftCmd && !midFlow && !doc) {
    // A granted user (paid pass / one-time credit / own cookies) always gets through,
    // whether or not PUBLIC_ACCESS is on — that toggle only governs whether a complete
    // stranger with no grant at all can browse the free preview.
    const baseCmd = text.split(/[\s@]/)[0].toLowerCase()
    // A brand-new stranger's very first /find or /findco still needs to reach
    // gateOwnerSession below — that's where the free trial actually gets granted,
    // so auto-trial has to work even while the rest of the bot stays private.
    const couldAutoTrial = AUTO_TRIAL && FREE_TIER_CMDS.includes(baseCmd)
    if (!PUBLIC_ACCESS && !hasAccess && !couldAutoTrial) {
      await send(chatId, 'Private bot.')
      return res.status(200).send('OK')
    }
    if (!text.startsWith('/')) {
      await send(chatId, 'Tap /start to open the menu 👇')
      return res.status(200).send('OK')
    }
    if (OWNER_SESSION_CMDS.includes(baseCmd)) {
      // Still the precise per-tier check — a one-time credit only ever covers /find or
      // /findco, never /scout, /fresh, etc., so this stays even for a hasAccess user.
      const whoName = [msg.from?.first_name, msg.from?.last_name, msg.from?.username ? '@' + msg.from.username : '']
        .filter(Boolean).join(' ')
      if (!(await gateOwnerSession(chatId, userId, baseCmd, whoName))) return res.status(200).send('OK')
    } else if (!PUBLIC_CMDS.includes(baseCmd) && !hasAccess) {
      // Not a free-tier command and this person has no grant at all -> locked.
      // A granted user reaches everything else here (campaigns, leads, mark, black,
      // others, audit...) — only the truly admin-only commands further down (grant,
      // revoke, accesslist, pricing) still check isOwner on their own and stay closed.
      await tgCall('sendMessage', { chat_id: chatId, text: '🔒 That feature needs access. Tap below to see how.',
        reply_markup: { inline_keyboard: [[B('🏠 Main menu', 'menu:main')]] } })
      return res.status(200).send('OK')
    }
  }

  // ── Owner typed a new payment contact / price (from 👥 Access requests) ──
  if (isOwner && text && !text.startsWith('/')) {
    const pq = await getUserQueue(userId)
    // Yield to any live user flow (scout count, /find review cap, wizard...):
    // a stale edit flag must never eat an answer meant for another prompt.
    const adminEditLive = !activeFlowFlags(pq) && (pq.awaitingPayContact || pq.awaitingPayPrice || pq.awaitingTrialSize)
    if (pq.awaitingPayContact && adminEditLive) {
      // Pull the first usable token out of whatever was pasted — a full URL,
      // an @handle, or a bare domain like paypal.me/you buried inside a
      // multi-line browser copy-paste (which surrounds the link with page
      // text and whitespace, and used to fail validation and get stuck).
      let v = text.trim()
      const urlM = v.match(/https?:\/\/[^\s<>"']+/i)
      const handleM = !urlM && v.match(/@[A-Za-z0-9_]{5,32}/)
      const domainM = !urlM && !handleM && v.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/i)
      if (urlM) v = urlM[0].slice(0, 120)
      else if (handleM) v = handleM[0]
      else if (domainM) v = 'https://' + domainM[0].replace(/[.,;:?!]+$/, '').slice(0, 120)
      else {
        await send(chatId, `You're mid-edit of the payment contact (from 👥 Access requests), and that doesn't look like a Telegram username or a link.\n\nSend e.g. @zammynn or https://paypal.me/you — or /cancel to drop the edit and get your bot back.`)
        return res.status(200).send('OK')
      }
      const saved = handleM && !v.startsWith('@') ? '@' + v : v
      await redis('SET', 'config:pay_contact', saved)
      PAY_CONTACT = saved
      PAYMENT_LINK = payUrlFrom(saved)
      pq.awaitingPayContact = false
      await saveUserQueue(userId, pq)
      await tgCall('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `✅ Payment contact updated to <b>${saved.replace(/[<>&]/g, '')}</b>. New access requests will point here.`,
        reply_markup: { inline_keyboard: [[B('👥 Access requests', 'menu:accesslist')]] }
      })
      return res.status(200).send('OK')
    }
    if (pq.awaitingTrialSize && adminEditLive) {
      const n = parseInt(text.trim())
      if (!n || n < 1 || n > 20) {
        await send(chatId, 'Send a number from 1 to 20 — or /cancel.')
        return res.status(200).send('OK')
      }
      await redis('SET', 'config:trial_size', String(n))
      TRIAL_SIZE = n
      pq.awaitingTrialSize = false
      await saveUserQueue(userId, pq)
      await tgCall('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `✅ Free trial updated to <b>${n} search${n === 1 ? '' : 'es'}</b> per new account.`,
        reply_markup: { inline_keyboard: [[B('👥 Access requests', 'menu:accesslist')]] }
      })
      return res.status(200).send('OK')
    }
    if (pq.awaitingPayPrice && adminEditLive) {
      const v = text.trim().slice(0, 20)
      if (!v) { await send(chatId, 'Send the price text, e.g. $1 — or /cancel.'); return res.status(200).send('OK') }
      await redis('SET', 'config:pay_price', v)
      ACCESS_PRICE = v
      pq.awaitingPayPrice = false
      await saveUserQueue(userId, pq)
      await tgCall('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `✅ Price updated to <b>${v.replace(/[<>&]/g, '')}</b>.`,
        reply_markup: { inline_keyboard: [[B('👥 Access requests', 'menu:accesslist')]] }
      })
      return res.status(200).send('OK')
    }
  }

  // ── Owner: gift-creation wizard + /start text editing ──
  if (isOwner && text && !text.startsWith('/')) {
    const gq = await getUserQueue(userId)
    if (gq.awaitingStartText && !activeFlowFlags(gq)) {
      if (/^clear$/i.test(text.trim())) {
        await redis('DEL', 'config:start_text')
        START_TEXT = ''
        gq.awaitingStartText = false
        await saveUserQueue(userId, gq)
        await send(chatId, '✅ /start text reset to the default.')
        return res.status(200).send('OK')
      }
      const v = text.trim().slice(0, 900)
      await redis('SET', 'config:start_text', v)
      START_TEXT = v
      gq.awaitingStartText = false
      await saveUserQueue(userId, gq)
      await tgCall('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
        text: `✅ /start message updated (${v.length} chars) — it now shows for everyone.`,
        reply_markup: { inline_keyboard: [[B('🛠 Admin', 'menu:admin')]] } })
      return res.status(200).send('OK')
    }
    if (gq.awaitingBroadcast && !activeFlowFlags(gq)) {
      if (!text.trim()) { await send(chatId, 'Send the message text to broadcast (or /cancel).'); return res.status(200).send('OK') }
      gq.awaitingBroadcast = false
      await saveUserQueue(userId, gq)
      await send(chatId, `📣 Broadcasting to all users — one moment...`)
      await broadcastMessage(chatId, text.trim())
      return res.status(200).send('OK')
    }
    if (gq.giftDraft) {
      const dft = gq.giftDraft
      const numOf = (t) => { const m = String(t).match(/\d+/) ; return m ? parseInt(m[0]) : NaN }
      if (dft.step === 'searches') {
        const n = numOf(text)
        if (!n || n < 1 || n > 100) { await send(chatId, 'Send a number 1–100 — how many searches does the gift include?'); return res.status(200).send('OK') }
        dft.searches = n; dft.step = 'cap'
        await saveUserQueue(userId, gq)
        await send(chatId, `🎁 ${n} searches.\n\nMax results per search? (free default is ${FREE_RESULT_CAP} — e.g. 25 gives bigger reports). Send a number 1–50.`)
        return res.status(200).send('OK')
      }
      if (dft.step === 'cap') {
        const n = numOf(text)
        if (!n || n < 1 || n > 50) { await send(chatId, 'Send a number 1–50 — max results per search.'); return res.status(200).send('OK') }
        dft.cap = n; dft.step = 'mode'
        await saveUserQueue(userId, gq)
        await tgCall('sendMessage', { chat_id: chatId, text: `✅ Up to ${n} results per search.\n\nWho gets it?`,
          reply_markup: { inline_keyboard: [
            [B('👥 Everyone (each claims once)', 'giftmode:everyone')],
            [B('⚡ First person to claim', 'giftmode:first')],
            [B('❓ Quiz — first correct answer wins', 'giftmode:quiz')]
          ] } })
        return res.status(200).send('OK')
      }
      if (dft.step === 'days') {
        const n = numOf(text)
        if (!n || n < 1 || n > 365) { await send(chatId, 'Send a number 1–365 — how many days does the pass last?'); return res.status(200).send('OK') }
        dft.days = n; dft.step = 'mode'
        await saveUserQueue(userId, gq)
        await tgCall('sendMessage', { chat_id: chatId, text: `⏳ ${n}-day pass.\n\nWho gets it?`,
          reply_markup: { inline_keyboard: [
            [B('👥 Everyone (each claims once)', 'giftmode:everyone')],
            [B('⚡ First person to claim', 'giftmode:first')],
            [B('❓ Quiz — first correct answer wins', 'giftmode:quiz')]
          ] } })
        return res.status(200).send('OK')
      }
      if (dft.step === 'maxclaims') {
        const t = text.trim()
        if (!/^\d+$/.test(t) || parseInt(t) > 10000) { await send(chatId, 'Send 0 for unlimited claims, or a max number (e.g. 10).'); return res.status(200).send('OK') }
        dft.maxClaims = parseInt(t); dft.step = 'message'
        await saveUserQueue(userId, gq)
        await send(chatId, `👥 ${dft.maxClaims === 0 ? 'Unlimited claims' : 'Up to ' + dft.maxClaims + ' claims'}.\n\nAttach a personal message for the winners? Send it now (it lands in their DMs), or reply "skip".`)
        return res.status(200).send('OK')
      }
      if (dft.step === 'question') {
        if (text.trim().length < 5) { await send(chatId, 'Send the quiz question (at least a few words).'); return res.status(200).send('OK') }
        dft.question = text.trim().slice(0, 300); dft.step = 'answer'
        await saveUserQueue(userId, gq)
        await send(chatId, `❓ "${dft.question}"\n\nNow send the CORRECT answer (case & punctuation don't matter).`)
        return res.status(200).send('OK')
      }
      if (dft.step === 'answer') {
        if (!text.trim()) { await send(chatId, 'Send the correct answer.'); return res.status(200).send('OK') }
        dft.answer = text.trim().slice(0, 200); dft.step = 'message'
        await saveUserQueue(userId, gq)
        await send(chatId, `✅ Answer saved.\n\nAttach a personal message for the winner? Send it now, or reply "skip".`)
        return res.status(200).send('OK')
      }
      if (dft.step === 'message') {
        if (!/^skip$/i.test(text.trim())) dft.message = text.trim().slice(0, 500)
        const gid = 'gift-' + Date.now().toString(36)
        const gift = {
          id: gid, kind: dft.kind, searches: dft.searches || 0,
          cap: dft.cap || FREE_RESULT_CAP, days: dft.days || 0,
          mode: dft.mode, maxClaims: dft.maxClaims || 0,
          question: dft.question || '', answer: dft.answer || '',
          message: dft.message || '', status: 'open', winners: [], attempts: {},
          created: Date.now()
        }
        await saveGift(gift)
        gq.giftDraft = null
        await saveUserQueue(userId, gq)
        await tgCall('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
          text: `✅ Gift <code>${gid}</code> is LIVE.\n\n🎁 ${giftPrizeText(gift)} · mode: ${gift.mode}${gift.message ? '\n💌 "' + gift.message.slice(0, 80) + '"' : ''}\n\nUsers see it under 🎁 Gifts on the main menu (or /gift). You get a DM every time someone claims or wins.`,
          reply_markup: { inline_keyboard: [[B('🎁 Gift admin', 'menu:admingifts')]] } })
        return res.status(200).send('OK')
      }
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
              reply_markup: { inline_keyboard: countButtons(actorTier) } })
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
    if (isOwner) {
      await registerCommands(chatId)     // makes "/" show the command list + Menu button
      // Opening the menu also abandons any half-finished admin edit — otherwise
      // a forgotten edit flag keeps eating every plain message sent afterwards.
      const q0 = await getUserQueue(userId)
      let dirty = false
      for (const f of ['awaitingPayContact', 'awaitingPayPrice', 'awaitingTrialSize', 'awaitingStartText', 'awaitingBroadcast']) {
        if (q0[f]) { q0[f] = false; dirty = true }
      }
      if (q0.giftDraft) { q0.giftDraft = null; dirty = true }
      if (dirty) {
        await saveUserQueue(userId, q0)
        await send(chatId, '🧹 Discarded the unfinished admin edit you had open — the bot is no longer waiting for it.')
      }
    }
    if (/^\/start/.test(text)) await redis('INCR', 'stats:starts')
    await showScreen(chatId, null, 'main', isOwner, hasAccess)
    return res.status(200).send('OK')
  }
  if (/^\/help(@\w+)?$/.test(text)) {
    await showScreen(chatId, null, 'help', isOwner, hasAccess)
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
    q.awaitingPayContact = false; q.awaitingPayPrice = false; q.awaitingTrialSize = false
    q.answeringGift = null; q.giftDraft = null; q.awaitingStartText = false; q.awaitingBroadcast = false
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
    const requestedCount = Math.min(Math.max(parseInt(parts[1]) || 20, 1), 100)
    // /newuk is always free to run (free government API, costs the owner nothing) and
    // never spends a search credit — but the RESULT SIZE still follows the same free-vs-
    // paid shape as everything else, so a free account can't pull the full 100 at once.
    const newukTier = isOwner ? 'owner' : await tierOf(userId)
    const newukCap = (newukTier === 'paid' || newukTier === 'owner' || newukTier === 'byoc')
      ? null : (newukTier === 'onetime' ? FREE_RESULT_CAP : DAILY_RESULT_CAP)
    const count = newukCap ? Math.min(requestedCount, newukCap) : requestedCount
    if (newukCap && requestedCount > count) {
      await send(chatId, `🎟️ You're on the free trial — free accounts see up to ${newukCap} at a time, so showing ${count} of the ${requestedCount} you asked for. Get a pass (/access) for the full list.`)
    }

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

  // ── /gift — users: open gift box · owner: gift admin ──
  if (/^\/gift(@\w+)?$/.test(text)) {
    const s = isOwner ? await buildGiftAdminScreen() : await buildGiftsScreen(userId)
    await tgCall('sendMessage', { chat_id: chatId, text: s.text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: s.kb }, disable_web_page_preview: true })
    return res.status(200).send('OK')
  }

  // ── /admin — owner-only control panel ──
  if (/^\/admin(@\w+)?$/.test(text)) {
    if (!isOwner) { await send(chatId, 'Owner only.'); return res.status(200).send('OK') }
    const s = await buildAdminScreen()
    await tgCall('sendMessage', { chat_id: chatId, text: s.text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: s.kb }, disable_web_page_preview: true })
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
    const match = (await listPendingRequests()).find(p => p.id === target)
    await grantPass(target, days, match?.who || '')
    await tgCall('sendMessage', { chat_id: target, text: `✅ Access granted: ${days} days. Send /access anytime to check your status.` })
    await send(chatId, `✓ ${target} now has ${days} days of access.`)
    return res.status(200).send('OK')
  }

  // ── /revoke <id> — owner only: cut someone off right now, pass or one-time ──
  if (text.startsWith('/revoke')) {
    if (!isOwner) { await send(chatId, 'Owner only.'); return res.status(200).send('OK') }
    const target = text.split(' ')[1] || ''
    if (!/^\d+$/.test(target)) {
      await send(chatId, `Usage: /revoke <telegram user id>`)
      return res.status(200).send('OK')
    }
    await redis('DEL', `pass:${target}`)
    await redis('SREM', 'access:granted:ids', target)
    await redis('SET', `onetime:${target}`, '0')
    await redis('SREM', 'access:onetime:ids', target)
    await redis('SET', `trial:used:${target}`, '1')  // a revoke is a full block — no auto-trial fallback in
    await tgCall('sendMessage', { chat_id: target, text: 'Your access was revoked by the bot owner.' })
    await send(chatId, `✓ ${target}'s access has been revoked (pass + one-time credit cleared, free-trial blocked too).`)
    return res.status(200).send('OK')
  }

  // ── /grant1 <id> [count] — owner only: N one-time search credits (default 1) ──
  if (text.startsWith('/grant1')) {
    if (!isOwner) { await send(chatId, 'Owner only.'); return res.status(200).send('OK') }
    const parts = text.split(' ').slice(1)
    const target = parts[0] || ''
    const count = Math.min(Math.max(parseInt(parts[1]) || 1, 1), 50)
    if (!/^\d+$/.test(target)) {
      await send(chatId, `Usage: /grant1 <telegram user id> [count]\ne.g. /grant1 123456789  or  /grant1 123456789 3`)
      return res.status(200).send('OK')
    }
    const match = (await listPendingRequests()).find(p => p.id === target)
    const total = await grantOneTime(target, count, match?.who || '')
    await tgCall('sendMessage', { chat_id: target, text: `✅ You've been granted ${count} search${count === 1 ? '' : 'es'}. Send /find or /findco whenever you're ready. Send /access anytime to check your status.` })
    await send(chatId, `✓ ${target} now has ${total} one-time search${total === 1 ? '' : 'es'} available.`)
    return res.status(200).send('OK')
  }

  // ── /accesslist — owner only: pending requests + active passes, one place ──
  if (/^\/accesslist(@\w+)?$/.test(text)) {
    if (!isOwner) { await send(chatId, 'Owner only.'); return res.status(200).send('OK') }
    const s = await buildAccessListScreen()
    await tgCall('sendMessage', { chat_id: chatId, text: s.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: s.kb }, disable_web_page_preview: true })
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

    // ── Answering a gift quiz question ──
    if (userQueue.answeringGift && text) {
      const gid = userQueue.answeringGift
      userQueue.answeringGift = null
      await saveUserQueue(userId, userQueue)
      await answerGift(chatId, userId, gid, text)
      return res.status(200).send('OK')
    }

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
      // queueJob attaches user_id (and byoc:true only for genuine BYOC users) —
      // free/trial users borrow the owner's shared gm_cookies.json, BYOC users
      // get their own session and their own hourly search budget.
      const tier = await tierOf(userId)
      // A free search (lifetime trial, or the once-a-day follow-on) is capped —
      // unlimited is what the paid pass is for.
      const cap = tier === 'onetime' ? await resultCapFor(userId, FREE_RESULT_CAP) : tier === 'daily' ? DAILY_RESULT_CAP : null
      let count = job.count
      let capped = false
      if (cap && count > cap) {
        count = cap
        capped = true
      }
      const payload = {
        chat_id: chatId, city: job.city, niche: job.niche,
        count, review_cap: reviewCap,
        sample_mode: !!job.sampleMode,
        include_seen: !!job.includeSeen,
        job_id: `find-${Date.now()}`
      }
      const queued = await queueJob(chatId, userId, payload, `${job.niche} in ${job.city}`)
      if (!queued) return res.status(200).send('OK')
      const dispatched = await triggerGithubWorkflow()
      await send(chatId,
        `✅ Job posted: ${job.niche} in ${job.city} (max ${count}` +
        `${reviewCap ? `, review cap ${reviewCap}` : ', no review cap'}` +
        `${job.sampleMode ? ', SAMPLE mode' : ''}` +
        `${job.includeSeen ? ', including previously-seen' : ''})\n\n` +
        (capped ? `🎟️ You're on the free trial — searches are capped at ${cap} results (you asked for ${job.count}), ` +
                  `so this run returns ${cap}. ${tier === 'daily' ? RESULTS_ARE_YOURS_LINE + ' ' : ''}` +
                  `Get a pass (/access) for unlimited runs and bigger batches.\n\n` : '') +
        (dispatched
          ? `⚡ Starting now — first results land here within a couple of minutes.\n`
          : `⏳ Queued — it starts automatically on the next pass.\n`) +
        `\n⏱️ Give it a few minutes — every lead is gathered live, right now, just for you. ` +
        `Nothing is served from an old database: each business is found fresh, then its real website is ` +
        `opened and checked for email, booking, socials and speed, one by one. ` +
        `Results land here in batches, plus downloadable .txt/.html reports at the end.`
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
      // A free (trial/daily) search shares the same cap as /find and /findco — capped
      // here, up front, so there's no "ask for 50, silently get 5" surprise later.
      const scoutTier = isOwner ? 'owner' : await tierOf(userId)
      const scoutCap = scoutTier === 'onetime' ? await resultCapFor(userId, FREE_RESULT_CAP) : scoutTier === 'daily' ? DAILY_RESULT_CAP : null
      const wantCount = Math.min(n, scoutCap || 300)
      if (scoutCap && n > scoutCap) {
        await send(chatId, `🎟️ You're on the free trial — capped at ${scoutCap} leads per search, so I'll search for ${scoutCap} instead of ${n}. Get a pass (/access) for up to 300.`)
      }
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
          `🔌 Your own connection is saved — /findco and /find now run privately through your account.\n` +
          `${arr.length} session entries, active until ${exp ? new Date(exp * 1000).toISOString().slice(0, 10) : 'unknown'}.\n\n` +
          `Re-send this file anytime to refresh (sessions expire every few weeks). Send /access to check status.`)
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
