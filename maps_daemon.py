#!/usr/bin/env python3
"""maps_daemon.py - Scrapes Google Maps, checks websites, sends to Telegram."""

import os
import json
import time
import re
import html
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from playwright.sync_api import sync_playwright

# [NEW] Auto-load a .env file if one exists next to this script (local PC use).
# On GitHub Actions there's no .env file — secrets arrive as real environment
# variables instead, so this simply does nothing there, harmlessly.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# [CHANGED] Secrets now come from environment variables, not hardcoded in
# the file. This is REQUIRED once this code lives in a public GitHub repo —
# hardcoded tokens in a public repo are visible to anyone, forever (even
# in old commits). Locally, set these before running (see SETUP.md);
# on GitHub Actions, they come from encrypted repo Secrets.
REDIS_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "")
REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")
BOT_TOKEN = os.environ.get("SCRAPER_BOT_TOKEN", "")

if not (REDIS_URL and REDIS_TOKEN and BOT_TOKEN):
    raise SystemExit(
        "Missing required environment variables.\n"
        "Set UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, SCRAPER_BOT_TOKEN\n"
        "before running (see SETUP.md)."
    )

# [NEW] RUN_MODE controls whether this runs forever (local PC, default) or
# checks Redis once and exits (used by the GitHub Actions scheduled workflow).
RUN_MODE = os.environ.get("RUN_MODE", "loop")

# [CHANGED] No more hardcoded REVIEW_THRESHOLD — the bot now asks for this
# in Telegram each time you run /find, and it rides along on the job.

HIGH_VALUE_NICHES = [
    "med spa", "medspa", "dentist", "dental", "orthodont", "cosmetic",
    "plastic surgery", "dermatolog", "aesthetic", "roofing", "roofer",
    "law", "attorney", "lawyer", "real estate", "chiropractor",
    "physical therapy", "hvac", "veterinar", "contractor", "remodel",
]

DECISION_TITLES = [
    "owner", "co-founder", "founder", "ceo", "president",
    "practice manager", "office manager", "marketing manager",
    "operations manager", "general manager",
]

# ── Requests session with retries for slow networks ──
def make_session():
    session = requests.Session()
    retry = Retry(
        total=2,
        backoff_factor=2,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["HEAD", "GET", "OPTIONS"]
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session

# ── Telegram ──
def send_telegram(chat_id, text, parse_mode=None):
    try:
        payload = {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
        if parse_mode:
            payload["parse_mode"] = parse_mode
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json=payload,
            timeout=15
        )
    except Exception as e:
        print(f"  Telegram send failed: {e}")

# [NEW] Send a file (the .txt report) straight to Telegram as a document
def send_telegram_document(chat_id, filepath, caption=""):
    try:
        with open(filepath, "rb") as f:
            r = requests.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendDocument",
                data={"chat_id": chat_id, "caption": caption[:1024]},
                files={"document": (os.path.basename(filepath), f)},
                timeout=60
            )
        d = r.json()
        if not d.get("ok"):
            print(f"  Telegram document send failed: {d}")
    except Exception as e:
        print(f"  Telegram document send failed: {e}")

# ── Redis (slow-network friendly with retry) ──
def redis(*args):
    for attempt in range(3):
        try:
            r = requests.post(REDIS_URL, headers={
                "Authorization": f"Bearer {REDIS_TOKEN}",
                "Content-Type": "application/json"
            }, json=args, timeout=20)
            d = r.json()
            if d.get("error"):
                print(f"  Redis error: {d['error']}")
                return None
            return d.get("result")
        except Exception as e:
            print(f"  Redis unreachable (attempt {attempt+1}/3): {e}")
            if attempt < 2:
                time.sleep(2)
    return None

def redis_sadd(key, *members):
    if not members:
        return 0
    return redis("SADD", key, *members) or 0

def redis_sismember(key, member):
    return redis("SISMEMBER", key, member) or 0

def redis_srem(key, *members):
    if not members:
        return 0
    return redis("SREM", key, *members) or 0

def redis_hset(key, field, value):
    return redis("HSET", key, field, value)

def redis_hget(key, field):
    return redis("HGET", key, field)

def redis_set(key, value):
    return redis("SET", key, value)

def redis_get(key):
    return redis("GET", key)


# ── Helper: get current detail panel name ──
def get_panel_name(page):
    """Get the business name currently shown in the detail panel h1."""
    junk_names = ["results", "google maps", "search", "", " "]
    # [CHANGED] Try the known specific classes first, then fall back to any
    # visible h1 in the main panel — Google's CSS class names occasionally
    # differ for some listing types (ads, chains, limited-info entries),
    # which was likely a real cause of "detail panel didn't load" skips.
    selectors = [
        "h1.DUwDvf", "h1.fontHeadlineLarge",
        '[role="main"] h1', 'div[role="main"] h1',
    ]
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el:
                name = el.inner_text().strip()
                if name and len(name) > 1 and name.lower() not in junk_names and "result" not in name.lower():
                    return name
        except:
            continue
    return None


# ── Helper: robust click that tries multiple methods ──
def robust_click(element, page):
    """Try multiple click strategies."""
    # Strategy 1: Normal click with scroll
    try:
        element.scroll_into_view_if_needed()
        time.sleep(0.3)
        element.click(timeout=8000)
        return True
    except:
        pass

    # Strategy 2: JavaScript click
    try:
        element.evaluate("el => el.click()")
        return True
    except:
        pass

    # Strategy 3: Click via page mouse on bounding box center
    try:
        box = element.bounding_box()
        if box:
            page.mouse.click(box["x"] + box["width"]/2, box["y"] + box["height"]/2)
            return True
    except:
        pass

    return False


