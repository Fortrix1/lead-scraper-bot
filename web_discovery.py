#!/usr/bin/env python3
"""web_discovery.py — Persistent-identity web discovery bot.

Takes a list of companies (name + location), searches Google *while
authenticated with your real Chrome cookies* (Cookie-Editor export), and
figures out where each company lives online: official website, LinkedIn
page, or nothing found.

Designed to slot into the existing maps_daemon job queue:
  - Jobs arrive on the same Redis `jobs:find` list with
    {"type": "discovery", "chat_id": ..., "companies": [...]}
  - Results go back to Telegram in batches + a downloadable .txt report
  - Rate limiting is shared across GitHub Actions runs via Redis
    (one counter for the whole hour, every machine respects it)
  - SQLite cache means a company already looked up in the last 30 days
    is never re-searched
  - Progress is checkpointed to Redis after every company, so if a run
    dies mid-list (job timeout, CAPTCHA), the next tick resumes exactly
    where it left off instead of starting over

Cookie acquisition (one-time, redone whenever Google logs you out):
  1. Install the "Cookie-Editor" Chrome extension
  2. Go to google.com while logged into your Google account
  3. Export cookies as JSON -> save to cookies/google_cookies.json
     (next to this script, or set GOOGLE_COOKIES_PATH)
"""

import os
import re
import json
import time
import html
import random
import sqlite3
from datetime import datetime, timezone
from urllib.parse import urlparse, quote_plus

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

# Shared budget across ALL runners (your PC + every GitHub Actions tick).
# 40/hour keeps you well under Google's radar; cookies make this look like
# a real logged-in user, so the real constraint is behavioral, not quota.
MAX_SEARCHES_PER_HOUR = 40
REDIS_RL_KEY = "disc:rl:hour"
REDIS_PROGRESS_PREFIX = "disc:progress:"   # + job_id
REDIS_LOCK_KEY = "disc:running"

# How long a cached discovery answer is trusted before re-searching.
CACHE_TTL_DAYS = 30

# Delay between searches — randomized, human-looking.
MIN_DELAY, MAX_DELAY = 3, 7

# Search queries to try, in order, until a confident website is found.
QUERY_TEMPLATES = [
    '"{name}" {location} official website',
    '"{name}" {location}',
    '"{name}" company',
]

# Domains that are never the company's own website.
JUNK_DOMAINS = [
    "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
    "youtube.com", "wikipedia.org", "google.", "bing.com", "yahoo.com",
    "yelp.com", "tripadvisor.com", "trustpilot.com", "bloomberg.com",
    "crunchbase.com", "glassdoor.com", "indeed.com", "amazon.",
    "apple.com", "microsoft.com", "gov.uk/companies", "find-and-update",
    "pinterest.", "tiktok.com", "reddit.com", "ebay.",
    "bbb.org", "manta.com", "yellowpages", "dnb.com", "rocketreach.co",
    "zoominfo.com", "owler.com", "pitchbook.com", "reuters.com",
]

# Search-result selectors, most-specific first (Google changes these often).
RESULT_ANCHORS = [
    "div.MjjYud a h3",          # classic organic
    "div.g a h3",
    "a h3",
]


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
            (key,),
        ).fetchone()
        if not row:
            return None
        result, ts = json.loads(row[0]), row[1]
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(ts)).days
        if age > CACHE_TTL_DAYS:
            return None  # stale — re-search
        result["from_cache"] = True
        return result
    finally:
        conn.close()


