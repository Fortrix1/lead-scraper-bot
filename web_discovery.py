#!/usr/bin/env python3
"""web_discovery.py — contact-discovery engine (v3).

For each company (typically pasted from /newuk), builds the fullest possible
contact picture, in this order:

  Phase C  Companies House (free official API)  -> company number (looked up
           by name if the paste didn't include one), registered town, and
           the CURRENT directors (the founders).
  Phase A  Google web search, several angles     -> official website,
           LinkedIn company page, every social profile, plus any emails /
           phone numbers visible in result snippets, plus directory pages
           that mention the company ("mentions").
  Phase A2 Website crawl (no Google budget used)  -> emails, phones and
           social links from the home / contact / about pages.
  Phase B  Google Maps, searching JUST the name   -> phone, website, rating,
           address. Falls back to name + town. A listing is only accepted if
           its title actually matches the company name.
  Phase D  Google search per director             -> personal LinkedIn,
           Instagram, Facebook, X, TikTok. Each hit is marked verified
           (company name appears next to the person) or possible.

Everything is cached in SQLite for 30 days, progress checkpoints to Redis
after every company, page navigations are counted against a shared hourly
budget, and a CAPTCHA wall pauses the job instead of burning the list.
Unfinished companies are automatically re-queued.

Cookie setup (one-time / when Google logs you out):
  Cookie-Editor extension -> export google.com cookies ->
  cookies/google_cookies.json next to this script.
"""

import os
import re
import json
import time
import html
import random
import base64
import sqlite3
from datetime import datetime, timezone
from urllib.parse import urlparse, quote_plus, parse_qs, unquote

import requests
from playwright.sync_api import sync_playwright

# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------

COOKIES_PATH = os.environ.get(
    "GOOGLE_COOKIES_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "cookies", "google_cookies.json"),
)
DB_PATH = os.environ.get(
    "DISCOVERY_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "discovery_cache.db"),
)
COMPANIES_HOUSE_API_KEY = os.environ.get("COMPANIES_HOUSE_API_KEY", "")

CACHE_VERSION = 4          # bump to invalidate old (thinner) cached results

# Page navigations per hour across ALL runners (PC + GitHub Actions).
# A full company costs roughly 6-10 navigations, so 150/h ~ 15-25 companies/h.
MAX_NAVS_PER_HOUR = int(os.environ.get("DISCOVERY_NAVS_PER_HOUR", "150"))
REDIS_RL_KEY = "disc:rl:hour"
# Budgets are per session owner: a BYOC user's searches can never eat the
# owner's shared-session budget (and vice versa). Set per job in process_job.
_SCOPE = "owner"
REDIS_PROGRESS_PREFIX = "disc:progress:"

CACHE_TTL_DAYS = 30
MIN_DELAY, MAX_DELAY = 3, 7
MAX_DIRECTORS = 3                  # directors searched per company
MAX_WEB_QUERIES = 4                # Google web queries per company
MAX_PERSON_QUERIES = 3             # Google queries per director
MAX_RUN_SECONDS = int(os.environ.get("DISCOVERY_MAX_RUN_SECONDS", str(20 * 60)))

JUNK_DOMAINS = [
    "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
    "youtube.com", "wikipedia.org", "google.", "bing.com", "yahoo.com",
    "yelp.com", "tripadvisor.com", "trustpilot.com", "bloomberg.com",
    "crunchbase.com", "glassdoor.com", "indeed.com", "amazon.",
    "apple.com", "microsoft.com", "find-and-update", "pinterest.",
    "tiktok.com", "reddit.com", "ebay.", "bbb.org", "manta.com",
    "yellowpages", "dnb.com", "rocketreach.co", "zoominfo.com",
    "owler.com", "pitchbook.com", "reuters.com", "gov.uk",
    "opencorporates.com", "companycheck", "endole.co.uk", "checkcompany",
    "companieslist", "companiesinfo", "ukcompanyinfo", "company-information",
    "gb.kompass", "192.com", "creditsafe", "northdata", "cylex", "hotfrog",
    "scoot.co.uk", "yell.com", "thomsonlocal", "cityfos", "wikidata",
]

SOCIAL_PATTERNS = {
    "linkedin":  r"https?://(?:[a-z]{2,3}\.)?linkedin\.com/(?:company|in)/[a-zA-Z0-9_\-%.]+",
    "instagram": r"https?://(?:www\.)?instagram\.com/[a-zA-Z0-9_.\-]+",
    "facebook":  r"https?://(?:www\.|m\.|web\.)?facebook\.com/[a-zA-Z0-9.\-]+",
    "tiktok":    r"https?://(?:www\.)?tiktok\.com/@[a-zA-Z0-9_.\-]+",
    "x":         r"https?://(?:www\.)?(?:twitter|x)\.com/[a-zA-Z0-9_]+",
}
SOCIAL_HOSTS = re.compile(
    r"(linkedin\.com|instagram\.com|facebook\.com|twitter\.com|"
    r"(?:^|\.)x\.com|tiktok\.com)")
# first path segments that are never a real profile
SOCIAL_SKIP = {
    "share", "sharer", "sharer.php", "intent", "login", "dialog", "plugins",
    "tr", "home", "explore", "p", "reel", "reels", "hashtag", "search",
    "watch", "groups", "pages", "policies", "legal", "help", "about",
    "privacy", "events", "marketplace", "stories", "photo", "photo.php",
    "permalink.php", "profile.php", "wix", "wordpress", "shopify",
    "squarespace", "godaddy", "elementor", "facebook", "instagram",
    "twitter", "linkedin", "google", "youtube", "tiktok", "i", "x",
    "company", "in", "feed", "jobs", "pub",
}

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
EMAIL_BAD_TAIL = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js", ".ico")
EMAIL_BAD_DOMAIN = ("sentry", "example.", "wixpress", "schema.org", "yourdomain",
                    "domain.com", "email.com", "godaddy", "w3.org", "gstatic",
                    "googleapis", "cloudflare", "sentry.io", "shopify.com")
