# Lead Scraper Bot — Setup Guide

## Step 1 — Create a NEW Telegram bot (separate from Karios Agency bot)
1. Telegram → @BotFather → /newbot
2. Name: "Lead Scraper" (or anything)
3. Copy the token — starts with numbers:letters

## Step 2 — Get your Telegram user ID (if you don't have it saved)
1. Telegram → @userinfobot → /start
2. Copy your ID number

## Step 3 — Create a NEW JSONbin (separate database for this bot)
1. jsonbin.io → Create Bin
2. Paste: {"seen":{},"queue":{}}
3. Copy the Bin ID from the URL
4. Copy your Master Key (same one from before, in API Keys)

## Step 4 — Deploy to Vercel
1. Create new GitHub repo: lead-scraper-bot
2. Push this folder to it (same git process as before):
   cd Desktop\lead-scraper-bot
   git init
   git add .
   git commit -m "first commit"
   git branch -M main
   git remote add origin https://Fortrix1:YOUR_TOKEN@github.com/Fortrix1/lead-scraper-bot.git
   git push -u origin main
3. Vercel → Add New Project → Import lead-scraper-bot
4. Framework Preset → Other
5. Deploy

## Step 5 — Add environment variables on Vercel
Settings → Environment Variables:

| Name              | Value                          |
|-------------------|--------------------------------|
| SCRAPER_BOT_TOKEN | your new bot token             |
| SCRAPER_ADMIN_ID  | your telegram user ID          |
| SCRAPER_BIN_URL   | https://api.jsonbin.io/v3/b/YOUR_BIN_ID |
| SCRAPER_BIN_KEY   | your jsonbin master key        |

Save, then Redeploy.

## Step 6 — Register the webhook
Open in browser (replace YOUR_TOKEN and YOUR_DOMAIN):

https://api.telegram.org/botYOUR_TOKEN/setWebhook?url=https://YOUR_DOMAIN/api/scraper_bot

Should show {"ok":true}

## Step 7 — Test it
Telegram → your bot → /start

Try /scout to pull fresh leads directly from URLScan.io,
or send a .txt/.csv file to process a list you already have.
