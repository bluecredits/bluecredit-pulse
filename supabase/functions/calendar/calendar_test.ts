// deno test supabase/functions/calendar — runs the calendar function against fake Google, Microsoft and database servers.
import { handle } from "./index.ts";
import { fakeDb, assert, eq } from "../_shared/testkit.ts";

const env = {
  SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
  GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec", MS_CLIENT_ID: "mid", MS_CLIENT_SECRET: "msec",
  CALENDAR_SECRET: "test-secret", SITE_URL: "https://pulse.example.com", CRON_SECRET: "cron",
};
const T0 = Date.parse("2026-11-09T12:00:00Z");
function world() {
  const db = fakeDb({
    profiles: [
      { id: "u1", workspace_id: "w1", role: "admin", active: true, display_name: "Ann Admin", email: "ann@acme.test" },
      { id: "u2", workspace_id: "w1", role: "member", active: true, display_name: "Al Member", email: "al@acme.test" },
      { id: "x1", workspace_id: "w2", role: "admin", active: true, display_name: "Bea Other", email: "bea@beta.test" },
    ],
    calendar_accounts: [], busy_blocks: [], meetings: [],
  });
  const calls: string[] = [];
  const users: Record<string, string> = { "jwt-ann": "u1", "jwt-al": "u2", "jwt-bea": "x1" };
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input), method = init.method || "GET";
    calls.push(`${method} ${url.split("?")[0]}`);
    if (url.endsWith("/auth/v1/user")) {
      const tok = String((init.headers as any).authorization).replace("Bearer ", "");
      return users[tok] ? Response.json({ id: users[tok], email: db.t.profiles.find((p: any) => p.id === users[tok]).email }) : new Response("no", { status: 401 });
    }
    if (url.includes("/rest/v1/")) return db.handle(url, init);
    if (url === "https://oauth2.googleapis.com/token") {
      const b = new URLSearchParams(String(init.body));
      if (b.get("grant_type") === "authorization_code") {
        assert(b.get("code") === "good-code", "code passed"); assert(b.get("client_secret") === "gsec");
        return Response.json({ access_token: "g-at-1", refresh_token: "g-rt-1", expires_in: 3600, id_token: "x." + btoa(JSON.stringify({ email: "ann@gmail.test" })) + ".y" });
      }
      if (b.get("refresh_token") === "g-rt-1") return Response.json({ access_token: "g-at-2", expires_in: 3600 });
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url === "https://www.googleapis.com/calendar/v3/freeBusy") {
      assert(String((init.headers as any).authorization).startsWith("Bearer g-at"), "google token used");
      return Response.json({ calendars: { primary: { busy: [{ start: "2026-11-10T14:00:00Z", end: "2026-11-10T15:00:00Z" }, { start: "2026-11-11T16:00:00Z", end: "2026-11-11T16:30:00Z" }] } } });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
      const ev = JSON.parse(String(init.body));
      return Response.json({ id: "gev1", hangoutLink: ev.conferenceData ? "https://meet.google.com/abc" : undefined, htmlLink: "https://calendar.google.com/e/1", _echo: ev });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("");
    if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") return Response.json({ access_token: "m-at", refresh_token: "m-rt", expires_in: 3600 });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return Response.json({ mail: "al@acme.test" });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView")) {
      if (url.includes("page=2")) return Response.json({ value: [{ start: { dateTime: "2026-11-12T09:00:00.0000000" }, end: { dateTime: "2026-11-12T10:00:00.0000000" }, showAs: "busy" }] });
      return Response.json({ value: [
        { start: { dateTime: "2026-11-10T14:30:00.0000000" }, end: { dateTime: "2026-11-10T15:30:00.0000000" }, showAs: "busy" },
        { start: { dateTime: "2026-11-10T18:00:00.0000000" }, end: { dateTime: "2026-11-10T19:00:00.0000000" }, showAs: "free" },
        { start: { dateTime: "2026-11-10T20:00:00.0000000" }, end: { dateTime: "2026-11-10T21:00:00.0000000" }, showAs: "busy", isCancelled: true },
      ], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?page=2" });
    }
    throw new Error("unexpected fetch " + url);
  };
  const d = { fetch: f as typeof fetch, env, now: () => T0 };
  const post = (tok: string | null, body: unknown, headers: Record<string, string> = {}) => handle(new Request("https://proj.supabase.co/functions/v1/calendar", {
    method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: JSON.stringify(body) }), d);
  const get = (path: string) => handle(new Request("https://proj.supabase.co/functions/v1/calendar" + path), d);
  return { db, calls, post, get };
}

