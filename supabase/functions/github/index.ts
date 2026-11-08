// github: the "Pulse for GitHub" app. Three jobs, one function:
//   1. Setup URL: GitHub sends an admin back here after they install the app. We check the one-time `state` code Pulse gave
//      them, record the installation for their workspace (rpc gh_app_connect) and send them back to Admin → Integrations.
//   2. Relay: the database timer can't sign GitHub App tokens, so it asks this function (with the shared relay secret) to make
//      read-only GET requests to the GitHub API for an installation. Only issue, milestone and repository-list paths are allowed.
//   3. Webhook: GitHub tells us when issues, milestones or labels change; we ask the database to sync the linked projects now.
// Deploy with "Verify JWT" off (GitHub and the database timer don't carry a Supabase sign-in). Secrets: see deploy/GITHUB_APP.md.
import { type Deps, HttpError } from "../_shared/pulse.ts";

const API = "https://api.github.com";
const PATHS = /^\/(repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|milestones)|installation\/repositories)(\?[A-Za-z0-9_.=&%:,+-]*)?$/;
const enc = new TextEncoder();
const tokens = new Map<string, { token: string; exp: number }>();   // installation id → token (warm instances reuse it)

export async function handle(req: Request, d: Deps): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.has("installation_id")) return await setup(url, d);
    if (req.method === "GET" && url.searchParams.has("path")) return await relay(req, url, d);
    if (req.method === "POST" && req.headers.get("x-github-event")) return await webhook(req, d);
    return new Response("Pulse for GitHub is running.", { status: 200 });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return Response.json({ message: e instanceof Error ? e.message : String(e) }, { status });
  }
}

// ---------------------------------------------------------------- app authentication (RS256 JWT → installation token)
function der(len: number) { return len < 128 ? [len] : len < 256 ? [0x81, len] : [0x82, len >> 8, len & 255]; }
// GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); Web Crypto wants PKCS#8, so wrap it
function pkcs8(pem: string): Uint8Array {
  const body = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (/BEGIN PRIVATE KEY/.test(pem)) return body;
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...der(body.length)];
  const inner = [0x02, 0x01, 0x00, ...alg, ...octet];
  return new Uint8Array([0x30, ...der(inner.length + body.length), ...inner, ...body]);
}
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function appJwt(d: Deps) {
  const { GITHUB_APP_ID: id, GITHUB_APP_PRIVATE_KEY: pem } = d.env;
  if (!id || !pem) throw new HttpError(503, "The GitHub app isn't set up: add GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to the function's secrets.");
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(pem.replace(/\\n/g, "\n")), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor((d.now?.() ?? Date.now()) / 1000);
  const part = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
  const head = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: id })}`;
  return `${head}.${b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head)))}`;
}
async function gh(d: Deps, path: string, auth: string, method = "GET") {
  return d.fetch(API + path, { method, headers: { authorization: auth, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Pulse-for-GitHub" } });
}
async function installationToken(d: Deps, inst: string) {
  const c = tokens.get(inst), now = d.now?.() ?? Date.now();
  if (c && c.exp - now > 5 * 60_000) return c.token;
  const r = await gh(d, `/app/installations/${inst}/access_tokens`, `Bearer ${await appJwt(d)}`, "POST");
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, `GitHub wouldn't give an installation token: ${body.message || r.status}`);
  tokens.set(inst, { token: body.token, exp: Date.parse(body.expires_at) });
  return body.token as string;
}

// ---------------------------------------------------------------- 1. after install
async function setup(url: URL, d: Deps) {
  const site = (d.env.PULSE_SITE_URL || "").replace(/\/?$/, "/");
  const back = (msg: string) => Response.redirect(`${site}admin/#/integrations?github=${encodeURIComponent(msg)}`, 302);
  const inst = url.searchParams.get("installation_id")!, state = url.searchParams.get("state");
  if (url.searchParams.get("setup_action") === "request") return back("Your organization's owner needs to approve the install on GitHub; Pulse connects once they do.");
  if (!state) return back("Open Pulse and click Connect GitHub there, so Pulse knows which company the install is for.");
  const r = await gh(d, `/app/installations/${inst}`, `Bearer ${await appJwt(d)}`);
  if (!r.ok) return back("GitHub didn't confirm the install. Try Connect GitHub again.");
  const info = await r.json();
  const db = await rpc(d, "gh_app_connect", { p_state: state, p_installation: +inst, p_account: info.account?.login || null });
  if (!db.ok) return back((await db.json().catch(() => ({})))?.message || "Pulse couldn't save the connection. Try again.");
  return back("connected");
}

// ---------------------------------------------------------------- 2. relay for the database timer
async function relay(req: Request, url: URL, d: Deps) {
  const secret = d.env.PULSE_RELAY_SECRET || "";
  if (!secret || !(await same(req.headers.get("x-pulse-relay") || "", secret))) throw new HttpError(401, "Not allowed.");
  const inst = url.searchParams.get("installation") || "", path = url.searchParams.get("path") || "";
  if (!/^\d+$/.test(inst) || !PATHS.test(path)) throw new HttpError(400, "That request isn't allowed.");
  const r = await gh(d, path, `token ${await installationToken(d, inst)}`);
  return new Response(await r.text(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
}

// ---------------------------------------------------------------- 3. webhooks
async function webhook(req: Request, d: Deps) {
  const raw = await req.text(), secret = d.env.GITHUB_WEBHOOK_SECRET || "";
  if (!secret) throw new HttpError(503, "GITHUB_WEBHOOK_SECRET isn't set.");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!(await same(req.headers.get("x-hub-signature-256") || "", want))) throw new HttpError(401, "Bad signature.");
  const ev = req.headers.get("x-github-event") || "", p = JSON.parse(raw || "{}"), inst = p.installation?.id;
  if (!inst) return Response.json({ ignored: ev });
  let event = ev;
  if (ev === "installation" || ev === "installation_repositories") event = `installation.${ev === "installation" ? p.action : "repos"}`;
  else if (!["issues", "milestone", "label", "issue_comment"].includes(ev)) return Response.json({ ignored: ev });
  if (ev === "issue_comment") return Response.json({ ignored: ev });
  const r = await rpc(d, "gh_app_event", { p_installation: inst, p_repo: p.repository?.full_name || "", p_event: event });
  if (event.startsWith("installation.")) tokens.delete(String(inst));
  return Response.json({ ok: r.ok, event, synced: r.ok ? await r.json() : 0 });
}

// ---------------------------------------------------------------- helpers
async function rpc(d: Deps, fn: string, args: unknown) {
  return d.fetch(`${d.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args),
    headers: { apikey: d.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${d.env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" } });
}
async function same(a: string, b: string) {   // constant-time compare
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y); let diff = a.length ^ b.length;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

if (import.meta.main) Deno.serve({ port: +(Deno.env.get("PORT") || 8000), hostname: Deno.env.get("HOST") || "0.0.0.0" }, (req) => handle(req, { fetch, env: Deno.env.toObject() }));
