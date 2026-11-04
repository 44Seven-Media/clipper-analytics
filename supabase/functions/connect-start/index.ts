// Step 1 of "Connect": a signed-in team member asks for a platform's sign-in link.
import { PROVIDERS } from "../_shared/providers.ts";
import { callbackUrl, caller, cors, env, json, loadSettings, randomToken, serviceClient } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const who = await caller(req, true);
  if (who instanceof Response) return who;
  const svc = serviceClient();
  await loadSettings(svc);

  let platform = "";
  try { platform = String((await req.json()).platform ?? ""); } catch { /* empty body */ }
  const p = PROVIDERS[platform];
  if (!p) return json({ error: `Unknown platform "${platform}"` }, 400);
  const missing = p.secrets.filter((s) => !env(s));
  if (missing.length) {
    return json({ error: "This platform isn't set up yet. Add its app keys under Settings → Connections." }, 400);
  }

  const state = randomToken(24);
  const verifier = randomToken(48);
  // Clear abandoned sign-ins older than an hour while we're here.
  await svc.from("oauth_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  const { error } = await svc.from("oauth_states").insert({ state, platform, user_id: who.id, code_verifier: verifier });
  if (error) return json({ error: `Couldn't start sign-in: ${error.message}` }, 500);

  return json({ url: await p.authorizeUrl(state, verifier, callbackUrl()) });
});
