/* Pulse — landing page: signs people in, lets them start a company workspace or join one with its code,
   and lists the workspace's apps. Shared helpers come from core.js. */
"use strict";
window.onAuthLost = () => showAuth("signin");

const APPS = PULSE_APPS;
// Landing-page sections, in order. Every tile is the same size: icon, name, a two-line description, up to two numbers.
const GROUPS = [
  { key: "win", title: "Win work", note: "Pipeline, relationships and funding" },
  { key: "deliver", title: "Deliver work", note: "Projects, contracts and the people on them" },
  { key: "daily", title: "Every day", note: "Time, meetings, requests and your assistant" },
];

// Signing in always lands on this apps page. If someone was sent here from an app (?next=review#/contacts),
// offer a link back to where they were instead of jumping there.
function resumeLink() {
  const p = new URLSearchParams(location.search), app = myApps().find((a) => a.key === p.get("next"));
  const hash = /^#\//.test(location.hash) ? location.hash : "";
  history.replaceState(null, "", location.pathname);
  if (!app) return "";
  return `<div class="notice-bar">${icon("arrow-out")}<div>You were in <b>${esc(app.name)}</b>. <a href="${app.href + esc(hash)}">Continue where you left off</a></div></div>`;
}

async function Launcher(isNew = false) {
  const h = new Date().getHours();
  const admin = S.profile.role === "admin";
  $("#main").innerHTML = `
    ${isNew && admin ? welcome() : ""}
    <section class="hub-hero"><h1>${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${esc(firstName())}</h1>
      <p class="muted">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · Pick up where you left off.</p></section>
    ${resumeLink()}
    ${planBanner()}
    <div id="dueReminders"></div>
    ${appSections()}
    ${linkTiles()}
`;
  loadStats();
}
function appSections() {
  const mine = myApps();
  return GROUPS.map((g) => {
    const apps = mine.filter((a) => a.group === g.key);
    if (!apps.length) return "";
    return `<section class="hub-group"><h2 class="hub-h">${esc(g.title)} <span>${esc(g.note)}</span></h2>
      <div class="hub-apps">${apps.map(appTile).join("")}</div></section>`;
  }).join("");
}
function appTile(a) {
  const name = a.key === "chief" ? S.workspace?.config?.chief_name || a.name : a.name, locked = !hasApp(a.key), need = PLANS[appPlan(a.key)];
  return `<a class="hub-app ${locked ? "locked" : ""}" href="${a.href}" data-app="${a.key}" title="${esc(a.blurb)}">
    <div class="hub-ic ${a.key === "chief" ? "ai" : ""}">${icon(a.icon)}</div><div class="hub-body"><h3>${esc(name)}${locked ? ` <small class="plan-badge">${need.name}</small>` : ""}</h3><p>${esc(a.blurb)}</p>
    <div class="hub-stats" id="stats-${a.key}" ${locked ? `data-locked="1"><span class="hub-stat">Part of <b>${need.name}</b> · $${need.price}/user</span>` : `><span class="muted">Loading…</span>`}</div></div></a>`;
}
// trial and plan reminders for admins
function planBanner() {
  const b = S.billing; if (!b || S.profile.role !== "admin" || b.comped) return "";
  const paid = b.paid_until && new Date(b.paid_until) > new Date();
  if (!paid && b.trial_days_left > 0) return `<div class="notice-bar">${icon("clock")}<div><b>Pro trial: ${b.trial_days_left} day${b.trial_days_left === 1 ? "" : "s"} left.</b> Every Pro app is open until then. <a href="./admin/#/billing">Choose a plan</a></div></div>`;
  if (!paid && b.plan === "starter" && b.trial_ends_at) return `<div class="notice-bar">${icon("key")}<div>Your Pro trial has ended; you're on <b>Starter</b>. Opportunities, Projects, Agreements and Hiring are kept safe until you upgrade. <a href="./admin/#/billing">See plans</a></div></div>`;
  return "";
}
// Links an admin set in Workspace settings → Integrations (talent tool, AI chief of staff, …)
// First visit after creating a workspace: show the code to invite people
function welcome() {
  setTimeout(async () => { try { $("#welcomeCode").textContent = await db.rpc("get_company_code"); } catch { /* shown on Team page */ } }, 0);
  return `<section class="panel welcome"><h2>Your ${esc(S.workspace.name)} workspace is ready</h2>
    <p>Invite your team: send them this site and the company code below. They choose <b>Join with code</b>.</p>
    <div class="code-box"><b id="welcomeCode">…</b><button class="btn" id="copyWelcome">Copy</button></div>
    <p class="muted" style="margin-bottom:0">Next: add your logo and adjust your lists in <a href="./admin/#/settings">Workspace settings</a>, or import contacts in <a href="./contacts/">Contacts</a>.</p></section>`;
}
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#copyWelcome")) return;
  await navigator.clipboard.writeText($("#welcomeCode").textContent); toast("Code copied");
});
function linkTiles() {
  const links = (S.workspace?.config?.links || []).filter((l) => /^https:\/\//i.test(l.url || ""));
  if (!links.length) return "";
  return `<section class="hub-group"><h2 class="hub-h">Connected tools <span>Links your admin added</span></h2><div class="hub-apps hub-links">${links.map((l) => `
    <a class="hub-app" href="${esc(l.url)}" target="_blank" rel="noopener"><div class="hub-ic ${l.kind === "ai" ? "ai" : "ext"}">${icon(l.kind === "ai" ? "sparkles" : l.kind === "talent" ? "team" : "link")}</div>
      <div class="hub-body"><h3>${esc(l.label || "Link")} <svg class="ic ext-ic"><use href="#i-external"/></svg></h3><p>${esc(l.note || new URL(l.url).hostname)}</p></div></a>`).join("")}</div></section>`;
}
const myApps = () => APPS.filter((a) => (!a.staff || S.profile?.role !== "contractor") && CFG.apps?.[a.key] !== false);
function icon(name, cls = "ic") { return `<svg class="${cls}"><use href="#i-${name}"/></svg>`; }
async function loadStats() {
  loadAppStats();
  const stat = (n, label, href, alert, preset) => `<span class="hub-stat ${alert && n ? "alert" : ""}" ${href ? `data-href="${href}"` : ""} ${preset ? `data-preset="${preset}"` : ""}><b>${Number(n).toLocaleString()}</b> ${label}</span>`;
  if (S.profile.role === "contractor") return deskStats(stat);
  db.rpc("dashboard_data", { p_owner: firstName() }).then((d) => {
    const k = d.kpis;
    $("#stats-review").innerHTML = [stat(d.due_soon.length, `deadline${d.due_soon.length === 1 ? "" : "s"} in 14 days`, "./review/#/dashboard", false),
      stat(k.open_actions, "open actions", "./review/#/actions", k.overdue_actions), stat(k.active_opps, "active opportunities", "./review/#/opportunities")].join("");
    const fundDue = d.due_soon.filter((r) => r.entity === "funding").length;
    $("#stats-funding").innerHTML = [stat(k.active_funding, "active applications", "./funding/#/funding", false, "status=Identified|Pursuing|Submitted"),
      stat(fundDue, `funding deadline${fundDue === 1 ? "" : "s"} in 14 days`, "./funding/#/funding", true)].join("");
    $("#stats-contacts").innerHTML = stat(k.followups_due, "follow-ups due", "./contacts/#/contacts", true, "__followups") + ($("#stats-contacts").dataset.total || "");
  }).catch(() => ["review", "funding", "contacts"].forEach((k) => ($("#stats-" + k).innerHTML = "")));
  sb.from("contacts").select("id", { count: "exact" }).limit(1).then(({ count }) => {
    if (count == null) return;
    const el = $("#stats-contacts"), t = stat(count, "contacts", "");
    if (/follow-ups/.test(el.textContent)) el.insertAdjacentHTML("beforeend", t); else el.dataset.total = t;
  });
  deskStats(stat);
}
function deskStats(stat) {
  db.rpc("desk_counts", {}).then((c) => {
    $("#stats-tickets").innerHTML = [stat(c.approvals, "waiting for your approval", "./tickets/#/approvals", true),
      stat(c.my_open, "of your requests open", "./tickets/#/requests"), c.to_work ? stat(c.to_work, "to work on", "./tickets/#/requests") : "",
      stat(c.my_assets, "assets assigned to you", "./tickets/#/assets")].join("");
  }).catch(() => ($("#stats-tickets").innerHTML = S.profile.role === "admin" ? `<span class="hub-stat alert">One-time database update needed</span>` : `<span class="muted">Not set up yet</span>`));
}
// stats for the newer apps; each fills its own tile and stays quiet if its tables aren't there yet
const hstat = (n, label, href, alert) => `<span class="hub-stat ${alert && n ? "alert" : ""}" data-href="${href}"><b>${(+n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</b> ${label}</span>`;
const fill = (key, html) => { const el = $("#stats-" + key); if (el && !el.dataset.locked) el.innerHTML = html; };
function loadAppStats() {
  Promise.all([db.rpc("project_rollup", {}), db.rpc("my_tasks", {})]).then(([ps, mine]) => {
    const act = ps.filter((r) => r.status === "Active"), attn = act.filter((r) => r.health !== "On track").length, due = mine.filter((t) => t.due && new Date(t.due) - Date.now() < 3 * 864e5).length;
    fill("projects", hstat(act.length, "active projects", "./projects/") + (attn ? hstat(attn, "need attention", "./projects/", true) : "") + hstat(mine.length, "tasks assigned to you", "./projects/#/mytasks", due > 0));
  }).catch(() => fill("projects", ""));
  if (S.profile.role !== "contractor") Promise.all([db.rpc("fed_status", {}), db.rpc("fed_counts", {})]).then(([st, n]) => {
    const bs = n.by_source || {};
    fill("opportunities", (st.has_key || st.has_bidmatch ? hstat((bs["SAM.gov"] || 0) + (bs.BidMatch || 0), "new contracts and bids", "./opportunities/#/contracts", false) : `<span class="hub-stat alert" data-href="./opportunities/#/settings"><b>Add</b> your SAM.gov key</span>`)
      + hstat(bs["Grants.gov"] || 0, "new grants", "./opportunities/#/grants", false));
  }).catch(() => fill("opportunities", ""));
  sb.from("agreements").select("status, end_date").then(({ data, error }) => {
    if (error) return fill("agreements", "");
    const out = (data || []).filter((r) => r.status === "Out for signature").length, act = (data || []).filter((r) => r.status === "Active");
    const ending = act.filter((r) => r.end_date && (new Date(r.end_date) - Date.now()) / 864e5 <= 60).length, toClose = (data || []).filter((r) => ["Expired", "Terminated"].includes(r.status)).length;
    fill("agreements", hstat(out, "out for signature", "./agreements/#/list") + hstat(act.length, "active", "./agreements/#/list") + (ending ? hstat(ending, "ending in 60 days", "./agreements/#/list", true) : "") + (toClose ? hstat(toClose, "to close out", "./agreements/#/list", true) : ""));
  });
  if (CFG.apps?.chief !== false) sb.from("reminders").select("id, text, remind_at").eq("user_id", S.user.id).eq("done", false).order("remind_at").then(({ data, error }) => {
    if (error) return fill("chief", "");
    const due = (data || []).filter((r) => Date.parse(r.remind_at) < Date.now() + 36e5);
    fill("chief", hstat(due.length, "reminders due", "./chief/#/reminders", true) + `<span class="hub-stat" data-href="./chief/#/brief"><b>Today's</b> brief</span>`);
    if (due.length) $("#dueReminders").innerHTML = `<div class="notice-bar">${icon("clock")}<div><b>Reminder${due.length > 1 ? "s" : ""}:</b> ${due.slice(0, 3).map((r) => esc(r.text)).join(" · ")}${due.length > 3 ? ` · and ${due.length - 3} more` : ""} <a href="./chief/#/reminders">Open</a></div></div>`;
  });
  if (CFG.apps?.scheduler !== false) db.rpc("calendar_status", {}).then((st) => {
    const mine = (st || []).some((x) => x.user_id === S.user.id && x.status === "connected"), n = new Set((st || []).filter((x) => x.status === "connected").map((x) => x.user_id)).size;
    fill("scheduler", (mine ? "" : `<span class="hub-stat alert" data-href="./scheduler/#/connect"><b>Connect</b> your calendar</span>`) + hstat(n, `of ${S.team.filter((p) => p.active).length} calendars linked`, "./scheduler/"));
  }).catch(() => fill("scheduler", ""));
  Promise.all([sb.from("onboardings").select("status, checklist, user_id"), S.profile.role === "contractor" || !hasApp("hiring") ? Promise.resolve(null) : db.rpc("hire_summary", {}).catch(() => null)]).then(([{ data, error }, h]) => {
    if (error) return fill("people", "");
    if (S.profile.role === "contractor") {
      const mine = (data || []).filter((o) => o.user_id === S.user.id).flatMap((o) => o.checklist || []).filter((i) => i.who === "them");
      return fill("people", hstat(mine.filter((i) => !i.done).length, "of your checklist items left", "./people/#/mine", true));
    }
    const on = (data || []).filter((o) => ["Planned", "In progress"].includes(o.status)).length;
    fill("people", (h?.my_scorecards ? hstat(h.my_scorecards, "scorecards to fill", "./people/#/interviews", true) : "")
      + (h ? hstat(h.to_review, "candidates to review", "./people/#/candidates", h.to_review > 0) : "") + hstat(on, "being onboarded", "./people/#/people"));
  });
  const d = new Date(), wk = new Date(d); wk.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const w = wk.toLocaleDateString("en-CA");
  Promise.all([sb.from("time_entries").select("hours").eq("user_id", S.user.id).gte("work_date", w),
               sb.from("timesheets").select("user_id, status").eq("status", "Submitted")]).then(([a, b]) => {
    if (a.error) return fill("timecards", "");
    const h = (a.data || []).reduce((x, r) => x + +r.hours, 0), wait = (b.data || []).filter((t) => t.user_id !== S.user.id).length;
    fill("timecards", hstat(h, "hours this week", "./timecards/#/week") + (wait ? hstat(wait, "timesheets to approve", "./timecards/#/approvals", true) : ""));
  });
}
document.addEventListener("click", (e) => {
  const s = e.target.closest("[data-href]");
  if (!s) return;
  e.preventDefault();
  if (s.dataset.preset) sessionStorage.setItem("preset:" + s.dataset.href.split("#/")[1], s.dataset.preset);
  location.href = s.dataset.href;
});

/* ================================================================ auth */
let authMode = "signin";
// plans under the sign-in card
function renderPricing() {
  const el = $("#pricing"); if (!el || el.dataset.done) return; el.dataset.done = "1";
  const name = (k) => k === "hiring" ? "Hiring" : PULSE_APPS.find((a) => a.key === k)?.name || k;
  el.innerHTML = `<h2>Simple pricing</h2><p class="muted">Per staff user per month. Contractors and consultants are free. Pay yearly and get 2 months free.</p>
    <div class="price-grid">${PLAN_ORDER.map((k, i) => { const p = PLANS[k];
      return `<div class="price-card ${k === "pro" ? "best" : ""}">${k === "pro" ? `<span class="price-flag">Most popular</span>` : ""}<h3>${p.name}</h3>
        <p class="price"><b>$${p.price}</b> /user/month</p><p class="muted small">${esc(p.blurb)}</p>
        <ul>${i ? `<li><b>Everything in ${PLANS[PLAN_ORDER[i - 1]].name}</b></li>` : ""}${p.apps.map((a) => `<li>${esc(name(a))}</li>`).join("")}<li class="muted">${esc(p.limit)}</li></ul></div>`; }).join("")}</div>
    <p class="muted small">Every new workspace starts with 14 days of Pro. No card needed to start.</p>`;
}
// ── Landing page (signed out): apps, highlights, how it works, pricing, FAQ ──
function renderLanding() {
  const more = $("#landMore"); if (!more || more.dataset.done) return; more.dataset.done = "1";
  $$(".yr").forEach((e) => (e.textContent = new Date().getFullYear()));
  const badge = (k) => { const p = appPlan(k); return p === "starter" ? "" : `<small class="plan-badge">${PLANS[p].name}</small>`; };
  more.innerHTML = `
  <section class="land-sec" id="apps"><p class="land-kicker">Eleven apps, one sign-in, one price</p><h2>Everything a small company runs on</h2>
    <div class="land-groups">${GROUPS.map((g) => `<div class="land-group"><h3>${esc(g.title)}</h3><p class="muted small">${esc(g.note)}</p>
      <ul>${PULSE_APPS.filter((a) => a.group === g.key).map((a) => `<li><span class="hub-ic ${a.key === "chief" ? "ai" : ""}">${icon(a.icon)}</span><span><b>${esc(a.name)}</b>${badge(a.key)}<small>${esc(a.blurb)}</small></span></li>`).join("")}</ul></div>`).join("")}</div></section>
  <section class="land-sec land-feats"><p class="land-kicker">Why small firms switch to Pulse</p><h2>From first contact to finished work</h2>
    <div class="land-feat-grid">
      <div class="land-feat">${icon("users")}<h3>A simple CRM</h3><p>Contacts, follow-ups and a pipeline by stage. Import your spreadsheet in one step; duplicates are combined. Daily to quarterly reviews open with a live snapshot of what moved and what's due.</p></div>
      <div class="land-feat">${icon("gov")}<h3>New work, found for you</h3><p>Selling to government? Pulse checks SAM.gov, Grants.gov and your APEX bids every day against your NAICS codes and keywords, and saves the contracting officer to Contacts.</p></div>
      <div class="land-feat">${icon("clipboard")}<h3>From handshake to close-out</h3><p>Teaming agreements and NDAs signed online, projects with budget vs. actual from real timecards, and a close-out check before anything closes.</p></div>
      <div class="land-feat">${icon("user-plus")}<h3>Hiring without the spreadsheet</h3><p>A public apply link for each opening, a candidate board, interviews and blind scorecards. Hire, and onboarding starts on its own.</p></div>
      <div class="land-feat">${icon("team")}<h3>Contractors included, free</h3><p>Consultants and contractors join with their own code, log time to their projects and see only what they need. They don't count as paid users.</p></div>
      <div class="land-feat">${icon("key")}<h3>Your data stays yours</h3><p>Every company gets its own private workspace, enforced in the database on every record. Keys and links you paste are stored encrypted.</p></div>
    </div></section>
  <section class="land-sec" id="how"><p class="land-kicker">Up and running in an afternoon</p><h2>How it works</h2>
    <ol class="land-steps">
      <li><b>Start a workspace</b><span>Name your company and pick a starting setup. You get 14 days of Pro, no card needed.</span></li>
      <li><b>Bring in what you have</b><span>Import your contacts and lists from a spreadsheet. If you sell to government, add your NAICS codes and keywords and matching work shows up the next morning.</span></li>
      <li><b>Invite the team</b><span>Share the company code with staff and the contractor code with consultants. Everyone signs in once.</span></li>
    </ol></section>`;
  const faq = [
    ["Who counts as a user?", "Admins and members (your staff). Contractors and consultants are free."],
    ["What happens when the trial ends?", "Apps outside your plan show a lock until an admin chooses a plan. Nothing is deleted."],
    ["Is Pulse a CRM?", "It includes one: contacts, follow-ups and a pipeline. Pulse also runs what comes after the deal (projects, agreements, timecards, hiring), which a CRM alone doesn't."],
    ["Do I have to sell to government?", "No. Opportunities is there for firms that bid on public work; every other app works for any small company."],
    ["Can I bring my existing contacts and lists?", "Yes. Import a spreadsheet or CSV into Contacts and most lists; Pulse matches the columns and combines duplicates."],
    ["Can I pay by invoice?", "Yes. Pay by card in Plan and billing, or ask for an invoice."],
  ];
  $("#landFaq").innerHTML = `<section class="land-sec" id="faq"><h2>Questions</h2><div class="land-faq">${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>
    <p class="muted small" style="text-align:center;margin-top:16px">More in the <a href="./help/">Help Center</a>, or email <a href="mailto:support@bluecredits.org">support@bluecredits.org</a>.</p></section>
    <section class="land-final"><h2>Ready when you are</h2><p>Set up your workspace in a few minutes. Your first 14 days are on us.</p><button class="btn primary big" type="button" data-auth="create">Start your free trial</button></section>`;
}
const CARD_LEAD = { signin: "Welcome back. Sign in to your workspace.", join: "Joining your company? Use the code your admin sent you.", create: "14 days of Pro free. No card needed." };
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-auth]"); if (!b) return;
  showAuth(b.dataset.auth); $("#auth")?.scrollIntoView({ behavior: "smooth", block: "center" });
});
function showAuth(mode, notice = "") {
  renderPricing(); renderLanding();
  if ($("#cardLead")) { $("#cardLead").textContent = CARD_LEAD[mode] || ""; $("#cardLead").hidden = !CARD_LEAD[mode]; }
  authMode = mode;
  $("#shell").hidden = true; $("#topbar").hidden = true; $("#setup").hidden = true; $("#login").hidden = false;
  $("#authTabs").hidden = !["signin", "join", "create"].includes(mode);
  $$("#authTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  $$(".auth-form").forEach((f) => (f.hidden = f.dataset.mode !== mode));
  $("#authError").textContent = ""; $("#authNotice").textContent = notice;
  setTimeout(() => $(`.auth-form[data-mode="${mode}"] input`)?.focus({ preventScroll: true }), 30);
}
$$("#authTabs button").forEach((b) => b.addEventListener("click", () => showAuth(b.dataset.mode)));
$$("[data-goto]").forEach((b) => b.addEventListener("click", () => showAuth(b.dataset.goto)));
$$(".pack-select").forEach((sel) => (sel.innerHTML = Object.entries(window.PULSE_PACKS).map(([k, p]) =>
  `<option value="${k}">${esc(p.label)} — ${esc(p.blurb)}</option>`).join("")));

$("#createForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  const company = f.get("company").trim(), name = f.get("name").trim(), template = f.get("template");
  try {
    const { data, error } = await sb.auth.signUp({ email: f.get("email").trim(), password: f.get("password"),
      options: { data: { display_name: name, intent: "create", company, template }, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    if (!data.session) { showAuth("signin", "Check your email and click the confirmation link, then sign in here. Your workspace is created when you first sign in."); return; }
    await db.rpc("create_workspace", { p_company: company, p_name: name, p_template: template });
    await afterSignIn(true);
  } catch (err) { authErr(err); } finally { busy(e.target, false); }
});
$("#finishCreateForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  try { await db.rpc("create_workspace", { p_company: f.get("company").trim(), p_name: f.get("name").trim(), p_template: f.get("template") }); await afterSignIn(true); }
  catch (err) { authErr(err); } finally { busy(e.target, false); }
});
const authErr = (e) => { $("#authNotice").textContent = ""; $("#authError").textContent = e.message || String(e); };
const busy = (form, on) => $$("button", form).forEach((b) => (b.disabled = on));

$("#signinForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  try {
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    if (error) throw new Error(/confirm/i.test(error.message) ? "Confirm your email first — check your inbox for the link." : "Wrong email or password.");
    await afterSignIn();
  } catch (err) { authErr(err); } finally { busy(e.target, false); }
});

