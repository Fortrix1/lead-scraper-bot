#!/usr/bin/env python3
"""
fb_scraper.py - local Facebook people/pages scraper with country, account-age
and recent-activity (last post) filters.

Usage:
  python fb_scraper.py login                     # log in manually (browser window)
  python fb_scraper.py login --cookies cookies.json
      # import a Cookie-Editor export from your NORMAL browser instead of
      # logging in manually. Best fix for the stuck two-step-verification /
      # CAPTCHA spinner: complete the verification in your real browser, export
      # the facebook.com cookies, feed them here.
  python fb_scraper.py scrape --query "coffee shops" --type pages --country GB \
      --min-age-years 3 --active-within 30 --max 60 --out ./results
  python fb_scraper.py scrape --query "boutique owners" --type people \
      --posted-since 2026-10-01 --posted-until 2026-11-25 --max 40

Activity filters (all keep profiles whose posts can't be dated, tagged):
  --active-within N        most recent visible post within N days
  --posted-since DATE      most recent post on/after YYYY-MM-DD (with --active-within,
                           the stricter of the two wins)
  --posted-until DATE      most recent post on/before YYYY-MM-DD

FIXES vs the old version (the "stuck on two_step_verification" bug):
  * login() no longer saves whatever half-loaded page happened to be open.
    It waits for ENTER, then CHECKS the real login cookies (c_user + xs)
    and only saves a verified session — with 3 retries if you pressed
    ENTER too early (e.g. while the challenge spinner was still showing).
  * New: login --cookies <file> imports a Cookie-Editor export so you can
    pass a session that was verified in your normal browser (where the
    CAPTCHA / 2FA challenge actually loads and can be solved).
  * Browser launched with --disable-blink-features=AutomationControlled —
    without it Facebook's challenge page often hangs on a blank spinner.
  * scrape() validates the saved session (c_user/xs) BEFORE driving the
    search, and detects a live "checkpoint" wall with a clear message
    instead of silently producing 0 links.
"""
import argparse, asyncio, csv, json, random, re, sys, time
from datetime import datetime, timedelta
from pathlib import Path
from playwright.async_api import async_playwright
from rich.console import Console

console = Console()
STATE_FILE = Path("fb_state.json")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
# Chromium's automation flag is the #1 reason Facebook's two-step-
# verification / CAPTCHA page renders as a blank Meta-logo spinner: the
# challenge JS detects it and never finishes. Disabling the flag lets the
# page actually load so you can solve it in the window.
STEALTH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
]

COUNTRY_NAMES = {
    "GB": ["United Kingdom", "England", "Scotland", "Wales", "Northern Ireland", "London"],
    "US": ["United States", "USA", "California", "New York", "Texas"],
    "DE": ["Germany", "Deutschland", "Berlin", "Munich"],
    "FR": ["France", "Paris", "Lyon"],
    "IN": ["India", "Mumbai", "Delhi", "Bangalore"],
    "BR": ["Brazil", "Brasil", "Sao Paulo", "Rio"],
    "NG": ["Nigeria", "Lagos", "Abuja"],
    "CA": ["Canada", "Toronto", "Vancouver"],
}

# site-feature slugs that are never people/pages
EXCLUDED_SLUGS = {
    "home", "profile", "bookmarks", "saved", "notifications", "settings",
    "groups", "events", "marketplace", "watch", "gaming", "pages", "search",
    "help", "login", "recover", "support", "campaign", "donate", "fundraisers",
    "messages", "friends", "reels", "stories", "hashtag", "policies",
    "privacy", "places", "jobs", "ads", "business", "about", "lite",
    "mobile", "logout", "confirm", "checkpoint", "two_step", "error",
}

CONSENT_BUTTONS = [
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Decline optional cookies")',
    'button:has-text("Only allow essential cookies")',
    'button:has-text("Continue")',
]

MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
MONTH_INDEX = {m.lower(): i + 1 for i, m in enumerate(MONTHS)}

# URL fragments that mean "Facebook wants verification before proceeding".
CHALLENGE_URL_BITS = ("checkpoint", "two_step_verification", "confirm", "challenge", "devices")


# ------------------------------------------------------------------
# Session helpers — the old code saved whatever page was open, which is
# exactly how you end up re-opening on a spinning two_step_verification
# page with no real login. These helpers verify the session by its
# actual login cookies (c_user + xs), not by what the page looks like.
# ------------------------------------------------------------------
def session_cookie_names(state_path=STATE_FILE):
    """Names of the cookies stored in a saved storage-state file."""
    try:
        data = json.loads(Path(state_path).read_text(encoding="utf-8"))
    except Exception:
        return set()
    return {c.get("name") for c in data.get("cookies", []) if isinstance(c, dict)}


