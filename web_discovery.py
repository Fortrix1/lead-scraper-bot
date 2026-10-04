#!/usr/bin/env python3
"""web_discovery.py — contact-discovery engine (v2).

For each company, builds the fullest possible contact picture:

  Phase A  Google web search (authenticated cookies)  → official website,
           LinkedIn company page, every social profile found in results
  Phase B  Google Maps listing                        → phone number,
           rating/review count, address, hours
  Phase C  Companies House officers (free official
           API, needs COMPANIES_HOUSE_API_KEY + the
           company number from the find-and-update
           links in your pasted list)                → director names
  Phase D  Google search per director                 → their personal
           LinkedIn (/in/), X, Instagram, Facebook

Everything is cached in SQLite for 30 days, progress checkpoints to
Redis after every company (resume-safe), page navigations are counted
against a shared hourly budget, and a CAPTCHA wall pauses the job and
waits for fresh cookies instead of burning the list.

Cookie setup (one-time / when Google logs you out):
  Cookie-Editor extension → export google.com cookies →
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
from urllib.parse import urlparse, quote_plus

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

# Navigations per hour across ALL runners (PC + GitHub Actions ticks).
# One company = up to ~6 navigations (web ladder + maps + 2 directors),
# so ~100 navigations/hour ≈ 15-20 companies/hour.
MAX_NAVS_PER_HOUR = 100
REDIS_RL_KEY = "disc:rl:hour"
REDIS_PROGRESS_PREFIX = "disc:progress:"

CACHE_TTL_DAYS = 30
MIN_DELAY, MAX_DELAY = 3, 7
MAX_DIRECTORS = 2          # director searches per company (budget control)

QUERY_TEMPLATES = [
    '"{name}" {location} official website',
    '"{name}" {location}',
    '"{name}" company',
]

JUNK_DOMAINS = [
    "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
    "youtube.com", "wikipedia.org", "google.", "bing.com", "yahoo.com",
    "yelp.com", "tripadvisor.com", "trustpilot.com", "bloomberg.com",
    "crunchbase.com", "glassdoor.com", "indeed.com", "amazon.",
    "apple.com", "microsoft.com", "find-and-update", "pinterest.",
    "tiktok.com", "reddit.com", "ebay.", "bbb.org", "manta.com",
    "yellowpages", "dnb.com", "rocketreach.co", "zoominfo.com",
    "owler.com", "pitchbook.com", "reuters.com", "gov.uk",
]

RESULT_ANCHORS = ["div.MjjYud a h3", "div.g a h3", "a h3"]

SOCIAL_PATTERNS = {
    "linkedin":  r"https?://(?:www\.)?linkedin\.com/(?:company|in)/[a-zA-Z0-9_\-%.]+",
    "instagram": r"https?://(?:www\.)?instagram\.com/[a-zA-Z0-9_.\-]+",
    "facebook":  r"https?://(?:www\.)?facebook\.com/[a-zA-Z0-9.\-]+",
    "tiktok":    r"https?://(?:www\.)?tiktok\.com/@[a-zA-Z0-9_.\-]+",
    "x":         r"https?://(?:www\.)?(?:twitter|x)\.com/[a-zA-Z0-9_\-]+",
}
SOCIAL_HOSTS = re.compile(
    r"(linkedin\.com|instagram\.com|facebook\.com|twitter\.com|"
    r"(?:^|\.)x\.com|tiktok\.com)")


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
        same_site = (c.get("sameSite") or "unspecified").lower()
        same_site = {"no_restriction": "None", "unspecified": "None"}.get(
            same_site, same_site.capitalize())
        entry = {"name": c["name"], "value": c.get("value", ""),
                 "domain": c["domain"], "path": c.get("path", "/"),
                 "httpOnly": bool(c.get("httpOnly")),
                 "secure": bool(c.get("secure")), "sameSite": same_site}
        if exp:
            entry["expires"] = float(exp)
        out.append(entry)
    return out or None


# ------------------------------------------------------------------
# Rate limiting (navigations, shared via Redis)
# ------------------------------------------------------------------

def nav_allowed(md):
    used = md.redis("INCR", REDIS_RL_KEY)
    if used in (None, 0):
        return True, 0, MAX_NAVS_PER_HOUR
    if used == 1:
        md.redis("EXPIRE", REDIS_RL_KEY, "3600")
    return used <= MAX_NAVS_PER_HOUR, used, MAX_NAVS_PER_HOUR


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
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
    """Budget-checked navigation. Returns False when budget/wall hit."""
    allowed, used, cap = nav_allowed(md)
    if not allowed:
        return "budget"
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    human_pause(2, 4)
    dismiss_consent(page)
    if is_blocked(page):
        return "blocked"
    return True


def extract_results(page):
    results, seen = [], set()
    for sel in RESULT_ANCHORS:
        try:
            anchors = page.query_selector_all(sel)
        except Exception:
            continue
        for a in anchors:
            try:
                href = (a.get_attribute("href") or "").strip()
                if not href.startswith("http") or href in seen:
                    continue
                title = a.inner_text().strip()
                snippet = ""
                try:
                    card = a.evaluate("el => el.closest('div.MjjYud, div.g, [data-sokoban-container]')")
                    if card:
                        snippet = card.inner_text().strip().replace("\n", " ")[:300]
                except Exception:
                    pass
                seen.add(href)
                results.append((href, title, snippet))
            except Exception:
                continue
        if len(results) >= 10:
            break
    return results[:10]


def host_of(url):
    try:
        return urlparse(url).netloc.lower().replace("www.", "")
    except Exception:
        return ""


def harvest_socials(urls):
    """Scan a list of URLs for social profiles."""
    found = {}
    for u in urls:
        for net, pat in SOCIAL_PATTERNS.items():
            m = re.search(pat, u)
            if m and not found.get(net):
                # skip share/login-style URLs that aren't profiles
                link = m.group(0)
                if re.search(r"/(share|login|intent|hashtag)/?", link):
                    continue
                found[net] = link
    return found


def name_tokens(name):
    stop = {"ltd", "limited", "llc", "inc", "corp", "corporation", "plc",
            "uk", "the", "and", "of", "co", "company", "group", "services",
            "solutions", "llp", "lp", "holdings"}
    return {t for t in re.findall(r"[a-z0-9]+", name.lower())
            if len(t) > 2 and t not in stop}


def score_candidate(url, title, snippet, name):
    host = host_of(url)
    tokens = name_tokens(name)
    domain_tokens = set(re.findall(r"[a-z0-9]+", host.split(".")[0]))
    blob = f"{title} {snippet} {host}".lower()
    hits = sum(1 for t in tokens if t in blob)
    if tokens and domain_tokens & tokens:
        return 95, "company name in domain"
    if tokens and hits >= max(2, len(tokens) - 1):
        return 80, "strong name match"
    if tokens and hits >= 1:
        return 60, "partial name match"
    return 30, "weak match"


# ------------------------------------------------------------------
# Phase A — web search
# ------------------------------------------------------------------

def search_company_web(page, name, location, md):
    best, linkedin, socials = None, None, {}
    for template in QUERY_TEMPLATES:
        q = template.format(name=name, location=location or "UK")
        url = f"https://www.google.com/search?q={quote_plus(q)}&num=10&hl=en&gl=uk"
        status = safe_goto(page, url, md)
        if status is not True:
            return {"error": status}
        human_scroll(page)
        results = extract_results(page)

        for href, title, snippet in results:
            if SOCIAL_HOSTS.search(href):
                socials.update(harvest_socials([href]))
                if "linkedin.com/company" in href and not linkedin:
                    linkedin = href
                continue
            if any(j in href.lower() for j in JUNK_DOMAINS):
                continue
            score, why = score_candidate(href, title, snippet, name)
            cand = {"url": href, "title": title, "score": score, "why": why}
            if best is None or cand["score"] > best["score"]:
                best = cand
            if score >= 80:
                break
        if best and best["score"] >= 80:
            break

    if best is None:
        return {"website": None, "linkedin_company": linkedin,
                "socials": socials, "confidence": 0}
    return {"website": best["url"], "website_title": best.get("title", ""),
            "match_reason": best.get("why", ""),
            "linkedin_company": linkedin, "socials": socials,
            "confidence": best["score"]}


# ------------------------------------------------------------------
# Phase B — Google Maps listing
# ------------------------------------------------------------------

def maps_lookup(page, name, location, md):
    q = f"{name} {location}".strip() if location and location != "UK" else name
    url = "https://www.google.com/maps/search/" + quote_plus(q)
    status = safe_goto(page, url, md)
    if status is not True:
        return {"error": status}

    out = {}
    try:
        time.sleep(random.uniform(1.5, 3))
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
        print(f"    maps parse error for {name}: {e}")
    return out


# ------------------------------------------------------------------
# Phase C — Companies House officers (free official API)
# ------------------------------------------------------------------

def fetch_officers(company_number):
    if not (COMPANIES_HOUSE_API_KEY and company_number):
        return []
    url = (f"https://api.company-information.service.gov.uk/company/"
           f"{company_number}/officers")
    auth = base64.b64encode(f"{COMPANIES_HOUSE_API_KEY}:".encode()).decode()
    try:
        r = requests.get(url, headers={"Authorization": f"Basic {auth}"},
                         timeout=10)
        if r.status_code != 200:
            return []
        out = []
        for it in r.json().get("items", []):
            raw = (it.get("name") or "").strip()
            if not raw:
                continue
            # Companies House format is "SURNAME, Forename" — flip it
            if "," in raw:
                last, _, first = raw.partition(",")
                display = f"{first.strip()} {last.strip()}".strip()
            else:
                display = raw.title()
            out.append({"name": display,
                        "role": it.get("officer_role", "").replace("_", " ")})
        return out[:MAX_DIRECTORS]
    except Exception as e:
        print(f"    officers lookup failed for {company_number}: {e}")
        return []


# ------------------------------------------------------------------
# Phase D — person search (director → LinkedIn / socials)
# ------------------------------------------------------------------

def person_search(page, person_name, company_name, md):
    q = f'"{person_name}" {company_name} linkedin'
    url = f"https://www.google.com/search?q={quote_plus(q)}&num=10&hl=en&gl=uk"
    status = safe_goto(page, url, md)
    if status is not True:
        return {"error": status}
    human_scroll(page)
    results = extract_results(page)
    urls = [h for h, _, _ in results]
    socials = harvest_socials(urls)
    linkedin = socials.get("linkedin", "")
    return {"linkedin": linkedin, "socials": socials}


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
    md.redis_set(progress_key(job_id), json.dumps(progress))


# ------------------------------------------------------------------
# Job processing
# ------------------------------------------------------------------

def process_job(data):
    import maps_daemon as md

    chat_id = str(data.get("chat_id", ""))
    companies = data.get("companies") or []
    job_id = str(data.get("job_id") or f"{chat_id}-{int(time.time())}")
    max_to_process = int(data.get("max", 40))

    md.send_telegram(
        chat_id,
        f"🕵️ Discovery job started: {len(companies)} compan"
        f"{'y' if len(companies)==1 else 'ies'} (up to {max_to_process}/run). "
        "For each: Google web search → Maps listing → Companies House "
        "directors → their LinkedIn/socials. Results land here...")

    cookies = load_google_cookies()
    if not cookies:
        md.send_telegram(
            chat_id,
            f"⚠️ No usable google.com cookies at {COOKIES_PATH}.\n\n"
            "Export them with the Cookie-Editor extension while logged in to "
            "google.com, save as cookies/google_cookies.json next to "
            "maps_daemon.py, then re-run.")
        return

    progress = load_progress(md, job_id)
    if progress.get("blocked"):
        md.send_telegram(
            chat_id,
            "⏸️ This job hit a Google CAPTCHA / unusual-traffic wall last run "
            "and is paused. Refresh your cookies (Cookie-Editor export → "
            "cookies/google_cookies.json), then send /findco again with the "
            "same list to resume.")
        return

    done_map = progress.setdefault("done", {})
    remaining = [c for c in companies
                 if company_key(c.get("name", ""), c.get("location", ""))
                 not in done_map][:max_to_process]

    instant, needs_search = [], []
    for c in remaining:
        hit = get_cached(c.get("name", ""), c.get("location", ""))
        (instant if hit else needs_search).append((c, hit))

    results = []
    for c, hit in instant:
        done_map[company_key(c.get("name", ""), c.get("location", ""))] = hit
        results.append(hit)

    budget_hit = False
    if needs_search:
        with sync_playwright() as p:
            browser, context = make_context(p, cookies)
            page = context.new_page()
            try:
                for c, _ in needs_search:
                    name = c.get("name", "")
                    location = c.get("location", "UK")
                    company_number = c.get("company_number", "")
                    key = company_key(name, location)

                    # Phase C first — it's free and needs no browser
                    officers = fetch_officers(company_number)

                    # Phase A — web search
                    web = search_company_web(page, name, location, md)
                    if web.get("error") in ("budget", "blocked"):
                        if web["error"] == "blocked":
                            progress["blocked"] = True
                            save_progress(md, job_id, progress)
                            md.send_telegram(
                                chat_id,
                                "🚫 Google threw a CAPTCHA / unusual-traffic "
                                "wall mid-run. Job PAUSED and state saved — "
                                "refresh your google cookies (Cookie-Editor → "
                                "cookies/google_cookies.json), then re-send "
                                "the same /findco command to resume.")
                        else:
                            budget_hit = True
                            md.send_telegram(
                                chat_id,
                                f"⏳ Hourly search budget reached. "
                                f"{len(needs_search)} compan"
                                f"{'y' if len(needs_search)==1 else 'ies'} left "
                                "— progress is saved and the next tick resumes.")
                            save_progress(md, job_id, progress)
                        break

                    # Phase B — maps
                    maps = maps_lookup(page, name, location, md)
                    if maps.get("error") in ("budget", "blocked"):
                        maps = {}

                    # Phase D — director searches
                    officer_results = []
                    for off in officers:
                        ps = person_search(page, off["name"], name, md)
                        if ps.get("error"):
                            break
                        officer_results.append({**off, **ps})
                        human_pause()

                    result = {
                        "company": name, "location": location,
                        "company_number": company_number,
                        "discovered_website": web.get("website"),
                        "website_title": web.get("website_title", ""),
                        "discovered_linkedin": web.get("linkedin_company"),
                        "socials": web.get("socials", {}),
                        "maps": maps or None,
                        "officers": officer_results,
                        "discovery_source": "google_search" if web.get("website")
                                            else "not_found",
                        "confidence_score": web.get("confidence", 0),
                        "match_reason": web.get("match_reason", ""),
                        "search_timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    put_cached(name, location, result)
                    done_map[key] = result
                    save_progress(md, job_id, progress)
                    results.append(result)

                    site = result["discovered_website"] or "— no website"
                    print(f"  🔎 {name}: {site} "
                          f"({result['confidence_score']}) "
                          f"maps={'✓' if maps else '✗'} "
                          f"officers={len(officer_results)}")
                    human_pause()
            finally:
                try:
                    browser.close()
                except Exception:
                    pass

    send_report(md, chat_id, job_id, results)

    try:
        path = export_report(results, job_id)
        md.send_telegram_document(chat_id, path,
                                  caption=f"Discovery results — {job_id}")
    except Exception as e:
        print(f"  discovery export failed: {e}")

    left = len(companies) - len(done_map)
    if left > 0:
        md.send_telegram(
            chat_id,
            f"⏭️ {left} companies still pending (budget/cap). The next daemon "
            "tick picks them up automatically — re-send the same list or wait "
            "for the schedule.")
    else:
        md.redis("DEL", progress_key(job_id))
        found = sum(1 for r in results if r.get("discovered_website"))
        md.send_telegram(chat_id,
                         f"✓ Discovery job complete: {found} websites found, "
                         f"{len(results) - found} not found.")


def send_report(md, chat_id, job_id, results):
    lines = [f"🕵️ Discovery report — {job_id}", ""]
    for i, r in enumerate(results, 1):
        conf = r.get("confidence_score", 0)
        hot = " 🔥" if conf >= 80 else ""
        lines.append(f"{i}. {r['company']} ({r.get('location', '')}){hot}")
        if r.get("discovered_website"):
            lines.append(f"   🔗 {r['discovered_website']}")
        else:
            lines.append("   🔗 no website found")
        socials = r.get("socials") or {}
        social_bits = [f"{k}: {v}" for k, v in socials.items()
                       if k != "linkedin"]
        if social_bits:
            lines.append("   📣 " + " | ".join(social_bits[:4]))
        if r.get("discovered_linkedin"):
            lines.append(f"   💼 {r['discovered_linkedin']}")
        maps = r.get("maps") or {}
        if maps:
            bits = []
            if maps.get("rating"):
                bits.append(f"⭐ {maps['rating']}"
                            + (f" ({maps['reviews']})" if maps.get("reviews") else ""))
            if maps.get("phone"):
                bits.append(f"📱 {maps['phone']}")
            if maps.get("address"):
                bits.append(f"📍 {maps['address']}")
            if bits:
                lines.append("   " + " · ".join(bits))
        for off in r.get("officers", []):
            role = off.get("role", "")
            ln = off.get("linkedin") or ""
            osoc = off.get("socials", {})
            extra = " | ".join(v for k, v in osoc.items()
                               if k != "linkedin")
            lines.append(f"   👤 {off.get('name','')} ({role})"
                         + (f"\n      💼 {ln}" if ln else "")
                         + (f"\n      📣 {extra}" if extra else "")
                         + ("" if (ln or extra) else " — nothing public"))
        lines.append("")
    msg = "\n".join(lines)
    for start in range(0, len(msg), 3800):
        md.send_telegram(chat_id, msg[start:start + 3800])
        time.sleep(1)


def export_report(results, job_id):
    os.makedirs(os.path.join(os.path.dirname(DB_PATH), "exports"),
                exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(os.path.dirname(DB_PATH),
                        "exports", f"discovery_{ts}_{job_id[:20]}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"DISCOVERY REPORT — {job_id}\n")
        f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write("=" * 60 + "\n\n")
        for r in results:
            f.write(f"{r['company']} ({r.get('location','')})\n")
            f.write(f"  website:   {r.get('discovered_website')}\n")
            f.write(f"  linkedin:  {r.get('discovered_linkedin')}\n")
            socials = r.get("socials") or {}
            for k, v in socials.items():
                if k != "linkedin":
                    f.write(f"  {k}: {v}\n")
            maps = r.get("maps") or {}
            if maps:
                f.write(f"  maps:      {maps.get('rating','')} "
                        f"({maps.get('reviews','')} reviews) "
                        f"{maps.get('phone','')} {maps.get('address','')}\n")
            for off in r.get("officers", []):
                f.write(f"  officer:   {off.get('name','')} "
                        f"({off.get('role','')})\n")
                if off.get("linkedin"):
                    f.write(f"    linkedin: {off['linkedin']}\n")
                for k, v in (off.get("socials") or {}).items():
                    if k != "linkedin":
                        f.write(f"    {k}: {v}\n")
            f.write(f"  score:     {r.get('confidence_score')}/100 "
                    f"({r.get('match_reason','')})\n")
            f.write(f"  checked:   {r.get('search_timestamp','')}\n\n")
    return path


if __name__ == "__main__":
    import maps_daemon as md  # noqa: F401  (self-test needs md.* helpers)
    demo = [
        {"name": "Rolls-Royce", "location": "Derby UK", "company_number": "00021500"},
    ]
    process_job({"type": "discovery", "chat_id": os.environ.get("DEMO_CHAT_ID", ""),
                 "job_id": f"demo-{int(time.time())}", "companies": demo})
