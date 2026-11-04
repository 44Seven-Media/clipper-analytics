// Run: deno test --allow-env supabase/functions/_tests
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PROVIDERS } from "../_shared/providers.ts";
import { UserError } from "../_shared/util.ts";

for (const [k, v] of Object.entries({
  TIKTOK_CLIENT_KEY: "ck", TIKTOK_CLIENT_SECRET: "cs", META_APP_ID: "1", META_APP_SECRET: "s",
  GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs", X_CLIENT_ID: "x", X_CLIENT_SECRET: "xs",
})) Deno.env.set(k, v);

function mockFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const key = Object.keys(routes).find((r) => url.includes(r));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const v = routes[key];
    const [status, body] = Array.isArray(v) ? v : [200, v];
    return new Response(JSON.stringify(body), { status: status as number });
  }) as typeof fetch;
  return calls;
}

Deno.test("tiktok: accepts the 'ok' error code and returns the account", async () => {
  mockFetch({
    "/v2/oauth/token/": { access_token: "A", refresh_token: "R", expires_in: 86400, refresh_expires_in: 31536000, open_id: "o1" },
    "/v2/user/info/": { data: { user: { username: "realafclips", display_name: "REAL AF Clips", open_id: "o1" } }, error: { code: "ok" } },
  });
  const [a] = await PROVIDERS.tiktok.finish("code", "", "https://cb");
  assertEquals([a.platform, a.handle, a.connection.refresh_token], ["tiktok", "realafclips", "R"]);
});

Deno.test("tiktok: real errors surface as a readable message", async () => {
  mockFetch({ "/v2/oauth/token/": [400, { error: "invalid_grant", error_description: "Authorization code is expired." }] });
  await assertRejects(() => PROVIDERS.tiktok.finish("c", "", "https://cb"), UserError, "Authorization code is expired");
});

Deno.test("meta: one sign-in yields every Page and its linked Instagram", async () => {
  mockFetch({
    "fb_exchange_token": { access_token: "LONG" },
    "/oauth/access_token": { access_token: "SHORT" },
    "/me/accounts": { data: [
      { id: "111", name: "REAL AF Clips", access_token: "P1", instagram_business_account: { id: "ig1", username: "realafclips" } },
      { id: "222", name: "75 Hard Daily", access_token: "P2" },
    ] },
  });
  const found = await PROVIDERS.meta.finish("c", "", "https://cb");
  assertEquals(found.map((f) => `${f.platform}:${f.handle}:${f.connection.access_token}`),
    ["facebook:111:P1", "instagram:realafclips:P1", "facebook:222:P2"]);
});

Deno.test("x: authorize link uses PKCE", async () => {
  const url = new URL(await PROVIDERS.x.authorizeUrl("st", "verifier-verifier-verifier-verifier-verifier", "https://cb"));
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("state"), "st");
});

Deno.test("youtube: no channel gives a clear message", async () => {
  mockFetch({ "oauth2.googleapis.com/token": { access_token: "A" }, "/youtube/v3/channels": { items: [] } });
  await assertRejects(() => PROVIDERS.youtube.finish("c", "", "https://cb"), UserError, "no YouTube channel");
});
