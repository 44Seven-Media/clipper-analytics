from __future__ import annotations

import httpx

from ..config import Account, Settings
from ..models import Snapshot
from ..tokens import TokenStore


class Collector:
    platform = ""

    def __init__(self, http: httpx.Client, settings: Settings, tokens: TokenStore | None = None):
        self.http = http
        self.settings = settings
        self.tokens = tokens

    def prepare(self, accounts: list[Account]) -> None:
        """Called once with all of this platform's accounts before fetch(), for batch lookups."""

    def fetch(self, account: Account) -> Snapshot:
        raise NotImplementedError


def to_int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
