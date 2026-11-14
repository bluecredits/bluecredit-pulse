// billing: PayPal subscriptions for Pulse plans. Off until PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and SITE_URL are set
// (PAYPAL_WEBHOOK_ID too, for renewals and cancellations made on PayPal's side). PAYPAL_ENV = "sandbox" (default) or "live".
//   POST {action:"checkout", plan, cycle}   (workspace admin) → {url} of PayPal's approval page; one seat per staff user
//   POST {action:"confirm", subscription_id} (workspace admin) → after PayPal sends them back: checks the subscription and turns the plan on
//   POST {action:"change", plan, cycle}     (workspace admin) → {url} to approve the new plan on PayPal (or {ok} when no approval is needed)
//   POST {action:"sync_seats"}              (workspace admin) → sets the subscription quantity to today's staff count
//   POST {action:"cancel", reason}          (workspace admin) → cancels at PayPal; the plan stays on until the paid period ends
//   POST {action:"manage"}                  (workspace admin) → {url} of PayPal's page for the payer's automatic payments
//   POST /webhook                           (PayPal)          → keeps workspaces.plan / paid_until in step with the subscription
// Deploy with "Verify JWT" off: PayPal's webhook carries no user token (it is checked with PayPal's verify-webhook-signature API).
// PayPal needs a billing plan per price: they're created on first use (product "Pulse", one plan per plan × cycle) and remembered
// in the paypal_plans table, separately for sandbox and live.
import { caller, CORS, Deps, HttpError, json, need, rest } from "../_shared/pulse.ts";

export const PRICES: Record<string, number> = { starter: 3, pro: 6, enterprise: 10 };   // US dollars per user per month; yearly = 10 months
const NAMES: Record<string, string> = { starter: "Pulse Starter", pro: "Pulse Pro", enterprise: "Pulse Enterprise" };
const GRACE_DAYS = 3;   // a late renewal keeps the plan this long while PayPal retries

const live = (d: Deps) => d.env.PAYPAL_ENV === "live";
const api = (d: Deps) => (live(d) ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
const now = (d: Deps) => d.now?.() ?? Date.now();

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    if (/\/webhook\/?$/.test(url.pathname)) return json(await webhook(req, d));
    need(d.env, "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "SITE_URL");
    const me = await caller(req, d);
    if (me.role !== "admin") throw new HttpError(403, "Only admins can change the plan.");
    const body = await req.json().catch(() => ({}));
    const [w] = await rest(d, `workspaces?id=eq.${me.workspace_id}&select=id,name,plan,billing_cycle,billing_email,paypal_subscription_id,comped`);
    if (!w) throw new HttpError(404, "Workspace not found.");
    if (body.action === "checkout") return json(await checkout(w, me, body, d));
    if (body.action === "confirm") return json(await confirm(w, body, d));
    if (body.action === "change") return json(await change(w, body, d));
    if (body.action === "sync_seats") return json(await syncSeats(w, d));
    if (body.action === "cancel") return json(await cancel(w, body, d));
    if (body.action === "manage") return json({ url: live(d) ? "https://www.paypal.com/myaccount/autopay/" : "https://www.sandbox.paypal.com/myaccount/autopay/" });
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
}

// ---------------------------------------------------------------- PayPal API
let tokenCache: { key: string; token: string; until: number } | null = null;
async function token(d: Deps) {
  const key = `${d.env.PAYPAL_CLIENT_ID}:${live(d)}`;
  if (tokenCache && tokenCache.key === key && tokenCache.until > now(d) + 60_000) return tokenCache.token;
  const r = await d.fetch(`${api(d)}/v1/oauth2/token`, {
    method: "POST", body: "grant_type=client_credentials",
    headers: { authorization: `Basic ${btoa(`${d.env.PAYPAL_CLIENT_ID}:${d.env.PAYPAL_CLIENT_SECRET}`)}`, "content-type": "application/x-www-form-urlencoded" },
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || !out.access_token) throw new HttpError(502, `PayPal sign-in failed: ${out.error_description || r.status}. Check the client ID, secret and PAYPAL_ENV.`);
  tokenCache = { key, token: out.access_token, until: now(d) + (out.expires_in || 3000) * 1000 };
  return out.access_token as string;
}
export async function pp(d: Deps, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const r = await d.fetch(`${api(d)}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${await token(d)}`, "content-type": "application/json", prefer: "return=representation" },
  });
  const text = await r.text(), out = text ? JSON.parse(text) : {};
  if (!r.ok) throw new HttpError(502, `PayPal: ${out?.details?.[0]?.description || out?.message || r.status}`);
  return out;
}
const siteUrl = (d: Deps) => d.env.SITE_URL!.split(",")[0].trim().replace(/\/$/, "");   // first address if several are listed
const approveLink = (o: any) => (o?.links || []).find((l: any) => l.rel === "approve")?.href as string | undefined;