# UK phone numbers: +44 ... or 0xxxx xxx xxx
PHONE_RE = re.compile(
    r"(?<![\d.])(?:\+44[\s\-.]?\(?0?\)?[\s\-.]?|0)(?:\d[\s\-.]?){9,10}(?!\d)")

CONTACT_PATHS = ["/contact", "/contact-us", "/about", "/about-us"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


class Wall(Exception):
    """Raised when we must stop browsing: 'budget' or 'blocked' (CAPTCHA)."""
    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


# ------------------------------------------------------------------
# SQLite cache
# ------------------------------------------------------------------

def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS discoveries ("
        " company_key TEXT PRIMARY KEY,"
        " result_json TEXT NOT NULL,"
        " ts TEXT NOT NULL)"
    )
    conn.commit()
    return conn


def company_key(name, location=""):
    return re.sub(r"\s+", " ", f"{name} {location}".strip().lower())


def get_cached(name, location=""):
    key = company_key(name, location)
    conn = _db()
    try:
        row = conn.execute(
            "SELECT result_json, ts FROM discoveries WHERE company_key = ?",
            (key,)).fetchone()
        if not row:
            return None
        result, ts = json.loads(row[0]), row[1]
        if result.get("v") != CACHE_VERSION:
            return None
        if (datetime.now(timezone.utc) - datetime.fromisoformat(ts)).days > CACHE_TTL_DAYS:
            return None
        result["from_cache"] = True
        return result
    finally:
        conn.close()


def put_cached(name, location, result):
    conn = _db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO discoveries VALUES (?, ?, ?)",
            (company_key(name, location), json.dumps(result),
             datetime.now(timezone.utc).isoformat()))
        conn.commit()
    finally:
        conn.close()


# ------------------------------------------------------------------
# Cookies
# ------------------------------------------------------------------

def load_google_cookies(path=COOKIES_PATH):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return None
    now = time.time()
    out = []
    for c in raw:
        domain = (c.get("domain") or "").lower()
        if "google." not in domain and "gstatic" not in domain \
                and "googleapis" not in domain:
            continue
        exp = c.get("expirationDate") or c.get("expires")
        if exp and float(exp) < now:
            continue
        secure = bool(c.get("secure"))
        same_site = (c.get("sameSite") or "unspecified").lower()
        same_site = {"no_restriction": "None", "unspecified": "None"}.get(
            same_site, same_site.capitalize())
        # Chromium rejects SameSite=None without Secure -> downgrade to Lax
        if same_site == "None" and not secure:
            same_site = "Lax"
        entry = {"name": c["name"], "value": c.get("value", ""),
                 "domain": c["domain"], "path": c.get("path", "/"),
                 "httpOnly": bool(c.get("httpOnly")),
                 "secure": secure, "sameSite": same_site}
        if exp:
            entry["expires"] = float(exp)
        out.append(entry)
    return out or None


# ------------------------------------------------------------------
# Rate limiting / human-ish behaviour
# ------------------------------------------------------------------

def nav_allowed(md):
    key = f"{REDIS_RL_KEY}:{_SCOPE}"
    used = md.redis("INCR", key)
    if used in (None, 0):
        return True, 0, MAX_NAVS_PER_HOUR
    if used == 1:
        md.redis("EXPIRE", key, "3600")
    return used <= MAX_NAVS_PER_HOUR, used, MAX_NAVS_PER_HOUR


def load_user_cookies(md, uid):
    """A non-owner's BYOC cookies (stored by the bot when they uploaded
    their Cookie-Editor export). Returns None if missing or fully expired —
    the caller must NOT fall back to the owner's shared session."""
    raw = md.redis_get(f"cookies:{uid}:google")
    if not raw:
        return None
    tmp = os.path.join(os.path.dirname(COOKIES_PATH), f"google_{uid}.json")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(raw)
        return load_google_cookies(tmp)   # None if every cookie is expired
    except Exception:
        return None


def human_pause(a=MIN_DELAY, b=MAX_DELAY):
    time.sleep(random.uniform(a, b))


def human_scroll(page):
    try:
        page.evaluate(f"window.scrollBy(0, {random.randint(120, 450)})")
        time.sleep(random.uniform(0.4, 1.1))
    except Exception:
        pass


# ------------------------------------------------------------------
# Browser session
# ------------------------------------------------------------------

def make_context(p, cookies):
    browser = p.chromium.launch(
        headless=False,
        args=["--disable-blink-features=AutomationControlled",
              "--no-sandbox", "--disable-dev-shm-usage"],
    )
    context = browser.new_context(
        viewport={"width": 1366, "height": 850},
        user_agent=UA,
        locale="en-GB",
        timezone_id="Europe/London",
        extra_http_headers={"Accept-Language": "en-GB,en;q=0.9"},
    )
    if cookies:
        context.add_cookies(cookies)
    return browser, context


def dismiss_consent(page):
    for label in ("Accept all", "I agree", "Accept", "Agree", "Got it"):
        try:
            btn = page.query_selector(f"button:has-text('{label}')")
            if btn and btn.is_visible():
                btn.click()
                time.sleep(random.uniform(1.0, 2.0))
                return True
        except Exception:
            pass
    return False


def is_blocked(page):
    url = page.url
    try:
        text = page.inner_text("body").lower()
    except Exception:
        text = ""
    signals = ["unusual traffic", "detected unusual traffic",
               "our systems have detected", "recaptcha", "captcha-form"]
    return ("google.com/sorry" in url) or any(s in text for s in signals)


def safe_goto(page, url, md):
    """Budget-checked navigation. Raises Wall on budget / CAPTCHA."""
    allowed, _used, _cap = nav_allowed(md)
    if not allowed:
        raise Wall("budget")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        print(f"    navigation problem: {str(e)[:100]}")
    human_pause(2, 4)
    dismiss_consent(page)
    if is_blocked(page):
        raise Wall("blocked")
    return True