def state_has_login(state_path=STATE_FILE):
    """A saved state is only a real login if BOTH c_user and xs are present."""
    return {"c_user", "xs"} <= session_cookie_names(state_path)


def cookie_editor_to_playwright(raw):
    """Convert a Cookie-Editor (or similar) JSON export into Playwright
    cookie objects. Same SameSite/Secure rules as web_discovery.py."""
    now = time.time()
    out = []
    for c in raw:
        if not isinstance(c, dict) or "name" not in c:
            continue
        domain = (c.get("domain") or "").lower()
        if "facebook.com" not in domain:
            continue
        exp = c.get("expirationDate") or c.get("expires")
        if exp and float(exp) < now:
            continue
        secure = bool(c.get("secure"))
        same_site = (c.get("sameSite") or "unspecified").lower()
        same_site = {"no_restriction": "None", "unspecified": "None"}.get(
            same_site, same_site.capitalize())
        if same_site == "None" and not secure:
            same_site = "Lax"
        entry = {"name": c["name"], "value": c.get("value", ""),
                 "domain": c["domain"], "path": c.get("path", "/"),
                 "httpOnly": bool(c.get("httpOnly")),
                 "secure": secure, "sameSite": same_site}
        if exp:
            entry["expires"] = float(exp)
        out.append(entry)
    return out


async def verify_session_report():
    """Open facebook.com headlessly with the saved state and report:
       "ok"            -> logged in, feed loads
       "checkpoint"    -> Facebook wants verification (2FA/CAPTCHA) on this session
       "not_logged_in" -> no usable login (missing/expired cookies)
       "missing"       -> no state file at all
    """
    if not STATE_FILE.exists():
        return "missing"
    if not state_has_login():
        # Not even the login cookies are there — don't bother opening a browser.
        return "not_logged_in"
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=STEALTH_ARGS)
        ctx = await browser.new_context(user_agent=UA, storage_state=str(STATE_FILE))
        page = await ctx.new_page()
        try:
            await page.goto("https://www.facebook.com/", wait_until="domcontentloaded",
                            timeout=45000)
            await page.wait_for_timeout(4000)
            url = page.url.lower()
            if any(bit in url for bit in CHALLENGE_URL_BITS):
                return "checkpoint"
            cookies = {c["name"] for c in await ctx.cookies()}
            if {"c_user", "xs"} <= cookies:
                return "ok"
            return "not_logged_in"
        except Exception:
            return "not_logged_in"
        finally:
            try:
                await browser.close()
            except Exception:
                pass


def year_from_text(txt):
    if not txt: return None
    m = re.search(r"(19|20)\d{2}", txt)
    return int(m.group(0)) if m else None

def age_from_year(y):
    return datetime.now().year - y if y else None

def last_post_days_ago(text):
    """Best guess at how many days ago the most recent visible post was,
    from Facebook's visible date strings ('Just now', 'Yesterday at ...',
    '5 h', '3 days', 'November 18 at ...'). Returns a float or None."""
    if not text:
        return None
    now = datetime.now()
    best = None
    def consider(days):
        nonlocal best
        if days is not None and days >= 0 and (best is None or days < best):
            best = float(days)
    low = " " + text.lower() + " "
    if re.search(r"\bjust now\b", low):
        consider(0)
    if re.search(r"\byesterday\b", low):
        consider(1)
    for m in re.finditer(r"\b(\d{1,2})\s*(?:h|hr|hrs|hours)\b", low):
        h = int(m.group(1))
        if 0 < h <= 72:
            consider(h / 24.0)
    for m in re.finditer(r"\b(\d{1,3})\s*(?:d|days?)\b", low):
        d = int(m.group(1))
        if 1 <= d <= 365:
            consider(float(d))
    for m in re.finditer(r"\b(january|february|march|april|may|june|july|august|"
                         r"september|october|november|december)\s+(\d{1,2})\b"
                         r"(?:\s*,?\s*(\d{4}))?", low):
        mon = MONTH_INDEX.get(m.group(1))
        day = int(m.group(2))
        year = int(m.group(3)) if m.group(3) else now.year
        if not mon:
            continue
        try:
            d = datetime(year, mon, day)
            if d > now and not m.group(3):
                d = datetime(year - 1, mon, day)   # e.g. "December 2" in January
            consider(max(0, (now - d).days))
        except ValueError:
            pass
    return best

