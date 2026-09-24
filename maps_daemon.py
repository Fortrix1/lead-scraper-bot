#!/usr/bin/env python3
"""maps_daemon.py - Scrapes Google Maps, checks websites, sends to Telegram.
Also runs fresh-Shopify-store "ticks" against crt.sh when the job queue is empty."""

import os
import json
import time
import re
import html
import random
from datetime import datetime, timezone
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from playwright.sync_api import sync_playwright

# Auto-load a .env file if one exists next to this script (local PC use).
# On GitHub Actions there's no .env — secrets arrive as real environment vars.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

REDIS_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "")
REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")
BOT_TOKEN = os.environ.get("SCRAPER_BOT_TOKEN", "")

if not (REDIS_URL and REDIS_TOKEN and BOT_TOKEN):
    raise SystemExit(
        "Missing required environment variables.\n"
        "Set UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, SCRAPER_BOT_TOKEN\n"
        "before running (see SETUP.md)."
    )

# "loop" = run forever (local PC, default). "once" = check once and exit
# (GitHub Actions scheduled workflow).
RUN_MODE = os.environ.get("RUN_MODE", "loop")

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
    try:
        element.scroll_into_view_if_needed()
        time.sleep(0.3)
        element.click(timeout=8000)
        return True
    except:
        pass
    try:
        element.evaluate("el => el.click()")
        return True
    except:
        pass
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
    try:
        cleaned = text.replace(",", "").strip()
        return int(cleaned) if cleaned else default
    except (ValueError, AttributeError):
        return default


# ── Google Maps Scraping ──

def scrape_google_maps(city, niche, max_results=30, review_cap=200, include_seen=False):
    search_query = f"{niche} in {city}"
    results = []
    seen_names = set()
    seen_addresses = set()
    script_dir = os.path.dirname(os.path.abspath(__file__))
    cookie_path = os.path.join(script_dir, "gm_cookies.json")
    dedup_key = "seen_maps:global"

    scrape_start_time = time.time()
    MAX_SCRAPE_SECONDS = 20 * 60  # leave headroom under the 30 min job timeout

    def time_left():
        return MAX_SCRAPE_SECONDS - (time.time() - scrape_start_time)

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

        # Detect a CAPTCHA / "unusual traffic" block early.
        try:
            page_text = page.inner_text("body").lower()
        except Exception:
            page_text = ""
        block_signals = [
            "unusual traffic", "detected unusual traffic", "recaptcha",
            "our systems have detected", "captcha-form", "sorry/index",
        ]
        is_blocked = ("google.com/sorry" in page.url) or any(sig in page_text for sig in block_signals)
        if is_blocked:
            print("  🚫 Google is showing a CAPTCHA / block page — cookies are likely stale or this IP got flagged.")
            try:
                page.screenshot(path=os.path.join(script_dir, "debug_captcha.png"), full_page=True)
                print("  Screenshot saved: debug_captcha.png")
            except Exception:
                pass
            browser.close()
            return results

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

        time.sleep(3)

        # Aggressive scrolling until enough unique businesses
        print("  Scrolling to load more cards...")
        last_count = 0
        stuck_scrolls = 0
        target_buffer = max_results * 3

        for i in range(80):
            if time_left() <= 0:
                print("  ⏱️ Time budget hit during scrolling, moving on with what we have")
                break
            try:
                feed.evaluate("el => el.scrollTop = el.scrollHeight")
            except:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(1.5)

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
                if stuck_scrolls >= 8:
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

        # Find all place links, dedupe by VISIBLE TEXT
        all_links = page.query_selector_all('div[role="feed"] a[href*="/maps/place"]')
        print(f"  Found {len(all_links)} raw links in feed")

        card_links = []
        seen_sidebar_names = set()
        for link in all_links:
            try:
                text = link.inner_text().strip()
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

        for idx, card_link in enumerate(card_links):
            if len(results) >= max_results:
                break
            if time_left() <= 0:
                print(f"  ⏱️ Time budget hit, stopping early with {len(results)} results")
                break

            sidebar_name = ""
            try:
                sidebar_name = card_link.inner_text().strip()
            except:
                pass

            time.sleep(0.4)

            clicked = robust_click(card_link, page)
            if not clicked:
                skipped_reasons["click_fail"] += 1
                print(f"    ⏭️  Card {idx} ({sidebar_name}): could not click")
                continue

            panel_name = wait_for_new_panel_name(page, last_panel_name, max_wait=12)

            if not panel_name:
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
                for btn in page.query_selector_all('button[data-item-id*="phone"], button[data-tooltip*="phone"]'):
                    item_id = btn.get_attribute("data-item-id") or ""
                    m = re.search(r"phone:tel:([\d+\-\s()]+)", item_id)
                    if m:
                        data["phone"] = m.group(1).strip()
                        break
                    txt = btn.inner_text().strip()
                    if txt and any(c.isdigit() for c in txt):
                        data["phone"] = txt
                        break
                    aria = btn.get_attribute("aria-label") or ""
                    if aria and any(c.isdigit() for c in aria):
                        data["phone"] = re.sub(r"^phone:?\s*", "", aria, flags=re.IGNORECASE).strip()
                        break

                # Rating
                el = page.query_selector("div.fontDisplayLarge, span.ceNzKf")
                if el:
                    txt = el.inner_text().strip()
                    if txt and any(c.isdigit() for c in txt):
                        data["rating"] = txt

                # Reviews
                review_count = 0

                for sel in ['button[aria-label*="review"]', 'button[aria-label*="Review"]', 'span[aria-label*="review"]', 'span[aria-label*="Review"]']:
                    review_el = page.query_selector(sel)
                    if review_el:
                        aria = review_el.get_attribute("aria-label") or ""
                        m = re.search(r"([\d,]+)", aria)
                        if m:
                            review_count = safe_int(m.group(1))
                            break

                if review_count == 0 and data["rating"]:
                    try:
                        panel = page.query_selector('div[role="main"]')
                        if panel:
                            panel_text = panel.inner_text()
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

                if review_count == 0:
                    try:
                        panel = page.query_selector('div[role="main"]')
                        if panel:
                            near_rating = panel.query_selector_all("span, div, button")
                            for el in near_rating[:20]:
                                txt = el.inner_text().strip()
                                if txt and txt.replace(",", "").isdigit():
                                    num = int(txt.replace(",", ""))
                                    if 10 < num < 100000:
                                        review_count = num
                                        break
                    except:
                        pass

                data["reviews"] = review_count

                if review_cap is not None and data["reviews"] > review_cap:
                    skipped_reasons["too_many_reviews"] += 1
                    print(f"    ⏭️  High reviews: {data['name']} ({data['reviews']})")
                    continue

                # GLOBAL cross-search dedup via Redis
                dedup_id = f"{data['name'].lower().strip()}|{addr_key}"
                already_seen = redis_sismember(dedup_key, dedup_id)
                if already_seen and not include_seen:
                    skipped_reasons["already_seen"] += 1
                    print(f"    ⏭️  Already seen (global): {data['name']}")
                    continue

                data["dedup_id"] = dedup_id
                data["previously_seen"] = bool(already_seen)

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