# ------------------------------------------------------------------
# Name helpers
# ------------------------------------------------------------------

SUFFIX_WORDS = {"ltd", "limited", "llc", "inc", "corp", "corporation", "plc",
                "llp", "lp", "cic", "uk"}
STOP_WORDS = SUFFIX_WORDS | {"the", "and", "of", "co", "company", "group",
                             "services", "solutions", "holdings"}


def core_name(name):
    """'MW IMPACT LTD' -> 'mw impact'."""
    words = re.findall(r"[a-z0-9&]+", name.lower())
    while words and words[-1] in SUFFIX_WORDS:
        words.pop()
    return " ".join(words)


def squash(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def name_tokens(name):
    return {t for t in re.findall(r"[a-z0-9]+", name.lower())
            if len(t) > 2 and t not in STOP_WORDS}


def name_in_text(name, text):
    """Is this company genuinely mentioned in text?"""
    core = core_name(name)
    if not core:
        return False
    low = re.sub(r"\s+", " ", text.lower())
    if core in low:
        return True
    toks = name_tokens(name)
    if len(toks) >= 2:
        return all(t in low for t in toks)
    return False


def host_of(url):
    try:
        return urlparse(url).netloc.lower().replace("www.", "")
    except Exception:
        return ""


def score_candidate(url, title, snippet, name):
    host = host_of(url)
    label = host.split(".")[0]
    core_sq = squash(core_name(name))
    blob = f"{title} {snippet} {host}"
    if core_sq and len(core_sq) >= 4 and (core_sq in squash(label) or
                                          (len(squash(label)) >= 5 and squash(label) in core_sq)):
        return 95, "company name in domain"
    if name_in_text(name, blob):
        return 80, "company name on page"
    toks = name_tokens(name)
    if toks and any(t in blob.lower() for t in toks):
        return 55, "partial name match"
    return 25, "weak match"


# ------------------------------------------------------------------
# Address verification — is this the SAME company, or just the same name?
# ------------------------------------------------------------------

UK_POSTCODE_RE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", re.I)


def norm_pc(pc):
    return re.sub(r"\s+", "", pc or "").upper()


def postcodes_in(text):
    return {m.group(1).upper() + m.group(2).upper()
            for m in UK_POSTCODE_RE.finditer(text or "")}


def addr_status(profile, text):
    """Compare a page / listing / snippet against the REGISTERED address.
       verified = our exact postcode appears
       likely   = same postcode area (e.g. B65) or same town, no contradicting postcode
       conflict = it shows other UK postcodes and none of ours -> different business
       unknown  = no address information at all"""
    pc = norm_pc(profile.get("postcode"))
    found = postcodes_in(text)
    if pc and pc in found:
        return "verified"
    outward = pc[:-3] if len(pc) > 4 else ""
    if outward and any(f[:-3] == outward for f in found):
        return "likely"
    if found:
        return "conflict"
    loc = (profile.get("locality") or "").strip().lower()
    if loc and len(loc) > 3 and re.search(r"\b" + re.escape(loc) + r"\b", (text or "").lower()):
        return "likely"
    return "unknown"


def is_recent(profile, days=90):
    try:
        d = datetime.fromisoformat(profile.get("created", ""))
        return (datetime.now() - d).days <= days
    except Exception:
        return False


# ------------------------------------------------------------------
# Extraction helpers (emails / phones / socials)
# ------------------------------------------------------------------

def clean_emails(text):
    out = []
    for m in EMAIL_RE.findall(html.unescape(text or "")):
        e = m.strip(".,;:()<>[]\"'").lower()
        if e.endswith(EMAIL_BAD_TAIL) or any(b in e for b in EMAIL_BAD_DOMAIN):
            continue
        if e not in out:
            out.append(e)
    return out


def clean_phones(text):
    out = []
    for m in PHONE_RE.findall(text or ""):
        digits = re.sub(r"\D", "", m)
        if digits.startswith("44"):
            digits = "0" + digits[2:]
        if not (10 <= len(digits) <= 11):
            continue
        pretty = re.sub(r"\s+", " ", m.strip())
        if pretty not in out and all(re.sub(r"\D", "", o).lstrip("0")[-9:] != digits[-9:] for o in out):
            out.append(pretty)
    return out


def harvest_socials(texts, skip_handles=None):
    """Find social profile URLs inside a list of strings (hrefs or raw HTML)."""
    found = {}
    for chunk in texts:
        for net, pat in SOCIAL_PATTERNS.items():
            if found.get(net):
                continue
            for m in re.finditer(pat, chunk or ""):
                link = m.group(0).rstrip(".")
                path = urlparse(link).path.strip("/").split("/")
                seg = path[-1] if net == "linkedin" else path[0]
                seg = seg.lower().lstrip("@")
                if net != "linkedin" and seg in SOCIAL_SKIP:
                    continue
                if net == "linkedin" and (len(path) < 2 or path[1].lower() in SOCIAL_SKIP):
                    continue
                if skip_handles and seg in skip_handles:
                    continue
                found[net] = link
                break
    return found


# ------------------------------------------------------------------
# Google SERP parsing
# ------------------------------------------------------------------

RESULT_ANCHORS = ["div.MjjYud a h3", "div.g a h3", "a h3"]


def _unwrap(href):
    if href.startswith("/url?"):
        q = parse_qs(urlparse(href).query).get("q", [""])[0]
        return unquote(q)
    return href


def extract_results(page):
    """-> [(href, title, snippet)] for the visible organic results."""
    results, seen = [], set()
    for sel in RESULT_ANCHORS:
        try:
            handles = page.query_selector_all(sel)
        except Exception:
            continue
        for h3 in handles:
            try:
                info = h3.evaluate(
                    """el => {
                        const a = el.closest('a');
                        const card = el.closest('div.MjjYud, div.g, [data-sokoban-container]');
                        return {href: a ? a.getAttribute('href') : '',
                                title: el.innerText || '',
                                snippet: card ? card.innerText : ''};
                    }""")
                href = _unwrap((info.get("href") or "").strip())
                if not href.startswith("http") or href in seen:
                    continue
                seen.add(href)
                results.append((href, (info.get("title") or "").strip(),
                                re.sub(r"\s+", " ", info.get("snippet") or "")[:500]))
            except Exception:
                continue
        if len(results) >= 10:
            break
    return results[:10]


def serp(page, query, md):
    url = f"https://www.google.com/search?q={quote_plus(query)}&num=10&hl=en&gl=uk"
    safe_goto(page, url, md)
    human_scroll(page)
    return extract_results(page)


# ------------------------------------------------------------------
# Phase A — Google web search (several angles)
# ------------------------------------------------------------------

def web_queries(name, locality, number, postcode=""):
    qs = [
        f'"{name}"',                                              # exact name, anywhere
        f'"{name}" {postcode}' if postcode else f'"{name}" {locality or "UK"}',   # + registered postcode
        f'"{name}" contact email phone',                          # contact details
        f'"{name}" linkedin OR instagram OR facebook',            # socials
    ]
    if number:
        qs.append(f'"{name}" "{number}"')                         # directory pages
    return qs[:MAX_WEB_QUERIES]


def search_company_web(page, name, profile, number, md):
    locality = profile.get("locality", "")
    postcode = profile.get("postcode", "")
    cands = {}                      # url -> candidate
    linkedin = None                 # {"url","verified"}
    socials = {}                    # net -> {"url","verified"}
    emails, phones, mentions = [], [], []
    relevant_total = 0
    ran = 0

    for q in web_queries(name, locality, number, postcode):
        results = serp(page, q, md)
        ran += 1
        for href, title, snippet in results:
            blob = f"{title} {snippet}"
            relevant = name_in_text(name, blob + " " + href)
            loc_ok = addr_status(profile, blob) in ("verified", "likely")

            if SOCIAL_HOSTS.search(href):
                if relevant or squash(core_name(name)) in squash(href):
                    relevant_total += 1
                    for k, v in harvest_socials([href]).items():
                        prev = socials.get(k)
                        if not prev or (loc_ok and not prev["verified"]):
                            socials[k] = {"url": v, "verified": loc_ok}
                    if "linkedin.com/company" in href and (not linkedin or (loc_ok and not linkedin["verified"])):
                        linkedin = {"url": href, "verified": loc_ok}
                continue

            if relevant:
                relevant_total += 1
                if loc_ok:          # only trust contact details sitting next to OUR address
                    for e in clean_emails(snippet):
                        if e not in emails:
                            emails.append(e)
                    for ph in clean_phones(snippet):
                        if ph not in phones:
                            phones.append(ph)

            low = href.lower()
            if any(j in low for j in JUNK_DOMAINS):
                if relevant and loc_ok and len(mentions) < 4:
                    mentions.append({"url": href, "title": title[:90]})
                continue
            score, why = score_candidate(href, title, snippet, name)
            if score >= 55 and (href not in cands or score > cands[href]["score"]):
                cands[href] = {"url": href, "title": title, "score": score, "why": why}

        strong = any(c["score"] >= 80 for c in cands.values())
        if ran >= 2 and relevant_total == 0 and not strong:
            break
        if strong and (emails or phones) and (linkedin or socials):
            break

    ordered = sorted(cands.values(), key=lambda c: -c["score"])[:3]
    return {"linkedin_company": linkedin, "socials": socials,
            "emails": emails, "phones": phones, "mentions": mentions,
            "candidates": ordered, "queries_run": ran}


# ------------------------------------------------------------------
# Phase A2 — crawl the company's own website (no Google budget used)
# ------------------------------------------------------------------

def crawl_site(url):
    out = {"emails": [], "phones": [], "socials": {}, "pages": 0}
    if not url:
        return out
    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}"
    pages = [url] + [base + p for p in CONTACT_PATHS]
    seen = set()
    texts = []
    for i, u in enumerate(pages):
        if u in seen:
            continue
        seen.add(u)
        try:
            r = requests.get(u, headers={"User-Agent": UA}, timeout=8,
                             allow_redirects=True)
        except Exception:
            if i == 0:
                break          # home page unreachable -> don't try the rest
            continue
        if r.status_code != 200 or "text/html" not in r.headers.get("content-type", ""):
            continue
        out["pages"] += 1
        texts.append(r.text[:400000])
        if out["pages"] >= 4:
            break
    if not texts:
        return out
    blob = "\n".join(texts)
    mailtos = re.findall(r'mailto:([^"\'?\s>]+)', blob, flags=re.I)
    tels = re.findall(r'tel:([+\d\s\-().]+)', blob, flags=re.I)
    emails = clean_emails(" ".join(mailtos) + " " + re.sub(r"<[^>]+>", " ", blob))
    out["emails"] = emails[:6]
    out["phones"] = clean_phones(" ".join(tels) + " " +
                                 re.sub(r"<[^>]+>", " ", blob))[:4]
    out["socials"] = harvest_socials([blob])
    out["text"] = html.unescape(re.sub(r"<[^>]+>", " ", blob))[:150000]
    return out