async def human_pause(a=1.5, b=4.0):
    await asyncio.sleep(random.uniform(a, b))

async def dismiss_overlays(page):
    for sel in CONSENT_BUTTONS:
        try:
            btn = page.locator(sel).first
            if await btn.is_visible(timeout=1500):
                await btn.click()
                console.print(f"  clicked overlay: {sel.split(chr(34))[1]}")
                await human_pause(1, 2)
        except Exception:
            pass

async def login(cookies_file=None):
    """Two ways to get a session:
       (a) cookies_file given -> import a Cookie-Editor export (recommended
           when the manual login keeps hanging on the verification spinner:
           solve it once in your REAL browser, export, import here).
       (b) otherwise -> open a headed browser and log in manually. The session
           is only saved once the REAL login cookies (c_user + xs) exist, and
           you get 3 attempts if you press ENTER too early."""
    if cookies_file:
        return await login_from_cookies(cookies_file)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=STEALTH_ARGS)
        ctx = await browser.new_context(
            user_agent=UA,
            viewport={"width": 1366, "height": 900},
            locale="en-US",
            timezone_id="Europe/London",
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
        )
        page = await ctx.new_page()
        await page.goto("https://www.facebook.com/login",
                        wait_until="domcontentloaded", timeout=60000)
        console.print("[yellow]A browser window just opened. Then:[/yellow]")
        console.print("[yellow]  1. Log in to Facebook IN THAT WINDOW.[/yellow]")
        console.print("[yellow]  2. If Facebook shows a verification / CAPTCHA /[/yellow]")
        console.print("[yellow]     2FA challenge, COMPLETE it in the window — wait[/yellow]")
        console.print("[yellow]     until your News Feed (home page) is fully loaded.[/yellow]")
        console.print("[yellow]  3. ONLY THEN press ENTER here.[/yellow]")
        console.print("[dim]   (Pressing ENTER while the spinner is still showing saves[/dim]")
        console.print("[dim]    a broken session — that was the old bug.)[/dim]")

        saved = False
        for attempt in range(3):
            input()
            cookies = await ctx.cookies()
            names = {c["name"] for c in cookies}
            if "c_user" in names and "xs" in names:
                saved = True
                break
            url = page.url
            if any(bit in url for bit in CHALLENGE_URL_BITS):
                console.print(f"[red]You're still on the verification page ({url[:70]}...)[/red]")
                console.print("[red]Finish it in the browser window — full News Feed first —[/red]")
                console.print("[red]then press ENTER again. ({}/3)[/red]".format(attempt + 1))
            else:
                console.print("[red]No login session detected yet (no c_user/xs cookies).[/red]")
                console.print("[red]Make sure you're fully logged in inside the window, then[/red]")
                console.print("[red]press ENTER again. ({}/3)[/red]".format(attempt + 1))
        if not saved:
            console.print("[red]No verified login after 3 attempts — nothing was saved.[/red]")
            console.print("[red]Tip: solve the verification in your normal browser and use:[/red]")
            console.print("[red]  python fb_scraper.py login --cookies cookies.json[/red]")
            await browser.close()
            return

        # Final sanity check: reload home and confirm the session sticks.
        await page.goto("https://www.facebook.com/", wait_until="domcontentloaded",
                        timeout=60000)
        await page.wait_for_timeout(3000)
        names = {c["name"] for c in await ctx.cookies()}
        if {"c_user", "xs"} <= names:
            await ctx.storage_state(path=str(STATE_FILE))
            console.print("[green]Session verified (c_user + xs) — saved to fb_state.json[/green]")
        else:
            console.print("[yellow]Login cookies vanished after reload — Facebook likely[/yellow]")
            console.print("[yellow]still wants verification. Nothing saved; try again.[/yellow]")
        await browser.close()


