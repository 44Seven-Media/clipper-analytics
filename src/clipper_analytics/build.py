"""Builds the dashboard: one HTML page with the whole history embedded, so it opens offline-ish
(only the chart library comes from a CDN) and can be shared as a single file."""
from __future__ import annotations

import csv
import json
from datetime import datetime, timedelta, timezone
from importlib import resources
from pathlib import Path

from .config import Config

MAX_POSTS = 20000


def _rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _n(v):
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def payload(cfg: Config, demo: bool = False) -> dict:
    data = cfg.data_dir
    meta = {r["account"]: r for r in _rows(data / "accounts.csv")}
    accounts = []
    for a in cfg.accounts:
        m = meta.get(a.id, {})
        accounts.append({
            "id": a.id, "name": a.name, "platform": a.platform, "handle": a.handle,
            "group": a.group, "url": m.get("profile_url", ""), "avatar": m.get("avatar", ""),
            "lastSuccess": m.get("last_success", ""),
        })
    known = {a["id"] for a in accounts}
    daily = [
        [r["date"], r["account"], _n(r["followers"]), _n(r["views_lifetime"]), _n(r["views_day"]),
         _n(r["likes_total"]), r["status"], r["note"]]
        for r in _rows(data / "daily.csv") if r["account"] in known
    ]
    cutoff = (datetime.now(timezone.utc) - timedelta(days=400)).strftime("%Y-%m-%d")
    posts = [r for r in _rows(data / "posts.csv")
             if r["account"] in known and (r.get("published_at") or r.get("first_seen", ""))[:10] >= cutoff]
    posts.sort(key=lambda r: _n(r.get("views")) or 0, reverse=True)
    posts = [
        [r["account"], r["post_id"], r.get("published_at", "") or r.get("first_seen", ""), r.get("title", ""),
         r.get("url", ""), r.get("thumbnail", ""), _n(r.get("views")), _n(r.get("likes")),
         _n(r.get("comments")), _n(r.get("shares")), _n(r.get("views_prev")), r.get("prev_date", ""),
         r.get("last_seen", "")]
        for r in posts[:MAX_POSTS]
    ]
    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "demo": demo,
        "accounts": accounts,
        "daily": daily,
        "posts": posts,
    }


def render(data: dict, fragment: bool = False) -> str:
    tpl = resources.files("clipper_analytics").joinpath("dashboard_template.html").read_text(encoding="utf-8")
    blob = json.dumps(data, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    body = tpl.replace("__DATA__", blob)
    if fragment:
        return body
    # A standalone file keeps its <title> in the head.
    title = ""
    start, end = body.find("<title>"), body.find("</title>")
    if start != -1 and end != -1:
        title, body = body[start:end + 8], body[:start] + body[end + 8:]
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            + title + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')


def build(cfg: Config, out: Path | None = None, fragment: bool = False, demo: bool = False) -> Path:
    out = out or cfg.dashboard_path
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(payload(cfg, demo=demo), fragment=fragment), encoding="utf-8")
    return out
