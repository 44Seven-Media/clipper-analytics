"""Instagram (Business/Creator accounts linked to a Facebook Page): followers, daily views, recent posts."""
from __future__ import annotations

from ..models import CollectError, Post, Snapshot
from . import meta
from .base import Collector, to_int


class InstagramCollector(Collector):
    platform = "instagram"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.media_metrics = ["views,shares", "views", "plays"]
        self.account_views = True

    def _ig_id(self, handle: str) -> str:
        h = handle.lstrip("@").lower()
        pages = meta.discover(self.http)
        for p in pages:
            ig = p.get("instagram_business_account") or {}
            if ig and h in (ig.get("id"), (ig.get("username") or "").lower()):
                return ig["id"]
        linked = ", ".join(
            "@" + p["instagram_business_account"]["username"]
            for p in pages if p.get("instagram_business_account", {}).get("username")
        ) or "none"
        raise CollectError(
            f"Instagram @{h} isn't linked to a Facebook Page the Meta token can see. "
            f"Make it a Business/Creator account linked to a Page. Linked accounts: {linked}"
        )

    def _media_insights(self, media_id: str, tok: str) -> dict[str, int]:
        while self.media_metrics:
            m = self.media_metrics[0]
            try:
                body = meta.get(self.http, f"{media_id}/insights", tok, metric=m)
            except meta.GraphError as e:
                # Stories/old posts can reject a metric that works elsewhere; only drop it on a
                # "metric not supported" style error from the first post.
                if e.code == 100:
                    self.media_metrics.pop(0)
                    continue
                return {}
            out = {}
            for series in body.get("data", []):
                vals = series.get("values") or [{}]
                out[series.get("name", "")] = to_int(vals[0].get("value"))
            return out
        return {}

    def fetch(self, account) -> Snapshot:
        conn = self.connection(account)
        if conn and account.external_id:  # connected on the live page through its Facebook Page
            tok, ig_id = conn["access_token"], account.external_id
        else:
            tok = meta.token()
            ig_id = self._ig_id(account.handle)
        info = meta.get(self.http, ig_id, tok,
                        fields="username,name,followers_count,follows_count,media_count,profile_picture_url")
        snap = Snapshot(
            followers=to_int(info.get("followers_count")),
            following=to_int(info.get("follows_count")),
            posts_count=to_int(info.get("media_count")),
            profile_url=f"https://www.instagram.com/{info.get('username', account.handle.lstrip('@'))}/",
            avatar=info.get("profile_picture_url", ""),
        )
        if self.account_views:
            since, until = meta.yesterday_window()
            try:
                body = meta.get(self.http, f"{ig_id}/insights", tok, metric="views", period="day",
                                metric_type="total_value", since=since, until=until)
                for s in body.get("data", []):
                    snap.views_day = to_int((s.get("total_value") or {}).get("value"))
            except meta.GraphError as e:
                if e.code == 100:
                    self.account_views = False
        n = self.settings.recent_posts
        if n > 0:
            media = meta.paged(
                self.http, f"{ig_id}/media", tok, n,
                fields="id,caption,media_type,media_product_type,timestamp,permalink,"
                       "thumbnail_url,media_url,like_count,comments_count",
            )
            for m in media:
                ins = self._media_insights(m["id"], tok)
                thumb = m.get("thumbnail_url") or (m.get("media_url") if m.get("media_type") == "IMAGE" else "")
                snap.posts.append(Post(
                    post_id=m["id"],
                    published_at=m.get("timestamp", ""),
                    title=(m.get("caption") or "").strip()[:200],
                    url=m.get("permalink", ""),
                    thumbnail=thumb or "",
                    views=ins.get("views", ins.get("plays")),
                    likes=to_int(m.get("like_count")),
                    comments=to_int(m.get("comments_count")),
                    shares=ins.get("shares"),
                ))
        return snap
