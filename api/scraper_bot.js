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

  const BATCH_SIZE  = 12   // links checked per message — stays under Vercel's time limit
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

  async function scrapeUrlscan(query, maxResults = 100) {
    const results = []
    let searchAfter = null
    const perPage = 100

    while (results.length < maxResults) {
      let apiUrl = `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=${perPage}`
      if (searchAfter) apiUrl += `&search_after=${searchAfter}`

      let data
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 6000)
        const r = await fetch(apiUrl, { signal: controller.signal })
        clearTimeout(t)
        data = await r.json()
      } catch (e) {
        break
      }

      if (!data.results || !data.results.length) break

      for (const item of data.results) {
        const domain = item.page?.domain
        const url    = domain ? `https://${domain}` : (item.page?.url || item.task?.url)
        if (url) results.push(url)
      }

      const last = data.results[data.results.length - 1]
      if (last?.sort) searchAfter = last.sort.join(',')
      else break

      if (data.results.length < perPage) break  // no more pages ("load more" exhausted)
      if (results.length >= maxResults) break
    }

    return results
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

  function looksLikeValidLead(url) {
    const u = url.toLowerCase()
    return !NEVER_LEADS.some(d => u.includes(d))
  }

  function extractAndCleanLinks(rawText) {
    const found = rawText.match(LINK_PATTERN) || []
    const fixed = found.map(fixUrl).filter(Boolean).filter(looksLikeValidLead)
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

  async function checkOneStore(url) {
    const result = {
      url, store_name: '', email: 'no email', email_is_generic: false,
      contact_page: '', store_type: '', socials: {}, status: 'dead'
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
      const html = await r.text()

      if (html.includes('myshopify.com') || html.includes('cdn.shopify.com')) result.store_type = 'Shopify'
      else if (html.includes('woocommerce')) result.store_type = 'WooCommerce'
      else if (html.includes('wp-content')) result.store_type = 'WordPress'
      else if (html.includes('wixsite.com') || html.includes('wixstatic.com')) result.store_type = 'Wix'
      else if (html.includes('squarespace.com')) result.store_type = 'Squarespace'
      else result.store_type = 'Custom/Other'

      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      if (titleMatch) result.store_name = titleMatch[1].split(/[–|—]/)[0].trim().slice(0, 60)

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
    } catch (e) {}
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
      // ── ADMIN — unchanged saved-search / custom, but the FIRST scout of
      // the day also splits the batch: 50 into the shared free pool, the
      // rest stays admin's own (see adminScoutAndFillPoolIfNeeded).
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
          return await adminScoutAndFillPoolIfNeeded(cbChatId, cbUserId, search.query, search.label)
        }
        return res.status(200).send('OK')
      }

      // ── PREMIUM (Stars-purchased) — same live-search flow as admin,
      // minus one paid credit. Full detail, same as admin gets. ──
      if (data === 'pscout_custom') {
        const user = await getUser(cbUserId)
        if (user.premiumScrapesRemaining <= 0) {
          await send(cbChatId, 'No premium scrapes left. Buy one for 2 Stars via /scout.')
          return res.status(200).send('OK')
        }
        await setUserFields(cbUserId, { premiumScrapesRemaining: user.premiumScrapesRemaining - 1 })
        await send(cbChatId, 'Send your custom search query now.')
        const q = await getUserQueue(cbUserId)
        q.awaitingCustomQuery = true
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
        await setUserFields(cbUserId, { premiumScrapesRemaining: user.premiumScrapesRemaining - 1 })
        return await startScoutJob(cbChatId, cbUserId, search.query, search.label)
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
        `🔍 /scout — full search menu\n\n` +
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

    // ── Awaiting a custom URLScan query typed by the user ──
    if (userQueue.awaitingCustomQuery) {
      userQueue.awaitingCustomQuery = false
      await saveUserQueue(userId, userQueue)
      return await startScoutJob(chatId, userId, text, 'Custom search')
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
      const rawLinks = extractAndCleanLinks(content)
      return await startBatchJob(chatId, userId, rawLinks, `file (${rawLinks.length} links)`)
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

  // Admin's FIRST /scout of the day also fills the shared free pool with up
  // to 30 leads — but admin still sees the FULL list either way, just with
  // whichever of those links are (still) sitting in today's pool flagged.
  async function adminScoutAndFillPoolIfNeeded(chatId, userId, query, label) {
    const date = today()
    const { result: filledDate } = await redis('GET', 'poolFilledDate')

    await send(chatId, `🔍 Searching for fresh leads — "${label}"...`)
    const rawLinks = await scrapeUrlscan(query, 100)
    const cleaned  = [...new Set(rawLinks.map(fixUrl).filter(Boolean).filter(looksLikeValidLead))]

    if (filledDate !== date) {
      const dedupeKeys = cleaned.map(normalizeForDedupe)
      const seenMap = await getSeenBatch(dedupeKeys)
      const eligible = cleaned.filter((u, i) => !seenMap[dedupeKeys[i]])
      const forPool = eligible.slice(0, 30)

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

    return await startBatchJob(chatId, userId, cleaned, label, poolSet)
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

    const rawLinks = await scrapeUrlscan(SAVED_SEARCHES['1'].query, 100)
    let cleaned = [...new Set(rawLinks.map(fixUrl).filter(Boolean).filter(looksLikeValidLead))]

    const dedupeKeys = cleaned.map(normalizeForDedupe)
    const seenMap = await getSeenBatch(dedupeKeys)
    cleaned = cleaned.filter((u, i) => !seenMap[dedupeKeys[i]])

    const batch = cleaned.slice(0, want)
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

  async function startScoutJob(chatId, userId, query, label) {
    await send(chatId, `🔍 Searching for fresh leads — "${label}"...`)
    const rawLinks = await scrapeUrlscan(query, 100)
    const cleaned  = [...new Set(rawLinks.map(fixUrl).filter(Boolean).filter(looksLikeValidLead))]
    return await startBatchJob(chatId, userId, cleaned, label)
  }

  async function startBatchJob(chatId, userId, rawLinks, sourceLabel, poolSet) {
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
      poolUrls: poolSet ? [...poolSet] : []
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

    const usable = results.filter(r => r.status === 'OK' && (r.email !== 'no email' || r.contact_page || Object.keys(r.socials || {}).length))
    const remaining = userQueue.pending.length
    const poolUrlSet = new Set(userQueue.poolUrls || [])

    let reply = `✓ <b>Batch done:</b> ${results.length} checked, ${usable.length} reachable.\n`
    let leadNum = 0
    usable.forEach(r => {
      leadNum++
      const inPool = poolUrlSet.has(normalizeForDedupe(r.url))
      const poolFlag = inPool ? `\n    🔒 <b>IN FREE POOL</b> — also shown to free users` : ''

      const socialsList = Object.entries(r.socials || {}).map(([k, v]) => `${k}: ${v}`).join('\n              ')
      const socialsNote = socialsList ? `\n    💬 social: ${socialsList}` : ''

      const contactNote = r.contact_page ? `\n    🌐 contact page: ${r.contact_page}` : ''

      const genericNote = r.email_is_generic ? ' (generic)' : ''
      const emailNote = r.email !== 'no email' ? `\n    📧 ${r.email}${genericNote} (in case)` : ''

      reply += `\n\n<b>${leadNum}.</b> ${r.store_name || r.url}${socialsNote}${contactNote}${emailNote}${poolFlag}`
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