# ------------------------------------------------------------------
# Phase B — Google Maps (search JUST the name first)
# ------------------------------------------------------------------

def _maps_parse_place(page):
    out = {}
    try:
        for sel in ["h1.DUwDvf", "h1.fontHeadlineLarge", '[role="main"] h1']:
            el = page.query_selector(sel)
            if el:
                t = el.inner_text().strip()
                if t and "result" not in t.lower() and len(t) > 1:
                    out["name"] = t
                    break
        el = page.query_selector("div.fontDisplayLarge, span.ceNzKf")
        if el:
            t = el.inner_text().strip()
            if any(c.isdigit() for c in t):
                out["rating"] = t
        for sel in ['button[aria-label*="review"]', 'button[aria-label*="Review"]',
                    'span[aria-label*="review"]']:
            el = page.query_selector(sel)
            if el:
                m = re.search(r"([\d,]+)", el.get_attribute("aria-label") or "")
                if m:
                    out["reviews"] = int(m.group(1).replace(",", ""))
                    break
        for btn in page.query_selector_all('button[data-item-id*="address"]'):
            t = btn.inner_text().strip()
            if len(t) > 5:
                out["address"] = t
                break
        for btn in page.query_selector_all('button[data-item-id*="phone"], button[data-tooltip*="phone"]'):
            aria = btn.get_attribute("data-item-id") or ""
            m = re.search(r"phone:tel:([\d+\-\s()]+)", aria)
            if m:
                out["phone"] = m.group(1).strip()
                break
            t = btn.inner_text().strip()
            if t and any(c.isdigit() for c in t):
                out["phone"] = t
                break
        for a in page.query_selector_all('a[data-item-id="authority"]'):
            href = a.get_attribute("href")
            if href and href.startswith("http"):
                out["website"] = href
                break
    except Exception as e:
        print(f"    maps parse error: {e}")
    return out