async function seats(d: Deps, ws: string) {
  const rows = await rest(d, `profiles?workspace_id=eq.${ws}&active=eq.true&role=in.(admin,member,employee)&select=id`);
  return Math.max(1, rows.length);
}

// one PayPal plan per Pulse plan × cycle, priced per user (quantity = seats)
export async function planId(d: Deps, plan: string, cycle: string) {
  const env = live(d) ? "live" : "sandbox", key = `${plan}-${cycle}`;
  const [have] = await rest(d, `paypal_plans?env=eq.${env}&key=eq.${key}&select=plan_id,product_id`);
  if (have?.plan_id) return have.plan_id as string;
  let [prod] = await rest(d, `paypal_plans?env=eq.${env}&key=eq.product&select=product_id`);
  if (!prod?.product_id) {
    const p = await pp(d, "/v1/catalogs/products", { name: "Pulse", description: "Pulse workspace for small firms", type: "SERVICE", category: "SOFTWARE" });
    await rest(d, "paypal_plans", { method: "POST", body: JSON.stringify({ env, key: "product", product_id: p.id }) });
    prod = { product_id: p.id };
  }
  const price = cycle === "year" ? PRICES[plan] * 10 : PRICES[plan];
  const p = await pp(d, "/v1/billing/plans", {
    product_id: prod.product_id, name: `${NAMES[plan]} (${cycle === "year" ? "yearly" : "monthly"}, per user)`, status: "ACTIVE", quantity_supported: true,
    billing_cycles: [{ frequency: { interval_unit: cycle === "year" ? "YEAR" : "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: price.toFixed(2), currency_code: "USD" } } }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CONTINUE", payment_failure_threshold: 3 },
  });
  await rest(d, "paypal_plans", { method: "POST", body: JSON.stringify({ env, key, plan_id: p.id, product_id: prod.product_id }) });
  return p.id as string;
}
const keyOf = (plan: string, cycle: string) => { if (!PRICES[plan]) throw new HttpError(400, "Pick Starter, Pro or Enterprise."); return [plan, cycle === "year" ? "year" : "month"]; };

async function checkout(w: any, me: any, body: any, d: Deps) {
  const [plan, cycle] = keyOf(String(body.plan), body.cycle);
  if (w.comped) throw new HttpError(400, "This workspace is on a complimentary plan; nothing to pay.");
  if (w.paypal_subscription_id) throw new HttpError(409, "You already have a subscription. Use Change plan instead.");
  const site = siteUrl(d);
  const sub = await pp(d, "/v1/billing/subscriptions", {
    plan_id: await planId(d, plan, cycle), quantity: String(await seats(d, w.id)), custom_id: w.id,
    subscriber: { email_address: w.billing_email || me.email },
    application_context: { brand_name: "Pulse", user_action: "SUBSCRIBE_NOW", shipping_preference: "NO_SHIPPING",
      // no "#" in these: PayPal adds ?subscription_id=… to the end of the address
      return_url: `${site}/admin/?paypal=return`, cancel_url: `${site}/admin/?paypal=cancel` },
  });
  const url = approveLink(sub);
  if (!url) throw new HttpError(502, "PayPal didn't return an approval page.");
  return { url, subscription_id: sub.id };
}

// read a subscription and write what it means into the workspace
export async function apply(d: Deps, sub: any, ws?: string) {
  ws = ws || sub.custom_id;
  if (!ws) return { ignored: "no workspace" };
  const status = String(sub.status || "");
  const plans = await rest(d, `paypal_plans?plan_id=eq.${sub.plan_id}&select=key`);
  const [plan, cycle] = String(plans?.[0]?.key || "").split("-");
  const next = sub.billing_info?.next_billing_time ? Date.parse(sub.billing_info.next_billing_time) : NaN;
  const patch: Record<string, unknown> = {};
  if (status === "ACTIVE") {
    patch.paypal_subscription_id = sub.id;
    patch.paid_until = new Date((Number.isFinite(next) ? next : now(d) + (cycle === "year" ? 365 : 31) * 86400_000) + GRACE_DAYS * 86400_000).toISOString();
    if (PRICES[plan]) patch.plan = plan;
    if (cycle === "month" || cycle === "year") patch.billing_cycle = cycle;
  } else if (status === "CANCELLED" || status === "EXPIRED") {
    patch.paypal_subscription_id = null;   // the paid period already recorded in paid_until still counts
  } else if (status === "SUSPENDED") {
    patch.paid_until = new Date(now(d)).toISOString();   // payments failed; back to Starter until it's sorted out on PayPal
  } else return { ignored: status };
  await rest(d, `workspaces?id=eq.${ws}&comped=eq.false`, { method: "PATCH", body: JSON.stringify(patch) });
  return { ok: true, workspace: ws, status, plan: PRICES[plan] ? plan : null };
}

async function confirm(w: any, body: any, d: Deps) {
  const id = String(body.subscription_id || "");
  if (!/^I-[A-Z0-9]+$/.test(id)) throw new HttpError(400, "That isn't a PayPal subscription number.");
  const sub = await pp(d, `/v1/billing/subscriptions/${id}`);
  if (sub.custom_id !== w.id) throw new HttpError(403, "That subscription belongs to another workspace.");
  if (sub.status === "APPROVAL_PENDING" || sub.status === "APPROVED") return { pending: true, status: sub.status };
  return await apply(d, sub, w.id);
}

async function change(w: any, body: any, d: Deps) {
  const [plan, cycle] = keyOf(String(body.plan), body.cycle);
  if (!w.paypal_subscription_id) throw new HttpError(400, "No subscription yet. Choose a plan first.");
  const site = siteUrl(d);
  const r = await pp(d, `/v1/billing/subscriptions/${w.paypal_subscription_id}/revise`, {
    plan_id: await planId(d, plan, cycle), quantity: String(await seats(d, w.id)),
    application_context: { brand_name: "Pulse", shipping_preference: "NO_SHIPPING", return_url: `${site}/admin/?paypal=return&subscription_id=${w.paypal_subscription_id}`, cancel_url: `${site}/admin/?paypal=cancel` },
  });
  const url = approveLink(r);
  if (url) return { url };
  return await apply(d, await pp(d, `/v1/billing/subscriptions/${w.paypal_subscription_id}`), w.id);
}

async function syncSeats(w: any, d: Deps) {
  if (!w.paypal_subscription_id) throw new HttpError(400, "No subscription yet.");
  const sub = await pp(d, `/v1/billing/subscriptions/${w.paypal_subscription_id}`);
  const n = await seats(d, w.id);
  if (String(sub.quantity) === String(n)) return { seats: n };
  const site = siteUrl(d);
  const r = await pp(d, `/v1/billing/subscriptions/${w.paypal_subscription_id}/revise`, {
    plan_id: sub.plan_id, quantity: String(n),
    application_context: { brand_name: "Pulse", shipping_preference: "NO_SHIPPING", return_url: `${site}/admin/?paypal=return&subscription_id=${w.paypal_subscription_id}`, cancel_url: `${site}/admin/?paypal=cancel` },
  });
  return { seats: n, url: approveLink(r) || null };
}

async function cancel(w: any, body: any, d: Deps) {
  if (!w.paypal_subscription_id) throw new HttpError(400, "There's no PayPal subscription to cancel.");
  await pp(d, `/v1/billing/subscriptions/${w.paypal_subscription_id}/cancel`, { reason: String(body.reason || "Cancelled from Pulse").slice(0, 120) });
  await rest(d, `workspaces?id=eq.${w.id}`, { method: "PATCH", body: JSON.stringify({ paypal_subscription_id: null }) });
  return { ok: true };
}

// ---------------------------------------------------------------- webhook
// PayPal checks the signature for us (verify-webhook-signature), so a forged call can't change a plan.
export async function webhook(req: Request, d: Deps) {
  need(d.env, "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID");
  const payload = await req.text();
  let ev: any; try { ev = JSON.parse(payload); } catch { throw new HttpError(400, "Bad payload."); }
  const h = (k: string) => req.headers.get(k) || "";
  const v = await pp(d, "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"), webhook_id: d.env.PAYPAL_WEBHOOK_ID, webhook_event: ev,
  });
  if (v.verification_status !== "SUCCESS") throw new HttpError(400, "Bad signature.");
  const type = String(ev.event_type || ""), o = ev.resource || {};
  let subId: string | undefined;
  if (/^BILLING\.SUBSCRIPTION\./.test(type)) subId = o.id;
  else if (type === "PAYMENT.SALE.COMPLETED" || type === "PAYMENT.SALE.DENIED") subId = o.billing_agreement_id;
  if (!subId) return { ignored: type };
  return await apply(d, await pp(d, `/v1/billing/subscriptions/${subId}`));
}

if (import.meta.main) Deno.serve({ port: +(Deno.env.get("PORT") || 8000), hostname: Deno.env.get("HOST") || "0.0.0.0" }, (req) => handle(req, { fetch, env: Deno.env.toObject() }));
