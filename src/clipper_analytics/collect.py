"""The daily run: ask every platform for every account's numbers and add them to the history.

The history lives either in Supabase (the live page) or in the CSV files in data/.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .config import Account, Config, secret
from .models import CollectError, NotConfigured, Snapshot
from .net import client
from .platforms import COLLECTORS
from .store import Store
from .supabase_backend import SupabaseBackend
from .tokens import TokenStore

log = logging.getLogger(__name__)


@dataclass
class RunSummary:
    ok: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)
    skipped: dict[str, str] = field(default_factory=dict)


class CsvBackend:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.store = Store(cfg.data_dir)
        self.tokens = TokenStore(cfg.data_dir / "tokens.enc", secret("CLIPPER_TOKEN_KEY"))

    def accounts(self) -> list[Account]:
        return self.cfg.accounts

    def save_success(self, account: Account, today: str, snap: Snapshot) -> None:
        self.store.upsert_posts(account, snap.posts, today)
        self.store.record(account, today, snap, "ok", snap.note)

    def save_failure(self, account: Account, today: str, status: str, note: str) -> None:
        self.store.record(account, today, None, status, note)

    def finish(self) -> None:
        try:
            self.tokens.save()
        except CollectError as e:
            log.error("Couldn't save TikTok tokens: %s", e)
        self.store.save()


def use_supabase() -> bool:
    return bool(secret("SUPABASE_URL") and secret("SUPABASE_SERVICE_ROLE_KEY"))


def today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def run(cfg: Config, today: str | None = None, only: set[str] | None = None, http=None, backend=None) -> RunSummary:
    today = today or today_utc()
    summary = RunSummary()
    own_http = http is None
    http = http or client()
    if backend is None:
        backend = (SupabaseBackend(secret("SUPABASE_URL"), secret("SUPABASE_SERVICE_ROLE_KEY"), http)
                   if use_supabase() else CsvBackend(cfg))

    def save(fn, *args) -> bool:
        try:
            fn(*args)
            return True
        except CollectError as e:
            log.error("Couldn't save %s: %s", args[0].id, e)
            summary.failed[args[0].id] = f"Couldn't save: {e}"
            return False

    try:
        if hasattr(backend, "load_settings"):
            backend.load_settings()
        accounts = [a for a in backend.accounts() if not only or a.id in only or a.platform in only]
        by_platform = defaultdict(list)
        for a in accounts:
            by_platform[a.platform].append(a)
        for platform, accts in by_platform.items():
            col = COLLECTORS[platform](http, cfg.settings, backend.tokens)
            col.prepare(accts)
            for a in accts:
                try:
                    snap = col.fetch(a)
                except NotConfigured as e:
                    if save(backend.save_failure, a, today, "skipped", str(e)):
                        summary.skipped[a.id] = str(e)
                except CollectError as e:
                    save(backend.save_failure, a, today, "error", str(e))
                    summary.failed[a.id] = str(e)
                except Exception as e:  # keep going: one broken account must not stop the run
                    log.exception("Unexpected error for %s", a.id)
                    save(backend.save_failure, a, today, "error", f"Unexpected error: {type(e).__name__}: {e}")
                    summary.failed[a.id] = f"{type(e).__name__}: {e}"
                else:
                    if save(backend.save_success, a, today, snap):
                        summary.ok.append(a.id)
    finally:
        backend.finish()
        if own_http:
            http.close()
    return summary