# ── Helper: wait for detail panel to show a NEW name ──
def wait_for_new_panel_name(page, prev_name, max_wait=12):
    """Wait until detail panel shows a name different from prev_name."""
    start = time.time()
    while time.time() - start < max_wait:
        name = get_panel_name(page)
        if name and name != prev_name:
            return name
        time.sleep(0.5)
    return None


def safe_int(text, default=0):
    """Parse a comma-stripped number, returning `default` instead of crashing
    on edge cases like a regex match that captured only a stray comma."""
    try:
        cleaned = text.replace(",", "").strip()
        return int(cleaned) if cleaned else default
    except (ValueError, AttributeError):
        return default


# ── Google Maps Scraping ──

def scrape_google_maps(city, niche, max_results=30, review_cap=200):
    search_query = f"{niche} in {city}"
    results = []
    seen_names = set()
    seen_addresses = set()
    script_dir = os.path.dirname(os.path.abspath(__file__))
    cookie_path = os.path.join(script_dir, "gm_cookies.json")
    # [FIX] GLOBAL dedup key — once a business is scraped, never show it again
    dedup_key = "seen_maps:global"

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ]
        )

        context = browser.new_context(
            viewport={"width": 1366, "height": 768},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            locale="en-US",
            timezone_id="America/Chicago",
        )

        if os.path.exists(cookie_path):
            try:
                with open(cookie_path, "r") as f:
                    cookies = json.load(f)
                context.add_cookies(cookies)
                print("  Cookies loaded")
            except Exception as e:
                print(f"  Could not load cookies: {e}")

        page = context.new_page()

        print(f"\n🔍 Searching: {search_query}")
        url = f"https://www.google.com/maps/search/{search_query.replace(' ', '+')}"
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        time.sleep(6)

        # Handle consent
        consent_buttons = ["Accept all", "I agree", "Reject all", "Accept", "Got it"]
        for btn_text in consent_buttons:
            try:
                btn = page.query_selector(f"button:has-text('{btn_text}')")
                if btn and btn.is_visible():
                    print(f"  Clicking consent: {btn_text}")
                    btn.click()
                    time.sleep(3)
                    break
            except:
                pass

        # Wait for feed
        print("  Waiting for results...")
        feed = None
        for attempt in range(10):
            time.sleep(2)
            feed = page.query_selector('div[role="feed"]')
            if feed:
                print(f"  Feed found on attempt {attempt + 1}")
                break
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")

        if not feed:
            print("  No feed found")
            try:
                page.screenshot(path=os.path.join(script_dir, "debug.png"), full_page=True)
                print("  Screenshot saved: debug.png")
            except:
                pass
            browser.close()
            return results

        # Wait for cards to render
        time.sleep(3)

        # [FIX] Aggressive scrolling — keep going until we have enough unique businesses
        print("  Scrolling to load more cards...")
        last_count = 0
        stuck_scrolls = 0
        target_buffer = max_results * 3  # Need 3x buffer because of dedup/filters

        for i in range(80):  # [FIX] was 40, now 80 scroll attempts
            try:
                feed.evaluate("el => el.scrollTop = el.scrollHeight")
            except:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(1.5)

            # Count unique sidebar names
            all_links = page.query_selector_all('div[role="feed"] a[href*="/maps/place"]')
            temp_names = set()
            for link in all_links:
                try:
                    txt = link.inner_text().strip()
                    if txt and len(txt) > 2:
                        temp_names.add(txt.lower())
                except:
                    pass
            current_count = len(temp_names)

            if current_count == last_count:
                stuck_scrolls += 1
                if stuck_scrolls >= 8:  # [FIX] was 5, more patience
                    print(f"  No new businesses after 8 scrolls, stopping at {current_count}")
                    break
            else:
                stuck_scrolls = 0
                last_count = current_count

            if current_count >= target_buffer:
                print(f"  Reached {current_count} unique names, enough buffer")
                break

            if i % 10 == 0:
                print(f"  ...scrolled {i} times, {current_count} unique cards so far")

        # [FIX] Find all place links, dedupe by VISIBLE TEXT
        all_links = page.query_selector_all('div[role="feed"] a[href*="/maps/place"]')
        print(f"  Found {len(all_links)} raw links in feed")

        card_links = []
        seen_sidebar_names = set()
        for link in all_links:
            try:
                text = link.inner_text().strip()
                # Only keep links with actual business name text
                if text and len(text) > 2 and text.lower() not in seen_sidebar_names:
                    seen_sidebar_names.add(text.lower())
                    card_links.append(link)
            except:
                pass

        print(f"  Found {len(card_links)} UNIQUE business cards")

        if not card_links:
            print("  No business cards found")
            browser.close()
            return results

        skipped_reasons = {
            "duplicate_name": 0, "duplicate_addr": 0, "junk_name": 0,
            "too_many_reviews": 0, "already_seen": 0, "click_fail": 0,
            "panel_load_fail": 0, "parse_error": 0
        }

        last_panel_name = None

        # Click each unique card
        for idx, card_link in enumerate(card_links):
            if len(results) >= max_results:
                break

            sidebar_name = ""
            try:
                sidebar_name = card_link.inner_text().strip()
            except:
                pass

            # [NEW] Small pacing delay — clicking cards back-to-back with zero
            # gap likely contributes to the detail panel not keeping up.
            time.sleep(0.4)

            # Robust click with fallbacks
            clicked = robust_click(card_link, page)
            if not clicked:
                skipped_reasons["click_fail"] += 1
                print(f"    ⏭️  Card {idx} ({sidebar_name}): could not click")
                continue

            # Wait for detail panel to show a NEW name
            panel_name = wait_for_new_panel_name(page, last_panel_name, max_wait=12)

            if not panel_name:
                # [CHANGED] Longer, single retry instead of a short one — most
                # slow-render cases just need more time, not another click.
                time.sleep(2)
                panel_name = wait_for_new_panel_name(page, last_panel_name, max_wait=15)
                if not panel_name:
                    skipped_reasons["panel_load_fail"] += 1
                    print(f"    ⏭️  Card {idx} ({sidebar_name}): detail panel didn't load")
                    continue

            last_panel_name = panel_name

            try:
                data = {
                    "name": panel_name, "address": "", "website": "", "phone": "",
                    "rating": "", "reviews": 0, "city": city, "niche": niche,
                    "instagram_handle": "", "facebook_page": ""
                }

                # Skip junk/duplicate names
                junk_names = ["results", "google maps", "search", "", " "]
                if data["name"].lower() in junk_names or "result" in data["name"].lower():
                    skipped_reasons["junk_name"] += 1
                    continue

                if data["name"].lower() in seen_names:
                    skipped_reasons["duplicate_name"] += 1
                    print(f"    ⏭️  Duplicate: {data['name']}")
                    continue

                # Address
                for btn in page.query_selector_all('button[data-item-id*="address"]'):
                    txt = btn.inner_text().strip()
                    if txt and len(txt) > 5:
                        data["address"] = txt
                        break

                addr_key = data["address"].lower().replace(" ", "") if data["address"] else ""
                if addr_key and addr_key in seen_addresses:
                    skipped_reasons["duplicate_addr"] += 1
                    continue

                # Website
                for btn in page.query_selector_all('a[data-item-id="authority"]'):
                    href = btn.get_attribute("href")
                    if href and href.startswith("http"):
                        data["website"] = href
                        break

                # Phone
                for btn in page.query_selector_all('button[data-tooltip*="phone"], button[data-item-id*="phone"]'):
                    txt = btn.get_attribute("data-tooltip") or btn.inner_text().strip()
                    if txt and any(c.isdigit() for c in txt):
                        data["phone"] = txt
                        break

                # Rating
                el = page.query_selector("div.fontDisplayLarge, span.ceNzKf")
                if el:
                    txt = el.inner_text().strip()
                    if txt and any(c.isdigit() for c in txt):
                        data["rating"] = txt

                # [FIX] Reviews - comprehensive extraction from detail panel
                review_count = 0

                # Method 1: aria-label on review button/span
                for sel in ['button[aria-label*="review"]', 'button[aria-label*="Review"]', 'span[aria-label*="review"]', 'span[aria-label*="Review"]']:
                    review_el = page.query_selector(sel)
                    if review_el:
                        aria = review_el.get_attribute("aria-label") or ""
                        m = re.search(r"([\d,]+)", aria)
                        if m:
                            review_count = safe_int(m.group(1))
                            break

                # Method 2: Look for text pattern like "4.4 (806)" or "4.4 · 806" in detail panel
                if review_count == 0 and data["rating"]:
                    try:
                        # Get text from the main detail panel
                        panel = page.query_selector('div[role="main"]')
                        if panel:
                            panel_text = panel.inner_text()
                            # Pattern: rating followed by reviews in parens or after dot
                            patterns = [
                                re.escape(data["rating"]) + r"[^\d]*\(?([\d,]+)\)?",
                                re.escape(data["rating"]) + r"[^\d]*·[^\d]*([\d,]+)",
                                re.escape(data["rating"]) + r"\s*\(\s*([\d,]+)\s*\)",
                            ]
                            for pat in patterns:
                                m = re.search(pat, panel_text)
                                if m:
                                    review_count = safe_int(m.group(1))
                                    break
                    except:
                        pass

                # Method 3: Find any standalone number > 10 near the rating area
                if review_count == 0:
                    try:
                        # Look for elements that contain just a number near the top of the panel
                        panel = page.query_selector('div[role="main"]')
                        if panel:
                            # Get first few divs/spans which usually contain rating info
                            near_rating = panel.query_selector_all("span, div, button")
                            for el in near_rating[:20]:  # Check first 20 elements
                                txt = el.inner_text().strip()
                                if txt and txt.replace(",", "").isdigit():
                                    num = int(txt.replace(",", ""))
                                    if 10 < num < 100000:  # Reasonable review count range
                                        review_count = num
                                        break
                    except:
                        pass

                data["reviews"] = review_count

                # Skip high-review businesses (review_cap is None = no limit)
                if review_cap is not None and data["reviews"] > review_cap:
                    skipped_reasons["too_many_reviews"] += 1
                    print(f"    ⏭️  High reviews: {data['name']} ({data['reviews']})")
                    continue

                # [FIX] GLOBAL cross-search dedup — check Redis before adding
                dedup_id = f"{data['name'].lower().strip()}|{addr_key}"
                if redis_sismember(dedup_key, dedup_id):
                    skipped_reasons["already_seen"] += 1
                    print(f"    ⏭️  Already seen (global): {data['name']}")
                    continue

                data["dedup_id"] = dedup_id  # [NEW] carried through for status tracking

                redis_sadd(dedup_key, dedup_id)
                seen_names.add(data["name"].lower())
                if addr_key:
                    seen_addresses.add(addr_key)

                results.append(data)
                print(f"    ✅ {len(results)}. {data['name']} — {data['website'] or 'no website'} — {data['reviews']} reviews")

            except Exception as e:
                skipped_reasons["parse_error"] += 1
                print(f"    ⚠️  Card {idx} ({sidebar_name}) error: {str(e)[:80]}")
                continue

        # Save cookies
        try:
            cookies = context.cookies()
            with open(cookie_path, "w") as f:
                json.dump(cookies, f)
            print("  Cookies saved")
        except:
            pass

        browser.close()

    print(f"\n  Skipped breakdown: {skipped_reasons}")
    print(f"  ✅ Total collected: {len(results)} / {max_results} requested")
    return results


