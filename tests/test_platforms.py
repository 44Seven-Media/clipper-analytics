import time

import httpx
import respx

from clipper_analytics.config import Account, Settings
from clipper_analytics.models import CollectError
from clipper_analytics.platforms import facebook, instagram, meta, tiktok, x, youtube
from clipper_analytics.tokens import TokenStore, new_key

S = Settings(recent_posts=5, x_recent_posts=5)


@respx.mock
def test_youtube(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "k")
    respx.get(f"{youtube.API}/channels").respond(json={"items": [{
        "id": "UC123", "snippet": {"customUrl": "@realafclips", "thumbnails": {"default": {"url": "a.jpg"}}},
        "statistics": {"subscriberCount": "1200", "viewCount": "99000", "videoCount": "40"},
        "contentDetails": {"relatedPlaylists": {"uploads": "UU123"}}}]})
    respx.get(f"{youtube.API}/playlistItems").respond(json={"items": [{"contentDetails": {"videoId": "v1"}}]})
    respx.get(f"{youtube.API}/videos").respond(json={"items": [{
        "id": "v1", "snippet": {"title": "Clip", "publishedAt": "2026-11-01T10:00:00Z"},
        "statistics": {"viewCount": "500", "likeCount": "20"}, "contentDetails": {"duration": "PT45S"}}]})
    with httpx.Client() as c:
        snap = youtube.YouTubeCollector(c, S).fetch(Account("a", "A", "youtube", "@realafclips"))
    assert snap.followers == 1200 and snap.views_lifetime == 99000
    assert snap.posts[0].url.endswith("/shorts/v1") and snap.posts[0].duration_s == 45


def test_youtube_duration():
    assert youtube.parse_duration("PT1H2M3S") == 3723
    assert youtube.parse_duration("P0D") == 0


@respx.mock
def test_youtube_unknown_handle(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "k")
    respx.get(f"{youtube.API}/channels").respond(json={"items": []})
    with httpx.Client() as c:
        try:
            youtube.YouTubeCollector(c, S).fetch(Account("a", "A", "youtube", "@nope"))
        except CollectError as e:
            assert "No YouTube channel" in str(e)
        else:
            raise AssertionError


def _meta_discovery():
    respx.get(f"{meta.GRAPH}/me/accounts").respond(json={"data": [{
        "id": "111", "name": "REAL AF Clips", "access_token": "PAGE",
        "instagram_business_account": {"id": "ig1", "username": "realafclips"}}]})


@respx.mock
def test_instagram(monkeypatch):
    monkeypatch.setenv("META_ACCESS_TOKEN", "t")
    _meta_discovery()
    respx.get(f"{meta.GRAPH}/ig1").respond(json={"username": "realafclips", "followers_count": 900, "media_count": 12})
    respx.get(f"{meta.GRAPH}/ig1/insights").respond(json={"data": [{"name": "views", "total_value": {"value": 4400}}]})
    respx.get(f"{meta.GRAPH}/ig1/media").respond(json={"data": [{"id": "m1", "caption": "hi", "timestamp": "2026-11-01T00:00:00+0000", "like_count": 3}]})
    respx.get(f"{meta.GRAPH}/m1/insights").respond(json={"data": [{"name": "views", "values": [{"value": 777}]}, {"name": "shares", "values": [{"value": 4}]}]})
    with httpx.Client() as c:
        snap = instagram.InstagramCollector(c, S).fetch(Account("a", "A", "instagram", "realafclips"))
    assert snap.followers == 900 and snap.views_day == 4400
    assert snap.posts[0].views == 777 and snap.posts[0].shares == 4


@respx.mock
def test_instagram_not_linked(monkeypatch):
    monkeypatch.setenv("META_ACCESS_TOKEN", "t")
    _meta_discovery()
    with httpx.Client() as c:
        try:
            instagram.InstagramCollector(c, S).fetch(Account("a", "A", "instagram", "someoneelse"))
        except CollectError as e:
            assert "@realafclips" in str(e)
        else:
            raise AssertionError


