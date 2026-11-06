/* Pulse · Scheduler — team free/busy from everyone's Google or Outlook calendar, find a time, book it.
   Busy times come from the calendar server function (supabase/functions/calendar), which keeps tokens on the
   server; the browser only ever sees start and end times, never meeting titles. */
"use strict";

const SC = { start: null, days: 7, pick: new Set(), minutes: 30, title: "", by: null, status: [] };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY_FROM = 8, DAY_TO = 18;   // the hours drawn on the team calendar (viewer's time zone)
const WORK_FROM = 9, WORK_TO = 17; // hours "Find a time" looks in
const fmtTime = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const fmtDay = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const people = () => S.team.filter((p) => p.active);
const list = (v) => Array.isArray(v) ? v : String(v || "").replace(/^\{|\}$/g, "").split(",").filter(Boolean);
const nameOf = (id) => S.team.find((p) => p.id === id)?.display_name || "";
const connected = (uid) => SC.status.some((s) => s.user_id === uid && s.status === "connected");
function fnProblem(e) {
  return e.setup ? `<section class="panel"><h2>Calendar connections aren't switched on yet</h2>
    <p>${S.profile.role === "admin" ? "The calendar server function needs to be deployed with Google and Microsoft app keys. See <b>deploy/DEPLOY_CONTABO.md</b> in the repo (or hand it to your developer)." : "Ask an admin to finish setting up calendar connections."}</p>
    <p class="muted">${esc(e.message)}</p></section>` : `<div class="empty">${esc(e.message)}</div>`;
}

async function loadBusy(from, to, ids) {
  SC.status = await db.rpc("calendar_status", {});
  let q = sb.from("busy_blocks").select("user_id, start_at, end_at").lt("start_at", to.toISOString()).gt("end_at", from.toISOString());
  if (ids) q = q.in("user_id", ids);
  return must(await q);
}
// background refresh of anyone not synced lately; redraws when done
function refreshTeam(redraw) {
  if (SC.refreshing || !SC.status.length) return;
  SC.refreshing = true;
  callFn("calendar", { action: "sync", scope: "team" }).then((r) => { if (r.synced) redraw(); }).catch(() => {}).finally(() => (SC.refreshing = false));
}

