"""Loads the account list and credentials."""
from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

PLATFORMS = ("facebook", "tiktok", "instagram", "youtube", "x")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


@dataclass(frozen=True)
class Account:
    id: str
    name: str
    platform: str
    handle: str
    group: str = ""
    external_id: str = ""   # the platform's own id, filled in when connected by login


@dataclass
class Settings:
    recent_posts: int = 30
    x_recent_posts: int = 10


@dataclass
class Config:
    root: Path
    accounts: list[Account]
    settings: Settings = field(default_factory=Settings)

    @property
    def data_dir(self) -> Path:
        return self.root / "data"

    @property
    def dashboard_path(self) -> Path:
        return self.root / "dashboard" / "index.html"


class ConfigError(ValueError):
    pass


def project_root() -> Path:
    env = os.environ.get("CLIPPER_ROOT")
    if env:
        return Path(env).resolve()
    here = Path.cwd().resolve()
    for p in (here, *here.parents):
        if (p / "config" / "accounts.toml").exists():
            return p
    return here


def load_config(root: Path | None = None) -> Config:
    root = root or project_root()
    load_dotenv(root / ".env")
    path = root / "config" / "accounts.toml"
    if not path.exists():
        raise ConfigError(f"No account list at {path}")
    raw = tomllib.loads(path.read_text())
    s = raw.get("settings", {})
    settings = Settings(
        recent_posts=int(s.get("recent_posts", 30)),
        x_recent_posts=int(s.get("x_recent_posts", 10)),
    )
    accounts: list[Account] = []
    seen: set[str] = set()
    for i, a in enumerate(raw.get("accounts", []), 1):
        missing = [k for k in ("id", "name", "platform", "handle") if not str(a.get(k, "")).strip()]
        if missing:
            raise ConfigError(f"Account #{i} in accounts.toml is missing: {', '.join(missing)}")
        acc = Account(
            id=str(a["id"]).strip(),
            name=str(a["name"]).strip(),
            platform=str(a["platform"]).strip().lower(),
            handle=str(a["handle"]).strip(),
            group=str(a.get("group", "")).strip(),
        )
        if not ID_RE.match(acc.id):
            raise ConfigError(f"Account id '{acc.id}' must be lowercase letters, numbers and dashes")
        if acc.id in seen:
            raise ConfigError(f"Account id '{acc.id}' is used twice")
        if acc.platform not in PLATFORMS:
            raise ConfigError(f"Account '{acc.id}': platform must be one of {', '.join(PLATFORMS)}")
        seen.add(acc.id)
        accounts.append(acc)
    return Config(root=root, accounts=accounts, settings=settings)


def secret(name: str) -> str:
    return os.environ.get(name, "").strip()
