import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const env = (name: string): string => (Deno.env.get(name) ?? "").trim();

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
