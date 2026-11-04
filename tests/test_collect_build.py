import csv
import json

import httpx
import respx

from clipper_analytics import build, collect, demo
from clipper_analytics.config import load_config
from clipper_analytics.platforms import youtube


@respx.mock
def test_run_keeps_going_and_marks_unconfigured(project, monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "k")
    respx.get(f"{youtube.API}/channels").respond(500, json={"error": {"message": "backend"}})
    monkeypatch.setattr("clipper_analytics.net.time.sleep", lambda s: None)
    cfg = load_config(project)
    with httpx.Client() as c:
        s = collect.run(cfg, today="2026-11-04", http=c)
    assert "ra-yt" in s.failed
    assert set(s.skipped) == {"ra-tt", "ra-ig", "ra-fb", "ra-x"}
    rows = list(csv.DictReader((project / "data" / "daily.csv").open()))
    assert {r["status"] for r in rows} == {"error", "skipped"} and len(rows) == 5


def test_build_embeds_data_safely(project):
    cfg = load_config(project)
    (project / "data").mkdir()
    (project / "data" / "daily.csv").write_text(
        "date,account,platform,followers,following,posts_count,likes_total,views_lifetime,views_day,status,note\n"
        "2026-11-04,ra-yt,youtube,10,,,,100,,ok,</script><b>x</b>\n")
    html = build.render(build.payload(cfg))
    assert html.startswith("<!doctype html>") and "<title>Clipper Network</title>" in html.split("<body>")[0]
    assert "</script><b>" not in html
    blob = html.split('type="application/json">')[1].split("</script>")[0]
    data = json.loads(blob)
    assert data["daily"][0][2] == 10 and data["accounts"][0]["id"] == "ra-yt"


def test_demo_builds(tmp_path):
    cfg = demo.make(tmp_path, days=20)
    out = build.build(cfg, out=tmp_path / "d.html", demo=True)
    assert out.stat().st_size > 10_000 and len(cfg.accounts) == 26
