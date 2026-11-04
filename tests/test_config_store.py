import pytest

from clipper_analytics.config import Account, ConfigError, load_config
from clipper_analytics.models import Post, Snapshot
from clipper_analytics.store import Store


def test_loads_accounts(project):
    cfg = load_config(project)
    assert [a.platform for a in cfg.accounts] == ["youtube", "tiktok", "instagram", "facebook", "x"]
    assert cfg.settings.recent_posts == 5


def test_rejects_duplicate_ids(project):
    p = project / "config" / "accounts.toml"
    p.write_text(p.read_text() + '\n[[accounts]]\nid = "ra-yt"\nname = "x"\nplatform = "youtube"\nhandle = "@x"\n')
    with pytest.raises(ConfigError, match="used twice"):
        load_config(project)


def test_rejects_unknown_platform(project):
    p = project / "config" / "accounts.toml"
    p.write_text('[[accounts]]\nid = "a"\nname = "A"\nplatform = "myspace"\nhandle = "a"\n')
    with pytest.raises(ConfigError, match="platform"):
        load_config(project)


def test_post_views_prev_rolls_forward_once_per_day(tmp_path):
    acc = Account("a", "A", "tiktok", "@a")
    s = Store(tmp_path)
    s.upsert_posts(acc, [Post("p1", views=100)], "2026-11-01")
    s.upsert_posts(acc, [Post("p1", views=150)], "2026-11-02")
    s.upsert_posts(acc, [Post("p1", views=180)], "2026-11-02")  # second run same day
    row = s.posts[("tiktok", "p1")]
    assert row["views"] == 180 and row["views_prev"] == 100 and row["prev_date"] == "2026-11-01"


def test_lifetime_views_summed_from_all_known_posts(tmp_path):
    acc = Account("a", "A", "tiktok", "@a")
    s = Store(tmp_path)
    s.upsert_posts(acc, [Post("old", views=1000)], "2026-11-01")
    # "old" fell out of the recent window today but still counts
    s.upsert_posts(acc, [Post("new", views=50)], "2026-11-02")
    s.record(acc, "2026-11-02", Snapshot(followers=10), "ok")
    s.save()
    s2 = Store(tmp_path)
    row = [r for r in s2.daily if r["date"] == "2026-11-02"][0]
    assert row["views_lifetime"] == "1050" and row["followers"] == "10"


def test_rerun_replaces_same_day_row(tmp_path):
    acc = Account("a", "A", "x", "a")
    s = Store(tmp_path)
    s.record(acc, "2026-11-02", None, "error", "boom")
    s.record(acc, "2026-11-02", Snapshot(followers=5), "ok")
    assert len(s.daily) == 1 and s.daily[0]["status"] == "ok"
    assert s.meta["a"]["last_success"] == "2026-11-02"
