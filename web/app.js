/* BlueCredit Pulse — static single-page app on GitHub Pages, data in Supabase. No build step. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CFG = window.PULSE_CONFIG || {};
const S = { schema: window.PULSE_SCHEMA, user: null, profile: null, team: [] };
const today = () => new Date().toLocaleDateString("en-CA");
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const daysUntil = (iso) => Math.round((new Date(iso + "T12:00:00") - new Date(today() + "T12:00:00")) / 864e5);
const money = (n) => n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const short = (iso) => iso ? new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: String(iso).slice(0, 4) === today().slice(0, 4) ? undefined : "numeric" }) : "";
const ago = (ts) => { const m = Math.round((Date.now() - new Date(ts)) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const firstName = () => (S.profile?.display_name || "").split(" ")[0];
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600); }

/* ================================================================ data layer (Supabase) */
const sb = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

function must({ data, error, count }) {
  if (error) {
    if (/JWT|not authenticated|401/i.test(error.message)) showAuth("signin");
    throw new Error(error.message || "Something went wrong");
  }
  return count === undefined || count === null ? data : { data, count };
}
const fieldDefs = (entity) => S.schema.entities[entity].fields;
const fieldTypes = (entity) => Object.fromEntries(fieldDefs(entity).map((f) => [f.name, f.type]));

function clean(entity, data) {
  const types = fieldTypes(entity), out = {};
  for (const [k, raw] of Object.entries(data)) {
    if (!(k in types)) continue;
    let v = typeof raw === "string" ? raw.trim() : raw;
    if (types[k] === "number") {
      if (v === "" || v == null) v = null;
      else { const n = parseFloat(String(v).replace(/[$,%\s]/g, "")); if (isNaN(n)) throw new Error(`${k} must be a number`); v = n; }
    } else if (types[k] === "date") v = v ? String(v).slice(0, 10) : null;
    else if (v === "") v = null;
    out[k] = v;
  }
  return out;
}
const pgList = (vals) => "(" + vals.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",") + ")";
const safeTerm = (t) => t.replace(/[,()*"\\%]/g, " ").trim();

function applyFilters(query, entity, params) {
  const types = fieldTypes(entity);
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v == null) continue;
    if (k in types) {
      const vals = String(v).split("|");
      if (vals.length === 1 && vals[0] === "__blank__") query = query.or(`${k}.is.null,${k}.eq.`);
      else query = query.in(k, vals);
    } else if (k.endsWith("__not") && k.slice(0, -5) in types) {
      const f = k.slice(0, -5);
      query = query.or(`${f}.is.null,${f}.not.in.${pgList(String(v).split("|"))}`);
    } else if (k.endsWith("__gte") && k.slice(0, -5) in types) query = query.gte(k.slice(0, -5), v);
    else if (k.endsWith("__lte") && k.slice(0, -5) in types) query = query.lte(k.slice(0, -5), v);
  }
  const q = (params.q || "").trim();
  if (q) {
    const cols = fieldDefs(entity).filter((f) => ["text", "textarea", "email", "select", "url"].includes(f.type)).map((f) => f.name);
    for (const term of q.split(/\s+/).map(safeTerm).filter(Boolean)) query = query.or(cols.map((c) => `${c}.ilike.*${term}*`).join(","));
  }
  return query;
}

const db = {
  async list(entity, params = {}) {
    const ent = S.schema.entities[entity];
    let sort = params.sort || ent.default_sort;
    const desc = sort.startsWith("-"); sort = sort.replace(/^-/, "");
    if (!(sort in fieldTypes(entity)) && !["id", "updated_at", "created_at"].includes(sort)) sort = "id";
    const limit = params.limit ?? 100, offset = params.offset ?? 0;
    let query = applyFilters(sb.from(entity).select("*", { count: "exact" }), entity, params)
      .order(sort, { ascending: !desc, nullsFirst: false }).order("id", { ascending: false }).range(offset, offset + limit - 1);
    const { data, count } = must(await query);
    return { total: count ?? data.length, rows: data };
  },
  async all(entity, params = {}) {  // every matching row, 1000 at a time (for CSV export)
    const rows = []; let offset = 0;
    for (;;) { const r = await db.list(entity, { ...params, limit: 1000, offset }); rows.push(...r.rows); offset += 1000; if (offset >= r.total) break; }
    return rows;
  },
  async get(entity, id) {
    const row = must(await sb.from(entity).select("*").eq("id", id).single());
    row.history = must(await sb.from("activity").select("*").eq("entity", entity).eq("entity_id", id).order("ts", { ascending: false }).limit(50));
    if (["opportunities", "funding", "contacts"].includes(entity))
      row.actions = must(await sb.from("actions").select("*").eq("linked_type", entity).eq("linked_id", id).order("status").order("due_date", { nullsFirst: false }));
    return row;
  },
  async create(entity, data) { return must(await sb.from(entity).insert(clean(entity, data)).select().single()); },
  async update(entity, id, data) { return must(await sb.from(entity).update(clean(entity, data)).eq("id", id).select().single()); },
  async remove(entity, id) { must(await sb.from(entity).delete().eq("id", id)); },
  async rpc(fn, args) { return must(await sb.rpc(fn, args)); },
};

/* ================================================================ auth */
let authMode = "signin";
function showAuth(mode, notice = "") {
  authMode = mode;
  $("#shell").hidden = true; $("#setup").hidden = true; $("#login").hidden = false;
  $("#authTabs").hidden = !["signin", "join"].includes(mode);
  $$("#authTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  $$(".auth-form").forEach((f) => (f.hidden = f.dataset.mode !== mode));
  $("#authError").textContent = ""; $("#authNotice").textContent = notice;
  setTimeout(() => $(`.auth-form[data-mode="${mode}"] input`)?.focus(), 30);
}
$$("#authTabs button").forEach((b) => b.addEventListener("click", () => showAuth(b.dataset.mode)));
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

document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-signout]")) return;
  await sb.auth.signOut(); S.user = null; S.profile = null; location.hash = ""; showAuth("signin");
});