def maps_name_matches(candidate, name):
    c = core_name(candidate)
    n = core_name(name)
    if not c or not n:
        return False
    if c == n or n in c or c in n and len(c) >= 4:
        return True
    return squash(c) == squash(n)


def _maps_try(page, query, name, md):
    url = "https://www.google.com/maps/search/" + quote_plus(query)
    safe_goto(page, url, md)
    try:
        page.wait_for_selector("h1.DUwDvf, a.hfpxzc", timeout=9000)
    except Exception:
        return {}
    time.sleep(random.uniform(1.2, 2.2))

    # Result LIST -> click the first entry whose label matches the company
    if not page.query_selector("h1.DUwDvf"):
        try:
            for a in page.query_selector_all("a.hfpxzc")[:6]:
                label = a.get_attribute("aria-label") or ""
                if maps_name_matches(label, name):
                    a.click()
                    page.wait_for_selector("h1.DUwDvf", timeout=9000)
                    time.sleep(random.uniform(1.0, 2.0))
                    break
            else:
                return {}
        except Exception:
            return {}

    place = _maps_parse_place(page)
    if place.get("name") and maps_name_matches(place["name"], name):
        return place
    return {}


def maps_lookup(page, name, profile, md):
    """Name only first; if the listing is at a different address (a look-alike),
    retry with name + registered postcode, then name + town.
    Returns (place_or_{}, rejected_listing_or_None)."""
    postcode, locality = profile.get("postcode", ""), profile.get("locality", "")
    queries = [name]
    if postcode:
        queries.append(f"{name} {postcode}")
    if locality:
        queries.append(f"{name} {locality}")
    rejected = None
    for q in queries:
        place = _maps_try(page, q, name, md)
        if not place:
            continue
        st = addr_status(profile, place.get("address", ""))
        place["addr_status"] = st
        if st == "conflict":
            rejected = {"name": place.get("name", ""), "address": place.get("address", "")}
            continue
        return place, rejected
    return {}, rejected


# ------------------------------------------------------------------
# Phase C — Companies House (free official API)
# ------------------------------------------------------------------

def _ch_get(path, params=None):
    if not COMPANIES_HOUSE_API_KEY:
        return None
    auth = base64.b64encode(f"{COMPANIES_HOUSE_API_KEY}:".encode()).decode()
    try:
        r = requests.get("https://api.company-information.service.gov.uk" + path,
                         headers={"Authorization": f"Basic {auth}"},
                         params=params, timeout=12)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception as e:
        print(f"    companies house call failed ({path}): {e}")
        return None


def resolve_company_number(name):
    """Pasted a bare name with no link? Find its number by exact name match."""
    data = _ch_get("/search/companies", {"q": name, "items_per_page": 5})
    if not data:
        return ""
    want = re.sub(r"\s+", " ", name.upper().strip())
    for it in data.get("items", []):
        if re.sub(r"\s+", " ", (it.get("title") or "").upper().strip()) == want:
            return it.get("company_number", "")
    return ""


def fetch_profile(company_number):
    d = _ch_get(f"/company/{company_number}") if company_number else None
    if not d:
        return {}
    addr = d.get("registered_office_address") or {}
    return {"locality": addr.get("locality", ""),
            "postcode": addr.get("postal_code", ""),
            "address": ", ".join(x for x in [addr.get("address_line_1"),
                                             addr.get("locality"),
                                             addr.get("postal_code")] if x),
            "created": d.get("date_of_creation", ""),
            "sic": d.get("sic_codes", [])}


def fetch_officers(company_number):
    """Current (not resigned) human officers, directors first."""
    d = _ch_get(f"/company/{company_number}/officers") if company_number else None
    if not d:
        return []
    out = []
    for it in d.get("items", []):
        if it.get("resigned_on"):
            continue
        raw = (it.get("name") or "").strip()
        if not raw or re.search(r"\b(ltd|limited|llp|plc|inc)\b", raw, re.I):
            continue                         # corporate officer
        if "," in raw:
            last, _, first = raw.partition(",")
            full = f"{first.strip()} {last.strip()}".title()
            search = f"{first.strip().split()[0]} {last.strip()}".title() if first.strip() else last.title()
        else:
            full = search = raw.title()
        role = (it.get("officer_role") or "").replace("-", " ").replace("_", " ")
        addr = it.get("address") or {}
        out.append({"name": full, "search_name": search, "role": role,
                    "locality": addr.get("locality", ""),
                    "occupation": it.get("occupation", "")})
    out.sort(key=lambda o: 0 if "director" in o["role"] or "member" in o["role"] else 1)
    return out[:MAX_DIRECTORS]


# ------------------------------------------------------------------
# Phase D — founder / director search
# ------------------------------------------------------------------

