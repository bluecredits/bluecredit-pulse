// deno test supabase/functions/github — app JWT signing, install callback, relay rules and webhooks against a fake GitHub.
import { appJwt, handle } from "./index.ts";
import { assert, eq } from "../_shared/testkit.ts";

// a throwaway PKCS#1 key ("BEGIN RSA PRIVATE KEY", the form GitHub hands out), made with openssl at test time
async function pkcs1Pem() {
  const dir = await Deno.makeTempDir(), run = (...a: string[]) => new Deno.Command("openssl", { args: a, stderr: "null" }).output();
  let o = await run("genrsa", "-traditional", "-out", `${dir}/k.pem`, "2048"); if (!o.success) await run("genrsa", "-out", `${dir}/k.pem`, "2048");
  await run("rsa", "-in", `${dir}/k.pem`, "-pubout", "-outform", "DER", "-out", `${dir}/k.der`);
  const pub = await crypto.subtle.importKey("spki", await Deno.readFile(`${dir}/k.der`), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return { pem: await Deno.readTextFile(`${dir}/k.pem`), pub };
}
const enc = new TextEncoder();
async function world() {
  const { pem, pub } = await pkcs1Pem();
  const calls: { url: string; init: RequestInit }[] = [];
  const env = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_WEBHOOK_SECRET: "whsec", PULSE_RELAY_SECRET: "relay-secret-0123456789abcdef", PULSE_SITE_URL: "https://pulse.example.com" };
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "ghs_inst", expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (url === "https://api.github.com/app/installations/77") return Response.json({ id: 77, account: { login: "BlueCredit" } });
    if (url.startsWith("https://api.github.com/repos/")) return Response.json([{ number: 1 }]);
    if (url.endsWith("/rpc/gh_app_connect")) return JSON.parse(String(init.body)).p_state === "good" ? Response.json("w1") : Response.json({ message: "This GitHub connection link has expired." }, { status: 400 });
    if (url.endsWith("/rpc/gh_app_event")) return Response.json(2);
    return new Response("?", { status: 404 });
  };
  return { d: { fetch: f as typeof fetch, env }, calls, pub };
}

Deno.test("app JWT is RS256-signed with the PKCS#1 key and names the app", async () => {
  const { d, pub } = await world();
  const jwt = await appJwt(d); const [h, p, s] = jwt.split(".");
  const un = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - x.length % 4) % 4)), (c) => c.charCodeAt(0));
  assert(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, un(s), enc.encode(`${h}.${p}`)), "signature verifies");
  eq(JSON.parse(new TextDecoder().decode(un(p))).iss, "12345");
});

Deno.test("install callback connects the workspace and returns to Integrations", async () => {
  const { d, calls } = await world();
  let r = await handle(new Request("https://fn/github?installation_id=77&setup_action=install&state=good"), d);
  eq(r.status, 302); eq(r.headers.get("location"), "https://pulse.example.com/admin/#/integrations?github=connected");
  const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/rpc/gh_app_connect"))!.init.body));
  eq(body, { p_state: "good", p_installation: 77, p_account: "BlueCredit" });
  r = await handle(new Request("https://fn/github?installation_id=77&setup_action=install&state=old"), d);
  assert(r.headers.get("location")!.includes("expired"), "expired state is explained");
  r = await handle(new Request("https://fn/github?installation_id=77&setup_action=install"), d);
  assert(r.headers.get("location")!.includes("Connect%20GitHub"), "no state: told to start from Pulse");
});

Deno.test("relay needs the secret and only allows read paths", async () => {
  const { d, calls } = await world();
  const q = (path: string, secret = d.env.PULSE_RELAY_SECRET) => handle(new Request(`https://fn/github?installation=77&path=${encodeURIComponent(path)}`, { headers: { "x-pulse-relay": secret } }), d);
  eq((await q("/repos/BlueCredit/bluecredits-core/issues?state=all&per_page=100&page=1&since=2026-11-08T18:25:55Z")).status, 200);
  const gh = calls.find((c) => c.url.startsWith("https://api.github.com/repos/"))!;
  eq((gh.init.headers as any).authorization, "token ghs_inst");
  eq((await q("/repos/x/y/issues", "wrong")).status, 401);
  eq((await q("/repos/x/y/contents/secret.txt")).status, 400);
  eq((await q("/user/repos")).status, 400);
});

Deno.test("webhook checks the signature and asks the database to sync", async () => {
  const { d, calls } = await world();
  const payload = JSON.stringify({ action: "closed", installation: { id: 77 }, repository: { full_name: "BlueCredit/bluecredits-core" } });
  const key = await crypto.subtle.importKey("raw", enc.encode("whsec"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  let r = await handle(new Request("https://fn/github", { method: "POST", body: payload, headers: { "x-github-event": "issues", "x-hub-signature-256": sig } }), d);
  eq(r.status, 200); eq((await r.json()).synced, 2);
  eq(JSON.parse(String(calls.find((c) => c.url.endsWith("/rpc/gh_app_event"))!.init.body)), { p_installation: 77, p_repo: "BlueCredit/bluecredits-core", p_event: "issues" });
  r = await handle(new Request("https://fn/github", { method: "POST", body: payload, headers: { "x-github-event": "issues", "x-hub-signature-256": "sha256=00" } }), d);
  eq(r.status, 401);
});
