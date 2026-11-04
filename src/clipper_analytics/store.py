"""The history: two CSV files that the daily job appends to and commits.

data/daily.csv   one row per account per day (followers, views, ...)
data/posts.csv   one row per post ever seen, with its latest numbers and yesterday's views
"""
from __future__ import annotations

import csv
from pathlib import Path

from .config import Account
from .models import Post, Snapshot

DAILY_FIELDS = [
    "date", "account", "platform", "followers", "following", "posts_count", "likes_total",
    "views_lifetime", "views_day", "status", "note",
]
POST_FIELDS = [
    "platform", "post_id", "account", "published_at", "title", "url", "thumbnail", "duration_s",
    "views", "likes", "comments", "shares", "views_prev", "prev_date", "first_seen", "last_seen",
]
META_FIELDS = ["account", "profile_url", "avatar", "last_success"]


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _write(path: Path, fields: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in fields})
    tmp.replace(path)


def _int(v) -> int | None:
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


class Store:
    def __init__(self, data_dir: Path):
        self.dir = data_dir
        self.daily_path = data_dir / "daily.csv"
        self.posts_path = data_dir / "posts.csv"
        self.meta_path = data_dir / "accounts.csv"
        self.daily = _read(self.daily_path)
        self.posts = {(r["platform"], r["post_id"]): r for r in _read(self.posts_path)}
        self.meta = {r["account"]: r for r in _read(self.meta_path)}

    # -- posts -------------------------------------------------------------------------------
    def upsert_posts(self, account: Account, posts: list[Post], today: str) -> None:
        for p in posts:
            key = (account.platform, p.post_id)
            old = self.posts.get(key)
            row = dict(old) if old else {
                "platform": account.platform, "post_id": p.post_id, "account": account.id,
                "first_seen": today,
            }
            if old and old.get("last_seen") and old["last_seen"] < today:
                # Roll today's starting point forward so "views gained" is since the last run.
                row["views_prev"] = old.get("views", "")
                row["prev_date"] = old["last_seen"]
            for k in ("published_at", "title", "url", "thumbnail", "duration_s",
                      "views", "likes", "comments", "shares"):
                v = getattr(p, k)
                if v not in (None, ""):
                    row[k] = v
            row["last_seen"] = today
            self.posts[key] = row

    def views_from_posts(self, account: Account) -> int | None:
        vals = [_int(r.get("views")) for r in self.posts.values() if r["account"] == account.id]
        vals = [v for v in vals if v is not None]
        return sum(vals) if vals else None

    # -- daily -------------------------------------------------------------------------------
    def record(self, account: Account, today: str, snap: Snapshot | None, status: str, note: str = "") -> None:
        self.daily = [r for r in self.daily if not (r["date"] == today and r["account"] == account.id)]
        row = {"date": today, "account": account.id, "platform": account.platform,
               "status": status, "note": note}
        if snap is not None:
            views_lifetime = snap.views_lifetime
            if views_lifetime is None:
                views_lifetime = self.views_from_posts(account)
            row.update(
                followers=snap.followers, following=snap.following, posts_count=snap.posts_count,
                likes_total=snap.likes_total, views_lifetime=views_lifetime, views_day=snap.views_day,
            )
            m = self.meta.get(account.id, {"account": account.id})
            if snap.profile_url:
                m["profile_url"] = snap.profile_url
            if snap.avatar:
                m["avatar"] = snap.avatar
            m["last_success"] = today
            self.meta[account.id] = m
        self.daily.append(row)

    def save(self) -> None:
        self.daily.sort(key=lambda r: (r["date"], r["account"]))
        _write(self.daily_path, DAILY_FIELDS, self.daily)
        posts = sorted(self.posts.values(), key=lambda r: (r["account"], r.get("published_at", ""), r["post_id"]))
        _write(self.posts_path, POST_FIELDS, posts)
        _write(self.meta_path, META_FIELDS, sorted(self.meta.values(), key=lambda r: r["account"]))