async function afterSignIn() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showAuth("signin");
  S.user = user;
  let prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  if (!prof) {  // confirmed their email after joining: finish with the code they entered
    const meta = user.user_metadata || {};
    if (meta.company_code) {
      try { await db.rpc("join_company", { p_code: meta.company_code, p_name: meta.display_name || user.email.split("@")[0] }); }
      catch (err) { showAuth("finish"); authErr(err); return; }
      prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
    }
  }
  if (!prof) { showAuth("finish"); $("#finishForm [name=name]").value = user.user_metadata?.display_name || ""; return; }
  if (!prof.active) { await sb.auth.signOut(); showAuth("signin"); authErr(new Error("This account is turned off. Ask an admin to turn it back on.")); return; }
  S.profile = prof;
  await loadTeam();
  $("#login").hidden = true; $("#shell").hidden = false;
  $("#whoami").textContent = prof.display_name;
  route();
}

async function loadTeam() {
  S.team = must(await sb.from("profiles").select("*").order("display_name"));
  // owner dropdowns: the original names plus anyone who has joined
  const names = new Set(window.PULSE_SCHEMA.owners);
  S.team.filter((p) => p.active).forEach((p) => names.add(p.display_name.split(" ")[0]));
  S.owners = [...names];
  for (const ent of Object.values(S.schema.entities)) for (const f of ent.fields) if (f.name === "owner") f.options = S.owners;
}

async function boot() {
  $$(".app-name").forEach((e) => (e.textContent = CFG.appName || "BlueCredit Pulse"));
  document.title = CFG.appName || "BlueCredit Pulse";
  if (!sb) { $("#setup").hidden = false; return; }
  sb.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") showAuth("reset"); });
  if (/type=recovery/.test(location.hash)) return;  // handled by PASSWORD_RECOVERY
  const { data: { session } } = await sb.auth.getSession();
  if (session) afterSignIn().catch((e) => { showAuth("signin"); authErr(e); });
  else showAuth("signin");
}

