# Lead Scraper Bot — Setup Guide (v3)

## Architecture

- **Bot (Vercel)**: Handles Telegram webhooks, URLScan scraping, file uploads, and posts Google Maps jobs to Redis.
- **Daemon (Your PC)**: `maps_daemon.py` runs in the background, polls Redis for `/find` jobs, scrapes Google Maps headlessly, checks websites, and sends results back to Telegram.

---

## Step 1 — Create Telegram Bot

1. Telegram → @BotFather → `/newbot`
2. Name it anything, copy the token (starts with numbers:letters)
3. Get your Telegram user ID from @userinfobot

---

## Step 2 — Upstash Redis

1. Go to [upstash.com](https://upstash.com) → Create a Redis database
2. Copy the **REST URL** and **REST Token**
3. This is shared between Vercel and your PC daemon

---

## Step 3 — Deploy Bot to Vercel

1. Create GitHub repo: `lead-scraper-bot`
   **Make it Public** if you plan to use the GitHub Actions daemon option in
   Step 5 below — free unlimited Actions minutes only apply to public repos.
   (This is fine: the `.gitignore` in this project keeps your tokens and
   cookies out of the repo. Never commit `gm_cookies.json` or `_env`.)
2. Push this folder:
   ```bash
   cd Desktop\lead-scraper-bot
   git init
   git add .
   git commit -m "v3"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/lead-scraper-bot.git
   git push -u origin main
   ```
3. Vercel → Add New Project → Import repo
4. Framework Preset → **Other**
5. Deploy

### Environment Variables (Vercel)

| Name | Value |
|------|-------|
| `SCRAPER_BOT_TOKEN` | your bot token |
| `SCRAPER_ADMIN_ID` | your Telegram user ID — **required**: the bot now locks out anyone whose ID doesn't match this |
| `COMPANIES_HOUSE_API_KEY` | *(optional)* enables `/newuk` — free, see below |
| `UPSTASH_REDIS_REST_URL` | your Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | your Upstash REST token |

Save, then **Redeploy**.

> If `SCRAPER_ADMIN_ID` is left unset, the lock is skipped entirely (anyone who finds your bot can use it) — it's not required for the bot to *run*, but you should set it.

### Register Webhook

Open in browser:
```
https://api.telegram.org/botYOUR_TOKEN/setWebhook?url=https://YOUR_VERCEL_DOMAIN/api/scraper_bot
```

Should return `{"ok":true}`.

---

## Step 4 — Run the PC Daemon (local option)

Open terminal / PowerShell in the `local-sender` folder (or wherever you want):

```bash
# 1. Install Python deps
pip install -r requirements.txt

# 2. Install Playwright browser
playwright install chromium

# 3. Run the daemon — it automatically reads your .env file
python maps_daemon.py
```

Your `.env` file (already in this folder) should contain:
```
UPSTASH_REDIS_REST_URL=your_url
UPSTASH_REDIS_REST_TOKEN=your_token
SCRAPER_BOT_TOKEN=your_bot_token
```

The daemon will print:
```
Waiting for /find jobs from Telegram bot...
Press Ctrl+C to exit
```

**Leave it running.** It polls Redis every few seconds.

---

## Step 5 — Optional: Run the Daemon on GitHub Actions Instead of Your PC

If you don't want to keep your PC on 24/7, you can have GitHub run the daemon
for you, for free, on a schedule — no VPS, no card charges beyond what
GitHub itself already asks for at signup (nothing, for public repos).

**How it works:** every 10 minutes, GitHub spins up a temporary Linux machine,
checks Redis for one waiting `/find` job, runs it if there is one, then throws
the machine away. This replaces the always-on loop with a "wake up, check,
maybe work, go back to sleep" pattern — functionally the same result for you,
since jobs still get picked up and results still land in Telegram.

### 5.1 — Make sure the repo is public
Free, unlimited Actions minutes only apply to **public** repositories. If your
repo is private, this still works but is capped at ~2,000 free minutes/month —
fine for occasional use, but switch to public if you want zero limits.

### 5.2 — Add your secrets to GitHub (never commit them)
Repo → Settings → Secrets and variables → Actions → **New repository secret**.
Add all four of these:

| Secret name | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | your Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | your Upstash REST token |
| `SCRAPER_BOT_TOKEN` | your Telegram bot token |
| `GM_COOKIES_JSON` | the full contents of your `gm_cookies.json` file, pasted as-is |

### 5.3 — Push the workflow file
Make sure `.github/workflows/daemon.yml` is committed and pushed. GitHub
detects it automatically — check the **Actions** tab on your repo, you should
see "Maps Daemon (scheduled)" listed there.

### 5.4 — Test it manually first
In the Actions tab, click "Maps Daemon (scheduled)" → **Run workflow** to
trigger it by hand instead of waiting for the schedule. Watch the logs to
confirm it installs cleanly and either finds/runs a job or reports "No job
waiting."

### 5.5 — Known limitation: cookies don't self-update remotely
Locally, the daemon saves fresh cookies back to `gm_cookies.json` after every
run, so it stays logged in over time. On GitHub Actions, each run is a
brand-new throwaway machine — it can't write back to your `GM_COOKIES_JSON`
secret automatically (and we deliberately don't commit cookies to a public
repo, since that would expose live session data to anyone).

In practice: if Google ever blocks a run or shows a CAPTCHA, the job will
just come back empty. When that happens, run `python maps_daemon.py` locally
once (this refreshes `gm_cookies.json` on your PC), then copy its new
contents into the `GM_COOKIES_JSON` secret to refresh it. This should be
rare, not something you need to do constantly.

### 5.6 — You can run both at once
The GitHub Actions workflow and your local PC daemon both just pop jobs off
the same Redis queue — whichever one checks first gets the job. So you can
leave GitHub Actions running as the default, and occasionally run the daemon
locally too (e.g. to refresh cookies) without conflicts.

### 5.7 — Optional: Skip the wait, trigger runs instantly
By default, GitHub only checks for jobs every 10 minutes (Step 5.1), and
that schedule can sometimes be delayed further under GitHub's own load.
You can bypass this entirely: the bot can tell GitHub "run right now" the
moment you post a `/find` job, instead of waiting on the schedule.

1. Create a Personal Access Token at `github.com/settings/tokens` with the
   **`workflow`** scope (same as Step 5's push permission — you can reuse
   an existing token if it already has this scope, or make a new one).
2. In your Vercel project → Settings → Environment Variables, add:

   | Name | Value |
   |---|---|
   | `GITHUB_DISPATCH_TOKEN` | the token from step 1 |
   | `GITHUB_OWNER` | your GitHub username (e.g. `Fortrix1`) |
   | `GITHUB_REPO` | `lead-scraper-bot` |

3. Redeploy on Vercel so the new environment variables take effect.

That's it — every `/find` job now triggers GitHub Actions immediately.
This is optional: if it's not configured, or the trigger call fails for any
reason, the scheduled run still picks the job up on its own, just slower.

---

## How to Use

### Google Maps Scraping

In Telegram, send:
```
/find Austin restaurant 20
```

Every lead is now tagged with a category:
- **Website Needed** — no website, or the website is dead/unreachable
- **Website Opportunity** — has a website but a *real* gap: 2+ distinct issues detected (e.g. missing booking AND no contact form), or 50+ reviews (proven customer demand) plus at least one issue. A single missing feature like "no online booking" on its own isn't enough — that's normal for most small business sites, not a real signal.
- **Fresh Prospect** — has a website with no significant gap detected; a general prospect

**Fresh vs. repeat runs** — by default, `/find` never shows you a business you've already scraped before (tracked globally in Redis, across all cities/niches/campaigns). Add `rescan` to the end of the command to include previously-seen businesses in this run too:
```
/find Austin restaurant 20 rescan
```
Repeats are marked "♻️ Previously scraped" in the output so you can tell them apart. You can combine both flags in either order: `/find Austin restaurant 20 sample rescan`.

**Sample mode** — add `sample` to the end of `/find` to get a capped, privacy-safe run:
```
/find Austin restaurant 20 sample
```
This caps the outgoing batch to 10–20 leads (by score) and hides phone/email
behind a partial mask (e.g. `(512) •••-••••`, `j•••@domain.com`), and holds
back the decision-maker guess and extra contact channels. Everything else —
name, city, reviews, website/booking status, socials, category, and the
opportunity reasoning — is shown in full, since that's what proves the data
is real. The full unmasked scrape is still recorded internally (`/leads`,
`/campaigns`, `/mark`) regardless of sample mode; only what gets sent to
Telegram and exported to .txt/.html is capped and masked.

The bot posts the job to Redis. Your PC daemon picks it up, scrapes Google Maps headlessly, visits each website, and sends results back to Telegram in batches:

```
📍 Austin Restaurant — 1-5 of 20

1. Joe's Pizza
   📍 123 Main St, Austin
   📱 (512) 555-0123
   🔗 https://joespizza.com
   ⭐ 4.5 (127 reviews)
   📧 contact@joespizza.com
   📸 @joespizzaatx
   📊 Score: 82 🔥
   💡 Site loads in 8.2s — most visitors leave after 3s

2. ...
```

### Fresh Shopify Stores (crt.sh) — tick mode

In Telegram, send:
```
/fresh 45 15      # turns monitoring ON: stores whose first-ever cert is ≤45 days old, up to 15 per tick
/freshoff         # turns monitoring OFF
```
`45` = max store age in days (default 30, capped at 90), `15` = how many to report per tick (default 15, capped at 30).

**This is a switch, not a one-off job.** `/fresh` doesn't post a job — it saves a config in Redis (valid 14 days). From then on, every daemon run that finds the `jobs:find` queue empty does ONE "tick". crt.sh only supports `%` as a *leading* wildcard (`%.myshopify.com` — matching everything under that domain), not a mid-token prefix like `a%.myshopify.com`, so ticks work in two phases: roughly once every 20 hours, a tick runs the one heavy query crt.sh actually supports (`%.myshopify.com`) and caches every candidate domain it returns in Redis; every other tick just works through that cached pool with cheap, exact-domain lookups (age-checking up to 25 candidates per tick). Only stores whose **first-ever certificate** (expired ones included — that's the true birthday, not the latest ~90-day renewal) falls within the age window get reported to Telegram.

