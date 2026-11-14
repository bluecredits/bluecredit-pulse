// deno test supabase/functions/billing — checkout, confirm, plan change, seats, cancel and the webhook against a fake PayPal and database.
import { handle } from "./index.ts";
import { fakeDb, assert, eq } from "../_shared/testkit.ts";

const env = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
  PAYPAL_CLIENT_ID: "cid", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "WH-1", SITE_URL: "https://pulse.example.com" };
const T0 = Date.parse("2026-11-14T12:00:00Z");
const NEXT = "2026-12-14T10:00:00Z";
function world(opts: { verify?: string; subStatus?: string; customId?: string } = {}) {
  const db = fakeDb({
    profiles: [
      { id: "u1", workspace_id: "w1", role: "admin", active: true, display_name: "Ann Admin", email: "ann@acme.test" },
      { id: "u2", workspace_id: "w1", role: "member", active: true, display_name: "Al Member", email: "al@acme.test" },
      { id: "u4", workspace_id: "w1", role: "employee", active: true, display_name: "Eve", email: "eve@acme.test" },
      { id: "u3", workspace_id: "w1", role: "contractor", active: true, display_name: "Cara", email: "cara@x.test" },
    ],
    workspaces: [{ id: "w1", name: "Acme", plan: "starter", billing_cycle: "month", comped: false, billing_email: null, paypal_subscription_id: null, paid_until: null }],
    paypal_plans: [],
  });
  const calls: { method: string; path: string; body: any }[] = [];
  const users: Record<string, string> = { "jwt-ann": "u1", "jwt-al": "u2" };
  let n = 0;
  const sub = () => ({ id: "I-SUB1", status: opts.subStatus || "ACTIVE", custom_id: opts.customId || "w1", quantity: "3",
    plan_id: db.t.paypal_plans.find((p: any) => p.key === "pro-month")?.plan_id || "P-PRO-MONTH", billing_info: { next_billing_time: NEXT } });
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/auth/v1/user")) {
      const tok = String((init.headers as any).authorization).replace("Bearer ", "");
      return users[tok] ? Response.json({ id: users[tok], email: db.t.profiles.find((p: any) => p.id === users[tok]).email }) : new Response("no", { status: 401 });
    }
    if (url.includes("/rest/v1/")) return db.handle(url, init);
    if (url.startsWith("https://api-m.sandbox.paypal.com")) {
      const path = url.slice("https://api-m.sandbox.paypal.com".length), method = init.method || "GET";
      const body = init.body && path !== "/v1/oauth2/token" ? JSON.parse(String(init.body)) : init.body;
      calls.push({ method, path, body });
      if (path === "/v1/oauth2/token") return Response.json({ access_token: "tok", expires_in: 3600 });
      if (path === "/v1/catalogs/products") return Response.json({ id: "PROD-1" });
      if (path === "/v1/billing/plans") return Response.json({ id: `P-${++n}` });
      if (path === "/v1/billing/subscriptions" && method === "POST") return Response.json({ id: "I-SUB1", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1" }] });
      if (path === "/v1/billing/subscriptions/I-SUB1") return Response.json(sub());
      if (path === "/v1/billing/subscriptions/I-SUB1/revise") return Response.json({ plan_id: body.plan_id, links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve-revise" }] });
      if (path === "/v1/billing/subscriptions/I-SUB1/cancel") return new Response(null, { status: 204 });
      if (path === "/v1/notifications/verify-webhook-signature") return Response.json({ verification_status: opts.verify || "SUCCESS" });
    }
    throw new Error("unexpected fetch " + url);
  };
  const d = { fetch: f as typeof fetch, env, now: () => T0 };
  const post = (tok: string, body: unknown) => handle(new Request("https://proj.supabase.co/functions/v1/billing", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }), d);
  const hook = (ev: unknown) => handle(new Request("https://proj.supabase.co/functions/v1/billing/webhook", {
    method: "POST", headers: { "content-type": "application/json", "paypal-transmission-id": "t1" }, body: JSON.stringify(ev) }), d);
  return { db, calls, post, hook };
}

Deno.test("checkout creates the product and a per-user plan once, then a subscription for the staff count", async () => {
  const w = world();
  const r = await w.post("jwt-ann", { action: "checkout", plan: "pro", cycle: "month" });
  const out = await r.json();
  eq(r.status, 200, JSON.stringify(out));
  assert(out.url.includes("ba_token"), "approval url");
  const plan = w.calls.find((c) => c.path === "/v1/billing/plans")!.body;
  eq(plan.billing_cycles[0].pricing_scheme.fixed_price.value, "6.00");
  eq(plan.quantity_supported, true);
  const s = w.calls.find((c) => c.path === "/v1/billing/subscriptions")!.body;
  eq(s.quantity, "3", "admin + member + employee; contractor free");
  eq(s.custom_id, "w1");
  assert(!s.application_context.return_url.includes("#"), "no hash in return url");
  // second checkout attempt for another plan reuses the stored product
  await w.post("jwt-ann", { action: "checkout", plan: "enterprise", cycle: "year" });
  eq(w.calls.filter((c) => c.path === "/v1/catalogs/products").length, 1);
  const ent = w.calls.filter((c) => c.path === "/v1/billing/plans")[1].body;
  eq(ent.billing_cycles[0].pricing_scheme.fixed_price.value, "100.00", "yearly = 10 months");
  eq(ent.billing_cycles[0].frequency.interval_unit, "YEAR");
});

Deno.test("only admins; comped workspaces don't pay", async () => {
  const w = world();
  eq((await w.post("jwt-al", { action: "checkout", plan: "pro" })).status, 403);
  w.db.t.workspaces[0].comped = true;
  eq((await w.post("jwt-ann", { action: "checkout", plan: "pro" })).status, 400);
});

Deno.test("confirm turns the plan on until the next billing date plus grace", async () => {
  const w = world();
  await w.post("jwt-ann", { action: "checkout", plan: "pro", cycle: "month" });
  const r = await (await w.post("jwt-ann", { action: "confirm", subscription_id: "I-SUB1" })).json();
  eq(r.ok, true, JSON.stringify(r));
  const ws = w.db.t.workspaces[0];
  eq(ws.plan, "pro"); eq(ws.paypal_subscription_id, "I-SUB1"); eq(ws.billing_cycle, "month");
  eq(ws.paid_until, new Date(Date.parse(NEXT) + 3 * 86400_000).toISOString());
});

Deno.test("confirm refuses another workspace's subscription", async () => {
  const w = world({ customId: "w2" });
  eq((await w.post("jwt-ann", { action: "confirm", subscription_id: "I-SUB1" })).status, 403);
  eq(w.db.t.workspaces[0].plan, "starter");
});

Deno.test("change and seat sync go through PayPal's revise (approval link back)", async () => {
  const w = world();
  w.db.t.workspaces[0].paypal_subscription_id = "I-SUB1";
  const c = await (await w.post("jwt-ann", { action: "change", plan: "enterprise", cycle: "month" })).json();
  assert(c.url?.includes("approve-revise"), JSON.stringify(c));
  w.db.t.profiles.push({ id: "u5", workspace_id: "w1", role: "member", active: true, display_name: "New", email: "n@acme.test" });
  const s = await (await w.post("jwt-ann", { action: "sync_seats" })).json();
  eq(s.seats, 4);
  eq(w.calls.filter((x) => x.path.endsWith("/revise")).pop()!.body.quantity, "4");
});

Deno.test("cancel stops the subscription but keeps the paid period", async () => {
  const w = world();
  Object.assign(w.db.t.workspaces[0], { paypal_subscription_id: "I-SUB1", plan: "pro", paid_until: "2026-12-17T00:00:00.000Z" });
  eq((await w.post("jwt-ann", { action: "cancel", reason: "Closing" })).status, 200);
  eq(w.db.t.workspaces[0].paypal_subscription_id, null);
  eq(w.db.t.workspaces[0].paid_until, "2026-12-17T00:00:00.000Z");
});

Deno.test("webhook: verified renewal extends; bad signature is refused; suspension ends access", async () => {
  const w = world();
  w.db.t.paypal_plans.push({ env: "sandbox", key: "pro-month", plan_id: "P-PRO-MONTH" });
  const ok = await (await w.hook({ event_type: "PAYMENT.SALE.COMPLETED", resource: { billing_agreement_id: "I-SUB1" } })).json();
  eq(ok.ok, true, JSON.stringify(ok));
  eq(w.db.t.workspaces[0].plan, "pro");
  const bad = world({ verify: "FAILURE" });
  eq((await bad.hook({ event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-SUB1" } })).status, 400);
  eq(bad.db.t.workspaces[0].plan, "starter");
  const sus = world({ subStatus: "SUSPENDED" });
  await sus.hook({ event_type: "BILLING.SUBSCRIPTION.SUSPENDED", resource: { id: "I-SUB1" } });
  eq(sus.db.t.workspaces[0].paid_until, new Date(T0).toISOString());
});

Deno.test("not set up yet without PayPal keys", async () => {
  const w = world();
  const r = await handle(new Request("https://x/functions/v1/billing", { method: "POST", headers: { authorization: "Bearer jwt-ann" }, body: "{}" }),
    { fetch: (() => { throw new Error("no"); }) as any, env: { ...env, PAYPAL_CLIENT_ID: "" } });
  eq(r.status, 503);
});
