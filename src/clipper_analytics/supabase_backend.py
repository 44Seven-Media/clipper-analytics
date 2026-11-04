"""Where the daily job reads accounts and saves numbers when the live page (Supabase) is in use.

Talks to Supabase's REST API with the service role key, which only the daily job has.
"""
from __future__ import annotations

import time
from dataclasses import asdict

import httpx

from .config import Account
from .models import CollectError, Snapshot
from .net import request


class Supabase:
    def __init__(self, url: str, key: str, http: httpx.Client):
        self.base = url.rstrip("/") + "/rest/v1"
        self.http = http
        self.headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def call(self, method: str, path: str, *, params=None, json=None, prefer: str = "") -> list | dict | None:
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        r = request(self.http, method, f"{self.base}/{path}", params=params, json=json, headers=headers)
        if r.status_code >= 300:
            try:
                msg = r.json().get("message", r.text[:200])
            except ValueError:
                msg = r.text[:200]
            raise CollectError(f"Supabase {r.status_code} on {path}: {msg}")
        return r.json() if r.content else None

    def rpc(self, fn: str, **args) -> None:
        self.call("POST", f"rpc/{fn}", json=args)


class SupabaseTokens:
    """Same interface as TokenStore, backed by the connections table."""

    def __init__(self, db: Supabase):
        self.db = db
        self._data: dict | None = None

    def load(self) -> dict:
        if self._data is None:
            rows = self.db.call("GET", "connections", params={"select": "*"}) or []
            self._data = {r["account_id"]: r for r in rows}
        return self._data

    def get(self, account_id: str) -> dict | None:
        return self.load().get(account_id)

    def put(self, account_id: str, value: dict) -> None:
        old = self.load().get(account_id, {})
        row = {**old, **value, "account_id": account_id,
               "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        row.setdefault("provider", "tiktok")
        cols = ("account_id", "provider", "access_token", "refresh_token", "access_expires", "refresh_expires",
                "open_id", "scope", "updated_at")
        row = {k: row[k] for k in cols if k in row}
        self.db.call("POST", "connections", params={"on_conflict": "account_id"}, json=row,
                     prefer="resolution=merge-duplicates")
        if row.get("refresh_expires"):
            self.db.call("PATCH", "accounts", params={"id": f"eq.{account_id}"}, json={
                "connection_expires": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["refresh_expires"]))})
        self._data[account_id] = row

    def save(self) -> None:
        """Saved as they change."""


class SupabaseBackend:
    def __init__(self, url: str, key: str, http: httpx.Client):
        self.db = Supabase(url, key, http)
        self.tokens = SupabaseTokens(self.db)

    def accounts(self) -> list[Account]:
        rows = self.db.call("GET", "accounts", params={
            "select": "id,name,platform,handle,external_id,group_name", "active": "is.true", "order": "platform,name"}) or []
        return [Account(id=r["id"], name=r["name"], platform=r["platform"], handle=r["handle"],
                        group=r.get("group_name") or "", external_id=r.get("external_id") or "") for r in rows]

    def save_success(self, account: Account, today: str, snap: Snapshot) -> None:
        if snap.posts:
            self.db.rpc("ingest_posts", p_account=account.id, p_today=today,
                        p_posts=[asdict(p) for p in snap.posts])
        data = asdict(snap)
        data.pop("posts")
        note = data.pop("note")
        self.db.rpc("record_daily", p_account=account.id, p_today=today, p_status="ok", p_note=note, p_snap=data)

    def save_failure(self, account: Account, today: str, status: str, note: str) -> None:
        self.db.rpc("record_daily", p_account=account.id, p_today=today, p_status=status, p_note=note, p_snap=None)

    def finish(self) -> None:
        pass
