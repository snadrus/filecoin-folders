#!/usr/bin/env python3
"""Print space-separated accounts to stdout, refusing any that are currently ready in the warm pool."""
import json, os, sys, urllib.request

want = [a.strip() for a in os.environ.get("ACCOUNTS", "").replace(",", " ").split() if a.strip()]
if not want:
    raise SystemExit("no accounts")
req = urllib.request.Request("https://fast.scionbase.ai/pool", headers={"User-Agent": "Mozilla/5.0"})
pool = json.load(urllib.request.urlopen(req, timeout=30))
ready = {str(e.get("account", "")).lower() for e in pool.get("entries") or [] if e.get("status") == "ready"}
blocked = [a for a in want if a.lower() in ready]
if blocked:
    print("refusing to sweep ready pool accounts:", ", ".join(blocked), file=sys.stderr)
    raise SystemExit(2)
print("sweeping", len(want), "accounts; ready pool left untouched:", ", ".join(sorted(ready)) or "(none)", file=sys.stderr)
for a in want:
    print(a)