/* ================================================================ status styling */
function statusClass(v) {
  const s = (v || "").toLowerCase();
  if (["won", "done", "active", "responded", "meeting set"].includes(s)) return "s-won";
  if (["lost", "missed", "dropped", "withdrawn", "cancelled", "do not contact"].includes(s)) return "s-lost";
  if (s === "submitted") return "s-submitted";
  if (["identified", "qualifying", "pursuing", "open", "to contact", "contacted"].includes(s)) return "s-active";
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

/* ================================================================ router */
const routes = { dashboard: Dashboard, reviews: Reviews, activity: Activity, team: Team };
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [name = "dashboard", id] = location.hash.replace(/^#\/?/, "").split("/");
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === name));
  closeDrawer();
  const main = $("#main");
  main.innerHTML = `<p class="muted">Loading…</p>`;
  const fn = routes[name] || (S.schema.entities[name] ? () => ListPage(name) : Dashboard);
  Promise.resolve(fn(id)).catch((e) => (main.innerHTML = `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  main.focus({ preventScroll: true });
}

/* ================================================================ dashboard */
async function Dashboard() {
  const d = await db.rpc("dashboard_data", { p_owner: firstName() });
  const k = d.kpis, last = d.last_reviews || {};
  const h = new Date().getHours();
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${esc(firstName())}</h1>
      <p class="muted">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p></div>
      <div class="actions-row"><a class="btn primary" href="#/reviews">Start today's review</a></div></div>
    <div class="kpis">
      <a class="kpi" href="#/opportunities"><b>${k.active_opps}</b><span>Active opportunities</span></a>
      <a class="kpi" href="#/funding"><b>${k.active_funding}</b><span>Active funding applications</span></a>
      <a class="kpi" href="#/opportunities" data-preset="stage=Submitted"><b>${k.submitted}</b><span>Awaiting decision</span></a>
      <a class="kpi" href="#/opportunities" data-preset="stage=Won"><b>${k.won}</b><span>Won</span></a>
      <a class="kpi ${k.overdue_actions ? "alert" : ""}" href="#/actions"><b>${k.open_actions}</b><span>Open actions${k.overdue_actions ? ` · ${k.overdue_actions} overdue` : ""}</span></a>
      <a class="kpi ${k.followups_due ? "alert" : ""}" href="#/contacts" data-preset="__followups"><b>${k.followups_due}</b><span>Follow-ups due</span></a>
    </div>
    <section class="panel"><h2>Next 14 days <small>${d.due_soon.length} deadline${d.due_soon.length === 1 ? "" : "s"}</small></h2>${gauge(d.due_soon, 14)}
      ${d.due_soon.length ? `<ul class="list">${d.due_soon.map(dueLi).join("")}</ul>` : `<p class="muted">No deadlines in the next two weeks. Qualify something from the forecasts.</p>`}</section>
    <div class="grid2">
      <div>
        <section class="panel"><h2>My open actions <small><a href="#/actions">All actions</a></small></h2>
          ${d.my_actions.length ? d.my_actions.map(actionItem).join("") : `<p class="muted">Nothing assigned to you. Actions you're given in reviews show up here.</p>`}</section>
        <section class="panel"><h2>Recent activity <small><a href="#/activity">Full log</a></small></h2>
          <ul class="list">${d.recent.slice(0, 12).map((a) => `<li><span>${esc(a.summary)}</span><span class="meta">${esc(a.user_name)} · ${ago(a.ts)}</span></li>`).join("") || `<li class="muted">No edits yet.</li>`}</ul></section>
      </div>
      <div>
        <section class="panel"><h2>Review rhythm</h2><ul class="list">
          ${Object.entries(S.schema.cadences).map(([c, cfg]) => { const l = last[c]; const late = !l || daysUntil(l) < -{ daily: 1, weekly: 7, monthly: 31, quarterly: 92 }[c];
            return `<li><span>${cfg.label}</span><span class="meta ${late ? "due-over" : ""}">${l ? "Last " + short(l) : "Not run yet"}</span></li>`; }).join("")}</ul></section>
        <section class="panel"><h2>Opportunities by stage</h2>${bars(d.opp_by_stage, "opportunities", "stage")}</section>
        <section class="panel"><h2>Funding pipeline</h2>${bars(d.funding_by_status, "funding", "status")}</section>
      </div>
    </div>`;
  wireCommon($("#main"), Dashboard);
}
function dueLi(r) {
  return `<li><span><a href="#" data-open="${r.entity}:${r.id}">${esc(r.name)}</a><br><span class="meta">${r.entity === "funding" ? "Funding" : "Opportunity"}${r.org ? " · " + esc(r.org) : ""}${r.owner ? " · " + esc(r.owner) : ""}</span></span>
    <span class="meta">${dueCell(r.deadline)}<br>${pill(r.status)}</span></li>`;
}
function gauge(items, span) {
  if (!items.length) return "";
  const ticks = span <= 14 ? [0, 3, 7, span] : span <= 30 ? [0, 7, 14, span] : [0, Math.round(span / 4), Math.round(span / 2), Math.round(span * 3 / 4), span];
  const wk = Math.min(100, (7 / span) * 100), urgent = Math.min(100, (1 / span) * 100);
  const track = `background:linear-gradient(90deg,var(--rust) 0 ${urgent}%,var(--ochre) ${urgent}% ${wk}%,var(--teal) ${wk}% 100%)`;
  const by = {};
  items.forEach((r) => (by[r.deadline] = by[r.deadline] || []).push(r));
  const dots = Object.entries(by).map(([d, rs]) => {
    const n = Math.max(0, daysUntil(d)); const pos = Math.min(100, (n / span) * 100);
    const f = rs.every((r) => r.entity === "funding");
    const title = rs.map((r) => `${r.name} (${short(d)})`).join("\n");
    return `<button class="gauge-dot ${f ? "f" : ""} ${n <= 7 ? "soon" : ""}" style="left:${pos}%" title="${esc(title)}" aria-label="${esc(title)}" data-open="${rs[0].entity}:${rs[0].id}">${rs.length > 1 ? `<span class="n">${rs.length}</span>` : ""}</button>`;
  }).join("");
  return `<div class="gauge"><p class="gauge-legend"><span><i></i>Opportunity</span><span><i class="f"></i>Funding</span></p>
    <div class="gauge-track"><span class="gauge-line" style="${track}"></span>${dots}${ticks.map((t) => `<span class="gauge-tick" style="left:${(t / span) * 100}%">${t === 0 ? "Today" : "+" + t + "d"}</span>`).join("")}</div></div>`;
}
function bars(rows, entity, field) {
  if (!rows?.length) return `<p class="muted">Nothing here yet.</p>`;
  const max = Math.max(...rows.map((r) => r.n));
  const order = S.schema.entities[entity].fields.find((f) => f.name === field).options;
  rows = [...rows].sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k));
  return `<div class="bars">${rows.map((r) => { const c = statusClass(r.k); const cls = c === "s-won" ? "won" : c === "s-lost" ? "lost" : c === "s-submitted" ? "sub" : "";
    return `<a class="bar" href="#/${entity}" data-preset="${field}=${encodeURIComponent(r.k || "__blank__")}" style="color:inherit;text-decoration:none"><span>${esc(r.k || "No status")}</span>
      <span class="track"><span class="fill ${cls}" style="width:${(r.n / max) * 100}%;display:block"></span></span><b>${r.n}</b></a>`; }).join("")}</div>`;
}
function actionItem(a) {
  const link = a.linked_type && a.linked_id ? ` · <a href="#" data-open="${a.linked_type}:${a.linked_id}">linked ${esc(S.schema.entities[a.linked_type]?.singular.toLowerCase() || a.linked_type)}</a>` : "";
  return `<div class="action-item ${a.status === "Done" ? "done" : ""}">
    <input type="checkbox" ${a.status === "Done" ? "checked" : ""} data-toggle-action="${a.id}" aria-label="Mark done">
    <div><div class="t">${esc(a.text)}</div><div class="m">${esc(a.owner || "Unassigned")}${a.due_date ? " · due " + dueCell(a.due_date, a.status === "Open") : ""}${link}</div></div>
    <button class="icon-btn" data-open="actions:${a.id}" aria-label="Edit action">✎</button></div>`;
}
function wireCommon(root, onChange) {
  root.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o) { e.preventDefault(); const [ent, id] = o.dataset.open.split(":"); openRecord(ent, +id, onChange); return; }
    const p = e.target.closest("[data-preset]");
    if (p) sessionStorage.setItem("preset:" + p.getAttribute("href").slice(2), p.dataset.preset);
  });
  root.addEventListener("change", async (e) => {
    const t = e.target.closest("[data-toggle-action]");
    if (!t) return;
    try { await db.update("actions", +t.dataset.toggleAction, { status: t.checked ? "Done" : "Open" }); }
    catch (err) { t.checked = !t.checked; return toast(err.message); }
    t.closest(".action-item").classList.toggle("done", t.checked);
    toast(t.checked ? "Marked done" : "Reopened");
  });
}

/* ================================================================ list pages */
const LIST_STATE = {};
const PRESETS = {
  opportunities: [["Active (identified → submitted)", "stage=Identified|Qualifying|Pursuing|Submitted"], ["Due in 30 days", "__due30"], ["Past due, no outcome", "__stale"], ["All", ""]],
  funding: [["Active applications", "status=Identified|Pursuing|Submitted"], ["All applications (not catalog)", "status__not=Catalog"], ["Catalog — open deadlines", "__catalogopen"], ["Catalog — everything", "status=Catalog"], ["All", ""]],
  contacts: [["Working contacts", "category__not=Mailing List|Corporate Prospect|Expert"], ["Follow-ups due", "__followups"], ["All", ""]],
  actions: [["Open", "status=Open"], ["Done", "status=Done"], ["All", ""]],
  resources: [["All", ""]],
};
function presetParams(key) {
  const t = today();
  if (key === "__due30") return { stage: "Identified|Qualifying|Pursuing|Submitted", deadline__gte: t, deadline__lte: addDays(t, 30) };
  if (key === "__stale") return { stage: "Identified|Qualifying|Pursuing", deadline__lte: addDays(t, -1) };
  if (key === "__catalogopen") return { status: "Catalog", deadline__gte: t };
  if (key === "__followups") return { next_step_date__lte: t, status__not: "Do Not Contact|Dormant" };
  return Object.fromEntries(new URLSearchParams(key));
}

async function ListPage(entity) {
  const ent = S.schema.entities[entity];
  const st = LIST_STATE[entity] ||= { q: "", preset: PRESETS[entity][0][1], extra: {}, sort: "", offset: 0 };
  const pre = sessionStorage.getItem("preset:" + entity);
  if (pre) {
    sessionStorage.removeItem("preset:" + entity); st.offset = 0; st.q = "";
    if (PRESETS[entity].some(([, v]) => v === pre)) { st.preset = pre; st.extra = {}; }
    else { st.preset = ""; st.extra = presetParams(pre); }
  }
  const facets = ent.fields.filter((f) => f.type === "select" && f.name !== ent.status_field).slice(0, 2);
  if (ent.status_field) facets.unshift(ent.fields.find((f) => f.name === ent.status_field));

  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${esc(ent.label)}</h1></div>
      <div class="actions-row no-print">
        <label class="btn">Import CSV<input type="file" accept=".csv" id="importCsv" hidden></label>
        <button class="btn" id="exportCsv">Export CSV</button>
        <button class="btn primary" id="addNew">Add ${esc(ent.singular.toLowerCase())}</button></div></div>
    <div class="filters">
      <input type="search" id="q" placeholder="Search ${esc(ent.label.toLowerCase())}…" value="${esc(st.q)}" aria-label="Search">
      <select id="preset" aria-label="View">${PRESETS[entity].map(([l, v]) => `<option value="${esc(v)}" ${v === st.preset ? "selected" : ""}>${esc(l)}</option>`).join("")}
        ${st.preset === "" && Object.keys(st.extra).length ? `<option value="" selected>Custom filter</option>` : ""}</select>
      ${facets.map((f) => `<select data-facet="${f.name}" aria-label="${esc(f.label)}"><option value="">${esc(f.label)}: any</option>
        ${f.options.map((o) => `<option ${st.extra[f.name] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`).join("")}
      <span class="count" id="count"></span>
    </div>
    <div class="table-wrap"><table><thead><tr>${ent.list_fields.map((f) => `<th data-sort="${f}">${esc(fieldLabel(entity, f))}</th>`).join("")}</tr></thead><tbody id="rows"></tbody></table></div>
    <div class="pager" id="pager"></div>`;

  const params = () => { const p = { ...presetParams(st.preset), ...st.extra, q: st.q, sort: st.sort }; Object.keys(p).forEach((k) => p[k] === "" && delete p[k]); return p; };
  const load = async () => {
    $("#count").textContent = "Loading…";
    let data;
    try { data = await db.list(entity, { ...params(), offset: st.offset, limit: 100 }); }
    catch (e) { $("#count").textContent = ""; $("#rows").innerHTML = `<tr><td class="empty" colspan="9">${esc(e.message)}</td></tr>`; return; }
    $("#count").textContent = `${data.total.toLocaleString()} ${data.total === 1 ? "record" : "records"}`;
    $("#rows").innerHTML = data.rows.length ? data.rows.map((r) => `<tr data-open="${entity}:${r.id}" tabindex="0">${ent.list_fields.map((f) => cell(entity, f, r)).join("")}</tr>`).join("")
      : `<tr><td colspan="${ent.list_fields.length}" class="empty">No ${esc(ent.label.toLowerCase())} match. Clear the search or switch the view to “All”.</td></tr>`;
    const s = st.sort || ent.default_sort;
    $$("th[data-sort]").forEach((th) => { th.classList.toggle("sorted", th.dataset.sort === s.replace("-", "")); th.classList.toggle("desc", s.startsWith("-")); });
    const end = Math.min(st.offset + 100, data.total);
    $("#pager").innerHTML = data.total > 100 ? `<span>${st.offset + 1}–${end} of ${data.total.toLocaleString()}</span>
      <button class="btn small" id="prev" ${st.offset ? "" : "disabled"}>Previous</button><button class="btn small" id="next" ${end < data.total ? "" : "disabled"}>Next</button>` : "";
    $("#prev")?.addEventListener("click", () => { st.offset -= 100; load(); });
    $("#next")?.addEventListener("click", () => { st.offset += 100; load(); });
  };
  let tmr;
  $("#q").addEventListener("input", (e) => { clearTimeout(tmr); tmr = setTimeout(() => { st.q = e.target.value; st.offset = 0; load(); }, 250); });
  $("#preset").addEventListener("change", (e) => { st.preset = e.target.value; st.extra = {}; st.offset = 0; ListPage(entity); });
  $$("[data-facet]").forEach((s) => s.addEventListener("change", () => { if (s.value) st.extra[s.dataset.facet] = s.value; else delete st.extra[s.dataset.facet]; st.offset = 0; load(); }));
  $$("th[data-sort]").forEach((th) => th.addEventListener("click", () => { const f = th.dataset.sort; if (f === "linked") return; const cur = st.sort || ent.default_sort; st.sort = cur === f ? "-" + f : f; load(); }));
  $("#rows").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.open) e.target.click(); });
  $("#addNew").addEventListener("click", () => openRecord(entity, null, load));
  $("#exportCsv").addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Exporting…";
    try { downloadCsv(`${entity}-${today()}.csv`, ["id", ...ent.fields.map((f) => f.name), "updated_at", "updated_by"], await db.all(entity, params())); }
    catch (err) { toast(err.message); } finally { e.target.disabled = false; e.target.textContent = "Export CSV"; }
  });
  $("#importCsv").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { const n = await importCsv(entity, await file.text()); toast(`Imported ${n} rows`); load(); }
    catch (err) { toast("Import failed: " + err.message); }
    e.target.value = "";
  });
  wireCommon($("#main"), load);
  await load();
}
function fieldLabel(entity, f) { return f === "linked" ? "Linked to" : (S.schema.entities[entity].fields.find((x) => x.name === f)?.label || f); }
const CLOSED = ["Won", "Lost", "Missed", "Not Qualified", "No-Bid", "Cancelled", "Catalog", "Out of Scope", "Withdrawn", "Done", "Dropped"];
function cell(entity, f, r) {
  const ent = S.schema.entities[entity];
  const def = ent.fields.find((x) => x.name === f) || {};
  const v = r[f];
  if (f === "linked") return `<td>${r.linked_type ? esc(S.schema.entities[r.linked_type]?.singular || r.linked_type) : r.review_id ? "Review" : ""}</td>`;
  if (f === ent.status_field) return `<td>${pill(v)}</td>`;
  if (f === "priority") return `<td>${v === "High" ? `<span class="pill s-high">High</span>` : esc(v)}</td>`;
  if (def.type === "date") return `<td class="date">${dueCell(v, !CLOSED.includes(r[ent.status_field]))}</td>`;
  if (def.type === "number") return `<td class="num">${f === "value" || f === "amount" ? money(v) : v ?? ""}</td>`;
  if (def.type === "url" && v) return `<td><a href="${esc(/^https?:/i.test(v) ? v : "https://" + v)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open</a></td>`;
  if (def.type === "email" && v) return `<td>${esc(v.split(/[,;\s]+/)[0])}</td>`;
  const first = f === ent.title_field;
  return `<td class="wrap"><span class="clip" ${first ? 'style="font-weight:550"' : ""}>${esc(v || (first ? r.organization || "(untitled)" : ""))}</span></td>`;
}

/* ---------------- CSV */
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
async function importCsv(entity, text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) throw new Error("The file is empty.");
  const byLabel = Object.fromEntries(fieldDefs(entity).flatMap((f) => [[f.name.toLowerCase(), f.name], [f.label.toLowerCase(), f.name]]));
  const map = head.map((h) => byLabel[h.trim().toLowerCase()]);
  if (!map.some(Boolean)) throw new Error("None of the column headers match this list's fields.");
  const records = rows.map((r) => clean(entity, Object.fromEntries(map.map((k, i) => [k, r[i]]).filter(([k]) => k))))
    .filter((r) => Object.values(r).some((v) => v != null));
  for (let i = 0; i < records.length; i += 500) must(await sb.from(entity).insert(records.slice(i, i + 500)));
  return records.length;
}

