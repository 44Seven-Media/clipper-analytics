"""What a collector returns for one account on one day."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Post:
    post_id: str
    published_at: str = ""      # ISO 8601, UTC
    title: str = ""
    url: str = ""
    thumbnail: str = ""
    duration_s: int | None = None
    views: int | None = None
    likes: int | None = None
    comments: int | None = None
    shares: int | None = None


@dataclass
class Snapshot:
    followers: int | None = None
    following: int | None = None
    posts_count: int | None = None
    likes_total: int | None = None
    # Lifetime views reported by the platform (YouTube). Other platforms are summed from posts.
    views_lifetime: int | None = None
    # Views in the last full day, when the platform reports it (Instagram, Facebook insights).
    views_day: int | None = None
    profile_url: str = ""
    avatar: str = ""
    posts: list[Post] = field(default_factory=list)
    note: str = ""              # a non-fatal warning shown on the dashboard


class CollectError(RuntimeError):
    """Raised for a problem the user can fix (bad handle, expired token)."""


class NotConfigured(CollectError):
    """The platform's credentials aren't set, so it is skipped rather than failed."""