# ── Website checking (slow-network friendly) ──

def clean_emails(text):
    emails = re.findall(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}", text)
    junk = ["example", "domain", "sentry", "shopify", "wixpress", "schema", "pixel",
            ".png", ".jpg", "yourstore", "youremail", "test@", "user@", "noreply", "no-reply"]
    return [e.lower() for e in emails if not any(j in e.lower() for j in junk)]

def best_email(emails):
    priority = ["contact", "info", "hello", "support", "admin", "help", "sales", "store", "hi"]
    for p in priority:
        found = next((e for e in emails if p in e), None)
        if found:
            return found
    return emails[0] if emails else ""

def extract_socials(text):
    socials = {}
    patterns = {
        "instagram": r"https?://(?:www\.)?instagram\.com/[a-zA-Z0-9_.\-]+",
        "facebook":  r"https?://(?:www\.)?facebook\.com/[a-zA-Z0-9.]+",
        "linkedin":  r"https?://(?:www\.)?linkedin\.com/(?:company|in)/[a-zA-Z0-9_\-]+",
        "tiktok":    r"https?://(?:www\.)?tiktok\.com/@[a-zA-Z0-9_.\-]+",
    }
    for key, pat in patterns.items():
        m = re.search(pat, text)
        if m:
            socials[key] = m.group(0)
    return socials

