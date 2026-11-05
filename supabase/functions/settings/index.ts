// Settings page: platform app keys (Connections) and who can sign in (Team). Admins only.
// Secret values are write-only: the page learns whether each one is saved, never what it is.
import { callbackUrl, caller, cors, env, json, loadSettings, readJson, serviceClient } from "../_shared/util.ts";

type Field = { key: string; label: string; secret: boolean };
const PLATFORMS: Record<string, Field[]> = {
  meta: [
    { key: "META_APP_ID", label: "App ID", secret: false },
    { key: "META_APP_SECRET", label: "App secret", secret: true },
    { key: "META_CONFIG_ID", label: "Login configuration ID", secret: false },
  ],
  tiktok: [
    { key: "TIKTOK_CLIENT_KEY", label: "Client key", secret: false },
    { key: "TIKTOK_CLIENT_SECRET", label: "Client secret", secret: true },
  ],
  youtube: [
    { key: "YOUTUBE_API_KEY", label: "API key", secret: true },
    { key: "GOOGLE_CLIENT_ID", label: "OAuth client ID", secret: false },
    { key: "GOOGLE_CLIENT_SECRET", label: "OAuth client secret", secret: true },
  ],
  x: [
    { key: "X_CLIENT_ID", label: "OAuth 2.0 client ID", secret: false },
    { key: "X_CLIENT_SECRET", label: "OAuth 2.0 client secret", secret: true },
    { key: "X_BEARER_TOKEN", label: "Bearer token", secret: true },
  ],
};
const ALL = new Map(Object.values(PLATFORMS).flat().map((f) => [f.key, f]));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function describe() {
  const platforms: Record<string, unknown> = {};
  for (const [p, fields] of Object.entries(PLATFORMS)) {
    platforms[p] = fields.map((f) => {
      const v = env(f.key);
      return { key: f.key, label: f.label, secret: f.secret, saved: !!v, value: f.secret ? "" : v };
    });
  }
  return { callbackUrl: callbackUrl(), platforms };
}

// A cheap call per platform that proves the saved keys are accepted.
async function check(platform: string): Promise<string> {
  if (platform === "meta") {
    await readJson(await fetch(`https://graph.facebook.com/v24.0/oauth/access_token?${new URLSearchParams({
      client_id: env("META_APP_ID"), client_secret: env("META_APP_SECRET"), grant_type: "client_credentials" })}`), "Meta");
    return "Meta accepted the App ID and secret.";
  }
  if (platform === "tiktok") {
    await readJson(await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: env("TIKTOK_CLIENT_KEY"), client_secret: env("TIKTOK_CLIENT_SECRET"),
                                  grant_type: "client_credentials" }),
    }), "TikTok");
    return "TikTok accepted the client key and secret.";
  }
  if (platform === "youtube") {
    if (!env("YOUTUBE_API_KEY")) return "Add the API key to check it. The OAuth client is checked when you first click Connect.";
    await readJson(await fetch(`https://www.googleapis.com/youtube/v3/i18nRegions?part=snippet&hl=en&key=${encodeURIComponent(env("YOUTUBE_API_KEY"))}`), "YouTube");
    return "YouTube accepted the API key.";
  }
  if (platform === "x") {
    return "X is checked when you first click Connect, so nothing is billed here.";
  }
  throw new Error("Unknown platform");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const who = await caller(req, true);
  if (who instanceof Response) return who;
  const svc = serviceClient();
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty */ }

  try {
    await loadSettings(svc);
    switch (body.action) {
      case "get":
        return json(await describe());

      case "save": {
        const values = (body.values ?? {}) as Record<string, string>;
        for (const [key, raw] of Object.entries(values)) {
          if (!ALL.has(key)) return json({ error: `Unknown setting ${key}` }, 400);
          const value = String(raw ?? "").trim();
          if (value.length > 4000) return json({ error: `${ALL.get(key)!.label} is too long.` }, 400);
          const res = value
            ? await svc.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString(), updated_by: who.email })
            : await svc.from("app_settings").delete().eq("key", key);
          if (res.error) return json({ error: res.error.message }, 500);
        }
        await loadSettings(svc);
        return json(await describe());
      }

      case "check": {
        try {
          return json({ ok: true, message: await check(String(body.platform)) });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      }

      case "team": {
        const { data, error } = await svc.from("team_members").select("email,role,added_at").order("added_at");
        if (error) return json({ error: error.message }, 500);
        const { data: users } = await svc.auth.admin.listUsers({ perPage: 1000 });
        const seen = new Map((users?.users ?? []).map((u) => [u.email?.toLowerCase(), u.last_sign_in_at]));
        return json({ me: who.email.toLowerCase(), members: (data ?? []).map((m) => ({ ...m, lastSignIn: seen.get(m.email) ?? null, hasLogin: seen.has(m.email) })) });
      }

      case "invite": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const role = body.role === "admin" ? "admin" : "viewer";
        if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email." }, 400);
        const { error } = await svc.from("team_members").upsert({ email, role });
        if (error) return json({ error: error.message }, 500);
        const { data: users } = await svc.auth.admin.listUsers({ perPage: 1000 });
        if ((users?.users ?? []).some((u) => u.email?.toLowerCase() === email)) {
          return json({ message: `${email} already has a login, and is now on the team as ${role}.` });
        }
        const inv = await svc.auth.admin.inviteUserByEmail(email, { redirectTo: env("SITE_URL") || undefined });
        if (inv.error) return json({ error: `Added to the team, but the invite email failed: ${inv.error.message}` }, 500);
        return json({ message: `Invite sent to ${email}.` });
      }

      case "role": {
        const email = String(body.email ?? "").toLowerCase();
        const role = body.role === "admin" ? "admin" : "viewer";
        if (email === who.email.toLowerCase() && role !== "admin") return json({ error: "You can't remove your own admin access." }, 400);
        const { error } = await svc.from("team_members").update({ role }).eq("email", email);
        if (error) return json({ error: error.message }, 500);
        return json({ message: `${email} is now ${role === "admin" ? "an admin" : "a viewer"}.` });
      }

      case "remove": {
        const email = String(body.email ?? "").toLowerCase();
        if (email === who.email.toLowerCase()) return json({ error: "You can't remove yourself." }, 400);
        const { error } = await svc.from("team_members").delete().eq("email", email);
        if (error) return json({ error: error.message }, 500);
        return json({ message: `${email} can no longer see the dashboard.` });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
