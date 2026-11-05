// One entry per "Connect" button. Each builds the platform's sign-in link and, after the person
// approves, turns the returned code into the accounts it found plus the login to keep for them.
import { env, pkceChallenge, readJson, UserError } from "./util.ts";

export type FoundAccount = {
  platform: "facebook" | "instagram" | "tiktok" | "youtube" | "x";
  handle: string;
  external_id: string;
  name: string;
  profile_url: string;
  avatar: string;
  connection: {
    provider: string;
    access_token: string;
    refresh_token: string;
    access_expires: number;
    refresh_expires: number;
    open_id: string;
    scope: string;
  };
};

type Provider = {
  secrets: string[];
  authorizeUrl(state: string, verifier: string, redirect: string): Promise<string>;
  finish(code: string, verifier: string, redirect: string): Promise<FoundAccount[]>;
};

const now = () => Math.floor(Date.now() / 1000);
const GRAPH = "https://graph.facebook.com/v24.0";

const tiktok: Provider = {
  secrets: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  async authorizeUrl(state, _v, redirect) {
    const q = new URLSearchParams({
      client_key: env("TIKTOK_CLIENT_KEY"), response_type: "code", redirect_uri: redirect, state,
      scope: "user.info.basic,user.info.profile,user.info.stats,video.list",
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
  },
  async finish(code, _v, redirect) {
    const tok = await readJson(await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: env("TIKTOK_CLIENT_KEY"), client_secret: env("TIKTOK_CLIENT_SECRET"), code,
        grant_type: "authorization_code", redirect_uri: redirect,
      }),
    }), "TikTok sign-in");
    const info = await readJson(await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username,avatar_url,profile_deep_link",
      { headers: { Authorization: `Bearer ${tok.access_token}` } }), "TikTok profile");
    const u = info.data?.user ?? {};
    if (!u.username) throw new UserError("TikTok didn't share the username. Make sure the app has the user.info.profile scope.");
    return [{
      platform: "tiktok", handle: u.username, external_id: u.open_id ?? tok.open_id ?? "",
      name: u.display_name || u.username, profile_url: u.profile_deep_link || `https://www.tiktok.com/@${u.username}`,
      avatar: u.avatar_url ?? "",
      connection: {
        provider: "tiktok", access_token: tok.access_token, refresh_token: tok.refresh_token ?? "",
        access_expires: now() + Number(tok.expires_in ?? 86400),
        refresh_expires: now() + Number(tok.refresh_expires_in ?? 31536000),
        open_id: tok.open_id ?? "", scope: tok.scope ?? "",
      },
    }];
  },
};

const meta: Provider = {
  secrets: ["META_APP_ID", "META_APP_SECRET"],
  async authorizeUrl(state, _v, redirect) {
    const q = new URLSearchParams({ client_id: env("META_APP_ID"), redirect_uri: redirect, state, response_type: "code" });
    if (env("META_CONFIG_ID")) {
      // Facebook Login for Business apps take their permissions from a saved Login Configuration.
      q.set("config_id", env("META_CONFIG_ID"));
      q.set("override_default_response_type", "true");
    } else {
      q.set("scope", "pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights,business_management");
    }
    return `https://www.facebook.com/v24.0/dialog/oauth?${q}`;
  },
  async finish(code, _v, redirect) {
    const id = env("META_APP_ID"), secret = env("META_APP_SECRET");
    const short = await readJson(await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({
      client_id: id, client_secret: secret, redirect_uri: redirect, code })}`), "Facebook sign-in");
    // A long-lived user token makes the Page tokens below permanent.
    const long = await readJson(await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({
      grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: short.access_token })}`),
      "Facebook sign-in");
    const pages: any[] = [];
    let url: string | null = `${GRAPH}/me/accounts?${new URLSearchParams({
      access_token: long.access_token, limit: "100",
      fields: "id,name,link,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}",
    })}`;
    while (url && pages.length < 1000) {
      const body = await readJson(await fetch(url), "Facebook Pages");
      pages.push(...(body.data ?? []));
      url = body.paging?.next ?? null;
    }
    if (!pages.length) throw new UserError("No Facebook Pages were shared. Reconnect and tick every Page and Instagram account you want.");
    const out: FoundAccount[] = [];
    for (const p of pages) {
      const conn = { provider: "meta", access_token: p.access_token, refresh_token: "", access_expires: 0,
                     refresh_expires: 0, open_id: "", scope: "" };
      out.push({ platform: "facebook", handle: p.id, external_id: p.id, name: p.name ?? p.id,
                 profile_url: p.link ?? `https://www.facebook.com/${p.id}`, avatar: p.picture?.data?.url ?? "", connection: conn });
      const ig = p.instagram_business_account;
      if (ig?.username) {
        out.push({ platform: "instagram", handle: ig.username, external_id: ig.id, name: ig.name || ig.username,
                   profile_url: `https://www.instagram.com/${ig.username}/`, avatar: ig.profile_picture_url ?? "", connection: conn });
      }
    }
    return out;
  },
};

