"""One collector per platform. Each turns an account into a Snapshot using the official API."""
from __future__ import annotations

from .facebook import FacebookCollector
from .instagram import InstagramCollector
from .tiktok import TikTokCollector
from .x import XCollector
from .youtube import YouTubeCollector

COLLECTORS = {
    "youtube": YouTubeCollector,
    "facebook": FacebookCollector,
    "instagram": InstagramCollector,
    "tiktok": TikTokCollector,
    "x": XCollector,
}