Separately, `/scout` results are tagged with store age too (`🎂 age: 12d 🔥`), pulled from the same crt.sh lookup and cached forever per domain, so you don't need `/fresh` running just to see how old a store you already found is.

**If crt.sh is blocked or rate-limiting your daemon's IP** (common on shared GitHub Actions IPs), the workflow's "Probe crt.sh from this IP" step will show `HTTP 403` in the Actions log instead of `HTTP 200`. In that case, set a `CRTSH_RELAY_URL` secret pointing at a small proxy (e.g. a Cloudflare Worker) that forwards requests to `crt.sh/json` from a different IP — both the daemon and the bot's own age lookups use it automatically once it's set.

### Newly Incorporated UK Companies (Companies House)

In Telegram, send:
```
/newuk 1 20        # companies incorporated in the last 1 day, up to 20 reported
/newuk 50          # one number >30 = how many RESULTS you want (today, 50 companies)
/newuk 5           # one number ≤30 = days back (default 20 results)
/newuk 7 50 with   # last 7 days, 50 results, only companies WITH a verified website
/newuk 1 20 nosite # only companies where NO website could be found
/newuk range       # pick your own exact FROM–TO date window (plus count)
```

**You always get exactly the count you ask for.** `/newuk` never spends a search credit, so the free-tier result caps no longer shrink it — if you see a "free accounts" message you're not recognized as the owner, which means `SCRAPER_ADMIN_ID` in Vercel doesn't match your Telegram ID (check it with `/access`).