CATEGORY_LABELS = {
    "website_needed": "Website Needed",
    "website_opportunity": "Website Opportunity",
    "fresh_prospect": "Fresh Prospect",
}

def categorize_lead(lead):
    if not lead.get("website") or lead.get("status") == "dead":
        return "website_needed"
    pain = lead.get("pain_points") or []
    relevant = [cat for cat, _ in pain if cat in ("Conversion", "Lead-response")]
    reviews = lead.get("reviews") or 0
    is_opportunity = len(relevant) >= 2 or (reviews >= 50 and len(relevant) >= 1)
    return "website_opportunity" if is_opportunity else "fresh_prospect"


# ── Masking helpers for sample mode ──
def mask_phone(phone):
    if not phone:
        return phone
    out, digit_count = [], 0
    for ch in phone:
        if ch.isdigit():
            digit_count += 1
            out.append(ch if digit_count <= 3 else "•")
        else:
            out.append(ch)
    return "".join(out)

def mask_email(email):
    if not email or email == "no email":
        return email
    local, sep, domain = email.partition("@")
    if not sep:
        return email
    masked_local = local[0] + "•" * max(len(local) - 1, 3)
    return f"{masked_local}@{domain}"

def mask_lead_for_sample(lead):
    """Shallow copy with contact-heavy fields hidden — used only for what
    gets SENT OUT (Telegram batches + exports) in sample mode. The real,
    unmasked lead stays recorded in Redis via record_lead_status."""
    masked = dict(lead)
    masked["_masked"] = True
    if masked.get("phone"):
        masked["phone"] = mask_phone(masked["phone"])
    if masked.get("email") and masked["email"] != "no email":
        masked["email"] = mask_email(masked["email"])
    masked["decision_maker"] = {"name": "", "title": ""}
    channels = dict(masked.get("contact_channels") or {})
    channels.pop("email", None)
    channels.pop("whatsapp", None)
    channels.pop("messenger", None)
    masked["contact_channels"] = channels
    masked["tech_stack"] = {}
    return masked


