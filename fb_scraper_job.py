#!/usr/bin/env python3
"""fb_scraper_job.py - daemon-side runner for Facebook people/pages searches.

maps_daemon.handle_job() routes {type: "fbscrape", ...} jobs here. We run
fb_scraper.py as a subprocess (it needs the saved fb_state.json login session
and a real browser), then read the newest results_*.json and report the
leads back to Telegram in batches + the JSON file as a document.

FIX: the session is now VALIDATED BEFORE the search runs (fb_scraper.
verify_session_report) instead of discovering a broken/mid-verification
session after 25 minutes of nothing. If the session is missing, expired, or
Facebook is showing a checkpoint/2FA wall on it, the user gets an exact
Telegram message telling them what to do — no more silent empty runs.
"""
import asyncio, glob, json, os, subprocess, sys, time
from pathlib import Path

import maps_daemon as md
import fb_scraper

BASE_DIR = Path(__file__).resolve().parent


def card(r, n):
    lines = [f"{n}. {r.get('name') or '(no name)'}", f"   🔗 {r.get('url', '')}"]
    if r.get("location"):
        lines.append(f"   📍 {r['location']}")
    ago = r.get("last_post_days_ago")
    if ago is not None:
        tag = "🟢 active" if ago <= 7 else ("🟡" if ago <= 30 else "🟠")
        lines.append(f"   🕒 last post: {r.get('last_post_date', '')} ({ago:.0f}d ago) {tag}")
    else:
        lines.append("   🕒 activity: unknown (no dated posts visible)")
    if r.get("inferred_age_years") is not None:
        lines.append(f"   🎂 ~{r['inferred_age_years']}y old")
    if r.get("website"):
        lines.append(f"   🌐 {r['website']}")
    if r.get("email"):
        lines.append(f"   📧 {r['email']}")
    if r.get("phone"):
        lines.append(f"   📱 {r['phone']}")
    if r.get("error"):
        lines.append(f"   ⚠️ {r['error']}")
    return "\n".join(lines)


def _session_help() -> str:
    return ("On the PC running the daemon, run once:\n"
            "  python fb_scraper.py login\n\n"
            "If the verification / CAPTCHA page won't load in that window, instead:\n"
            "  1. In your NORMAL browser (where you can solve the 2FA/CAPTCHA), "
            "stay logged into facebook.com\n"
            "  2. Export the cookies with the Cookie-Editor extension, save as cookies.json\n"
            "  3. python fb_scraper.py login --cookies cookies.json\n\n"
            "fb_state.json is gitignored — never push it.")


def process_job(data):
    chat_id = str(data.get("chat_id", ""))
    out = BASE_DIR / "fb_results"
    out.mkdir(parents=True, exist_ok=True)

    state_file = BASE_DIR / "fb_state.json"
    if not state_file.exists():
        md.send_telegram(chat_id,
            "⚠️ No Facebook login session on this machine yet.\n\n" + _session_help())
        return

    # ── Validate the session BEFORE driving a real search ──
    try:
        status = asyncio.run(fb_scraper.verify_session_report())
    except Exception as e:
        status = "unknown"
        print(f"  session pre-check failed to run: {e}")

    if status != "ok":
        if status == "checkpoint":
            md.send_telegram(chat_id,
                "🚧 Facebook is showing a verification / 2FA / CAPTCHA wall on the saved "
                "session (this is the spinning Meta-logo page that never loads in an "
                "automated browser).\n\n"
                "Fix it in your NORMAL browser — where the challenge actually renders:\n"
                "1. Open facebook.com in your everyday browser (same account)\n"
                "2. Complete the verification/2FA there once\n"
                "3. Re-export cookies (Cookie-Editor) and on the daemon PC run:\n"
                "   python fb_scraper.py login --cookies cookies.json\n\n"
                "Your job was NOT run, so nothing was wasted.")
        elif status == "not_logged_in":
            md.send_telegram(chat_id,
                "⚠️ The saved Facebook session has no active login (the c_user/xs cookies "
                "are missing or expired — probably saved while the verification page was "
                "still spinning).\n\n" + _session_help() + "\n\nYour job was NOT run.")
        else:
            md.send_telegram(chat_id,
                "⚠️ Couldn't validate the Facebook session (unexpected error). "
                "On the daemon PC run:\n  python fb_scraper.py login\n\nYour job was NOT run.")
        return

    ftype = "people" if data.get("ftype") == "people" else "pages"
    cmd = [sys.executable, str(BASE_DIR / "fb_scraper.py"), "scrape",
           "--query", str(data.get("query", "")),
           "--type", ftype,
           "--max", str(min(max(int(data.get("max") or 20), 1), 40)),
           "--max-scrolls", "25",
           "--out", str(out)]
    if data.get("country"):
        cmd += ["--country", str(data["country"])]
    if data.get("min_age_years"):
        cmd += ["--min-age-years", str(int(data["min_age_years"]))]
    if data.get("active_within"):
        cmd += ["--active-within", str(int(data["active_within"]))]
    if data.get("active_from"):
        cmd += ["--posted-since", str(data["active_from"])]
    if data.get("active_until"):
        cmd += ["--posted-until", str(data["active_until"])]

    filters = []
    if data.get("country"):     filters.append(f"country {data['country']}")
    if data.get("min_age_years"): filters.append(f"age ≥{data['min_age_years']}y")
    if data.get("active_within"): filters.append(f"posted ≤{data['active_within']}d ago")
    if data.get("active_from"):   filters.append(f"posted since {data['active_from']}")
    if data.get("active_until"):  filters.append(f"posted until {data['active_until']}")
    ftxt = f" [{', '.join(filters)}]" if filters else ""

    md.send_telegram(chat_id,
        f"📘 Facebook search started: {ftype} \"{data.get('query', '')}\"{ftxt} — "
        "this drives a real browser on the daemon PC and visits each profile live. A few minutes...")

    before = set(glob.glob(str(out / "results_*.json")))
    try:
        subprocess.run(cmd, cwd=str(BASE_DIR), timeout=28 * 60)
    except subprocess.TimeoutExpired:
        md.send_telegram(chat_id, "⏱️ Facebook job hit its time limit — sending whatever finished.")

    new_files = sorted(set(glob.glob(str(out / "results_*.json"))) - before,
                       key=os.path.getmtime)
    if not new_files:
        md.send_telegram(chat_id,
            "No results were produced — the search likely found 0 links "
            "(or the session was rejected mid-run). "
            "Check the daemon console and fb_results/debug_search.png to see what Facebook served. "
            "If it shows a login/verification page, re-run: python fb_scraper.py login")
        return
    try:
        kept = json.loads(Path(new_files[-1]).read_text(encoding="utf-8"))
    except Exception as e:
        md.send_telegram(chat_id, f"⚠️ Couldn't read the results file: {e}")
        return

    if not kept:
        md.send_telegram(chat_id,
            "0 leads passed your filters. Loosen the country / age / activity filters and try again.")
        return

    header = f"📘 Facebook results — {len(kept)} lead(s) ({ftype})"
    BATCH = 5
    for i in range(0, len(kept), BATCH):
        chunk = kept[i:i + BATCH]
        msg = header + f" — {i + 1}-{i + len(chunk)} of {len(kept)}"
        for j, r in enumerate(chunk, i + 1):
            msg += "\n\n" + card(r, j)
        md.send_telegram(chat_id, msg)
        time.sleep(1)
    try:
        md.send_telegram_document(chat_id, new_files[-1],
                                  caption=f"Facebook results — {len(kept)} leads (full JSON)")
    except Exception as e:
        print(f"  FB document send failed: {e}")
