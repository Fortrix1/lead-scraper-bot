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

## Step 4 — Setup PC Daemon

Open terminal / PowerShell in the `local-sender` folder (or wherever you want):

```bash
# 1. Install Python deps
pip install -r requirements.txt

# 2. Install Playwright browser
playwright install chromium

# 3. Set environment variables (same as Vercel)
# Windows PowerShell:
$env:UPSTASH_REDIS_REST_URL = "your_url"
$env:UPSTASH_REDIS_REST_TOKEN = "your_token"
$env:SCRAPER_BOT_TOKEN = "your_bot_token"

# Or create a .env file and load it with python-dotenv if you prefer

# 4. Run the daemon
python maps_daemon.py
```

The daemon will print:
```
Waiting for /find jobs from Telegram bot...
Press Ctrl+C to exit
```

**Leave it running.** It polls Redis every few seconds.

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
| `/find <city> <niche> [count]` | Scrape Google Maps via PC daemon |
| `/others` | See blacklisted links from last search |
| `/black <url>` | Add domains from a raw list to blacklist |
| `/scoutlist <url>` | Scan any domain list as leads |

---

## Notes

- The daemon **must** be running on your PC for `/find` to work.
- URLScan and file uploads work without the daemon (they run on Vercel).
- Google Maps scraping is headless — no browser window pops up.
- Max 50 results per `/find` job (safety limit).