def is_high_value_niche(niche):
    n = niche.lower()
    return any(k in n for k in HIGH_VALUE_NICHES)


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

        result["contact_channels"] = extract_contact_channels(html, result)

    except Exception as e:
        print(f"    ⚠️ Website check failed: {e}")
    finally:
        session.close()

    return result


def format_lead(lead, num):
    e = html.escape
    masked = bool(lead.get("_masked"))
    hot = " 🔥" if lead.get("score", 0) >= 70 else ""
    cat_label = CATEGORY_LABELS.get(lead.get("category"), "")

    lines = [f"{num}. <b>{e(lead['name'])}</b>{hot}"]
    if cat_label:
        lines.append(f"   🏷️ {e(cat_label)}")
    if lead.get("previously_seen"):
        lines.append("   ♻️ Previously scraped")

    lines.append("   <u>Prospect</u>")
    if lead.get("address"):
        lines.append(f"   📍 {e(lead['address'])}")
    rev = lead.get("reviews", "")
    if lead.get("rating") or rev:
        stars = f"⭐ {e(str(lead.get('rating', '')))}" if lead.get("rating") else "⭐"
        lines.append(f"   {stars}" + (f" ({rev} reviews)" if rev else ""))
    lines.append(f"   🌐 Website: {'Yes' if lead.get('website') else 'No'}")
    booking = (lead.get("signals") or {}).get("has_booking")
    lines.append(f"   📅 Booking: {'Detected' if booking else 'Not detected'}")

    if lead.get("instagram_handle"):
        ig_url = f"https://instagram.com/{lead['instagram_handle']}"
        lines.append(f'   📸 Instagram: <a href="{ig_url}">@{e(lead["instagram_handle"])}</a>')
    else:
        lines.append("   📸 Instagram: No")

    if lead.get("facebook_page"):
        fb_url = lead["facebook_page"]
        if not fb_url.startswith("http"):
            fb_url = "https://" + fb_url
        lines.append(f'   📘 Facebook: <a href="{e(fb_url)}">Yes</a>')
    else:
        lines.append("   📘 Facebook: No")

    if lead.get("phone"):
        if masked:
            lines.append(f"   📱 Phone: {e(lead['phone'])}")
        else:
            tel = re.sub(r"[^\d+]", "", lead["phone"])
            lines.append(f'   📱 Phone: <a href="tel:{tel}">{e(lead["phone"])}</a>')
    else:
        lines.append("   📱 Phone: not publicly listed")

    if lead.get("email") and lead["email"] != "no email":
        if masked:
            lines.append(f"   📧 Email: {e(lead['email'])}")
        else:
            g = " (generic)" if lead.get("email_is_generic") else ""
            lines.append(f'   📧 Email: <a href="mailto:{e(lead["email"])}">{e(lead["email"])}</a>{g}')
    else:
        lines.append("   📧 Email: not publicly available")

    if lead.get("website"):
        lines.append(f'   🔗 <a href="{e(lead["website"])}">{e(lead["website"])}</a>')

    lines.append("")
    lines.append("   <u>Opportunity</u>")
    lines.append(f"   Website present: {'Yes' if lead.get('website') else 'No'}")
    pain = lead.get("pain_points") or []
    opp_cats = sorted({cat for cat, _ in pain}) if pain else []
    lines.append(f"   Potential opportunity: {e('/'.join(opp_cats)) if opp_cats else 'General prospecting'}")
    if lead.get("why_contact"):
        lines.append(f"   Reason: {e(lead['why_contact'])}")
    if lead.get("score", 0) > 0:
        lines.append(f"   📊 Opportunity score: {lead['score']}/100{hot}")
    for cat, desc in pain[:2]:
        lines.append(f"   💡 [{e(cat)}] {e(desc)}")

    if not masked:
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

    return "\n".join(lines)