def extract_instagram_handle(text):
    m = re.search(r"instagram\.com/([a-zA-Z0-9_.]+)", text)
    return m.group(1) if m else ""

def extract_facebook_page(text):
    m = re.search(r"facebook\.com/([a-zA-Z0-9.]+)", text)
    return m.group(0) if m else ""

# [NEW] ── Website signal detection (booking, chat, WhatsApp, CTA, mobile) ──
def detect_signals(html):
    h = html.lower()
    return {
        "has_contact_form": bool(re.search(r"<form[^>]*>", h)) and
                             any(k in h for k in ["contact", "message", "enquiry", "inquiry"]),
        "has_booking": any(k in h for k in [
            "calendly.com", "acuityscheduling.com", "book now", "book an appointment",
            "schedule an appointment", "booksy.com", "mindbodyonline.com",
            "setmore.com", "book online", "square appointments", "opentable.com"
        ]),
        "has_live_chat": any(k in h for k in [
            "intercom", "drift.com", "tawk.to", "crisp.chat", "zendesk",
            "livechatinc", "hubspot", "olark", "tidio", "purechat", "freshchat"
        ]),
        "has_whatsapp": ("wa.me/" in h) or ("api.whatsapp.com" in h),
        "has_clear_cta": any(k in h for k in [
            "book now", "call now", "get started", "contact us", "schedule now",
            "get a quote", "shop now", "buy now", "sign up", "request a"
        ]),
        "is_mobile_friendly": 'name="viewport"' in h or "name='viewport'" in h,
    }


# [NEW] ── Tech-stack / software fingerprinting from public page source ──
# Same approach tools like Wappalyzer/BuiltWith use: known script/domain
# signatures in the HTML. Can't see inside their CRM — only that it's there.
TECH_SIGNATURES = {
    "cms": {
        "WordPress": ["wp-content", "wp-json", "wp-includes"],
        "Wix": ["static.wixstatic.com", "wix.com/website"],
        "Squarespace": ["squarespace.com", "static1.squarespace.com"],
        "Shopify": ["cdn.shopify.com", ".myshopify.com"],
        "Webflow": ["webflow.com", "website-files.com"],
        "GoDaddy Website Builder": ["godaddysites.com", "gdbuilder"],
    },
    "crm_marketing": {
        "HubSpot": ["hs-scripts.com", "hs-analytics", "hubspot.com"],
        "Salesforce": ["force.com", "salesforce.com"],
        "GoHighLevel": ["msgsndr.com", "gohighlevel.com"],
        "ActiveCampaign": ["activehosted.com"],
        "Mailchimp": ["list-manage.com", "mailchimp.com"],
        "Klaviyo": ["klaviyo.com", "static.klaviyo.com"],
    },
    "booking_tools": {
        "Calendly": ["calendly.com"],
        "Acuity Scheduling": ["acuityscheduling.com"],
        "Booksy": ["booksy.com"],
        "Mindbody": ["mindbodyonline.com"],
        "Setmore": ["setmore.com"],
        "Square Appointments": ["squareup.com/appointments", "square.site"],
        "OpenTable": ["opentable.com"],
    },
    "chat_tools": {
        "Intercom": ["intercom"],
        "Drift": ["drift.com"],
        "Tawk.to": ["tawk.to"],
        "Crisp": ["crisp.chat"],
        "Zendesk Chat": ["zendesk"],
        "LiveChat": ["livechatinc"],
        "Tidio": ["tidio"],
    },
    "analytics": {
        "Google Analytics": ["googletagmanager.com", "google-analytics.com", "gtag/js"],
        "Meta Pixel": ["connect.facebook.net"],
        "TikTok Pixel": ["analytics.tiktok.com"],
    },
}

