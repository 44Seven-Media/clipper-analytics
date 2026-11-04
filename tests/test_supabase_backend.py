import json
import time

import httpx
import respx

from clipper_analytics import collect
from clipper_analytics.config import Account, Settings, load_config
from clipper_analytics.platforms import facebook, instagram, meta, tiktok, youtube
from clipper_analytics.supabase_backend import SupabaseBackend

URL = "https://proj.supabase.co"
REST = f"{URL}/rest/v1"
S = Settings(recent_posts=5, x_recent_posts=0)


class FakeTokens:
    def __init__(self, data):
        self.data = data
        self.puts = {}

    def get(self, aid):
        return self.data.get(aid)

    def put(self, aid, v):
        self.data[aid] = v
        self.puts[aid] = v


@respx.mock
def test_daily_run_against_supabase(project, monkeypatch):
    monkeypatch.delenv("TIKTOK_CLIENT_KEY", raising=False)
    monkeypatch.setenv("TIKTOK_CLIENT_SECRET", "cs")
    monkeypatch.delenv("X_BEARER_TOKEN", raising=False)
    respx.get(f"{REST}/app_settings").respond(json=[{"key": "TIKTOK_CLIENT_KEY", "value": "from-settings"}])
    respx.get(f"{REST}/accounts").respond(json=[
        {"id": "acc-1", "name": "REAL AF", "platform": "tiktok", "handle": "realafclips", "external_id": "o1", "group_name": "REAL AF"},
        {"id": "acc-2", "name": "Clips", "platform": "x", "handle": "clips", "external_id": "", "group_name": ""},
    ])
    respx.get(f"{REST}/connections").respond(json=[{
        "account_id": "acc-1", "provider": "tiktok", "access_token": "old", "access_expires": 0,
        "refresh_token": "R1", "refresh_expires": int(time.time()) + 1000, "open_id": "o1", "scope": ""}])
    saved_conn = respx.post(f"{REST}/connections").respond(201)
    expires = respx.patch(f"{REST}/accounts").respond(204)
    ingest = respx.post(f"{REST}/rpc/ingest_posts").respond(204)
    record = respx.post(f"{REST}/rpc/record_daily").respond(204)
    respx.post(tiktok.TOKEN_URL).respond(json={"access_token": "new", "refresh_token": "R2", "expires_in": 86400,
                                               "refresh_expires_in": 31536000, "open_id": "o1"})
    respx.get(f"{tiktok.API}/user/info/").respond(json={"data": {"user": {"username": "realafclips", "follower_count": 10}},
                                                        "error": {"code": "ok"}})
    respx.post(f"{tiktok.API}/video/list/").respond(json={"data": {"videos": [{"id": "9", "view_count": 50}], "has_more": False},
                                                          "error": {"code": "ok"}})
    cfg = load_config(project)
    with httpx.Client() as c:
        s = collect.run(cfg, today="2026-11-04", http=c, backend=SupabaseBackend(URL, "service", c))
    assert s.ok == ["acc-1"] and "acc-2" in s.skipped
    # the client key saved on the Settings page was used for the TikTok refresh
    assert b"client_key=from-settings" in respx.calls[[c.request.url.host for c in respx.calls].index("open.tiktokapis.com")].request.content
    # refreshed TikTok login was saved straight back
    assert json.loads(saved_conn.calls[0].request.content)["refresh_token"] == "R2"
    assert expires.called
    assert json.loads(ingest.calls[0].request.content)["p_posts"][0]["views"] == 50
    bodies = [json.loads(c.request.content) for c in record.calls]
    ok = next(b for b in bodies if b["p_account"] == "acc-1")
    assert ok["p_status"] == "ok" and ok["p_snap"]["followers"] == 10 and "posts" not in ok["p_snap"]
    skipped = next(b for b in bodies if b["p_account"] == "acc-2")
    assert skipped["p_status"] == "skipped" and skipped["p_snap"] is None
    assert record.calls[0].request.headers["apikey"] == "service"


@respx.mock
def test_facebook_uses_saved_page_token_without_system_user():
    respx.get(f"{meta.GRAPH}/111").respond(json={"name": "P", "followers_count": 5})
    respx.get(f"{meta.GRAPH}/111/insights").respond(json={"data": []})
    respx.get(f"{meta.GRAPH}/111/video_reels").respond(json={"data": []})
    toks = FakeTokens({"a": {"access_token": "PAGE"}})
    with httpx.Client() as c:
        snap = facebook.FacebookCollector(c, S, toks).fetch(Account("a", "A", "facebook", "111", external_id="111"))
    assert snap.followers == 5
    assert respx.calls[0].request.url.params["access_token"] == "PAGE"


@respx.mock
def test_instagram_uses_saved_token_and_ig_id():
    respx.get(f"{meta.GRAPH}/ig9").respond(json={"username": "clips", "followers_count": 77})
    respx.get(f"{meta.GRAPH}/ig9/insights").respond(json={"data": []})
    respx.get(f"{meta.GRAPH}/ig9/media").respond(json={"data": []})
    toks = FakeTokens({"a": {"access_token": "PAGE"}})
    with httpx.Client() as c:
        snap = instagram.InstagramCollector(c, S, toks).fetch(Account("a", "A", "instagram", "clips", external_id="ig9"))
    assert snap.followers == 77


@respx.mock
def test_youtube_falls_back_to_google_login(monkeypatch):
    monkeypatch.delenv("YOUTUBE_API_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "g")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "gs")
    respx.post("https://oauth2.googleapis.com/token").respond(json={"access_token": "fresh", "expires_in": 3600})
    ch = respx.get(f"{youtube.API}/channels").respond(json={"items": [{"id": "UCabcdefghijklmnopqrstuv",
        "snippet": {}, "statistics": {"subscriberCount": "3"}, "contentDetails": {"relatedPlaylists": {}}}]})
    toks = FakeTokens({"a": {"access_token": "stale", "access_expires": 0, "refresh_token": "RT"}})
    with httpx.Client() as c:
        snap = youtube.YouTubeCollector(c, S, toks).fetch(
            Account("a", "A", "youtube", "UCabcdefghijklmnopqrstuv", external_id="UCabcdefghijklmnopqrstuv"))
    assert snap.followers == 3
    assert ch.calls[0].request.headers["Authorization"] == "Bearer fresh"
    assert ch.calls[0].request.url.params["id"] == "UCabcdefghijklmnopqrstuv"
    assert toks.puts["a"]["access_token"] == "fresh"