# ── Exports ──
def export_txt(enriched, city, niche, review_cap, campaign, sample_mode=False):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    export_dir = os.path.join(script_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ts = time.strftime("%Y%m%d_%H%M%S")
    safe_city = re.sub(r"[^a-zA-Z0-9]+", "_", city).strip("_") or "city"
    safe_niche = re.sub(r"[^a-zA-Z0-9]+", "_", niche).strip("_") or "niche"
    tag = "sample" if sample_mode else "full"
    filepath = os.path.join(export_dir, f"leads_{safe_niche}_{safe_city}_{ts}_{tag}.txt")

    lines = []
    lines.append(("SAMPLE — " if sample_mode else "") + f"LEAD REPORT — {niche.title()} in {city.title()}")
    lines.append(f"Campaign: {campaign}")
    lines.append(f"Generated: {time.strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"Review cap: {review_cap if review_cap is not None else 'none'}")
    lines.append(f"Total leads: {len(enriched)}")
    if sample_mode:
        lines.append("Note: this is a limited sample — phone/email are partially hidden and shown in full in the paid batch.")
    lines.append("=" * 60)
    lines.append("")

    for i, lead in enumerate(enriched, 1):
        masked = bool(lead.get("_masked"))
        cat_label = CATEGORY_LABELS.get(lead.get("category"), "")
        header = f"[{i}] {lead.get('name', '')}"
        if cat_label:
            header += f"  ({cat_label})"
        header += f"  —  Opportunity Score: {lead.get('score', 0)}/100"
        lines.append(header)
        lines.append("    -- Prospect --")
        lines.append(f"    Address:   {lead.get('address', '')}")
        lines.append(f"    Phone:     {lead.get('phone', '')}")
        lines.append(f"    Website:   {lead.get('website') or 'NONE — opportunity'}")
        booking = (lead.get("signals") or {}).get("has_booking")
        lines.append(f"    Booking:   {'Detected' if booking else 'Not detected'}")
        lines.append(f"    Rating:    {lead.get('rating', '')} ({lead.get('reviews', 0)} reviews)")
        lines.append(f"    Email:     {lead.get('email', '')}")
        socials = lead.get("socials") or {}
        if socials:
            lines.append("    Socials:   " + ", ".join(f"{k}: {v}" for k, v in socials.items()))

        lines.append("    -- Opportunity --")
        lines.append(f"    Website present: {'Yes' if lead.get('website') else 'No'}")
        pain = lead.get("pain_points") or []
        opp_cats = sorted({cat for cat, _ in pain}) if pain else []
        lines.append(f"    Potential opportunity: {'/'.join(opp_cats) if opp_cats else 'General prospecting'}")
        if lead.get("why_contact"):
            lines.append(f"    Reason: {lead['why_contact']}")
        if pain:
            lines.append("    Pain points:")
            for cat, desc in pain:
                lines.append(f"      - [{cat}] {desc}")

        if not masked:
            channels = lead.get("contact_channels") or {}
            if channels:
                lines.append("    Contact channels:")
                for k, v in channels.items():
                    lines.append(f"      - {k}: {v}")
            tech = lead.get("tech_stack") or {}
            if tech:
                lines.append("    Tech stack detected:")
                for tcategory, tools in tech.items():
                    lines.append(f"      - {tcategory.replace('_', ' ')}: {', '.join(tools)}")
            dm = lead.get("decision_maker") or {}
            if dm.get("name"):
                lines.append(f"    Decision-maker (best guess, confirm manually): {dm['name']} — {dm['title']}")
            bd = lead.get("score_breakdown") or {}
            if bd:
                lines.append("    Score breakdown:")
                for k, v in bd.items():
                    lines.append(f"      - {k}: {v}")

        lines.append("")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return filepath


def export_html(enriched, city, niche, review_cap, campaign, sample_mode=False):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    export_dir = os.path.join(script_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ts = time.strftime("%Y%m%d_%H%M%S")
    safe_city = re.sub(r"[^a-zA-Z0-9]+", "_", city).strip("_") or "city"
    safe_niche = re.sub(r"[^a-zA-Z0-9]+", "_", niche).strip("_") or "niche"
    tag = "sample" if sample_mode else "full"
    filepath = os.path.join(export_dir, f"leads_{safe_niche}_{safe_city}_{ts}_{tag}.html")

    parts = [
        "<html><head><meta charset='utf-8'>",
        f"<title>{html.escape(campaign)}</title>",
        "<style>body{font-family:sans-serif;max-width:900px;margin:2rem auto;}pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem;border-radius:8px;}</style>",
        "</head><body>",
        f"<h2>{'SAMPLE — ' if sample_mode else ''}Lead Report — {html.escape(niche.title())} in {html.escape(city.title())}</h2>",
        f"<p>Generated {time.strftime('%Y-%m-%d %H:%M')} · {len(enriched)} leads · review cap {review_cap if review_cap is not None else 'none'}</p>",
    ]
    for i, lead in enumerate(enriched, 1):
        parts.append("<pre>" + format_lead(lead, i) + "</pre><hr>")
    parts.append("</body></html>")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
    return filepath


# ── Lead recording (feeds /campaigns, /leads, /mark) ──
def record_lead_status(lead, campaign):
    dedup_id = lead.get("dedup_id") or f"{lead.get('name','').lower().strip()}|"
    record = {
        "name": lead.get("name", ""),
        "phone": lead.get("phone", ""),
        "email": lead.get("email", "") if lead.get("email") != "no email" else "",
        "score": lead.get("score", 0),
        "campaign": campaign,
        "status": "new",
        "updated": time.strftime("%Y-%m-%d %H:%M"),
    }
    redis_hset("leads:status", dedup_id, json.dumps(record))
    redis_sadd("status:new", dedup_id)
    redis_sadd(f"campaign:{campaign}:leads", dedup_id)
    redis_sadd("campaigns:all", campaign)


# ── Job processing: enrich + batch-send a /find result ──
def process_job(data):
    chat_id = str(data.get("chat_id", ""))
    city = data.get("city", "")
    niche = data.get("niche", "")
    count = int(data.get("count", 20) or 20)
    review_cap = data.get("review_cap")
    if isinstance(review_cap, str):
        review_cap = int(review_cap) if review_cap.strip().isdigit() else None
    sample_mode = bool(data.get("sample_mode"))
    include_seen = bool(data.get("include_seen"))
    campaign = f"{niche.replace('_', ' ').title()} — {city.title()}"

    print(f"  Job: {niche} in {city} (max {count}, cap {review_cap}, sample={sample_mode}, rescan={include_seen})")
    send_telegram(chat_id, f"🗺️ Scraping Google Maps for {niche} in {city} — up to {count} leads. This takes a while...")

    raw = scrape_google_maps(city, niche, max_results=count, review_cap=review_cap, include_seen=include_seen)
    if not raw:
        send_telegram(chat_id,
            f"No leads collected for {niche} in {city} — either blocked (check the Actions log for "
            f"a CAPTCHA message) or everything in range was already scraped. Try again later, "
            f"another city, or add 'rescan'.")
        return

    enriched = []
    for lead in raw:
        if lead.get("website"):
            web = check_website(lead["website"])
        else:
            web = {"email": "no email", "email_is_generic": False, "contact_page": "",
                   "socials": {}, "instagram_handle": "", "facebook_page": "",
                   "ssl_valid": None, "load_seconds": None, "status": "dead",
                   "signals": {}, "decision_maker": {"name": "", "title": ""},
                   "tech_stack": {}, "contact_channels": {}}

        lead.update({
            "email": web.get("email", "no email"),
            "email_is_generic": web.get("email_is_generic", False),
            "contact_page": web.get("contact_page", ""),
            "socials": web.get("socials", {}),
            "instagram_handle": web.get("instagram_handle", ""),
            "facebook_page": web.get("facebook_page", ""),
            "ssl_valid": web.get("ssl_valid"),
            "load_seconds": web.get("load_seconds"),
            "status": web.get("status", "dead"),
            "signals": web.get("signals", {}),
            "decision_maker": web.get("decision_maker", {"name": "", "title": ""}),
            "tech_stack": web.get("tech_stack", {}),
            "contact_channels": web.get("contact_channels", {}),
        })
        pain = detect_pain_points(lead["signals"], lead.get("reviews", 0))
        lead["pain_points"] = pain
        score, breakdown = score_lead(lead, lead["signals"], niche)
        lead["score"] = score
        lead["score_breakdown"] = breakdown
        lead["why_contact"] = generate_why_contact(lead, niche, pain)
        lead["category"] = categorize_lead(lead)
        record_lead_status(lead, campaign)
        enriched.append(lead)

    enriched.sort(key=lambda x: x.get("score", 0), reverse=True)

    out = enriched
    if sample_mode:
        out = [mask_lead_for_sample(l) for l in enriched[:20]]

    # Store report index for /mark
    lastfind = [{"index": i + 1, "dedup_id": l.get("dedup_id", ""), "name": l.get("name", ""),
                 "phone": l.get("phone", ""), "email": l.get("email", ""), "score": l.get("score", 0)}
                for i, l in enumerate(out)]
    redis_set(f"lastfind:{chat_id}", json.dumps(lastfind))

    total = len(out)
    BATCH = 5
    for start in range(0, total, BATCH):
        chunk = out[start:start + BATCH]
        header = f"📍 {niche.replace('_', ' ').title()} in {city.title()} — {start + 1}-{start + len(chunk)} of {total}"
        body = "\n\n".join(format_lead(l, start + 1 + i) for i, l in enumerate(chunk))
        send_telegram(chat_id, header + "\n\n" + body, parse_mode="HTML")
        time.sleep(1)

    try:
        txt_path = export_txt(out, city, niche, review_cap, campaign, sample_mode)
        html_path = export_html(out, city, niche, review_cap, campaign, sample_mode)
        for p in (txt_path, html_path):
            if p:
                send_telegram_document(chat_id, p, caption=f"{campaign} — {total} leads{' (SAMPLE)' if sample_mode else ''}")
    except Exception as e:
        print(f"  Export failed: {e}")
        send_telegram(chat_id, "(exports failed — lead batches above are complete)")

    send_telegram(chat_id, "✓ Report complete. Use /mark <number> <status> on these results, /leads and /campaigns to browse.")


# ══════════════════════════════════════════════════════════════
#  FRESH SHOPIFY STORES via crt.sh — tick-based (Actions-safe)
#
#  crt.sh only supports '%' as a LEADING wildcard ('%.myshopify.com'), not
#  a mid-token prefix like 'a%.myshopify.com' — the latter returns an HTML
#  "Unsupported use of '%'" error (with HTTP 200!), which is why an earlier
#  version of this that tried per-letter slicing silently produced nothing
#  every single run. So instead: each daemon run with an empty job queue
#  may run ONE tick:
#    Phase 1: occasionally (≈once/20h) run the ONE query crt.sh actually
#             supports — the full '%.myshopify.com' sweep — and cache
#             every candidate domain it finds in Redis. Skipped on ticks
#             that ran too recently, since it's a heavy request.
#    Phase 2: age-check up to 25 pooled candidates (true birthday =
#             earliest cert EVER for that exact domain — this part uses
#             small exact-domain queries, which crt.sh handles fine)
#    Phase 3: report fresh finds to Telegram
#  Cron fires every 10 min; a lock limits ticks to one per 25 min.
# ══════════════════════════════════════════════════════════════

# Optional relay (Cloudflare Worker) for when GitHub's IP is hard-blocked.
# Set the CRTSH_RELAY_URL secret and everything routes through it.
CRTSH_BASE = os.environ.get("CRTSH_RELAY_URL") or "https://crt.sh/json"

CRTSH_INFRA_LABELS = {
    "shops", "shops-gclb", "shops-glb", "app-proxy-internal", "app-proxy",
    "admin", "api", "app", "www", "cdn", "cdn2", "static", "assets",
    "email", "help", "status", "widgets", "accounts", "auth", "monorail",
}
STORE_DOMAIN_RE = re.compile(r"^([a-z0-9][a-z0-9-]{0,61})\.myshopify\.com$")

def extract_store_domains(name_value):
    out = set()
    for raw in str(name_value or "").split("\n"):
        d = raw.strip().lower().lstrip("*").lstrip(".")
        m = STORE_DOMAIN_RE.match(d)
        if m and m.group(1) not in CRTSH_INFRA_LABELS:
            out.add(d)
    return out

def crtsh_json(session, params, timeout=90, tries=3):
    """Exact-domain queries are small; retry with backoff on 504/flakes."""
    for i in range(tries):
        try:
            r = session.get(CRTSH_BASE, params=params, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            print(f"  crt.sh {params.get('q','')[:40]} -> HTTP {r.status_code} (attempt {i+1})")
        except Exception as e:
            print(f"  crt.sh {params.get('q','')[:40]} failed: {str(e)[:60]} (attempt {i+1})")
        time.sleep(8 * (i + 1))
    return None

def parse_ts(s):
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        # crt.sh doesn't always include a timezone suffix on not_before —
        # without this, fromisoformat returns a naive datetime, and later
        # subtracting it from datetime.now(timezone.utc) crashes with
        # "can't subtract offset-naive and offset-aware datetimes". crt.sh
        # timestamps are UTC, so a naive result just means "assume UTC".
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None

def store_first_cert(session, domain):
    """Earliest cert EVER for this exact domain (expired included) = true birthday."""
    data = crtsh_json(session, {"q": domain}, timeout=45, tries=2)
    earliest = None
    for row in (data or []):
        t = parse_ts(row.get("not_before", ""))
        if t and (earliest is None or t < earliest):
            earliest = t
    return earliest

def quick_store_check(domain):
    """Live store / locked 'coming soon' / dead? Also catches the custom
    domain most stores point to within days of launching."""
    out = {"status": "dead", "custom_domain": "", "title": "", "email": "", "socials": {}}
    try:
        r = requests.get(f"https://{domain}",
                         headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
                         timeout=12, allow_redirects=True)
        final_host = r.url.split("/")[2].lower() if "://" in r.url else ""
        if final_host and final_host != domain and not final_host.endswith(".myshopify.com"):
            out["custom_domain"] = final_host
        text = r.text
        if r.status_code in (401, 403) or "/password" in r.url or \
           "shopify-section-password" in text or "opening soon" in text.lower() or \
           re.search(r"this store (is currently|will be back)", text, re.I):
            out["status"] = "locked"
            return out
        if r.status_code == 200:
            out["status"] = "live"
            m = re.search(r"<title[^>]*>([^<]+)</title>", text, re.I)
            if m:
                out["title"] = html.unescape(m.group(1)).split("|")[0].split("–")[0].strip()[:60]
            emails = clean_emails(text)
            if emails:
                out["email"] = best_email(emails)
            out["socials"] = extract_socials(text)
    except Exception as e:
        print(f"    check failed: {e}")
    return out

def crtsh_full_sweep(session, timeout=280, tries=2):
    """crt.sh only supports '%' as a LEADING wildcard (e.g. '%.myshopify.com',
    proven to work — that's exactly what you ran manually in the browser).
    It does NOT support a mid-token wildcard like 'a%.myshopify.com' — that
    returns an HTML error page ("Unsupported use of '%'") with HTTP 200,
    which is why the old letter-sliced sweep silently produced nothing every
    single run. There's no cheap way to slice this query server-side, so
    this pulls the WHOLE myshopify.com identity list in one (heavy) request
    instead. Called rarely — see should_run_full_sweep() — not every tick."""
    params = {"q": "%.myshopify.com", "exclude": "expired"}
    for attempt in range(tries):
        try:
            r = session.get(CRTSH_BASE, params=params, timeout=timeout)
            if r.status_code == 200:
                try:
                    return r.json()
                except Exception as e:
                    print(f"  full sweep: got HTTP 200 but body isn't valid JSON ({e}) — "
                          f"likely an HTML error page from crt.sh, not real cert data")
                    return None
            print(f"  full sweep -> HTTP {r.status_code} (attempt {attempt+1})")
        except Exception as e:
            print(f"  full sweep failed: {str(e)[:80]} (attempt {attempt+1})")
        time.sleep(30)
    return None

FULL_SWEEP_MIN_INTERVAL_SECONDS = 20 * 60 * 60  # ~20 hours between full sweeps

def should_run_full_sweep():
    last = redis_get("fresh:sweep:last")
    if not last:
        return True
    try:
        last_ts = float(last)
    except Exception:
        return True
    return (time.time() - last_ts) >= FULL_SWEEP_MIN_INTERVAL_SECONDS

def maybe_fresh_tick():
    """Called whenever the job queue is empty. Runs at most one tick per
    60 seconds, driven by the config /fresh sets in Redis. This is short on
    purpose: it only exists to stop two literally-simultaneous runs from
    clobbering each other, not to rate-limit crt.sh — that's handled
    separately by the ~20-hour gate on the heavy full sweep
    (should_run_full_sweep). Per-domain age-check lookups are cheap and
    have been reliable, so there's no need to throttle those further."""
    cfg_raw = redis_get("fresh:config")
    if not cfg_raw:
        print("  fresh:config not set in Redis — send /fresh <age_days> <count> in Telegram to turn monitoring on.")
        return
    try:
        cfg = json.loads(cfg_raw)
    except Exception as e:
        print(f"  fresh:config exists but isn't valid JSON ({e}) — send /fresh again to reset it.")
        return
    got = redis("SET", "fresh:tick:lock", "1", "NX", "EX", "60")
    if not got or got != "OK":
        print("  A fresh-store tick is already running (lock held) — skipping this run.")
        return
    print(f"  fresh:config found: max_age_days={cfg.get('max_age_days')}, count={cfg.get('count')}, chat_id={cfg.get('chat_id')} — running tick...")
    try:
        run_fresh_tick(cfg)
    except Exception as e:
        print(f"  fresh tick failed: {e}")

def run_fresh_tick(cfg):
    chat_id = str(cfg.get("chat_id", ""))
    max_age = int(cfg.get("max_age_days", 30))
    want = int(cfg.get("count", 15))
    MAX_TICK_SECONDS = 20 * 60
    t0 = time.time()
    def time_left():
        return MAX_TICK_SECONDS - (time.time() - t0)

    session = make_session()

    # ── Phase 1: occasionally refresh the FULL candidate pool ──
    # See crtsh_full_sweep()'s docstring for why this can't be sliced by
    # letter. It's a heavy request, so it only runs once every ~20 hours;
    # every other tick just works through the pool from the last sweep.
    swept_this_run = False
    pool_before = redis("SCARD", "fresh:candidates") or 0
    if should_run_full_sweep():
        print("  running full crt.sh sweep (last one was 20+ hours ago, or never)...")
        data = crtsh_full_sweep(session)
        added = 0
        if data:
            for row in data:
                for d in extract_store_domains(row.get("name_value", "")):
                    redis_sadd("fresh:candidates", d)
                    added += 1
            redis_set("fresh:sweep:last", str(time.time()))
            swept_this_run = True
            print(f"  full sweep OK — {len(data)} certs scanned, {added} candidate domain entries added")
        else:
            print("  full sweep failed this run — will retry next tick, using existing pool for now")
    else:
        print("  full sweep skipped — ran within the last 20 hours, using existing candidate pool")

    # ── Phase 2: age-check up to 25 candidates, report fresh ones ──
    fresh = []
    checked = 0
    while checked < 25 and time_left() > 180:
        d = redis("SPOP", "fresh:candidates")
        if not d:
            break
        d = str(d).strip().lower()
        if not d or redis_sismember("fresh:processed", d):
            continue
        checked += 1
        first = store_first_cert(session, d)
        if first:
            redis_sadd("fresh:processed", d)
            age_days = (datetime.now(timezone.utc) - first).days
            if age_days <= max_age:
                info = quick_store_check(d)
                info.update({"domain": d, "age_days": age_days,
                             "first_cert": first.strftime("%Y-%m-%d")})
                fresh.append(info)
                print(f"  🌱 {d} — {age_days}d old — {info['status']}")
        else:
            # lookup failed — park it with a fail counter, drop after 3 tries
            fails = int(redis("HINCRBY", "fresh:failcnt", d, "1") or 0)
            if fails < 3:
                redis_sadd("fresh:candidates", d)
        time.sleep(2)

    # ── Phase 3: report ──
    pool = redis("SCARD", "fresh:candidates") or 0
    sweep_note = "full sweep ran" if swept_this_run else f"using existing pool (was {pool_before} before this tick)"
    summary = (f"🌱 tick done — {sweep_note}, "
               f"{checked} stores age-checked, {len(fresh)} fresh, "
               f"{pool} candidates waiting in pool.")
    if fresh:
        lines = [summary, ""]
        for i, s in enumerate(fresh[:want], 1):
            icon = {"live": "🟢", "locked": "🔒", "dead": "💀"}.get(s["status"], "❔")
            lines.append(f"{i}. {s['domain']} {icon}")
            lines.append(f"   🎂 {s['first_cert']} ({s['age_days']} days old)")
            if s.get("custom_domain"):
                lines.append(f"   🌐 {s['custom_domain']}")
            if s.get("title"):
                lines.append(f"   🏷️ {s['title']}")
            if s.get("email"):
                lines.append(f"   📧 {s['email']}")
            lines.append(f"   🔗 https://{s['domain']}")
            lines.append("")
        send_telegram(chat_id, "\n".join(lines))
    else:
        send_telegram(chat_id, summary)


# ── Main ──
BANNER = r"""
┌──────────────────────────────────┐
│  Maps Daemon — Karios Agency     │
│  Polls Redis → Scrapes Maps      │
│  + fresh-store ticks (crt.sh)    │
└──────────────────────────────────┘
"""

def handle_job(job_raw):
    try:
        data = json.loads(job_raw)
    except Exception as e:
        print(f"  Bad job payload: {e}")
        return
    if data.get("type") == "fresh":
        # Legacy leftover from the old /fresh — the new system is automatic.
        print("  Ignoring legacy 'fresh' job — fresh runs as automatic ticks now.")
        return
    try:
        process_job(data)
    except Exception as e:
        print(f"  Job failed: {e}")
        try:
            send_telegram(str(data.get("chat_id", "")), f"⚠️ Job failed: {str(e)[:150]}")
        except Exception:
            pass

def main():
    print(BANNER)
    if RUN_MODE == "once":
        job_raw = redis("LPOP", "jobs:find")
        if job_raw:
            handle_job(job_raw)
        else:
            print("No job waiting — trying a fresh-store tick (if enabled & due)...")
            maybe_fresh_tick()
            print("Done. Exiting.")
        return

    while True:
        try:
            job_raw = redis("LPOP", "jobs:find")
            if job_raw:
                handle_job(job_raw)
                continue
            maybe_fresh_tick()
        except Exception as e:
            print(f"  loop error: {e}")
        time.sleep(5)

if __name__ == "__main__":
    main()