def person_queries(person, company, locality):
    loc = locality or ""
    return [
        f'"{person}" "{company}"',                              # name + company anywhere
        f'"{person}" {company} linkedin',                       # LinkedIn
        f'"{person}" {loc} instagram OR facebook OR twitter'.replace("  ", " "),
    ][:MAX_PERSON_QUERIES]


def person_search(page, person, company, locality, md):
    toks = re.findall(r"[a-z]+", person.lower())
    first, last = (toks[0], toks[-1]) if toks else ("", "")
    links = {}                      # net -> {"url":..., "verified": bool}
    emails, phones, mentions = [], [], []

    for q in person_queries(person, company, locality):
        for href, title, snippet in serp(page, q, md):
            blob = f"{title} {snippet} {href}".lower()
            if not (first and last and first in blob and last in blob):
                continue                    # not this person
            verified = name_in_text(company, blob)
            if SOCIAL_HOSTS.search(href):
                for net, url in harvest_socials([href]).items():
                    # a personal LinkedIn is /in/, never /company/
                    if net == "linkedin" and "/company/" in url:
                        continue
                    prev = links.get(net)
                    if not prev or (verified and not prev["verified"]):
                        links[net] = {"url": url, "verified": verified}
            elif verified:
                for e in clean_emails(snippet):
                    if e not in emails:
                        emails.append(e)
                for ph in clean_phones(snippet):
                    if ph not in phones:
                        phones.append(ph)
                if len(mentions) < 3 and not any(j in href.lower() for j in ("google.", "gov.uk")):
                    mentions.append({"url": href, "title": title[:90]})
        # enough? personal LinkedIn + one more channel
        if "linkedin" in links and len(links) >= 2:
            break
    return {"links": links, "emails": emails, "phones": phones, "mentions": mentions}


# ------------------------------------------------------------------
# Progress checkpointing
# ------------------------------------------------------------------

def progress_key(job_id):
    return REDIS_PROGRESS_PREFIX + job_id


def load_progress(md, job_id):
    raw = md.redis_get(progress_key(job_id))
    if not raw:
        return {"done": {}, "blocked": False}
    try:
        return json.loads(raw)
    except Exception:
        return {"done": {}, "blocked": False}


def save_progress(md, job_id, progress):
    md.redis("SET", progress_key(job_id), json.dumps(progress), "EX", str(7 * 86400))


# ------------------------------------------------------------------
# Per-company pipeline
# ------------------------------------------------------------------

def merge_contacts(parts):
    """parts: [(source, verified, emails, phones)] -> deduped contact lists."""
    emails, phones = {}, {}
    for source, ok, em, ph in parts:
        for e in em or []:
            emails.setdefault(e, {"value": e, "source": source, "verified": ok})
        for p in ph or []:
            key = re.sub(r"\D", "", p)[-9:]
            if key and key not in {re.sub(r"\D", "", k)[-9:] for k in phones}:
                phones[p] = {"value": p, "source": source, "verified": ok}
    return list(emails.values()), list(phones.values())


def pick_website(candidates, profile):
    """Crawl candidate sites (free, no Google budget) and keep the first that
    isn't clearly a different business. Returns (cand, site, status, rejected)."""
    rejected = []
    for cand in candidates:
        site = crawl_site(cand["url"])
        text = site.pop("text", "")
        status = addr_status(profile, text) if site["pages"] else "unknown"
        if status == "conflict":
            found = sorted(postcodes_in(text))[:2]
            rejected.append({"url": cand["url"],
                             "why": "its address is elsewhere (" + ", ".join(found) + ")"})
            continue
        return cand, site, status, rejected
    return None, {"emails": [], "phones": [], "socials": {}, "pages": 0}, "unknown", rejected