/* ================================================================ record drawer */
async function openRecord(entity, id, onSaved) {
  const ent = S.schema.entities[entity];
  let r;
  try { r = id ? await db.get(entity, id) : {}; } catch (e) { return toast(e.message); }
  if (!id) {
    if (ent.status_field) r[ent.status_field] = ent.fields.find((f) => f.name === ent.status_field).options[entity === "funding" ? 1 : 0];
    if (["opportunities", "funding", "actions", "contacts"].includes(entity)) r.owner = firstName();
  }
  $("#drawerTitle").textContent = id ? (r[ent.title_field] || r.organization || ent.singular) : `New ${ent.singular.toLowerCase()}`;
  const hidden = entity === "actions" ? ["review_id", "linked_type", "linked_id"] : [];
  const full = (f) => f.type === "textarea" || [ent.title_field, "url", "next_step"].includes(f.name);
  const ownerOpts = () => S.owners.map((o) => `<option ${o === firstName() ? "selected" : ""}>${esc(o)}</option>`).join("");
  $("#drawerBody").innerHTML = `
    <form class="form" id="recForm">
      ${ent.fields.filter((f) => !hidden.includes(f.name)).map((f) => `<label class="${full(f) ? "full" : ""}">${esc(f.label)}${input(f, r[f.name])}</label>`).join("")}
    </form>
    <div class="form-foot">
      <button class="btn primary" id="saveRec">${id ? "Save changes" : "Add " + ent.singular.toLowerCase()}</button>
      <button class="btn" data-close>Cancel</button><span class="spacer"></span>
      ${id ? `<button class="btn danger" id="delRec">Delete</button>` : ""}
    </div>
    ${id && r.actions ? `<section class="history"><h3>Action items</h3>
      <div>${r.actions.map(actionItem).join("") || `<p class="muted">No actions linked yet.</p>`}</div>
      <div class="add-action"><input id="naText" placeholder="Next action…" aria-label="New action"><select id="naOwner" aria-label="Owner">${ownerOpts()}</select>
        <input type="date" id="naDue" aria-label="Due date"><button class="btn small" id="naAdd">Add</button></div></section>` : ""}
    ${id && entity === "actions" && r.review_id ? `<p class="meta-box"><a href="#/reviews/${r.review_id}">Open the review this came from</a></p>` : ""}
    ${id && r.history?.length ? `<section class="history"><h3>History</h3><ul>${r.history.map((h) => `<li>${esc(h.summary)} <span class="muted">— ${esc(h.user_name)}, ${ago(h.ts)}</span></li>`).join("")}</ul></section>` : ""}
    ${r.meta && typeof r.meta === "object" && Object.keys(r.meta).length ? `<details class="meta-box"><summary>Original import fields</summary><dl>${Object.entries(r.meta).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>` : ""}
    ${id && r.updated_at ? `<p class="meta-box">Last updated ${ago(r.updated_at)}${r.updated_by ? " by " + esc(r.updated_by) : ""}</p>` : ""}`;
  openDrawer();
  $("#saveRec").addEventListener("click", async (e) => {
    const data = Object.fromEntries(new FormData($("#recForm")));
    if (!String(data[ent.title_field] || "").trim() && !(entity === "contacts" && String(data.organization || "").trim())) return toast(`Add a ${fieldLabel(entity, ent.title_field).toLowerCase()} first`);
    e.target.disabled = true;
    try { id ? await db.update(entity, id, data) : await db.create(entity, data); toast(id ? "Saved" : `${ent.singular} added`); closeDrawer(); onSaved && onSaved(); }
    catch (err) { toast(err.message); e.target.disabled = false; }
  });
  $("#delRec")?.addEventListener("click", async () => {
    if (!confirm(`Delete this ${ent.singular.toLowerCase()}? A copy is kept in the activity log, but it can't be restored from here.`)) return;
    try { await db.remove(entity, id); toast("Deleted"); closeDrawer(); onSaved && onSaved(); } catch (err) { toast(err.message); }
  });
  $("#naAdd")?.addEventListener("click", async () => {
    const text = $("#naText").value.trim(); if (!text) return $("#naText").focus();
    try { await db.create("actions", { text, owner: $("#naOwner").value, due_date: $("#naDue").value, status: "Open", linked_type: entity, linked_id: id }); toast("Action added"); openRecord(entity, id, onSaved); }
    catch (err) { toast(err.message); }
  });
  wireCommon($("#drawerBody"), () => openRecord(entity, id, onSaved));
  setTimeout(() => $("#recForm input, #recForm select")?.focus(), 60);
}
function input(f, v) {
  v = v ?? "";
  const n = `name="${f.name}"`;
  if (f.type === "select") { const opts = !v || f.options.includes(v) ? f.options : [v, ...f.options];
    return `<select ${n}><option value=""></option>${opts.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`; }
  if (f.type === "textarea") return `<textarea ${n} rows="5">${esc(v)}</textarea>`;
  const type = { date: "date", number: "number" }[f.type] || "text";
  return `<input ${n} type="${type}" value="${esc(f.type === "date" ? String(v).slice(0, 10) : v)}" ${f.type === "number" ? 'step="any"' : ""}>`;
}
function openDrawer() { const d = $("#drawer"); d.classList.add("open"); d.setAttribute("aria-hidden", "false"); }
function closeDrawer() { const d = $("#drawer"); d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); }
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

