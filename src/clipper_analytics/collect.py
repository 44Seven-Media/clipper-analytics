"""The daily run: ask every platform for every account's numbers and add them to the history."""
from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .config import Config, secret
from .models import CollectError, NotConfigured
from .net import client
from .platforms import COLLECTORS
from .store import Store
from .tokens import TokenStore

log = logging.getLogger(__name__)


@dataclass
class RunSummary:
    ok: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)
    skipped: dict[str, str] = field(default_factory=dict)


def today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def run(cfg: Config, today: str | None = None, only: set[str] | None = None, http=None) -> RunSummary:
    today = today or today_utc()
    store = Store(cfg.data_dir)
    tokens = TokenStore(cfg.data_dir / "tokens.enc", secret("CLIPPER_TOKEN_KEY"))
    summary = RunSummary()

    accounts = [a for a in cfg.accounts if not only or a.id in only or a.platform in only]
    by_platform = defaultdict(list)
    for a in accounts:
        by_platform[a.platform].append(a)

    own_http = http is None
    http = http or client()
    try:
        for platform, accts in by_platform.items():
            col = COLLECTORS[platform](http, cfg.settings, tokens)
            col.prepare(accts)
            for a in accts:
                try:
                    snap = col.fetch(a)
                except NotConfigured as e:
                    store.record(a, today, None, "skipped", str(e))
                    summary.skipped[a.id] = str(e)
                except CollectError as e:
                    store.record(a, today, None, "error", str(e))
                    summary.failed[a.id] = str(e)
                except Exception as e:  # keep going: one broken account must not stop the run
                    log.exception("Unexpected error for %s", a.id)
                    store.record(a, today, None, "error", f"Unexpected error: {type(e).__name__}: {e}")
                    summary.failed[a.id] = f"{type(e).__name__}: {e}"
                else:
                    store.upsert_posts(a, snap.posts, today)
                    store.record(a, today, snap, "ok", snap.note)
                    summary.ok.append(a.id)
    finally:
        if own_http:
            http.close()
        try:
            tokens.save()
        except CollectError as e:
            log.error("Couldn't save TikTok tokens: %s", e)
        store.save()
    return summary