def discover_company(page, c, md):
    name = c.get("name", "")
    location = c.get("location", "UK") or "UK"
    number = c.get("company_number", "")

    # Phase C — official register: number, registered address, current directors
    if not number:
        number = resolve_company_number(name)
    profile = fetch_profile(number)
    if not profile.get("locality") and location.upper() != "UK":
        profile["locality"] = location
    officers = fetch_officers(number)
    locality = profile.get("locality", "")

    # Phase A — Google, several angles (postcode-aware)
    web = search_company_web(page, name, profile, number, md)

    # Phase A2 — pick the website that actually matches the registered address
    cand, site, site_status, rejected = pick_website(web["candidates"], profile)
    website = cand["url"] if cand else None
    confidence = cand["score"] if cand else 0
    reason = cand["why"] if cand else ""

    # Phase B — Maps: name first, then name + postcode, verified against our address
    maps, maps_rejected = maps_lookup(page, name, profile, md)
    if maps_rejected:
        rejected.append({"url": f"Maps: {maps_rejected['name']}",
                         "why": f"listed at {maps_rejected['address']}"})
    if maps.get("website") and not website:
        mc, msite, mstatus, mrej = pick_website(
            [{"url": maps["website"], "score": 85, "why": "website listed on Google Maps"}], profile)
        rejected += mrej
        if mc:
            website, site, site_status = mc["url"], msite, mstatus
            confidence, reason = 85, mc["why"]

    # Phase D — each director / founder
    officer_results = []
    for off in officers:
        ps = person_search(page, off["search_name"], name,
                           off.get("locality") or locality, md)
        officer_results.append({**off, **ps})
        human_pause()

    site_ok = site_status in ("verified", "likely")
    maps_ok = maps.get("addr_status") in ("verified", "likely")

    socials = {}
    for k, v in (site.get("socials") or {}).items():
        socials[k] = {"url": v, "verified": site_ok}
    for k, v in (web.get("socials") or {}).items():
        if k not in socials or (v["verified"] and not socials[k]["verified"]):
            socials[k] = v
    li = web.get("linkedin_company")
    if socials.get("linkedin") and "/company/" in socials["linkedin"]["url"]:
        cand_li = socials["linkedin"]
        if not li or (cand_li["verified"] and not li["verified"]):
            li = cand_li
    socials.pop("linkedin", None)

    emails, phones = merge_contacts([
        ("website", site_ok, site.get("emails"), site.get("phones")),
        ("google", True, web.get("emails"), web.get("phones")),
        ("maps", maps_ok, [], [maps.get("phone")] if maps.get("phone") else []),
    ])

    return {
        "v": CACHE_VERSION,
        "company": name, "location": location,
        "company_number": number,
        "registered_address": profile.get("address", ""),
        "registered_postcode": profile.get("postcode", ""),
        "is_new": is_recent(profile),
        "created": profile.get("created", ""),
        "discovered_website": website,
        "website_status": site_status,
        "discovered_linkedin": li,
        "socials": socials,
        "emails": emails, "phones": phones,
        "mentions": web.get("mentions", []),
        "rejected": rejected,
        "maps": maps or None,
        "officers": officer_results,
        "discovery_source": "google_search" if website else "not_found",
        "confidence_score": confidence,
        "match_reason": reason,
        "queries_run": web.get("queries_run", 0),
        "search_timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ------------------------------------------------------------------
# Job processing
# ------------------------------------------------------------------

def requeue(md, data, remaining, delay_seconds=0):
    job = dict(data)
    job["companies"] = remaining
    job["resume_after"] = int(time.time()) + delay_seconds if delay_seconds else 0
    md.redis("RPUSH", "jobs:find", json.dumps(job))


def process_job(data):
    import maps_daemon as md

    chat_id = str(data.get("chat_id", ""))
    companies = data.get("companies") or []
    job_id = str(data.get("job_id") or f"{chat_id}-{int(time.time())}")
    max_to_process = int(data.get("max", 40))

    # A budget-delayed job that isn't due yet goes back on the shelf quietly.
    resume_after = int(data.get("resume_after") or 0)
    if resume_after and time.time() < resume_after:
        md.redis("RPUSH", "jobs:find", json.dumps(data))
        time.sleep(5)
        return

    progress = load_progress(md, job_id)
    if not progress.get("started"):
        md.send_telegram(
            chat_id,
            f"🕵️ Discovery started: {len(companies)} compan"
            f"{'y' if len(companies) == 1 else 'ies'}.\n"
            "Per company: Companies House directors → Google (name, town, "
            "contact, socials) → their website → Google Maps (name only) → "
            "each director on Google/LinkedIn/socials. Results land here...")
        progress["started"] = True

    # Session selection: a non-owner job uses the CALLER's own cookies and
    # their own hourly budget — the owner's shared session is never touched.
    global _SCOPE
    uid = str(data.get("user_id") or "")
    _SCOPE = uid or "owner"
    if uid:
        cookies = load_user_cookies(md, uid)
        if not cookies:
            md.send_telegram(
                chat_id,
                "⚠️ Your saved Google cookies are missing or expired — export "
                "fresh ones with the Cookie-Editor extension and send the "
                "cookies.json file to the bot again, then re-run /findco.")
            return
    else:
        cookies = load_google_cookies()
        if not cookies:
            md.send_telegram(
                chat_id,
                f"⚠️ No usable google.com cookies at {COOKIES_PATH}.\n\n"
                "Export them with the Cookie-Editor extension while logged in to "
                "google.com, save as cookies/google_cookies.json next to "
                "maps_daemon.py (or the GOOGLE_COOKIES_JSON secret), then re-send /findco.")
            return

    if progress.get("blocked"):
        md.send_telegram(
            chat_id,
            "⏸️ This job hit a Google CAPTCHA wall earlier and is paused. "
            "Refresh your cookies, then send /findco again with the same list.")
        return

    done_map = progress.setdefault("done", {})
    pending = [c for c in companies
               if company_key(c.get("name", ""), c.get("location", "")) not in done_map]
    batch = pending[:max_to_process]

    results, to_search = [], []
    for c in batch:
        hit = get_cached(c.get("name", ""), c.get("location", ""))
        if hit:
            done_map[company_key(c.get("name", ""), c.get("location", ""))] = hit
            results.append(hit)
        else:
            to_search.append(c)

    stop_reason = None
    started = time.time()
    if to_search:
        with sync_playwright() as p:
            browser, context = make_context(p, cookies)
            page = context.new_page()
            try:
                for c in to_search:
                    if time.time() - started > MAX_RUN_SECONDS:
                        stop_reason = "time"
                        break
                    name = c.get("name", "")
                    key = company_key(name, c.get("location", ""))
                    try:
                        result = discover_company(page, c, md)
                    except Wall as w:
                        stop_reason = w.kind
                        break
                    except Exception as e:
                        print(f"  ⚠️ {name} failed: {e}")
                        continue
                    put_cached(name, c.get("location", ""), result)
                    done_map[key] = result
                    save_progress(md, job_id, progress)
                    results.append(result)
                    print(f"  🔎 {name}: {result['discovered_website'] or '— no website'} "
                          f"({result['confidence_score']}) "
                          f"maps={'✓' if result['maps'] else '✗'} "
                          f"emails={len(result['emails'])} "
                          f"directors={len(result['officers'])}")
                    human_pause()
            finally:
                try:
                    browser.close()
                except Exception:
                    pass

    if stop_reason == "blocked":
        progress["blocked"] = True
        md.send_telegram(
            chat_id,
            "🚫 Google threw a CAPTCHA / unusual-traffic wall. Job PAUSED and "
            "saved — refresh your google cookies, then re-send /findco.")
    save_progress(md, job_id, progress)

    if results:
        send_report(md, chat_id, job_id, results)
        try:
            path = export_report(list(done_map.values()), job_id)
            md.send_telegram_document(chat_id, path,
                                      caption=f"Discovery results — {job_id}")
        except Exception as e:
            print(f"  discovery export failed: {e}")

    remaining = [c for c in companies
                 if company_key(c.get("name", ""), c.get("location", "")) not in done_map]
    if remaining and stop_reason != "blocked":
        if stop_reason == "budget":
            if not progress.get("budget_notified"):
                progress["budget_notified"] = True
                save_progress(md, job_id, progress)
                md.send_telegram(
                    chat_id,
                    f"⏳ Hourly Google budget reached. {len(remaining)} left — "
                    "they're re-queued and will resume automatically in ~50 min.")
            requeue(md, data, remaining, delay_seconds=50 * 60)
        else:
            requeue(md, data, remaining)
            md.send_telegram(chat_id,
                             f"⏭️ {len(remaining)} still pending — continuing on the next run.")
    elif not remaining:
        md.redis("DEL", progress_key(job_id))
        found = sum(1 for r in done_map.values() if r.get("discovered_website"))
        contactable = sum(1 for r in done_map.values()
                          if r.get("emails") or r.get("phones") or r.get("discovered_linkedin")
                          or r.get("socials")
                          or any(o.get("links") for o in r.get("officers", [])))
        md.send_telegram(chat_id,
                         f"✓ Discovery complete: {len(done_map)} companies, "
                         f"{found} websites, {contactable} with at least one way to contact.")


# ------------------------------------------------------------------
# Reporting
# ------------------------------------------------------------------

def _tick(v):
    return "✅" if v else "❓"


def format_result(r, i=None):
    conf = r.get("confidence_score", 0)
    st = r.get("website_status", "unknown")
    head = f"{i}. " if i else ""
    lines = [f"{head}{r['company']}"]
    if r.get("company_number"):
        lines[0] += f"  (#{r['company_number']})"
    if r.get("registered_address"):
        lines.append(f"   🏛️ Registered: {r['registered_address']}")
    if r.get("discovered_website"):
        tag = {"verified": "✅ address matches", "likely": "✅ same area"}.get(
            st, "❓ address not confirmed")
        lines.append(f"   🔗 {r['discovered_website']}  {tag}")
        if st == "unknown" and r.get("is_new"):
            lines.append("   ⚠️ Company is only weeks old — a website this easy to find may belong "
                         "to another business with the same name. Check before contacting.")
    else:
        lines.append("   🔗 no matching website found")
    for rj in r.get("rejected", [])[:3]:
        lines.append(f"   🚫 ignored look-alike: {rj['url']} — {rj['why']}")
    for e in r.get("emails", [])[:3]:
        lines.append(f"   📧 {e['value']}  ({e['source']}) {_tick(e.get('verified'))}")
    for p in r.get("phones", [])[:3]:
        lines.append(f"   📱 {p['value']}  ({p['source']}) {_tick(p.get('verified'))}")
    li = r.get("discovered_linkedin")
    if li:
        lines.append(f"   💼 {li['url']} {_tick(li.get('verified'))}")
    for net, d in (r.get("socials") or {}).items():
        lines.append(f"   📣 {net}: {d['url']} {_tick(d.get('verified'))}")
    m = r.get("maps") or {}
    if m:
        bits = []
        if m.get("rating"):
            bits.append(f"⭐ {m['rating']}" + (f" ({m['reviews']})" if m.get("reviews") else ""))
        if m.get("address"):
            bits.append(f"📍 {m['address']} {_tick(m.get('addr_status') in ('verified', 'likely'))}")
        if bits:
            lines.append("   🗺️ Maps: " + " · ".join(bits))
    for off in r.get("officers", []):
        lines.append(f"   👤 {off.get('name', '')} ({off.get('role', '')})")
        links = off.get("links") or {}
        for net, d in links.items():
            lines.append(f"      {'💼' if net == 'linkedin' else '📣'} {net}: {d['url']} {_tick(d['verified'])}")
        for e in off.get("emails", [])[:2]:
            lines.append(f"      📧 {e}")
        for ph in off.get("phones", [])[:2]:
            lines.append(f"      📱 {ph}")
        for mt in off.get("mentions", [])[:2]:
            lines.append(f"      🔎 {mt['title']} — {mt['url']}")
        if not (links or off.get("emails") or off.get("phones") or off.get("mentions")):
            lines.append("      — nothing public found")
    for mt in r.get("mentions", [])[:2]:
        lines.append(f"   🔎 {mt['title']} — {mt['url']}")
    if not (r.get("emails") or r.get("phones") or r.get("discovered_linkedin")
            or r.get("socials") or r.get("discovered_website")
            or any(o.get("links") for o in r.get("officers", []))):
        lines.append("   ⚠️ no public footprint yet (very new company) — "
                     "check the director names above / registered address")
    return lines


def send_report(md, chat_id, job_id, results):
    blocks = []
    for i, r in enumerate(results, 1):
        blocks.append("\n".join(format_result(r, i)))
    header = f"🕵️ Discovery report — {job_id}\n(✅ = matches the company's registered address / confirmed, ❓ = same name only, unconfirmed)\n"
    msg, chunks = header, []
    for b in blocks:
        if len(msg) + len(b) + 2 > 3800:
            chunks.append(msg)
            msg = ""
        msg += "\n" + b + "\n"
    chunks.append(msg)
    for ch in chunks:
        md.send_telegram(chat_id, ch)
        time.sleep(1)


def export_report(results, job_id):
    os.makedirs(os.path.join(os.path.dirname(DB_PATH), "exports"), exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(os.path.dirname(DB_PATH), "exports",
                        f"discovery_{ts}_{job_id[:20]}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"DISCOVERY REPORT — {job_id}\n")
        f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write("=" * 60 + "\n\n")
        for r in results:
            f.write("\n".join(format_result(r)) + "\n")
            f.write(f"   score: {r.get('confidence_score')}/100 "
                    f"({r.get('match_reason', '')}) · registered: "
                    f"{r.get('registered_address', '')}\n\n")
    return path


if __name__ == "__main__":
    import maps_daemon as md  # noqa: F401
    demo = [{"name": "Rolls-Royce Holdings plc", "location": "Derby UK",
             "company_number": "07524813"}]
    process_job({"type": "discovery", "chat_id": os.environ.get("DEMO_CHAT_ID", ""),
                 "job_id": f"demo-{int(time.time())}", "companies": demo})
