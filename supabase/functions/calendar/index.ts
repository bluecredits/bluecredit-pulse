// Pulse · calendar — connects each person's Google or Outlook calendar, keeps the team's free/busy
// times fresh, and books meetings on the organizer's calendar (the provider emails the invites).
//
// Routes (POST JSON with the person's Supabase sign-in, unless noted):
//   {action:"start", provider, return_to}   → {url} to send the browser to Google/Microsoft
//   GET /calendar/callback/<provider>        ← Google/Microsoft send the browser back here (no sign-in header)
//   {action:"sync", scope:"me"|"team"}       → refresh busy times (team: anyone not synced in 10 minutes)
//   {action:"book", title, start, end, attendee_ids, guest_emails, description, video}
//   {action:"disconnect", provider}
//   {action:"sync_all"} with header x-cron-secret → refresh everyone (run every 15 minutes by pg_cron)
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MS_CLIENT_ID, MS_CLIENT_SECRET, CALENDAR_SECRET (signs links and
// encrypts tokens), SITE_URL (where Pulse is served, e.g. https://pulse.bluecredits.org), CRON_SECRET.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { caller, CORS, Deps, HttpError, json, need, randomId, rest, seal, sign, unseal, verify } from "../_shared/pulse.ts";

const WINDOW_BACK_MS = 864e5, WINDOW_AHEAD_MS = 21 * 864e5, STALE_MS = 10 * 6e4;
type Provider = "google" | "microsoft";
const P = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events",
    id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET",
  },
  microsoft: {
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access openid email User.Read Calendars.ReadWrite",
    id: "MS_CLIENT_ID", secret: "MS_CLIENT_SECRET",
  },
} as const;
const fnUrl = (d: Deps) => d.env.CALENDAR_FUNCTION_URL || `${d.env.SUPABASE_URL}/functions/v1/calendar`;
const redirectUri = (d: Deps, p: Provider) => `${fnUrl(d)}/callback/${p}`;
const now = (d: Deps) => (d.now ? d.now() : Date.now());

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    const cb = url.pathname.match(/\/callback\/(google|microsoft)\/?$/);
    if (req.method === "GET" && cb) return await callback(url, cb[1] as Provider, d);
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    const body = await req.json().catch(() => ({}));
    if (body.action === "sync_all") {
      if (!d.env.CRON_SECRET || req.headers.get("x-cron-secret") !== d.env.CRON_SECRET) throw new HttpError(403, "Not allowed.");
      const accts = await rest(d, `calendar_accounts?status=eq.connected&select=*`);
      return json(await syncMany(accts, d));
    }
    const me = await caller(req, d);
    switch (body.action) {
      case "start": return json(await start(me, body, d));
      case "sync": {
        const filter = body.scope === "team" ? `workspace_id=eq.${me.workspace_id}` : `user_id=eq.${me.id}`;
        let accts = await rest(d, `calendar_accounts?${filter}&status=eq.connected&select=*`);
        if (body.scope === "team") accts = accts.filter((a: any) => a.user_id === me.id || !a.last_sync_at || now(d) - Date.parse(a.last_sync_at) > STALE_MS);
        return json(await syncMany(accts, d));
      }
      case "book": return json(await book(me, body, d));
      case "disconnect": return json(await disconnect(me, body.provider, d));
      default: throw new HttpError(400, "Unknown action.");
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
}