def detect_tech_stack(html):
    h = html.lower()
    found = {}
    for category, tools in TECH_SIGNATURES.items():
        hits = [name for name, sigs in tools.items() if any(s.lower() in h for s in sigs)]
        if hits:
            found[category] = hits
    return found


# [NEW] ── Actual contact channel URLs (not just yes/no signals) ──
def extract_contact_channels(html, result):
    channels = {}
    m = re.search(r"https?://wa\.me/[0-9]{6,15}", html)
    if m:
        channels["whatsapp"] = m.group(0)
    m = re.search(r"https?://(?:www\.)?m\.me/[a-zA-Z0-9_.\-]+", html)
    if m:
        channels["messenger"] = m.group(0)
    if result.get("email") and result["email"] != "no email":
        channels["email"] = result["email"]
    if result.get("contact_page"):
        channels["contact_form"] = result["contact_page"]
    for platform in ("instagram", "facebook", "linkedin", "tiktok"):
        if result.get("socials", {}).get(platform):
            channels[platform] = result["socials"][platform]
    return channels


# [NEW] ── Best-effort decision-maker guess from page text ──
# This is a heuristic (regex around common title words), not a verified lookup —
# treat hits as a starting point to confirm manually, not a guaranteed name.
NAME_STOPWORDS = {
    "book", "now", "call", "get", "contact", "schedule", "shop", "buy",
    "sign", "request", "learn", "more", "click", "here", "today", "visit",
}