/* ================================================================ Team calendar */
async function Week() {
  SC.start ||= startOfDay(new Date());
  const from = SC.start, to = addD(from, SC.days);
  const busy = await loadBusy(from, to);
  const meetings = must(await sb.from("meetings").select("*").eq("status", "Booked").gte("start_at", from.toISOString()).lt("start_at", to.toISOString()).order("start_at"));
  const days = [...Array(SC.days)].map((_, i) => addD(from, i)).filter((d) => SC.weekends || ![0, 6].includes(d.getDay()));
  const span = (DAY_TO - DAY_FROM) * 60;
  const strip = (uid, day) => {
    const d0 = new Date(day); d0.setHours(DAY_FROM, 0, 0, 0); const d1 = new Date(day); d1.setHours(DAY_TO, 0, 0, 0);
    const blocks = busy.filter((b) => b.user_id === uid && new Date(b.end_at) > d0 && new Date(b.start_at) < d1).map((b) => {
      const s = Math.max(0, (new Date(b.start_at) - d0) / 6e4), e = Math.min(span, (new Date(b.end_at) - d0) / 6e4);
      return `<i style="left:${(100 * s / span).toFixed(2)}%;width:${Math.max(1, 100 * (e - s) / span).toFixed(2)}%" title="Busy ${fmtTime(new Date(b.start_at))}–${fmtTime(new Date(b.end_at))}"></i>`;
    }).join("");
    return `<div class="fb-strip ${connected(uid) ? "" : "unknown"}">${blocks}</div>`;
  };
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Team calendar</h1><p class="muted">Busy times from everyone's connected calendar, ${DAY_FROM > 12 ? DAY_FROM - 12 + "pm" : DAY_FROM + "am"}–${DAY_TO - 12}pm your time (${esc(TZ)}). Titles stay private.</p></div>
      <div class="actions-row week-nav"><button class="btn small" id="prev" aria-label="Earlier">${icon("chevron-left")}</button>
        <b class="week-label">${fmtDay(from)} – ${fmtDay(addD(to, -1))}</b><button class="btn small" id="next" aria-label="Later">${icon("chevron-right")}</button>
        <button class="btn small" id="today">Today</button><label class="check small"><input type="checkbox" id="wkend" ${SC.weekends ? "checked" : ""}> Weekends</label>
        <a class="btn primary" href="#/find">${icon("clock")}Find a time</a></div></div>
    ${connected(S.user.id) ? "" : `<div class="notice-bar">${icon("link")}<div>Connect your calendar so teammates can see when you're free. <a href="#/connect">Connect Google or Outlook</a></div></div>`}
    <section class="panel" style="padding:0"><div class="table-wrap"><table class="fb-grid">
      <thead><tr><th>Person</th>${days.map((d) => `<th class="${startOfDay(d).getTime() === startOfDay(new Date()).getTime() ? "today" : ""}">${fmtDay(d)}<div class="fb-ticks">${[DAY_FROM, 12, DAY_TO - 2].map((h) => `<span style="left:${100 * (h - DAY_FROM) / (DAY_TO - DAY_FROM)}%">${h > 12 ? h - 12 : h}${h >= 12 ? "p" : "a"}</span>`).join("")}</div></th>`).join("")}</tr></thead>
      <tbody>${people().map((p) => `<tr style="cursor:default"><td class="fb-who"><b>${esc(p.display_name)}</b>${connected(p.id) ? "" : `<small class="muted">no calendar linked</small>`}</td>
        ${days.map((d) => `<td>${strip(p.id, d)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>
    <h2 class="hub-h">Meetings booked in Pulse</h2>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>When</th><th>Meeting</th><th>Organizer</th><th>With</th><th></th></tr></thead><tbody>
      ${meetings.map((m) => `<tr style="cursor:default"><td class="date">${fmtDay(new Date(m.start_at))} ${fmtTime(new Date(m.start_at))}–${fmtTime(new Date(m.end_at))}</td><td><b>${esc(m.title)}</b></td>
        <td>${esc(nameOf(m.organizer_id))}</td><td>${esc([...list(m.attendee_ids).map(nameOf), ...list(m.guest_emails)].filter(Boolean).join(", "))}</td>
        <td>${m.join_url ? `<a class="btn small" href="${esc(m.join_url)}" target="_blank" rel="noopener">${icon("video")}Join</a>` : ""}</td></tr>`).join("")
        || `<tr><td colspan="5" class="empty">No meetings booked through Pulse this week.</td></tr>`}</tbody></table></div></section>`;
  $("#prev").addEventListener("click", () => { SC.start = addD(SC.start, -7); Week(); });
  $("#next").addEventListener("click", () => { SC.start = addD(SC.start, 7); Week(); });
  $("#today").addEventListener("click", () => { SC.start = startOfDay(new Date()); Week(); });
  $("#wkend").addEventListener("change", (e) => { SC.weekends = e.target.checked; Week(); });
  refreshTeam(Week);
}

/* ================================================================ Find a time */
function freeSlots(busy, ids, minutes, from, days) {
  const out = [], step = 15 * 6e4, len = minutes * 6e4, nowT = Date.now() + 15 * 6e4;
  for (let i = 0; i < days && out.length < 60; i++) {
    const day = addD(from, i); if ([0, 6].includes(day.getDay())) continue;
    const a = new Date(day); a.setHours(WORK_FROM, 0, 0, 0); const z = new Date(day); z.setHours(WORK_TO, 0, 0, 0);
    for (let t = a.getTime(); t + len <= z.getTime(); t += step) {
      if (t < nowT) continue;
      const clash = busy.some((b) => ids.includes(b.user_id) && Date.parse(b.start_at) < t + len && Date.parse(b.end_at) > t);
      if (!clash) { out.push(new Date(t)); t += len - step; }   // next option starts after this one
    }
  }
  return out;
}
async function Find(params) {
  const p = new URLSearchParams(params || "");
  if (p.get("with")) { const names = p.get("with").toLowerCase().split(","); people().forEach((m) => names.includes(m.display_name.split(" ")[0].toLowerCase()) && SC.pick.add(m.id)); }
  if (p.get("minutes")) SC.minutes = +p.get("minutes") || 30;
  if (p.get("title")) SC.title = p.get("title");
  SC.pick.add(S.user.id);
  const from = startOfDay(new Date()), horizon = 10;
  const ids = [...SC.pick];
  const busy = await loadBusy(from, addD(from, horizon + 1), ids);
  const slots = freeSlots(busy, ids, SC.minutes, from, horizon);
  const missing = ids.filter((id) => !connected(id));
  const byDay = {};
  slots.forEach((s) => (byDay[fmtDay(s)] ||= []).push(s));
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Find a time</h1><p class="muted">Open slots for everyone picked, weekdays ${WORK_FROM}am–${WORK_TO - 12}pm your time, over the next two weeks.</p></div></div>
    <section class="panel"><div class="form-grid">
      <label>Title<input id="fTitle" value="${esc(SC.title)}" placeholder="e.g. Proposal kickoff"></label>
      <label>Length<select id="fLen">${[15, 30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${m === SC.minutes ? "selected" : ""}>${m < 60 ? m + " minutes" : m / 60 + " hour" + (m > 60 ? "s" : "")}</option>`).join("")}</select></label></div>
      <h3 class="ck-h">Who</h3><div class="chips">${people().map((m) => `<label class="chip-check"><input type="checkbox" data-who="${m.id}" ${SC.pick.has(m.id) ? "checked" : ""} ${m.id === S.user.id ? "disabled" : ""}> ${esc(m.display_name)}${m.id === S.user.id ? " (you)" : ""}${connected(m.id) ? "" : ' <span class="muted">· no calendar</span>'}</label>`).join("")}</div></section>
    ${missing.length ? `<div class="notice-bar">${icon("alert")}<div>${missing.map((id) => esc(nameOf(id))).join(", ")} ${missing.length === 1 ? "hasn't" : "haven't"} connected a calendar, so their busy times aren't counted.${missing.includes(S.user.id) ? ` <a href="#/connect">Connect yours</a>.` : ""}</div></div>` : ""}
    <div class="slot-days">${Object.entries(byDay).map(([d, list]) => `<section class="panel slot-day"><h3>${d}</h3><div class="slots">${list.map((s) =>
      `<button class="slot" data-slot="${s.toISOString()}">${fmtTime(s)}</button>`).join("")}</div></section>`).join("") || `<div class="empty">No time works for everyone in the next two weeks. Try fewer people or a shorter meeting.</div>`}</div>`;
  $$("[data-who]").forEach((c) => c.addEventListener("change", () => { c.checked ? SC.pick.add(c.dataset.who) : SC.pick.delete(c.dataset.who); SC.title = $("#fTitle").value; Find(); }));
  $("#fLen").addEventListener("change", (e) => { SC.minutes = +e.target.value; SC.title = $("#fTitle").value; Find(); });
  $("#fTitle").addEventListener("input", (e) => (SC.title = e.target.value));
  $$("[data-slot]").forEach((b) => b.addEventListener("click", () => bookForm(new Date(b.dataset.slot))));
}
function bookForm(start) {
  const end = new Date(start.getTime() + SC.minutes * 6e4), ids = [...SC.pick].filter((id) => id !== S.user.id);
  $("#drawerTitle").textContent = "Book meeting";
  $("#drawerBody").innerHTML = `<form id="bookForm" class="form-grid">
    <p style="grid-column:1/-1"><b>${fmtDay(start)}, ${fmtTime(start)}–${fmtTime(end)}</b> <span class="muted">(${esc(TZ)})</span><br>
      With: ${ids.length ? ids.map((id) => esc(nameOf(id))).join(", ") : "just you"}</p>
    <label style="grid-column:1/-1">Title<input name="title" required value="${esc(SC.title)}"></label>
    <label style="grid-column:1/-1">Guests outside the team <small class="muted">(emails, comma-separated)</small><input name="guests" placeholder="client@example.com"></label>
    <label style="grid-column:1/-1">Agenda<textarea name="description" rows="3"></textarea></label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="video" checked> Add a video link (Google Meet or Teams)</label>
    <p class="muted" style="grid-column:1/-1">It goes on your calendar and everyone gets an invite from it.</p>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">${icon("calendar")}Book and send invites</button></div></form>`;
  openDrawer();
  $("#bookForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target); const btn = $("button.primary", e.target); btn.disabled = true;
    try {
      const r = await callFn("calendar", { action: "book", title: f.get("title"), description: f.get("description"), start: start.toISOString(), end: end.toISOString(),
        attendee_ids: ids, guest_emails: String(f.get("guests") || "").split(/[,\s;]+/).filter(Boolean), video: !!f.get("video") });
      toast(`Booked. ${r.invited} invite${r.invited === 1 ? "" : "s"} sent`); closeDrawer(); location.hash = "#/week";
    } catch (err) { btn.disabled = false; toast(err.message); }
  });
}