$("#joinForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  const code = f.get("code").trim(), name = f.get("name").trim();
  try {
    const { data, error } = await sb.auth.signUp({ email: f.get("email").trim(), password: f.get("password"),
      options: { data: { display_name: name, company_code: code }, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    if (!data.session) { showAuth("signin", "Check your email and click the confirmation link, then sign in here. You won't need the code again."); return; }
    await db.rpc("join_company", { p_code: code, p_name: name });
    await afterSignIn();
  } catch (err) { authErr(err); } finally { busy(e.target, false); }
});

$("#finishForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  try { await db.rpc("join_company", { p_code: f.get("code").trim(), p_name: f.get("name").trim() }); await afterSignIn(); }
  catch (err) { authErr(err); } finally { busy(e.target, false); }
});

$("#forgotBtn").addEventListener("click", async () => {
  const email = $("#signinForm [name=email]").value.trim();
  if (!email) { authErr(new Error("Enter your email above, then click “Forgot password?” again.")); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) return authErr(error);
  $("#authError").textContent = ""; $("#authNotice").textContent = "If that email has an account, a reset link is on its way.";
});

$("#resetForm").addEventListener("submit", async (e) => {
  e.preventDefault(); busy(e.target, true);
  try { const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get("password") }); if (error) throw error; toast("Password updated"); await afterSignIn(); }
  catch (err) { authErr(err); } finally { busy(e.target, false); }
});


