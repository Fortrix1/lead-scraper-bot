#!/usr/bin/env python3
"""certstream_watcher.py — run this locally on your PC (not GitHub Actions).

Watches CertStream — a live push feed of certificates as they're issued
across public Certificate Transparency logs — for anything under
myshopify.com. The moment a match comes through, it runs the SAME
"is this genuinely a new store, or just a renewal of an old one" check
your GitHub Actions crt.sh ticks already do (store_first_cert), and if it's
genuinely new, reports it to Telegram immediately.

This is a companion to, not a replacement for, the GitHub Actions side:
- GitHub Actions keeps polling crt.sh on its own schedule as a reliable
  (if slower, and sometimes flaky) fallback.
- This script gets you near-instant notifications while it's running,
  since it doesn't have to poll an overloaded server — certs are pushed
  to it the moment they're issued.
Both share the same Redis "fresh:processed" set, so whichever one sees a
domain first marks it done and the other won't re-report it.

It reads the same /fresh config your Telegram bot already sets (max age,
chat id) — no new commands needed. If /fresh hasn't been run (or
/freshoff was sent), this script just sits idle and reports nothing.

Requires: pip install -r requirements.txt (adds the `certstream` package)
Run with:  python certstream_watcher.py
Leave it running in its own terminal window, the same way you'd run
maps_daemon.py in loop mode. Ctrl+C to stop.
"""

import os
import json
import time
from datetime import datetime, timezone

import certstream

# Reuses everything from maps_daemon.py — same Redis helpers, same Telegram
# sender, same age-check and store-check logic — instead of duplicating it.
# Importing it does NOT start the maps daemon; that only happens under
# maps_daemon.py's own `if __name__ == "__main__":` guard.
import maps_daemon as md

# Public demo endpoint by default. If it proves too unreliable, point this
# at a self-hosted certstream-server-go instance instead — no code changes
# needed, just set the env var.
CERTSTREAM_URL = os.environ.get("CERTSTREAM_URL", "wss://certstream.calidog.io/")

_session = None


def get_session():
    global _session
    if _session is None:
        _session = md.make_session()
    return _session


def extract_candidate_domains(leaf_cert):
    """Pull out anything under myshopify.com from a cert's domain list,
    filtering out Shopify's own infrastructure subdomains — same rules
    maps_daemon.py's crt.sh sweep already uses, kept consistent on purpose."""
    out = set()
    for raw in (leaf_cert.get("all_domains") or []):
        d = str(raw).strip().lower().lstrip("*").lstrip(".")
        m = md.STORE_DOMAIN_RE.match(d)
        if m and m.group(1) not in md.CRTSH_INFRA_LABELS:
            out.add(d)
    return out


def handle_candidate(domain):
    cfg_raw = md.redis_get("fresh:config")
    if not cfg_raw:
        return  # /fresh isn't active — nothing to do
    try:
        cfg = json.loads(cfg_raw)
    except Exception:
        return

    if md.redis_sismember("fresh:processed", domain):
        return  # GitHub Actions (or this script, earlier) already handled it

    # We just SAW a cert get issued for this domain — but that could still
    # be a renewal cert for a years-old store, not a new one. Confirm by
    # pulling the domain's FULL cert history and checking its true
    # first-ever certificate, exactly like the GitHub Actions side does.
    session = get_session()
    first = md.store_first_cert(session, domain)
    if not first:
        return  # lookup failed — a later GitHub Actions tick will retry it

    md.redis_sadd("fresh:processed", domain)
    age_days = (datetime.now(timezone.utc) - first).days
    max_age = int(cfg.get("max_age_days", 30))
    if age_days > max_age:
        return  # real store, just not a NEW one

    chat_id = str(cfg.get("chat_id", ""))
    if not chat_id:
        return

    info = md.quick_store_check(domain)
    icon = {"live": "🟢", "locked": "🔒", "dead": "💀"}.get(info.get("status"), "❔")
    lines = [
        "⚡ LIVE — new Shopify store, cert just issued",
        "",
        f"{domain} {icon}",
        f"🎂 {first.strftime('%Y-%m-%d')} ({age_days}d old)",
    ]
    if info.get("custom_domain"):
        lines.append(f"🌐 {info['custom_domain']}")
    if info.get("title"):
        lines.append(f"🏷️ {info['title']}")
    if info.get("email"):
        lines.append(f"📧 {info['email']}")
    lines.append(f"🔗 https://{domain}")

    md.send_telegram(chat_id, "\n".join(lines))
    print(f"  ⚡ {domain} — {age_days}d old — reported to Telegram")


def on_message(message, context):
    if message.get("message_type") != "certificate_update":
        return
    leaf_cert = message.get("data", {}).get("leaf_cert", {})
    for domain in extract_candidate_domains(leaf_cert):
        try:
            handle_candidate(domain)
        except Exception as e:
            # Never let one bad candidate kill the whole stream connection.
            print(f"  error handling {domain}: {e}")


def on_error(ws, error, context=None):
    print(f"  certstream connection error: {error}")


def main():
    print("┌──────────────────────────────────┐")
    print("│  CertStream Watcher               │")
    print("│  Live feed → new Shopify stores   │")
    print("└──────────────────────────────────┘")
    print(f"Connecting to {CERTSTREAM_URL} ...")
    print("(Reports use the same /fresh config as GitHub Actions — "
          "send /fresh in Telegram if you haven't already.)")
    while True:
        try:
            certstream.listen_for_events(on_message, url=CERTSTREAM_URL, on_error=on_error)
        except KeyboardInterrupt:
            print("\nStopped.")
            break
        except Exception as e:
            print(f"  connection dropped ({e}) — reconnecting in 10s...")
            time.sleep(10)


if __name__ == "__main__":
    main()
