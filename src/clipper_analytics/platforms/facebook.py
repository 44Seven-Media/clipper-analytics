"""Facebook Pages: followers, daily views, and recent Reels with play counts."""
from __future__ import annotations

from ..models import CollectError, Post, Snapshot
from . import meta
from .base import Collector, to_int

# Meta renames these every so often. The first one that works is used.
PAGE_VIEW_METRICS = ["page_media_view", "page_impressions"]
REEL_VIEW_METRICS = ["blue_reels_play_count", "fb_reels_total_plays", "total_video_views"]


class FacebookCollector(Collector):
    platform = "facebook"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.page_metrics = list(PAGE_VIEW_METRICS)
        self.reel_metrics = list(REEL_VIEW_METRICS)

    def _page(self, handle: str) -> dict:
        h = handle.lstrip("@").lower()
        for p in meta.discover(self.http):
            if h in (p["id"], (p.get("username") or "").lower(), p.get("name", "").lower()):
                return p
        names = ", ".join(f"{p.get('name')} ({p['id']})" for p in meta.discover(self.http)) or "none"
        raise CollectError(f"Facebook Page '{handle}' isn't available to the Meta token. Pages it can see: {names}")

    def _page_views(self, page_id: str, tok: str) -> int | None:
        since, until = meta.yesterday_window()
        while self.page_metrics:
            m = self.page_metrics[0]
            try:
                body = meta.get(self.http, f"{page_id}/insights", tok, metric=m, period="day",
                                since=since, until=until)
            except meta.GraphError:
                self.page_metrics.pop(0)
                continue
            for series in body.get("data", []):
                vals = series.get("values") or []
                if vals:
                    return to_int(vals[-1].get("value"))
            return None
        return None

    def _reel_views(self, reel_id: str, tok: str) -> int | None:
        while self.reel_metrics:
            m = self.reel_metrics[0]
            try:
                body = meta.get(self.http, f"{reel_id}/video_insights", tok, metric=m)
            except meta.GraphError:
                self.reel_metrics.pop(0)
                continue
            for series in body.get("data", []):
                vals = series.get("values") or []
                if vals:
                    return to_int(vals[-1].get("value"))
            return None
        return None

    def fetch(self, account) -> Snapshot:
        conn = self.connection(account)
        if conn:  # connected on the live page: a permanent Page token
            page = {"id": account.external_id or account.handle, "access_token": conn["access_token"]}
        else:     # otherwise find the Page through the System User token
            page = self._page(account.handle)
        tok = page.get("access_token") or meta.token()
        info = meta.get(self.http, page["id"], tok, fields="name,link,followers_count,fan_count,picture{url}")
        snap = Snapshot(
            followers=to_int(info.get("followers_count")) or to_int(info.get("fan_count")),
            profile_url=info.get("link") or f"https://www.facebook.com/{page['id']}",
            avatar=(info.get("picture", {}).get("data") or {}).get("url", ""),
            views_day=self._page_views(page["id"], tok),
        )
        n = self.settings.recent_posts
        if n > 0:
            try:
                reels = meta.paged(self.http, f"{page['id']}/video_reels", tok, n,
                                   fields="id,description,created_time,permalink_url,picture,length")
            except meta.GraphError as e:
                reels = []
                snap.note = f"Couldn't list Reels: {e}"
            for r in reels:
                link = r.get("permalink_url", "")
                if link.startswith("/"):
                    link = "https://www.facebook.com" + link
                snap.posts.append(Post(
                    post_id=r["id"],
                    published_at=r.get("created_time", ""),
                    title=(r.get("description") or "").strip()[:200],
                    url=link,
                    thumbnail=r.get("picture", ""),
                    duration_s=int(float(r["length"])) if r.get("length") else None,
                    views=self._reel_views(r["id"], tok),
                ))
            if reels and not self.reel_metrics:
                snap.note = "Meta didn't return Reel play counts for this Page."
        return snap
