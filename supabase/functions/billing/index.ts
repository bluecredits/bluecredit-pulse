// billing: Stripe for Pulse plans. Off until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set.
//   POST {action:"checkout", plan, cycle}  (workspace admin)  → {url} of a Stripe Checkout page, one seat per staff user
//   POST {action:"portal"}                 (workspace admin)  → {url} of the Stripe customer portal (cards, invoices, cancel)
//   POST {action:"sync_seats"}             (workspace admin)  → sets the subscription quantity to today's staff count
//   POST /webhook                          (Stripe)           → keeps workspaces.plan / paid_until in step with the subscription
// Deploy with "Verify JWT" off: Stripe's webhook carries no user token (it is checked by its signature instead).
import { caller, CORS, Deps, HttpError, json, need, rest } from "../_shared/pulse.ts";

export const PRICES: Record<string, number> = { starter: 300, pro: 600, enterprise: 1000 };   // US cents per user per month
const NAMES: Record<string, string> = { starter: "Pulse Starter", pro: "Pulse Pro", enterprise: "Pulse Enterprise" };
const GRACE_DAYS = 3;   // a failed renewal keeps the plan this long while Stripe retries

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    if (/\/webhook\/?$/.test(url.pathname)) return json(await webhook(req, d));
    need(d.env, "STRIPE_SECRET_KEY", "SITE_URL");
    const me = await caller(req, d);
    if (me.role !== "admin") throw new HttpError(403, "Only admins can change the plan.");
    const body = await req.json().catch(() => ({}));
    const [w] = await rest(d, `workspaces?id=eq.${me.workspace_id}&select=id,name,plan,billing_email,stripe_customer_id,stripe_subscription_id,comped`);
    if (!w) throw new HttpError(404, "Workspace not found.");
    if (body.action === "checkout") return json(await checkout(w, me, body, d));
    if (body.action === "portal") return json(await portal(w, d));
    if (body.action === "sync_seats") return json(await syncSeats(w, d));
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
}

async function stripe(d: Deps, path: string, params?: Record<string, string>, method = params ? "POST" : "GET") {
  const r = await d.fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { authorization: `Bearer ${d.env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const out = await r.json();
  if (!r.ok) throw new HttpError(502, `Stripe: ${out?.error?.message || r.status}`);
  return out;
}
async function seats(d: Deps, ws: string) {
  const rows = await rest(d, `profiles?workspace_id=eq.${ws}&active=eq.true&role=in.(admin,member)&select=id`);
  return Math.max(1, rows.length);
}

async function checkout(w: any, me: any, body: any, d: Deps) {
  const plan = String(body.plan), cycle = body.cycle === "year" ? "year" : "month";
  if (!PRICES[plan]) throw new HttpError(400, "Pick Starter, Pro or Enterprise.");
  if (w.comped) throw new HttpError(400, "This workspace is on a complimentary plan; nothing to pay.");
  if (w.stripe_subscription_id) throw new HttpError(409, "You already have a subscription. Use Manage billing to change it.");
  const site = d.env.SITE_URL!.replace(/\/$/, "");
  const p: Record<string, string> = {
    mode: "subscription",
    "line_items[0][quantity]": String(await seats(d, w.id)),
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cycle === "year" ? PRICES[plan] * 10 : PRICES[plan]),   // yearly = 2 months free
    "line_items[0][price_data][recurring][interval]": cycle,
    "line_items[0][price_data][product_data][name]": NAMES[plan],
    "metadata[workspace_id]": w.id, "metadata[plan]": plan, "metadata[cycle]": cycle,
    "subscription_data[metadata][workspace_id]": w.id, "subscription_data[metadata][plan]": plan, "subscription_data[metadata][cycle]": cycle,
    client_reference_id: w.id, allow_promotion_codes: "true",
    success_url: `${site}/admin/#/billing?paid=1`, cancel_url: `${site}/admin/#/billing`,
  };
  if (w.stripe_customer_id) p.customer = w.stripe_customer_id; else p.customer_email = w.billing_email || me.email;
  const s = await stripe(d, "checkout/sessions", p);
  return { url: s.url };
}

async function portal(w: any, d: Deps) {
  if (!w.stripe_customer_id) throw new HttpError(400, "No card on file yet. Choose a plan first.");
  const s = await stripe(d, "billing_portal/sessions", { customer: w.stripe_customer_id, return_url: `${d.env.SITE_URL!.replace(/\/$/, "")}/admin/#/billing` });
  return { url: s.url };
}

async function syncSeats(w: any, d: Deps) {
  if (!w.stripe_subscription_id) throw new HttpError(400, "No subscription yet.");
  const sub = await stripe(d, `subscriptions/${w.stripe_subscription_id}`);
  const item = sub.items?.data?.[0];
  const n = await seats(d, w.id);
  if (item && item.quantity !== n) await stripe(d, `subscription_items/${item.id}`, { quantity: String(n), proration_behavior: "create_prorations" });
  return { seats: n };
}

// ---------------------------------------------------------------- webhook
async function verifySig(payload: string, header: string, secret: string, nowSec: number) {
  const parts = Object.fromEntries(header.split(",").map((x) => x.split("=") as [string, string]));
  const t = Number(parts.t), v1 = header.split(",").filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
  if (!t || !v1.length || Math.abs(nowSec - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1.some((s) => s.length === hex.length && [...s].every((c, i) => c === hex[i]));
}
const periodEnd = (sub: any) => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;

export async function webhook(req: Request, d: Deps) {
  need(d.env, "STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY");
  const payload = await req.text();
  const ok = await verifySig(payload, req.headers.get("stripe-signature") || "", d.env.STRIPE_WEBHOOK_SECRET!, Math.floor((d.now?.() ?? Date.now()) / 1000));
  if (!ok) throw new HttpError(400, "Bad signature.");
  const ev = JSON.parse(payload), o = ev.data?.object || {};
  let sub: any = null;
  if (ev.type === "checkout.session.completed" && o.mode === "subscription") sub = await stripe(d, `subscriptions/${o.subscription}`);
  else if (/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) sub = o;
  else return { ignored: ev.type };
  const ws = sub.metadata?.workspace_id || o.metadata?.workspace_id || o.client_reference_id;
  if (!ws) return { ignored: "no workspace" };
  const live = ["active", "trialing", "past_due"].includes(sub.status) && ev.type !== "customer.subscription.deleted";
  const plan = PRICES[sub.metadata?.plan] ? sub.metadata.plan : undefined;
  const patch: Record<string, unknown> = {
    stripe_customer_id: sub.customer, stripe_subscription_id: live ? sub.id : null,
    paid_until: live && periodEnd(sub) ? new Date((periodEnd(sub) + GRACE_DAYS * 86400) * 1000).toISOString() : new Date(d.now?.() ?? Date.now()).toISOString(),
  };
  if (plan) patch.plan = plan;
  if (sub.metadata?.cycle === "year" || sub.metadata?.cycle === "month") patch.billing_cycle = sub.metadata.cycle;
  await rest(d, `workspaces?id=eq.${ws}&comped=eq.false`, { method: "PATCH", body: JSON.stringify(patch) });
  return { ok: true, workspace: ws, plan: plan || null, live };
}

if (import.meta.main) Deno.serve({ port: +(Deno.env.get("PORT") || 8000), hostname: Deno.env.get("HOST") || "0.0.0.0" }, (req) => handle(req, { fetch, env: Deno.env.toObject() }));
