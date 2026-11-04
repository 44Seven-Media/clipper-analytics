"""Shared HTTP client with retries for rate limits and server errors."""
from __future__ import annotations

import time

import httpx

RETRY_STATUS = {429, 500, 502, 503, 504}


def client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(30.0), headers={"User-Agent": "clipper-analytics/0.1"})


def request(c: httpx.Client, method: str, url: str, *, attempts: int = 4, **kw) -> httpx.Response:
    delay = 2.0
    for i in range(attempts):
        try:
            r = c.request(method, url, **kw)
        except httpx.TransportError:
            if i == attempts - 1:
                raise
        else:
            if r.status_code not in RETRY_STATUS or i == attempts - 1:
                return r
            retry_after = r.headers.get("retry-after", "")
            if retry_after.isdigit():
                delay = min(float(retry_after), 60.0)
        time.sleep(delay)
        delay *= 2
    raise AssertionError("unreachable")