async def login_from_cookies(path):
    """Import a Cookie-Editor export of facebook.com cookies (made in your
    normal browser while logged in, AFTER any 2FA/CAPTCHA was completed
    there) and save it as fb_state.json. Then verify it headlessly."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:
        console.print(f"[red]Couldn't read {path}: {e}[/red]")
        return
    if not isinstance(raw, list):
        console.print("[red]That doesn't look like a Cookie-Editor export (expected a JSON list).[/red]")
        return
    cookies = cookie_editor_to_playwright(raw)
    if not cookies:
        console.print("[red]No facebook.com cookies found in that file.[/red]")
        return
    names = {c["name"] for c in cookies}
    if not {"c_user", "xs"} <= names:
        console.print("[yellow]Warning: the export has no c_user/xs login cookies —[/yellow]")
        console.print("[yellow]it probably wasn't exported while logged in. Saving anyway.[/yellow]")
    STATE_FILE.write_text(json.dumps({"cookies": cookies, "origins": []}, indent=2),
                          encoding="utf-8")
    console.print(f"[green]Imported {len(cookies)} facebook.com cookies -> fb_state.json[/green]")
    console.print("[dim]Verifying the session headlessly...[/dim]")
    status = await verify_session_report()
    if status == "ok":
        console.print("[green]✅ Session works — the daemon can use it now.[/green]")
    elif status == "checkpoint":
        console.print("[yellow]⚠️ Facebook still wants verification on this session.[/yellow]")
        console.print("[yellow]   Open facebook.com in your normal browser, complete the[/yellow]")
        console.print("[yellow]   2FA/CAPTCHA there, then re-export and re-import the cookies.[/yellow]")
    elif status == "missing":
        console.print("[red]State file wasn't written — check permissions.[/red]")
    else:
        console.print("[yellow]⚠️ Cookies imported but the login looks expired/invalid.[/yellow]")
        console.print("[yellow]   Re-export from your browser while logged in and try again.[/yellow]")

async def extract_profile(page, url, kind):
    """Visit a profile/page, then its About tab, and pull public fields."""
    rec = {"url": url, "type": kind, "name": None, "location": None,
           "about_location": None, "website": None, "email": None, "phone": None,
           "earliest_year": None, "inferred_age_years": None, "created": None,
           "last_post_date": None, "last_post_days_ago": None}
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        await dismiss_overlays(page)
        await human_pause(2, 4)
        rec["name"] = (await page.title()).replace(" | Facebook", "").strip()

        # external website link on the main page (target=_blank hrefs)
        ext = await page.eval_on_selector_all(
            'a[href^="http"]', "els => els.map(e => e.getAttribute('href'))")
        rec["website"] = next((h for h in ext if h and "facebook.com" not in h), None)

        body = await page.inner_text("body")

        # ---- most recent visible post (activity check) ------------------
        ago = last_post_days_ago(body)
        if ago is not None:
            rec["last_post_days_ago"] = round(ago, 1)
            rec["last_post_date"] = (datetime.now() - timedelta(days=ago)).strftime("%Y-%m-%d")
        # -----------------------------------------------------------------

        # ---- About tab: this is where FB actually shows location/contact -
        await page.goto(url.rstrip("/") + "/about", wait_until="domcontentloaded", timeout=45000)
        await dismiss_overlays(page)
        await human_pause(1.5, 3.0)
        about = await page.inner_text("body")

        LABELS = {
            "location": r"^(Located in|Lives in|From|Address)$",
            "website": r"^Website$",
            "email": r"^Email$",
            "phone": r"^(Phone|Mobile|Contact)$",
            "joined": r"^Joined",
        }
        lines = [l.strip() for l in about.splitlines() if l.strip()]
        for i, line in enumerate(lines):
            for field, pat in LABELS.items():
                if re.match(pat, line, re.I) and i + 1 < len(lines):
                    if rec[field] is None or field == "location":
                        val = lines[i + 1][:160]
                        if field == "location":
                            rec["about_location"] = val
                            if rec["location"] is None:
                                rec["location"] = val
                        else:
                            rec[field] = val
        # ------------------------------------------------------------------

        if kind == "pages":
            m = re.search(r"(?:Page created|Created)\D{0,10}([A-Z][a-z]+ \d{1,2}, (19|20)\d{2})",
                          body + "\n" + about)
            if m:
                rec["created"] = m.group(1)
                y = year_from_text(m.group(1))
                rec["earliest_year"] = y
                rec["inferred_age_years"] = age_from_year(y)
        else:
            m = re.search(r"Joined\s+(?:Facebook\s+)?([A-Z][a-z]+ \d{1,2}, (19|20)\d{2})",
                          rec.get("joined") or "")
            if m:
                y = year_from_text(m.group(1))
                rec["earliest_year"] = y
                rec["inferred_age_years"] = age_from_year(y)
            else:
                years = [int(y) for y in re.findall(r"\b(19\d{2}|20\d{2})\b", body + "\n" + about)
                         if 2004 <= int(y) <= datetime.now().year]
                if years:
                    ey = min(years)
                    rec["earliest_year"] = ey
                    rec["inferred_age_years"] = age_from_year(ey)
    except Exception as e:
        rec["error"] = str(e)[:120]
    return rec

def extract_result_links(hrefs):
    links = set()
    for h in hrefs:
        if not h:
            continue
        base = h.split("?")[0].rstrip("/")
        m = re.match(r"^https://(?:www\.)?facebook\.com/([A-Za-z0-9._-]+)$", base)
        if not m:
            continue
        slug = m.group(1)
        if slug.lower() in EXCLUDED_SLUGS or slug.startswith("profile.php"):
            continue
        links.add(base)
    return links

async def scrape(args):
    if not STATE_FILE.exists():
        console.print("[red]No session. Run: python fb_scraper.py login[/red]")
        console.print("[red]or import browser cookies:[/red]")
        console.print("[red]  python fb_scraper.py login --cookies cookies.json[/red]")
        return
    # Validate the session BEFORE burning a search: the old code happily ran
    # with a half-saved state (no c_user/xs) and produced 0 links with no
    # explanation.
    if not state_has_login():
        console.print("[red]fb_state.json has NO active login (missing c_user/xs cookies).[/red]")
        console.print("[red]It was probably saved mid-verification. Re-run:[/red]")
        console.print("[red]  python fb_scraper.py login[/red]")
        console.print("[red]or import cookies from your browser:[/red]")
        console.print("[red]  python fb_scraper.py login --cookies cookies.json[/red]")
        return

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=args.headless, args=STEALTH_ARGS)
        ctx = await browser.new_context(user_agent=UA, storage_state=str(STATE_FILE))
        page = await ctx.new_page()

        search_type = "people" if args.type == "people" else "pages"
        q = args.query.replace(" ", "%20")
        url = f"https://www.facebook.com/search/{search_type}/?q={q}"

        console.print(f"[cyan]Searching:[/cyan] {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
        await dismiss_overlays(page)
        await human_pause(3, 5)

        title = await page.title()
        console.print(f"[dim]page title: {title}[/dim]")
        current_url = page.url.lower()

        # Cookie-level login check (DOM selectors lie on localized/lagged pages).
        cookie_names = {c["name"] for c in await ctx.cookies()}
        logged_in = {"c_user", "xs"} <= cookie_names
        if any(bit in current_url for bit in CHALLENGE_URL_BITS):
            console.print("[red]Facebook is asking for verification on this session[/red]")
            console.print("[red](checkpoint / 2FA / CAPTCHA). Open facebook.com in your[/red]")
            console.print("[red]normal browser, complete it there, then re-run:[/red]")
            console.print("[red]  python fb_scraper.py login --cookies cookies.json[/red]")
            console.print("[red]with freshly exported cookies.[/red]")
            await browser.close()
            return
        if not logged_in:
            console.print("[red]Not logged in! (no c_user/xs cookies on this session)[/red]")
            console.print("[red]Re-run: python fb_scraper.py login[/red]")
            await browser.close()
            return
        try:
            await page.wait_for_selector('div[role="main"] a[href]', timeout=15000)
        except Exception:
            pass
        await human_pause(2, 4)

        links = set()
        scrolls = 0
        while len(links) < args.max and scrolls < args.max_scrolls:
            hrefs = await page.eval_on_selector_all(
                'div[role="main"] a[href]', "els => els.map(e => e.href)")
            links |= extract_result_links(hrefs)
            console.print(f"  found {len(links)} links (scroll {scrolls + 1})")
            await page.mouse.wheel(0, 3000)
            await human_pause(2, 3.5)
            scrolls += 1

        if not links:
            shot = out / "debug_search.png"
            html = out / "debug_search.html"
            await page.screenshot(path=str(shot), full_page=True)
            html.write_text(await page.content(), encoding="utf-8")
            console.print(f"[yellow]0 links found. Saved {shot} and {html}[/yellow]")
        await browser.close()

    links = list(links)[:args.max]
    console.print(f"[green]Collected {len(links)} candidates. Visiting each...[/green]")

    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=args.headless, args=STEALTH_ARGS)
        ctx = await browser.new_context(user_agent=UA, storage_state=str(STATE_FILE))
        page = await ctx.new_page()
        for i, link in enumerate(links, 1):
            console.print(f"  [{i}/{len(links)}] {link}")
            rec = await extract_profile(page, link, args.type)
            results.append(rec)
            await human_pause(1.5, 3.5)
        await browser.close()

    # Activity window: --active-within N and --posted-since both set a start
    # bound — the stricter of the two wins. --posted-until sets the end bound.
    since = until = None
    if args.posted_since:
        try:
            since = datetime.strptime(args.posted_since, "%Y-%m-%d")
        except ValueError:
            console.print(f"[red]Bad --posted-since date '{args.posted_since}' — use YYYY-MM-DD.[/red]")
            return
    if args.posted_until:
        try:
            until = datetime.strptime(args.posted_until, "%Y-%m-%d")
        except ValueError:
            console.print(f"[red]Bad --posted-until date '{args.posted_until}' — use YYYY-MM-DD.[/red]")
            return
    if args.active_within is not None:
        since_active = datetime.now() - timedelta(days=args.active_within)
        if since is None or since_active > since:
            since = since_active

    hints = COUNTRY_NAMES.get(args.country.upper(), [args.country]) if args.country else []
    def ok(r):
        if hints:
            hay = (r.get("location") or "") + " " + (r.get("about_location") or "")
            if not any(h.lower() in hay.lower() for h in hints): return False
        if args.min_age_years is not None:
            if r.get("inferred_age_years") is None: return False
            if r["inferred_age_years"] < args.min_age_years: return False
        ago = r.get("last_post_days_ago")
        if ago is not None and (since is not None or until is not None):
            post_date = (datetime.now() - timedelta(days=ago)).date()
            if since is not None and post_date < since.date(): return False
            if until is not None and post_date > until.date(): return False
            # unknown activity -> kept
        return True

    kept = [r for r in results if ok(r)]
    unknown_activity = sum(1 for r in kept if r.get("last_post_days_ago") is None)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = out / f"results_{stamp}.json"
    csv_path = out / f"results_{stamp}.csv"
    json_path.write_text(json.dumps(kept, indent=2, ensure_ascii=False), encoding="utf-8")
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["name", "url", "type", "location", "about_location",
                                          "website", "email", "phone", "last_post_date",
                                          "last_post_days_ago", "earliest_year",
                                          "inferred_age_years", "created", "error"])
        w.writeheader()
        for r in kept:
            w.writerow({k: r.get(k, "") for k in w.fieldnames})

    if since is not None or until is not None:
        console.print(f"[dim]Activity window: posts since {since.date() if since else 'any time'}"
                      f" until {until.date() if until else 'today'}.[/dim]")
    console.print(f"\n[green]Kept {len(kept)} / {len(results)} after filters.[/green]")
    if args.active_within is not None:
        console.print(f"[dim]{unknown_activity} kept with unknown activity (no dated posts visible).[/dim]")
    console.print(f"Saved:\n  {json_path}\n  {csv_path}")

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")

    l = sub.add_parser("login", help="save your FB session (run once)")
    l.add_argument("--cookies", help="Cookie-Editor export (facebook.com) to import "
                                     "instead of logging in manually — use this when the "
                                     "verification/CAPTCHA page won't load in the automated window")

    s = sub.add_parser("scrape", help="run a search")
    s.add_argument("--query", required=True)
    s.add_argument("--type", choices=["people", "pages"], default="pages")
    s.add_argument("--country", help="ISO code e.g. GB, US, DE (filters by location text)")
    s.add_argument("--min-age-years", type=int, help="min inferred account age in years")
    s.add_argument("--active-within", type=int,
                   help="only keep profiles whose most recent visible post is within N days "
                        "(unknown activity is kept, tagged)")
    s.add_argument("--posted-since", help="only keep profiles whose most recent post is on/after "
                                          "this date, YYYY-MM-DD (unknown activity is kept, tagged)")
    s.add_argument("--posted-until", help="only keep profiles whose most recent post is on/before "
                                          "this date, YYYY-MM-DD (unknown activity is kept, tagged)")
    s.add_argument("--max", type=int, default=50, help="max candidates to visit")
    s.add_argument("--max-scrolls", type=int, default=15)
    s.add_argument("--out", default="./results")
    s.add_argument("--headless", action="store_true", help="run browser invisibly")

    args = ap.parse_args()
    try:
        if args.cmd == "login":
            asyncio.run(login(cookies_file=args.cookies))
        elif args.cmd == "scrape":
            asyncio.run(scrape(args))
        else:
            ap.print_help()
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted by user (Ctrl+C). Session files are safe.[/yellow]")

if __name__ == "__main__":
    main()
