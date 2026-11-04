// Step 2 of "Connect": the platform sends the browser back here with a one-time code.
// Save every account it shared, keep the login for the daily job, then return to the page.
import { PROVIDERS } from "../_shared/providers.ts";
import { callbackUrl, env, loadSettings, serviceClient, UserError } from "../_shared/util.ts";

const MAX_AGE_MS = 20 * 60 * 1000;

function back(params: Record<string, string>): Response {
  const site = env("SITE_URL") || "/";
  const url = new URL(site);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.hash = "accounts";
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const svc = serviceClient();
  const { data: row } = state
    ? await svc.from("oauth_states").delete().eq("state", state).select().maybeSingle()
    : { data: null };
  if (!row) return back({ connect_error: "This sign-in link expired or was already used. Click Connect again." });
  if (Date.now() - new Date(row.created_at).getTime() > MAX_AGE_MS) {
    return back({ connect_error: "The sign-in took too long. Click Connect again." });
  }
  const denied = q.get("error_description") || q.get("error_message") || q.get("error");
  const code = q.get("code") ?? "";
  if (denied || !code) return back({ connect_error: `Sign-in was cancelled${denied ? `: ${denied}` : ""}.` });

  try {
    await loadSettings(svc);
    const found = await PROVIDERS[row.platform].finish(code, row.code_verifier, callbackUrl());
    let added = 0, updated = 0;
    for (const f of found) {
      const expires = f.connection.refresh_expires ? new Date(f.connection.refresh_expires * 1000).toISOString() : null;
      const { data: existing } = await svc.from("accounts").select("id")
        .eq("platform", f.platform).eq("handle", f.platform === "youtube" ? f.handle : f.handle.toLowerCase()).maybeSingle();
      let id = existing?.id as string | undefined;
      const fields = { external_id: f.external_id, profile_url: f.profile_url, avatar: f.avatar, connection: "oauth",
                       connection_expires: expires };
      if (id) {
        const { error } = await svc.from("accounts").update({ ...fields, active: true }).eq("id", id);
        if (error) throw new Error(error.message);
        updated++;
      } else {
        const { data, error } = await svc.from("accounts")
          .insert({ ...fields, platform: f.platform, handle: f.handle, name: f.name, created_by: row.user_id })
          .select("id").single();
        if (error) throw new Error(error.message);
        id = data.id; added++;
      }
      const { error } = await svc.from("connections").upsert({ account_id: id, ...f.connection, updated_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
    }
    return back({ connected: String(added + updated), added: String(added), platform: row.platform });
  } catch (e) {
    const msg = e instanceof UserError ? e.message : `Something went wrong saving the connection (${(e as Error).message}).`;
    return back({ connect_error: msg });
  }
});