def put_cached(name, location, result):
    key = company_key(name, location)
    conn = _db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO discoveries VALUES (?, ?, ?)",
            (key, json.dumps(result),
             datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()


# ------------------------------------------------------------------
# Cookies
# ------------------------------------------------------------------

def load_google_cookies(path=COOKIES_PATH):
    """Load a Cookie-Editor JSON export, keep only google.com cookies,
    validate expiry, convert to Playwright's add_cookies() shape."""
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
            continue  # expired cookie — worthless
        same_site = (c.get("sameSite") or "unspecified").lower()
        same_site = {"no_restriction": "None", "unspecified": "None"}.get(
            same_site, same_site.capitalize())
        entry = {
            "name": c["name"],
            "value": c.get("value", ""),
            "domain": c["domain"],
            "path": c.get("path", "/"),
            "httpOnly": bool(c.get("httpOnly")),
            "secure": bool(c.get("secure")),
            "sameSite": same_site,
        }
        if exp:
            entry["expires"] = float(exp)
        out.append(entry)
    return out or None


def cookie_freshness_note(path=COOKIES_PATH):
    """Human-readable summary for the 'your cookies are stale' alert."""
    cookies = load_google_cookies(path)
    if not cookies:
        return f"no usable google.com cookies found at {path}"
    return f"{len(cookies)} usable google.com cookies loaded"


# ------------------------------------------------------------------
# Rate limiting (shared via Redis so PC + Actions don't double-dip)
# ------------------------------------------------------------------

def rate_limit_allows(md):
    """Returns (allowed: bool, used: int, cap: int)."""
    used = md.redis("INCR", REDIS_RL_KEY)
    if used in (None, 0):
        return True, 0, MAX_SEARCHES_PER_HOUR  # Redis down — don't hard-block
    if used == 1:
        md.redis("EXPIRE", REDIS_RL_KEY, "3600")
    return used <= MAX_SEARCHES_PER_HOUR, used, MAX_SEARCHES_PER_HOUR


# ------------------------------------------------------------------
# Google search via authenticated session
# ------------------------------------------------------------------

def make_context(p, cookies):
    browser = p.chromium.launch(
        headless=False,   # headful + Xvfb on Actions; looks far less bot-y
        args=["--disable-blink-features=AutomationControlled",
              "--no-sandbox", "--disable-dev-shm-usage"],
    )
    context = browser.new_context(
        viewport={"width": 1366, "height": 850},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        locale="en-GB",
        timezone_id="Europe/London",
        # Realistic extra headers so the session doesn't look automated
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


def human_pause(a=MIN_DELAY, b=MAX_DELAY):
    time.sleep(random.uniform(a, b))


def human_scroll(page):
    """Small random scroll — enough to look alive, not enough to be weird."""
    try:
        page.evaluate(
            f"window.scrollBy(0, {random.randint(120, 450)})")
        time.sleep(random.uniform(0.4, 1.1))
    except Exception:
        pass


def extract_results(page):
    """Pull organic results from the SERP: (url, title, snippet) list."""
    results = []
    seen = set()
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


def is_junk(url):
    u = url.lower()
    return any(j in u for j in JUNK_DOMAINS)


def is_linkedin(url):
    h = host_of(url)
    return h == "linkedin.com" or h.endswith(".linkedin.com")


def name_tokens(name):
    stop = {"ltd", "limited", "llc", "inc", "corp", "corporation", "plc",
            "uk", "the", "and", "of", "&", "co", "company", "group", "services",
            "solutions", " Ltd".lower(), "limited"}
    toks = re.findall(r"[a-z0-9]+", name.lower())
    return {t for t in toks if len(t) > 2 and t not in stop}


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


def categorize(url):
    if is_linkedin(url):
        return "linkedin"
    if is_junk(url):
        return "directory"
    return "company_website"


def search_company(page, name, location):
    """Run the query ladder until a confident company website is found.
    Returns a result dict. Raises NothingFound-style return for not_found."""
    best = None
    for template in QUERY_TEMPLATES:
        q = template.format(name=name, location=location or "UK")
        url = f"https://www.google.com/search?q={quote_plus(q)}&num=10&hl=en&gl=uk"
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        human_pause(2, 4)
        dismiss_consent(page)
        human_scroll(page)

        if is_blocked(page):
            return {"error": "blocked"}

        results = extract_results(page)
        linkedin = None
        for href, title, snippet in results:
            cat = categorize(href)
            if cat == "linkedin" and not linkedin:
                linkedin = href
                continue
            if cat != "company_website":
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
        return {
            "company": name, "location": location,
            "discovered_website": None,
            "discovered_linkedin": linkedin,
            "discovery_source": "not_found",
            "confidence_score": 0,
            "search_timestamp": datetime.now(timezone.utc).isoformat(),
        }

    return {
        "company": name, "location": location,
        "discovered_website": best["url"],
        "website_title": best.get("title", ""),
        "discovered_linkedin": linkedin,
        "discovery_source": "google_search",
        "confidence_score": best["score"],
        "match_reason": best.get("why", ""),
        "search_timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ------------------------------------------------------------------
# Progress checkpointing (resume after interruption)
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
# Job processing (called from maps_daemon.handle_job)
# ------------------------------------------------------------------

def process_job(data):
    """data = {"type": "discovery", "chat_id": "...", "job_id": "...",
               "companies": [{"name": ..., "location": ...}, ...]}"""
    import maps_daemon as md  # reuse Redis + Telegram helpers

    chat_id = str(data.get("chat_id", ""))
    companies = data.get("companies") or []
    job_id = str(data.get("job_id") or f"{chat_id}-{int(time.time())}")
    max_to_process = int(data.get("max", 100))

    md.send_telegram(
        chat_id,
        f"🕵️ Discovery job started: {len(companies)} compan"
        f"{'y' if len(companies)==1 else 'ies'} (up to {max_to_process}/run). "
        f"Results land here as they're found...",
    )

    cookies = load_google_cookies()
    if not cookies:
        md.send_telegram(
            chat_id,
            f"⚠️ No usable google.com cookies at {COOKIES_PATH}.\n\n"
            "Export them with the Cookie-Editor extension while logged in to "
            "google.com, save as cookies/google_cookies.json next to "
            "maps_daemon.py, then re-run.",
        )
        return

    progress = load_progress(md, job_id)
    if progress.get("blocked"):
        md.send_telegram(
            chat_id,
            "⏸️ This job hit a Google CAPTCHA / unusual-traffic wall last "
            "run and is paused. Refresh your cookies (Cookie-Editor export "
            "→ cookies/google_cookies.json), then send /findco again with "
            "the same list to resume.",
        )
        return

    done_map = progress.setdefault("done", {})
    remaining = [c for c in companies
                 if company_key(c.get("name", ""), c.get("location", ""))
                 not in done_map][:max_to_process]

    # Serve pure cache hits instantly without touching Google at all
    instant, needs_search = [], []
    for c in remaining:
        hit = get_cached(c.get("name", ""), c.get("location", ""))
        (instant if hit else needs_search).append((c, hit))

    found, not_found, from_cache = [], [], 0
    for c, hit in instant:
        done_map[company_key(c.get("name", ""), c.get("location", ""))] = hit
        from_cache += 1
        (found if hit.get("discovered_website") else not_found).append(hit)

    if needs_search:
        with sync_playwright() as p:
            browser, context = make_context(p, cookies)
            page = context.new_page()
            try:
                for c, _ in needs_search:
                    allowed, used, cap = rate_limit_allows(md)
                    if not allowed:
                        md.send_telegram(
                            chat_id,
                            f"⏳ Hourly search budget reached ({used}/{cap}). "
                            f"{len(needs_search)} compan"
                            f"{'y' if len(needs_search)==1 else 'ies'} left — "
                            "progress is saved and the next tick resumes "
                            "automatically.",
                        )
                        save_progress(md, job_id, progress)
                        break

                    name, location = c.get("name", ""), c.get("location", "UK")
                    try:
                        result = search_company(page, name, location)
                    except Exception as e:
                        print(f"  discovery error for {name}: {e}")
                        continue

                    if result.get("error") == "blocked":
                        progress["blocked"] = True
                        save_progress(md, job_id, progress)
                        md.send_telegram(
                            chat_id,
                            "🚫 Google threw a CAPTCHA / unusual-traffic "
                            "wall mid-run. Job PAUSED and state saved — "
                            "refresh your google cookies (Cookie-Editor → "
                            "cookies/google_cookies.json), then re-send "
                            "the same /findco command to resume from where "
                            "it stopped.",
                        )
                        break

                    put_cached(name, location, result)
                    done_map[company_key(name, location)] = result
                    save_progress(md, job_id, progress)
                    (found if result.get("discovered_website")
                     else not_found).append(result)

                    site = result.get("discovered_website") or "— not found"
                    print(f"  🔎 {name}: {site} "
                          f"({result.get('confidence_score', 0)})")
                    human_pause()  # human-like gap between searches
            finally:
                try:
                    browser.close()
                except Exception:
                    pass

    # ── Report to Telegram ──
    lines = [f"🕵️ Discovery report — {job_id}"]
    if from_cache:
        lines.append(f"📦 {from_cache} answered from cache (no Google hits)")
    for i, r in enumerate(sorted(found,
                                 key=lambda x: -x.get("confidence_score", 0)), 1):
        conf = r.get("confidence_score", 0)
        hot = " 🔥" if conf >= 80 else ""
        lines.append(
            f"\n{i}. {r['company']} ({r.get('location','')}){hot}\n"
            f"   🔗 {r['discovered_website']}\n"
            f"   📊 confidence {conf}/100 — {r.get('match_reason','')}"
        )
        if r.get("discovered_linkedin"):
            lines.append(f"   💼 {r['discovered_linkedin']}")
    if not_found:
        lines.append(f"\n❌ Not found ({len(not_found)}): " +
                     ", ".join(r["company"] for r in not_found))

    msg = "\n".join(lines)
    for start in range(0, len(msg), 3800):
        md.send_telegram(chat_id, msg[start:start + 3800])
        time.sleep(1)

    # ── Export ──
    try:
        path = export_report(found, not_found, job_id)
        md.send_telegram_document(chat_id, path,
                                  caption=f"Discovery results — {job_id}")
    except Exception as e:
        print(f"  discovery export failed: {e}")

    left = len(companies) - len(done_map)
    if left > 0:
        md.send_telegram(
            chat_id,
            f"⏭️ {left} companies still pending (budget/cap). The next "
            "daemon tick picks them up automatically — just re-send the "
            "same list, or wait for the schedule.",
        )
    else:
        md.redis("DEL", progress_key(job_id))
        md.send_telegram(chat_id,
                         f"✓ Discovery job complete: "
                         f"{len(found)} found, {len(not_found)} not found.")


def export_report(found, not_found, job_id):
    os.makedirs(os.path.join(os.path.dirname(DB_PATH), "exports"),
                exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(os.path.dirname(DB_PATH),
                        "exports", f"discovery_{ts}_{job_id[:20]}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"DISCOVERY REPORT — {job_id}\n")
        f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write("=" * 60 + "\n\n")
        for r in sorted(found, key=lambda x: -x.get("confidence_score", 0)):
            f.write(f"{r['company']} ({r.get('location','')})\n")
            f.write(f"  website:  {r.get('discovered_website')}\n")
            f.write(f"  linkedin: {r.get('discovered_linkedin')}\n")
            f.write(f"  source:   {r.get('discovery_source')}\n")
            f.write(f"  score:    {r.get('confidence_score')}/100 "
                    f"({r.get('match_reason','')})\n")
            f.write(f"  checked:  {r.get('search_timestamp','')}\n\n")
        for r in not_found:
            f.write(f"NOT FOUND: {r['company']} ({r.get('location','')})\n")
    return path


if __name__ == "__main__":
    # Quick self-test with a couple of well-known companies:
    #   python web_discovery.py
    import maps_daemon as md  # for md.* helpers in standalone mode
    demo = [
        {"name": "Rolls-Royce", "location": "Derby UK"},
        {"name": "SomeClearlyFakeCo ZZ123", "location": "UK"},
    ]
    process_job({"type": "discovery", "chat_id": os.environ.get("DEMO_CHAT_ID", ""),
                 "job_id": f"demo-{int(time.time())}", "companies": demo})