// ---------------------------------------------------------------- connect
function allowedReturn(d: Deps, to: string) {
  const sites = (d.env.SITE_URL || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  try { const u = new URL(to); return sites.some((s) => (u.origin + u.pathname).startsWith(s)); } catch { return false; }
}
async function start(me: any, body: any, d: Deps) {
  const p = body.provider as Provider;
  if (!P[p]) throw new HttpError(400, "Pick Google or Microsoft.");
  need(d.env, P[p].id, P[p].secret, "CALENDAR_SECRET", "SITE_URL");
  if (!allowedReturn(d, body.return_to || "")) throw new HttpError(400, "Unexpected return address.");
  const state = await sign({ u: me.id, w: me.workspace_id, p, r: body.return_to, exp: now(d) + 10 * 6e4 }, d.env.CALENDAR_SECRET!);
  const q = new URLSearchParams({ client_id: d.env[P[p].id]!, redirect_uri: redirectUri(d, p), response_type: "code", scope: P[p].scope, state });
  if (p === "google") { q.set("access_type", "offline"); q.set("prompt", "consent"); q.set("include_granted_scopes", "true"); if (me.email) q.set("login_hint", me.email); }
  else { q.set("response_mode", "query"); q.set("prompt", "select_account"); }
  return { url: `${P[p].auth}?${q}` };
}

function backTo(r: string, params: Record<string, string>) {
  const u = new URL(r), hash = u.hash; u.hash = "";
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString() + hash;
}
async function callback(url: URL, p: Provider, d: Deps) {
  need(d.env, "CALENDAR_SECRET");
  const st = await verify<{ u: string; w: string; p: Provider; r: string; exp: number }>(url.searchParams.get("state") || "", d.env.CALENDAR_SECRET!);
  const go = (params: Record<string, string>) => new Response(null, { status: 302, headers: { location: backTo(st.r, params) } });
  if (st.p !== p || st.exp < now(d)) return go({ calendar_error: "That link expired. Try connecting again." });
  if (url.searchParams.get("error")) return go({ calendar_error: url.searchParams.get("error_description") || "Access wasn't granted." });
  const [prof] = await rest(d, `profiles?id=eq.${st.u}&workspace_id=eq.${st.w}&active=eq.true&select=id`);
  if (!prof) return go({ calendar_error: "Your Pulse account isn't active." });
  const tok = await tokenCall(p, { grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: redirectUri(d, p) }, d);
  const email = await accountEmail(p, tok, d);
  const row = {
    workspace_id: st.w, user_id: st.u, provider: p, email, status: "connected", last_error: null,
    access_token: await seal(tok.access_token, d.env.CALENDAR_SECRET!),
    token_expires_at: new Date(now(d) + (tok.expires_in || 3600) * 1000).toISOString(),
    ...(tok.refresh_token ? { refresh_token: await seal(tok.refresh_token, d.env.CALENDAR_SECRET!) } : {}),
  };
  const [acct] = await rest(d, "calendar_accounts?on_conflict=user_id,provider", { method: "POST", body: JSON.stringify(row), prefer: "resolution=merge-duplicates,return=representation" });
  if (!acct.refresh_token) return go({ calendar_error: "Google didn't allow ongoing access. Remove Pulse from your Google account's third-party access, then connect again." });
  await syncMany([acct], d);
  return go({ calendar: "connected" });
}

async function tokenCall(p: Provider, params: Record<string, string>, d: Deps) {
  need(d.env, P[p].id, P[p].secret);
  const r = await d.fetch(P[p].token, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: d.env[P[p].id]!, client_secret: d.env[P[p].secret]! }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new HttpError(r.status === 400 ? 400 : 502, j.error_description || j.error || "Couldn't reach the calendar provider."); (e as any).code = j.error; throw e; }
  return j;
}
async function accountEmail(p: Provider, tok: any, d: Deps) {
  if (p === "google" && tok.id_token) {
    try { return JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || null; } catch { return null; }
  }
  if (p === "microsoft") {
    const r = await d.fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (r.ok) { const j = await r.json(); return j.mail || j.userPrincipalName || null; }
  }
  return null;
}