const youtube: Provider = {
  secrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  async authorizeUrl(state, _v, redirect) {
    const q = new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: redirect, response_type: "code", state,
      scope: "https://www.googleapis.com/auth/youtube.readonly", access_type: "offline", prompt: "consent select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },
  async finish(code, _v, redirect) {
    const tok = await readJson(await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
                                  redirect_uri: redirect, grant_type: "authorization_code" }),
    }), "Google sign-in");
    const ch = await readJson(await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50",
      { headers: { Authorization: `Bearer ${tok.access_token}` } }), "YouTube channels");
    if (!ch.items?.length) throw new UserError("That Google account has no YouTube channel. For a brand channel, pick it on the Google screen.");
    return ch.items.map((c: any) => ({
      platform: "youtube", handle: c.id, external_id: c.id, name: c.snippet?.title ?? c.id,
      profile_url: c.snippet?.customUrl ? `https://www.youtube.com/${c.snippet.customUrl}` : `https://www.youtube.com/channel/${c.id}`,
      avatar: c.snippet?.thumbnails?.default?.url ?? "",
      connection: { provider: "google", access_token: tok.access_token, refresh_token: tok.refresh_token ?? "",
                    access_expires: now() + Number(tok.expires_in ?? 3600), refresh_expires: 0, open_id: "", scope: tok.scope ?? "" },
    }));
  },
};

const x: Provider = {
  secrets: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  async authorizeUrl(state, verifier, redirect) {
    const q = new URLSearchParams({
      response_type: "code", client_id: env("X_CLIENT_ID"), redirect_uri: redirect, state,
      scope: "tweet.read users.read offline.access", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256",
    });
    return `https://x.com/i/oauth2/authorize?${q}`;
  },
  async finish(code, verifier, redirect) {
    const tok = await readJson(await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded",
                 Authorization: "Basic " + btoa(`${env("X_CLIENT_ID")}:${env("X_CLIENT_SECRET")}`) },
      body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: redirect, code_verifier: verifier,
                                  client_id: env("X_CLIENT_ID") }),
    }), "X sign-in");
    const me = await readJson(await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url,name,username",
      { headers: { Authorization: `Bearer ${tok.access_token}` } }), "X profile");
    const u = me.data ?? {};
    return [{
      platform: "x", handle: u.username, external_id: u.id, name: u.name || u.username,
      profile_url: `https://x.com/${u.username}`, avatar: u.profile_image_url ?? "",
      connection: { provider: "x", access_token: tok.access_token, refresh_token: tok.refresh_token ?? "",
                    access_expires: now() + Number(tok.expires_in ?? 7200), refresh_expires: 0, open_id: "", scope: tok.scope ?? "" },
    }];
  },
};

export const PROVIDERS: Record<string, Provider> = { tiktok, meta, youtube, x };
