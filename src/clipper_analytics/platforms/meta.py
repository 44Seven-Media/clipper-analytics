"""Shared Meta Graph API helpers for Facebook Pages and Instagram.

Uses one System User token (Meta Business Suite → Settings → System users) that has been
given access to every Page and Instagram account. System User tokens don't expire.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx

from ..config import secret
from ..models import CollectError, NotConfigured
from ..net import request

GRAPH_VERSION = "v24.0"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"


class GraphError(CollectError):
    def __init__(self, msg: str, code: int | None = None):
        super().__init__(msg)
        self.code = code


def token() -> str:
    t = secret("META_ACCESS_TOKEN")
    if not t:
        raise NotConfigured("META_ACCESS_TOKEN is not set")
    return t


def get(http: httpx.Client, path: str, access_token: str, **params) -> dict:
    url = path if path.startswith("http") else f"{GRAPH}/{path.lstrip('/')}"
    r = request(http, "GET", url, params={**params, "access_token": access_token})
    try:
        body = r.json()
    except ValueError:
        body = {}
    if r.status_code != 200 or "error" in body:
        err = body.get("error", {}) if isinstance(body, dict) else {}
        code = err.get("code")
        msg = err.get("message") or r.text[:200]
        if code == 190:
            msg = f"Meta token expired or revoked. Create a new System User token. ({msg})"
        raise GraphError(f"Meta API: {msg}", code)
    return body


def paged(http: httpx.Client, path: str, access_token: str, limit: int, **params) -> list[dict]:
    out: list[dict] = []
    body = get(http, path, access_token, limit=min(limit, 100), **params)
    while True:
        out.extend(body.get("data", []))
        nxt = body.get("paging", {}).get("next")
        if len(out) >= limit or not nxt:
            return out[:limit]
        body = get(http, nxt, access_token)


_DISCOVERY: dict[str, list[dict]] = {}


def discover(http: httpx.Client) -> list[dict]:
    """Every Page the token can manage, with its Page token and linked Instagram account."""
    t = token()
    if t not in _DISCOVERY:
        _DISCOVERY[t] = paged(
            http, "me/accounts", t, 500,
            fields="id,name,username,link,access_token,followers_count,"
                   "instagram_business_account{id,username,followers_count}",
        )
    return _DISCOVERY[t]


def yesterday_window() -> tuple[int, int]:
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=1)
    return int(start.timestamp()), int(today.timestamp())
