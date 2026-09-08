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
| `SCRAPER_ADMIN_ID` | your Telegram user ID |
| `UPSTASH_REDIS_REST_URL` | your Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | your Upstash REST token |

Save, then **Redeploy**.

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

---

## How to Use

### Google Maps Scraping

In Telegram, send:
```
/find Austin restaurant 20
```

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

### URLScan Scraping

Send `/scout` in Telegram → pick a search → reply with how many leads → choose whether to include locked stores.

Results come back in batches. Send any message to continue to the next batch.

### File Upload

Send a `.txt` file with one URL per line. The bot extracts, dedupes, and checks each site.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/start` | Show help |
| `/scout` | URLScan.io search menu |
| `/find <city> <niche> [count]` | Scrape Google Maps (asks for a review cap, then runs the daemon) |
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