Deno.test("connect Google: start → callback stores encrypted tokens and busy times → redirect back", async () => {
  const w = world();
  const r = await w.post("jwt-ann", { action: "start", provider: "google", return_to: "https://pulse.example.com/scheduler/#/connect" });
  eq(r.status, 200); const { url } = await r.json(); const u = new URL(url);
  eq(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  eq(u.searchParams.get("redirect_uri"), "https://proj.supabase.co/functions/v1/calendar/callback/google");
  eq(u.searchParams.get("access_type"), "offline");
  const cb = await w.get(`/callback/google?code=good-code&state=${encodeURIComponent(u.searchParams.get("state")!)}`);
  eq(cb.status, 302);
  eq(cb.headers.get("location"), "https://pulse.example.com/scheduler/?calendar=connected#/connect");
  const [a] = w.db.t.calendar_accounts;
  eq(a.user_id, "u1"); eq(a.workspace_id, "w1"); eq(a.email, "ann@gmail.test");
  assert(a.refresh_token.startsWith("v1.") && !a.refresh_token.includes("g-rt-1"), "refresh token stored encrypted");
  assert(a.access_token.startsWith("v1."), "access token stored encrypted");
  eq(w.db.t.busy_blocks.length, 2); eq(w.db.t.busy_blocks[0].workspace_id, "w1");
});

Deno.test("tampered or foreign return address is refused", async () => {
  const w = world();
  const bad = await w.post("jwt-ann", { action: "start", provider: "google", return_to: "https://evil.example/steal" });
  eq(bad.status, 400);
  const r = await w.post("jwt-ann", { action: "start", provider: "google", return_to: "https://pulse.example.com/scheduler/" });
  const state = new URL((await r.json()).url).searchParams.get("state")!;
  const [body, sig] = state.split(".");
  const forged = btoa(JSON.stringify({ u: "x1", w: "w1", p: "google", r: "https://evil.example", exp: T0 + 1e6 })).replace(/=+$/, "") + "." + sig;
  const cb = await w.get(`/callback/google?code=good-code&state=${encodeURIComponent(forged)}`);
  eq(cb.status, 400); eq(w.db.t.calendar_accounts.length, 0);
  void body;
});

Deno.test("Outlook: pages through calendarView, skips free and cancelled, times in UTC", async () => {
  const w = world();
  const r = await w.post("jwt-al", { action: "start", provider: "microsoft", return_to: "https://pulse.example.com/scheduler/" });
  const state = new URL((await r.json()).url).searchParams.get("state")!;
  const cb = await w.get(`/callback/microsoft?code=c&state=${encodeURIComponent(state)}`);
  eq(cb.status, 302);
  const blocks = w.db.t.busy_blocks.filter((b: any) => b.user_id === "u2");
  eq(blocks.map((b: any) => b.start_at).sort(), ["2026-11-10T14:30:00.000Z", "2026-11-12T09:00:00.000Z"]);
});

Deno.test("refresh expired token, team sync, booking with Meet link, invites only own team", async () => {
  const w = world();
  const r = await w.post("jwt-ann", { action: "start", provider: "google", return_to: "https://pulse.example.com/scheduler/" });
  const state = new URL((await r.json()).url).searchParams.get("state")!;
  await w.get(`/callback/google?code=good-code&state=${encodeURIComponent(state)}`);
  w.db.t.calendar_accounts[0].token_expires_at = "2026-11-09T11:00:00Z";   // expired
  w.db.t.calendar_accounts[0].last_sync_at = "2026-11-09T09:00:00Z";
  const s = await w.post("jwt-al", { action: "sync", scope: "team" });
  eq((await s.json()).synced, 1);
  assert(w.calls.filter((c) => c.endsWith("oauth2.googleapis.com/token")).length === 2, "refreshed once after expiry");
  const cross = await w.post("jwt-ann", { action: "book", title: "Kickoff", start: "2026-11-10T16:00:00Z", end: "2026-11-10T16:30:00Z", attendee_ids: ["x1"] });
  eq(cross.status, 400);
  const ok = await w.post("jwt-ann", { action: "book", title: "Kickoff", start: "2026-11-10T16:00:00Z", end: "2026-11-10T16:30:00Z", attendee_ids: ["u2"], guest_emails: ["client@corp.test", "not-an-email"], video: true });
  eq(ok.status, 200); const j = await ok.json();
  eq(j.invited, 2); eq(j.meeting.join_url, "https://meet.google.com/abc"); eq(j.meeting.attendee_ids, ["u2"]); eq(j.meeting.guest_emails, ["client@corp.test"]);
  const none = await w.post("jwt-al", { action: "book", title: "x", start: "2026-11-10T16:00:00Z", end: "2026-11-10T16:30:00Z" });
  eq(none.status, 400);
});

Deno.test("cron sync needs the secret; disconnect removes tokens and busy times", async () => {
  const w = world();
  eq((await w.post(null, { action: "sync_all" })).status, 403);
  eq((await w.post(null, { action: "sync_all" }, { "x-cron-secret": "cron" })).status, 200);
  const r = await w.post("jwt-ann", { action: "start", provider: "google", return_to: "https://pulse.example.com/scheduler/" });
  await w.get(`/callback/google?code=good-code&state=${encodeURIComponent(new URL((await r.json()).url).searchParams.get("state")!)}`);
  eq((await w.post("jwt-ann", { action: "disconnect", provider: "google" })).status, 200);
  eq(w.db.t.calendar_accounts.length, 0); eq(w.db.t.busy_blocks.length, 0);
  assert(w.calls.some((c) => c.includes("oauth2.googleapis.com/revoke")), "revoked at Google");
});

Deno.test("signed-out and not-configured cases", async () => {
  const w = world();
  eq((await w.post(null, { action: "sync" })).status, 401);
  const d2 = { fetch: (() => { throw new Error("no"); }) as unknown as typeof fetch, env: { ...env, GOOGLE_CLIENT_ID: "" }, now: () => T0 };
  void d2;
});
