// Shared helpers for Pulse's Supabase Edge Functions (calendar, chief).
// Every function takes its outside world (fetch, env, clock) as `deps`, so tests can run them without the network.

export type Env = Record<string, string | undefined>;
export type Deps = { fetch: typeof fetch; env: Env; now?: () => number };

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export function need(env: Env, ...keys: string[]) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new HttpError(503, `Not set up yet: an admin needs to add ${missing.join(", ")} to the function's secrets.`);
}

// ---------------------------------------------------------------- who is calling
export type Member = { id: string; email: string; workspace_id: string; role: string; display_name: string; token: string };
export async function caller(req: Request, d: Deps): Promise<Member> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in first.");
  const r = await d.fetch(`${d.env.SUPABASE_URL}/auth/v1/user`, { headers: { authorization: `Bearer ${token}`, apikey: d.env.SUPABASE_ANON_KEY! } });
  if (!r.ok) throw new HttpError(401, "Your sign-in has expired. Sign in again.");
  const u = await r.json();
  const [p] = await rest(d, `profiles?id=eq.${u.id}&select=workspace_id,role,active,display_name,email`);
  if (!p || !p.active) throw new HttpError(403, "Join a workspace first.");
  return { id: u.id, email: u.email, workspace_id: p.workspace_id, role: p.role, display_name: p.display_name, token };
}

// ---------------------------------------------------------------- plan check (Scheduler and Chief of Staff are Enterprise apps)
export async function needPlan(d: Deps, workspace: string, app: "scheduler" | "chief") {
  const ok = await rest(d, "rpc/ws_has_app_for", { method: "POST", body: JSON.stringify({ p_ws: workspace, p_app: app }) });
  if (ok !== true) throw new HttpError(402, "This app is part of the Enterprise plan. An admin can upgrade in Admin → Billing.");
}

// ---------------------------------------------------------------- database (PostgREST)
// With the service key by default (bypasses row-level security: only use for rows the function owns),
// or as the person with `asUser` (row-level security applies).
export async function rest(d: Deps, path: string, init: RequestInit & { asUser?: string; prefer?: string } = {}) {
  const key = init.asUser || d.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers: Record<string, string> = {
    apikey: init.asUser ? d.env.SUPABASE_ANON_KEY! : d.env.SUPABASE_SERVICE_ROLE_KEY!,
    authorization: `Bearer ${key}`, "content-type": "application/json",
  };
  if (init.prefer) headers.prefer = init.prefer;
  const r = await d.fetch(`${d.env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) } });
  const text = await r.text();
  if (!r.ok) throw new HttpError(r.status >= 500 ? 502 : r.status, `Database: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- signing and encryption (Web Crypto)
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sign(obj: unknown, secret: string) {
  const body = b64u(enc.encode(JSON.stringify(obj)));
  const sig = b64u(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}
export async function verify<T>(token: string, secret: string): Promise<T> {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) throw new HttpError(400, "That link is broken. Start again from Pulse.");
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(sig), enc.encode(body));
  if (!ok) throw new HttpError(400, "That link is broken. Start again from Pulse.");
  return JSON.parse(dec.decode(unb64u(body)));
}
async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(text: string | null | undefined, secret: string) {
  if (!text) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(text));
  return "v1." + b64u(iv) + "." + b64u(ct);
}
export async function unseal(sealed: string | null | undefined, secret: string) {
  if (!sealed) return null;
  const [, iv, ct] = sealed.split(".");
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await aesKey(secret), unb64u(ct)));
}
export const randomId = () => b64u(crypto.getRandomValues(new Uint8Array(12)));
