"""Sample data so the dashboard can be seen before any account is connected.

Writes a self-contained demo project (its own accounts.toml and data/) that never touches the
real history. Numbers are invented and the dashboard labels them as sample data.
"""
from __future__ import annotations

import math
import random
from datetime import date, timedelta
from pathlib import Path

from .config import Account, Config, Settings
from .models import Post, Snapshot
from .store import Store

BRANDS = [
    ("REAL AF Clips", "REAL AF"), ("75 Hard Daily", "75 Hard"), ("MFCEO Moments", "MFCEO"),
    ("Andy Frisella Clips", "REAL AF"), ("CTI Highlights", "REAL AF"), ("Operator Standard Clips", "Operator Standard"),
]
# platform: (follower base range, daily views per follower, posts/day)
PROFILE = {
    "tiktok": ((40_000, 900_000), 0.55, 3),
    "instagram": ((20_000, 400_000), 0.35, 2),
    "youtube": ((10_000, 300_000), 0.45, 2),
    "facebook": ((15_000, 250_000), 0.25, 2),
    "x": ((3_000, 60_000), 0.30, 3),
}
TOPICS = [
    "Why discipline beats motivation", "The truth about comfort", "Stop waiting for permission",
    "75 Hard changed everything", "What winners do at 5 AM", "Nobody is coming to save you",
    "How to handle haters", "Build the business you want", "Keep promises to yourself",
    "The cost of being average", "Your friends are holding you back", "Do the hard thing first",
    "Andy on starting 1st Phorm", "Most people quit right here", "Confidence comes from proof",
]


def _slug(s: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in s).strip("-").replace("--", "-")


def make(root: Path, days: int = 120, seed: int = 7) -> Config:
    rnd = random.Random(seed)
    accounts: list[Account] = []
    lines = ["# Sample accounts for the demo dashboard. Not real.\n"]
    plats = list(PROFILE)
    for i in range(26):
        name, group = BRANDS[i % len(BRANDS)]
        plat = plats[i % len(plats)]
        aid = f"{_slug(name)}-{plat}"
        handle = _slug(name).replace("-", "")
        accounts.append(Account(aid, name, plat, handle, group))
        lines.append(f'[[accounts]]\nid = "{aid}"\nname = "{name}"\nplatform = "{plat}"\nhandle = "{handle}"\ngroup = "{group}"\n')
    (root / "config").mkdir(parents=True, exist_ok=True)
    (root / "config" / "accounts.toml").write_text("\n".join(lines))
    cfg = Config(root=root, accounts=accounts, settings=Settings())

    for f in ("daily.csv", "posts.csv", "accounts.csv"):
        (cfg.data_dir / f).unlink(missing_ok=True)
    store = Store(cfg.data_dir)
    end = date.today()
    start = end - timedelta(days=days - 1)
    state = {}
    for a in accounts:
        (lo, hi), vpf, ppd = PROFILE[a.platform]
        launch = rnd.choice([0, 0, 0, 0, 20, 45, 70])
        state[a.id] = {
            "followers": rnd.randint(lo, hi) // (4 if launch else 1),
            "growth": rnd.uniform(0.002, 0.012), "vpf": vpf * rnd.uniform(0.5, 1.6),
            "ppd": ppd, "launch": launch, "views": 0, "likes": 0, "n": 0, "posts": [],
        }
    for d in range(days):
        day = start + timedelta(days=d)
        iso = day.isoformat()
        for a in accounts:
            s = state[a.id]
            if d < s["launch"]:
                continue
            # A few viral days per account: views and follows jump together.
            viral = rnd.random() < 0.035
            boost = rnd.uniform(4, 12) if viral else rnd.uniform(0.6, 1.4)
            weekly = 1 + 0.12 * math.sin(2 * math.pi * day.weekday() / 7)
            day_views = int(s["followers"] * s["vpf"] * boost * weekly)
            gained = int(s["followers"] * s["growth"] * boost * rnd.uniform(0.5, 1.3))
            if rnd.random() < 0.06:
                gained = -int(gained * rnd.uniform(0.1, 0.5))
            s["followers"] = max(100, s["followers"] + gained)
            s["views"] += day_views
            s["likes"] += int(day_views * 0.06)
            # New clips today; older clips keep picking up views.
            for _ in range(rnd.randint(max(0, s["ppd"] - 1), s["ppd"] + 1)):
                s["n"] += 1
                topic = rnd.choice(TOPICS)
                s["posts"].append({"id": f"{a.id}-{s['n']}", "day": d, "title": topic,
                                   "weight": rnd.lognormvariate(0, 1.1) * (8 if viral else 1), "views": 0})
            live = [p for p in s["posts"] if d - p["day"] < 30]
            total_w = sum(p["weight"] / (1 + (d - p["day"]) * 0.6) for p in live) or 1
            for p in live:
                p["views"] += int(day_views * (p["weight"] / (1 + (d - p["day"]) * 0.6)) / total_w)
            snap = Snapshot(
                followers=s["followers"], likes_total=s["likes"], posts_count=s["n"],
                profile_url=f"https://example.com/{a.platform}/{a.handle}",
            )
            if a.platform in ("instagram", "facebook"):
                snap.views_day = day_views
            if a.platform == "youtube":
                snap.views_lifetime = s["views"]
            if d == days - 1 and a.id == accounts[3].id:
                store.record(a, iso, None, "error", "Meta token expired or revoked. Create a new System User token.")
                continue
            recent = live if d < days - 1 else s["posts"]
            store.upsert_posts(a, [
                Post(post_id=p["id"], published_at=(start + timedelta(days=p["day"])).isoformat() + "T15:00:00Z",
                     title=p["title"], url=f"https://example.com/{a.platform}/{a.handle}/{p['id']}",
                     views=p["views"], likes=int(p["views"] * 0.05), comments=int(p["views"] * 0.002),
                     shares=int(p["views"] * 0.004))
                for p in recent
            ], iso)
            store.record(a, iso, snap, "ok")
    store.save()
    return cfg