**The date window is strict.** "Last N days" INCLUDES today (`/newuk 1` = today only — the old version started from yesterday, so results never matched the window you picked), computed on the **London calendar** (Companies House is a UK register). An extra client-side filter re-checks every company's incorporation date against the window before reporting, and `/newuk range` lets you pick an exact from–to window. Note: Companies House loads each day's incorporations with a delay, so "today" fills up as the day goes on — a few missing companies at 9am is normal, not a bug.

**Website verification (with / nosite / all).** Companies House doesn't list websites, so the bot finds each company's site itself: it probes the likely domains built from the company name (`companyname.co.uk`, `.com`, `.org.uk`, `.uk`, hyphenated variants), and if none verify it searches the web for the company and probes what comes back. A site only counts when it PROVES itself: loads with HTTP 200, isn't a parked/for-sale page, isn't an aggregator or social site, and actually mentions the company name. Choose **🔗 Only WITH a website**, **🚫 Only WITHOUT a website**, or **📋 All companies** — every company gets the check either way, results are cached per company for 30 days, and if the time budget cuts the run short, send any message to continue exactly where it stopped.

This calls the UK government's own [Companies House Advanced Search API](https://developer.company-information.service.gov.uk/api/docs/search/advanced-search/advancedSearchCompanies.html) directly — free, official, no scraping, and unlike crt.sh it's fast and reliable, so it runs straight from Vercel with no daemon involved. Each company includes its incorporation date, type, registered address, website verdict, and a link to its public Companies House page. Results are deduplicated the same way `/scout` leads are, so re-running `/newuk` won't re-send companies you've already seen.

