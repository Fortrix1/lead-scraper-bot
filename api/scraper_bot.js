// api/scraper_bot.js
// Personal Telegram lead-scraper bot — hosted on Vercel
// Works even when your PC is off. Batches through Vercel's serverless
// time limit, remembers everything checked so nothing repeats.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'GET') return res.status(200).send('OK')

  const BOT_TOKEN = process.env.SCRAPER_BOT_TOKEN || ''
  const ADMIN_ID  = process.env.SCRAPER_ADMIN_ID  || ''
  const BIN_URL   = process.env.SCRAPER_BIN_URL   || ''
  const BIN_KEY   = process.env.SCRAPER_BIN_KEY   || ''

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

  async function answerCallback(callbackQueryId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId })
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

  async function getDB() {
    try {
      const r = await fetch(BIN_URL + '/latest', { headers: { 'X-Master-Key': BIN_KEY } })
      const d = await r.json()
      const rec = d.record || {}
      return {
        seen:  rec.seen  || {},
        queue: rec.queue || {},
      }
    } catch { return { seen: {}, queue: {} } }
  }

  async function saveDB(db) {
    try {
      await fetch(BIN_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': BIN_KEY },
        body: JSON.stringify(db)
      })
    } catch (e) {}
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

    if (cbUserId !== ADMIN_ID) return res.status(200).send('OK')

    if (data === 'scout_custom') {
      await send(cbChatId, 'Send your custom URLScan query now (e.g. page.domain:myshopify.com AND page.title:candles).')
      const db = await getDB()
      db.queue[cbUserId] = db.queue[cbUserId] || {}
      db.queue[cbUserId].awaitingCustomQuery = true
      await saveDB(db)
      return res.status(200).send('OK')
    }

    if (data.startsWith('scout_')) {
      const key = data.replace('scout_', '')
      const search = SAVED_SEARCHES[key]
      if (!search) return res.status(200).send('OK')
      return await startScoutJob(cbChatId, cbUserId, search.query, search.label)
    }

    return res.status(200).send('OK')
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

  if (userId !== ADMIN_ID) {
    await send(chatId, '⛔ This bot is private.')
    return res.status(200).send('OK')
  }

  // ══════════════════════════════════════════════
  //  COMMANDS
  // ══════════════════════════════════════════════

  if (text === '/start') {
    await send(chatId,
      `👋 <b>Lead Scraper Bot</b>\n\n` +
      `Works even when your PC is off.\n\n` +
      `<b>Two ways to feed it links:</b>\n` +
      `📄 Send a .txt/.csv file — I extract, dedupe, check it\n` +
      `🔍 /scout — I pull fresh links directly from URLScan.io\n\n` +
      `Either way I process ${BATCH_SIZE} at a time (Vercel time limit).\n` +
      `Send anything to continue the next batch.\n` +
      `Already-checked links are never re-checked, ever.\n\n` +
      `When done, send your outreach messages separated by /\n` +
      `and I'll pair each one with an email for you to copy & send.`
    )
    return res.status(200).send('OK')
  }

  // ── /scout — pick a saved URLScan search ──
  if (text === '/scout') {
    const keyboard = Object.entries(SAVED_SEARCHES).map(([key, s]) =>
      [{ text: s.label, callback_data: `scout_${key}` }]
    )
    keyboard.push([{ text: '✏️ Custom search term', callback_data: 'scout_custom' }])
    await sendKeyboard(chatId, 'Which URLScan search do you want to run?', keyboard)
    return res.status(200).send('OK')
  }

  const db = await getDB()
  const userQueue = db.queue[userId] || { pending: [], results: [], awaitingMessages: false, messages: [] }

  // ── Awaiting a custom URLScan query typed by the user ──
  if (userQueue.awaitingCustomQuery) {
    userQueue.awaitingCustomQuery = false
    db.queue[userId] = userQueue
    await saveDB(db)
    return await startScoutJob(chatId, userId, text, 'Custom search')
  }

  // ── File upload — start a new batch job ──
  if (doc) {
    await send(chatId, '📄 Reading file...')
    const content = await getFileContent(doc.file_id)
    const rawLinks = extractAndCleanLinks(content)
    return await startBatchJob(chatId, userId, db, rawLinks, `file (${rawLinks.length} links)`)
  }

  // ── Awaiting outreach messages ──
  if (userQueue.awaitingMessages) {
    const withEmail = userQueue.results.filter(r => r.email !== 'no email')
    const parts = text.split('/').map(s => s.trim()).filter(Boolean)
    userQueue.messages.push(...parts)
    db.queue[userId] = userQueue
    await saveDB(db)

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
    db.queue[userId] = userQueue
    await saveDB(db)
    return res.status(200).send('OK')
  }

  // ── Any other message = continue processing next batch ──
  if (userQueue.pending.length > 0) {
    return await runBatch(chatId, userId, db, userQueue)
  }

  if (userQueue.results.length > 0 && !userQueue.awaitingMessages) {
    const withEmail = userQueue.results.filter(r => r.email !== 'no email')
    userQueue.awaitingMessages = true
    db.queue[userId] = userQueue
    await saveDB(db)
    await send(chatId,
      `✓ All done! ${userQueue.results.length} processed, ${withEmail.length} have emails.\n\n` +
      `Send your outreach messages now, separated by /.\n` +
      `Need at least ${withEmail.length} messages.`
    )
    return res.status(200).send('OK')
  }

  await send(chatId, 'Send a .txt/.csv file, or use /scout to pull fresh links from URLScan.io.')
  return res.status(200).send('OK')

  // ══════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════

  async function startScoutJob(chatId, userId, query, label) {
    await send(chatId, `🔍 Scraping URLScan.io — "${label}"...`)
    const rawLinks = await scrapeUrlscan(query, 100)
    const cleaned  = [...new Set(rawLinks.map(fixUrl).filter(Boolean).filter(looksLikeValidLead))]
    const db = await getDB()
    return await startBatchJob(chatId, userId, db, cleaned, `URLScan: ${label}`)
  }

  async function startBatchJob(chatId, userId, db, rawLinks, sourceLabel) {
    if (!rawLinks.length) {
      await send(chatId, `No links found from ${sourceLabel}.`)
      return res.status(200).send('OK')
    }

    const newLinks = rawLinks.filter(u => !db.seen[normalizeForDedupe(u)])
    const alreadySeen = rawLinks.length - newLinks.length

    if (!newLinks.length) {
      await send(chatId, `✓ Got ${rawLinks.length} from ${sourceLabel} — all already checked before. Nothing new.`)
      return res.status(200).send('OK')
    }

    const userQueue = { pending: newLinks, results: [], awaitingMessages: false, messages: [] }
    db.queue[userId] = userQueue
    await saveDB(db)

    await send(chatId,
      `✓ ${sourceLabel}: found ${rawLinks.length} links (${alreadySeen} already seen, skipped).\n` +
      `${newLinks.length} new to process.\n\nProcessing first batch of ${BATCH_SIZE}...`
    )

    return await runBatch(chatId, userId, db, userQueue)
  }

  async function runBatch(chatId, userId, db, userQueue) {
    const batch = userQueue.pending.slice(0, BATCH_SIZE)
    userQueue.pending = userQueue.pending.slice(BATCH_SIZE)

    const results = await processBatch(batch)
    userQueue.results.push(...results)

    for (const r of results) {
      db.seen[normalizeForDedupe(r.url)] = {
        status: r.status, email: r.email, checkedAt: new Date().toISOString()
      }
    }
    db.queue[userId] = userQueue
    await saveDB(db)

    const withEmail = results.filter(r => r.email !== 'no email').length
    const remaining = userQueue.pending.length

    let reply = `✓ Batch done: ${results.length} checked, ${withEmail} have emails.\n`
    results.forEach(r => {
      if (r.email !== 'no email') {
        const genericNote = r.email_is_generic ? ' (generic)' : ''
        const contactNote = r.contact_page ? `\n   ↳ contact: ${r.contact_page}` : ''
        const socialsList = Object.entries(r.socials || {}).map(([k,v]) => `${k}: ${v}`).join(', ')
        const socialsNote  = socialsList ? `\n   ↳ social: ${socialsList}` : ''
        reply += `\n📧 ${r.email}${genericNote}  —  ${r.store_name || r.url}${contactNote}${socialsNote}`
      }
    })

    if (remaining > 0) {
      reply += `\n\n${remaining} links remaining. Send anything to continue.`
    } else {
      const totalWithEmail = userQueue.results.filter(r => r.email !== 'no email').length
      reply += `\n\n✓ ALL DONE! ${userQueue.results.length} total processed, ${totalWithEmail} have emails.\n` +
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
