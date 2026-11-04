"""X API v2 with an app bearer token. Followers come from one batched lookup for all accounts;
recent posts (with view counts) are optional because X bills per post read."""
from __future__ import annotations

from ..config import secret
from ..models import CollectError, NotConfigured, Post, Snapshot
from ..net import request
from .base import Collector, to_int

API = "https://api.x.com/2"


class XCollector(Collector):
    platform = "x"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.users: dict[str, dict] = {}
        self.lookup_error = ""

    def _headers(self) -> dict:
        t = secret("X_BEARER_TOKEN")
        if not t:
            raise NotConfigured("X_BEARER_TOKEN is not set")
        return {"Authorization": f"Bearer {t}"}

    def _get(self, path: str, **params) -> dict:
        r = request(self.http, "GET", f"{API}/{path}", params=params, headers=self._headers())
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code != 200:
            msg = body.get("detail") or body.get("title") or r.text[:200]
            if r.status_code == 402:
                msg = f"X API credits ran out. Top up at console.x.com. ({msg})"
            raise CollectError(f"X API {r.status_code}: {msg}")
        return body

    def prepare(self, accounts) -> None:
        names = [a.handle.lstrip("@") for a in accounts]
        try:
            self._headers()
        except NotConfigured:
            return
        for i in range(0, len(names), 100):
            try:
                body = self._get("users/by", usernames=",".join(names[i:i + 100]),
                                 **{"user.fields": "public_metrics,profile_image_url"})
            except CollectError as e:
                self.lookup_error = str(e)
                return
            for u in body.get("data", []):
                self.users[u["username"].lower()] = u

    def fetch(self, account) -> Snapshot:
        self._headers()
        if self.lookup_error:
            raise CollectError(self.lookup_error)
        name = account.handle.lstrip("@").lower()
        u = self.users.get(name)
        if not u:
            raise CollectError(f"No X account found for @{name}")
        pm = u.get("public_metrics", {})
        snap = Snapshot(
            followers=to_int(pm.get("followers_count")),
            following=to_int(pm.get("following_count")),
            posts_count=to_int(pm.get("tweet_count")),
            likes_total=to_int(pm.get("like_count")),
            profile_url=f"https://x.com/{u['username']}",
            avatar=u.get("profile_image_url", ""),
        )
        n = self.settings.x_recent_posts
        if n > 0:
            body = self._get(f"users/{u['id']}/tweets", max_results=max(5, min(n, 100)),
                             exclude="retweets,replies",
                             **{"tweet.fields": "public_metrics,created_at", "expansions": "attachments.media_keys",
                                "media.fields": "preview_image_url,duration_ms"})
            media = {m["media_key"]: m for m in body.get("includes", {}).get("media", [])}
            for t in body.get("data", [])[:n]:
                tm = t.get("public_metrics", {})
                keys = t.get("attachments", {}).get("media_keys", [])
                m = media.get(keys[0], {}) if keys else {}
                snap.posts.append(Post(
                    post_id=t["id"],
                    published_at=t.get("created_at", ""),
                    title=(t.get("text") or "").strip()[:200],
                    url=f"https://x.com/{u['username']}/status/{t['id']}",
                    thumbnail=m.get("preview_image_url", ""),
                    duration_s=(to_int(m.get("duration_ms")) or 0) // 1000 or None,
                    views=to_int(tm.get("impression_count")),
                    likes=to_int(tm.get("like_count")),
                    comments=to_int(tm.get("reply_count")),
                    shares=(to_int(tm.get("retweet_count")) or 0) + (to_int(tm.get("quote_count")) or 0),
                ))
        return snap