**One-time setup (free, ~2 minutes):**
1. Register at [developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/)
2. Create an application, then "Create new key" → choose **REST API key**
3. Add it to Vercel → Settings → Environment Variables as `COMPANIES_HOUSE_API_KEY`
4. Redeploy

Without this key set, `/newuk` will tell you it's not configured yet rather than failing silently.

**Coverage note:** this is UK-only. A US equivalent is possible but more limited — only 5 states (NY, CO, CT, PA, OR) publish free, commercial-use-OK open incorporation data; the largest states (Texas, California, Delaware) don't offer free bulk access at all. Germany's Handelsregister has no free official API for this either — every option is a paid third-party service sitting in front of the same government portal. Ask if you want either of those built; they're real, just not "flip a free switch" the way the UK one is.

### Public Access, Paid Passes & Bring-Your-Own-Cookies

Session-heavy features (`/findco`, `/find`, `/scout`, `/fresh`, `/scoutlist`)
run on a logged-in Google session. There are now three ways someone can use
them:

| Tier | Who | How |
|---|---|---|
| **Owner** | you | everything, always |
| **Paid pass** | anyone | pays you → you approve → `PASS_DAYS` days on your shared session |
| **BYOC** | anyone (free) | uploads their own google.com cookies → runs entirely on *their* session, with *their own* hourly search budget — yours is never touched |

**Turning public mode on** — set `PUBLIC_ACCESS=true` in Vercel. Strangers
can then use `/newuk`, the menus, and anything else in `PUBLIC_CMDS`; the
moment they tap a session-heavy feature they hit the access gate.

**Vercel environment variables for this system:**

| Name | What |
|---|---|
| `PUBLIC_ACCESS` | `true` to let strangers use the bot at all |
| `PAYMENT_LINK` | your payment URL (Stripe Payment Link, Gumroad, etc.) — shown on the "Get access" screen |
| `ACCESS_PRICE_TEXT` | e.g. `$1` (display only) |
| `ACCESS_PASS_DAYS` | days a paid pass lasts (default 30) |

**How a paid sale works (no Stripe integration needed):**
1. User taps 💳 "Get a pass" on the access screen → sees your `PAYMENT_LINK`
2. You get a DM with their user ID and **Approve / Deny** buttons
3. Tap Approve → their pass activates instantly; they get a confirmation DM
4. You can also grant manually anytime: `/grant <user id> [days]`

**How BYOC works:**
1. User sends their `cookies.json` (Cookie-Editor export, google.com) as a
   document — the bot sniffs the file, stores it under their user ID, and
   confirms with the expiry date
2. Their `/findco` and `/find` jobs run with **their** cookies; the hourly
   Google budget is per-user (`disc:rl:hour:<userId>`) so they can never
   burn your session
3. When Google eventually kills their session, the job tells them to
   re-upload — your shared session is never used as a fallback for them

