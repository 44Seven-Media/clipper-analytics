"""clipper: the command-line tool. Run `clipper --help`."""
from __future__ import annotations

import argparse
import logging
import sys
import urllib.parse
from collections import Counter
from pathlib import Path

from . import build as build_mod
from . import collect, demo
from .config import ConfigError, load_config, secret
from .models import CollectError
from .net import client
from .platforms import meta, tiktok
from .tokens import TokenStore, new_key

CREDS = {
    "youtube": ["YOUTUBE_API_KEY"],
    "facebook": ["META_ACCESS_TOKEN"],
    "instagram": ["META_ACCESS_TOKEN"],
    "tiktok": ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "CLIPPER_TOKEN_KEY"],
    "x": ["X_BEARER_TOKEN"],
}


def cmd_check(args) -> int:
    cfg = load_config()
    counts = Counter(a.platform for a in cfg.accounts)
    print(f"{len(cfg.accounts)} accounts in config/accounts.toml")
    for platform, needed in CREDS.items():
        missing = [n for n in needed if not secret(n)]
        state = "ready" if not missing else "missing " + ", ".join(missing)
        print(f"  {platform:<10} {counts.get(platform, 0):>3} accounts   {state}")
    if counts.get("tiktok") and secret("CLIPPER_TOKEN_KEY"):
        store = TokenStore(cfg.data_dir / "tokens.enc", secret("CLIPPER_TOKEN_KEY"))
        try:
            todo = [a.id for a in cfg.accounts if a.platform == "tiktok" and not store.get(a.id)]
        except CollectError as e:
            print(f"  tiktok: {e}")
        else:
            for aid in todo:
                print(f"  tiktok: {aid} not connected yet. Run: clipper auth tiktok {aid}")
    return 0


def cmd_collect(args) -> int:
    cfg = load_config()
    only = set(args.only) if args.only else None
    s = collect.run(cfg, today=args.date, only=only)
    print(f"Collected {len(s.ok)} accounts, {len(s.failed)} failed, {len(s.skipped)} skipped.")
    for aid, msg in s.failed.items():
        print(f"::warning::{aid}: {msg}" if args.github else f"  FAILED  {aid}: {msg}")
    for aid, msg in s.skipped.items():
        print(f"  skipped {aid}: {msg}")
    if not args.no_build:
        print(f"Dashboard: {build_mod.build(cfg)}")
    return 0


def cmd_build(args) -> int:
    cfg = load_config()
    out = build_mod.build(cfg, out=Path(args.out) if args.out else None, fragment=args.fragment)
    print(f"Dashboard: {out}")
    return 0


def cmd_demo(args) -> int:
    root = Path(args.out).resolve()
    cfg = demo.make(root, days=args.days)
    out = build_mod.build(cfg, out=root / "dashboard.html", fragment=args.fragment, demo=True)
    print(f"Sample dashboard: {out}")
    return 0


def cmd_keygen(args) -> int:
    print(new_key())
    print("Save this as CLIPPER_TOKEN_KEY in .env and as a GitHub Actions secret. Keep it private.",
          file=sys.stderr)
    return 0


def cmd_auth_tiktok(args) -> int:
    cfg = load_config()
    acct = next((a for a in cfg.accounts if a.id == args.account), None)
    if not acct or acct.platform != "tiktok":
        print(f"'{args.account}' isn't a TikTok account in config/accounts.toml", file=sys.stderr)
        return 2
    redirect = secret("TIKTOK_REDIRECT_URI")
    if not redirect:
        print("Set TIKTOK_REDIRECT_URI in .env (the redirect URL registered in your TikTok app).",
              file=sys.stderr)
        return 2
    url, state = tiktok.authorize_url(redirect)
    print(f"1. Open this link in a browser where you're logged into TikTok as {acct.handle}:\n\n{url}\n")
    print("2. Approve access. You'll land on your redirect page.")
    pasted = input("3. Paste the full address of that page here: ").strip()
    q = urllib.parse.parse_qs(urllib.parse.urlparse(pasted).query)
    if q.get("state", [""])[0] != state:
        print("That address doesn't match this sign-in (state check failed). Try again.", file=sys.stderr)
        return 2
    code = q.get("code", [""])[0]
    if not code:
        print(f"No code in that address. TikTok said: {q.get('error_description', q.get('error', ['?']))[0]}",
              file=sys.stderr)
        return 2
    with client() as http:
        rec = tiktok.exchange_code(http, code, redirect)
    store = TokenStore(cfg.data_dir / "tokens.enc", secret("CLIPPER_TOKEN_KEY"))
    store.put(acct.id, rec)
    store.save()
    print(f"Connected {acct.id}. Commit data/tokens.enc so the daily job can use it.")
    return 0


def cmd_discover_meta(args) -> int:
    with client() as http:
        pages = meta.discover(http)
    if not pages:
        print("The Meta token can't see any Pages. Assign Pages to the System User in Business Settings.")
        return 1
    print("# Paste the ones you want into config/accounts.toml\n")
    for p in pages:
        slug = "".join(c.lower() if c.isalnum() else "-" for c in p.get("name", p["id"])).strip("-")
        print(f'[[accounts]]\nid = "{slug}-fb"\nname = "{p.get("name", "")}"\nplatform = "facebook"\nhandle = "{p["id"]}"\n')
        ig = p.get("instagram_business_account") or {}
        if ig.get("username"):
            print(f'[[accounts]]\nid = "{slug}-ig"\nname = "{p.get("name", "")}"\nplatform = "instagram"\nhandle = "{ig["username"]}"\n')
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    ap = argparse.ArgumentParser(prog="clipper", description="Clipper network analytics")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check", help="show accounts and which platforms have credentials").set_defaults(fn=cmd_check)

    p = sub.add_parser("collect", help="fetch today's numbers for every account, then rebuild the dashboard")
    p.add_argument("--only", nargs="+", help="account ids or platform names")
    p.add_argument("--date", help="record under this date (YYYY-MM-DD) instead of today (UTC)")
    p.add_argument("--no-build", action="store_true")
    p.add_argument("--github", action="store_true", help="print failures as GitHub Actions warnings")
    p.set_defaults(fn=cmd_collect)

    p = sub.add_parser("build", help="rebuild dashboard/index.html from the saved history")
    p.add_argument("--out")
    p.add_argument("--fragment", action="store_true", help="omit <html>/<head> wrapper")
    p.set_defaults(fn=cmd_build)

    p = sub.add_parser("demo", help="build a dashboard from invented sample data")
    p.add_argument("--out", default="demo")
    p.add_argument("--days", type=int, default=120)
    p.add_argument("--fragment", action="store_true")
    p.set_defaults(fn=cmd_demo)

    sub.add_parser("keygen", help="create a CLIPPER_TOKEN_KEY").set_defaults(fn=cmd_keygen)

    p = sub.add_parser("auth", help="connect an account that needs a login (TikTok)")
    auth_sub = p.add_subparsers(dest="platform", required=True)
    t = auth_sub.add_parser("tiktok")
    t.add_argument("account", help="account id from accounts.toml")
    t.set_defaults(fn=cmd_auth_tiktok)

    p = sub.add_parser("discover", help="list accounts a token can see")
    d_sub = p.add_subparsers(dest="platform", required=True)
    d_sub.add_parser("meta").set_defaults(fn=cmd_discover_meta)

    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except (ConfigError, CollectError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