// ---------------------------------------------------------------- tokens and busy times
async function accessToken(a: any, d: Deps) {
  if (a.access_token && a.token_expires_at && Date.parse(a.token_expires_at) > now(d) + 60e3) return unseal(a.access_token, d.env.CALENDAR_SECRET!);
  const refresh = await unseal(a.refresh_token, d.env.CALENDAR_SECRET!);
  if (!refresh) throw Object.assign(new HttpError(400, "Reconnect this calendar."), { code: "invalid_grant" });
  const tok = await tokenCall(a.provider, { grant_type: "refresh_token", refresh_token: refresh, ...(a.provider === "microsoft" ? { scope: P.microsoft.scope } : {}) }, d);
  const patch: Record<string, unknown> = {
    access_token: await seal(tok.access_token, d.env.CALENDAR_SECRET!),
    token_expires_at: new Date(now(d) + (tok.expires_in || 3600) * 1000).toISOString(),
  };
  if (tok.refresh_token) patch.refresh_token = await seal(tok.refresh_token, d.env.CALENDAR_SECRET!);
  await rest(d, `calendar_accounts?id=eq.${a.id}`, { method: "PATCH", body: JSON.stringify(patch) });
  return tok.access_token as string;
}

export async function fetchBusy(a: any, token: string, d: Deps): Promise<{ start: string; end: string }[]> {
  const from = new Date(now(d) - WINDOW_BACK_MS).toISOString(), to = new Date(now(d) + WINDOW_AHEAD_MS).toISOString();
  if (a.provider === "google") {
    const r = await d.fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: from, timeMax: to, items: [{ id: "primary" }] }),
    });
    if (!r.ok) throw new HttpError(502, `Google calendar: ${r.status}`);
    const j = await r.json();
    return (j.calendars?.primary?.busy || []).map((b: any) => ({ start: b.start, end: b.end }));
  }
  const out: { start: string; end: string }[] = [];
  let next: string | null = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${from}&endDateTime=${to}&$select=start,end,showAs,isCancelled&$top=250`;
  for (let page = 0; next && page < 8; page++) {
    const r: Response = await d.fetch(next, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' } });
    if (!r.ok) throw new HttpError(502, `Outlook calendar: ${r.status}`);
    const j = await r.json();
    for (const e of j.value || []) {
      if (e.isCancelled || ["free", "workingElsewhere"].includes(e.showAs)) continue;
      const z = (s: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
      out.push({ start: new Date(z(e.start.dateTime)).toISOString(), end: new Date(z(e.end.dateTime)).toISOString() });
    }
    next = j["@odata.nextLink"] || null;
  }
  return out;
}

async function syncMany(accts: any[], d: Deps) {
  need(d.env, "CALENDAR_SECRET");
  let synced = 0; const errors: string[] = [];
  for (const a of accts) {
    try {
      const token = await accessToken(a, d);
      const busy = await fetchBusy(a, token!, d);
      await rest(d, `busy_blocks?user_id=eq.${a.user_id}&provider=eq.${a.provider}`, { method: "DELETE" });
      if (busy.length) await rest(d, "busy_blocks", { method: "POST", body: JSON.stringify(busy.map((b) => ({ workspace_id: a.workspace_id, user_id: a.user_id, provider: a.provider, start_at: b.start, end_at: b.end }))) });
      await rest(d, `calendar_accounts?id=eq.${a.id}`, { method: "PATCH", body: JSON.stringify({ last_sync_at: new Date(now(d)).toISOString(), last_error: null, status: "connected" }) });
      synced++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e), dead = (e as any).code === "invalid_grant";
      errors.push(`${a.provider}: ${msg}`);
      await rest(d, `calendar_accounts?id=eq.${a.id}`, { method: "PATCH", body: JSON.stringify({ last_error: msg.slice(0, 300), ...(dead ? { status: "needs_reconnect" } : {}) }) }).catch(() => {});
    }
  }
  return { synced, errors };
}

// ---------------------------------------------------------------- book a meeting
async function book(me: any, b: any, d: Deps) {
  const title = String(b.title || "").trim();
  const s = Date.parse(b.start), e = Date.parse(b.end);
  if (!title) throw new HttpError(400, "Add a title.");
  if (!s || !e || e <= s) throw new HttpError(400, "Pick a start and end time.");
  if (e - s > 12 * 36e5) throw new HttpError(400, "Meetings can be at most 12 hours.");
  const ids: string[] = [...new Set((b.attendee_ids || []).filter((x: string) => x && x !== me.id))] as string[];
  const people = ids.length ? await rest(d, `profiles?id=in.(${ids.join(",")})&workspace_id=eq.${me.workspace_id}&active=eq.true&select=id,email,display_name`) : [];
  if (people.length !== ids.length) throw new HttpError(400, "Invite people from your own team.");
  const guests = (b.guest_emails || []).map((x: string) => String(x).trim().toLowerCase()).filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 30);
  const emails = [...new Set([...people.map((p: any) => p.email).filter(Boolean), ...guests])];
  const accts = await rest(d, `calendar_accounts?user_id=eq.${me.id}&status=eq.connected&select=*`);
  const a = accts.find((x: any) => x.provider === b.provider) || accts[0];
  if (!a) throw new HttpError(400, "Connect your Google or Outlook calendar first (Scheduler → My calendars).");
  const token = await accessToken(a, d);
  const startIso = new Date(s).toISOString(), endIso = new Date(e).toISOString();
  let eventId = "", join = "";
  if (a.provider === "google") {
    const r = await d.fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ summary: title, description: b.description || "", start: { dateTime: startIso }, end: { dateTime: endIso },
        attendees: emails.map((email) => ({ email })),
        ...(b.video ? { conferenceData: { createRequest: { requestId: randomId(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(502, `Google calendar didn't accept the meeting: ${j.error?.message || r.status}`);
    eventId = j.id; join = j.hangoutLink || j.htmlLink || "";
  } else {
    const r = await d.fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: title, body: { contentType: "text", content: b.description || "" },
        start: { dateTime: startIso.replace("Z", ""), timeZone: "UTC" }, end: { dateTime: endIso.replace("Z", ""), timeZone: "UTC" },
        attendees: emails.map((address) => ({ emailAddress: { address }, type: "required" })),
        ...(b.video ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(502, `Outlook didn't accept the meeting: ${j.error?.message || r.status}`);
    eventId = j.id; join = j.onlineMeeting?.joinUrl || j.webLink || "";
  }
  const [m] = await rest(d, "meetings", { method: "POST", prefer: "return=representation", body: JSON.stringify({
    workspace_id: me.workspace_id, organizer_id: me.id, title, description: b.description || null, start_at: startIso, end_at: endIso,
    attendee_ids: ids, guest_emails: guests, provider: a.provider, provider_event_id: eventId, join_url: join || null }) });
  await syncMany([a], d);
  return { meeting: m, invited: emails.length };
}

async function disconnect(me: any, p: Provider, d: Deps) {
  const [a] = await rest(d, `calendar_accounts?user_id=eq.${me.id}&provider=eq.${p}&select=*`);
  if (!a) return { ok: true };
  if (p === "google" && d.env.CALENDAR_SECRET) {   // revoke Google's grant too; Microsoft grants are removed in the account's app settings
    const t = await unseal(a.refresh_token, d.env.CALENDAR_SECRET).catch(() => null);
    if (t) await d.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: "POST" }).catch(() => {});
  }
  await rest(d, `busy_blocks?user_id=eq.${me.id}&provider=eq.${p}`, { method: "DELETE" });
  await rest(d, `calendar_accounts?id=eq.${a.id}`, { method: "DELETE" });
  return { ok: true };
}

// Supabase Edge Functions ignore the port; on our own server (deploy/) PORT and HOST come from the service file.
if (import.meta.main) Deno.serve({ port: +(Deno.env.get("PORT") || 8000), hostname: Deno.env.get("HOST") || "0.0.0.0" }, (req) => handle(req, { fetch, env: Deno.env.toObject() }));