async function afterSignIn(isNew = false) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showAuth("signin");
  S.user = user;
  let prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  const meta = user.user_metadata || {};
  if (!prof) {  // confirmed their email after signing up: finish what they started (create or join)
    const nm = meta.display_name || user.email.split("@")[0];
    try {
      if (meta.intent === "create" && meta.company) { await db.rpc("create_workspace", { p_company: meta.company, p_name: nm, p_template: meta.template || "general" }); isNew = true; }
      else if (meta.company_code) await db.rpc("join_company", { p_code: meta.company_code, p_name: nm });
    } catch (err) { showAuth(meta.intent === "create" ? "finishcreate" : "finish"); authErr(err); return; }
    prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  }
  if (!prof) {
    const mode = meta.intent === "create" ? "finishcreate" : "finish";
    showAuth(mode);
    $$(`.auth-form[data-mode="${mode}"] [name=name]`).forEach((i) => (i.value = meta.display_name || ""));
    if (meta.company) $$(`#finishCreateForm [name=company]`).forEach((i) => (i.value = meta.company));
    return;
  }
  if (!prof.active) { await sb.auth.signOut(); showAuth("signin"); authErr(new Error("This account is turned off. Ask an admin to turn it back on.")); return; }
  S.profile = prof;
  await loadWorkspace();
  S.team = must(await sb.from("profiles").select("*").order("display_name"));
  $("#login").hidden = true; $("#setup").hidden = true;
  showShell();
  Launcher(isNew);
}

async function boot() {
  // old Business Review links (bluecredit-pulse/#/contacts) moved to /review/
  if (/^#\/[a-z]/.test(location.hash) && !location.search) { location.replace("./review/" + location.hash); return; }
  if (!sb) { $("#setup").hidden = false; return; }
  sb.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") showAuth("reset"); });
  if (/type=recovery/.test(location.hash)) return;
  const { data: { session } } = await sb.auth.getSession();
  if (session && new URLSearchParams(location.search).get("reset")) { history.replaceState(null, "", location.pathname); showAuth("reset"); return; }
  if (session) afterSignIn().catch((e) => { showAuth("signin"); authErr(e); });
  else showAuth("signin", new URLSearchParams(location.search).get("next") ? "Sign in to continue." : "");
}
boot();
