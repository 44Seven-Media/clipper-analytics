"""Encrypted storage for per-account OAuth tokens (TikTok).

TikTok hands out a new refresh token now and then, so the latest one has to be saved
after every run. The tokens live in data/tokens.enc, encrypted with CLIPPER_TOKEN_KEY,
so the daily job can commit them back to the repo without exposing them.
"""
from __future__ import annotations

import json
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from .models import CollectError, NotConfigured


def new_key() -> str:
    return Fernet.generate_key().decode()


class TokenStore:
    def __init__(self, path: Path, key: str):
        self.path = path
        self.key = key
        self._data: dict | None = None
        self.dirty = False

    def _fernet(self) -> Fernet:
        if not self.key:
            raise NotConfigured("CLIPPER_TOKEN_KEY is not set. Create one with: clipper keygen")
        try:
            return Fernet(self.key.encode())
        except ValueError as e:
            raise CollectError("CLIPPER_TOKEN_KEY is not a valid key. Create one with: clipper keygen") from e

    def load(self) -> dict:
        if self._data is None:
            if self.path.exists():
                try:
                    self._data = json.loads(self._fernet().decrypt(self.path.read_bytes()))
                except InvalidToken as e:
                    raise CollectError("data/tokens.enc can't be read with this CLIPPER_TOKEN_KEY") from e
            else:
                self._data = {}
        return self._data

    def get(self, account_id: str) -> dict | None:
        return self.load().get(account_id)

    def put(self, account_id: str, value: dict) -> None:
        self.load()[account_id] = value
        self.dirty = True

    def save(self) -> None:
        if not self.dirty:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        blob = self._fernet().encrypt(json.dumps(self._data, sort_keys=True).encode())
        self.path.write_bytes(blob)
        self.dirty = False