/* ================================================================ reviews */
async function Reviews(id) {
  if (id) return ReviewDetail(+id);
  const list = must(await sb.from("reviews").select("id,cadence,review_date,title,attendees").order("review_date", { ascending: false }).order("id", { ascending: false }).limit(300));
  const acts = list.length ? must(await sb.from("actions").select("review_id,status").in("review_id", list.map((r) => r.id))) : [];
  const counts = {};
  acts.forEach((a) => { const c = counts[a.review_id] ||= { n: 0, open: 0 }; c.n++; if (a.status === "Open") c.open++; });
  const last = {};
  list.forEach((r) => { if (!last[r.cadence] || r.review_date > last[r.cadence]) last[r.cadence] = r.review_date; });
  const every = { daily: 1, weekly: 7, monthly: 31, quarterly: 92 };
  const about = { daily: "What moved yesterday, today's priorities, deadlines this week.", weekly: "Close last week's actions, go/no-go on the next 30 days, follow-ups.",
    monthly: "Pipeline by stage, wins and losses, funding decisions, credentials.", quarterly: "Results vs goals, performance by owner, strategy and fundraise." };
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Business reviews</h1><p class="muted">Each review opens with a live snapshot of the pipeline, then you take notes and assign actions.</p></div></div>
    <div class="cadences">${Object.entries(S.schema.cadences).map(([c, cfg]) => {
      const l = last[c]; const late = !l || daysUntil(l) < -every[c];
      return `<div class="cadence"><h2>${cfg.label}</h2><p class="muted" style="margin:0">${about[c]}</p>
        <span class="when ${late ? "late" : ""}">${l ? "Last held " + short(l) : "Not held yet"}</span>
        <button class="btn ${c === "daily" ? "primary" : ""}" data-start="${c}">Start ${cfg.label.toLowerCase()} review</button></div>`; }).join("")}</div>
    <section class="panel"><h2>Past reviews</h2>
      ${list.length ? `<div class="table-wrap" style="border:0"><table><thead><tr><th>Date</th><th>Review</th><th>Type</th><th>Attendees</th><th>Actions</th></tr></thead><tbody>
      ${list.map((r) => { const c = counts[r.id]; return `<tr data-go="${r.id}" tabindex="0"><td class="date">${short(r.review_date)}</td><td style="font-weight:550">${esc(r.title)}</td><td>${esc(cap(r.cadence))}</td>
        <td>${esc(r.attendees || "")}</td><td>${c ? `${c.n}${c.open ? ` (${c.open} open)` : ""}` : ""}</td></tr>`; }).join("")}</tbody></table></div>`
      : `<p class="muted">No reviews yet. Start a daily review above.</p>`}</section>`;
  $$("[data-start]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "Building snapshot…";
    try {
      const c = b.dataset.start, d = today();
      const snapshot = await db.rpc("build_snapshot", { p_cadence: c, p_as_of: d });
      const prevAtt = list.find((r) => r.cadence === c)?.attendees || "";
      const r = must(await sb.from("reviews").insert({ cadence: c, review_date: d, title: `${S.schema.cadences[c].label} review — ${d}`, attendees: prevAtt, snapshot }).select("id").single());
      location.hash = `#/reviews/${r.id}`;
    } catch (err) { toast(err.message); b.disabled = false; }
  }));
  $$("tr[data-go]").forEach((tr) => { tr.addEventListener("click", () => (location.hash = `#/reviews/${tr.dataset.go}`)); tr.addEventListener("keydown", (e) => e.key === "Enter" && tr.click()); });
}

