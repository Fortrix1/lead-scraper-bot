#!/usr/bin/env python3
"""
fb_scraper.py - local Facebook people/pages scraper with country, account-age
and recent-activity (last post) filters.

Usage:
  python fb_scraper.py login
  python fb_scraper.py scrape --query "coffee shops" --type pages --country GB \
      --min-age-years 3 --active-within 30 --max 60 --out ./results
  python fb_scraper.py scrape --query "boutique owners" --type people \
      --posted-since 2026-10-01 --posted-until 2026-11-25 --max 40

Activity filters (all keep profiles whose posts can't be dated, tagged):
  --active-within N        most recent visible post within N days
  --posted-since DATE      most recent post on/after YYYY-MM-DD (with --active-within,
                           the stricter of the two wins)
  --posted-until DATE      most recent post on/before YYYY-MM-DD
"""
import argparse, asyncio, csv, json, random, re, sys, time
from datetime import datetime, timedelta
from pathlib import Path
from playwright.async_api import async_playwright
from rich.console import Console

console = Console()
STATE_FILE = Path("fb_state.json")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

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

async def login():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        ctx = await browser.new_context(user_agent=UA)
        page = await ctx.new_page()
        await page.goto("https://www.facebook.com/login")
        console.print("[yellow]Log in manually in the window, then press ENTER here.[/yellow]")
        input()
        await ctx.storage_state(path=str(STATE_FILE))
        console.print("[green]Session saved to fb_state.json[/green]")
        await browser.close()

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
        return
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=args.headless)
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
        logged_in = await page.query_selector('[aria-label="Your profile"], [aria-label="Profile"], [data-pagelet="LeftRail"]')
        if not logged_in:
            console.print("[red]Not logged in! Re-run: python fb_scraper.py login[/red]")
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
        browser = await p.chromium.launch(headless=args.headless)
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

    sub.add_parser("login", help="save your FB session (run once)")

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
            asyncio.run(login())
        elif args.cmd == "scrape":
            asyncio.run(scrape(args))
        else:
            ap.print_help()
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted by user (Ctrl+C). Session files are safe.[/yellow]")

if __name__ == "__main__":
    main()
