// api/scraper_bot.js
// Personal Telegram lead-scraper bot — hosted on Vercel
// Stripped down: URLScan scraping + /find command that posts jobs to Redis
// Maps scraping happens on your PC via maps_daemon.py

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'GET') return res.status(200).send('OK')

  const BOT_TOKEN = process.env.SCRAPER_BOT_TOKEN || ''
  const ADMIN_ID  = process.env.SCRAPER_ADMIN_ID  || ''
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || ''
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

  const BATCH_SIZE  = 8
  const CONCURRENCY = 4

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

  async function answerCallback(callbackQueryId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId })
      })
    } catch (e) {}
  }

  async function send(chatId, text) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      })
    } catch (e) {}
  }

  function sendKeyboard(chatId, text, keyboard) {
    return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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

  // ── Upstash Redis REST ──

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
    return v ? JSON.parse(v) : { pending: [], results: [], awaitingMessages: false, messages: [], awaitingCustomQuery: false }
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
      sslValid: null, loadSeconds: null, score: 0, scoreReasons: [],
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

  // ══════════════════════════════════════════════
  //  URLSCAN.IO
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
      await send(chatId, `🚫 <b>Filtered out</b> — ${filteredOut.length} link(s):\n\n` + shown.join('\n') + more + `\n\nSaved — retrieve with /others.`)
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

    await send(chatId, `✓ ${sourceLabel}: ${rawLinks.length} links (${alreadySeen} already seen, skipped).\n${newLinks.length} new to process.\n\nProcessing first batch of ${BATCH_SIZE}...`)
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
    let reply = `✓ <b>Batch done:</b> ${results.length} checked, ${usable.length} reachable, ${hotCount} 🔥 hot` + (lockedCount ? `, ${lockedCount} 🔐 locked` : '') + `.`

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
      const hook = auditHookLine(r)
      const hookNote = hook ? `\n    💡 ${hook}` : ''
      reply += `\n\n<b>${leadNum}.</b> ${nameLine}${scoreNote}${hookNote}${socialsNote}${contactNote}${emailNote}`
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
    let chunk = `📋 <b>Ready to send — copy each pair:</b>\n\n`
    for (const line of lines) {
      if ((chunk + line + '\n\n').length > 3800) { await send(chatId, chunk); chunk = '' }
      chunk += line + '\n\n'
    }
    if (chunk.trim()) await send(chatId, chunk)
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

  // Basic gate
  if (ADMIN_ID && userId !== ADMIN_ID) {
    await send(chatId, 'This bot is private.')
    return res.status(200).send('OK')
  }

  // ── /start ──
  if (text.startsWith('/start')) {
    await send(chatId,
      `👋 <b>Lead Scraper Bot</b>\n\n` +
      `<b>Commands:</b>\n` +
      `🔍 /scout — search URLScan.io for Shopify leads\n` +
      `🗺️ /find <city> <niche> [count] — scrape Google Maps (runs on your PC)\n` +
      `🚫 /others — blacklisted links from last search\n` +
      `🔒 /black <url> — grow blacklist from domain list\n` +
      `🕵️ /scoutlist <url> — scan any domain list as leads\n\n` +
      `📄 Send a .txt file — I extract, dedupe, and check links\n\n` +
      `Already-checked links are never re-checked.\n` +
      `When done, send outreach messages separated by / and I'll pair them with emails.`
    )
    return res.status(200).send('OK')
  }

  // ── /find <city> <niche> [count] ──
  if (text.startsWith('/find')) {
    const parts = text.split(' ').slice(1)
    if (parts.length < 2) {
      await send(chatId, 'Usage: /find <city> <niche> [count]\nExample: /find Austin restaurant 20\n\nNiches: restaurant, food_truck, salon, gym, auto_repair, real_estate')
      return res.status(200).send('OK')
    }
    const city  = parts[0]
    const niche = parts[1]
    const count = Math.min(parseInt(parts[2]) || 20, 50)

    const job = JSON.stringify({ chat_id: chatId, city, niche, count })
    await redis('RPUSH', 'jobs:find', job)

    await send(chatId,
      `✅ Job posted: <b>${niche}</b> in <b>${city}</b> (max ${count})\n\n` +
      `Make sure <b>maps_daemon.py</b> is running on your PC.\n` +
      `Results will appear here automatically.`
    )
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
    await send(chatId, `🚫 <b>Filtered links</b> — ${filtered.length} total:\n\n` + shown.join('\n') + more)
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

    // ── File upload (.txt only) ──
    if (doc) {
      if (doc.file_name && !doc.file_name.endsWith('.txt')) {
        await send(chatId, 'Only .txt files are supported.')
        return res.status(200).send('OK')
      }
      await send(chatId, '📄 Reading file...')
      const content = await getFileContent(doc.file_id)
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

    await send(chatId, 'Send a .txt file, use /scout for URLScan leads, or /find for Google Maps.')
    return res.status(200).send('OK')
  } finally {
    await releaseLock(userId)
  }
}
