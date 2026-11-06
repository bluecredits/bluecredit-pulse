/* Pulse — landing page: signs people in, lets them start a company workspace or join one with its code,
   and lists the workspace's apps. Shared helpers come from core.js. */
"use strict";
window.onAuthLost = () => showAuth("signin");

const APPS = [
  { key: "review", staff: true, name: "Business Review", icon: "chart", href: "./review/", blurb: "Opportunities, action items, and daily to quarterly business reviews." },
  { key: "contacts", staff: true, name: "Contacts", icon: "users", href: "./contacts/", blurb: "Customers, investors, partners and the mailing list; import and follow up." },
  { key: "funding", staff: true, name: "Funding", icon: "banknotes", href: "./funding/", blurb: "Grant and loan applications in progress, plus the catalog of funding programs." },
  { key: "timecards", name: "Timecards", icon: "timer", href: "./timecards/", blurb: "Log hours by project each week; approve timesheets; hours and amounts by project." },
  { key: "onboarding", name: "Onboarding", icon: "user-plus", href: "./onboarding/", blurb: "Bring on contractors, consultants and new hires with a checklist; offboard them cleanly." },
  { key: "projects", name: "Projects", icon: "briefcase", href: "./projects/", blurb: "Run funded work: schedule, task board, team, budget vs. actual, status reports, close-out." },
  { key: "agreements", name: "Agreements", icon: "clipboard", href: "./agreements/", blurb: "Teaming, consulting and confidentiality agreements: fill in, e-sign, amend and close out." },
  { key: "scheduler", name: "Scheduler", icon: "calendar", href: "./scheduler/", blurb: "Everyone's Google or Outlook free/busy in one view; find a time and send the invites." },
  { key: "chief", name: "Chief of Staff", icon: "sparkles", href: "./chief/", blurb: "Your AI chief of staff: a prioritized brief each morning, answers about your work, reminders." },
  { key: "tickets", name: "Tickets", icon: "ticket", href: "./tickets/", blurb: "Ask for equipment, purchases, time off or IT help; approve requests; see your assets." },
];

// ?next=review#/contacts → back to where someone was when they had to sign in
function goNext() {
  const p = new URLSearchParams(location.search), next = p.get("next");
  const app = myApps().find((a) => a.key === next);
  if (!app) return false;
  location.replace(app.href + (/^#\//.test(location.hash) ? location.hash : ""));
  return true;
}

async function Launcher(isNew = false) {
  const h = new Date().getHours();
  const admin = S.profile.role === "admin";
  $("#main").innerHTML = `
    ${isNew && admin ? welcome() : ""}
    <section class="hub-hero"><h1>${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${esc(firstName())}</h1>
      <p class="muted">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · Pick up where you left off.</p></section>
    <h2 class="hub-h">Workspace apps</h2>
    <div id="dueReminders"></div>
    <div class="hub-apps">${myApps().map((a) => `<a class="hub-app" href="${a.href}" data-app="${a.key}">
        <div class="hub-ic ${a.key === "chief" ? "ai" : ""}">${icon(a.icon)}</div><div class="hub-body"><h3>${esc(a.key === "chief" ? S.workspace?.config?.chief_name || a.name : a.name)}</h3><p>${esc(a.blurb)}</p>
        <div class="hub-stats" id="stats-${a.key}"><span class="muted">Loading…</span></div></div></a>`).join("")}</div>
    ${linkTiles()}
    ${admin ? `<p class="hub-admin"><a href="./admin/">Team and workspace settings</a> · People join from this page with the company code.</p>` : ""}`;
  loadStats();
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
  return `<h2 class="hub-h">Connected tools</h2><div class="hub-apps hub-links">${links.map((l) => `
    <a class="hub-app" href="${esc(l.url)}" target="_blank" rel="noopener"><div class="hub-ic ${l.kind === "ai" ? "ai" : "ext"}">${icon(l.kind === "ai" ? "sparkles" : l.kind === "talent" ? "team" : "link")}</div>
      <div class="hub-body"><h3>${esc(l.label || "Link")} <svg class="ic ext-ic"><use href="#i-external"/></svg></h3><p>${esc(l.note || new URL(l.url).hostname)}</p></div></a>`).join("")}</div>`;
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
const fill = (key, html) => { const el = $("#stats-" + key); if (el) el.innerHTML = html; };
function loadAppStats() {
  Promise.all([db.rpc("project_rollup", {}), db.rpc("my_tasks", {})]).then(([ps, mine]) => {
    const act = ps.filter((r) => r.status === "Active"), attn = act.filter((r) => r.health !== "On track").length, due = mine.filter((t) => t.due && new Date(t.due) - Date.now() < 3 * 864e5).length;
    fill("projects", hstat(act.length, "active projects", "./projects/") + (attn ? hstat(attn, "need attention", "./projects/", true) : "") + hstat(mine.length, "tasks assigned to you", "./projects/#/mytasks", due > 0));
  }).catch(() => fill("projects", ""));
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
  sb.from("onboardings").select("status, checklist, user_id").then(({ data, error }) => {
    if (error) return fill("onboarding", "");
    if (S.profile.role === "contractor") {
      const mine = (data || []).filter((o) => o.user_id === S.user.id).flatMap((o) => o.checklist || []).filter((i) => i.who === "them");
      return fill("onboarding", hstat(mine.filter((i) => !i.done).length, "of your checklist items left", "./onboarding/#/mine", true));
    }
    const on = (data || []).filter((o) => ["Planned", "In progress"].includes(o.status)).length, off = (data || []).filter((o) => o.status === "Offboarding").length;
    fill("onboarding", hstat(on, "being onboarded", "./onboarding/") + (off ? hstat(off, "offboarding", "./onboarding/", true) : ""));
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
function showAuth(mode, notice = "") {
  authMode = mode;
  $("#shell").hidden = true; $("#topbar").hidden = true; $("#setup").hidden = true; $("#login").hidden = false;
  $("#authTabs").hidden = !["signin", "join", "create"].includes(mode);
  $$("#authTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  $$(".auth-form").forEach((f) => (f.hidden = f.dataset.mode !== mode));
  $("#authError").textContent = ""; $("#authNotice").textContent = notice;
  setTimeout(() => $(`.auth-form[data-mode="${mode}"] input`)?.focus(), 30);
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
  if (goNext()) return;
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
  if (session) afterSignIn().catch((e) => { showAuth("signin"); authErr(e); });
  else showAuth("signin", new URLSearchParams(location.search).get("next") ? "Sign in to continue." : "");
}
boot();
