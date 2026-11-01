# Fixed scraper_bot.js — what changed and why

**File:** `api/scraper_bot.js` (drop-in replacement, v5 → v6). Everything else (`maps_daemon.py`, `certstream_watcher.py`, `package.json`, `requirements.txt`) is unchanged — no new dependencies, no new Redis keys except the two listed at the bottom.

Every claim marked ✅ was verified LIVE against the real internet on 2026-11-01 while making these fixes.

---

## PART B — "AI Hunter only finds Lovable" (root cause + fix)

### The real root cause (found by testing, not guessing)
Lovable issues **one certificate per project subdomain**, so crt.sh's CT-log search can enumerate every new Lovable site. **Framer covers ALL customer sites with a single wildcard cert** — crt.sh holds exactly one row, `*.framer.website`, and nothing else (✅ verified). So no amount of crt.sh querying can ever list Framer customer sites. Same for Wix (`wixsite.com`) and Durable (`durable.site`). That's why output was "just Lovable" — the other builders were structurally invisible to the discovery source, and the old `framer.app` zone was wrong anyway (Framer's free sites live on `framer.website`).

### What's in the fix
1. **Two-tier discovery.**
   - **TIER A (crt.sh):** `lovable.app` — per-site certs, unchanged.
   - **TIER B (urlscan):** `framer.website`, `durable.site`, `wixsite.com` via a new `fetchUrlscanBuilderDomains()`: `page.domain:<zone> AND page.status:200 AND date:[last 4 days]`, paginated with `search_after` (same infra /scout already uses).
   - Two live-verified details baked in: **`page.status:200`** (without it the pool is ~all taken-down phishing stubs) and the **full `page.url`** (Wix free sites live at a *path* — `sub.wixsite.com/mysite` — the bare subdomain 404s).
2. **Cross-fallback:** crt.sh zone failing (502s are normal) → that zone falls back to urlscan, and vice versa. One dead source can no longer kill a run.
3. **Dead-page filter (`AI_DEAD_TITLES`):** "Site Not Found | Framer" and "404 Error: Page Not Found | Wix.com" pages return HTTP 200 (✅ both seen live) — they're now dropped before any contact-page fetching.
4. **Durable's internal previews** (`*.preview.durable.site`, its own test bench — ✅ seen live) are filtered out.
5. **Freshness cut:** candidates older than `HUNT_MAX_CERT_AGE_DAYS` (default 14) are skipped when the pool is big enough to afford it. Lead cards now show `🆕 spotted: <date>`.
6. `vercel.app / netlify.app / pages.dev` removed from the `all` scan (developer zones — they belong to PART C's "developer" problem, not a business-lead pool).
7. Wix generator-meta added as a second Wix marker; `assets.squarespace.com` added for Squarespace. Markers verified live: `framerusercontent.com` (55–93 hits on live sites ✅), `cdn.durable.co` on a real coaching business ✅, `wixstatic.com` + `generator: Wix.com Website Builder` on 3 live Wix sites ✅.

### Live end-to-end proof (today)
- `/hunt framer`: 39 candidates passed the gate → checked → **1 developer portfolio auto-flagged 👨‍💻, 3 sites delivered** (incl. a real wedding-photography business 🏢) — in ~3s.
- `/hunt durable`: preview junk filtered → **2 live Durable sites delivered** (a Milano performance-coaching business, a community nonprofit).
- `/hunt wix`: keyword gate cut 3,275 scans → 3 live Wix sites delivered via their correct full-path URLs.

---

## PART C — "results are developers and shit" → 🏢 / 🌐 toggle

1. **New classifier `classifySiteKind()`** — pure rules, no extra network calls, runs inside `analyzeAiSite()`. Returns `REAL_BUSINESS | DEVELOPER | UNCERTAIN` plus the exact matched signals.
   - Dev signals: portfolio / developer wording / "hire me" / resume / side project / "built with …" / demo notices / placeholder text / example.com emails / GitHub links / host-label segments (`demo`, `test`, `clone`, `dev`… — matched as exact hyphen segments, so `devonplumbing` is safe).
   - Business signals: `tel:` link, prices, booking widgets (Calendly, Booksy, Square, Acuity…), street addresses, opening hours, contact page, niche keyword in the host label.
   - ≥2 dev signals → DEVELOPER · else ≥2 business signals → REAL_BUSINESS · else UNCERTAIN. A single-page site with zero business signals counts as dev.
2. **The toggle:** every hunt keyboard now has a `🏢 Business sites only ✅ | 🌐 Show everything` row. Stored per user in Redis `hunt:mode:{userId}` (default `business`).
   - Business mode: DEVELOPER leads are never delivered but are **counted** — the batch header says `🏢 Skipped N developer/portfolio sites — tap 🌐 …`.
   - All-mode: everything comes back, tagged `🏢 real business` / `👨‍💻 developer/portfolio` / `❔ unclear` on every lead card.
3. **`/check <url>`** now shows the classification **and the exact matched signals** ("why dev: portfolio, github link") so you can judge borderline cases yourself.

---

## PART A — "/scout gave me 1000-day-old stores in a 5-day window"

### The real root cause
Not a leak. There are TWO dates in play: the `date:[from TO to]` filter you pick filters **when urlscan last scanned the page** — an ancient store scanned yesterday still matches a 5-day window. Store age (`🎂`) is computed separately and was never linked to your window. (Code-audit also confirmed every continuation page rebuilds its query through the same date filter — no actual bug there.)

### The fix (your choice, not a forced slowdown)
After picking a window, /scout now asks one extra question:

```
🆕 Only stores born in this window   |   ♻️ Any store age (faster)
```

- **Age gate ON** → the window length (5-day range = 5 days) is enforced against each store's **first-ever certificate** (the true birthday, incl. expired certs — same source the 🎂 tag already uses). Older stores are dropped, logged to `/others` as `store too old (Xd, window Yd)`, and the header shows `🎂 Store age ≤ 5d enforced`. Stores whose age can't be proven are **kept** but tagged `🎂 age unknown — no source could prove it` (never drop on missing data).
- **Age gate OFF** → behaves exactly like today (no extra lookups, no latency).
- The 🌱 freshness presets for "Any time" searches work exactly as before — untouched path.

---

## Deploy

1. Replace `api/scraper_bot.js` with this file → `vercel --prod` (or push → auto-deploy).
2. Nothing else to install. Optional env: `HUNT_MAX_CERT_AGE_DAYS=14` (default works fine).

## New config keys

| Key | Meaning | Default |
|---|---|---|
| `hunt:mode:{userId}` (Redis) | per-user 🏢/🌐 hunt filter | `business` |
| `HUNT_MAX_CERT_AGE_DAYS` (env) | skip AI-hunt candidates older than this | `14` |

## Tests

- `30/30` unit tests pass on the new logic (keyword gate, builder detection, dead titles, classifier incl. false-positive guards, window-day math).
- Live E2E on all three Tier-B zones green (see PART B proof above). Lovable (Tier A/crt.sh) path unchanged from the version that already worked.