def guess_decision_maker(html):
    text = re.sub("<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)
    name_part = r"([A-Z][a-zA-Z\.\-]+(?:\s+[A-Z][a-zA-Z\.\-]+){0,2})"
    for title in DECISION_TITLES:
        for pat in [
            re.compile(name_part + r"\s*[,\-|]\s*" + re.escape(title), re.IGNORECASE),
            re.compile(re.escape(title) + r"\s*[:\-]\s*" + name_part, re.IGNORECASE),
        ]:
            m = pat.search(text)
            if m:
                words = [w.strip(".,;:") for w in m.group(1).strip().split()]
                while words and words[-1].lower() in NAME_STOPWORDS:
                    words.pop()
                if 2 <= len(words) <= 3 and not any(w.lower() in NAME_STOPWORDS for w in words):
                    return {"name": " ".join(words), "title": title.title()}
    return {"name": "", "title": ""}


# [NEW] ── Turn missing signals into human-readable pain points ──
def detect_pain_points(sig, reviews):
    points = []
    if not sig.get("has_live_chat") and not sig.get("has_whatsapp"):
        points.append(("Lead-response", "no live chat or WhatsApp — inquiries may sit unanswered"))
    if not sig.get("has_contact_form") and not sig.get("has_booking"):
        points.append(("Lead-response", "no contact form or booking system — hard for customers to reach them directly"))
    if not sig.get("has_booking"):
        points.append(("Conversion", "no online booking system found"))
    if not sig.get("has_clear_cta"):
        points.append(("Conversion", "no clear call-to-action on the homepage"))
    if reviews and reviews >= 50 and not sig.get("has_live_chat") and not sig.get("has_booking"):
        points.append(("Reactivation", f"{reviews}+ reviews show a real customer base but no visible follow-up system"))
    if not sig.get("is_mobile_friendly"):
        points.append(("Website", "no mobile viewport tag found — site may not be mobile-friendly"))

    seen_cat, unique = set(), []
    for cat, desc in points:
        if cat not in seen_cat:
            unique.append((cat, desc))
            seen_cat.add(cat)
    return unique[:3]


def is_high_value_niche(niche):
    n = niche.lower()
    return any(k in n for k in HIGH_VALUE_NICHES)


# [NEW] ── Weighted opportunity score (replaces the old flat scoring) ──
def score_lead(data, sig, niche):
    reviews = data.get("reviews", 0) or 0
    b = {}

    b["high_value_service"] = 20 if is_high_value_niche(niche) else 8

    if reviews >= 100: vol = 20
    elif reviews >= 50: vol = 16
    elif reviews >= 20: vol = 12
    elif reviews >= 5: vol = 8
    else: vol = 4
    b["lead_volume_potential"] = vol

    missing = sum([
        not sig.get("has_live_chat"), not sig.get("has_whatsapp"),
        not sig.get("has_booking"), not sig.get("has_contact_form"),
    ])
    b["weak_follow_up"] = min(20, missing * 5)

    website_opp = 0
    load = data.get("load_seconds")
    if isinstance(load, (int, float)):
        if load >= 8: website_opp += 8
        elif load >= 5: website_opp += 5
    if data.get("ssl_valid") is False: website_opp += 4
    if not sig.get("is_mobile_friendly"): website_opp += 3
    b["website_opportunity"] = min(15, website_opp)

    social_count = len(data.get("socials", {}))
    b["active_social_presence"] = min(10, social_count * 4)

    pay = 5 if is_high_value_niche(niche) else 2
    if reviews >= 50: pay += 5
    b["ability_to_pay"] = min(10, pay)

    b["decision_maker_identifiable"] = 5 if data.get("decision_maker", {}).get("name") else 0

    return min(sum(b.values()), 100), b


# [NEW] ── Rule-based "why contact" line built from real evidence, not a generic template ──
def generate_why_contact(data, niche, pain_points):
    biz = data.get("name", "This business")
    reviews = data.get("reviews", 0) or 0

    if not data.get("website"):
        return f"{biz} doesn't appear to have a website yet — a ground-floor opportunity to build their whole online presence."

    bits = []
    bits.append(f"{reviews} Google reviews" if reviews else "no Google review count yet")
    if data.get("socials"):
        bits.append("active on " + ", ".join(k.title() for k in data["socials"].keys()))
    if pain_points:
        bits.append(pain_points[0][1])

    return (biz + " has " + "; ".join(bits) + ".").strip()


def check_website(url):
    result = {
        "email": "no email", "email_is_generic": False, "contact_page": "",
        "socials": {}, "instagram_handle": "", "facebook_page": "",
        "ssl_valid": None, "load_seconds": None, "score": 0,
        "score_reasons": [], "status": "dead",
        # [NEW] signal / intelligence fields
        "signals": {}, "decision_maker": {"name": "", "title": ""},
        "pain_points": [], "why_contact": "", "score_breakdown": {},
        "tech_stack": {}, "contact_channels": {},
    }
    if not url or not url.startswith("http"):
        return result

    session = make_session()

    try:
        start = time.time()
        r = session.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
            timeout=15,
            allow_redirects=True
        )
        result["load_seconds"] = round(time.time() - start, 1)

        if r.status_code not in [200, 401, 403]:
            return result

        result["status"] = "OK"
        result["ssl_valid"] = url.startswith("https://")
        html = r.text
        emails = clean_emails(html)

        if emails:
            chosen = best_email(emails)
            result["email"] = chosen
            result["email_is_generic"] = any(chosen.startswith(p) for p in ["contact@", "info@", "support@", "hello@", "admin@", "sales@", "help@", "hi@"])

        result["socials"] = extract_socials(html)
        result["instagram_handle"] = extract_instagram_handle(html)
        result["facebook_page"] = extract_facebook_page(html)

        # [NEW] Website intelligence signals + decision-maker guess (homepage)
        result["signals"] = detect_signals(html)
        result["decision_maker"] = guess_decision_maker(html)
        result["tech_stack"] = detect_tech_stack(html)

        # Fallback contact pages
        if not emails or not result["decision_maker"]["name"]:
            base = url.rstrip("/")
            for path in ["/pages/contact", "/contact", "/about", "/about-us", "/contact-us", "/team"]:
                try:
                    pr = session.get(base + path, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
                    if pr.status_code != 200:
                        continue
                    if not emails:
                        pe = clean_emails(pr.text)
                        if pe:
                            result["email"] = best_email(pe)
                            result["email_is_generic"] = any(result["email"].startswith(p) for p in ["contact@", "info@", "support@", "hello@", "admin@", "sales@", "help@", "hi@"])
                        else:
                            result["contact_page"] = base + path
                    if not result["decision_maker"]["name"]:
                        dm = guess_decision_maker(pr.text)
                        if dm["name"]:
                            result["decision_maker"] = dm
                    if result["email"] != "no email" and result["decision_maker"]["name"]:
                        break
                except Exception as e:
                    print(f"    ⚠️ Fallback page failed: {e}")
                    continue

        # NOTE: score/score_reasons are now filled in by score_lead() in
        # process_job(), which also has the niche and pain points to work with.

        result["contact_channels"] = extract_contact_channels(html, result)

    except Exception as e:
        print(f"    ⚠️ Website check failed: {e}")
    finally:
        session.close()

    return result


def format_lead(lead, num):
    e = html.escape  # shorthand — escapes &, <, > so names/addresses can't break the HTML message
    hot = " 🔥" if lead.get("score", 0) >= 70 else ""
    lines = [f"{num}. <b>{e(lead['name'])}</b>{hot}"]

    if lead.get("address"):
        lines.append(f"   📍 {e(lead['address'])}")

    if lead.get("phone"):
        # tel: link — tapping it opens the phone dialer
        tel = re.sub(r"[^\d+]", "", lead["phone"])
        lines.append(f'   📱 <a href="tel:{tel}">{e(lead["phone"])}</a>')

    if lead.get("website"):
        lines.append(f'   🔗 <a href="{e(lead["website"])}">{e(lead["website"])}</a>')

    if lead.get("rating"):
        rev = lead.get("reviews", "")
        lines.append(f"   ⭐ {e(str(lead['rating']))}" + (f" ({rev} reviews)" if rev else ""))

    if lead.get("email") and lead["email"] != "no email":
        g = " (generic)" if lead.get("email_is_generic") else ""
        lines.append(f'   📧 <a href="mailto:{e(lead["email"])}">{e(lead["email"])}</a>{g}')

    if lead.get("instagram_handle"):
        ig_url = f"https://instagram.com/{lead['instagram_handle']}"
        lines.append(f'   📸 <a href="{ig_url}">@{e(lead["instagram_handle"])}</a>')

    if lead.get("facebook_page"):
        fb_url = lead["facebook_page"]
        if not fb_url.startswith("http"):
            fb_url = "https://" + fb_url
        lines.append(f'   📘 <a href="{e(fb_url)}">Facebook</a>')

    dm = lead.get("decision_maker") or {}
    if dm.get("name"):
        lines.append(f"   👤 {e(dm['name'])} ({e(dm['title'])}) — best guess, confirm manually")

    channels = lead.get("contact_channels") or {}
    if channels.get("whatsapp"):
        lines.append(f'   💬 <a href="{e(channels["whatsapp"])}">WhatsApp</a>')
    if channels.get("messenger"):
        lines.append(f'   💬 <a href="{e(channels["messenger"])}">Messenger</a>')
    if channels.get("linkedin"):
        lines.append(f'   💼 <a href="{e(channels["linkedin"])}">LinkedIn</a>')
    if channels.get("tiktok"):
        lines.append(f'   🎵 <a href="{e(channels["tiktok"])}">TikTok</a>')

    tech = lead.get("tech_stack") or {}
    tech_flat = [t for tools in tech.values() for t in tools]
    if tech_flat:
        lines.append(f"   🧩 Uses: {e(', '.join(tech_flat[:4]))}")

    if lead.get("score", 0) > 0:
        lines.append(f"   📊 Opportunity score: {lead['score']}/100{hot}")

    pain = lead.get("pain_points") or []
    for cat, desc in pain[:2]:
        lines.append(f"   💡 [{e(cat)}] {e(desc)}")

    if lead.get("why_contact"):
        lines.append(f"   ✉️ Why: {e(lead['why_contact'])}")

    return "\n".join(lines)


# [NEW] ── Export the full enriched list to a .txt file (not CSV — easy to
# open in any Notes/Docs app on a phone) and hand it back via Telegram ──
def export_txt(enriched, city, niche, review_cap, campaign):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    export_dir = os.path.join(script_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ts = time.strftime("%Y%m%d_%H%M%S")
    safe_city = re.sub(r"[^a-zA-Z0-9]+", "_", city).strip("_") or "city"
    safe_niche = re.sub(r"[^a-zA-Z0-9]+", "_", niche).strip("_") or "niche"
    filepath = os.path.join(export_dir, f"leads_{safe_niche}_{safe_city}_{ts}.txt")

    lines = []
    lines.append(f"LEAD REPORT — {niche.title()} in {city.title()}")
    lines.append(f"Campaign: {campaign}")
    lines.append(f"Generated: {time.strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"Review cap: {review_cap if review_cap is not None else 'none'}")
    lines.append(f"Total leads: {len(enriched)}")
    lines.append("=" * 60)
    lines.append("")

    for i, lead in enumerate(enriched, 1):
        lines.append(f"[{i}] {lead.get('name', '')}  —  Opportunity Score: {lead.get('score', 0)}/100")
        lines.append(f"    Address:   {lead.get('address', '')}")
        lines.append(f"    Phone:     {lead.get('phone', '')}")
        lines.append(f"    Website:   {lead.get('website') or 'NONE — opportunity'}")
        lines.append(f"    Rating:    {lead.get('rating', '')} ({lead.get('reviews', 0)} reviews)")
        lines.append(f"    Email:     {lead.get('email', '')}")
        socials = lead.get("socials") or {}
        if socials:
            lines.append("    Socials:   " + ", ".join(f"{k}: {v}" for k, v in socials.items()))
        channels = lead.get("contact_channels") or {}
        if channels:
            lines.append("    Contact channels:")
            for k, v in channels.items():
                lines.append(f"      - {k}: {v}")
        tech = lead.get("tech_stack") or {}
        if tech:
            lines.append("    Tech stack detected:")
            for category, tools in tech.items():
                lines.append(f"      - {category.replace('_', ' ')}: {', '.join(tools)}")
        dm = lead.get("decision_maker") or {}
        if dm.get("name"):
            lines.append(f"    Decision-maker (best guess, confirm manually): {dm['name']} — {dm['title']}")
        else:
            lines.append("    Decision-maker: not confidently identified")
        breakdown = lead.get("score_breakdown") or {}
        if breakdown:
            b = ", ".join(f"{k.replace('_', ' ')}: {v}" for k, v in breakdown.items())
            lines.append(f"    Score breakdown: {b}")
        pain = lead.get("pain_points") or []
        if pain:
            lines.append("    Pain points:")
            for cat, desc in pain:
                lines.append(f"      - [{cat}] {desc}")
        if lead.get("why_contact"):
            lines.append(f"    Why contact: {lead['why_contact']}")
        lines.append("")

    lines.append("=" * 60)
    lines.append("Decision-maker names are best-effort guesses from page text — confirm before outreach.")
    lines.append(f"In Telegram: /leads new to see fresh leads, /mark <number> <status> to track outreach")
    lines.append(f"(number = position [N] above, from THIS report only). /campaigns for an overview.")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return filepath


# [NEW] ── Campaign + status tracking (so the Telegram bot can list/mark leads later) ──
# Redis layout:
#   leads:status            hash   dedup_id -> JSON {status, campaign, city, niche, name, phone, email, score, updated}
#   status:<status>         set    dedup_ids currently in that status
#   campaign:<name>:leads   set    dedup_ids belonging to that campaign
#   campaigns:all           set    all known campaign names
def record_lead_status(lead, campaign, city, niche):
    dedup_id = lead.get("dedup_id")
    if not dedup_id:
        return
    # Don't clobber a status the user has already set from Telegram (e.g. "contacted")
    existing = redis_hget("leads:status", dedup_id)
    if existing:
        return
    record = {
        "status": "new", "campaign": campaign, "city": city, "niche": niche,
        "name": lead.get("name", ""), "phone": lead.get("phone", ""),
        "email": lead.get("email", ""), "score": lead.get("score", 0),
        "updated": time.strftime("%Y-%m-%d %H:%M"),
    }
    redis_hset("leads:status", dedup_id, json.dumps(record))
    redis_sadd("status:new", dedup_id)
    redis_sadd(f"campaign:{campaign}:leads", dedup_id)
    redis_sadd("campaigns:all", campaign)


# [NEW] Save the last /find report for this chat so the bot can resolve
# "/mark 3 contacted" back to a real dedup_id.
def save_lastfind(chat_id, enriched):
    entries = [{
        "index": i + 1,
        "dedup_id": lead.get("dedup_id", ""),
        "name": lead.get("name", ""),
        "phone": lead.get("phone", ""),
        "email": lead.get("email", ""),
        "score": lead.get("score", 0),
    } for i, lead in enumerate(enriched)]
    redis_set(f"lastfind:{chat_id}", json.dumps(entries))


def process_job(job):
    chat_id = job["chat_id"]
    city = job["city"]
    niche = job["niche"]
    count = min(job.get("count", 20), 50)
    # [NEW] review cap now comes from the Telegram conversation, not a hardcoded constant
    review_cap = job.get("review_cap", None)
    # [NEW] campaign — lets you compare "Miami Med Spas" vs "Dallas Med Spas" etc.
    campaign = job.get("campaign") or f"{niche.title()} — {city.title()}"

    cap_txt = f"max {review_cap} reviews" if review_cap is not None else "no review cap"
    send_telegram(chat_id, f"✅ Scraping {niche} in {city} (target: {count}, {cap_txt})...\n\nThis takes a few minutes. A browser window will open.")
    print(f"\n{'='*50}")
    print(f"JOB: {niche} in {city} (max {count}, review_cap={review_cap})")
    print(f"{'='*50}")

    results = scrape_google_maps(city, niche, count, review_cap=review_cap)

    if not results:
        send_telegram(chat_id, "❌ No results found. Try a different city or niche.\n\nTip: If Google shows a CAPTCHA, solve it in the browser window and cookies will save for next time.")
        return

    send_telegram(chat_id, f"📍 Found {len(results)} businesses. Analyzing websites now...")

    enriched = []
    for r in results:
        if r.get("website"):
            print(f"  🔍 Checking {r['website']}...")
            r.update(check_website(r["website"]))
            sig = r.get("signals", {})
            r["pain_points"] = detect_pain_points(sig, r.get("reviews", 0))
            r["score"], r["score_breakdown"] = score_lead(r, sig, niche)
            r["why_contact"] = generate_why_contact(r, niche, r["pain_points"])
        else:
            # No website = its own kind of opportunity
            r["signals"] = {}
            r["pain_points"] = [("Website", "no website found at all")]
            r["score"] = 40
            r["score_breakdown"] = {"no_website_opportunity": 40}
            r["why_contact"] = generate_why_contact(r, niche, r["pain_points"])
        enriched.append(r)
        record_lead_status(r, campaign, city, niche)  # [NEW]
        time.sleep(0.5)

    enriched.sort(key=lambda x: x.get("score", 0), reverse=True)

    batch_size = 5
    total = len(enriched)
    for i in range(0, total, batch_size):
        batch = enriched[i:i + batch_size]
        header = f"📍 {html.escape(city.title())} {html.escape(niche.title())} — {i+1}-{min(i+batch_size, total)} of {total}\n\n"
        msg = header + "\n\n".join(format_lead(lead, i + j + 1) for j, lead in enumerate(batch))
        send_telegram(chat_id, msg, parse_mode="HTML")
        time.sleep(1)

    with_email = sum(1 for e in enriched if e.get("email") and e["email"] != "no email")
    hot = sum(1 for e in enriched if e.get("score", 0) >= 70)
    no_site = sum(1 for e in enriched if not e.get("website"))
    summary = (
        f"✅ Done! {total} leads checked — campaign: {campaign}\n"
        f"   📧 {with_email} have emails\n"
        f"   🔥 {hot} scored 70+ (hot leads)\n"
        f"   🌐 {no_site} have no website (opportunities!)\n\n"
        f"Sending your .txt report now..."
    )
    send_telegram(chat_id, summary)

    save_lastfind(chat_id, enriched)  # [NEW] so /mark <n> <status> can find these leads

    # [NEW] Full report as a downloadable .txt file, not CSV
    try:
        filepath = export_txt(enriched, city, niche, review_cap, campaign)
        send_telegram_document(chat_id, filepath, caption=f"📄 Full report — {niche} in {city} ({total} leads)")
        print(f"  ✅ Report saved and sent: {filepath}")
    except Exception as e:
        print(f"  ⚠️ Export/send failed: {e}")
        send_telegram(chat_id, "⚠️ Couldn't generate the .txt report — check the daemon logs.")

    print(f"\n✅ Complete: {total} leads, {with_email} with email, {hot} hot, {no_site} no-website")


def main():
    print("╔═══════════════════════════════════════╗")
    print("║     Maps Daemon — Karios Agency       ║")
    print("║     Polls Redis → Scrapes Maps        ║")
    print("╚═══════════════════════════════════════╝")

    # [NEW] RUN_MODE=once — checks Redis ONE time and exits. Used by the
    # GitHub Actions scheduled workflow, which wakes this script up every
    # few minutes instead of it running forever on its own.
    if RUN_MODE == "once":
        print("\nRUN_MODE=once — checking for a single waiting job...")
        try:
            result = redis("LPOP", "jobs:find")
            if result:
                job = json.loads(result)
                process_job(job)
            else:
                print("No job waiting. Exiting.")
        except Exception as e:
            print(f"Run error: {e}")
        return

    # Default: loop forever (for running on your own PC)
    print("\nWaiting for /find jobs from Telegram bot...")
    print("A browser window will open when a job starts.")
    print("Press Ctrl+C to exit\n")
    while True:
        try:
            result = redis("LPOP", "jobs:find")
            if result:
                job = json.loads(result)
                process_job(job)
            else:
                time.sleep(3)
        except KeyboardInterrupt:
            print("\n👋 Shutting down...")
            break
        except Exception as e:
            print(f"Loop error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    main()