**Checking status:** anyone can send `/access`; the owner can grant with
`/grant`. Cookie files and passes live in Redis (`cookies:{id}:google`,
`pass:{id}`) — nothing sensitive is written to the repo.

### Fresh Shopify Stores — real-time mode (CertStream, runs locally)

`certstream_watcher.py` is a companion to the crt.sh tick system above, not a replacement. It connects to [CertStream](https://certstream.calidog.io/) — a live push feed of every certificate as it's issued across public Certificate Transparency logs — and watches for anything under `myshopify.com`. Instead of polling an overloaded server (crt.sh) and hoping it answers, certificates are pushed to it the moment they're issued, so a genuinely new store can get reported within seconds rather than however long it takes the next GitHub Actions tick to stumble onto it.

**This runs on your PC, not GitHub Actions** — it needs a persistent, always-connected process, which a one-shot 10-minute cron job can't provide. Run it in its own terminal window, the same way you'd run `maps_daemon.py` in loop mode:

```bash
pip install -r requirements.txt
python certstream_watcher.py
```

Leave it running. It prints a line to the terminal whenever it reports something; Ctrl+C to stop.

It reuses the **same `/fresh` config** your Telegram bot already sets — no new commands. Send `/fresh 45 15` as usual to turn monitoring on (or `/freshoff` to pause it); the watcher and the GitHub Actions ticks both read that same setting. They also share the same Redis `fresh:processed` set, so whichever one sees a domain first marks it done — no duplicate reports between the two.

Every match still goes through the same "is this a genuinely new store, or just a renewal of an old one" check (pulling the domain's full cert history to find its true first-ever certificate) before anything gets reported — CertStream tells you a cert was *just issued*, not that the store is new; those aren't the same thing for a store that's simply renewing.

**Reliability note:** the public CertStream demo endpoint (`certstream.calidog.io`) is a free community service and isn't guaranteed to stay connected — the script auto-reconnects on drops, but if it proves too flaky over time, a self-hosted alternative ([`certstream-server-go`](https://github.com/d-Rickyy-b/certstream-server-go)) exists; point `CERTSTREAM_URL` at your own instance instead (no code changes needed, just the env var). Either way, GitHub Actions keeps running its own independent crt.sh ticks in the background regardless of whether this script is running, so losing the CertStream connection just means you fall back to the slower polling path, not that monitoring stops entirely.


### Company Web Discovery (/findco) — authenticated Google search

`web_discovery.py` finds companies' websites and LinkedIn pages by searching
Google with your **real, logged-in Chrome cookies** — so it doesn't hit
CAPTCHAs the way anonymous scraping does, and it shares your existing
daemon infrastructure (Redis queue, GitHub Actions schedule, Telegram
reports).

**One-time cookie setup (~2 minutes, redo whenever Google logs you out):**
1. Install the **Cookie-Editor** Chrome extension
2. Go to google.com while logged into your Google account
3. Export cookies as JSON → save to `cookies/google_cookies.json` next to
   `maps_daemon.py` (on your PC, and in the repo as a **secret** — see
   below — if you want GitHub Actions runs to use it too)

**Usage (two ways):**
```
/findco
```
then paste your company list as the next message — one per line, location
optional. You can even paste raw `/newuk` output straight in; the dates,
links, and address lines are ignored automatically and only the company
names get picked up.
```
Acme Ltd, London
WidgetCo | Manchester
SoloCompany
```
Or point it at a hosted list:
```
/findco https://example.com/companies.txt
```

**What it does per company (full contact picture):**
1. **Google web search** → official website, LinkedIn company page, and
   every social profile (Instagram, Facebook, TikTok, X) found in results
2. **Google Maps** → phone number, rating, review count, address
3. **Companies House directors** (free official API — the bot picks the
   company numbers out of the find-and-update links in your paste
   automatically) → the actual people behind the company
4. **Per-director Google search** → their personal LinkedIn and socials,
   so you know exactly who to contact

**How it behaves:**
- Paste it in ANY form: `/findco` then the list as the next message, or
  paste everything on the same line as the command — even raw `/newuk`
  output or a messy multi-app copy-paste (addresses, browser link
  previews, other bot replies) is filtered down to just the company names
- Page navigations are budgeted (~100/hour shared across all runners via
  Redis) with randomized human-like delays; roughly 15–20 companies/hour
- Every answer is cached in SQLite for 30 days — repeats are free
- Progress checkpoints to Redis after each company, so a run that hits
  the 30-minute job cap resumes mid-list on the next tick
- If Google shows a CAPTCHA mid-run, the job pauses itself, alerts you,
  and waits for fresh cookies instead of burning the list
- Results arrive in Telegram plus a `.txt` export: website, socials,
  Maps phone/rating, and each director with their LinkedIn

**Local run needs one extra line in `.env`:** `COMPANIES_HOUSE_API_KEY=...`
(same free key as Vercel). For GitHub Actions runs, add it as a repo
secret of the same name — `daemon.yml` passes it through automatically.

**For GitHub Actions runs:** add a repo secret `GOOGLE_COOKIES_JSON` with
the full contents of `google_cookies.json`, and add a step before the
daemon run in `daemon.yml`:
```yaml
      - name: Restore Google cookies from secret
        run: mkdir -p cookies && echo '${{ secrets.GOOGLE_COOKIES_JSON }}' > cookies/google_cookies.json
```
(Your local PC runs read the file directly — the workflow's env var
`GOOGLE_COOKIES_PATH` points at the same relative path by default.)

### URLScan Scraping

Send `/scout` in Telegram → pick a search → choose a date window → reply with how many leads → choose freshness and whether to include locked stores → type `all` or one required social platform (`linkedin`, `facebook`, `instagram`, `x`, or `tiktok`).

**🛍️ Online stores — Shopify · Wix · Etsy · Webflow.** The scout menu has an **Online stores** button that opens a platform picker. Every platform runs the exact same flow as Shopify: date window → how many → real-store checks → social filter. Discovery queries (verified live against urlscan's public index): Shopify `page.domain:myshopify.com`, Wix `page.domain:wixsite.com`, Etsy `page.domain:etsy.com AND page.url:"/shop/"` (the shop PAGE is the lead, not the marketplace root), Webflow `page.domain:webflow.io`. Two platform limits worth knowing: store-age lookups (SSL birthday) only work on Shopify — Wix, Etsy and Webflow hide every customer site behind one shared wildcard certificate, so age stays "unknown" there; and Etsy blocks some cloud IPs, so if your Vercel IP gets a 403 from Etsy those candidates can't be live-checked and will be sparse until the IP is clean.

**Niche presets are product-level now, not name-level.** The niche searches (Skincare/Beauty, Jewelry, Pet products, Fashion) no longer match keywords in the page TITLE — a cosmetics store called "Glow Labs" whose title never says cosmetics was invisible to the old queries. Instead they pull ALL stores of the platform, then open each store's LIVE product list: on Shopify the bot fetches `/products.json` and matches real product titles/tags/types; on other platforms it matches the visible product/listing texts on the page itself. A store only counts if it lists at least **3 matching products** (change `NICHE_MIN_PRODUCTS` at the top of `api/scraper_bot.js` if you want it tighter or looser), and the report shows exactly what matched (`🧴 Skincare/Beauty: 14 matching of 60 products (products.json)`). Stores that fail the product gate land in `/others` with the count that missed.

Under **Custom date or backward range**, choose one exact day or a backward range, then type the year, month, and day. A range asks for its total number of days and counts backward while including the selected end date. URLScan's public index only reaches back about 30 days, so older custom dates are rejected rather than returning an unexplained empty search.

After picking a date window, /scout asks one extra question — **🆕 Only stores born in this window** or **♻️ Any store age (faster)**. The date window filters when stores were last *scanned* (an old store scanned yesterday still matches it); the age-gate option additionally enforces the window on each store's REAL age (its first-ever SSL certificate). With the gate on, too-old stores are dropped, listed under `/others`, and the report header shows `🎂 Store age ≤ Nd enforced`.

A required social platform is mandatory, and **strict means strict on every platform**: each Facebook / Instagram / X / LinkedIn / TikTok link found on a store is live-fetched and must load as a real profile — a live 404, a "page isn't available / account doesn't exist / suspended" response, a redirect to the platform's home or login, or a link that ends up off the platform is dropped and does NOT count toward your requested total. Facebook links are additionally business-pages-only (personal profiles, groups and events never pass extraction). Network blocks (401/403/429, timeouts) are NOT treated as proof an account is fake — those links stay, so strictness can't invent false negatives just because a platform rate-limited the bot. The keep-hunting-until-you-have-exactly-N behavior is unchanged.

Results come back in batches. Send any message to continue searching until the requested number of qualifying leads is found or URLScan is exhausted.

### Gifts

The owner creates gifts from **Admin → Gifts**. Publishing sends a direct Telegram notification to every known user. Quiz gifts show **Answer / Decline**; other gifts show **Claim / Decline**. Decline hides that gift only for the user who tapped it. Claims and quiz answers are locked per gift so simultaneous responses cannot overwrite the winner. Wrong quiz answers leave the gift open.

### File Upload

Send a `.txt` file with one URL per line. The bot extracts, dedupes, and checks each site.

---

### AI-Built Sites (/hunt) — Lovable, Framer, Durable, Wix

In Telegram, send:
```
/hunt lovable 10      # newest Lovable sites (via certificate logs)
/hunt framer 10       # newest Framer sites
/hunt wix 10          # newest Wix sites
/hunt all 20          # a mix of every builder
```
Every hunt screen has a **🏢 Business sites only / 🌐 Show everything** row. Business mode (default) silently skips developer portfolios, demos and side projects and tells you how many it skipped. Leads are tagged 🏢 real business / 👨‍💻 developer / ❔ unclear, and `/check <url>` shows exactly why a site was classified that way.

How discovery works: Lovable gives every project its own SSL certificate, so new sites show up in public certificate logs (crt.sh). Framer, Wix and Durable put every customer site behind ONE wildcard certificate — certificate logs can't see them at all — so those three are discovered through urlscan's index of recent public scans instead (last 4 days, successful scans only, business-keyword filter on the big zones). Either source failing falls back to the other automatically.

## Commands

| Command | What it does |
|---------|-------------|
| `/start` | Show help |
| `/scout` | URLScan.io search menu — Shopify · Wix · Etsy · Webflow, niche presets product-checked |
| `/find <city> <niche> [count]` | Scrape Google Maps (asks for a review cap, then runs the daemon) |
| `/fresh [age_days] [count]` | Turn ON fresh-Shopify-store monitoring via crt.sh ticks (default: ≤30 days, top 15/tick) |
| `/freshoff` | Turn OFF fresh-store monitoring |
| `/hunt <lovable|framer|durable|wix|all> [count]` | Find AI-built websites (🏢 business-only toggle on every hunt screen) |
| `/check <url>` | Deep-check one site: builder, contacts, weaknesses, business-vs-developer verdict |
| `/audit` | Show the last 50 commands run, by whom and when |
| `/newuk [days] [count] [with\|nosite\|all]` | UK companies via Companies House, website-verified; `/newuk range` = exact from–to window |
| `/campaigns` | List campaigns and how many leads each has |
| `/leads <status>` | List leads by status: new, contacted, replied, interested, not_interested, do_not_contact, client |
| `/mark <number> <status>` | Mark lead #N from your last /find report with a status |
| `/others` | See blacklisted links from last search |
| `/black <url>` | Add domains from a raw list to blacklist |
| `/scoutlist <url>` | Scan any domain list as leads |

---

## Notes

- The daemon needs to be running **somewhere** for `/find` to work — either
  on your PC (Step 4) or via the GitHub Actions schedule (Step 5). Both can
  run at the same time without conflicting.
- URLScan and file uploads work without the daemon (they run on Vercel).
- Google Maps scraping opens a real (non-headless) browser window on
  purpose — it makes solving an occasional CAPTCHA possible. On GitHub
  Actions this runs inside a virtual display (Xvfb) instead of a visible
  window, since there's no screen on that machine.
- Max 50 results per `/find` job (safety limit).
- Never commit `gm_cookies.json` or `_env` — the `.gitignore` in this repo
  blocks them, but double-check before pushing if you ever restructure files.
