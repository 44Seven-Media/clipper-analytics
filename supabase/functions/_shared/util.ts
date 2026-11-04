import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

// Platform app keys come from the Settings page (app_settings table), falling back to function secrets.
const saved = new Map<string, string>();
export const env = (name: string): string => (saved.get(name) || Deno.env.get(name) || "").trim();

export async function loadSettings(svc: SupabaseClient): Promise<void> {
  const { data, error } = await svc.from("app_settings").select("key,value");
  if (error) throw new Error(`Couldn't read settings: ${error.message}`);
  saved.clear();
  for (const r of data ?? []) if (r.value) saved.set(r.key, r.value);
}

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
}

export function userClient(authHeader: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
}

export type Caller = { email: string; id: string; role: "admin" | "viewer" };

/** The signed-in team member making this request, or a Response explaining why not. */
export async function caller(req: Request, needAdmin: boolean): Promise<Caller | Response> {
  const uc = userClient(req.headers.get("Authorization") ?? "");
  const { data: { user } } = await uc.auth.getUser();
  if (!user) return json({ error: "Sign in again, then try once more." }, 401);
  const { data: role } = await uc.rpc("my_role");
  if (!role) return json({ error: "Your email isn't on the team list yet." }, 403);
  if (needAdmin && role !== "admin") return json({ error: "Only admins can do this." }, 403);
  return { email: user.email ?? "", id: user.id, role };
}

export function callbackUrl(): string {
  return env("CALLBACK_URL") || `${env("SUPABASE_URL")}/functions/v1/connect-callback`;
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class UserError extends Error {}

export async function readJson(r: Response, what: string): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  const e = body.error;
  const failed = !r.ok || (e && !(typeof e === "object" && e.code === "ok"));
  if (failed) {
    const msg = (typeof e === "object" && e ? (e.message ?? e.code) : e) ?? body.error_description ?? body.detail ?? body.title ?? `HTTP ${r.status}`;
    throw new UserError(`${what}: ${body.error_description ?? msg}`);
  }
  return body;
}