/* ================================================================ My calendars */
async function Connect() {
  const mine = must(await sb.from("calendar_accounts").select("id, provider, email, status, last_sync_at, last_error").eq("user_id", S.user.id));
  const has = (p) => mine.find((a) => a.provider === p);
  const card = (p, label, blurb) => { const a = has(p); return `<section class="panel cal-card"><header>${icon("calendar")}<div><h3>${label}</h3><p class="muted">${blurb}</p></div></header>
    ${a ? `<p>${a.status === "connected" ? pill("Active").replace("Active", "Connected") : pill("Rejected").replace("Rejected", "Reconnect needed")} ${esc(a.email || "")}</p>
      <p class="muted small">${a.last_sync_at ? "Updated " + ago(a.last_sync_at) : "Not synced yet"}${a.last_error ? " · " + esc(a.last_error) : ""}</p>
      <div class="actions-row"><button class="btn small" data-sync>Refresh now</button>${a.status !== "connected" ? `<button class="btn small primary" data-connect="${p}">Reconnect</button>` : ""}<button class="btn small danger" data-disc="${p}">Disconnect</button></div>`
      : `<button class="btn primary" data-connect="${p}">Connect ${label}</button>`}</section>`; };
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>My calendars</h1><p class="muted">Connect once. Pulse reads only when you're busy (never titles or details) so teammates can find a time, and adds meetings you book here.</p></div></div>
    <div class="appr-grid">${card("google", "Google Calendar", "Gmail or Google Workspace accounts.")}${card("microsoft", "Outlook / Microsoft 365", "Outlook.com, Hotmail or work Microsoft 365 accounts.")}</div>
    <p class="muted small">You can disconnect at any time; Pulse then deletes your saved busy times and its access to the calendar.</p>`;
  $$("[data-connect]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { const r = await callFn("calendar", { action: "start", provider: b.dataset.connect, return_to: location.origin + location.pathname + "#/connect" }); location.href = r.url; }
    catch (e) { b.disabled = false; if (e.setup) $("#main").insertAdjacentHTML("afterbegin", fnProblem(e)); else toast(e.message); }
  }));
  $$("[data-sync]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; try { const r = await callFn("calendar", { action: "sync", scope: "me" }); toast(r.errors?.length ? r.errors[0] : "Calendar refreshed"); Connect(); } catch (e) { b.disabled = false; toast(e.message); }
  }));
  $$("[data-disc]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Disconnect this calendar? Teammates won't see your busy times any more.")) return;
    try { await callFn("calendar", { action: "disconnect", provider: b.dataset.disc }); toast("Disconnected"); Connect(); } catch (e) { toast(e.message); }
  }));
}

/* ================================================================ router */
const routes = { week: Week, find: Find, connect: Connect };
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const key = routes[path] ? path : "week";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve(routes[key](query)).catch((e) => ($("#main").innerHTML = /busy_blocks|calendar_|meetings|schema cache|does not exist/i.test(e.message)
    ? `<section class="panel"><h2>One-time setup needed</h2><p>The Scheduler needs the latest database update.</p></section>` : fnProblem(e)));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try {
    if (!(await requireMember())) return;
    const p = new URLSearchParams(location.search);
    if (p.get("calendar") === "connected") toast("Calendar connected");
    if (p.get("calendar_error")) setTimeout(() => toast(p.get("calendar_error")), 300);
    if (p.has("calendar") || p.has("calendar_error")) history.replaceState(null, "", location.pathname + location.hash);
    showShell(); route();
  } catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
