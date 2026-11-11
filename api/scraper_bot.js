// api/scraper_bot.js
// Personal Telegram lead-scraper bot — hosted on Vercel
// v4: admin lock, audit log, /fresh as automatic tick switch, relay-aware age lookups
// v5: scout date windows skip the redundant freshness question (the chosen
//     window is enforced strictly, then it goes straight to the password
//     question); new AI Site Hunter module (/hunt + /check + 🤖 buttons) that
//     finds AI-builder sites (Lovable/Framer/v0/Bolt...) via crt.sh CT logs,
//     fingerprints them, scores AI copy, and pulls owner contacts.
// v6: DEEP PRODUCT VERIFICATION — a niche search only counts a store when its
//     LIVE product catalog (products.json / sitemap / storefront API) holds
//     3+ products that actually match the niche; new 🏪 Online Stores module
//     (Wix, Etsy, BigCommerce, Squarespace, WooCommerce, Shopify — all with
//     the same deep product check); STRICT social filters for every platform
//     (dead/login-walled links are never counted, verified links only);
//     /newuk honors the exact requested count, enforces the requested date
//     window client-side, handles Companies House publish lag, and gains a
//     With-website / No-website toggle with max-strength website verification
//     (domain guessing + web search + live site + company-identity match);
//     country detection on every scout lead (ported from the v5 build);

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

  // ══════════════════════════════════════════════
  //  v6 DEEP PRODUCT VERIFICATION ENGINE
  //  A niche search NEVER counts a store because its NAME or page title
  //  looks right. Every store must prove itself: we open its live product
  //  catalog and require 3+ products that actually match the niche
  //  (product titles, types, tags, categories, vendor). Stores selling
  //  cosmetics without "cosmetic" in their name pass; name-only matches fail.
  // ══════════════════════════════════════════════
  const NICHE_MIN_PRODUCT_MATCHES = 3
  const NICHE_KEYWORDS = {
    beauty: ['skincare','skin care','beauty','cosmetic','cosmetics','makeup','serum','moisturizer','moisturiser','cleanser','facial','face mask','face cream','eye cream','lip balm','lipstick','mascara','eyeliner','foundation','concealer','sunscreen','spf','body oil','body butter','body scrub','shea butter','night cream','toner','exfoliator','clay mask','sheet mask','retinol','niacinamide','hyaluronic','glycolic','blemish','acne','shower gel','bath bomb','lotion','beard oil','face mist','makeup brush','beauty blender','pressed powder','highlighter','blush','eyeshadow','lipliner','lip gloss','cuticle oil','french perfume','eau de parfum','fragrance'],
    jewelry: ['jewelry','jewellery','necklace','bracelet','earring','earrings','pendant','anklet','brooch','charm bracelet','signet ring','engagement ring','wedding band','sterling silver','925 silver','14k','18k','gold filled','rose gold','gemstone','birthstone','cubic zirconia','moissanite','pearl necklace','beaded bracelet','hoop earrings','stud earrings','jewel','locket','cufflinks','toe ring','body chain','initial necklace','name necklace','tennis bracelet','charm','jewelry box','ring','rings'],
    pet: ['pet','pets','dog','dogs','puppy','cat','cats','kitten','leash','dog collar','cat collar','harness','pet bed','dog bed','cat bed','cat tree','scratching post','litter box','cat litter','dog treats','cat treats','chew toy','pet food','dog food','cat food','aquarium','fish tank','hamster','guinea pig','parrot','bird cage','pet carrier','poop bag','grooming brush','pet bowl','dog toy','cat toy','dog leash','paw balm','pet shampoo','dog hoodie','catnip','puppy pads','pet blanket','slow feeder','dog raincoat'],
    fashion: ['fashion','clothing','clothes','apparel','dress','dresses','blouse','t-shirt','tshirt','crop top','hoodie','sweater','jumper','cardigan','jacket','coat','bomber jacket','jeans','trousers','pants','skirt','shorts','leggings','bodysuit','jumpsuit','streetwear','activewear','loungewear','swimwear','bikini','lingerie','pyjama','pajama','sneakers','trainers','boots','sandals','heels','loafers','handbag','tote bag','crossbody bag','backpack','belt','scarf','beanie','sunglasses','outfit','wardrobe','abaya','kaftan','saree','ankara','lace gown','ready to wear','athleisure','denim','two piece set','matching set','pencil skirt','cargo pants','oversized tee','bucket hat'],
  }
  const NICHE_LABELS = { beauty: 'Skincare/beauty', jewelry: 'Jewelry', pet: 'Pet products', fashion: 'Fashion/clothing' }
  const NICHE_SEARCH_WORDS = {
    beauty: 'skincare OR cosmetics OR beauty',
    jewelry: 'jewelry OR jewellery',
    pet: 'pet OR dog OR cat supplies',
    fashion: 'clothing OR fashion OR apparel',
  }

  // 🏪 Online Stores — platform picker. urlscan platforms use the scan index
  // (date windows enforced by the engine); web platforms are discovered via
  // DuckDuckGo/Bing search and verified with the SAME deep product check.
  const STORE_PLATFORMS = {
    shopify:     { label: '🛍️ Shopify',     discover: 'urlscan', query: 'page.domain:myshopify.com' },
    wix:         { label: '🌐 Wix',         discover: 'urlscan', query: 'page.domain:wixsite.com' },
    etsy:        { label: '🧵 Etsy',        discover: 'web',     webQuery: kws => `site:etsy.com/shop ${kws}` },
    bigcommerce: { label: '🧱 BigCommerce', discover: 'web',     webQuery: kws => `(${kws}) "powered by BigCommerce"` },
    squarespace: { label: '🎨 Squarespace', discover: 'web',     webQuery: kws => `(${kws}) squarespace store` },
    woocommerce: { label: '🛒 WooCommerce', discover: 'web',     webQuery: kws => `(${kws}) "powered by WooCommerce"` },
    auto:        { label: '🌍 Any builder', discover: 'urlscan', query: 'page.domain:myshopify.com OR page.domain:wixsite.com' },
  }

  const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
  function hostOfUrl(u) { try { return new URL(u).hostname.toLowerCase() } catch { return String(u || '') } }

  // Simple concurrency-limited mapper for the verification loops.
  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length)
    let i = 0
    async function worker() { while (i < list.length) { const idx = i++; out[idx] = await fn(list[idx], idx) } }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, () => worker()))
    return out
  }

  async function fetchTextSafe(url, timeout = 7000, maxLen = 300000) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': WEB_UA }, signal: AbortSignal.timeout(timeout) })
      return { status: r.status, url: r.url || url, text: await r.text().then(t => t.slice(0, maxLen)).catch(() => '') }
    } catch { return null }
  }
  async function fetchJsonSafe(url, timeout = 7000) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': WEB_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) })
      if (!r.ok) return null
      return await r.json()
    } catch { return null }
  }

  // Word-boundary matching on normalized text — "offering" must never match
  // the keyword "ring", and "skincare" must also catch "skin-care".
  function normalizeForMatch(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  }
  function textMatchesAny(normText, keywords) {
    if (!normText) return false
    for (const k of keywords) {
      if (!k) continue
      if (new RegExp('(^| )' + escapeRe(k) + '($| )', 'i').test(normText)) return true
    }
    return false
  }
  function productBlob(p) {
    return [p.title, p.type, Array.isArray(p.tags) ? p.tags.join(' ') : (p.tags || ''),
            Array.isArray(p.cats) ? p.cats.join(' ') : (p.cats || ''), p.vendor || ''].join(' ')
  }
  function countNicheMatches(products, keywords) {
    let n = 0; const samples = []
    for (const p of products || []) {
      const blob = normalizeForMatch(productBlob(p))
      if (textMatchesAny(blob, keywords)) {
        n++
        if (samples.length < 3 && p.title) samples.push(String(p.title).slice(0, 60))
      }
    }
    return { matches: n, samples }
  }
  function nicheWordsFor(nicheKey, customText) {
    if (nicheKey === 'custom' && customText) {
      const words = [...new Set(String(customText).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/).filter(w => w.length >= 4))].slice(0, 10)
      return words.length ? words : null
    }
    return NICHE_KEYWORDS[nicheKey] || null
  }
  function nicheSearchWords(nicheKey, customText) {
    if (NICHE_SEARCH_WORDS[nicheKey]) return NICHE_SEARCH_WORDS[nicheKey]
    if (nicheKey === 'custom' && customText) {
      const words = String(customText).split(/\s+/).filter(w => w.length >= 4).slice(0, 5)
      if (words.length) return words.join(' OR ')
      return customText
    }
    return 'store'
  }

  // ── Platform product fetchers: each returns [{title, type, tags, cats, vendor}]
  //    from the platform's OWN public product source, or null when the site
  //    isn't on that platform / the catalog can't be read.
  async function getShopifyProducts(domain) {
    const j = await fetchJsonSafe(`https://${domain}/products.json?limit=250`, 7000)
    const list = j && Array.isArray(j.products) ? j.products : null
    if (!list || !list.length) return null
    return list.map(p => ({ title: p.title || '', type: p.product_type || '',
      tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(','), vendor: p.vendor || '' }))
  }
  async function getWixProducts(domain) {
    // Wix auto-generates /sitemap.xml listing every /product-page/<slug> —
    // the slug IS the product name.
    const { text } = await fetchTextSafe(`https://${domain}/sitemap.xml`, 8000) || {}
    if (!text) return null
    const slugs = [...new Set((text.match(/https?:\/\/[^<\s"']+\/product-page\/([^<\s"'.?#]+)/gi) || [])
      .map(u => { try { return decodeURIComponent(u.split('/product-page/')[1].split(/[?#]/)[0]).replace(/[-_]+/g, ' ').trim() } catch { return '' } })
      .filter(Boolean))]
    return slugs.length ? slugs.map(t => ({ title: t })) : null
  }
  async function getWooProducts(domain) {
    const j = await fetchJsonSafe(`https://${domain}/wp-json/wc/store/v1/products?per_page=100`, 8000)
    if (Array.isArray(j) && j.length) {
      return j.map(p => ({ title: p.name || '', type: '', tags: (p.tags || []).map(t => t.name || ''),
        cats: (p.categories || []).map(c => c.name || '') }))
    }
    const { text } = await fetchTextSafe(`https://${domain}/sitemap.xml`, 7000) || {}
    if (text) {
      const slugs = [...new Set((text.match(/https?:\/\/[^<\s"']+\/product\/([^<\s"'.?#]+)/gi) || [])
        .map(u => { try { return decodeURIComponent(u.split('/product/')[1].split(/[?#]/)[0]).replace(/[-_]+/g, ' ').trim() } catch { return '' } })
        .filter(Boolean))]
      if (slugs.length) return slugs.map(t => ({ title: t }))
    }
    return null
  }
  async function getSquarespaceProducts(domain) {
    for (const path of ['/shop?format=json', '/?format=json']) {
      const j = await fetchJsonSafe(`https://${domain}${path}`, 7000)
      const items = j && Array.isArray(j.items) ? j.items : null
      if (items && items.length) {
        const out = items.map(it => ({ title: it.title ||
          (String(it.fullUrl || it.url || '').split('/').pop() || '').replace(/[-_]+/g, ' ').trim() }))
          .filter(p => p.title)
        if (out.length) return out
      }
    }
    return null
  }
  async function getBigCommerceProducts(domain) {
    const { text, status } = await fetchTextSafe(`https://${domain}/`, 7000) || {}
    if (!text || status >= 400) return null
    const prods = new Map()
    for (const m of text.matchAll(/"@type"\s*:\s*"Product"[\s\S]{0,400}?"name"\s*:\s*"([^"]{2,120})"/gi)) prods.set(m[1], { title: m[1] })
    for (const m of text.matchAll(/href="https?:[^\"]*\/(?:buy|products)\/([^\"\/?#]+)/gi)) {
      const t = (() => { try { return decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').trim() } catch { return '' } })()
      if (t) prods.set(t, { title: t })
    }
    return prods.size ? [...prods.values()] : null
  }
  async function getEtsyProducts(shopUrlOrName, keywords) {
    // Product-level evidence WITHOUT scraping Etsy (it blocks server IPs):
    // the search index knows each shop's LISTING pages — a listing URL is a
    // real product, and its slug is the product name. 3+ distinct matching
    // listings = the shop's catalog genuinely carries the niche.
    const m = String(shopUrlOrName).match(/etsy\.com\/shop\/([A-Za-z0-9_%.-]+)/i)
    const shop = m ? decodeURIComponent(m[1]) : String(shopUrlOrName || '').replace(/^@/, '').trim()
    if (!shop) return null
    const shopLow = shop.toLowerCase().replace(/[-_]/g, ' ')
    const singleWords = (keywords || []).filter(k => k && !k.includes(' ')).slice(0, 4)
    const kwStr = singleWords.length ? singleWords.join(' ') : (keywords || []).slice(0, 2).join(' ')
    const { results } = await webSearch(`site:etsy.com ${shop} ${kwStr}`)
    const slugs = new Set()
    for (const r of results) {
      const u = r.url.toLowerCase(); const t = r.title.toLowerCase()
      if (u.includes('/listing/') && (t.includes(shopLow) || u.includes(shop.toLowerCase().replace(/[^a-z0-9]/g, '')))) {
        const slug = (r.url.split('/listing/')[1] || '').replace(/^\d+\/?/, '').split(/[?#]/)[0].replace(/[-_]+/g, ' ').trim()
        if (slug) slugs.add(slug)
      }
    }
    if (slugs.size >= NICHE_MIN_PRODUCT_MATCHES) return [...slugs].map(s => ({ title: s }))
    // Fallback: direct shop page (works when Etsy doesn't block the server IP)
    const page = await fetchTextSafe(`https://www.etsy.com/shop/${encodeURIComponent(shop)}`, 7000)
    if (page && page.status === 200 && page.text) {
      const found = new Set()
      for (const lm of page.text.matchAll(/etsy\.com\/listing\/\d+\/([a-z0-9-]+)/gi)) {
        found.add(decodeURIComponent(lm[1]).replace(/[-_]+/g, ' '))
      }
      if (found.size) return [...found].map(s => ({ title: s }))
    }
    return slugs.size ? [...slugs].map(s => ({ title: s })) : null
  }

  // THE gate: open the store's live catalog for its platform and count
  // niche-matching products. pass = matches >= NICHE_MIN_PRODUCT_MATCHES.
  async function verifyStoreProducts(domain, platform, keywords) {
    if (!keywords || !keywords.length) return { skipped: true, matches: -1, samples: [] }
    const order = (!platform || platform === 'auto')
      ? ['shopify', 'woocommerce', 'wix', 'squarespace', 'bigcommerce'] : [platform]
    for (const p of order) {
      let products = null
      try {
        if (p === 'shopify') products = await getShopifyProducts(domain)
        else if (p === 'wix') products = await getWixProducts(domain)
        else if (p === 'woocommerce') products = await getWooProducts(domain)
        else if (p === 'squarespace') products = await getSquarespaceProducts(domain)
        else if (p === 'bigcommerce') products = await getBigCommerceProducts(domain)
        else if (p === 'etsy') products = await getEtsyProducts(domain, keywords)
      } catch (e) { /* try next platform source */ }
      if (products && products.length) {
        const { matches, samples } = countNicheMatches(products, keywords)
        return { skipped: false, platform: p, total: products.length, matches, samples,
                 pass: matches >= NICHE_MIN_PRODUCT_MATCHES }
      }
    }
    return { skipped: false, platform: null, matches: 0, samples: [], pass: false,
             note: 'no readable product catalog' }
  }

  // ── Web search (DuckDuckGo HTML, Bing fallback) — used for Etsy/BigCommerce/
  //    Squarespace/WooCommerce discovery and UK company website checks.
  async function webSearch(query, timeout = 8000) {
    try {
      const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(timeout) })
      if (r.ok) {
        const html = await r.text()
        if (!/anomaly|captcha|unusual traffic/i.test(html.slice(0, 4000))) {
          const out = []
          for (const m of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
            let url = m[1]
            const uddg = url.match(/[?&]uddg=([^&]+)/)
            if (uddg) { try { url = decodeURIComponent(uddg[1]) } catch { continue } }
            url = url.replace(/^\/\//, 'https://')
            if (!/^https?:\/\//i.test(url)) continue
            const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
            if (title) out.push({ url, title })
            if (out.length >= 30) break
          }
          if (out.length) return { results: out, blocked: false }
        }
      }
    } catch { /* fall through to Bing */ }
    try {
      const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=30`, {
        headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(timeout) })
      if (r.ok) {
        const html = await r.text()
        const out = []
        for (const m of html.matchAll(/<h2><a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
          const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
          if (title) out.push({ url: m[1], title })
          if (out.length >= 30) break
        }
        if (out.length) return { results: out, blocked: false }
      }
    } catch { /* both engines failed */ }
    return { results: [], blocked: true }
  }

  // ══════════════════════════════════════════════
  //  v6 UK COMPANY WEBSITE VERIFICATION (max strength)
  //  findCompanyWebsite() returns a website ONLY when a live site genuinely
  //  belongs to the company: domain-name match, registered postcode on the
  //  page, or the full company name on the page. Everything else is "no site".
  // ══════════════════════════════════════════════
  const UK_VERIFY_BATCH = 36   // companies website-verified per /newuk run (time budget)
  const UK_WEB_BLOCKLIST = ['company-information.service.gov.uk','find-and-update.company-information.service.gov.uk',
    'beta.companieshouse.gov.uk','companieshouse.gov.uk','gov.uk','opencorporates.com','linkedin.com','facebook.com',
    'instagram.com','twitter.com','x.com','tiktok.com','youtube.com','wikipedia.org','yell.com','thomsonlocal.com',
    '192.com','yelp.com','trustpilot.com','duedil.com','crunchbase.com','bark.com','checkatrade.com','ratedpeople.com',
    'glassdoor.co.uk','indeed.co.uk','indeed.com','zoominfo.com','dnb.com','bloomberg.com','craft.co','endole.com',
    'companycheck.co.uk','companywizard.co.uk','bizdb.co.uk','ukdata.com','llcfinder.com','bizapedia.com','doorbell.io']
  function ukCoreName(name) {
    return String(name || '').replace(/\b(ltd|limited|llp|plc|lp|llc|inc|uk|group|holdings)\b\.?/gi, ' ')
      .replace(/[^a-zA-Z0-9&\s]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  }
  function ukSlug(name) { return ukCoreName(name).replace(/[^a-z0-9]+/g, '') }
  function ukSlugHyphen(name) { return ukCoreName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') }

  // Live-check one candidate domain against the company's identity.
  async function checkSiteForCompany(url, companyName, addr) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': WEB_UA }, signal: AbortSignal.timeout(5000) })
      if (!r.ok) return null
      const finalUrl = (r.url || url).replace(/\/$/, '')
      const host = (() => { try { return new URL(finalUrl).hostname.toLowerCase() } catch { return '' } })()
      if (!host || UK_WEB_BLOCKLIST.some(b => host === b || host.endsWith('.' + b))) return null
      const body = await r.text().then(t => t.slice(0, 150000)).catch(() => '')
      if (!body) return null
      const low = body.toLowerCase()
      const core = ukCoreName(companyName)
      const toks = core.split(' ').filter(t => t.length > 2)
      const squashed = core.replace(/[^a-z0-9]/g, '')
      const hostLabel = host.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '')
      const titleM = low.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)
      const titleLow = titleM ? titleM[1].toLowerCase() : ''
      // Identity evidence, strongest first:
      if (squashed.length >= 5 && hostLabel.length >= 4 &&
          (hostLabel.includes(squashed) || (squashed.includes(hostLabel) && hostLabel.length >= 5))) {
        return { url: finalUrl, evidence: 'domain matches company name' }
      }
      const postcode = String((addr && (addr.postal_code || addr.postcode)) || '').toLowerCase().replace(/\s+/g, '')
      if (postcode.length >= 5 && low.includes(postcode)) {
        return { url: finalUrl, evidence: 'registered postcode on page' }
      }
      if (toks.length >= 2 && toks.every(t => low.includes(t))) {
        return { url: finalUrl, evidence: 'full company name on page' }
      }
      if (core.length >= 6 && titleLow.includes(core)) {
        return { url: finalUrl, evidence: 'company name in page title' }
      }
      return null
    } catch { return null }
  }

  async function findCompanyWebsite(company) {
    const name = company.name || company.company_name || ''
    const addr = company.registered_office_address || company.address || {}
    const core = ukCoreName(name)
    if (!core || core.length < 3) return null
    const s1 = ukSlug(name), s2 = ukSlugHyphen(name)
    const guesses = []
    for (const s of [s1, s2]) {
      if (!s || s.length < 3) continue
      guesses.push(`https://${s}.co.uk`, `https://www.${s}.com`, `https://${s}.org.uk`, `https://${s}.uk`)
    }
    const loc = [addr.locality, addr.postal_code].filter(Boolean).join(' ')
    const { results } = await webSearch(`"${name}" ${loc}`.trim())
    const searched = results.map(r => { try { return new URL(r.url).hostname.toLowerCase() } catch { return '' } })
      .filter(h => h && !UK_WEB_BLOCKLIST.some(b => h === b || h.endsWith('.' + b)))
    const candidates = [...new Set([...searched.slice(0, 3).map(h => `https://${h}`), ...new Set(guesses)])].slice(0, 8)
    for (const url of candidates) {
      const hit = await checkSiteForCompany(url, name, addr)
      if (hit) return hit
    }
    return null
  }

  // Per-user UK website filter — 'all' (default) | 'web' (with website only) | 'noweb'.
  async function getUkWebPref(userId) {
    const { result } = await redis('GET', `uk:webfilter:${userId}`)
    return ['all', 'web', 'noweb'].includes(result) ? result : 'all'
  }

  // Shared tail of the 🏪 Online Stores wizard: niche chosen → month picker.
  async function finalizeStoreSearch(chatId, userId, q, nicheKey, customNicheText) {
    const p = STORE_PLATFORMS[q.pendingSearch.storePlatform]
    if (!p) return
    const keywords = nicheWordsFor(nicheKey, customNicheText) || NICHE_KEYWORDS.beauty
    const nicheLabel = customNicheText ? `"${customNicheText}"` : (NICHE_LABELS[nicheKey] || nicheKey)
    q.pendingSearch.niche = nicheKey
    q.pendingSearch.customNiche = customNicheText || null
    q.pendingSearch.keywords = keywords
    q.pendingSearch.platform = q.pendingSearch.storePlatform
    q.pendingSearch.label = `${p.label} · ${nicheLabel} (3+ product check)`
    if (p.discover === 'urlscan') {
      q.pendingSearch.query = p.query
      q.pendingSearch.webQuery = null
    } else {
      q.pendingSearch.query = null
      q.pendingSearch.webQuery = p.webQuery(nicheSearchWords(nicheKey, customNicheText))
    }
    q.awaitingScoutMonth = true
    await saveUserQueue(userId, q)
    await sendKeyboard(chatId,
      `✅ ${p.label} · ${nicheLabel}\n\nEvery store found will be opened and its LIVE product catalog checked — only stores with 3+ matching products count.\n\nWhich date window should I pull from?` +
      (p.discover === 'web' ? '\n\n(Heads-up: web discovery can\'t hard-filter by scan date the way the Shopify index can — the store-age gate can still enforce real age.)' : ''),
      monthPickerKeyboard())
  }

  // ── v6 COUNTRY DETECTION (ported from the v5 build) ──
  // Signals, strongest first: 1. country-code TLD  2. printed phone prefixes
  // 3. page language. Server geo is deliberately not used.
  const COUNTRY_LABELS = {
    NG: '🇳🇬 Nigeria', GH: '🇬🇭 Ghana', KE: '🇰🇪 Kenya', ZA: '🇿🇦 South Africa', EG: '🇪🇬 Egypt',
    US: '🇺🇸 United States', UK: '🇬🇧 United Kingdom', CA: '🇨🇦 Canada', AU: '🇦🇺 Australia',
    IN: '🇮🇳 India', PK: '🇵🇰 Pakistan', PH: '🇵🇭 Philippines', ID: '🇮🇩 Indonesia', MY: '🇲🇾 Malaysia', SG: '🇸🇬 Singapore',
    DE: '🇩🇪 Germany', FR: '🇫🇷 France', IT: '🇮🇹 Italy', ES: '🇪🇸 Spain', NL: '🇳🇱 Netherlands',
    IE: '🇮🇪 Ireland', PT: '🇵🇹 Portugal', BR: '🇧🇷 Brazil', MX: '🇲🇽 Mexico', AR: '🇦🇷 Argentina',
    JP: '🇯🇵 Japan', AE: '🇦🇪 UAE', SA: '🇸🇦 Saudi Arabia', TR: '🇹🇷 Turkey', VN: '🇻🇳 Vietnam'
  }
  const COUNTRY_CCTLDS = {
    ng: 'NG', gh: 'GH', ke: 'KE', za: 'ZA', eg: 'EG', tz: 'KE', ug: 'KE', ma: 'EG', et: 'KE',
    uk: 'UK', us: 'US', ca: 'CA', au: 'AU', nz: 'AU', ie: 'IE',
    in: 'IN', pk: 'PK', bd: 'IN', ph: 'PH', id: 'ID', my: 'MY', sg: 'SG',
    de: 'DE', fr: 'FR', it: 'IT', es: 'ES', pt: 'PT', nl: 'NL', be: 'NL', ch: 'DE', at: 'DE',
    se: 'DE', no: 'DE', dk: 'DE', fi: 'SE', pl: 'DE', cz: 'DE', ro: 'DE', gr: 'DE', tr: 'TR',
    br: 'BR', mx: 'MX', ar: 'AR', cl: 'AR', co: 'MX',
    jp: 'JP', kr: 'JP', cn: 'JP', hk: 'JP', tw: 'JP', vn: 'VN', th: 'VN',
    il: 'TR', ae: 'AE', sa: 'AE'
  }
  const COUNTRY_PHONE = [
    ['+880', 'IN'], ['+852', 'JP'], ['+886', 'JP'], ['+234', 'NG'], ['+254', 'KE'],
    ['+233', 'GH'], ['+255', 'KE'], ['+256', 'KE'], ['+212', 'EG'], ['+351', 'PT'],
    ['+358', 'DE'], ['+353', 'IE'], ['+972', 'TR'], ['+971', 'AE'], ['+966', 'AE'],
    ['+27', 'ZA'], ['+20', 'EG'], ['+44', 'UK'], ['+91', 'IN'], ['+92', 'PK'],
    ['+63', 'PH'], ['+62', 'ID'], ['+60', 'MY'], ['+65', 'SG'], ['+49', 'DE'],
    ['+33', 'FR'], ['+39', 'IT'], ['+34', 'ES'], ['+31', 'NL'], ['+32', 'NL'],
    ['+41', 'DE'], ['+43', 'DE'], ['+46', 'DE'], ['+47', 'DE'], ['+45', 'DE'],
    ['+48', 'DE'], ['+40', 'DE'], ['+30', 'DE'], ['+90', 'TR'], ['+55', 'BR'],
    ['+52', 'MX'], ['+54', 'AR'], ['+56', 'AR'], ['+57', 'MX'], ['+81', 'JP'],
    ['+82', 'JP'], ['+86', 'JP'], ['+84', 'VN'], ['+66', 'VN'], ['+61', 'AU'],
    ['+64', 'AU'], ['+1', 'US']
  ]
  const COUNTRY_LANG = { de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', pt: 'PT', tr: 'TR', vi: 'VN', id: 'ID', pl: 'DE' }
  function detectCountry(host, text, html) {
    const h = String(host || '').toLowerCase()
    const t = String(text || '')
    for (const [cc, code] of Object.entries(COUNTRY_CCTLDS)) {
      if (h.endsWith('.' + cc)) return { code, label: COUNTRY_LABELS[code], why: [`.${cc} domain`] }
    }
    const counts = new Map()
    for (const [prefix, code] of COUNTRY_PHONE) {
      const rx = code === 'US' ? /\+1[\s(.-]{0,2}\d/g : new RegExp('\\' + prefix + '[\\s(.-]{0,2}\\d', 'g')
      const n = (t.match(rx) || []).length
      if (n) counts.set(code, (counts.get(code) || 0) + n)
    }
    let best = null
    for (const [code, n] of counts) if (!best || n > best.n) best = { code, n }
    if (best) return { code: best.code, label: COUNTRY_LABELS[best.code], why: [`${best.code} phone numbers ×${best.n}`] }
    const lang = (String(html || '').match(/<html[^>]*?\slang=["']([a-z]{2})(?:[-_][a-zA-Z]{2})?["']/i) || [])[1]
    if (lang && COUNTRY_LANG[lang.toLowerCase()]) {
      const code = COUNTRY_LANG[lang.toLowerCase()]
      return { code, label: COUNTRY_LABELS[code], why: [`page language "${lang}"`] }
    }
    return null
  }

  // ── /scout month picker — limits the search to one calendar month using
  //  urlscan's own date filter, so picking "October 2026" really means it.
  const MONTH_NAMES = ['January','February','March','April','May','June','July',
                       'August','September','October','November','December']
  function ymLabel(month) {
    if (month === 'last7')       return 'the last 7 days'
    if (month === 'last14')      return 'the last 14 days'
    if (month === 'last30')      return 'the last 30 days'
    if (month === 'thismonth') {
      const d = new Date()
      return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()} (so far)`
    }
    if (!month || month === 'any') return 'any time'
    const [y, m] = month.split('-')
    return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`
  }
  function monthPickerKeyboard() {
    // urlscan's public search index only covers the last 30 days
    // (search_date_limit_days: 30) — offering older months would just
    // produce empty results, so the picker stays inside that window.
    const rows = []
    const now = new Date()
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    rows.push([{ text: '🕐 Last 7 days',   callback_data: 'scoutmonth:last7'  },
               { text: '🕐 Last 14 days',  callback_data: 'scoutmonth:last14' }])
    rows.push([{ text: '🕐 Last 30 days',  callback_data: 'scoutmonth:last30' },
               { text: `📅 This month (${MONTH_NAMES[now.getUTCMonth()]})`, callback_data: 'scoutmonth:thismonth' }])
    rows.push([{ text: '🌐 Any time (newest first)', callback_data: 'scoutmonth:any' }])
    rows.push([{ text: '✏️ Custom date or backward range', callback_data: 'scoutdatecustom' }])
    return rows
  }
  // WORKING urlscan date syntax (verified live): an INCLUSIVE range —
  // date:[YYYY-MM-DD TO YYYY-MM-DD]. The date:>[...] AND date:<[...] form is
  // rejected by the API and silently returned zero results before.
  function applyMonthFilter(query, month) {
    if (!month || month === 'any') return query
    const isoDay = (d) => d.toISOString().slice(0, 10)
    const today = isoDay(new Date())
    let from
    if (month === 'last7')       from = isoDay(new Date(Date.now() - 7 * 86400000))
    else if (month === 'last14') from = isoDay(new Date(Date.now() - 14 * 86400000))
    else if (month === 'last30') from = isoDay(new Date(Date.now() - 30 * 86400000))
    else if (month === 'thismonth') {
      const d = new Date()
      from = isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
    } else {
      const [y, m] = month.split('-').map(Number)
      from = isoDay(new Date(Date.UTC(y, m - 1, 1)))
    }
    return `${query} AND date:[${from} TO ${today}]`
  }
  function applyScoutDateFilter(query, month, dateRange) {
    if (dateRange && dateRange.from && dateRange.to) {
      return `${query} AND date:[${dateRange.from} TO ${dateRange.to}]`
    }
    return applyMonthFilter(query, month)
  }
  function dateRangeLabel(range) {
    if (!range) return ''
    return range.from === range.to ? range.from : `${range.from} to ${range.to}`
  }
  function validIsoDay(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day))
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
    return d.toISOString().slice(0, 10)
  }
  function customDateWindowError(from, to) {
    const today = new Date().toISOString().slice(0, 10)
    const oldest = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    if (to > today) return 'That date is in the future. Choose today or an earlier day.'
    if (from < oldest) return `urlscan\'s public search only reaches back about 30 days (${oldest} onward here). Choose a more recent date or shorten the range.`
    return ''
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
      q.awaitingScoutAgeGate || q.awaitingStoreNiche ||
      q.awaitingCustomDate || q.awaitingSocialFilter || q.awaitingHuntUrl || q.wizard || q.answeringGift))
  }

  async function saveFilteredOut(userId, list) {
    // Merge with what's already stored — a hunt drops leads across several
    // batches/messages, replacing the list each time would lose earlier drops.
    const prev = await getFilteredOut(userId)
    const merged = [...prev, ...list].slice(-200)
    await redis('SET', `filtered:${userId}`, JSON.stringify(merged))
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
  // Claims and quiz answers for the same gift must be serialized across Vercel
  // invocations; otherwise two simultaneous reads can overwrite the winner.
  async function withGiftLock(giftId, fn) {
    const key = `lock:gift:${giftId}`
    let acquired = false
    for (let i = 0; i < 8; i++) {
      const { ok, result } = await redis('SET', key, '1', 'NX', 'EX', '20')
      if (ok && result === 'OK') { acquired = true; break }
      await new Promise(r => setTimeout(r, 120))
    }
    if (!acquired) return false
    try { await fn(); return true } finally { await redis('DEL', key) }
  }
  function giftDismissed(g, uid) {
    return (g.dismissed || []).includes(String(uid))
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
  function giftInviteText(g) {
    return `🎁 New gift for you!\n\n🎟️ ${giftPrizeText(g)}` +
      (g.message ? `\n\n💌 ${g.message}` : '') +
      (g.mode === 'quiz' ? `\n\n❓ ${g.question}\n\nTap Answer, then send your answer as a normal message.` :
        g.mode === 'first' ? `\n\n⚡ First person to claim wins.` : `\n\nTap Claim to receive yours.`)
  }
  function giftInviteKeyboard(g) {
    return [[
      B(g.mode === 'quiz' ? '✏️ Answer' : '🎁 Claim', g.mode === 'quiz' ? `giftans:${g.id}` : `giftclaim:${g.id}`),
      B('🚫 Decline', `giftdecline:${g.id}`)
    ]]
  }
  async function publishGiftToAll(g) {
    const { result: ids } = await redis('SMEMBERS', 'bot:users')
    let delivered = 0, failed = 0
    const recipients = ids || []
    // Small parallel batches stay below Telegram's broadcast rate while avoiding
    // one long serial request chain inside a single Vercel invocation.
    for (let i = 0; i < recipients.length; i += 20) {
      const responses = await Promise.all(recipients.slice(i, i + 20).map(uid => tgCall('sendMessage', {
        chat_id: uid, text: giftInviteText(g),
        reply_markup: { inline_keyboard: giftInviteKeyboard(g) }
      })))
      for (const r of responses) { if (r?.ok) delivered++; else failed++ }
      if (i + 20 < recipients.length) await new Promise(resolve => setTimeout(resolve, 800))
    }
    return { delivered, failed }
  }
  function giftUnavailableText(g) {
    if (!g) return 'That gift could not be found. Open /gift to see the current gifts.'
    if ((g.winners || []).length) return 'This gift already has a winner.'
    return 'This gift was closed by the owner. No winner was recorded.'
  }
  async function claimGift(chatId, uid, giftId) {
    const ran = await withGiftLock(giftId, async () => {
      const g = await getGift(giftId)
      if (!g || g.status !== 'open') { await send(chatId, giftUnavailableText(g)); return }
      if (g.mode === 'quiz') { await send(chatId, `This is a quiz gift — tap Answer and send your answer.`); return }
      if ((g.winners || []).some(w => String(w.uid) === String(uid))) { await send(chatId, `You already claimed this one 🎁`); return }
      if (g.mode === 'first' && (g.winners || []).length >= 1) { await send(chatId, `Someone already grabbed this one — check the other open gifts!`); return }
      if (g.mode === 'everyone' && g.maxClaims > 0 && (g.winners || []).length >= g.maxClaims) { await send(chatId, `This gift is all claimed out — check back for the next one!`); return }
      g.winners = g.winners || []
      g.winners.push({ uid, ts: Date.now() })
      if (g.mode === 'first') g.status = 'closed'
      await saveGift(g)
      await awardGiftTo(g, uid)
      await deliverGift(uid, g)
      await notifyOwnerGiftLine(g, uid, 'claimed')
      await send(chatId, `🎁 Gift claimed — your prize has been added to your account.`)
    })
    if (!ran) await send(chatId, 'That gift is busy with another response. Please tap the button again in a moment.')
  }
  async function answerGift(chatId, uid, giftId, text) {
    const ran = await withGiftLock(giftId, async () => {
      const g = await getGift(giftId)
      if (!g || g.status !== 'open') { await send(chatId, giftUnavailableText(g)); return }
      if (g.mode !== 'quiz') { await send(chatId, 'This gift needs Claim rather than an answer.'); return }
      if ((g.winners || []).length >= 1) { await send(chatId, `Someone already won this one!`); return }
      g.attempts = g.attempts || {}
      g.attempts[String(uid)] = text.slice(0, 200)
      if (normAnswer(text) === normAnswer(g.answer)) {
        g.winners = [{ uid, ts: Date.now() }]
        g.status = 'closed'
        await saveGift(g)
        await awardGiftTo(g, uid)
        await deliverGift(uid, g)
        await notifyOwnerGiftLine(g, uid, 'WON (correct answer)')
        await send(chatId, `🎉 Correct! You won — your prize has been added to your account.`)
      } else {
        // Wrong attempts never close the gift or create a winner.
        await saveGift(g)
        await send(chatId, `❌ Not quite — tap Answer on the gift and try again. The gift is still open.`)
      }
    })
    if (!ran) {
      const q = await getUserQueue(uid)
      q.answeringGift = giftId
      await saveUserQueue(uid, q)
      await send(chatId, 'Another answer is being checked. Please send yours again in a moment.')
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

  const SOCIAL_HOSTS = {
    facebook: ['facebook.com'], instagram: ['instagram.com'],
    x: ['x.com', 'twitter.com'], linkedin: ['linkedin.com'],
    tiktok: ['tiktok.com'], youtube: ['youtube.com']
  }
  const SOCIAL_PLACEHOLDERS = new Set([
    'shopify', 'shopifyplus', 'shopifydevelopers', 'yourstore', 'yourbrand',
    'username', 'yourusername', 'example', 'examples', 'test', 'testing',
    'facebook', 'instagram', 'twitter', 'x', 'linkedin', 'home', 'login',
    'tiktok', 'youtube', 'channel', 'user', 'watch', 'page'
  ])
  function normalizeSocialUrl(platform, raw) {
    try {
      const u = new URL(raw.replace(/[\\"'<>]+$/g, ''))
      const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '')
      if (!SOCIAL_HOSTS[platform].includes(host)) return null
      const parts = u.pathname.split('/').filter(Boolean)
      if (platform === 'linkedin') {
        if (!['company', 'in'].includes((parts[0] || '').toLowerCase()) || !parts[1]) return null
        if (SOCIAL_PLACEHOLDERS.has(parts[1].toLowerCase())) return null
      } else {
        if (parts.length !== 1 || !/^[a-zA-Z0-9_.-]+$/.test(parts[0])) return null
        if (SOCIAL_PLACEHOLDERS.has(parts[0].toLowerCase())) return null
        if (['sharer', 'share', 'intent', 'hashtag', 'explore', 'p', 'reel', 'stories'].includes(parts[0].toLowerCase())) return null
      }
      return `https://${host}/${parts.join('/')}`
    } catch { return null }
  }
  function extractSocials(text) {
    const socials = {}
    const patterns = {
      facebook:  /https?:\/\/(?:www\.|m\.)?facebook\.com\/[a-zA-Z0-9_.\-]+/gi,
      instagram: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9_.\-]+/gi,
      x:         /https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/[a-zA-Z0-9_.\-]+/gi,
      linkedin:  /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[a-zA-Z0-9_.\-]+/gi,
      tiktok:    /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9_.\-]+/gi,
      youtube:   /https?:\/\/(?:www\.)?youtube\.com\/@[a-zA-Z0-9_.\-]+/gi,
    }
    for (const [key, pat] of Object.entries(patterns)) {
      for (const m of text.match(pat) || []) {
        const clean = normalizeSocialUrl(key, m)
        if (clean) { socials[key] = clean; break }
      }
    }
    return socials
  }
  // v6 STRICT social validation — every link gets a LIVE check and a verdict:
  //   'valid'     → 200 on the platform itself, page is really that account
  //   'dead'      → 404/410, platform "page not found" body, or off-platform redirect
  //   'unverified'→ bot-walled (401/403/429/999), login-wall or network error
  // Only VERIFIED links count toward a required platform or the social score;
  // unverified links are kept but tagged, dead links are dropped entirely.
  async function validateSocialUrl(platform, url) {
    try {
      const r = await fetch(url, {
        redirect: 'follow', signal: AbortSignal.timeout(4500),
        headers: { 'User-Agent': WEB_UA }
      })
      const finalHost = new URL(r.url || url).hostname.toLowerCase().replace(/^(www|m|mobile)\./, '')
      if (!SOCIAL_HOSTS[platform].includes(finalHost)) return 'dead'
      if ([404, 410].includes(r.status)) return 'dead'
      if ([401, 403, 429, 999].includes(r.status)) return 'unverified'
      if (!r.ok) return 'unverified'
      const body = (await r.text()).slice(0, 250000).toLowerCase()
      if (/page (?:isn't|is not) available|this account doesn.?t exist|this page (?:could not|couldn't) be found|profile (?:does not|doesn't) exist|couldn'?t find this account|channel (?:is|does) not (?:available|exist)|user (?:is|does) not (?:available|exist)/.test(body)) return 'dead'
      // A redirect to a login/signup wall proves nothing about the account —
      // strict mode refuses to count it as verified.
      if (/(^|>)(log in|log into facebook|sign up to see)\b/i.test(body.slice(0, 4000))) return 'unverified'
      if (new URL(r.url || url).pathname.toLowerCase().startsWith('/login')) return 'unverified'
      return 'valid'
    } catch { return 'unverified' }
  }
  async function validateSocials(socials) {
    const entries = Object.entries(socials || {})
    const checked = await Promise.all(entries.map(async ([platform, url]) =>
      [platform, url, await validateSocialUrl(platform, url)]))
    const out = { verified: {}, unverified: {} }
    for (const [platform, url, verdict] of checked) {
      if (verdict === 'valid') out.verified[platform] = url
      else if (verdict === 'unverified') out.unverified[platform] = url
    }
    return out
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
    // All 5 sources in PARALLEL — sequentially this took up to ~30s per store
    // and made "hunt until N" impossible inside one run.
    async function crtshFirstSeenMs(host) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 6000)
        const r = await fetch(`${CRTSH_BASE}?q=${encodeURIComponent(host)}`, {
          signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' }
        })
        clearTimeout(t)
        if (!r.ok) return null
        let earliest = null
        for (const row of await r.json() || []) {
          const nb = row.not_before ? Date.parse(row.not_before) : NaN
          if (!isNaN(nb) && (earliest === null || nb < earliest)) earliest = nb
        }
        return earliest
      } catch { return null }
    }
    const [crt, cs, wb, us, pj] = await Promise.all([
      crtshFirstSeenMs(host),
      certspotterFirstSeenMs(host),
      waybackFirstSeenMs(host),
      urlscanFirstSeenMs(host),
      productsJsonFirstSeenMs(host),
    ])
    const signals = [crt, cs, wb, us, pj].filter(t => t)
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

      // v6: country detection (ported from the v5 build) — domain TLD → phone
      // prefixes → page language. Labeled on every lead card.
      try {
        result.country = detectCountry(hostOfUrl(url), html.replace(/<[^>]+>/g, ' '), html)
      } catch { /* never block the lead on this */ }

      const finalUrl = r.url || url
      result.isPasswordProtected = (
        r.status === 401 || finalUrl.includes('/password') ||
        html.includes('shopify-section-password') ||
        /this (store|shop) (will be back soon|is currently password protected)/i.test(html) ||
        /enter (using )?password/i.test(html) || /opening soon/i.test(html)
      )

      const sv = await validateSocials(extractSocials(html))
      result.socials = sv.verified
      result.socialsUnverified = sv.unverified
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
            return { pageUrl, emails: cleanEmails(pageHtml), exists: true, socials: extractSocials(pageHtml) }
          } catch { return { pageUrl, emails: [], exists: false, socials: {} } }
        }))
        for (const fallback of fallbackResults) {
          if (!fallback.socials) continue
          const more = await validateSocials(fallback.socials)
          result.socials = { ...result.socials, ...more.verified }
          result.socialsUnverified = { ...result.socialsUnverified, ...more.unverified }
        }
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

  async function processBatch(urls, userQueue = null) {
    const results = []
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const chunk = urls.slice(i, i + CONCURRENCY)
      const chunkResults = await Promise.all(chunk.map(url => checkOneStore(url)))
      // v6 DEEP PRODUCT CHECK — a niche job only counts stores whose live
      // catalog holds 3+ products matching the niche. Fails are dropped and
      // logged to /others, never counted toward the requested total.
      if (userQueue && userQueue.niche && userQueue.keywords) {
        await Promise.all(chunkResults.map(async r => {
          if (r.status !== 'OK') return
          r.nicheRequired = true
          try {
            const v = await verifyStoreProducts(hostOfUrl(r.url),
              userQueue.platform && userQueue.platform !== 'etsy' ? userQueue.platform : 'auto', userQueue.keywords)
            r.nicheMatches = v.matches
            r.nicheSamples = v.samples || []
            r.nicheVerified = !!v.pass
            if (v.platform) r.catalog_platform = v.platform
            if (!v.pass) r.nicheNote = v.skipped ? 'no readable catalog' : `${Math.max(v.matches, 0)}/${NICHE_MIN_PRODUCT_MATCHES} matching products`
          } catch (e) { r.nicheVerified = false; r.nicheNote = 'catalog check failed' }
        }))
      }
      results.push(...chunkResults)
    }
    return results
  }

  // Etsy candidates skip the normal store check (Etsy blocks server IPs) —
  // they go straight to the product-level listing check instead. A shop only
  // counts when 3+ real listings match the niche.
  async function processEtsyBatch(urls, userQueue) {
    const out = []
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const chunk = urls.slice(i, i + CONCURRENCY)
      const chunkResults = await Promise.all(chunk.map(async (url) => {
        const shopName = decodeURIComponent(((url.split('/shop/')[1] || url).replace(/\/$/, ''))).slice(0, 60)
        const r = { url: `https://www.etsy.com/shop/${shopName}`, store_name: shopName,
          email: 'no email', email_is_generic: false, contact_page: '', store_type: 'Etsy',
          socials: {}, socialsUnverified: {}, status: 'OK', sslValid: true, loadSeconds: null,
          ageDays: null, score: 55, scoreReasons: ['Etsy shop — live listing check'],
          isPasswordProtected: false, hasCatalog: true }
        try {
          const v = await verifyStoreProducts(r.url, 'etsy', userQueue.keywords)
          r.nicheRequired = true
          r.nicheMatches = Math.max(v.matches, 0)
          r.nicheSamples = v.samples || []
          r.nicheVerified = !!v.pass
          if (!v.pass) { r.nicheNote = `${r.nicheMatches}/${NICHE_MIN_PRODUCT_MATCHES} matching listings found`; r.hasCatalog = false }
        } catch (e) { r.nicheRequired = true; r.nicheVerified = false; r.hasCatalog = false; r.nicheNote = 'listing check failed' }
        return r
      }))
      out.push(...chunkResults)
    }
    return out
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
  //  AI SITE HUNTER — finds brand-new websites built by AI website builders
  //  (Lovable, Framer, v0/Bolt, Durable, Hostinger AI, Wix AI...).
  //  Source: crt.sh Certificate Transparency logs — every new subdomain cert
  //  on a builder's free host is a fresh AI-built site. This module only
  //  READS public pages and public APIs (no logins, no posting anywhere).
  // ══════════════════════════════════════════════
  // TIER A: every site on the host gets its OWN certificate, so one crt.sh
  // wildcard query enumerates the zone's newest sites. TIER B: the builder
  // covers ALL customer sites with ONE wildcard cert — verified live, crt.sh
  // holds exactly one `*.framer.website` row and nothing else — so certificate
  // logs can NEVER list these sites, and discovery goes through urlscan's
  // recent-scan index instead (fetchUrlscanBuilderDomains below).
  const AI_HUNT_SOURCES = {
    lovable: { label: 'Lovable',         tier: 'A',   suffixes: ['lovable.app'] },
    framer:  { label: 'Framer',          tier: 'B',   suffixes: ['framer.website'] },
    durable: { label: 'Durable',         tier: 'B',   suffixes: ['durable.site'] },
    wix:     { label: 'Wix sites',       tier: 'B',   suffixes: ['wixsite.com'] },
    all:     { label: 'All AI builders', tier: 'A+B', suffixes: ['lovable.app', 'framer.website', 'durable.site', 'wixsite.com'] }
  }
  // vercel.app / netlify.app / pages.dev cert logs are enormous — only keep
  // subdomains that look like a real small business (keyword filter).
  // Same gate for the two HUGE free-host zones (framer.website gets ~600
  // scans/4d, wixsite.com ~3300 — mostly phishing; the keywords cut that
  // noise before we spend a fetch on it). durable.site stays UNGATED: its
  // whole zone is ~30 scans/4d and its site slugs (alisayurkinaperformance)
  // rarely contain niche words — the classifier handles quality there.
  // lovable.app also ungated (small zone, high hit rate).
  const AI_HUNT_BIG_HOSTS = ['vercel.app', 'netlify.app', 'pages.dev', 'framer.website', 'wixsite.com']
  const AI_HUNT_KEYWORDS = ['roof','dental','law','plumb','agency','salon','clinic','landscap','clean','fitness','gym',
    'restaurant','bakery','cafe','coffee','food','realty','estate','coach','consult','repair','detail','movers','moving','pest','hvac',
    'electric','photo','wedding','tutor','account','insur','mortgage','chiro','therapy','spa','barber','auto',
    'studio','shop','store','care','homes','build','design','market','hotel','travel','yoga','nails','hair','fashion','beauty','event']

  // Subdomain zones where the host alone proves the builder. Values are
  // objects now (name + category + confidence) — wixsite.com sites are
  // no-code template sites, NOT AI builds, and must be labelled as such.
  const AI_SUBDOMAIN_BUILDERS = {
    'lovable.app':    { name: 'Lovable', category: 'AI_BUILDER', conf: 0.99 },
    'framer.website': { name: 'Framer',  category: 'AI_BUILDER', conf: 0.99 },
    'durable.site':   { name: 'Durable', category: 'AI_BUILDER', conf: 0.95 },
    'wixsite.com':    { name: 'Wix',     category: 'NO_CODE',    conf: 0.95 },
  }
  const AI_BUILDER_MARKERS = [
    { builder: 'Lovable',      category: 'AI_BUILDER', conf: 0.9,  tests: [/lovable-uploads\//i, /lovable-logo-mono/i] },
    { builder: 'Framer',       category: 'AI_BUILDER', conf: 0.9,  tests: [/framerusercontent\.com/i, /data-framer-/i] },
    { builder: 'Durable',      category: 'AI_BUILDER', conf: 0.9,  tests: [/cdn\.durable\.co/i, /<meta[^>]+generator[^>]+durable/i] },
    { builder: 'Hostinger AI', category: 'AI_BUILDER', conf: 0.85, tests: [/<meta[^>]+name=["']generator["'][^>]*hostinger/i] },
    { builder: 'Wix',          category: 'NO_CODE',    conf: 0.9,  tests: [/static\.wixstatic\.com/i, /<meta[^>]+generator[^>]+wix\.com/i] },
    { builder: 'Webflow',      category: 'NO_CODE',    conf: 0.9,  tests: [/cdn\.prod\.website-files\.com/i, /data-wf-page/i] },
    { builder: 'Squarespace',  category: 'NO_CODE',    conf: 0.9,  tests: [/static1\.squarespace\.com/i, /assets\.squarespace\.com/i, /squarespace\.com\/assets/i] },
  ]
  // Builder "site missing" pages — urlscan indexes plenty of taken-down
  // free-host sites (verified live: whole recent Framer/Wix result pages were
  // these). They carry no builder markers, but the title check is cheaper
  // than marker scanning and gives a cleaner "dead" verdict.
  const AI_DEAD_TITLES = [
    /^site not found\s*\|\s*framer/i,
    /^404 error:\s*page not found\s*\|\s*wix/i,
    /^page not found/i,
    /^site (not found|unavailable|suspended)/i,
  ]
  // "AI wrote this" copy heuristics — each match counts once (spec §5.2).
  const AI_COPY_PATTERNS = [
    /in today's fast-paced/i, /we pride ourselves on/i, /our journey began/i,
    /look no further/i, /elevate your/i, /seamless(?:ly)?/i, /game.?chang(?:er|ing)/i,
    /your one-stop/i, /whether you're a/i, /cutting-edge (?:solutions|technology)/i,
    /at .{2,30}, we believe/i, /unparalleled/i, /delve into/i,
    /transform(?:ing)? the way you/i, /a game-changer/i, /changed my business/i
  ]

  function aiDomainAllowed(host) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(host) || host.includes('..')) return false
    const big = AI_HUNT_BIG_HOSTS.find(s => host === s || host.endsWith('.' + s))
    if (!big) return true   // lovable.app: every subdomain is an AI-built site
    const sub = host.slice(0, -(big.length + 1))
    return !!sub && AI_HUNT_KEYWORDS.some(k => sub.includes(k))
  }

  function huntCountButtons(srcKey, tier, mode = 'business') {
    const countRow = tier === 'daily'   ? [[B(`🎁 Free hunt (${DAILY_RESULT_CAP})`, `huntgo:${srcKey}:${DAILY_RESULT_CAP}`)]]
                   : tier === 'onetime' ? [[B(`🎁 Free hunt (${FREE_RESULT_CAP})`, `huntgo:${srcKey}:${FREE_RESULT_CAP}`)]]
                   : [[B('10', `huntgo:${srcKey}:10`), B('20', `huntgo:${srcKey}:20`), B('50', `huntgo:${srcKey}:50`)]]
    return [...countRow, [
      B(mode === 'business' ? '🏢 Business sites only ✅' : '🏢 Business sites only', 'huntmode:business'),
      B(mode === 'all' ? '🌐 Show everything ✅' : '🌐 Show everything', 'huntmode:all')
    ]]
  }

  // Per-user AI Hunter filter mode — 'business' (default) drops developer
  // portfolios/demos/side projects; 'all' shows everything, tagged.
  async function getHuntMode(userId) {
    try {
      const { result } = await redis('GET', `hunt:mode:${userId}`)
      return result === 'all' ? 'all' : 'business'
    } catch { return 'business' }
  }

  // Newest certs for one builder suffix (TIER A only). Returns null on
  // failure (crt.sh 502s are normal under load — 3 attempts, growing
  // backoff), [] when genuinely empty. Uses the same CRTSH_RELAY_URL relay
  // as the store-age lookups when set.
  async function fetchCrtshNewestDomains(suffix, limit = 200) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${CRTSH_BASE}?q=${encodeURIComponent('%.' + suffix)}&output=json`,
          { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AIHunter/1.0' } })
        if (!r.ok) { if (attempt < 2) await new Promise(r2 => setTimeout(r2, attempt ? 10000 : 4000)); continue }
        const rows = await r.json()
        const newest = new Map()
        for (const row of rows || []) {
          const nb = Date.parse(row.not_before || '') || 0
          for (let n of String(row.name_value || row.common_name || '').split('\n')) {
            n = n.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
            if (!n.endsWith('.' + suffix) || !aiDomainAllowed(n)) continue
            if (nb >= (newest.get(n) || 0)) newest.set(n, nb)
          }
        }
        return [...newest.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
          .map(([domain, notBefore]) => ({ domain, notBefore }))
      } catch (e) {
        if (attempt < 2) await new Promise(r2 => setTimeout(r2, attempt ? 10000 : 4000))
      }
    }
    return null
  }

  // TIER B discovery — urlscan's index of recent public scans. These builder
  // zones sit behind a single wildcard certificate, so crt.sh can't enumerate
  // them (verified live: crt.sh holds exactly one `*.framer.website` row).
  // Two things this query must keep, both verified live today:
  //   1. page.status:200 — without it the pool is dominated by taken-down
  //      phishing/stub pages that will just burn the fetch stage.
  //   2. the FULL page.url, not just the domain — Wix free sites live at a
  //      PATH (sub.wixsite.com/mysite); the bare subdomain root 404s.
  // Same shape as the crt.sh pool: { domain, notBefore } plus url.
  async function fetchUrlscanBuilderDomains(suffix, limit = 200) {
    const to = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10)
    const query = `page.domain:${suffix} AND page.status:200 AND date:[${from} TO ${to}]`
    const found = new Map()   // domain -> { domain, url, notBefore }
    let searchAfter = null
    for (let page = 0; page < 4 && found.size < limit; page++) {
      const data = await fetchUrlscanPage(query, searchAfter)
      if (!data) break
      const items = data.results || []
      if (!items.length) break
      for (const item of items) {
        const pageUrl = String(item.page?.url || '')
        const m = pageUrl.match(/^https?:\/\/([^/]+)/i)
        if (!m) continue
        const host = m[1].toLowerCase().replace(/^www\./, '')
        // Builder-internal preview/staging subdomains (verified live:
        // *.preview.durable.site is Durable's own test bench) are never leads.
        if (/(^|\.)preview\./.test(host)) continue
        if (!host.endsWith('.' + suffix) || !aiDomainAllowed(host)) continue
        const t = Date.parse(item.task?.time || '') || 0
        const prev = found.get(host)
        if (!prev || t > prev.notBefore) found.set(host, { domain: host, url: pageUrl, notBefore: t })
      }
      const last = items[items.length - 1]
      if (!last?.sort || items.length < 100) break
      searchAfter = last.sort.join(',')
    }
    return [...found.values()].sort((a, b) => b.notBefore - a.notBefore).slice(0, limit)
  }

  function htmlToVisibleText(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function aiCopyScore(text) {
    const words = Math.max(1, text.split(' ').filter(Boolean).length)
    let hits = 0
    for (const p of AI_COPY_PATTERNS) if (p.test(text)) hits++
    return Math.min(40, Math.round((hits / (words / 100)) * 25))
  }

  function detectAiBuilder(host, html) {
    for (const [suffix, info] of Object.entries(AI_SUBDOMAIN_BUILDERS)) {
      if (host === suffix || host.endsWith('.' + suffix)) return { builder: info.name, confidence: info.conf, category: info.category }
    }
    for (const m of AI_BUILDER_MARKERS) {
      if (m.tests.some(t => t.test(html))) return { builder: m.builder, confidence: m.conf, category: m.category }
    }
    return null
  }

  // ── Business vs developer/portfolio classifier (rules only, no extra
  // network calls). Decides lead_kind for the 🏢 Business-sites-only toggle.
  // DEV_HOST_SEGMENTS are matched as EXACT hyphen/dot segments of the
  // subdomain label — "dev" must not match "devonplumbing".
  const AI_DEV_HOST_SEGMENTS = ['portfolio', 'demo', 'test', 'clone', 'playground', 'sandbox', 'staging', 'dev', 'v1', 'v2', 'v3', 'copy', 'backup', 'template', 'my', 'site']
  const AI_DEV_TEXT_SIGNALS = [
    ['portfolio',            /portfolio/i],
    ['developer wording',    /\b(software|web|front.?end|back.?end|full.?stack)\s+(engineer|developer)\b/i],
    ['"hire me"',            /\bhire me\b/i],
    ['resume / CV',          /\bmy (resume|cv)\b|download my (resume|cv)/i],
    ['side project',         /\bside project\b|\bhackathon\b/i],
    ['"built with" credit',  /built with (lovable|bolt|v0|framer|durable|wix|wordpress)/i],
    ['demo/test notice',     /this is a (demo|test|sample)|sample (project|site)|\bplayground\b/i],
    ['placeholder text',     /lorem ipsum/i],
    ['placeholder names',    /\b(john|jane) doe\b|\bacme (corp|inc|llc|company)\b|\byour (company|business) name\b/i],
    ['example.com email',    /@(example\.com|example\.org|test\.com)\b/i],
    ['github link',          /(www\.)?github\.com\//i],
  ]
  const AI_BIZ_TEXT_SIGNALS = [
    ['phone (tel: link)',    /href=["']tel:/i],
    ['prices',               /[$\u00a3\u20ac]\s?\d|\b\d{1,3}(?:[.,]\d{3})+\s?(?:\u20ac|USD|EUR|GBP)\b/i],
    ['booking widget',       /calendly\.com|booksy\.|squareup\.com\/appointments|acuityscheduling|setmore|simplybook/i],
    ['street address',       /\b(street|road|avenue|suite|boulevard|blvd|lane)\b/i],
    ['opening hours',        /opening hours|business hours|\bmon(day)?\s*[-\u2013]\s*(fri|sat|sun)/i],
    ['contact page',         /href=["'][^"']*contact[^"']*["']/i],
  ]

  function classifySiteKind(host, html) {
    const label = (host.split('.')[0] || '').toLowerCase()
    const segments = label.split(/[-_.]/)
    const text = htmlToVisibleText(html).slice(0, 8000)
    const raw = html.slice(0, 150000)
    const dev = [], biz = []
    for (const [name, rx] of AI_DEV_TEXT_SIGNALS) if (rx.test(raw) || rx.test(text)) dev.push(name)
    for (const [name, rx] of AI_BIZ_TEXT_SIGNALS) if (rx.test(raw) || rx.test(text)) biz.push(name)
    for (const w of AI_DEV_HOST_SEGMENTS) {
      if (segments.includes(w)) { dev.push(`"${w}" in the site address`); break }
    }
    if (AI_HUNT_KEYWORDS.some(k => label.includes(k))) biz.push('business niche in the site address')
    const internalLinks = new Set(raw.match(/href=["']\/[a-z0-9][a-z0-9\-/]{0,40}["']/gi) || [])
    if (!biz.length && internalLinks.size < 3) dev.push('single-page site with no business signals')
    let kind = 'UNCERTAIN'
    if (dev.length >= 2) kind = 'DEVELOPER'
    else if (biz.length >= 2) kind = 'REAL_BUSINESS'
    return { kind, dev, biz }
  }

  function aiSiteWeaknesses(html) {
    const w = []
    if (/lovable-logo-mono/i.test(html)) w.push("default Lovable logo still in place")
    if (!/<meta[^>]+name=["']description["']/i.test(html)) w.push('no meta description')
    const tm = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    const title = tm ? tm[1].trim() : ''
    if (!title || /^(home|index|welcome|untitled|new (site|website|project))$/i.test(title)) w.push(`generic title tag${title ? ` ('${title}')` : ''}`)
    const internalLinks = new Set(html.match(/href=["']\/[a-z0-9][a-z0-9\-/]{0,40}["']/gi) || [])
    if (internalLinks.size < 3) w.push('single-page site (no real pages/nav)')
    if (/your[._-]?email@example\.com|lorem ipsum/i.test(html)) w.push('placeholder content left behind')
    return w
  }

  // Free, key-less RDAP fallback for the domain owner's email (custom domains
  // only — registrars often redact, so this is a fallback, never primary).
  async function rdapEmail(domain) {
    try {
      const r = await fetch(`https://rdap.org/domain/${domain}`,
        { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/rdap+json' } })
      if (!r.ok) return null
      const data = await r.json()
      for (const ent of data.entities || []) {
        if (!(ent.roles || []).some(x => ['registrant', 'administrative', 'abuse', 'technical'].includes(x))) continue
        for (const item of ent.vcardArray?.[1] || []) {
          if (item[0] === 'email' && item[3]) return String(item[3])
        }
      }
    } catch {}
    return null
  }

  // Full single-site pass: fetch homepage raw HTML -> fingerprint the builder,
  // score the copy for "AI wrote this", pull contacts (homepage -> contact
  // pages -> socials -> RDAP), and list pitchable weaknesses.
  // certMs (optional) = the discovery timestamp (cert not_before / urlscan
  // scan time) — shown on the lead card as 🆕 date so you can see how new it is.
  async function analyzeAiSite(url, certMs = 0) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
    const out = { url, host, status: 'dead', builder: null, confidence: 0, category: 'HUMAN',
      ai_score: 0, emails: [], socials: {}, formUrl: '', weaknesses: [], title: '',
      kind: 'UNCERTAIN', kindWhy: null, certDate: certMs ? new Date(certMs).toISOString().slice(0, 10) : '' }
    let html = ''
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' } })
      if (![200, 401, 403].includes(r.status)) return out
      html = (await r.text()).slice(0, 500000)
      out.status = 'OK'
    } catch { return out }

    const tm = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    out.title = tm ? tm[1].trim().slice(0, 60) : ''
    // Taken-down builder pages ("Site Not Found | Framer", Wix 404 stubs —
    // both seen live in urlscan's index) return HTTP 200 but are dead ends:
    // stop here before wasting contact-page fetches on them.
    if (AI_DEAD_TITLES.some(rx => rx.test(out.title))) return out
    const copyPts = aiCopyScore(htmlToVisibleText(html))
    const det = detectAiBuilder(host, html)
    if (det) {
      out.builder = det.builder; out.confidence = det.conf; out.category = det.category
      out.ai_score = Math.min(100, 60 + copyPts)
    } else {
      out.ai_score = copyPts
      // No stable v0/Bolt marker — Next.js signals + high AI-copy = heuristic hit.
      if ((html.includes('/_next/') || html.includes('__next')) && copyPts >= 40) {
        out.builder = 'v0/Bolt?'; out.confidence = 0.5; out.category = 'LIKELY_AI'
      }
    }
    out.weaknesses = aiSiteWeaknesses(html)
    const kind = classifySiteKind(host, html)
    out.kind = kind.kind
    out.kindWhy = { dev: kind.dev, biz: kind.biz }

    // Contacts, in priority order: inline emails -> contact pages -> socials -> RDAP.
    out.emails = [...new Set(cleanEmails(html))].slice(0, 3)
    out.socials = extractSocials(html)
    if (!out.emails.length) {
      // Keep the original path when the site lives at one (Wix free sites:
      // sub.wixsite.com/mysite — probing /contact at the bare host 404s).
      const base = url.replace(/\/$/, '')
      const pages = await Promise.all(['/contact', '/contact-us', '/about'].map(async p => {
        try {
          const r2 = await fetch(base + p, { signal: AbortSignal.timeout(5000), redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0' } })
          if (!r2.ok) return null
          const h2 = (await r2.text()).slice(0, 300000)
          return { url: base + p, emails: cleanEmails(h2), socials: extractSocials(h2), hasForm: /<form[\s>]/i.test(h2) }
        } catch { return null }
      }))
      for (const pg of pages.filter(Boolean)) {
        if (pg.emails.length && !out.emails.length) out.emails = [...new Set(pg.emails)].slice(0, 3)
        if (!out.formUrl && pg.hasForm) out.formUrl = pg.url
        out.socials = { ...out.socials, ...pg.socials }
      }
      const isBuilderSub = Object.keys(AI_SUBDOMAIN_BUILDERS).some(s => host.endsWith('.' + s)) ||
        AI_HUNT_BIG_HOSTS.some(s => host.endsWith('.' + s))
      if (!out.emails.length && !isBuilderSub) {
        const rdap = await rdapEmail(host)
        if (rdap) out.emails = [rdap]
      }
    }
    if (!out.formUrl && !out.emails.length && /<form[\s>]/i.test(html)) out.formUrl = url
    const svAi = await validateSocials(out.socials)
    out.socials = svAi.verified
    out.socialsUnverified = svAi.unverified
    return out
  }

  const KIND_TAGS = { REAL_BUSINESS: '🏢 real business', DEVELOPER: '👨‍💻 developer/portfolio', UNCERTAIN: '❔ unclear' }

  function aiLeadCard(lead, idx, showWhy = false) {
    const contactBits = []
    if (lead.emails.length) contactBits.push(`📧 ${lead.emails.join(', ')}`)
    const socialBits = Object.entries(lead.socials || {}).map(([k, v]) => `${k}: ${v}`)
    if (socialBits.length) contactBits.push(`💬 ${socialBits.join(' · ')}`)
    if (lead.formUrl) contactBits.push(`📝 form: ${lead.formUrl}`)
    const conf = lead.confidence ? ` (conf ${lead.confidence.toFixed(2)})` : ''
    const kindTag = KIND_TAGS[lead.kind] || ''
    const whyLines = []
    if (showWhy && lead.kindWhy) {
      if (lead.kindWhy.dev.length) whyLines.push(`why dev: ${lead.kindWhy.dev.join(', ')}`)
      if (lead.kindWhy.biz.length) whyLines.push(`why business: ${lead.kindWhy.biz.join(', ')}`)
    }
    return `${idx}. 🔗 ${lead.url}` +
      (lead.title ? `\n    🏷️ ${lead.title}` : '') +
      `\n    🛠 ${lead.builder || 'unknown'}${conf} · ai_score: ${lead.ai_score}` +
      (kindTag ? ` · ${kindTag}` : '') +
      (lead.certDate ? `\n    🆕 spotted: ${lead.certDate}` : '') +
      `\n    ${contactBits.length ? contactBits.join('\n    ') : '⚠️ no public contact found'}` +
      (lead.weaknesses.length ? `\n    ⚠️ Weak: ${lead.weaknesses.join('; ')}` : '') +
      whyLines.map(w => `\n    ℹ️ ${w}`).join('')
  }

  async function startAiHunt(chatId, userId, srcKey, want) {
    const src = AI_HUNT_SOURCES[srcKey]
    if (!src) { await send(chatId, 'Unknown builder — pick one from the 🤖 AI-Built Sites menu.'); return res.status(200).send('OK') }
    const mode = await getHuntMode(userId)
    await send(chatId,
      `🤖 AI Site Hunter — ${src.label}\n\n` +
      `Scanning the newest ${src.tier === 'A' ? 'certificate records' : 'public scans'} for fresh ${src.label} sites, then opening each one live: ` +
      `builder check, AI-copy score, contacts, weaknesses. Hunting for ${want} lead${want === 1 ? '' : 's'}\n` +
      `Filter: ${mode === 'business' ? '🏢 business sites only (tap 🌐 in the hunt menu to include developers)' : '🌐 everything, developer sites tagged'}.\n\n` +
      `⏱️ Give it a few minutes — if the time budget cuts me short, send anything and I'll keep hunting.`)
    // Per-zone fetch with cross-fallback: crt.sh zones fall back to urlscan
    // when crt.sh 502s (it does that a lot), and urlscan zones fall back to
    // crt.sh when the recent-scan window is dry. A dead source never kills the run.
    const pools = await Promise.all(src.suffixes.map(async s => {
      if (src.tier === 'A') {
        const crt = await fetchCrtshNewestDomains(s, 200)
        if (crt) return crt
        return await fetchUrlscanBuilderDomains(s, 200)
      }
      const us = await fetchUrlscanBuilderDomains(s, 200)
      if (us && us.length) return us
      return await fetchCrtshNewestDomains(s, 200) || []
    }))
    if (pools.every(p => p === null || (Array.isArray(p) && !p.length))) {
      await send(chatId, `Nothing found right now — the discovery sources (crt.sh / urlscan) are overloaded or the zone is quiet. Try again in a few minutes.`)
      return res.status(200).send('OK')
    }
    const byDom = new Map()
    for (const c of pools.filter(Boolean).flat()) {
      const prev = byDom.get(c.domain)
      if (!prev || c.notBefore > prev.notBefore) byDom.set(c.domain, c)
    }
    let candidates = [...byDom.values()].sort((a, b) => b.notBefore - a.notBefore)
    // Freshness cut: a lead card is only worth pitching while it's new. Only
    // applied when it still leaves enough candidates to work with, so a quiet
    // week on a small zone doesn't zero out the run.
    const maxCertAgeMs = (parseInt(process.env.HUNT_MAX_CERT_AGE_DAYS) || 14) * 86400000
    const freshCut = candidates.filter(c => !c.notBefore || (Date.now() - c.notBefore) <= maxCertAgeMs)
    if (freshCut.length >= Math.min(30, want * 2)) candidates = freshCut
    const seenMap = await getSeenBatch(candidates.map(c => `ai:${c.domain}`))
    candidates = candidates.filter(c => !seenMap[`ai:${c.domain}`]).slice(0, 300)
    if (!candidates.length) {
      await send(chatId, `✓ The newest sites in this pool are all ones you've already received. Nothing new right now — try again later.`)
      return res.status(200).send('OK')
    }
    const q = await getUserQueue(userId)
    q.aiHunt = { srcKey, label: src.label, want, mode, candidates, results: [], delivered: 0, done: false }
    await saveUserQueue(userId, q)
    return await runAiHuntBatch(chatId, userId, q)
  }

  // Same persistent-hunter pattern as /scout: check batches until `want` live
  // leads are found, the candidate pool runs dry, or the ~40s invocation
  // budget runs out (then one ping continues exactly where it stopped).
  async function runAiHuntBatch(chatId, userId, userQueue) {
    const h = userQueue.aiHunt
    if (!h) return res.status(200).send('OK')
    const deadline = Date.now() + 40000
    // Business mode: developer/portfolio leads don't count toward `want` and
    // are never delivered — but they're still checked, counted and skipped
    // loudly so you know the filter is alive.
    const isSkippedDev = r => h.mode === 'business' && r.kind === 'DEVELOPER'
    const goodSoFar = () => h.results.filter(r => r.status === 'OK' && r.builder && !isSkippedDev(r))
    while (Date.now() < deadline && h.candidates.length && goodSoFar().length < h.want) {
      const chunk = h.candidates.splice(0, CONCURRENCY)
      const results = await Promise.all(chunk.map(c => analyzeAiSite(c.url || `https://${c.domain}`, c.notBefore || 0)))
      h.results.push(...results)
      await markSeenBatch(chunk.map((c, i) => [`ai:${c.domain}`, { status: results[i].status, builder: results[i].builder || '', checkedAt: new Date().toISOString() }]))
      await saveUserQueue(userId, userQueue)
    }
    const live = goodSoFar()
    const fresh = live.slice(h.delivered)
    const prevDelivered = h.delivered
    h.delivered = live.length
    h.done = live.length >= h.want || !h.candidates.length
    const skippedDev = h.results.filter(r => r.status === 'OK' && r.builder && isSkippedDev(r)).length

    let header
    if (live.length >= h.want) header = `✅ ALL DONE — ${live.length} AI-built sites as requested (${h.label}), checked ${h.results.length} new domains to find them.`
    else if (!h.candidates.length) header = `✓ Pool finished — ${live.length} live AI-built sites of ${h.results.length} new domains checked (${h.label}).`
    else header = `⏳ ${live.length} of ${h.want} so far (checked ${h.results.length}) — send anything and I'll keep hunting.`
    if (h.mode === 'business' && skippedDev > 0) {
      header += `\n🏢 Skipped ${skippedDev} developer/portfolio site${skippedDev === 1 ? '' : 's'} — tap 🌐 Show everything in the hunt menu to include them.`
    }

    let reply = header
    let n = prevDelivered
    for (const r of fresh) { n++; reply += `\n\n${aiLeadCard(r, n)}` }
    if (h.done) reply += `\n\n────────\n🔬 Deep-check any single site with /check <url>`
    await saveUserQueue(userId, userQueue)
    await send(chatId, reply)
    return res.status(200).send('OK')
  }

  // /check <url> — deep single-site report: builder, AI-copy score, contacts,
  // weaknesses, a likely-prompt guess and a ready pitch hook.
  async function sendAiSiteReport(chatId, rawUrl) {
    let url = String(rawUrl || '').trim().split(/\s/)[0]
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url
    if (!/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) {
      await send(chatId, `That doesn't look like a URL — send e.g. https://some-site.com`)
      return
    }
    await send(chatId, `🔬 Deep-checking ${url} — fingerprint, AI-copy score, contacts...`)
    const lead = await analyzeAiSite(url)
    if (lead.status !== 'OK') { await send(chatId, `❌ Couldn't reach that site (down, blocking, or not a real site).`); return }
    const verdict =
      lead.category === 'AI_BUILDER' ? `✅ Built with ${lead.builder} (AI builder)` :
      lead.category === 'NO_CODE'    ? `🧩 Built with ${lead.builder} (no-code — pitch a redesign, not "your site looks AI")` :
      lead.category === 'LIKELY_AI'  ? `🤔 Likely AI-built (${lead.builder})` :
                                       `👤 Looks hand-built (no AI-builder markers, low AI-copy score)`
    const kindLine =
      lead.kind === 'REAL_BUSINESS' ? `🏢 Classified: real business site` :
      lead.kind === 'DEVELOPER'     ? `👨‍💻 Classified: developer/portfolio site` :
                                      `❔ Classified: unclear (not enough signals either way)`
    const promptGuess = lead.title ? `"a website for ${lead.title.toLowerCase()}"` : '—'
    const pitchHook = lead.weaknesses.length
      ? `their site ${lead.weaknesses[0]}${lead.weaknesses[1] ? ' and ' + lead.weaknesses[1] : ''} — easy wins to offer.`
      : 'no obvious placeholder weaknesses spotted — lead with speed/SEO instead.'
    await send(chatId,
      `🔬 Deep check — ${lead.host}\n\n` +
      `${verdict}\n` +
      `${kindLine}\n` +
      `Confidence: ${lead.confidence ? lead.confidence.toFixed(2) : '—'} · AI-copy score: ${lead.ai_score}/100\n\n` +
      `${aiLeadCard(lead, 1, true).replace(/^1\. /, '')}\n\n` +
      `💬 Likely prompt: ${promptGuess}\n` +
      `💡 Pitch hook: ${pitchHook}`)
  }

  // ── URLSCAN.IO ──
  async function fetchUrlscanPage(query, searchAfter) {
    let apiUrl = `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=100`
    if (searchAfter) apiUrl += `&search_after=${searchAfter}`
    // Date-filtered queries run slower on urlscan's side — 12s cap + one
    // retry. The old 5s cap silently killed every month-filtered search.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 12000)
        const r = await fetch(apiUrl, { signal: controller.signal })
        clearTimeout(t)
        if (!r.ok) return null
        return await r.json()
      } catch (e) { /* retry once, then give up */ }
    }
    return null
  }

  // Does a checked store pass the user's reachability + freshness filters?
  // v6 strictness: a required social platform is only satisfied by a VERIFIED
  // live link (dead and login-walled links never count), and a niche job only
  // counts stores whose deep product check passed (3+ matching products).
  function isUsableLead(r, includeLocked, freshDays, requiredSocial = null) {
    if (r.status !== 'OK') return false
    if (r.isPasswordProtected && !includeLocked) return false
    if (!(r.email !== 'no email' || r.contact_page || Object.keys(r.socials || {}).length || r.hasCatalog)) return false
    if (requiredSocial && !r.socials?.[requiredSocial]) return false
    if (r.nicheRequired && r.nicheVerified !== true) return false
    // Freshness: provably-over-the-limit is dropped; an unknown age can't be
    // proven old, so it stays (it just won't carry a 🎂 tag).
    if (freshDays && typeof r.ageDays === 'number' && r.ageDays > freshDays) return false
    return true
  }

  // Pull the next page of urlscan candidates into userQueue.pending.
  // v6: web-discovery sources (Etsy/BigCommerce/Squarespace/WooCommerce) pull
  // from DuckDuckGo/Bing instead of urlscan, and dedupe on the FULL URL so
  // etsy.com/shop/<name> shops don't all collapse onto one host key.
  // Returns true when more candidates were queued; false when the source is
  // exhausted OR the page fetch failed (the cursor is kept, so the next call
  // retries the same page instead of skipping it).
  function dedupeKeyFor(userQueue, url) {
    return (userQueue && userQueue.dedupeFull)
      ? String(url || '').toLowerCase().replace(/\/$/, '')
      : normalizeForDedupe(url)
  }
  async function pullNextCandidates(userQueue) {
    const ctx = userQueue.searchCtx
    if (!ctx || ctx.exhausted) return false
    if (ctx.kind === 'web') {
      // One search pass, then the pool is what it is — the persistent hunter
      // keeps working through the queue after this.
      ctx.exhausted = true
      const { results, blocked } = await webSearch(ctx.webQuery)
      if (blocked) ctx.note = 'web search engines blocked this run — retry shortly'
      const pageUrls = results.map(r => r.url)
      const extraBlacklistSet = await getExtraBlacklistSet()
      const { cleaned } = partitionLeads(pageUrls, extraBlacklistSet)
      const seenMap = await getSeenBatch(cleaned.map(u => dedupeKeyFor(userQueue, u)))
      const alreadyQueued = new Set(userQueue.pending)
      let added = 0
      for (const u of cleaned) {
        const key = dedupeKeyFor(userQueue, u)
        if (!seenMap[key] && !alreadyQueued.has(u)) {
          userQueue.pending.push(u)
          alreadyQueued.add(u)
          added++
        }
      }
      return added > 0
    }
    const data = await fetchUrlscanPage(ctx.query, ctx.searchAfter)
    if (!data) return false
    if (ctx.total == null && typeof data.total === 'number') ctx.total = data.total
    const items = data.results || []
    if (!items.length) { ctx.exhausted = true; return false }
    const pageUrls = []
    for (const item of items) {
      const domain = item.page?.domain
      const url = domain ? `https://${domain}` : (item.page?.url || item.task?.url)
      if (url) pageUrls.push(url)
    }
    const extraBlacklistSet = await getExtraBlacklistSet()
    const { cleaned } = partitionLeads(pageUrls, extraBlacklistSet)
    const seenMap = await getSeenBatch(cleaned.map(u => dedupeKeyFor(userQueue, u)))
    const alreadyQueued = new Set(userQueue.pending)
    for (const u of cleaned) {
      const key = dedupeKeyFor(userQueue, u)
      if (!seenMap[key] && !alreadyQueued.has(u)) {
        userQueue.pending.push(u)
        alreadyQueued.add(u)
      }
    }
    const last = items[items.length - 1]
    if (last?.sort) ctx.searchAfter = last.sort.join(',')
    else ctx.exhausted = true
    if (items.length < 100) ctx.exhausted = true
    return true
  }

  // Window length in days for the /scout age gate — from a custom range
  // (inclusive) or one of the month-picker presets. null = no computable window.
  function scoutWindowDays(dateRange, month) {
    if (dateRange && dateRange.from && dateRange.to) {
      const days = Math.round((Date.parse(dateRange.to + 'T00:00:00Z') - Date.parse(dateRange.from + 'T00:00:00Z')) / 86400000) + 1
      return days >= 1 ? days : null
    }
    if (month === 'last7') return 7
    if (month === 'last14') return 14
    if (month === 'last30') return 30
    if (month === 'thismonth') return Math.min(30, new Date().getUTCDate())
    return null
  }

  async function startScoutJob(chatId, userId, query, label, wantCount, includeLocked, month = null, freshDays = null, dateRange = null, requiredSocial = null, ageGate = false, storeCtx = null) {
    const scope = dateRange ? dateRangeLabel(dateRange) : ymLabel(month)
    const ageNote = ageGate && freshDays ? ` · 🎂 store age ≤${freshDays}d ✅ enforced` : ''
    const nicheNote = storeCtx?.niche ? `\n🧾 Deep product check: I open every store's LIVE catalog and only count stores with 3+ real ${storeCtx.customNiche ? `"${storeCtx.customNiche}"` : (NICHE_LABELS[storeCtx.niche] || 'niche')} products — name matches alone never count.` : ''
    await send(chatId, `🔍 Hunting for ${wantCount} leads — "${label}" (${scope}${freshDays ? `, ≤${freshDays}d old` : ''}${ageNote}${requiredSocial ? `, must have a VERIFIED ${requiredSocial === 'x' ? 'X' : requiredSocial[0].toUpperCase() + requiredSocial.slice(1)}` : ''})...${nicheNote}\n\n` +
      `⏱️ This can take several minutes: I keep pulling stores and checking each one live — age, email, socials, page speed — ` +
      `until I have ${wantCount} that pass your filters. If a run's time budget cuts me short, send anything and I'll pick up exactly where I stopped.`)
    const isWebDiscovery = !!(storeCtx && storeCtx.webQuery)
    const searchCtx = isWebDiscovery
      ? { kind: 'web', webQuery: storeCtx.webQuery, exhausted: false }
      : { query: applyScoutDateFilter(query, month, dateRange), searchAfter: null, exhausted: false, total: null }
    const userQueue = {
      pending: [], results: [], delivered: 0, done: false,
      awaitingMessages: false, messages: [], awaitingCustomQuery: false,
      label: label || '', includeLocked: !!includeLocked,
      wantCount, freshDays, requiredSocial, ageGate: !!ageGate,
      niche: storeCtx?.niche || null, customNiche: storeCtx?.customNiche || null,
      keywords: storeCtx?.keywords || null, platform: storeCtx?.platform || null,
      dedupeFull: isWebDiscovery,
      searchCtx
    }
    await saveUserQueue(userId, userQueue)
    return await runBatch(chatId, userId, userQueue)
  }

  async function startBatchJob(chatId, userId, rawLinks, sourceLabel, poolSet, scanTimes, includeLocked, wantCount = 0, freshDays = null) {
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
    const userQueue = {
      pending: newLinks, results: [], delivered: 0, done: false,
      awaitingMessages: false, messages: [], awaitingCustomQuery: false,
      label: sourceLabel || '', includeLocked: !!includeLocked,
      wantCount, freshDays,
      searchCtx: null        // fixed list — nothing more to pull
    }
    await saveUserQueue(userId, userQueue)
    await send(chatId, `✓ ${sourceLabel}: found ${rawLinks.length} links (${alreadySeen} already seen, skipped).\n${newLinks.length} new to process.\n\n⏱️ Checking them now — results land as they pass your filters.`)
    return await runBatch(chatId, userId, userQueue)
  }

  // PERSISTENT HUNTER: keeps checking batches until `wantCount` leads PASS the
  // filters, the source is exhausted, or the run's time budget (~40s, one Vercel
  // invocation) runs out. On timeout it saves state and asks for one ping to
  // continue — and each store's age lookups now run in parallel, so one
  // invocation covers ~2 batches instead of dying mid-first-batch.
  async function runBatch(chatId, userId, userQueue) {
    const deadline = Date.now() + 40000
    const want = userQueue.wantCount || 0
    const freshDays = userQueue.freshDays || null
    const includeLocked = !!userQueue.includeLocked
    const requiredSocial = userQueue.requiredSocial || null

    while (Date.now() < deadline) {
      const usable = userQueue.results.filter(r => isUsableLead(r, includeLocked, freshDays, requiredSocial))
      if (want && usable.length >= want) break
      if (!userQueue.pending.length) {
        if (!(await pullNextCandidates(userQueue))) break
        await saveUserQueue(userId, userQueue)
        continue
      }
      const batch = userQueue.pending.slice(0, BATCH_SIZE)
      userQueue.pending = userQueue.pending.slice(BATCH_SIZE)
      const results = (userQueue.platform === 'etsy')
        ? await processEtsyBatch(batch, userQueue)
        : await processBatch(batch, userQueue)
      userQueue.results.push(...results)
      // v6: record every store dropped by the deep product check so /others
      // shows exactly why it wasn't counted.
      const nicheDropped = results.filter(r => r.status === 'OK' && r.nicheRequired && !r.nicheVerified)
        .map(r => `${r.url} — niche check failed: ${r.nicheNote || 'catalog did not match'}`)
      if (nicheDropped.length) await saveFilteredOut(userId, nicheDropped)
      // With the age gate on, record every provably-too-old store so /others
      // can show exactly what was dropped and why.
      const droppedOld = results.filter(r => freshDays && typeof r.ageDays === 'number' && r.ageDays > freshDays)
        .map(r => `${r.url} — store too old (${r.ageDays}d, window ${freshDays}d)`)
      if (droppedOld.length) await saveFilteredOut(userId, droppedOld)
      await markSeenBatch(results.map(r => [dedupeKeyFor(userQueue, r.url), { status: r.status, email: r.email, checkedAt: new Date().toISOString() }]))
      await saveUserQueue(userId, userQueue)
    }

    const usableAll = userQueue.results.filter(r => isUsableLead(r, includeLocked, freshDays, requiredSocial))
    const fresh = usableAll.slice(userQueue.delivered || 0).sort((a, b) => (b.score || 0) - (a.score || 0))
    const prevDelivered = (userQueue.delivered || 0)
    userQueue.delivered = usableAll.length

    const sourceExhausted = !userQueue.pending.length && (!userQueue.searchCtx || userQueue.searchCtx.exhausted)
    const reached = !!(want && usableAll.length >= want)
    userQueue.done = !!(reached || sourceExhausted)

    let header
    if (reached) header = `✅ ALL DONE — ${usableAll.length} leads as requested${freshDays ? ` (≤${freshDays}d old)` : ''}, checked ${userQueue.results.length} stores to find them.`
    else if (sourceExhausted) header = `✓ Source finished — ${usableAll.length} usable of ${userQueue.results.length} checked.`
    else header = `⏳ ${usableAll.length} of ${want} so far (checked ${userQueue.results.length}) — send anything and I'll keep hunting automatically.`
    if (userQueue.ageGate && freshDays) header += `\n🎂 Store age ≤ ${freshDays}d enforced — older stores dropped (see /others).`
    if (userQueue.niche) header += `\n🧾 Deep product check enforced — only stores with ${NICHE_MIN_PRODUCT_MATCHES}+ matching products counted${userQueue.platform === 'etsy' ? ' (Etsy: 3+ matching listings)' : ''}; see /others for the drops.`
    if (userQueue.searchCtx && userQueue.searchCtx.note) header += `\n⚠️ ${userQueue.searchCtx.note}`
    if (userQueue.searchCtx && userQueue.searchCtx.total != null && !sourceExhausted) header += `\n📊 ${userQueue.searchCtx.total} total matches in this window.`

    let reply = header
    let leadNum = prevDelivered
    for (const r of fresh) {
      leadNum++
      const nameLine = r.store_name ? `${r.store_name}\n    🔗 ${r.url}` : `🔗 ${r.url}`
      const socialsList = Object.entries(r.socials || {}).map(([k, v]) => `${k}: ${v}`).join('\n              ')
      const unverifiedList = Object.entries(r.socialsUnverified || {}).map(([k, v]) => `${k} (unverified): ${v}`).join('\n              ')
      const socialsNote = (socialsList || unverifiedList) ? `\n    💬 social: ${[socialsList, unverifiedList].filter(Boolean).join('\n              ')}` : ''
      const contactNote = r.contact_page ? `\n    🌐 contact page: ${r.contact_page}` : ''
      const genericNote = r.email_is_generic ? ' (generic)' : ''
      const emailNote = r.email !== 'no email' ? `\n    📧 ${r.email}${genericNote}` : ''
      const hotTag = r.score >= 70 ? ' 🔥' : ''
      const scoreNote = `\n    📊 score: ${r.score}${hotTag}` + (r.scoreReasons?.length ? ` (${r.scoreReasons.join(', ')})` : '')
      const ageNote = (typeof r.ageDays === 'number') ? `\n    🎂 age: ${r.ageDays}d${r.ageDays <= 30 ? ' 🔥' : ''}` : (userQueue.ageGate ? '\n    🎂 age unknown — no source could prove it' : '')
      const catalogNote = r.nicheRequired
        ? `\n    🧾 product check: ${r.nicheVerified ? `✅ ${r.nicheMatches} matching products in the live catalog` : `❌ dropped — ${r.nicheNote || 'catalog did not match'}`}` +
          (r.nicheVerified && r.nicheSamples?.length ? `\n    🏷️ e.g. ${r.nicheSamples.join(' · ')}` : '')
        : ''
      const platformNote = (r.store_type && r.nicheRequired) ? `\n    🏬 platform: ${r.catalog_platform || r.store_type}` : ''
      const countryNote = r.country && r.country.label ? `\n    🌍 ${r.country.label}` : ''
      const hook = auditHookLine(r)
      const hookNote = hook ? `\n    💡 ${hook}` : ''
      reply += `\n\n${leadNum}. ${nameLine}${scoreNote}${ageNote}${platformNote}${catalogNote}${countryNote}${hookNote}${socialsNote}${contactNote}${emailNote}`
    }
    if (!fresh.length && !userQueue.done) reply += `\n\n(The last batch didn't add any leads that pass your filters — still hunting.)`
    if (userQueue.done) reply += `\n\n────────\nSend anything to move to the message-writing step.`
    await saveUserQueue(userId, userQueue)
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
  const PUBLIC_CMDS = ['/start', '/menu', '/help', '/cancel', '/newuk', '/access', '/whoami']
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

  function screenFor(name, owner, hasAccessFlag, ukWebPref = 'all') {
    const go = (label, data) => hasAccessFlag ? B(label, data) : B('🔒 ' + label, 'locked')
    const nav = (back) => [B('⬅️ Back', back || 'menu:main'), B('🏠 Main menu', 'menu:main')]

    switch (name) {
      case 'uk': {
        const w = (mode, label) => B(ukWebPref === mode ? `${label} ✅` : label, `ukweb:${mode}`)
        return {
          text:
            `<b>🇬🇧 New UK Companies</b>\n\n` +
            `<b>What it does:</b> pulls brand-new companies straight from the official UK company register. Free and 100% real.\n\n` +
            `<b>Why it's useful:</b> a company this new has no suppliers, website or marketing yet — the perfect moment to pitch it.\n\n` +
            `<b>Website filter</b> (applies to every run until you change it):\n` +
            `🌐 With website only — every company is live-checked; only ones with a VERIFIED website are delivered\n` +
            `🚫 No website only — only companies where a full website search found nothing\n` +
            `📋 All companies — no website filtering\n\n` +
            `<b>Pick how far back to look</b> (results always match your exact date window):`,
          kb: [
            [B('📅 Today · 20', 'run:/newuk 1 20'), B('📅 3 days · 50', 'run:/newuk 3 50')],
            [B('📅 7 days · 100', 'run:/newuk 7 100'), B('📅 30 days · 100', 'run:/newuk 30 100')],
            [w('web', '🌐 With website only'), w('noweb', '🚫 No website only')],
            [w('all', '📋 All companies'), go('🕵️ Next step: find their contacts', 'menu:findco')],
            nav()
          ]
        }
      }
      case 'stores':
        return {
          text:
            `<b>🏪 Online Stores — every platform</b>\n\n` +
            `Find online stores on Shopify, Wix, Etsy, BigCommerce, Squarespace or WooCommerce.\n\n` +
            `<b>The strict part:</b> for EVERY platform I open each store's live product catalog and only count the store when <b>3+ real products</b> match your niche — checked on the products themselves (titles, types, tags, categories), never on the shop's name. A store named "Bloom & Co" selling 40 cosmetics passes the beauty niche; a name-only match with a food catalog doesn't.\n\n` +
            `<b>1️⃣</b> Pick a platform below\n<b>2️⃣</b> Pick the niche (or type your own)\n<b>3️⃣</b> Pick the date window + how many leads\n\n` +
            `Dead stores, wrong-niche catalogs and shops with fewer than 3 matching products are skipped automatically (see /others).`,
          kb: [
            [go('🛍️ Shopify', 'stplatform:shopify'), go('🌐 Wix', 'stplatform:wix')],
            [go('🧵 Etsy', 'stplatform:etsy'), go('🧱 BigCommerce', 'stplatform:bigcommerce')],
            [go('🎨 Squarespace', 'stplatform:squarespace'), go('🛒 WooCommerce', 'stplatform:woocommerce')],
            [go('🌍 Any builder (strict check)', 'stplatform:auto')],
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
      case 'aihunter':
        return {
          text:
            `<b>🤖 AI Site Hunter</b>\n\n` +
            `Finds brand-new websites built by AI builders (Lovable, Framer, Durable, Wix, v0/Bolt...) — ` +
            `their owners usually need a proper redesign, and you can pitch exactly that.\n\n` +
            `Each lead comes with: the builder it was made with, an AI-copy score, the owner's ` +
            `contact channels (email / socials / contact form), the site's weaknesses, and whether it's a ` +
            `<b>real business</b> or a developer's portfolio.\n\n` +
            `🏢 <b>Business filter</b> — every hunt keyboard has a 🏢/🌐 row: business-only mode silently skips ` +
            `developer portfolios, demos and side projects and tells you how many it skipped.\n\n` +
            `⚡ <b>Hunt</b> — scan the newest sources for fresh AI-built sites\n` +
            `🔬 <b>Check one site</b> — deep analysis of any URL: builder, confidence, contacts, weaknesses, likely prompt, pitch hook`,
          kb: [
            [go('⚡ Hunt Lovable sites', 'hunt:lovable')],
            [go('🖼 Hunt Framer sites', 'hunt:framer')],
            [go('🧱 Hunt Durable sites', 'hunt:durable')],
            [go('🎨 Hunt Wix sites', 'hunt:wix')],
            [go('🌐 Hunt ALL AI builders', 'hunt:all')],
            [go('🔬 Check one site', 'huntcheck')],
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
            `/hunt &lt;lovable|framer|durable|wix|all&gt; [count] — find AI-built websites (🏢 business-only toggle on every hunt screen)\n` +
            `/check &lt;url&gt; — deep-check one site (builder, contacts, weaknesses)\n` +
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
            [go('🏪 Online Stores (Wix, Etsy…)', 'menu:stores'), go('🤖 AI-Built Sites', 'menu:aihunter')],
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
  async function showScreen(chatId, messageId, name, owner, hasAccessFlag, ukWebPref) {
    await pushScreen(chatId, messageId, screenFor(name, owner, hasAccessFlag, ukWebPref))
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
    const open = (await openGiftList()).filter(g => !giftDismissed(g, userId))
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
        `Create a gift: prize (searches with a result cap, or a days-pass) → who gets it (everyone / first claim / quiz question) → optional personal message. Publishing DMs every known user with Answer/Claim and Decline buttons. Decline hides the gift only for that user. Winners get their prize by DM; you get a DM on every claim. For quiz gifts, open 📝 Attempts to read answers and 🏆 mark a winner by hand.\n\n` +
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
      ['hunt', '🤖 Hunt AI-built sites'], ['check', '🔬 Deep-check one site'],
      ['access', '💳 Get access / check status'], ['gift', '🎁 Open the gift box'],
      ['help', '❓ How this bot works'], ['cancel', '🧹 Stop what I\'m waiting for']
    ]
    const all = [
      ['start', '🏠 Open the main menu'], ['menu', '🏠 Main menu'], ['help', '❓ How this bot works'],
      ['newuk', '🇬🇧 New UK companies'], ['findco', '🕵️ Find contacts for companies'],
      ['find', '🗺️ Local businesses'], ['scout', '🛍️ Search Shopify stores'],
      ['hunt', '🤖 Hunt AI-built sites'], ['check', '🔬 Deep-check one site'],
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
      await showScreen(cbChat, cbMsg, screenName, isOwner, hasAccess, screenName === 'uk' ? await getUkWebPref(actorId) : undefined)
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

    if (d.startsWith('giftdecline:')) {
      const gid = d.slice('giftdecline:'.length)
      const ran = await withGiftLock(gid, async () => {
        const g = await getGift(gid)
        if (g && !giftDismissed(g, actorId)) {
          g.dismissed = g.dismissed || []
          g.dismissed.push(String(actorId))
          await saveGift(g)
        }
      })
      await tgCall('editMessageText', {
        chat_id: cbChat, message_id: cbMsg,
        text: ran ? '🎁 Gift declined. It is hidden only for you; nobody else is affected.' : 'Please tap Decline again in a moment.',
        reply_markup: { inline_keyboard: [[B('🎁 Other gifts', 'menu:gifts'), B('🏠 Main menu', 'menu:main')]] }
      })
      await answerCb(cq.id, ran ? 'Gift dismissed for you.' : 'Try again in a moment.')
      return res.status(200).send('OK')
    }

    if (d.startsWith('giftclaim:')) {
      await answerCb(cq.id)
      await claimGift(cbChat, actorId, d.slice('giftclaim:'.length))
      return res.status(200).send('OK')
    }

    if (d.startsWith('giftans:')) {
      await answerCb(cq.id)
      const gid = d.slice('giftans:'.length)
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
        await withGiftLock(gid, async () => {
          const g = await getGift(gid)
          if (g) { g.status = 'closed'; await saveGift(g) }
        })
        await pushScreen(cbChat, cbMsg, await buildGiftAdminScreen())
      } else if (parts[0] === 'giftatt') {
        const s = await buildGiftAttemptsScreen(gid)
        if (s) await pushScreen(cbChat, cbMsg, s)
      } else {
        const uid2 = parts.slice(2).join(':')
        await withGiftLock(gid, async () => {
          const g = await getGift(gid)
          if (g && g.status === 'open' && !(g.winners || []).some(w => String(w.uid) === String(uid2))) {
            g.winners = g.winners || []
            g.winners.push({ uid: uid2, ts: Date.now() })
            g.status = 'closed'
            await saveGift(g)
            await awardGiftTo(g, uid2)
            await deliverGift(uid2, g, '🏆 Awarded by the owner.')
            await notifyOwnerGiftLine(g, uid2, 'awarded manually')
          }
        })
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
        if (!search) { await saveUserQueue(cbUserId, q); return res.status(200).send('OK') }
        search.includeLocked = data === 'lockedyes'
        if (search.isDirectList) {
          q.pendingSearch = null
          await saveUserQueue(cbUserId, q)
          const batchLinks = search.rawLinks.slice(0, search.wantCount)
          return await startBatchJob(cbChatId, cbUserId, batchLinks, search.label, null, null, search.includeLocked, search.wantCount, search.freshDays || null)
        }
        q.awaitingSocialFilter = true
        await saveUserQueue(cbUserId, q)
        await send(cbChatId,
          `📱 Social-media filter\n\nType ALL to show every usable store, or type ONE platform that every result must have: LinkedIn, Facebook, Instagram, TikTok, YouTube, or X.\n\n` +
          `STRICT MODE: every link is live-checked first — dead links and login-walled pages are dropped and NEVER count toward your requested total. If a store has no verified link for your chosen platform, it is skipped and does not count.`)
        return res.status(200).send('OK')
      }

      // ── 🇬🇧 UK website filter toggle ──
      if (data.startsWith('ukweb:')) {
        const mode = data.slice('ukweb:'.length)
        if (!['all', 'web', 'noweb'].includes(mode)) return res.status(200).send('OK')
        await redis('SET', `uk:webfilter:${cbUserId}`, mode)
        const notes = {
          web: '🌐 With website only — every company gets a max-strength website check (web search + domain guessing + live site + company-identity match). Only verified ones are delivered.',
          noweb: '🚫 No website only — only companies where the full website search found nothing live are delivered. The freshest pitching targets.',
          all: '📋 All companies — no website filtering, every company in your date window is delivered.'
        }
        await send(cbChatId, `✅ UK filter set.\n\n${notes[mode]}`)
        const s = screenFor('uk', isOwner, hasAccess, mode)
        await pushScreen(cbChatId, body.callback_query.message?.message_id, s)
        return res.status(200).send('OK')
      }

      // ── 🏪 Online Stores wizard: platform → niche → month → count → … ──
      if (data.startsWith('stplatform:')) {
        const pkey = data.slice('stplatform:'.length)
        if (!STORE_PLATFORMS[pkey]) return res.status(200).send('OK')
        const q = await getUserQueue(cbUserId)
        q.pendingSearch = { storePlatform: pkey }
        q.awaitingScoutMonth = false
        q.awaitingLeadCount = false
        await saveUserQueue(cbUserId, q)
        await sendKeyboard(cbChatId,
          `${STORE_PLATFORMS[pkey].label} — which niche must the store's CATALOG match?\n\nI'll open each store's live product catalog and only count stores with 3+ matching products — checked on the products, not the shop name.`,
          [
            [{ text: '💅 Skincare / beauty', callback_data: 'stniche:beauty' }, { text: '💎 Jewelry', callback_data: 'stniche:jewelry' }],
            [{ text: '🐾 Pet products', callback_data: 'stniche:pet' }, { text: '👗 Fashion / clothing', callback_data: 'stniche:fashion' }],
            [{ text: '✏️ My own niche (type it)', callback_data: 'stnichecustom' }]
          ])
        return res.status(200).send('OK')
      }

      if (data === 'stnichecustom') {
        const q = await getUserQueue(cbUserId)
        if (!q.pendingSearch || !q.pendingSearch.storePlatform) {
          await send(cbChatId, 'That search expired — pick a platform again from 🏪 Online Stores.')
          return res.status(200).send('OK')
        }
        q.awaitingStoreNiche = true
        await saveUserQueue(cbUserId, q)
        await send(cbChatId, `✏️ Type your niche in a few words (e.g. "resin art", "phone cases", "hair growth oil").\n\nI'll only count stores whose LIVE catalog has 3+ products matching those words.`)
        return res.status(200).send('OK')
      }

      if (data.startsWith('stniche:')) {
        const nkey = data.slice('stniche:'.length)
        if (!NICHE_KEYWORDS[nkey]) return res.status(200).send('OK')
        const q = await getUserQueue(cbUserId)
        if (!q.pendingSearch || !q.pendingSearch.storePlatform) {
          await send(cbChatId, 'That search expired — pick a platform again from 🏪 Online Stores.')
          return res.status(200).send('OK')
        }
        await finalizeStoreSearch(cbChatId, cbUserId, q, nkey, null)
        return res.status(200).send('OK')
      }

      if (data === 'scout_custom') {
        await send(cbChatId, 'Send your custom search query now.')
        const q = await getUserQueue(cbUserId)
        q.awaitingCustomQuery = true
        await saveUserQueue(cbUserId, q)
        return res.status(200).send('OK')
      }

      if (data === 'scoutdatecustom') {
        const q = await getUserQueue(cbUserId)
        if (!q.pendingSearch || q.pendingSearch.isDirectList) {
          await send(cbChatId, 'That search expired — send /scout to start again.')
          return res.status(200).send('OK')
        }
        q.awaitingCustomDate = true
        q.customDate = { step: 'mode' }
        await saveUserQueue(cbUserId, q)
        await sendKeyboard(cbChatId, '📅 Custom date — choose a search type:', [
          [{ text: '1️⃣ One exact day', callback_data: 'scoutdatemode:single' }],
          [{ text: '↩️ Range counting backward', callback_data: 'scoutdatemode:range' }]
        ])
        return res.status(200).send('OK')
      }

      if (data.startsWith('scoutdatemode:')) {
        const q = await getUserQueue(cbUserId)
        if (!q.pendingSearch || !q.customDate) {
          await send(cbChatId, 'That custom date flow expired — send /scout to start again.')
          return res.status(200).send('OK')
        }
        q.customDate.mode = data.endsWith(':range') ? 'range' : 'single'
        q.customDate.step = 'year'
        await saveUserQueue(cbUserId, q)
        await send(cbChatId, `📅 ${q.customDate.mode === 'range' ? 'Backward range' : 'Single day'} selected.\n\nStep 1: type the YEAR (for example, 2026).`)
        return res.status(200).send('OK')
      }

      if (data.startsWith('scoutagegate:')) {
        const q = await getUserQueue(cbUserId)
        if (!q.pendingSearch || q.pendingSearch.isDirectList) {
          await send(cbChatId, 'That search expired — send /scout to start again.')
          return res.status(200).send('OK')
        }
        const enforce = data.endsWith(':enforce')
        q.pendingSearch.ageGate = enforce
        q.awaitingScoutAgeGate = false
        q.awaitingLockedFilter = true
        await saveUserQueue(cbUserId, q)
        await sendKeyboard(cbChatId,
          (enforce
            ? `🆕 Age gate ON — only stores whose first-ever certificate falls inside your window will be shown. Old ones get skipped and logged (see /others). Slower, since every candidate needs an age lookup.\n\n`
            : `♻️ Any store age — old stores scanned inside your window will show as before.\n\n`) +
          `🔐 Include password-protected / "coming soon" stores?`, [
          [{ text: '✅ Yes, show them', callback_data: 'lockedyes' }],
          [{ text: '🚫 No, skip them', callback_data: 'lockedno' }]
        ])
        return res.status(200).send('OK')
      }

      if (data.startsWith('scout_')) {
        const key = data.replace('scout_', '')
        const search = SAVED_SEARCHES[key]
        if (!search) return res.status(200).send('OK')
        const q = await getUserQueue(cbUserId)
        q.pendingSearch = { query: search.query, label: search.label }
        q.awaitingScoutMonth = true
        await saveUserQueue(cbUserId, q)
        await sendKeyboard(cbChatId, `"${search.label}" — which month and year should I pull from?\n\nPick a window — the search index only reaches back 30 days, so older months aren't searchable.`, monthPickerKeyboard())
        return res.status(200).send('OK')
      }

      if (data.startsWith('scoutmonth:')) {
        const month = data.slice('scoutmonth:'.length)
        const q = await getUserQueue(cbUserId)
        if (!q.pendingSearch || q.pendingSearch.isDirectList) {
          await send(cbChatId, 'That search expired — send /scout to start again.')
          return res.status(200).send('OK')
        }
        q.pendingSearch.month = month
        q.pendingSearch.dateRange = null
        q.customDate = null
        q.awaitingCustomDate = false
        q.awaitingScoutMonth = false
        q.awaitingLeadCount = true
        await saveUserQueue(cbUserId, q)
        const scope = ymLabel(month)
        await send(cbChatId, `✅ ${scope.charAt(0).toUpperCase() + scope.slice(1)} it is.\n\nHow many NEW leads? Reply with a number (max 300).`)
        return res.status(200).send('OK')
      }

      if (data.startsWith('scoutfresh:')) {
        const days = data.slice('scoutfresh:'.length)
        const q = await getUserQueue(cbUserId)
        if (!q.pendingSearch) {
          await send(cbChatId, 'That search expired — send /scout to start again.')
          return res.status(200).send('OK')
        }
        q.pendingSearch.freshDays = days === 'any' ? null : parseInt(days)
        q.awaitingFreshFilter = false
        q.awaitingLockedFilter = true
        await saveUserQueue(cbUserId, q)
        await sendKeyboard(cbChatId, `🔐 Include password-protected / "coming soon" stores?`, [
          [{ text: '✅ Yes, show them', callback_data: 'lockedyes' }],
          [{ text: '🚫 No, skip them', callback_data: 'lockedno' }]
        ])
        return res.status(200).send('OK')
      }

      // ── 🤖 AI Site Hunter buttons ──
      if (data === 'huntcheck') {
        const q = await getUserQueue(cbUserId)
        q.awaitingHuntUrl = true
        await saveUserQueue(cbUserId, q)
        await send(cbChatId,
          `🔬 Send me the URL of the site you want deep-checked (e.g. https://some-site.com).\n\n` +
          `I'll report the builder, confidence, AI-copy score, contact channels, weaknesses, a likely-prompt guess and a pitch hook.`)
        return res.status(200).send('OK')
      }

      if (data.startsWith('huntmode:')) {
        const mode = data.endsWith(':all') ? 'all' : 'business'
        await redis('SET', `hunt:mode:${cbUserId}`, mode)
        await send(cbChatId, mode === 'business'
          ? `🏢 Business sites only — from now on developer portfolios, demos and side projects are skipped during hunts (each run tells you how many were skipped).`
          : `🌐 Show everything — developer/portfolio sites come back in the results, tagged 👨‍💻 so you can tell at a glance.`)
        return res.status(200).send('OK')
      }

      if (data.startsWith('huntgo:')) {
        const [, srcKey, nStr] = data.split(':')
        const want = Math.min(Math.max(parseInt(nStr) || 10, 1), 50)
        return await startAiHunt(cbChatId, cbUserId, srcKey, want)
      }

      if (data.startsWith('hunt:')) {
        const srcKey = data.slice('hunt:'.length)
        if (!AI_HUNT_SOURCES[srcKey]) return res.status(200).send('OK')
        const huntTier = isOwner ? 'owner' : await tierOf(cbUserId)
        const huntMode = await getHuntMode(cbUserId)
        await sendKeyboard(cbChatId,
          `🤖 ${AI_HUNT_SOURCES[srcKey].label} — how many fresh AI-built sites?`,
          huntCountButtons(srcKey, huntTier, huntMode))
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
    midFlowQueue.awaitingScoutMonth || midFlowQueue.awaitingFreshFilter || midFlowQueue.awaitingScoutAgeGate ||
    midFlowQueue.awaitingCustomDate || midFlowQueue.awaitingSocialFilter || midFlowQueue.awaitingStoreNiche ||
    midFlowQueue.awaitingHuntUrl ||
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
        const notice = await publishGiftToAll(gift)
        await tgCall('sendMessage', { chat_id: chatId, parse_mode: 'HTML',
          text: `✅ Gift <code>${gid}</code> is LIVE.\n\n🎁 ${giftPrizeText(gift)} · mode: ${gift.mode}${gift.message ? '\n💌 "' + gift.message.slice(0, 80) + '"' : ''}\n\n📨 Direct notification delivered to ${notice.delivered} user(s)${notice.failed ? `; ${notice.failed} failed (blocked bot or deleted chat)` : ''}. It also remains under 🎁 Gifts unless a user declines it.`,
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
    q.awaitingCustomQuery = false; q.awaitingLeadCount = false; q.awaitingLockedFilter = false; q.awaitingScoutMonth = false; q.awaitingFreshFilter = false; q.awaitingScoutAgeGate = false
    q.awaitingCustomDate = false; q.awaitingSocialFilter = false; q.awaitingStoreNiche = false; q.customDate = null; q.pendingSearch = null
    q.awaitingHuntUrl = false; q.aiHunt = null
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
  // v6 fixes:
  //   1. The EXACT requested count is honored (no free-tier squeeze on /newuk —
  //      it runs on the free government API and costs nothing).
  //   2. Date-range STRICTNESS: every company is re-checked client-side against
  //      the exact requested window before it can be shown, sorted newest first.
  //   3. Publish-lag handling: incorporations filed today usually appear in the
  //      register the next morning — when a "today" window comes back empty the
  //      bot says so plainly and sweeps the last 7 days instead, each company
  //      still carrying its true incorporation date.
  //   4. Website filter (🌐 with website / 🚫 no website / 📋 all from the UK
  //      menu): with-website mode runs max-strength verification per company —
  //      web search + domain guessing + live HTTP check + company-identity
  //      match (domain name, registered postcode, or full company name on the
  //      page). Only verified companies are delivered.
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
    // v6: the requested count is the count you get.
    const count = requestedCount

    const webPref = await getUkWebPref(userId)
    const today = new Date()
    const fromDate = new Date(today)
    fromDate.setDate(fromDate.getDate() - days)
    const fmt = d => d.toISOString().slice(0, 10)
    const fromISO = fmt(fromDate), toISO = fmt(today)

    const webLabel = webPref === 'web' ? ' · 🌐 with verified live website only' : webPref === 'noweb' ? ' · 🚫 without website only' : ''
    await send(chatId, `🇬🇧 Pulling UK companies incorporated ${fromISO} → ${toISO} (exact window, newest first)${webLabel} — asking for ${count}...`)

    const data = await fetchNewUKCompanies(fromISO, toISO, Math.min(Math.max(count * 3, 60), 100))
    if (!data) {
      await send(chatId, `Companies House request failed — check the API key is valid in Vercel, or try again shortly.`)
      return res.status(200).send('OK')
    }

    // STRICT client-side date matching — a company can only appear if its
    // official date_of_creation falls inside the requested window.
    const strictWindow = (arr, f, t) => (arr || [])
      .filter(it => it.date_of_creation && it.date_of_creation >= f && it.date_of_creation <= t)
      .sort((a, b) => String(b.date_of_creation).localeCompare(String(a.date_of_creation)))
    let items = strictWindow(data.items, fromISO, toISO)

    // Publish-lag fallback for "today"-style windows: Companies House adds new
    // incorporations overnight, so a fresh window can legitimately be empty.
    let lagNote = ''
    if (!items.length && days <= 2) {
      const altFrom = fmt(new Date(Date.now() - 7 * 86400000))
      const data2 = await fetchNewUKCompanies(altFrom, toISO, 100)
      items = strictWindow(data2 && data2.items, altFrom, toISO)
      if (items.length) {
        lagNote = `\n\n⏱️ Companies House publishes new incorporations with a delay — nothing was in the register for ${fromISO} → ${toISO} yet. Showing the newest PUBLISHED companies instead (${altFrom} → ${toISO}); every date below is the company's official incorporation date, strictly inside that window.`
      }
    }

    if (!items.length) {
      await send(chatId, `No UK companies found in the exact window ${fromISO} → ${toISO} (${data.hits || 0} raw hits, none passed the strict date check). Try a wider window, e.g. /newuk 7 ${count}.`)
      return res.status(200).send('OK')
    }

    // Dedup against previously-sent companies, same "seen" hash the /scout flow uses
    const ukScope = isOwner ? '' : `${userId}:`
    const dedupeKeys = items.map(it => `ukco:${ukScope}${it.company_number}`)
    const seenMap = await getSeenBatch(dedupeKeys)
    let fresh = items.filter((it, i) => !seenMap[dedupeKeys[i]])

    if (!fresh.length) {
      await send(chatId, `✓ ${items.length} in range — all already sent to you before. Nothing new.`)
      await tgCall('sendMessage', { chat_id: chatId, text: 'Keep going 👇', reply_markup: { inline_keyboard: [[B('🌐 Verify the next batch', `run:/newuk ${days} ${count}`)], [B('🏠 Main menu', 'menu:main')]] } })
      return res.status(200).send('OK')
    }

    // ── Website filter modes (from the 🇬🇧 UK menu toggle) ──
    let webStats = null
    if (webPref !== 'all' && fresh.length) {
      const sweep = fresh.slice(0, UK_VERIFY_BATCH)
      await send(chatId, `🌐 Website check: live-verifying up to ${sweep.length} companies (web search + domain guesses + company-identity match) — this takes ~30s...`)
      const checked = await mapLimit(sweep, 6, async (it) => ({
        it, site: await findCompanyWebsite({ name: it.company_name, registered_office_address: it.registered_office_address })
      }))
      // Mark everything CHECKED as seen (with the outcome) so the next run
      // continues deeper into the register instead of re-checking the same ones.
      await markSeenBatch(checked.map(c => [`ukco:${ukScope}${c.it.company_number}`,
        { sentAt: new Date().toISOString(), webCheckedAt: new Date().toISOString(), hasSite: !!c.site }]))
      const withSite = checked.filter(c => c.site).length
      webStats = { checked: checked.length, withSite }
      fresh = webPref === 'web'
        ? checked.filter(c => c.site).map(c => ({ ...c.it, __website: c.site }))
        : checked.filter(c => !c.site).map(c => c.it)
      if (!fresh.length) {
        const msg = webPref === 'web'
          ? `❌ None of the ${webStats.checked} companies checked had a verifiable live website yet — brand-new companies often don't.\n\n🌐 Tap below to verify the NEXT batch deeper in the register, or switch the UK menu to 📋 All companies.`
          : `❌ Every company in this batch had a live website — nothing "without website" here.\n\n🌐 Tap below to check the NEXT batch, or switch the UK menu to 📋 All companies.`
        await send(chatId, msg)
        await tgCall('sendMessage', { chat_id: chatId, text: 'Next batch 👇', reply_markup: { inline_keyboard: [[B(`🌐 Verify the next batch (${webStats.checked} done)`, `run:/newuk ${days} ${count}`)], [B('🏠 Main menu', 'menu:main')]] } })
        return res.status(200).send('OK')
      }
    } else {
      const freshDedupe = fresh
      if (freshDedupe.length) {
        await markSeenBatch(freshDedupe.map(it => [`ukco:${ukScope}${it.company_number}`, { sentAt: new Date().toISOString() }]))
      }
    }

    const webHeader = webStats
      ? `\n\n🌐 Website check: ${webStats.withSite} of ${webStats.checked} companies checked ${webPref === 'web' ? 'have a VERIFIED live website' : 'had no live website'}.`
      : ''
    let reply = `🇬🇧 ${fresh.length} new UK compan${fresh.length === 1 ? 'y' : 'ies'} (${items.length} in the strict window ${fromISO} → ${toISO}${lagNote ? ', lag fallback applied' : ''}):${webHeader}${lagNote}`
    fresh.forEach((it, i) => {
      const addr = it.registered_office_address || {}
      const addrLine = [addr.address_line_1, addr.locality, addr.postal_code].filter(Boolean).join(', ')
      const webLine = it.__website
        ? `\n    🌐 Website: ${it.__website.url} (✅ verified — ${it.__website.evidence})`
        : (webPref === 'noweb' ? `\n    🌐 No live website found (max-strength check)` : '')
      reply += `\n\n${i + 1}. ${it.company_name}` +
        `\n    📅 Incorporated: ${it.date_of_creation}` +
        `\n    🏢 ${it.company_type || 'unknown type'}` +
        (addrLine ? `\n    📍 ${addrLine}` : '') +
        webLine +
        `\n    🔗 https://find-and-update.company-information.service.gov.uk/company/${it.company_number}`
    })
    if (webPref !== 'all' && items.length > webStats.checked) {
      reply += `\n\nℹ️ ${items.length - webStats.checked} more companies in the window weren't checked yet — tap the button below to verify the next batch.`
    }
    await send(chatId, reply)
    await tgCall('sendMessage', { chat_id: chatId, text: 'Next step 👇  Copy the list above, then tap Find Contacts and paste it.',
      reply_markup: { inline_keyboard: [
        ...(webPref !== 'all' ? [[B('🌐 Verify the next batch', `run:/newuk ${days} ${count}`)]] : []),
        [isOwner ? B('🕵️ Find Contacts', 'menu:findco') : B('🔒 Find Contacts', 'locked')],
        [B('🏠 Main menu', 'menu:main')]
      ] } })
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

  // ── /whoami — self-diagnosis: why am I (not) treated as the owner? ──
  // Fixes the "I asked for 20 but got 10" mystery: that happens when the
  // SCRAPER_ADMIN_ID env var on Vercel doesn't match your real Telegram ID,
  // so the bot thinks you're a free user. This command shows both IDs.
  if (/^\/whoami(@\w+)?$/.test(text)) {
    const lines = [
      `🪪 Your Telegram ID: ${userId}`,
      `👑 Owner recognition: ${isOwner ? '✅ YES — you are recognized as the owner' : '❌ NO — the bot does not recognize you as owner'}`
    ]
    if (isOwner) {
      lines.push(ADMIN_ID
        ? `🔐 SCRAPER_ADMIN_ID on the server: ${ADMIN_ID} (matches you ✓)`
        : `🔐 SCRAPER_ADMIN_ID is NOT set on Vercel — every user is currently treated as owner. Set it to ${userId} to lock the bot to you.`)
    } else {
      lines.push(`🔐 A different SCRAPER_ADMIN_ID is set on Vercel (only the owner can see it).`)
      lines.push(`👉 If YOU are the owner: open Vercel → your project → Settings → Environment Variables → set SCRAPER_ADMIN_ID to ${userId} → then Deploy → Redeploy. Until then, owner-gated things count your results like a free user's.`)
    }
    lines.push(`\nResult caps currently in effect for you: ${isOwner ? 'none — owner (exact counts always honored)' : `free tier: ${FREE_RESULT_CAP} per one-time search, ${DAILY_RESULT_CAP} per daily search (never applies to /newuk — that follows your exact count)`}`)
    await tgCall('sendMessage', { chat_id: chatId, text: lines.join('\n'), disable_web_page_preview: true })
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
    keyboard.push([{ text: '🏪 Online stores by platform (Wix, Etsy…)', callback_data: 'menu:stores' }])
    keyboard.push([{ text: '✏️ Custom search term', callback_data: 'scout_custom' }])
    await sendKeyboard(chatId, 'Which search do you want to run?\n\nEvery niche search now runs a DEEP product check — a store only counts when its live catalog has 3+ matching products.', keyboard)
    return res.status(200).send('OK')
  }

  // ── /hunt [lovable|framer|all] [count] — AI Site Hunter ──
  // Free public reads (crt.sh + the sites themselves), like /newuk — no
  // session, no credit spent; only the result COUNT follows the tier caps.
  if (/^\/hunt(@\w+)?(\s|$)/.test(text)) {
    const parts = text.split(/\s+/).slice(1)
    const srcKey = (parts[0] || '').toLowerCase()
    const n = Math.min(Math.max(parseInt(parts[1]) || 10, 1), 50)
    if (AI_HUNT_SOURCES[srcKey]) {
      const huntTier = isOwner ? 'owner' : await tierOf(userId)
      const huntCap = huntTier === 'onetime' ? FREE_RESULT_CAP : huntTier === 'daily' ? DAILY_RESULT_CAP : null
      const want = huntCap ? Math.min(n, huntCap) : n
      if (huntCap && n > huntCap) {
        await send(chatId, `🎟️ Free accounts see up to ${huntCap} leads per hunt — hunting ${want} instead of ${n}. Get a pass (/access) for up to 50.`)
      }
      return await startAiHunt(chatId, userId, srcKey, want)
    }
    // No/invalid builder -> open the same button screen as 🤖 AI-Built Sites
    const s = screenFor('aihunter', isOwner, hasAccess)
    await tgCall('sendMessage', { chat_id: chatId, text: s.text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: s.kb }, disable_web_page_preview: true })
    return res.status(200).send('OK')
  }

  // ── /check <url> — deep single-site AI analysis ──
  if (/^\/check(@\w+)?(\s|$)/.test(text)) {
    const url = text.replace(/^\/check(@\w+)?\s*/, '').trim()
    if (url) {
      await sendAiSiteReport(chatId, url)
      return res.status(200).send('OK')
    }
    const q = await getUserQueue(userId)
    q.awaitingHuntUrl = true
    await saveUserQueue(userId, q)
    await send(chatId, `🔬 Send me the URL of the site you want deep-checked (e.g. https://some-site.com).`)
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
      userQueue.awaitingScoutMonth = true
      await saveUserQueue(userId, userQueue)
      await sendKeyboard(chatId, `Custom search: "${text.slice(0, 80)}" — which month and year should I pull from?`, monthPickerKeyboard())
      return res.status(200).send('OK')
    }

    // ── Custom Scout date: year → month → day → optional backward range ──
    if (userQueue.awaitingCustomDate && userQueue.customDate) {
      const cd = userQueue.customDate
      if (cd.step === 'mode') {
        await send(chatId, 'Tap One exact day or Range counting backward on the date buttons above.')
        return res.status(200).send('OK')
      }
      if (cd.step === 'year') {
        const year = Number(text.trim())
        if (!/^\d{4}$/.test(text.trim()) || year < 2000 || year > new Date().getUTCFullYear()) {
          await send(chatId, `Type a valid four-digit year from 2000 to ${new Date().getUTCFullYear()}.`)
          return res.status(200).send('OK')
        }
        cd.year = year; cd.step = 'month'
        await saveUserQueue(userId, userQueue)
        await send(chatId, 'Step 2: type the MONTH — a number 1–12 or a name such as October.')
        return res.status(200).send('OK')
      }
      if (cd.step === 'month') {
        const rawMonth = text.trim().toLowerCase()
        const namedMonth = MONTH_NAMES.findIndex(name => name.toLowerCase() === rawMonth || name.slice(0, 3).toLowerCase() === rawMonth)
        const month = namedMonth >= 0 ? namedMonth + 1 : Number(rawMonth)
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          await send(chatId, 'Type a month from 1–12, or its name (for example, 10 or October).')
          return res.status(200).send('OK')
        }
        cd.month = month; cd.step = 'day'
        await saveUserQueue(userId, userQueue)
        await send(chatId, `Step 3: type the DAY of ${MONTH_NAMES[month - 1]} ${cd.year}.`)
        return res.status(200).send('OK')
      }
      if (cd.step === 'day') {
        const day = Number(text.trim())
        const iso = validIsoDay(cd.year, cd.month, day)
        if (!iso) {
          await send(chatId, `That is not a real day in ${MONTH_NAMES[cd.month - 1]} ${cd.year}. Type a valid day number.`)
          return res.status(200).send('OK')
        }
        cd.to = iso
        if (cd.mode === 'range') {
          cd.step = 'rangeDays'
          await saveUserQueue(userId, userQueue)
          await send(chatId, `↩️ Range end: ${iso}.\n\nHow many days in total, counting backward and INCLUDING this end date? Type 2–30.\nExample: 5 days ending on the 10th = the 6th through the 10th.`)
          return res.status(200).send('OK')
        }
        cd.from = iso
      } else if (cd.step === 'rangeDays') {
        const days = Number(text.trim())
        if (!/^\d+$/.test(text.trim()) || days < 2 || days > 30) {
          await send(chatId, 'Type a whole number from 2–30. The range includes the selected end date.')
          return res.status(200).send('OK')
        }
        cd.from = new Date(Date.parse(cd.to + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10)
      } else if (cd.step !== 'day') {
        await send(chatId, 'That date step could not be read. Send /cancel, then start /scout again.')
        return res.status(200).send('OK')
      }
      const windowError = customDateWindowError(cd.from, cd.to)
      if (windowError) {
        await send(chatId, windowError + (cd.mode === 'range' ? '\n\nType a shorter number of days, or /cancel to start over.' : '\n\nType a different day, or /cancel to start over.'))
        return res.status(200).send('OK')
      }
      userQueue.pendingSearch.month = null
      userQueue.pendingSearch.dateRange = { from: cd.from, to: cd.to }
      userQueue.awaitingCustomDate = false
      userQueue.customDate = null
      userQueue.awaitingScoutMonth = false
      userQueue.awaitingLeadCount = true
      await saveUserQueue(userId, userQueue)
      await send(chatId, `✅ Date set: ${dateRangeLabel(userQueue.pendingSearch.dateRange)}.\n\nHow many NEW leads? Reply with a number (max 300).`)
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
      // If the user already pinned a date window (Last 7/14/30 days, This month,
      // or a custom day/range), that window IS the freshness rule — the urlscan
      // date:[from TO to] filter in the query enforces it strictly. Asking
      // "how fresh should the stores be" again would be a redundant second
      // question, so skip it and go straight to the password-store question.
      // Only "Any time" searches (and direct link lists) still need an age filter.
      const s0 = userQueue.pendingSearch
      const windowChosen = !s0.isDirectList && !!(s0.dateRange || (s0.month && s0.month !== 'any'))
      if (windowChosen) {
        s0.freshDays = null
        userQueue.awaitingFreshFilter = false
        userQueue.awaitingScoutAgeGate = true
        await saveUserQueue(userId, userQueue)
        const chosenScope = s0.dateRange ? dateRangeLabel(s0.dateRange) : ymLabel(s0.month)
        // The urlscan window filters when stores were last SCANNED, not when
        // they were created — an old store scanned inside the window still
        // matches. Offer the strict real-age gate here (root cause of the
        // "1000-day-old store in a 5-day window" reports).
        await sendKeyboard(chatId,
          `✅ Got it — ${wantCount} leads, strictly from ${chosenScope}.\n\n` +
          `Heads-up: that window filters when stores were last SCANNED — an old store scanned inside your window still matches it.\n\n` +
          `Want me to also enforce the window on the store's REAL age (its first-ever certificate)?`, [
          [{ text: '🆕 Only stores born in this window', callback_data: 'scoutagegate:enforce' }],
          [{ text: '♻️ Any store age (faster)', callback_data: 'scoutagegate:any' }]
        ])
        return res.status(200).send('OK')
      }
      userQueue.awaitingFreshFilter = true
      await saveUserQueue(userId, userQueue)
      await sendKeyboard(chatId, `🌱 How fresh should the stores be?\n\nI keep checking until I have ${wantCount} that pass this — old stores get skipped, not counted.`, [
        [{ text: '🌱 Brand new (≤30 days)', callback_data: 'scoutfresh:30' },
         { text: '🌱 Under 3 months (≤90 days)', callback_data: 'scoutfresh:90' }],
        [{ text: '🌱 Under a year (≤365 days)', callback_data: 'scoutfresh:365' },
         { text: '🌍 Any age', callback_data: 'scoutfresh:any' }]
      ])
      return res.status(200).send('OK')
    }

    // ── Custom niche words for the 🏪 Online Stores flow ──
    if (userQueue.awaitingStoreNiche) {
      const custom = text.trim().slice(0, 80)
      userQueue.awaitingStoreNiche = false
      if (!custom || !userQueue.pendingSearch || !userQueue.pendingSearch.storePlatform) {
        await saveUserQueue(userId, userQueue)
        await send(chatId, 'That search expired — pick a platform again from 🏪 Online Stores.')
        return res.status(200).send('OK')
      }
      await saveUserQueue(userId, userQueue)
      await finalizeStoreSearch(chatId, userId, userQueue, 'custom', custom)
      return res.status(200).send('OK')
    }

    // ── Final Scout filter: show all, or require one real social platform ──
    if (userQueue.awaitingSocialFilter) {
      const aliases = { linkedin: 'linkedin', facebook: 'facebook', instagram: 'instagram', ig: 'instagram', x: 'x', twitter: 'x', tiktok: 'tiktok', youtube: 'youtube', 'youtube shorts': 'youtube' }
      const choice = text.trim().toLowerCase()
      const requiredSocial = aliases[choice] || null
      if (choice !== 'all' && !requiredSocial) {
        await send(chatId, 'Type ALL, LinkedIn, Facebook, Instagram, TikTok, YouTube, or X. A chosen platform is required on every returned store — and only VERIFIED live links count.')
        return res.status(200).send('OK')
      }
      const search = userQueue.pendingSearch
      userQueue.awaitingSocialFilter = false
      userQueue.pendingSearch = null
      await saveUserQueue(userId, userQueue)
      if (!search) {
        await send(chatId, 'That search expired — send /scout to start again.')
        return res.status(200).send('OK')
      }
      if (!isOwner) {
        const scoutTier = await tierOf(userId)
        if (!(await spendFreeCredit(chatId, scoutTier, userId))) return res.status(200).send('OK')
      }
      // Age gate ON → the chosen window doubles as the store-age limit:
      // a 5-day range means only stores whose first-ever certificate falls
      // inside those 5 days get reported. Age gate OFF → the freshness
      // preset from the 🌱 question ("Any time" searches) applies as before.
      const gateDays = search.ageGate ? scoutWindowDays(search.dateRange, search.month) : null
      const scoutFresh = search.ageGate ? gateDays : (search.freshDays || null)
      const storeCtx = search.platform ? {
        platform: search.platform, niche: search.niche, customNiche: search.customNiche,
        keywords: search.keywords, webQuery: search.webQuery || null
      } : null
      return await startScoutJob(chatId, userId, search.query, search.label, search.wantCount,
        !!search.includeLocked, search.month, scoutFresh, search.dateRange || null, requiredSocial, !!search.ageGate, storeCtx)
    }

    // ── Awaiting a URL for the AI Site Hunter deep check ──
    if (userQueue.awaitingHuntUrl) {
      userQueue.awaitingHuntUrl = false
      await saveUserQueue(userId, userQueue)
      await sendAiSiteReport(chatId, text)
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

    // ── Continue an AI Site Hunter run cut short by the time budget ──
    if (userQueue.aiHunt && !userQueue.aiHunt.done) {
      return await runAiHuntBatch(chatId, userId, userQueue)
    }

    // ── Continue hunting: user pinged while a scout is still short of its target ──
    if (!userQueue.done && (userQueue.pending.length > 0 || (userQueue.searchCtx && !userQueue.searchCtx.exhausted))) {
      return await runBatch(chatId, userId, userQueue)
    }

    if (userQueue.results.length > 0 && !userQueue.awaitingMessages && userQueue.done) {
      const withEmail = userQueue.results.filter(r => r.email !== 'no email')
      userQueue.awaitingMessages = true
      await saveUserQueue(userId, userQueue)
      await send(chatId, `✓ All done! ${userQueue.results.length} processed, ${withEmail.length} have emails.\n\nSend outreach messages separated by /. Need ${withEmail.length}.`)
      return res.status(200).send('OK')
    }

    await send(chatId, 'Send a .txt file of links, use /scout to search stores, /find for local businesses, or /fresh to watch for brand-new stores.')
    return res.status(200).send('OK')
  } finally {
    await releaseLock(userId)
  }
}
