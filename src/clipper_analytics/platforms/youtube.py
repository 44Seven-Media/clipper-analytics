"""YouTube Data API v3 with an API key: public channel stats plus recent uploads.

Costs about 3 quota units per channel per day (the free quota is 10,000).
"""
from __future__ import annotations

import re

from ..config import secret
from ..models import CollectError, NotConfigured, Post, Snapshot
from ..net import request
from .base import Collector, to_int

API = "https://www.googleapis.com/youtube/v3"
CHANNEL_ID_RE = re.compile(r"UC[\w-]{22}")
DURATION_RE = re.compile(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?")


def parse_duration(iso: str) -> int | None:
    m = DURATION_RE.fullmatch(iso or "")
    if not m:
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + s


class YouTubeCollector(Collector):
    platform = "youtube"

    def _get(self, path: str, **params) -> dict:
        key = secret("YOUTUBE_API_KEY")
        if not key:
            raise NotConfigured("YOUTUBE_API_KEY is not set")
        r = request(self.http, "GET", f"{API}/{path}", params={**params, "key": key})
        if r.status_code != 200:
            try:
                msg = r.json()["error"]["message"]
            except Exception:
                msg = r.text[:200]
            raise CollectError(f"YouTube API {r.status_code}: {msg}")
        return r.json()

    def fetch(self, account) -> Snapshot:
        h = account.handle
        if CHANNEL_ID_RE.fullmatch(h):
            lookup = {"id": h}
        else:
            lookup = {"forHandle": h if h.startswith("@") else f"@{h}"}
        data = self._get("channels", part="snippet,statistics,contentDetails", **lookup)
        items = data.get("items") or []
        if not items:
            raise CollectError(f"No YouTube channel found for '{h}'")
        ch = items[0]
        st = ch.get("statistics", {})
        sn = ch.get("snippet", {})
        snap = Snapshot(
            followers=None if st.get("hiddenSubscriberCount") else to_int(st.get("subscriberCount")),
            posts_count=to_int(st.get("videoCount")),
            views_lifetime=to_int(st.get("viewCount")),
            profile_url=f"https://www.youtube.com/{sn['customUrl']}" if sn.get("customUrl") else f"https://www.youtube.com/channel/{ch['id']}",
            avatar=(sn.get("thumbnails", {}).get("default") or {}).get("url", ""),
        )
        uploads = ch.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
        n = min(self.settings.recent_posts, 50)
        if uploads and n > 0:
            pl = self._get("playlistItems", part="contentDetails", playlistId=uploads, maxResults=n)
            ids = [i["contentDetails"]["videoId"] for i in pl.get("items", [])]
            if ids:
                vids = self._get("videos", part="snippet,statistics,contentDetails", id=",".join(ids))
                for v in vids.get("items", []):
                    vs, vn = v.get("statistics", {}), v.get("snippet", {})
                    dur = parse_duration(v.get("contentDetails", {}).get("duration", ""))
                    is_short = dur is not None and dur <= 180
                    snap.posts.append(Post(
                        post_id=v["id"],
                        published_at=vn.get("publishedAt", ""),
                        title=vn.get("title", ""),
                        url=f"https://www.youtube.com/{'shorts/' if is_short else 'watch?v='}{v['id']}",
                        thumbnail=(vn.get("thumbnails", {}).get("medium") or {}).get("url", ""),
                        duration_s=dur,
                        views=to_int(vs.get("viewCount")),
                        likes=to_int(vs.get("likeCount")),
                        comments=to_int(vs.get("commentCount")),
                    ))
        return snap
