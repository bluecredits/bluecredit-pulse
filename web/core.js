/* Pulse — shared core for every app (landing page, Business Review, Contacts, Funding, Tickets, Admin).
   One Supabase project and one set of accounts: signing in on the landing page signs you in everywhere,
   because all apps live on the same site. No build step. */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CFG = window.PULSE_CONFIG || {};
const S = { user: null, profile: null, team: [], workspace: null };
const today = () => new Date().toLocaleDateString("en-CA");
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const daysUntil = (iso) => Math.round((new Date(iso + "T12:00:00") - new Date(today() + "T12:00:00")) / 864e5);
const money = (n) => n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const short = (iso) => iso ? new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: String(iso).slice(0, 4) === today().slice(0, 4) ? undefined : "numeric" }) : "";
const ago = (ts) => { const m = Math.round((Date.now() - new Date(ts)) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const firstName = () => (S.profile?.display_name || "").split(" ")[0];
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600); }

const sb = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

function must({ data, error, count }) {
  if (error) {
    if (/JWT|not authenticated|401/i.test(error.message)) authLost();
    throw new Error(error.message || "Something went wrong");
  }
  return count === undefined || count === null ? data : { data, count };
}
const db = { async rpc(fn, args) { return must(await sb.rpc(fn, args)); } };
// Server functions (calendar, chief). Where they run is set in config.js (functionsUrl); default: Supabase Edge Functions.
const FN_URL = () => (CFG.functionsUrl || (CFG.supabaseUrl || "").replace(/\/$/, "") + "/functions/v1").replace(/\/$/, "");
async function callFn(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { authLost(); throw new Error("Sign in first."); }
  let r;
  try {
    r = await fetch(`${FN_URL()}/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}`, apikey: CFG.supabaseAnonKey }, body: JSON.stringify(body) });
  } catch { throw Object.assign(new Error("Couldn't reach the server. It may not be set up yet."), { setup: true }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `The server answered ${r.status}.`), { status: r.status, setup: r.status === 404 || r.status === 503 });
  return j;
}
// tiny, safe markdown for assistant answers: headings, lists, bold, italics, code and https links
function md(src) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(src || "").split("\n")) {
    let m;
    if ((m = line.match(/^#{1,3}\s+(.*)/))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close(); return out.join("");
}

// Longer documents (policies): headings, lists, tables, quotes and rules from Markdown. Everything is escaped first.
function mdDoc(src) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<i>$2</i>").replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/\\([*_#\[\]()|-])/g, "$1");
  const L = String(src || "").replace(/\r/g, "").split("\n"), out = []; let list = null, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const close = () => { flush(); if (list) { out.push(`</${list}>`); list = null; } };
  const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  for (let i = 0; i < L.length; i++) {
    const line = L[i]; let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); const h = Math.min(4, m[1].length + 1); out.push(`<h${h}>${inline(m[2])}</h${h}>`); }
    else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(L[i + 1] || "")) {
      close(); const head = cells(line); i++; const rows = [];
      while (i + 1 < L.length && /^\s*\|.*\|\s*$/.test(L[i + 1])) rows.push(cells(L[++i]));
      out.push(`<div class="table-wrap"><table class="doc-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flush(); if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flush(); if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { close(); out.push("<hr>"); }
    else if ((m = line.match(/^>\s?(.*)/))) { close(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else if (!line.trim()) close();
    else if (list && /^\s{2,}\S/.test(line)) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, " " + inline(line.trim()) + "</li>"); }
    else { if (list) close(); para.push(line.trim()); }
  }
  close(); return out.join("");
}

/* ---------------- shared sign-in guard: apps send people to the landing page to sign in */
const HUB = window.PULSE_HUB || "../";
function authLost() { if (window.onAuthLost) return window.onAuthLost(); goSignIn(); }
function goSignIn() {
  const here = location.pathname.replace(/\/index\.html$/, "/").replace(/\/$/, "").split("/").pop();
  location.href = HUB + "?next=" + encodeURIComponent(here) + (/^#\//.test(location.hash) ? location.hash : "");
}
// Signed in and on the team? Returns {user, profile}; otherwise sends the visitor to sign in.
async function requireMember() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { goSignIn(); return null; }
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { goSignIn(); return null; }
  const prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  if (!prof || !prof.active) { goSignIn(); return null; }
  S.user = user; S.profile = prof;
  await loadWorkspace();
  if (!S.team.length) S.team = must(await sb.from("profiles").select("*").order("display_name"));
  const app = pageApp();
  if (app && PULSE_APPS.some((a) => a.key === app) && !hasApp(app)) { showShell(); $("#main").innerHTML = lockedPanel(app); return null; }
  return { user, profile: prof };
}
// The company this person belongs to: name, logo, starter pack and saved settings. Shows it in the top bar.
const WS_COLS = "id, name, logo_url, template, config, plan, created_at";
async function loadWorkspace() {
  S.workspace = must(await sb.from("workspaces").select(WS_COLS).maybeSingle());
  // the plan decides which apps open (the database enforces it too); null = billing not set up yet, so nothing is locked
  try { const r = await sb.rpc("billing_status"); S.billing = r.error ? null : r.data; } catch { S.billing = null; }
  applyBrand();
  return S.workspace;
}

/* ---------------------------------------------------------------- plans
   Per staff user per month; contractors and consultants are free. Yearly = 10 months (2 free). */
const PLANS = {
  starter: { name: "Starter", price: 3, blurb: "Run the business day to day.", apps: ["review", "contacts", "funding", "timecards", "tickets", "people", "documents"], limit: "Up to 10 users" },
  pro: { name: "Pro", price: 6, blurb: "Find and win work, deliver it, hire.", apps: ["opportunities", "projects", "agreements", "invoices", "hiring"], limit: "Unlimited users" },
  enterprise: { name: "Enterprise", price: 10, blurb: "Everything, with your AI chief of staff.", apps: ["chief", "scheduler"], limit: "Unlimited users, priority support" },
};
const FEATURE_NAMES = { hiring: "Hiring", agreements: "Agreements and e-signing", invoices: "Invoices", documents: "Policies and sign-offs" };
const PLAN_ORDER = ["starter", "pro", "enterprise"];
const appPlan = (key) => PLAN_ORDER.find((p) => PLANS[p].apps.includes(key)) || "starter";
const planRank = (p) => Math.max(0, PLAN_ORDER.indexOf(p));
const hasApp = (key) => !S.billing || planRank(S.billing.effective) >= planRank(appPlan(key));
const planApps = (p) => PLAN_ORDER.slice(0, planRank(p) + 1).flatMap((k) => PLANS[k].apps);
// the app this page belongs to, from its folder (/opportunities/ → "opportunities")
const pageApp = () => (location.pathname.match(/\/([a-z]+)\/(?:index\.html)?$/) || [])[1];
// shown instead of an app the plan doesn't include
function lockedPanel(key, what) {
  const need = PLANS[appPlan(key)], admin = S.profile?.role === "admin";
  return `<section class="panel plan-lock"><div class="plan-lock-ic"><svg class="ic"><use href="#i-key"/></svg></div>
    <h1>${esc(what || PULSE_APPS.find((a) => a.key === key)?.name || "This app")} is part of ${need.name}</h1>
    <p class="muted">${esc(S.workspace?.name || "Your workspace")} is on <b>${esc(PLANS[S.billing?.effective]?.name || "Starter")}</b>. ${need.name} is $${need.price} per user per month and adds ${need.apps.filter((k) => k !== "documents").map((k) => esc(FEATURE_NAMES[k] || PULSE_APPS.find((a) => a.key === k)?.name || k)).join(", ")}.</p>
    <p class="muted small">Nothing has been deleted: everything saved here comes back as soon as you upgrade.</p>
    ${admin ? `<a class="btn primary" href="${HUB}admin/#/billing">See plans and upgrade</a>` : `<p><b>Ask an admin</b> to upgrade in Admin → Billing.</p>`}</section>`;
}
function applyBrand() {
  const w = S.workspace; if (!w) return;
  $$("[data-ws-name]").forEach((e) => (e.textContent = w.name));
  $$("[data-ws-logo]").forEach((e) => {
    e.innerHTML = w.logo_url ? `<img src="${esc(w.logo_url)}" alt="">` : esc(w.name.split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase());
  });
  const app = document.title.split(" · ")[0];
  document.title = (app && app !== "Pulse" ? app + " · " : "") + w.name + " · Pulse";
}
function setWho(name) {
  $$("#whoami").forEach((e) => (e.textContent = name));
  $$("#avatar").forEach((e) => (e.textContent = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()));
}
// Every app, for the landing page and the apps launcher in the top bar. href is relative to the landing page.
const PULSE_APPS = [
  { key: "review", group: "win", staff: true, name: "Business Review", icon: "chart", href: "./review/", blurb: "Opportunities, action items and daily to quarterly reviews." },
  { key: "contacts", group: "win", staff: true, name: "Contacts", icon: "users", href: "./contacts/", blurb: "Customers, investors, partners; import and follow up." },
  { key: "funding", group: "win", staff: true, name: "Funding", icon: "banknotes", href: "./funding/", blurb: "Grant and loan applications, plus the funding catalog." },
  { key: "opportunities", group: "win", staff: true, name: "Opportunities", icon: "gov", href: "./opportunities/", blurb: "Federal contracts, grants and state and local bids, checked daily." },
  { key: "projects", group: "deliver", name: "Projects", icon: "briefcase", href: "./projects/", blurb: "Schedule, tasks, team, budget vs. actual, reports, close-out." },
  { key: "documents", group: "deliver", name: "Documents", icon: "clipboard", href: "./agreements/", blurb: "Policies and sign-offs, contracts and e-signing, invoices, compliance dates." },
  { key: "people", group: "deliver", name: "People", icon: "user-plus", href: "./people/", blurb: "Hiring: openings, candidates, interviews. Then onboarding and offboarding." },
  { key: "timecards", group: "daily", name: "Timecards", icon: "timer", href: "./timecards/", blurb: "Log hours by project each week; approve timesheets." },
  { key: "scheduler", group: "daily", name: "Scheduler", icon: "calendar", href: "./scheduler/", blurb: "Team free/busy from Google or Outlook; find a time, invite." },
  { key: "tickets", group: "daily", name: "Tickets", icon: "ticket", href: "./tickets/", blurb: "Equipment, purchases, time off, IT help and approvals." },
  { key: "chief", group: "daily", name: "Chief of Staff", icon: "sparkles", href: "./chief/", blurb: "Your AI chief of staff: morning brief, answers, reminders." },
];
function showShell() {
  $("#shell").hidden = false; $("#topbar").hidden = false;
  if (S.profile) setWho(S.profile.display_name);
  buildUserMenu(); buildAppsMenu(); addFooter(); addHelpBtn();
}
// Help (?) in the top bar on every page: opens the Help Center at the topic for the app you're in
const HELP_TOPICS = ["review", "contacts", "funding", "opportunities", "projects", "documents", "people", "timecards", "tickets", "scheduler", "chief"];
function helpTopic() {
  const seg = location.pathname.replace(/\/index\.html$/, "/").split("/").filter(Boolean).pop() || "";
  if (seg === "agreements") return "documents";
  if (seg === "portal") return "start/portal";
  if (seg === "admin") return /billing/.test(location.hash) ? "billing" : "admin";
  if (seg === "opportunities") { const m = location.hash.match(/#\/help\/?(\w*)/); return "opportunities" + (m && m[1] ? "/" + m[1] : ""); }
  return HELP_TOPICS.includes(seg) ? seg : "";
}
function addHelpBtn() {
  const bar = $("#topbar"); if (!bar || $("#helpBtn", bar)) return;
  const at = $(".apps-menu", bar) || $(".user-menu", bar);
  const a = document.createElement("a"); a.id = "helpBtn"; a.className = "help-btn"; a.title = "Help"; a.setAttribute("aria-label", "Help Center");
  a.innerHTML = `<svg class="ic"><use href="#i-question"/></svg><span>Help</span>`;
  a.addEventListener("click", () => { a.href = HUB + "help/" + (helpTopic() ? "#" + helpTopic() : ""); });
  a.href = HUB + "help/" + (helpTopic() ? "#" + helpTopic() : ""); a.target = "_blank"; a.rel = "noopener";
  at ? at.before(a) : bar.appendChild(a);
}
// Apps launcher (grid button, top right) on every page
// Roles: admins and members are staff and see the business records; employees and contractors use the employee portal
// (their own checklist, policies, devices, hours and requests) and never see contacts, pipeline, funding or bids.
const ROLES = {
  admin: { name: "Admin", blurb: "Everything, plus settings, billing and the team." },
  member: { name: "Member", blurb: "Every app, including contacts, pipeline, funding and bids." },
  employee: { name: "Employee", blurb: "The employee portal: checklist, policies, contracts, devices, hours, requests and their projects." },
  contractor: { name: "Contractor", blurb: "Like an employee, for contractors and consultants. Free; doesn't count as a user." },
};
const isStaffRole = (r) => r === "admin" || r === "member";
const roleName = (r) => ROLES[r]?.name || r || "";
const PORTAL = HUB + "portal/";
const launcherApps = () => PULSE_APPS.filter((a) => (!a.staff || isStaffRole(S.profile?.role)) && CFG.apps?.[a.key] !== false);
function buildAppsMenu() {
  const host = $("#appsMenu"); if (!host || !S.profile) return;
  const here = location.pathname.replace(/\/index\.html$/, "/");
  host.innerHTML = `<div class="apps-grid">${launcherApps().map((a) => { const href = HUB + a.href.replace(/^\.\//, ""), on = here.endsWith(a.href.replace(/^\./, ""));
      const name = a.key === "chief" ? S.workspace?.config?.chief_name || a.name : a.name;
      const lock = !hasApp(a.key) ? `<small class="plan-badge">${PLANS[appPlan(a.key)].name}</small>` : "";
      return `<a role="menuitem" href="${href}" class="app-tile ${on ? "on" : ""} ${lock ? "locked" : ""}" data-app="${a.key}"><span class="hub-ic ${a.key === "chief" ? "ai" : ""}"><svg class="ic"><use href="#i-${a.icon}"/></svg></span><span>${esc(name)}</span>${lock}</a>`; }).join("")}</div>
    ${isStaffRole(S.profile.role) ? `<a class="apps-all" role="menuitem" href="${HUB}">Open the apps page</a>` : `<a class="apps-all" role="menuitem" href="${PORTAL}">Back to my portal</a>`}`;
}
document.addEventListener("click", (e) => {
  const btn = $("#appsBtn"), m = $("#appsMenu"); if (!btn || !m) return;
  if (e.target.closest("#appsBtn")) { const open = m.hidden; m.hidden = !open; btn.setAttribute("aria-expanded", String(open)); $("#userMenu") && ($("#userMenu").hidden = true); return; }
  if (!e.target.closest("#appsMenu")) { m.hidden = true; btn.setAttribute("aria-expanded", "false"); }
});
document.addEventListener("keydown", (e) => { const m = $("#appsMenu"); if (m && !m.hidden && e.key === "Escape") { m.hidden = true; $("#appsBtn").focus(); } });
// Footer on every page
function addFooter() {
  const shell = $("#shell"); if (!shell || $(".site-foot", shell)) return;
  shell.insertAdjacentHTML("beforeend", `<footer class="site-foot"><span>BlueCredit Pulse · © ${new Date().getFullYear()} BlueCredit Inc.</span>
    <span><a href="https://www.bluecredits.org" target="_blank" rel="noopener">bluecredits.org</a> · <a href="mailto:support@bluecredits.org">Support</a> · <a href="${HUB}">All apps</a></span></footer>`);
}
// Top-right menu on every page: who you are, workspace and admin links, sign out
function buildUserMenu() {
  const m = $("#userMenu"); if (!m || !S.profile) return;
  const p = S.profile, admin = p.role === "admin", ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
  const role = roleName(p.role);
  const item = (href, icon, label) => `<a role="menuitem" href="${href}">${ic(icon)}<span>${label}</span></a>`;
  m.innerHTML = `<div class="menu-head"><b>${esc(p.display_name)}</b><span>${esc(S.user?.email || p.email || "")}</span><small>${esc(role)}${S.workspace ? " · " + esc(S.workspace.name) : ""}</small></div>
    ${isStaffRole(p.role) ? item(HUB, "grid", "All apps") + item(PORTAL, "home", "My portal") : item(PORTAL, "home", "My portal")}
    ${admin ? `<div class="menu-sep"></div><div class="menu-label">Admin</div>${item(HUB + "admin/#/settings", "cog", "Workspace settings")}${item(HUB + "admin/#/team", "team", "Team and access")}${item(HUB + "admin/#/billing", "banknotes", "Plan and billing")}${item(HUB + "review/#/activity", "clock", "Activity log")}` : ""}
    <div class="menu-sep"></div>
    ${CFG.apps?.scheduler !== false ? item(HUB + "scheduler/#/connect", "calendar", "Connect my calendar") : ""}
    ${item(HUB + "?reset=1", "key", "Change password")}
    <button role="menuitem" type="button" data-signout>${ic("logout")}<span>Sign out</span></button>`;
}
document.addEventListener("click", (e) => {
  const btn = $("#userBtn"), m = $("#userMenu"); if (!btn || !m) return;
  if (e.target.closest("#userBtn")) { const open = m.hidden; m.hidden = !open; btn.setAttribute("aria-expanded", String(open)); if (open) m.querySelector("[role=menuitem]")?.focus(); return; }
  if (!e.target.closest("#userMenu")) { m.hidden = true; btn.setAttribute("aria-expanded", "false"); }
});
document.addEventListener("keydown", (e) => {
  const m = $("#userMenu"); if (!m || m.hidden) return;
  if (e.key === "Escape") { m.hidden = true; $("#userBtn").setAttribute("aria-expanded", "false"); $("#userBtn").focus(); }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const it = $$("[role=menuitem]", m), i = it.indexOf(document.activeElement);
    it[(i + (e.key === "ArrowDown" ? 1 : -1) + it.length) % it.length]?.focus(); }
});
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-signout]")) return;
  const portal = (S.profile && !isStaffRole(S.profile.role)) || /\/portal\/?(index\.html)?$/.test(location.pathname);
  await sb.auth.signOut(); location.href = portal ? PORTAL : HUB;
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#menuBtn")) document.body.classList.toggle("nav-open");
  else if (e.target.closest("#scrim")) document.body.classList.remove("nav-open");
});

/* ---------------- shared UI helpers */
function statusClass(v) {
  const s = (v || "").toLowerCase();
  if (["won", "done", "active", "responded", "meeting set", "approved", "available"].includes(s)) return "s-won";
  if (["lost", "missed", "dropped", "withdrawn", "cancelled", "do not contact", "rejected", "retired"].includes(s)) return "s-lost";
  if (["submitted", "in progress"].includes(s)) return "s-submitted";
  if (["pending approval", "in repair"].includes(s)) return "s-high";
  if (["identified", "qualifying", "pursuing", "open", "to contact", "contacted", "in use"].includes(s)) return "s-active";
  return "";
}
const pill = (v) => v ? `<span class="pill ${statusClass(v)}">${esc(v)}</span>` : "";
function dueCell(iso, active = true) {
  if (!iso) return "";
  const d = daysUntil(iso);
  const cls = !active ? "" : d < 0 ? "due-over" : d <= 7 ? "due-soon" : "";
  const hint = !active ? "" : d === 0 ? " · today" : d < 0 ? "" : d <= 14 ? ` · ${d}d` : "";
  return `<span class="${cls}" title="${iso}">${short(iso)}${hint}</span>`;
}
function downloadCsv(name, cols, rows) {
  const q = (v) => { v = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const text = [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["\ufeff" + text], { type: "text/csv" })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}
function parseCsv(text) {
  const rows = []; let row = [], f = "", i = 0, quoted = false;
  text = text.replace(/^\ufeff/, "");
  while (i < text.length) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else quoted = false; } else f += c; }
    else if (c === '"') quoted = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
    i++;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}
async function readSheetFile(file) {
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "csv" || ext === "txt") return { sheets: [{ name: file.name, rows: parseCsv(await file.text()) }] };
  if (ext === "tsv") return { sheets: [{ name: file.name, rows: (await file.text()).replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split("\t")) }] };
  if (ext !== "xlsx") throw new Error("Use an .xlsx, .csv or .tsv file. For an older .xls file, open it in Excel and save as .xlsx first.");
  return readXlsx(await file.arrayBuffer());
}
async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), files = {};
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This doesn't look like a valid .xlsx file.");
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0, count = dv.getUint16(eocd + 10, true); n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const nameLen = dv.getUint16(p + 28, true);
    files[new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen))] =
      { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), local: dv.getUint32(p + 42, true) };
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return async (name) => {
    const f = files[name]; if (!f) return null;
    const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
    const data = u8.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(data);
    if (f.method !== 8) throw new Error("This .xlsx uses an unsupported compression. Re-save it in Excel and try again.");
    return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  };
}
async function readXlsx(buf) {
  const read = await unzip(buf);
  const xml = async (path) => { const t = await read(path); return t ? new DOMParser().parseFromString(t, "application/xml") : null; };
  const tags = (doc, name) => [...doc.getElementsByTagNameNS("*", name)];
  const text = (el) => tags(el, "t").map((t) => t.textContent).join("");
  const ss = await xml("xl/sharedStrings.xml");
  const shared = ss ? tags(ss, "si").map(text) : [];
  const wb = await xml("xl/workbook.xml"), rels = await xml("xl/_rels/workbook.xml.rels");
  if (!wb) throw new Error("This doesn't look like a valid .xlsx file.");
  const target = Object.fromEntries((rels ? tags(rels, "Relationship") : []).map((r) => [r.getAttribute("Id"), r.getAttribute("Target")]));
  const sheets = [];
  for (const [i, sh] of tags(wb, "sheet").entries()) {
    const rid = sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sh.getAttribute("r:id");
    let path = target[rid] || `worksheets/sheet${i + 1}.xml`;
    path = path.startsWith("/") ? path.slice(1) : "xl/" + path.replace(/^\.\//, "");
    const doc = await xml(path); if (!doc) continue;
    const rows = [];
    for (const row of tags(doc, "row")) {
      const out = [];
      for (const c of tags(row, "c")) {
        const ref = c.getAttribute("r") || "", col = ref ? [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : out.length;
        const t = c.getAttribute("t"), v = tags(c, "v")[0]?.textContent ?? "";
        let val = t === "s" ? shared[+v] ?? "" : t === "inlineStr" ? text(c) : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v;
        if (!t && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(val) && Number.isInteger(+val) && Math.abs(+val) < 1e15) val = String(+val);
        out[col] = val;
      }
      rows.push(Array.from(out, (x) => x ?? ""));
    }
    sheets.push({ name: sh.getAttribute("name") || `Sheet ${i + 1}`, rows });
  }
  if (!sheets.length) throw new Error("No sheets found in this file.");
  return { sheets };
}
function guessField(header) {
  const h = String(header).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!h) return "ignore";
  if (/linkedin/.test(h)) return "linkedin";
  if (/e ?mail/.test(h)) return "email";
  if (/phone|mobile|cell|telephone|^tel\b/.test(h)) return "phone";
  if (/^(first|given|fname)( name)?$/.test(h)) return "first";
  if (/^(last|surname|family|lname)( name)?$/.test(h)) return "last";
  if (/^(full name|name|contact|contact name|participant|attendee|attendee name|person|poc|point of contact|representative|registrant)$/.test(h)) return "name";
  if (/company|organi[sz]ation|^org$|firm|business name|employer|agency|vendor|account name|legal business name|^partner$/.test(h)) return "organization";
  if (/^(title|job title|role|position|designation)$/.test(h)) return "role";
  if (/^(city|town)$/.test(h)) return "city";
  if (/^(state|province|state province)$/.test(h)) return "state";
  if (/zip|postal/.test(h)) return "zip";
  if (/^country$/.test(h)) return "country";
  if (/^(location|address|street|street address|mailing address)$/.test(h)) return "location";
  return "notes";
}
function findHeaderRow(rows) {
  let best = 0, bestScore = -1;
  rows.slice(0, 15).forEach((r, i) => {
    const filled = r.filter((x) => String(x).trim()).length;
    const score = r.filter((x) => !["notes", "ignore"].includes(guessField(x))).length * 10 + Math.min(filled, 9);
    if (filled >= 2 && score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}
const tidy = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
function openDrawer() { const d = $("#drawer"); if (!d) return; d.classList.add("open"); d.setAttribute("aria-hidden", "false"); }
function closeDrawer() { const d = $("#drawer"); if (!d) return; d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); }
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
