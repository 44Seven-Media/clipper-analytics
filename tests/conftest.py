import textwrap

import pytest


@pytest.fixture
def project(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "accounts.toml").write_text(textwrap.dedent("""
        [settings]
        recent_posts = 5
        x_recent_posts = 5

        [[accounts]]
        id = "ra-yt"
        name = "REAL AF Clips"
        platform = "youtube"
        handle = "@realafclips"

        [[accounts]]
        id = "ra-tt"
        name = "REAL AF Clips"
        platform = "tiktok"
        handle = "@realafclips"

        [[accounts]]
        id = "ra-ig"
        name = "REAL AF Clips"
        platform = "instagram"
        handle = "realafclips"

        [[accounts]]
        id = "ra-fb"
        name = "REAL AF Clips"
        platform = "facebook"
        handle = "111"

        [[accounts]]
        id = "ra-x"
        name = "REAL AF Clips"
        platform = "x"
        handle = "realafclips"
    """))
    for k in ("YOUTUBE_API_KEY", "META_ACCESS_TOKEN", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET",
              "CLIPPER_TOKEN_KEY", "X_BEARER_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLIPPER_ROOT", str(tmp_path))
    from clipper_analytics.platforms import meta
    meta._DISCOVERY.clear()
    return tmp_path