async function reviewActions(id) { return must(await sb.from("actions").select("*").eq("review_id", id).order("status").order("due_date", { nullsFirst: false })); }

async function ReviewDetail(id) {
  const r = must(await sb.from("reviews").select("*").eq("id", id).single());
  const actions = await reviewActions(id);
  const s = r.snapshot;
  const sec = (title, n, body) => `<section class="snap-sec"><h3>${title}${n != null ? ` <span class="c">${n}</span>` : ""}</h3>${body}</section>`;
  const recLi = (entity, x, name, sub, right) => `<li><span><a href="#" data-open="${entity}:${x.id}">${esc(name)}</a>${sub ? `<br><span class="meta">${sub}</span>` : ""}</span><span class="meta">${right}</span></li>`;
  const ul = (items, empty) => items.length ? `<ul class="list">${items.join("")}</ul>` : `<p class="muted">${empty}</p>`;

  let snapHtml = `<p class="muted">This review was imported from the old Word document, so it has no pipeline snapshot. Use “Refresh snapshot” to pull one as of ${short(r.review_date)}.</p>`;
  if (s) {
    const dl = [...s.opp_deadlines.map((x) => ({ ...x, entity: "opportunities", name: x.title, org: x.agency, status: x.stage })),
                ...s.funding_deadlines.map((x) => ({ ...x, entity: "funding", org: x.organization }))].sort((a, b) => a.deadline.localeCompare(b.deadline));
    const span = S.schema.cadences[s.cadence].ahead;
    const R = s.results;
    const sum = (k) => R ? (+R.opportunities[k] || 0) + (+R.funding[k] || 0) : 0;
    const moves = [...s.moves.submitted, ...s.moves.won, ...s.moves.lost];
    snapHtml = `
      <p class="muted" style="margin-top:0">Snapshot as of ${short(s.as_of)} · looking back to ${short(s.since)}, ahead to ${short(s.until)}.</p>
      ${R ? `<div class="stat-row">
        <div><b>${sum("Submitted")}</b><span>Submitted this period</span></div>
        <div><b>${sum("Won")}</b><span>Won</span></div>
        <div><b>${sum("Lost") + sum("Missed")}</b><span>Lost or missed</span></div>
        <div><b>${R.win_rate == null ? "—" : R.win_rate + "%"}</b><span>Win rate</span></div>
        <div><b>${money(R.value_won) || "$0"}</b><span>Contract value won</span></div></div>` : ""}
      ${sec("Carry-over from last review", s.carry_over.length, s.previous_review ? ul(s.carry_over.map((a) => `<li><span>${esc(a.text)}</span><span class="meta">${esc(a.owner || "")}</span></li>`),
          `Everything from <a href="#/reviews/${s.previous_review.id}">${esc(s.previous_review.title)}</a> is closed.`) : `<p class="muted">This is the first ${s.cadence} review.</p>`)}
      ${sec("Overdue actions", s.actions_overdue.length, ul(s.actions_overdue.map((a) => `<li><span>${esc(a.text)}</span><span class="meta">${esc(a.owner || "")} · ${dueCell(a.due_date)}</span></li>`), "None overdue."))}
      ${sec(`Deadlines in the next ${span} days`, dl.length, gauge(dl, span) + ul(dl.map(dueLi), "No deadlines in this window."))}
      ${sec("What moved", moves.length + Object.values(s.created).reduce((a, b) => a + b, 0),
        ul(moves.map((a) => `<li><span><a href="#" data-open="${a.entity}:${a.entity_id}">${esc(a.summary)}</a></span><span class="meta">${esc(a.user_name)} · ${short(a.ts)}</span></li>`)
          .concat(Object.entries(s.created).filter(([, n]) => n).map(([e, n]) => `<li><span>${n} new ${esc(n === 1 ? S.schema.entities[e].singular.toLowerCase() : S.schema.entities[e].label.toLowerCase())} added</span><span class="meta"></span></li>`)),
          "No submissions, wins, losses or new records in this period."))}
      ${sec("Follow-ups due", s.followups_due.length, ul(s.followups_due.slice(0, 15).map((c) => recLi("contacts", c, c.name || c.organization, esc([c.organization, c.next_step].filter(Boolean).join(" · ")), dueCell(c.next_step_date))), "No contact follow-ups due."))}
      ${s.stale_count ? sec("Past deadline with no outcome — update or close", s.stale_count, ul(s.stale.slice(0, 12).map((x) => recLi(x.entity, x, x.name, esc(x.owner || "Unassigned"), short(x.deadline)))
          .concat(s.stale_count > 12 ? [`<li><a href="#/opportunities" data-preset="__stale">See them all</a></li>`] : []), "")) : ""}
      ${s.opp_pipeline ? `<div class="grid2" style="gap:18px">${sec("Opportunity pipeline", null, bars(s.opp_pipeline, "opportunities", "stage"))}
        ${sec("Funding pipeline", null, bars(s.funding_pipeline, "funding", "status"))}</div>` : ""}
      ${s.by_owner ? sec("By owner", null, `<div class="table-wrap"><table><thead><tr><th>Owner</th><th>Active opps</th><th>Active funding</th><th>Submitted</th><th>Won</th></tr></thead><tbody>
        ${s.by_owner.map((o) => `<tr style="cursor:default"><td>${esc(o.owner)}</td><td>${o.active_opps}</td><td>${o.active_funding}</td><td>${o.submitted}</td><td>${o.won}</td></tr>`).join("")}</tbody></table></div>`) : ""}`;
  }
  const ownerOpts = S.owners.map((o) => `<option ${o === firstName() ? "selected" : ""}>${esc(o)}</option>`).join("");
  $("#main").innerHTML = `
    <div class="page-head"><div><p class="muted" style="margin:0 0 4px"><a href="#/reviews">Reviews</a> / ${esc(cap(r.cadence))}</p>
      <h1 contenteditable="true" id="rvTitle" spellcheck="false">${esc(r.title)}</h1></div>
      <div class="actions-row no-print"><button class="btn" id="refresh">Refresh snapshot</button><button class="btn" onclick="window.print()">Print</button>
        <button class="btn danger" id="delReview">Delete</button></div></div>
    <div class="review-layout">
      <div>
        <section class="panel"><h2>Agenda</h2><ol class="agenda">${(S.schema.agendas[r.cadence] || []).map((a) => `<li>${esc(a)}</li>`).join("")}</ol></section>
        <section class="panel"><h2>Pipeline snapshot</h2>${snapHtml}</section>
      </div>
      <div class="review-side">
        <section class="panel"><h2>Notes <span class="save-state" id="saveState"></span></h2>
          <div class="form" style="margin-bottom:10px"><label>Date<input type="date" id="rvDate" value="${esc(r.review_date)}"></label>
            <label>Attendees<input id="rvAtt" value="${esc(r.attendees || "")}" placeholder="Barasa, Sohaib…"></label></div>
          <textarea class="notes-area" id="rvNotes" placeholder="Decisions, updates, blockers…">${esc(r.notes || "")}</textarea></section>
        <section class="panel"><h2>Action items <small id="openCount">${actions.filter((a) => a.status === "Open").length} open</small></h2>
          <div id="rvActions">${actions.map(actionItem).join("") || `<p class="muted">Capture who does what by when.</p>`}</div>
          <div class="add-action no-print"><input id="naText" placeholder="Action…" aria-label="New action">
            <select id="naOwner" aria-label="Owner">${ownerOpts}</select>
            <input type="date" id="naDue" value="${addDays(r.review_date, { daily: 1, weekly: 7, monthly: 30, quarterly: 90 }[r.cadence])}" aria-label="Due date">
            <button class="btn small primary" id="naAdd">Add</button></div></section>
      </div>
    </div>`;
  let tmr;
  const fields = () => ({ notes: $("#rvNotes").value, attendees: $("#rvAtt").value, review_date: $("#rvDate").value || r.review_date, title: $("#rvTitle").textContent.trim() || r.title });
  const save = () => { $("#saveState").textContent = "Saving…"; clearTimeout(tmr);
    tmr = setTimeout(async () => { try { must(await sb.from("reviews").update(fields()).eq("id", id)); $("#saveState").textContent = "Saved"; } catch (e) { $("#saveState").textContent = "Not saved — " + e.message; } }, 700); };
  ["rvNotes", "rvAtt", "rvDate"].forEach((i) => $("#" + i).addEventListener("input", save));
  $("#rvTitle").addEventListener("blur", save);
  $("#rvTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
  $("#refresh").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { const snapshot = await db.rpc("build_snapshot", { p_cadence: r.cadence, p_as_of: fields().review_date });
      must(await sb.from("reviews").update({ ...fields(), snapshot }).eq("id", id)); toast("Snapshot refreshed"); ReviewDetail(id); }
    catch (err) { toast(err.message); e.target.disabled = false; }
  });
  $("#delReview").addEventListener("click", async () => {
    if (!confirm("Delete this review? Its action items are kept.")) return;
    try { must(await sb.from("reviews").delete().eq("id", id)); location.hash = "#/reviews"; } catch (err) { toast(err.message); }
  });
  const refreshActions = async () => { const a = await reviewActions(id); $("#rvActions").innerHTML = a.map(actionItem).join(""); $("#openCount").textContent = `${a.filter((x) => x.status === "Open").length} open`; };
  const addAction = async () => {
    const text = $("#naText").value.trim(); if (!text) return $("#naText").focus();
    try { await db.create("actions", { text, owner: $("#naOwner").value, due_date: $("#naDue").value, status: "Open", review_id: id }); await refreshActions(); $("#naText").value = ""; $("#naText").focus(); }
    catch (err) { toast(err.message); }
  };
  $("#naAdd").addEventListener("click", addAction);
  $("#naText").addEventListener("keydown", (e) => e.key === "Enter" && addAction());
  wireCommon($("#main"), refreshActions);
}

