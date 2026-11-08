// deno test supabase/functions/billing — checkout, portal, seat sync and the webhook against a fake Stripe and database.
import { handle } from "./index.ts";
import { fakeDb, assert, eq } from "../_shared/testkit.ts";

const env = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", SITE_URL: "https://pulse.example.com" };
const T0 = Date.parse("2026-11-08T12:00:00Z");
function world() {
  const db = fakeDb({
    profiles: [
      { id: "u1", workspace_id: "w1", role: "admin", active: true, display_name: "Ann Admin", email: "ann@acme.test" },
      { id: "u2", workspace_id: "w1", role: "member", active: true, display_name: "Al Member", email: "al@acme.test" },
      { id: "u3", workspace_id: "w1", role: "contractor", active: true, display_name: "Cara", email: "cara@x.test" },
    ],
    workspaces: [{ id: "w1", name: "Acme", plan: "starter", comped: false, billing_email: null, stripe_customer_id: null, stripe_subscription_id: null }],
  });
  const stripe: { path: string; body: URLSearchParams }[] = [];
  const users: Record<string, string> = { "jwt-ann": "u1", "jwt-al": "u2" };
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/auth/v1/user")) {
      const tok = String((init.headers as any).authorization).replace("Bearer ", "");
      return users[tok] ? Response.json({ id: users[tok], email: db.t.profiles.find((p: any) => p.id === users[tok]).email }) : new Response("no", { status: 401 });
    }
    if (url.includes("/rest/v1/")) return db.handle(url, init);
    if (url.startsWith("https://api.stripe.com/v1/")) {
      const path = url.slice(26); stripe.push({ path, body: new URLSearchParams(String(init.body || "")) });
      if (path === "checkout/sessions") return Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
      if (path === "billing_portal/sessions") return Response.json({ url: "https://billing.stripe.com/p/1" });
      if (path === "subscriptions/sub_1") return Response.json({ id: "sub_1", customer: "cus_1", status: "active", metadata: { workspace_id: "w1", plan: "pro", cycle: "month" },
        items: { data: [{ id: "si_1", quantity: 1, current_period_end: T0 / 1000 + 30 * 86400 }] } });
      if (path === "subscription_items/si_1") return Response.json({ id: "si_1" });
    }
    throw new Error("unexpected fetch " + url);
  };
  const d = { fetch: f as typeof fetch, env, now: () => T0 };
  const post = (tok: string, body: unknown) => handle(new Request("https://proj.supabase.co/functions/v1/billing", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }), d);
  return { db, stripe, post, d };
}
async function signed(payload: string, secret = "whsec_test", t = Math.floor(T0 / 1000)) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

Deno.test("checkout: one seat per staff user (contractors free), yearly = 10 months, admin only", async () => {
  const w = world();
  const r = await w.post("jwt-ann", { action: "checkout", plan: "pro", cycle: "year" });
  eq(r.status, 200); eq((await r.json()).url, "https://checkout.stripe.com/c/cs_1");
  const b = w.stripe[0].body;
  eq(b.get("line_items[0][quantity]"), "2");
  eq(b.get("line_items[0][price_data][unit_amount]"), "6000");
  eq(b.get("line_items[0][price_data][recurring][interval]"), "year");
  eq(b.get("subscription_data[metadata][workspace_id]"), "w1");
  eq(b.get("customer_email"), "ann@acme.test");
  eq((await w.post("jwt-al", { action: "checkout", plan: "pro" })).status, 403);
  eq((await w.post("jwt-ann", { action: "checkout", plan: "gold" })).status, 400);
});

Deno.test("webhook: signed checkout completion sets plan, customer and paid-until (+3 days grace); bad signature refused", async () => {
  const w = world();
  const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", client_reference_id: "w1", metadata: { workspace_id: "w1" } } } });
  const bad = await handle(new Request("https://proj.supabase.co/functions/v1/billing/webhook", { method: "POST", headers: { "stripe-signature": await signed(payload, "wrong") }, body: payload }), w.d);
  eq(bad.status, 400);
  const ok = await handle(new Request("https://proj.supabase.co/functions/v1/billing/webhook", { method: "POST", headers: { "stripe-signature": await signed(payload) }, body: payload }), w.d);
  eq(ok.status, 200);
  const ws = w.db.t.workspaces[0];
  eq(ws.plan, "pro"); eq(ws.stripe_customer_id, "cus_1"); eq(ws.stripe_subscription_id, "sub_1");
  eq(ws.paid_until, new Date(T0 + 33 * 86400e3).toISOString());
});

Deno.test("webhook: cancelled subscription ends the paid period now; old signatures refused", async () => {
  const w = world(); Object.assign(w.db.t.workspaces[0], { plan: "pro", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" });
  const payload = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { workspace_id: "w1", plan: "pro" } } } });
  const stale = await handle(new Request("https://x/billing/webhook", { method: "POST", headers: { "stripe-signature": await signed(payload, "whsec_test", T0 / 1000 - 900) }, body: payload }), w.d);
  eq(stale.status, 400);
  const r = await handle(new Request("https://x/billing/webhook", { method: "POST", headers: { "stripe-signature": await signed(payload) }, body: payload }), w.d);
  eq(r.status, 200);
  eq(w.db.t.workspaces[0].stripe_subscription_id, null); eq(w.db.t.workspaces[0].paid_until, new Date(T0).toISOString());
});

Deno.test("portal and seat sync use the stored customer and subscription", async () => {
  const w = world();
  eq((await w.post("jwt-ann", { action: "portal" })).status, 400);
  Object.assign(w.db.t.workspaces[0], { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" });
  eq((await (await w.post("jwt-ann", { action: "portal" })).json()).url, "https://billing.stripe.com/p/1");
  eq((await (await w.post("jwt-ann", { action: "sync_seats" })).json()).seats, 2);
  assert(w.stripe.some((s) => s.path === "subscription_items/si_1" && s.body.get("quantity") === "2"), "quantity updated");
});

Deno.test("not set up: clear 503 until the Stripe key is added", async () => {
  const w = world(); (w.d.env as any) = { ...env, STRIPE_SECRET_KEY: "" };
  const r = await handle(new Request("https://x/billing", { method: "POST", headers: { authorization: "Bearer jwt-ann" }, body: "{}" }), { ...w.d, env: { ...env, STRIPE_SECRET_KEY: "" } });
  eq(r.status, 503);
});