@respx.mock
def test_facebook_falls_back_when_metric_renamed(monkeypatch):
    monkeypatch.setenv("META_ACCESS_TOKEN", "t")
    _meta_discovery()
    respx.get(f"{meta.GRAPH}/111").respond(json={"name": "REAL AF Clips", "followers_count": 5000, "link": "https://facebook.com/ra"})

    def insights(request):
        if request.url.params["metric"] == "page_media_view":
            return httpx.Response(400, json={"error": {"message": "invalid metric", "code": 100}})
        return httpx.Response(200, json={"data": [{"values": [{"value": 321}]}]})
    respx.get(f"{meta.GRAPH}/111/insights").mock(side_effect=insights)
    respx.get(f"{meta.GRAPH}/111/video_reels").respond(json={"data": [{"id": "r1", "permalink_url": "/reel/r1", "length": 30.5}]})
    respx.get(f"{meta.GRAPH}/r1/video_insights").respond(json={"data": [{"values": [{"value": 9000}]}]})
    with httpx.Client() as c:
        snap = facebook.FacebookCollector(c, S).fetch(Account("a", "A", "facebook", "111"))
    assert snap.followers == 5000 and snap.views_day == 321
    assert snap.posts[0].views == 9000 and snap.posts[0].url == "https://www.facebook.com/reel/r1"


@respx.mock
def test_tiktok_refreshes_and_saves_new_token(monkeypatch, tmp_path):
    monkeypatch.setenv("TIKTOK_CLIENT_KEY", "ck")
    monkeypatch.setenv("TIKTOK_CLIENT_SECRET", "cs")
    store = TokenStore(tmp_path / "tokens.enc", new_key())
    store.put("a", {"access_token": "old", "access_expires": 0, "refresh_token": "R1",
                    "refresh_expires": int(time.time()) + 1000, "open_id": "o"})
    respx.post(tiktok.TOKEN_URL).respond(json={"access_token": "new", "expires_in": 86400, "refresh_token": "R2",
                                               "refresh_expires_in": 31536000, "open_id": "o"})
    respx.get(f"{tiktok.API}/user/info/").respond(json={"data": {"user": {
        "username": "realafclips", "follower_count": 42000, "likes_count": 1, "video_count": 2}}, "error": {"code": "ok"}})
    respx.post(f"{tiktok.API}/video/list/").respond(json={"data": {"videos": [
        {"id": "7", "create_time": 1762000000, "view_count": 1234, "share_url": "https://tiktok.com/v/7"}],
        "has_more": False}, "error": {"code": "ok"}})
    with httpx.Client() as c:
        snap = tiktok.TikTokCollector(c, S, store).fetch(Account("a", "A", "tiktok", "@realafclips"))
    assert snap.followers == 42000 and snap.posts[0].views == 1234
    store.save()
    reread = TokenStore(tmp_path / "tokens.enc", store.key)
    assert reread.get("a")["refresh_token"] == "R2"


def test_tiktok_not_connected(monkeypatch, tmp_path):
    monkeypatch.setenv("TIKTOK_CLIENT_KEY", "ck")
    monkeypatch.setenv("TIKTOK_CLIENT_SECRET", "cs")
    store = TokenStore(tmp_path / "tokens.enc", new_key())
    with httpx.Client() as c:
        try:
            tiktok.TikTokCollector(c, S, store).fetch(Account("a", "A", "tiktok", "@x"))
        except CollectError as e:
            assert "clipper auth tiktok a" in str(e)
        else:
            raise AssertionError


@respx.mock
def test_x_batch_lookup_and_posts(monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "b")
    route = respx.get(f"{x.API}/users/by").respond(json={"data": [
        {"id": "9", "username": "RealAFClips", "public_metrics": {"followers_count": 777, "tweet_count": 50}}]})
    respx.get(f"{x.API}/users/9/tweets").respond(json={"data": [
        {"id": "t1", "text": "clip", "public_metrics": {"impression_count": 5000, "like_count": 9}}]})
    with httpx.Client() as c:
        col = x.XCollector(c, S)
        col.prepare([Account("a", "A", "x", "realafclips")])
        snap = col.fetch(Account("a", "A", "x", "realafclips"))
    assert route.call_count == 1
    assert snap.followers == 777 and snap.posts[0].views == 5000