/* ================================================================ activity */
async function Activity() {
  const rows = must(await sb.from("activity").select("*").order("ts", { ascending: false }).limit(300));
  $("#main").innerHTML = `<div class="page-head"><div><h1>Activity log</h1><p class="muted">Every add, edit, status change and delete, newest first.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
    ${rows.map((a) => `<tr ${a.entity_id && S.schema.entities[a.entity] && a.action !== "delete" ? `data-open="${a.entity}:${a.entity_id}"` : 'style="cursor:default"'}>
      <td class="date">${new Date(a.ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td>${esc(a.user_name)}</td><td>${esc(a.summary)}</td></tr>`).join("")
      || `<tr><td colspan="3" class="empty">Nothing yet. Edits show up here as people work.</td></tr>`}</tbody></table></div>`;
  wireCommon($("#main"));
}

/* ================================================================ team */
async function Team() {
  await loadTeam();
  const admin = S.profile.role === "admin";
  let code = "";
  if (admin) { try { code = await db.rpc("get_company_code"); } catch { code = ""; } }
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Team</h1><p class="muted">${admin ? "Share the company code with new teammates. They join from the sign-in page." : "Ask an admin for the company code to invite someone."}</p></div></div>
    ${admin ? `<section class="panel"><h2>Company code</h2>
      <div class="code-box"><b id="code">${esc(code)}</b><button class="btn" id="copyCode">Copy</button><button class="btn" id="newCode">Change code</button></div>
      <p class="muted" style="margin-bottom:0">Changing the code only affects new sign-ups. People already on the team keep their access. Turn someone off below to remove them.</p></section>` : ""}
    <section class="panel"><h2>Members <small>${S.team.filter((p) => p.active).length} active</small></h2>
      <div class="table-wrap" style="border:0"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th>${admin ? "<th></th>" : ""}</tr></thead><tbody>
      ${S.team.map((p) => `<tr style="cursor:default"><td style="font-weight:550">${esc(p.display_name)}${p.id === S.user.id ? ' <span class="muted">(you)</span>' : ""}</td><td>${esc(p.email || "")}</td>
        <td>${p.role === "admin" ? `<span class="pill s-active">Admin</span>` : "Member"}</td><td>${p.active ? pill("Active") : pill("Dropped").replace("Dropped", "Turned off")}</td>
        <td class="date">${short(p.created_at)}</td>
        ${admin ? `<td>${p.id === S.user.id ? "" : `<button class="btn small" data-role="${p.id}" data-to="${p.role === "admin" ? "member" : "admin"}" data-active="${p.active}">${p.role === "admin" ? "Make member" : "Make admin"}</button>
          <button class="btn small ${p.active ? "danger" : ""}" data-toggle="${p.id}" data-role-now="${p.role}" data-active="${p.active}">${p.active ? "Turn off" : "Turn on"}</button>`}</td>` : ""}</tr>`).join("")}
      </tbody></table></div></section>
    <section class="panel"><h2>Your name</h2><div class="add-action" style="grid-template-columns:1fr auto;max-width:420px;margin:0">
      <input id="myName" value="${esc(S.profile.display_name)}" aria-label="Your name"><button class="btn" id="saveName">Save</button></div>
      <p class="muted" style="margin-bottom:0">Your first name is what shows as owner and in the activity log.</p></section>`;
  $("#copyCode")?.addEventListener("click", async () => { await navigator.clipboard.writeText($("#code").textContent); toast("Code copied"); });
  $("#newCode")?.addEventListener("click", async () => {
    if (!confirm("Make a new company code? The old one stops working for new sign-ups.")) return;
    try { $("#code").textContent = await db.rpc("rotate_company_code", { p_code: null }); toast("New code ready"); } catch (e) { toast(e.message); }
  });
  $$("[data-role]").forEach((b) => b.addEventListener("click", async () => {
    try { await db.rpc("set_member", { p_id: b.dataset.role, p_role: b.dataset.to, p_active: b.dataset.active === "true" }); Team(); } catch (e) { toast(e.message); }
  }));
  $$("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
    const on = b.dataset.active === "true";
    if (on && !confirm("Turn this person off? They'll be signed out and lose access right away.")) return;
    try { await db.rpc("set_member", { p_id: b.dataset.toggle, p_role: b.dataset.roleNow, p_active: !on }); Team(); } catch (e) { toast(e.message); }
  }));
  $("#saveName").addEventListener("click", async () => {
    const name = $("#myName").value.trim(); if (!name) return;
    try { must(await sb.from("profiles").update({ display_name: name }).eq("id", S.user.id)); S.profile.display_name = name; $("#whoami").textContent = name; toast("Saved"); await loadTeam(); }
    catch (e) { toast(e.message); }
  });
}

boot();
