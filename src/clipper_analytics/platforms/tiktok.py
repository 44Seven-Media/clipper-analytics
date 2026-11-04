"""TikTok Display API. Each account is connected once with `clipper auth tiktok <id>`.

Access tokens last 24 hours, so every run swaps the saved refresh token (valid 365 days,
renewed on use) for a fresh access token and saves whatever refresh token TikTok returns.
"""
from __future__ import annotations

import secrets
import time
import urllib.parse

from ..config import secret
from ..models import CollectError, NotConfigured, Post, Snapshot
from ..net import request
from .base import Collector, to_int

AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/"
TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"
API = "https://open.tiktokapis.com/v2"
SCOPES = "user.info.basic,user.info.profile,user.info.stats,video.list"
USER_FIELDS = "open_id,display_name,username,avatar_url,profile_deep_link,follower_count,following_count,likes_count,video_count"
VIDEO_FIELDS = "id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count"


def client_creds() -> tuple[str, str]:
    key, sec = secret("TIKTOK_CLIENT_KEY"), secret("TIKTOK_CLIENT_SECRET")
    if not key or not sec:
        raise NotConfigured("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set")
    return key, sec


def authorize_url(redirect_uri: str) -> tuple[str, str]:
    key, _ = client_creds()
    state = secrets.token_urlsafe(16)
    q = urllib.parse.urlencode({
        "client_key": key, "scope": SCOPES, "response_type": "code",
        "redirect_uri": redirect_uri, "state": state,
    })
    return f"{AUTH_URL}?{q}", state


def _token_call(http, data: dict) -> dict:
    r = request(http, "POST", TOKEN_URL, data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"})
    body = r.json() if r.content else {}
    if r.status_code != 200 or "access_token" not in body:
        msg = body.get("error_description") or body.get("error") or r.text[:200]
        raise CollectError(f"TikTok sign-in failed: {msg}")
    return body


def exchange_code(http, code: str, redirect_uri: str) -> dict:
    key, sec = client_creds()
    body = _token_call(http, {
        "client_key": key, "client_secret": sec, "code": code,
        "grant_type": "authorization_code", "redirect_uri": redirect_uri,
    })
    return _token_record(body)


def _token_record(body: dict) -> dict:
    now = int(time.time())
    return {
        "open_id": body.get("open_id", ""),
        "access_token": body["access_token"],
        "access_expires": now + int(body.get("expires_in", 86400)),
        "refresh_token": body.get("refresh_token", ""),
        "refresh_expires": now + int(body.get("refresh_expires_in", 31536000)),
        "scope": body.get("scope", ""),
    }


class TikTokCollector(Collector):
    platform = "tiktok"

    def _access_token(self, account) -> str:
        key, sec = client_creds()
        if self.tokens is None:
            raise NotConfigured("TikTok token store unavailable")
        rec = self.tokens.get(account.id)
        if not rec:
            raise CollectError(f"Not connected yet. Run: clipper auth tiktok {account.id}")
        now = int(time.time())
        if rec.get("access_expires", 0) - 300 > now:
            return rec["access_token"]
        if rec.get("refresh_expires", 0) < now:
            raise CollectError(f"TikTok connection expired. Run: clipper auth tiktok {account.id}")
        body = _token_call(self.http, {
            "client_key": key, "client_secret": sec,
            "grant_type": "refresh_token", "refresh_token": rec["refresh_token"],
        })
        new = _token_record(body)
        new["open_id"] = new["open_id"] or rec.get("open_id", "")
        new["refresh_token"] = new["refresh_token"] or rec["refresh_token"]
        self.tokens.put(account.id, new)
        return new["access_token"]

    @staticmethod
    def _check(r) -> dict:
        try:
            body = r.json()
        except ValueError:
            raise CollectError(f"TikTok API {r.status_code}: {r.text[:200]}")
        err = body.get("error", {})
        if r.status_code != 200 or (err.get("code") not in (None, "ok")):
            raise CollectError(f"TikTok API: {err.get('message') or err.get('code') or r.status_code}")
        return body.get("data", {})

    def fetch(self, account) -> Snapshot:
        tok = self._access_token(account)
        auth = {"Authorization": f"Bearer {tok}"}
        u = self._check(request(self.http, "GET", f"{API}/user/info/", params={"fields": USER_FIELDS}, headers=auth))
        u = u.get("user", {})
        want = account.handle.lstrip("@").lower()
        got = (u.get("username") or "").lower()
        note = ""
        if got and want and got != want:
            note = f"Connected TikTok is @{got}, but accounts.toml says @{want}."
        snap = Snapshot(
            followers=to_int(u.get("follower_count")),
            following=to_int(u.get("following_count")),
            likes_total=to_int(u.get("likes_count")),
            posts_count=to_int(u.get("video_count")),
            profile_url=u.get("profile_deep_link") or f"https://www.tiktok.com/@{got or want}",
            avatar=u.get("avatar_url", ""),
            note=note,
        )
        remaining, cursor = self.settings.recent_posts, None
        while remaining > 0:
            payload = {"max_count": min(remaining, 20)}
            if cursor:
                payload["cursor"] = cursor
            d = self._check(request(self.http, "POST", f"{API}/video/list/", params={"fields": VIDEO_FIELDS},
                                    json=payload, headers=auth))
            vids = d.get("videos", [])
            for v in vids:
                created = to_int(v.get("create_time"))
                snap.posts.append(Post(
                    post_id=str(v["id"]),
                    published_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created)) if created else "",
                    title=(v.get("title") or v.get("video_description") or "").strip()[:200],
                    url=v.get("share_url", ""),
                    thumbnail=v.get("cover_image_url", ""),
                    duration_s=to_int(v.get("duration")),
                    views=to_int(v.get("view_count")),
                    likes=to_int(v.get("like_count")),
                    comments=to_int(v.get("comment_count")),
                    shares=to_int(v.get("share_count")),
                ))
            remaining -= len(vids)
            if not d.get("has_more") or not vids:
                break
            cursor = d.get("cursor")
        return snap
