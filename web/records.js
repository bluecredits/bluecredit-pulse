/* Pulse — records engine shared by the Business Review, Contacts and Funding apps.
   Each app's index.html sets window.PULSE_APP (its home page) and its own sidebar; pages that belong
   to another app open there. Shared helpers and sign-in come from core.js. No build step. */
"use strict";
S.schema = window.PULSE_SCHEMA;

/* ================================================================ data layer (Supabase) */

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

Object.assign(db, {
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
});

async function afterSignIn() {
  const who = await requireMember(); if (!who) return;
  if (!isStaffRole(who.profile.role)) { location.replace(HUB); return; }  // business records are staff-only
  await loadTeam();
  showShell();
  route();
}


async function loadTeam() {
  S.team = must(await sb.from("profiles").select("*").order("display_name"));
  applyWorkspaceLists();
}
// This workspace's drop-down lists, agendas and owner names (starter pack + the admin's changes)
function applyWorkspaceLists() {
  const W = workspaceSettings(S.workspace);
  S.ws = W;
  for (const [key, list] of Object.entries(W.lists)) {
    const [entity, field] = key.split(".");
    const f = S.schema.entities[entity]?.fields.find((x) => x.name === field);
    if (f && Array.isArray(list) && list.length) f.options = list;
  }
  S.schema.agendas = W.agendas;
  // owner drop-downs: extra names the admin listed, plus everyone who has joined
  const names = new Set(W.owners);
  S.team.filter((p) => p.active).forEach((p) => names.add(p.display_name.split(" ")[0]));
  S.owners = [...names];
  for (const ent of Object.values(S.schema.entities)) for (const f of ent.fields) if (f.name === "owner") f.options = S.owners;
}

async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  afterSignIn().catch((e) => { $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; showShell(); });
}

/* ================================================================ status styling */

/* ================================================================ router */
const routes = { dashboard: Dashboard, reviews: Reviews, activity: Activity, team: Team, settings: () => WorkspaceSettings(), billing: () => (typeof Billing === "function" ? Billing() : null) };
// which app owns each page; anything not listed lives in Business Review
const OWNER = { contacts: "contacts", funding: "funding", team: "admin", settings: "admin", billing: "admin" };
const HERE = location.pathname.replace(/\/index\.html$/, "/").replace(/\/$/, "").split("/").pop();
const HOME = (window.PULSE_APP && window.PULSE_APP.home) || "dashboard";
let navPick = null;  // the sidebar link clicked last (several can point at one page with different views)
window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  const a = e.target.closest("#nav a[data-preset]");
  if (!a) return;
  sessionStorage.setItem("preset:" + a.dataset.r, a.dataset.preset);
  navPick = a;
  if (location.hash === a.getAttribute("href")) { e.preventDefault(); route(); }
});
function route() {
  if (!S.profile) return;
  const [part, id] = location.hash.replace(/^#\/?/, "").split("/");
  const name = part || HOME;
  const app = OWNER[name] || "review";
  if (app !== HERE) { location.href = `../${app}/#/${name}${id ? "/" + id : ""}`; return; }
  const links = $$("#nav a[data-r]");
  const on = navPick?.dataset.r === name ? navPick : links.find((a) => a.dataset.r === name);
  links.forEach((a) => a.classList.toggle("on", a === on));
  document.body.classList.remove("nav-open");
  closeDrawer();
  const main = $("#main");
  main.innerHTML = `<p class="muted">Loading…</p>`;
  const fn = routes[name] || (S.schema.entities[name] ? () => ListPage(name).then(() => { if (/^\d+$/.test(id || "")) openRecord(name, +id, () => ListPage(name)); }) : routes[HOME] || (() => ListPage(HOME)));
  Promise.resolve(fn(id)).catch((e) => (main.innerHTML = `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  main.focus({ preventScroll: true });
}

/* ================================================================ dashboard */
async function Dashboard() {
  const d = await db.rpc("dashboard_data", { p_owner: firstName() });
  const k = d.kpis, last = d.last_reviews || {};
  const h = new Date().getHours();
  // only what needs you this week: overdue or due within 7 days, soonest first
  const mine = [...d.my_actions].sort((x, y) => (x.due_date || "9999").localeCompare(y.due_date || "9999"));
  // the same action given in several reviews shows once
  const seen = new Set();
  const urgent = mine.filter((a) => a.due_date && daysUntil(a.due_date) <= 7)
    .filter((a) => { const k = `${a.text}`.trim().toLowerCase() + "|" + a.due_date; if (seen.has(k)) return false; seen.add(k); return true; });
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${esc(firstName())}</h1>
      <p class="muted">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p></div>
      <div class="actions-row"><a class="btn primary" href="#/reviews">Start today's review</a></div></div>
    <div class="kpis">
      ${kpiCard("#/opportunities", "", "Active opportunities", k.active_opps, "Identified → submitted", "briefcase")}
      ${kpiCard("#/funding", "", "Active funding", k.active_funding, "Applications in progress", "banknotes")}
      ${kpiCard("#/opportunities", "stage=Submitted", "Awaiting decision", k.submitted, "Submitted, no outcome yet", "send")}
      ${kpiCard("#/opportunities", "stage=Won", "Won", k.won, "Opportunities and funding", "trophy")}
      ${kpiCard("#/actions", "", "Open actions", k.open_actions, k.overdue_actions ? `${k.overdue_actions} overdue` : "None overdue", k.overdue_actions ? "alert" : "check", k.overdue_actions > 0)}
      ${kpiCard("#/contacts", "__followups", "Follow-ups due", k.followups_due, "Contacts with a next step due", "users", k.followups_due > 0)}
    </div>
    <section class="panel"><h2>Next 14 days <small>${d.due_soon.length} deadline${d.due_soon.length === 1 ? "" : "s"}</small></h2>${gauge(d.due_soon, 14)}
      ${d.due_soon.length ? `<ul class="list">${d.due_soon.map(dueLi).join("")}</ul>` : `<p class="muted">No deadlines in the next two weeks. Qualify something from the forecasts.</p>`}</section>
    <div class="grid2">
      <div>
        <section class="panel"><h2>My actions due this week <small><a href="#/actions">All actions</a></small></h2>
          ${urgent.length ? urgent.slice(0, 5).map(actionItem).join("") : `<p class="muted">Nothing of yours is due in the next 7 days.</p>`}
          ${mine.length > Math.min(urgent.length, 5) ? `<p class="meta" style="margin:8px 0 0"><a href="#/actions">${mine.length - Math.min(urgent.length, 5)} more open action${mine.length - Math.min(urgent.length, 5) === 1 ? "" : "s"} →</a></p>` : ""}</section>
        <section class="panel"><h2>Review rhythm</h2><ul class="list">
          ${Object.entries(S.schema.cadences).map(([c, cfg]) => { const l = last[c]; const late = !l || daysUntil(l) < -{ daily: 1, weekly: 7, monthly: 31, quarterly: 92 }[c];
            return `<li><span>${cfg.label}</span><span class="meta ${late ? "due-over" : ""}">${l ? "Last " + short(l) : "Not run yet"}</span></li>`; }).join("")}</ul></section>
      </div>
      <div>
        <section class="panel"><h2>Opportunities by stage</h2>${bars(d.opp_by_stage, "opportunities", "stage")}</section>
        <section class="panel"><h2>Funding pipeline</h2>${bars(d.funding_by_status, "funding", "status")}</section>
      </div>
    </div>`;
  wireCommon($("#main"), Dashboard);
}
function kpiCard(href, preset, label, value, sub, icon, alert = false) {
  return `<a class="kpi ${alert ? "alert" : ""}" href="${href}" ${preset ? `data-preset="${esc(preset)}"` : ""}>
    <div><span>${esc(label)}</span><b>${Number(value).toLocaleString()}</b><small>${esc(sub)}</small></div>
    <div class="bubble"><svg class="ic"><use href="#i-${icon}"/></svg></div></a>`;
}
function dueLi(r) {
  return `<li><span><a href="#" data-open="${r.entity}:${r.id}">${esc(r.name)}</a><br><span class="meta">${r.entity === "funding" ? "Funding" : "Opportunity"}${r.org ? " · " + esc(r.org) : ""}${r.owner ? " · " + esc(r.owner) : ""}</span></span>
    <span class="meta">${dueCell(r.deadline)}<br>${pill(r.status)}</span></li>`;
}
function gauge(items, span) {
  if (!items.length) return "";
  const ticks = span <= 14 ? [0, 3, 7, span] : span <= 30 ? [0, 7, 14, span] : [0, Math.round(span / 4), Math.round(span / 2), Math.round(span * 3 / 4), span];
  const wk = Math.min(100, (7 / span) * 100), urgent = Math.min(100, (1 / span) * 100);
  const track = `background:linear-gradient(90deg,var(--red) 0 ${urgent}%,var(--amber) ${urgent}% ${wk}%,var(--blue-5) ${wk}% 100%)`;
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
  contacts: [["Working contacts", "__working"], ["Follow-ups due", "__followups"], ["All", ""]],
  actions: [["Open", "status=Open"], ["Done", "status=Done"], ["All", ""]],
  resources: [["All", ""]],
};
function presetParams(key) {
  const t = today();
  if (key === "__due30") return { stage: "Identified|Qualifying|Pursuing|Submitted", deadline__gte: t, deadline__lte: addDays(t, 30) };
  if (key === "__stale") return { stage: "Identified|Qualifying|Pursuing", deadline__lte: addDays(t, -1) };
  if (key === "__catalogopen") return { status: "Catalog", deadline__gte: t };
  if (key === "__working") return S.ws?.working_exclude?.length ? { category__not: S.ws.working_exclude.join("|") } : {};
  if (key === "__followups") return { next_step_date__lte: t, status__not: "Do Not Contact|Dormant" };
  return Object.fromEntries(new URLSearchParams(key));
}

async function ListPage(entity) {
  const ent = S.schema.entities[entity];
  const st = LIST_STATE[entity] ||= { q: "", preset: PRESETS[entity][0][1], extra: {}, sort: "", offset: 0 };
  const pre = sessionStorage.getItem("preset:" + entity);
  if (pre !== null) {
    sessionStorage.removeItem("preset:" + entity); st.offset = 0; st.q = "";
    if (PRESETS[entity].some(([, v]) => v === pre)) { st.preset = pre; st.extra = {}; }
    else { st.preset = ""; st.extra = presetParams(pre); }
  }
  const views = $$(`#nav a[data-r="${entity}"][data-preset]`);  // sidebar links that are views of this list
  if (views.length) views.forEach((v) => v.classList.toggle("on", v.dataset.preset === st.preset));
  const facets = ent.fields.filter((f) => f.type === "select" && f.name !== ent.status_field).slice(0, 2);
  if (ent.status_field) facets.unshift(ent.fields.find((f) => f.name === ent.status_field));

  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${esc(ent.label)}</h1></div>
      <div class="actions-row no-print">
        ${entity === "contacts" ? `<button class="btn" id="importContacts">Import contacts</button>`
          : `<label class="btn">Import file<input type="file" accept=".csv,.tsv,.xlsx" id="importCsv" hidden></label>`}
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
  $("#importContacts")?.addEventListener("click", () => openContactImport(load));
  $("#importCsv")?.addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { const book = await readSheetFile(file); const n = await importRows(entity, book.sheets[0].rows); toast(`Imported ${n} rows`); load(); }
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
async function importRows(entity, all) {
  const [head, ...rows] = all.filter((r) => r.some((x) => String(x ?? "").trim() !== ""));
  if (!head) throw new Error("The file is empty.");
  const byLabel = Object.fromEntries(fieldDefs(entity).flatMap((f) => [[f.name.toLowerCase(), f.name], [f.label.toLowerCase(), f.name]]));
  const map = head.map((h) => byLabel[String(h).trim().toLowerCase()]);
  if (!map.some(Boolean)) throw new Error("None of the column headers match this list's fields.");
  const records = rows.map((r) => clean(entity, Object.fromEntries(map.map((k, i) => [k, r[i] ?? ""]).filter(([k]) => k))))
    .filter((r) => Object.values(r).some((v) => v != null));
  for (let i = 0; i < records.length; i += 500) must(await sb.from(entity).insert(records.slice(i, i + 500)));
  return records.length;
}

/* ---------------- spreadsheet reader (.xlsx, .csv, .tsv) — no external library */

/* ---------------- contact import: map columns, tidy values, merge against the list */
const CI_FIELDS = [["name", "Full name"], ["first", "First name"], ["last", "Last name"], ["organization", "Organization"], ["email", "Email"],
  ["phone", "Phone"], ["role", "Role / title"], ["city", "City"], ["state", "State"], ["zip", "ZIP code"], ["country", "Country"],
  ["location", "Location / address"], ["linkedin", "LinkedIn"], ["notes", "Add to notes"], ["ignore", "Don't import"]];
const US_STATES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR" };
const ABBR = new Set(Object.values(US_STATES));
function tidyState(v) { v = tidy(v); const k = v.toLowerCase().replace(/\./g, ""); return US_STATES[k] || (ABBR.has(k.toUpperCase()) ? k.toUpperCase() : v); }
function tidyZip(v) { v = tidy(v); return /^\d{4}$/.test(v) ? "0" + v : /^\d{9}$/.test(v) ? v.slice(0, 5) + "-" + v.slice(5) : v; }
function tidyPhone(v) {
  v = tidy(v); const d = v.replace(/\D/g, "");
  const ten = d.length === 10 ? d : d.length === 11 && d[0] === "1" ? d.slice(1) : null;
  return ten && !/^\+(?!1)/.test(v) ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : v;
}
function tidyName(v) { v = tidy(v); return v === v.toUpperCase() && /[A-Z]{2}/.test(v) ? v.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : v; }
function prettyHeader(h) {
  h = tidy(h); if (h !== h.toUpperCase()) return h;
  return h.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()).replace(/\b(naics|uei|cage|sam|duns|zip|usa|llc|poc)\b/gi, (w) => w.toUpperCase());
}
function toContacts(head, rows, map, opts) {
  const EM = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
  return rows.map((r) => {
    const by = {};
    map.forEach((f, i) => { const v = tidy(r[i]); if (v && f !== "ignore") (by[f] ||= []).push(f === "notes" ? `${prettyHeader(head[i])}: ${v}` : v); });
    const emails = (by.email || []).join(" ").match(EM) || [];
    const name = tidy([by.name?.join(" "), by.name ? "" : [by.first?.join(" "), by.last?.join(" ")].filter(Boolean).join(" ")].filter(Boolean).join(" "));
    const place = [by.city?.[0], [by.state ? tidyState(by.state[0]) : "", by.zip ? tidyZip(by.zip[0]) : ""].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const country = by.country?.[0] && !/^(us|usa|united states( of america)?)$/i.test(by.country[0]) ? by.country[0] : "";
    const notes = [...(by.notes || [])];
    if (emails.length > 1) notes.push("Other emails: " + emails.slice(1).join(", "));
    const email = (emails[0] || "").toLowerCase();
    let category = opts.category;
    if (opts.autoGov && /\.(gov|mil)$/i.test(email)) category = "Government";
    else if (opts.autoGov && /\.edu$/i.test(email)) category = "Academic";
    return { name: tidyName(name), organization: tidy(by.organization?.join(" / ")), email, phone: (by.phone || []).map(tidyPhone).join(" / "),
      role: tidy(by.role?.join(" / ")), location: [by.location?.join(", "), place, country].filter(Boolean).join(" · "), linkedin: by.linkedin?.[0] || "",
      notes: notes.join("; "), category, status: opts.status, owner: opts.owner, source: opts.label };
  }).filter((c) => c.name || c.organization || c.email);
}
// people who appear more than once in the same file (same email) become one row: first value wins, notes are combined
function combineDuplicates(list) {
  const out = [], byEmail = new Map();
  for (const c of list) {
    const prev = c.email && byEmail.get(c.email);
    if (!prev) { out.push({ ...c }); if (c.email) byEmail.set(c.email, out[out.length - 1]); continue; }
    for (const k of Object.keys(c)) if (!prev[k] && c[k]) prev[k] = c[k];
    if (c.notes && !prev.notes.includes(c.notes)) prev.notes = [prev.notes, c.notes].filter(Boolean).join("; ");
    if (c.organization && prev.organization.toLowerCase() !== c.organization.toLowerCase() && !prev.notes.includes(c.organization))
      prev.notes = [prev.notes, "Also listed as: " + c.organization].filter(Boolean).join("; ");
    prev._dups = (prev._dups || 0) + 1;
  }
  return out;
}
function labelFromFile(fname) {
  const base = fname.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  let s = base.replace(/\s*\d+\s*-\s*\d+$/, "").replace(/(?<=[a-z])\d+$/i, "");
  for (let prev = ""; prev !== s; ) { prev = s; s = s.replace(/\s+(registrations?|registrants?|attendees?|attendance|sign ?ups?|signups?|list|export|final|copy|contacts?)$/i, "").trim(); }
  s = s || base;
  if (base === base.toUpperCase()) s = s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Hnc|Usace|Epa|Deq|Gsa|Sba|Dod|Doe|Usda|Noaa|Sbic|Awwa|Wef|Asce|Apex|Naics|Osdbu|Faa|Dot|Fema|Nasa|Dla)\b/g, (w) => w.toUpperCase());
  return s;
}

function openContactImport(onDone) {
  const ent = S.schema.entities.contacts;
  const opt = (name) => ent.fields.find((f) => f.name === name).options;
  $("#drawerTitle").textContent = "Import contacts";
  $("#drawerBody").innerHTML = `
    <p class="muted" style="margin-top:0">Upload a sign-up sheet, attendee list or any spreadsheet of people. Columns are matched automatically, and anyone already in your list is updated instead of duplicated.</p>
    <label class="btn primary" style="justify-self:start">Choose a file (.xlsx or .csv)<input type="file" id="ciFile" accept=".xlsx,.csv,.tsv" hidden></label>
    <div id="ciBody"></div>`;
  openDrawer();
  $("#ciFile").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    $("#ciBody").innerHTML = `<p class="muted">Reading ${esc(file.name)}…</p>`;
    let book;
    try { book = await readSheetFile(file); } catch (err) { $("#ciBody").innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
    const state = { book, file, sheet: book.sheets.findIndex((s) => s.rows.length > 1), opts: { category: "Partner", autoGov: true, status: "To Contact", owner: "", label: labelFromFile(file.name) } };
    if (state.sheet < 0) state.sheet = 0;
    renderMapping(state, onDone);
  });
}
function renderMapping(st, onDone) {
  const sheet = st.book.sheets[st.sheet];
  const hr = findHeaderRow(sheet.rows);
  const head = sheet.rows[hr] || [], body = sheet.rows.slice(hr + 1).filter((r) => r.some((x) => tidy(x)));
  st.head = head; st.body = body;
  st.map ||= {}; const key = st.sheet;
  st.map[key] ||= head.map(guessField);
  const map = st.map[key];
  const sample = (i) => tidy(body.find((r) => tidy(r[i]))?.[i] || "");
  const ent = S.schema.entities.contacts, opts = (n) => ent.fields.find((f) => f.name === n).options;
  const raw = toContacts(head, body, map, st.opts), contacts = combineDuplicates(raw);
  const withEmail = contacts.filter((c) => c.email).length, dupes = raw.length - contacts.length;
  $("#ciBody").innerHTML = `
    ${st.book.sheets.length > 1 ? `<label style="margin-top:14px">Sheet<select id="ciSheet">${st.book.sheets.map((s, i) => `<option value="${i}" ${i === st.sheet ? "selected" : ""}>${esc(s.name)} (${Math.max(0, s.rows.length - 1).toLocaleString()} rows)</option>`).join("")}</select></label>` : ""}
    <section class="history"><h3>${contacts.length.toLocaleString()} people found <span class="muted" style="font-weight:500">· ${withEmail.toLocaleString()} with an email${dupes ? ` · ${dupes} listed twice, combined` : ""}</span></h3>
      <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Column in your file</th><th>Example</th><th>Goes into</th></tr></thead><tbody>
      ${head.map((h, i) => `<tr style="cursor:default"><td style="font-weight:600">${esc(tidy(h) || `Column ${i + 1}`)}</td><td class="wrap"><span class="clip muted">${esc(sample(i))}</span></td>
        <td><select data-col="${i}" aria-label="Field for ${esc(tidy(h))}">${CI_FIELDS.map(([v, l]) => `<option value="${v}" ${map[i] === v ? "selected" : ""}>${l}</option>`).join("")}</select></td></tr>`).join("")}
      </tbody></table></div></section>
    <section class="history"><h3>Apply to everyone in this file</h3>
      <div class="form" style="margin-top:8px">
        <label class="full">Tag (shows where they came from)<input id="ciLabel" value="${esc(st.opts.label)}"></label>
        <label>Category<select id="ciCat">${opts("category").map((o) => `<option ${o === st.opts.category ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>
        <label>Status<select id="ciStatus">${opts("status").map((o) => `<option ${o === st.opts.status ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>
        <label>Owner<select id="ciOwner"><option value=""></option>${S.owners.map((o) => `<option ${o === st.opts.owner ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" id="ciAuto" style="width:auto" ${st.opts.autoGov ? "checked" : ""}>.gov / .mil emails → Government, .edu → Academic</label>
      </div></section>
    <section class="history"><h3>Preview</h3>
      <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Name</th><th>Organization</th><th>Email</th><th>Phone</th><th>Location</th></tr></thead><tbody>
      ${contacts.slice(0, 5).map((c) => `<tr style="cursor:default"><td>${esc(c.name)}</td><td>${esc(c.organization)}</td><td>${esc(c.email)}</td><td class="date">${esc(c.phone)}</td><td>${esc(c.location)}</td></tr>`).join("")}
      </tbody></table></div>
      ${contacts[0]?.notes ? `<p class="muted" style="font-size:12.5px;margin:6px 0 0">Notes for the first person: ${esc(contacts[0].notes)}</p>` : ""}</section>
    <div class="form-foot"><button class="btn primary" id="ciGo" ${contacts.length ? "" : "disabled"}>Import ${contacts.length.toLocaleString()} ${contacts.length === 1 ? "person" : "people"}</button>
      <button class="btn" data-close>Cancel</button><span class="spacer"></span></div>
    <p id="ciResult" class="notice"></p>`;
  const reopts = () => { st.opts = { category: $("#ciCat").value, autoGov: $("#ciAuto").checked, status: $("#ciStatus").value, owner: $("#ciOwner").value, label: $("#ciLabel").value.trim() }; };
  $("#ciSheet")?.addEventListener("change", (e) => { reopts(); st.sheet = +e.target.value; renderMapping(st, onDone); });
  $$("[data-col]").forEach((s) => s.addEventListener("change", () => { map[+s.dataset.col] = s.value; reopts(); renderMapping(st, onDone); }));
  ["ciCat", "ciStatus", "ciOwner", "ciAuto"].forEach((id) => $("#" + id).addEventListener("change", () => { reopts(); renderMapping(st, onDone); }));
  $("#ciLabel").addEventListener("change", reopts);
  $("#ciGo").addEventListener("click", async (e) => {
    reopts();
    const rows = combineDuplicates(toContacts(st.head, st.body, map, st.opts)).map(({ _dups, ...c }) => c);
    e.target.disabled = true;
    const tot = { added: 0, merged: 0, skipped: 0 };
    try {
      for (let i = 0; i < rows.length; i += 500) {
        e.target.textContent = `Importing ${Math.min(i + 500, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}…`;
        const r = await db.rpc("import_contacts", { p_rows: rows.slice(i, i + 500), p_label: st.opts.label || null });
        tot.added += r.added; tot.merged += r.merged; tot.skipped += r.skipped;
      }
      e.target.textContent = "Imported";
      $("#ciResult").textContent = `Done: ${tot.added.toLocaleString()} new contact${tot.added === 1 ? "" : "s"} added, ${tot.merged.toLocaleString()} already in your list (new details added to them). Tagged “${st.opts.label}”.`;
      toast(`Imported ${tot.added + tot.merged} people`);
      onDone && onDone();
    } catch (err) { e.target.disabled = false; e.target.textContent = "Try again"; $("#ciResult").className = "error"; $("#ciResult").textContent = "Import stopped: " + err.message; }
  });
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

// ---- review snapshot: a summary strip, then the review in the order it is run ----
// Lists show the first few rows; the rest open with "Show N more" (and always print).
function snapList(items, limit = 5) {
  if (!items.length) return "";
  const rest = items.slice(limit);
  return `<ul class="list snap-list">${items.slice(0, limit).join("")}${rest.map((li) => li.replace("<li", "<li hidden data-more")).join("")}</ul>` +
    (rest.length ? `<button type="button" class="link-btn snap-more no-print" data-more-btn>Show ${rest.length} more</button>` : "");
}
function snapSec({ id, title, n, hint, body, clear, tone = "" }) {
  if (!n) return `<p class="snap-clear" id="snap-${id}"><span aria-hidden="true">✓</span> ${clear}</p>`;
  return `<section class="snap-sec ${tone}" id="snap-${id}"><h3>${title} <span class="c">${n}</span></h3>${hint ? `<p class="snap-hint">${hint}</p>` : ""}${body}</section>`;
}
// New leads from the Opportunities app (SAM.gov, Grants.gov, MyBidMatch) that nobody has sorted yet
function leadsBody(s) {
  if (!s.leads) return { total: 0, body: "" };
  const SRCS = [["SAM.gov", "Contracts · SAM.gov", "contracts"], ["BidMatch", "Contracts · APEX BidMatch", "contracts/bids"], ["Grants.gov", "Grants · Grants.gov", "grants"]];
  let total = 0;
  const body = SRCS.map(([k, label, tab]) => { const L = s.leads[k]; if (!L || !(L.new + L.saved)) return "";
    total += L.new + L.saved;
    const rows = L.items.map((x) => `<li><span><a href="${esc(x.url || "../opportunities/#/" + tab)}" target="_blank" rel="noopener">${esc(x.title)}</a><br><span class="meta">${esc([x.level, x.agency, x.naics && "NAICS " + x.naics, x.status === "Saved" ? "saved" : ""].filter(Boolean).join(" · "))}</span></span>
        <span class="meta">${x.due ? dueCell(String(x.due).slice(0, 10)) : "no due date"}</span></li>`);
    return `<div class="lead-src"><h4><span>${label}</span><span class="meta">${L.new} new${L.saved ? ` · ${L.saved} saved` : ""}${L.due_soon ? ` · <b class="due-soon">${L.due_soon} due soon</b>` : ""}</span>
        <a class="no-print" href="../opportunities/#/${tab}">Sort all ${L.new + L.saved} →</a></h4>${snapList(rows, 3)}</div>`; }).join("");
  return { total, body };
}
async function ReviewDetail(id) {
  const r = must(await sb.from("reviews").select("*").eq("id", id).single());
  const actions = await reviewActions(id);
  const s = r.snapshot;
  const sec = (title, n, body) => `<section class="snap-sec"><h3>${title}${n != null ? ` <span class="c">${n}</span>` : ""}</h3>${body}</section>`;
  const recLi = (entity, x, name, sub, right) => `<li><span><a href="#" data-open="${entity}:${x.id}">${esc(name)}</a>${sub ? `<br><span class="meta">${sub}</span>` : ""}</span><span class="meta">${right}</span></li>`;
  const step = (n, title, sub, html) => html.trim() ? `<div class="snap-group"><h3 class="snap-step"><span class="num">${n}</span>${title}<small>${sub}</small></h3>${html}</div>` : "";

  let snapHtml = `<p class="muted">This review was imported from the old Word document, so it has no snapshot. Use “Refresh snapshot” to pull one as of ${short(r.review_date)}.</p>`;
  if (s) {
    const dl = [...s.opp_deadlines.map((x) => ({ ...x, entity: "opportunities", name: x.title, org: x.agency, status: x.stage })),
                ...s.funding_deadlines.map((x) => ({ ...x, entity: "funding", org: x.organization }))].sort((a, b) => a.deadline.localeCompare(b.deadline));
    const span = S.schema.cadences[s.cadence].ahead;
    const R = s.results;
    const sum = (k) => R ? (+R.opportunities[k] || 0) + (+R.funding[k] || 0) : 0;
    const moves = [...s.moves.submitted, ...s.moves.won, ...s.moves.lost];
    const created = Object.entries(s.created).filter(([, n]) => n);
    const leads = leadsBody(s);
    // carry-over and overdue are often the same action: show each once
    const carryIds = new Set(s.carry_over.map((a) => a.id));
    const acts = [...s.carry_over, ...s.actions_overdue.filter((a) => !carryIds.has(a.id))]
      .sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
    const overdue = acts.filter((a) => a.due_date && daysUntil(a.due_date) < 0).length;
    const soon = dl.filter((x) => daysUntil(x.deadline) <= 7).length;
    const stale = s.stale_count || 0;
    const tiles = [
      ["leads", "New leads to sort", leads.total, leads.total ? "info" : ""],
      ["deadlines", `Deadlines, next ${span} days`, dl.length, soon ? "warn" : dl.length ? "info" : "", soon ? `${soon} within 7 days` : ""],
      ["actions", "Open actions", acts.length, overdue ? "alert" : acts.length ? "info" : "", overdue ? `${overdue} overdue` : ""],
      ["stale", "Past deadline, no outcome", stale, stale ? "warn" : ""],
      ["followups", "Follow-ups due", s.followups_due.length, s.followups_due.length ? "info" : ""],
    ];
    const decide = snapSec({ id: "leads", title: "New leads", n: leads.total, hint: "Add each to the pipeline or dismiss it in Opportunities.", body: leads.body,
        clear: s.leads ? "No new contract, grant or bid matches." : "Opportunities app not set up yet." })
      + snapSec({ id: "deadlines", title: `Deadlines in the next ${span} days`, n: dl.length, tone: soon ? "warn" : "",
        hint: "Go / no-go on each. Anything inside 7 days needs an owner and a plan today.", body: gauge(dl, span) + snapList(dl.map(dueLi)),
        clear: `No deadlines in the next ${span} days.` });
    const close = snapSec({ id: "actions", title: "Open actions", n: acts.length, tone: overdue ? "alert" : "",
        hint: s.previous_review ? `Carried over from <a href="#/reviews/${s.previous_review.id}">${esc(s.previous_review.title)}</a> plus anything overdue. Close them or give them a new date.` : "Overdue action items. Close them or give them a new date.",
        body: snapList(acts.map((a) => `<li><span><a href="#" data-open="actions:${a.id}">${esc(a.text)}</a>${carryIds.has(a.id) ? `<br><span class="meta">from last review</span>` : ""}</span>
          <span class="meta">${esc(a.owner || "Unassigned")}${a.due_date ? " · " + dueCell(a.due_date) : ""}</span></li>`)),
        clear: s.previous_review ? "No open or overdue actions." : `No overdue actions. This is the first ${esc(s.cadence)} review.` })
      + snapSec({ id: "stale", title: "Past deadline, no outcome", n: stale, tone: "warn",
        hint: "The deadline passed but nobody recorded what happened. Set each to Submitted, Lost, Missed or Not qualified.",
        body: snapList(s.stale.slice(0, 12).map((x) => recLi(x.entity, x, x.name, esc(x.owner || "Unassigned"), short(x.deadline))), 5)
          + (stale > 12 ? `<p class="meta no-print"><a href="#/opportunities" data-preset="__stale">Open all ${stale} in Opportunities →</a></p>` : ""),
        clear: "Every past deadline has an outcome." })
      + snapSec({ id: "followups", title: "Follow-ups due", n: s.followups_due.length, hint: "Reach out, or move the follow-up date.",
        body: snapList(s.followups_due.slice(0, 15).map((c) => recLi("contacts", c, c.name || c.organization, esc([c.organization, c.next_step].filter(Boolean).join(" · ")), dueCell(c.next_step_date)))),
        clear: "No contact follow-ups due." });
    const moved = moves.length + created.reduce((a, [, n]) => a + n, 0);
    const look = (R ? `<div class="stat-row">
        <div><b>${sum("Submitted")}</b><span>Submitted</span></div>
        <div><b>${sum("Won")}</b><span>Won</span></div>
        <div><b>${sum("Lost") + sum("Missed")}</b><span>Lost or missed</span></div>
        <div><b>${R.win_rate == null ? "—" : R.win_rate + "%"}</b><span>Win rate</span></div>
        <div><b>${money(R.value_won) || "$0"}</b><span>Value won</span></div></div>` : "")
      + snapSec({ id: "moved", title: "What moved", n: moved, body: snapList(moves.map((a) => `<li><span><a href="#" data-open="${a.entity}:${a.entity_id}">${esc(a.summary)}</a></span><span class="meta">${esc(a.user_name)} · ${short(a.ts)}</span></li>`)
          .concat(created.map(([e, n]) => `<li><span>${n} new ${esc(n === 1 ? S.schema.entities[e].singular.toLowerCase() : S.schema.entities[e].label.toLowerCase())} added</span><span class="meta"></span></li>`))),
        clear: "No submissions, wins, losses or new records." })
      + (s.opp_pipeline ? `<div class="grid2" style="gap:18px">${sec("Opportunity pipeline", null, bars(s.opp_pipeline, "opportunities", "stage"))}
        ${sec("Funding pipeline", null, bars(s.funding_pipeline, "funding", "status"))}</div>` : "")
      + (s.by_owner ? sec("By owner", null, `<div class="table-wrap"><table><thead><tr><th>Owner</th><th>Active opps</th><th>Active funding</th><th>Submitted</th><th>Won</th></tr></thead><tbody>
        ${s.by_owner.map((o) => `<tr style="cursor:default"><td>${esc(o.owner)}</td><td>${o.active_opps}</td><td>${o.active_funding}</td><td>${o.submitted}</td><td>${o.won}</td></tr>`).join("")}</tbody></table></div>`) : "");
    snapHtml = `
      <p class="muted snap-range">As of ${short(s.as_of)} · looking back to ${short(s.since)} and ahead to ${short(s.until)}</p>
      <div class="snap-tiles">${tiles.map(([k, label, n, tone, sub]) => `<a href="#" class="snap-tile ${tone}" data-jump="snap-${k}"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</a>`).join("")}</div>
      ${step(1, "Decide", "new leads and upcoming deadlines", decide)}
      ${step(2, "Clean up", "actions, missing outcomes and follow-ups", close)}
      ${step(3, "Look back", `since ${short(s.since)}`, look)}`;
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
        <section class="panel snapshot"><h2>Snapshot</h2>${snapHtml}</section>
      </div>
      <div class="review-side">
        <section class="panel"><h2>Notes <span class="save-state" id="saveState"></span></h2>
          <div class="form" style="margin-bottom:10px"><label>Date<input type="date" id="rvDate" value="${esc(r.review_date)}"></label>
            <label>Attendees<input id="rvAtt" value="${esc(r.attendees || "")}" placeholder="Names of who attended"></label></div>
          <textarea class="notes-area" id="rvNotes" placeholder="Decisions, updates, blockers…">${esc(r.notes || "")}</textarea></section>
        <section class="panel"><h2>Action items <small id="openCount">${actions.filter((a) => a.status === "Open").length} open</small></h2>
          <div id="rvActions">${actions.map(actionItem).join("") || `<p class="muted">Capture who does what by when.</p>`}</div>
          <div class="add-action no-print"><input id="naText" placeholder="Action…" aria-label="New action">
            <select id="naOwner" aria-label="Owner">${ownerOpts}</select>
            <input type="date" id="naDue" value="${addDays(r.review_date, { daily: 1, weekly: 7, monthly: 30, quarterly: 90 }[r.cadence])}" aria-label="Due date">
            <button class="btn small primary" id="naAdd">Add</button></div></section>
      </div>
    </div>`;
  if (!$("#main")._snapWired) ($("#main")._snapWired = true) && $("#main").addEventListener("click", (e) => {
    const j = e.target.closest("[data-jump]");
    if (j) { e.preventDefault(); document.getElementById(j.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const m = e.target.closest("[data-more-btn]");
    if (m && m.previousElementSibling) { m.previousElementSibling.querySelectorAll("[data-more]").forEach((li) => (li.hidden = false)); m.remove(); }
  });
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

/* ================================================================ team and access */
// Who can sign in and what each person sees. Three ways in: the company code (members: every app), the employee code
// (the employee portal) and the contractor code (the portal, free). Admins change anyone's role here.
const ROLE_SEES = [
  ["Contacts, pipeline, funding and bids", ["admin", "member"]],
  ["Projects", ["admin", "member"], "only projects they're on"],
  ["Documents", ["admin", "member"], "sign their own contracts, read policies"],
  ["People", ["admin", "member"], "own checklist, policies, devices, org chart"],
  ["Timecards", ["admin", "member"], "their own hours"],
  ["Tickets", ["admin", "member"], "their own requests"],
  ["Settings, billing, team", ["admin"]],
];
const ricon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
function inviteText(kind, code) {
  const root = new URL(HUB, location.href).href, ws = S.workspace?.name || "our company";
  if (kind === "member") return `Hi,\n\nI've added you to ${ws} on Pulse.\n\n1. Open ${root}\n2. Choose "Join with code" and enter: ${code}\n3. Use your work email and choose a password.\n\nYou only need the code once.`;
  const link = `${root}portal/?code=${encodeURIComponent(code)}`;
  return `Hi,\n\nWelcome to ${ws}! We use Pulse for onboarding, company policies, ${kind === "employee" ? "contracts, timesheets and requests like time off or equipment" : "contracts, timesheets and requests"}.\n\nCreate your login here (the code is filled in for you):\n${link}\n\nUse your work email so your checklist and contract find you. After that, sign in any time at ${root}portal/\n\nIf the link doesn't work, open ${root}portal/, choose "First time here" and enter the code: ${code}`;
}
async function Team() {
  await loadTeam();
  const admin = S.profile.role === "admin";
  const code = async (fn) => { try { return await db.rpc(fn); } catch { return null; } };
  const [cm, ce, cc] = admin ? await Promise.all([code("get_company_code"), code("get_employee_code"), code("get_contractor_code")]) : [];
  const T = Team, f = T.filter || "all", q = (T.q || "").toLowerCase();
  const act = S.team.filter((p) => p.active), count = (r) => act.filter((p) => p.role === r).length;
  const tabs = [["all", "Everyone", act.length], ["admin", "Admins", count("admin")], ["member", "Members", count("member")], ["employee", "Employees", count("employee")], ["contractor", "Contractors", count("contractor")], ["off", "Turned off", S.team.length - act.length]];
  const rows = S.team.filter((p) => (f === "all" ? p.active : f === "off" ? !p.active : p.active && p.role === f) && (!q || `${p.display_name} ${p.email || ""}`.toLowerCase().includes(q)));
  const card = (kind, title, blurb, c, extra = "") => `<div class="invite-card ${kind}"><h3>${title}</h3><p class="muted small">${blurb}</p>
    ${c ? `<div class="code-box"><b data-code="${kind}">${esc(c)}</b><button class="btn small" data-copycode="${kind}">Copy code</button></div>
      <div class="actions-row"><button class="btn small primary" data-invite="${kind}">${ricon("send")}Invite…</button><button class="btn small" data-newcode="${kind}">Change code</button></div>${extra}`
      : `<p class="notice-bar alert small">${ricon("alert")}<span>Needs the database update <code>fix_20261108k_employees.sql</code>.</span></p>`}</div>`;
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Team and access</h1><p class="muted">${admin ? "Who can sign in, and what each person sees. Change anyone's role below; it takes effect the next time they open a page." : "Everyone on your team. Ask an admin to invite someone."}</p></div></div>
    ${admin ? `<section class="panel"><h2>Invite people</h2><div class="invite-grid">
      ${card("member", "Staff", "Runs the business: every app, including contacts, pipeline, funding and bids. Counts as a user.", cm)}
      ${card("employee", `Employees ${ricon("home")}`, "The employee portal: their checklist, policies, contracts to sign, devices, hours, requests and projects. Counts as a user.", ce,
        `<p class="small" style="margin:8px 0 0">Portal sign-in: <a href="${HUB}portal/" target="_blank" rel="noopener">${esc(new URL(HUB, location.href).href)}portal/</a></p>`)}
      ${card("contractor", "Contractors and consultants", "The same portal, for people outside the payroll. Free.", cc)}
    </div><p class="muted small" style="margin-bottom:0">Changing a code only affects new sign-ups. People already on the team keep their access. Add new hires in <a href="../people/#/people">People</a> with the same email first, so their checklist, contract and devices are waiting when they sign in.</p></section>` : ""}
    <section class="panel"><h2>People</h2>
      <div class="row" style="flex-wrap:wrap;gap:10px;margin-bottom:12px"><div class="tabs" role="tablist">${tabs.map(([k, l, n]) => `<button class="tab ${k === f ? "on" : ""}" data-tf="${k}" role="tab" aria-selected="${k === f}">${l} <span class="tab-c">${n}</span></button>`).join("")}</div>
        <input type="search" id="teamQ" placeholder="Search name or email" value="${esc(T.q || "")}" style="max-width:240px;margin-left:auto"></div>
      <div class="table-wrap" style="border:0"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th>${admin ? "<th></th>" : ""}</tr></thead><tbody>
      ${rows.map((p) => { const self = p.id === S.user.id;
        return `<tr style="cursor:default"><td style="font-weight:550">${esc(p.display_name)}${self ? ' <span class="muted">(you)</span>' : ""}</td><td>${esc(p.email || "")}</td>
        <td>${admin && !self ? `<select class="role-sel" data-uid="${p.id}" data-active="${p.active}" aria-label="Role for ${esc(p.display_name)}">${Object.keys(ROLES).map((r) => `<option value="${r}" ${r === p.role ? "selected" : ""}>${ROLES[r].name}</option>`).join("")}</select>`
          : `<span class="pill ${p.role === "admin" ? "s-active" : ""}">${esc(roleName(p.role))}</span>`}</td>
        <td>${p.active ? pill("Active") : pill("Dropped").replace("Dropped", "Turned off")}</td><td class="date">${short(p.created_at)}</td>
        ${admin ? `<td>${self ? "" : `<button class="btn small ${p.active ? "danger" : ""}" data-toggle="${p.id}" data-role-now="${p.role}" data-active="${p.active}">${p.active ? "Turn off" : "Turn on"}</button>`}</td>` : ""}</tr>`; }).join("")
        || `<tr><td colspan="6" class="empty">Nobody here.</td></tr>`}
      </tbody></table></div></section>
    <section class="panel"><h2>What each role sees</h2><div class="table-wrap" style="border:0"><table class="role-matrix"><thead><tr><th></th>${Object.keys(ROLES).map((r) => `<th>${ROLES[r].name}</th>`).join("")}</tr></thead><tbody>
      ${ROLE_SEES.map(([area, full, part]) => `<tr><td>${esc(area)}</td>${Object.keys(ROLES).map((r) => `<td>${full.includes(r) ? ricon("check") : part ? `<small class="muted">${esc(part)}</small>` : `<span class="muted">—</span>`}</td>`).join("")}</tr>`).join("")}
      <tr><td>Starts at</td>${Object.keys(ROLES).map((r) => `<td><small class="muted">${isStaffRole(r) ? "All apps page" : "Employee portal"}</small></td>`).join("")}</tr>
      </tbody></table></div></section>
    <section class="panel"><h2>Your name</h2><div class="add-action" style="grid-template-columns:1fr auto;max-width:420px;margin:0">
      <input id="myName" value="${esc(S.profile.display_name)}" aria-label="Your name"><button class="btn" id="saveName">Save</button></div>
      <p class="muted" style="margin-bottom:0">Your first name is what shows as owner and in the activity log.</p></section>`;
  const codes = { member: cm, employee: ce, contractor: cc }, kinds = { member: "team", employee: "employee", contractor: "contractor" };
  $$("[data-tf]").forEach((b) => b.addEventListener("click", () => { T.filter = b.dataset.tf; Team(); }));
  $("#teamQ").addEventListener("change", (e) => { T.q = e.target.value; Team(); });
  $$("[data-copycode]").forEach((b) => b.addEventListener("click", async () => { await navigator.clipboard.writeText(codes[b.dataset.copycode]); toast("Code copied"); }));
  $$("[data-newcode]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Make a new code? The old one stops working for new sign-ups.")) return;
    try { await db.rpc("rotate_company_code", { p_code: null, p_kind: kinds[b.dataset.newcode] }); toast("New code ready"); Team(); } catch (e) { toast(e.message); }
  }));
  $$("[data-invite]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.invite, body = inviteText(k, codes[k]), subj = `Your ${S.workspace?.name || ""} ${k === "member" ? "Pulse" : "employee portal"} login`.replace(/\s+/g, " ");
    $("#drawerTitle").textContent = { member: "Invite staff", employee: "Invite employees", contractor: "Invite contractors and consultants" }[k];
    $("#drawerBody").innerHTML = `<p class="muted" style="margin-top:0">Send this from your own email. ${k === "member" ? "They'll see every app." : "They'll land in the employee portal and see only their own things."}</p>
      <label>To (optional)<input id="invTo" type="email" placeholder="name@company.com"></label>
      <label style="margin-top:10px">Message<textarea id="invBody" rows="14">${esc(body)}</textarea></label>
      <div class="actions-row" style="margin-top:10px"><button class="btn" id="copyMsg">Copy message</button><a class="btn primary" id="mailIt">${ricon("send")}Open in email</a></div>`;
    openDrawer();
    const mail = () => ($("#mailIt").href = `mailto:${encodeURIComponent($("#invTo").value.trim())}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent($("#invBody").value)}`);
    mail(); $("#invTo").addEventListener("input", mail); $("#invBody").addEventListener("input", mail);
    $("#copyMsg").addEventListener("click", async () => { await navigator.clipboard.writeText($("#invBody").value); toast("Message copied"); });
  }));
  $$(".role-sel").forEach((sel) => sel.addEventListener("change", async () => {
    const p = S.team.find((x) => x.id === sel.dataset.uid), to = sel.value;
    const warn = to === "admin" ? `Make ${p.display_name} an admin? Admins can change settings, billing and everyone's access.`
      : isStaffRole(p.role) && !isStaffRole(to) ? `Move ${p.display_name} to the ${ROLES[to].name.toLowerCase()} portal? They'll stop seeing contacts, pipeline, funding and bids.` : "";
    if (warn && !confirm(warn)) { sel.value = p.role; return; }
    try { await db.rpc("set_member", { p_id: p.id, p_role: to, p_active: sel.dataset.active === "true" }); toast(`${p.display_name} is now ${/^[AEIOU]/.test(ROLES[to].name) ? "an" : "a"} ${ROLES[to].name.toLowerCase()}`); Team(); }
    catch (e) { sel.value = p.role; toast(/role|check/i.test(e.message) && to === "employee" ? "The Employee role needs the database update fix_20261108k_employees.sql." : e.message); }
  }));
  $$("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
    const on = b.dataset.active === "true";
    if (on && !confirm("Turn this person off? They'll be signed out and lose access right away.")) return;
    try { await db.rpc("set_member", { p_id: b.dataset.toggle, p_role: b.dataset.roleNow, p_active: !on }); Team(); } catch (e) { toast(e.message); }
  }));
  $("#saveName").addEventListener("click", async () => {
    const name = $("#myName").value.trim(); if (!name) return;
    try { must(await sb.from("profiles").update({ display_name: name }).eq("id", S.user.id)); S.profile.display_name = name; setWho(name); toast("Saved"); await loadTeam(); }
    catch (e) { toast(e.message); }
  });
}

/* ================================================================ workspace settings (admins) */
const LIST_LABELS = { "opportunities.kind": "Opportunity types", "funding.type": "Funding types",
  "contacts.category": "Contact categories", "resources.category": "Resource categories" };
const LINK_KINDS = { talent: "Talent management (hiring, performance)", ai: "AI chief of staff", other: "Other tool" };
async function WorkspaceSettings() {
  if (S.profile.role !== "admin") { $("#main").innerHTML = `<div class="empty">Only admins can change workspace settings.</div>`; return; }
  await loadWorkspace();
  const w = S.workspace, W = workspaceSettings(w), cfg = w.config || {};
  const lines = (a) => esc((a || []).join("\n"));
  const linkRow = (l = {}) => `<div class="link-row">
      <select data-k="kind" aria-label="Kind">${Object.entries(LINK_KINDS).map(([k, v]) => `<option value="${k}" ${l.kind === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
      <input data-k="label" placeholder="Name, e.g. Kibali" value="${esc(l.label || "")}" aria-label="Name">
      <input data-k="url" placeholder="https://…" value="${esc(l.url || "")}" aria-label="Link">
      <input data-k="note" placeholder="What it's for (optional)" value="${esc(l.note || "")}" aria-label="Note">
      <button class="btn small" type="button" data-del-link aria-label="Remove">Remove</button></div>`;
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Workspace settings</h1><p class="muted">These apply to everyone in ${esc(w.name)}.</p></div>
      <div class="actions"><button class="btn primary" id="wsSave">Save changes</button></div></div>
    <section class="panel"><h2>Company</h2><div class="form-grid">
      <label>Company name<input id="wsName" value="${esc(w.name)}" maxlength="80"></label>
      <label>Logo link <small class="muted">(https image, square works best)</small><input id="wsLogo" value="${esc(w.logo_url || "")}" placeholder="https://…/logo.png"></label>
      <div class="ws-preview"><span class="ws-logo" id="wsLogoPrev"></span><b id="wsNamePrev"></b></div></div></section>
    <section class="panel"><h2>AI chief of staff</h2><div class="form-grid">
      <label>What your team calls it<input id="wsChief" value="${esc(cfg.chief_name || "")}" placeholder="Chief of Staff" maxlength="40"></label>
      <p class="muted" style="align-self:end">Each person gets their own brief and can ask questions about their work. It only sees what that person can see, and only suggests changes for them to accept.</p></div></section>
    <section class="panel"><h2>Connected tools <small>shown as tiles on everyone's landing page</small></h2>
      <p class="muted">Link your talent management tool (hiring and performance reviews), an AI chief of staff, or anything else the team uses.</p>
      <div id="links">${(cfg.links || []).map(linkRow).join("")}</div>
      <button class="btn small" type="button" id="addLink">Add a tool</button></section>
    <section class="panel"><h2>Lists <small>one per line</small></h2>
      <p class="muted">Started from the <b>${esc((window.PULSE_PACKS[w.template] || window.PULSE_PACKS.general).label)}</b> starter pack. Stages and statuses are fixed so reports and reviews add up.</p>
      <div class="form-grid lists-grid">${Object.entries(LIST_LABELS).map(([k, label]) => `<label>${esc(label)}<textarea rows="8" data-list="${k}">${lines(W.lists[k])}</textarea></label>`).join("")}
        <label>Extra owner names <small class="muted">(besides team members)</small><textarea rows="4" id="wsOwners">${lines(W.owners)}</textarea></label>
        <label>Categories left out of "Working contacts"<textarea rows="4" id="wsWorking">${lines(W.working_exclude)}</textarea></label></div></section>
    <section class="panel"><h2>Review agendas</h2><div class="form-grid lists-grid">
      ${Object.entries(S.schema.cadences).map(([c, cfgc]) => `<label>${esc(cfgc.label)}<textarea rows="6" data-agenda="${c}">${lines(W.agendas[c])}</textarea></label>`).join("")}</div></section>
    <section class="panel"><h2>Start over from a starter pack</h2>
      <p class="muted">Replaces the lists and agendas above with a pack's. Records you already have keep their values.</p>
      <div class="add-action" style="grid-template-columns:1fr auto;max-width:560px;margin:0"><select id="wsPack">${Object.entries(window.PULSE_PACKS).map(([k, p]) => `<option value="${k}" ${k === w.template ? "selected" : ""}>${esc(p.label)} — ${esc(p.blurb)}</option>`).join("")}</select>
        <button class="btn" id="wsReset">Use this pack</button></div></section>
    <section class="panel danger-zone"><h2>Delete workspace</h2>
      <p class="muted">Permanently deletes ${esc(w.name)}: every record, review, request, asset and member. Export what you need first (each list page has Export CSV).</p>
      <div class="add-action" style="grid-template-columns:1fr auto;max-width:560px;margin:0"><input id="wsDelName" placeholder="Type ${esc(w.name)} to confirm" aria-label="Workspace name">
        <button class="btn danger" id="wsDelete">Delete workspace</button></div></section>`;
  const prev = () => { $("#wsNamePrev").textContent = $("#wsName").value; const u = $("#wsLogo").value.trim();
    $("#wsLogoPrev").innerHTML = /^https:\/\//i.test(u) ? `<img src="${esc(u)}" alt="">` : esc($("#wsName").value.split(/\s+/).map((x) => x[0] || "").slice(0, 2).join("").toUpperCase()); };
  prev(); $("#wsName").addEventListener("input", prev); $("#wsLogo").addEventListener("input", prev);
  $("#addLink").addEventListener("click", () => $("#links").insertAdjacentHTML("beforeend", linkRow()));
  $("#links").addEventListener("click", (e) => e.target.closest("[data-del-link]")?.closest(".link-row").remove());
  const split = (t) => t.split("\n").map((x) => x.trim()).filter(Boolean);
  const save = async (extra = {}) => {
    const links = $$(".link-row").map((r) => Object.fromEntries($$("[data-k]", r).map((i) => [i.dataset.k, i.value.trim()]))).filter((l) => l.url);
    const bad = links.find((l) => !/^https:\/\/[^\s]+$/i.test(l.url));
    if (bad) throw new Error(`The link for ${bad.label || "a tool"} must start with https://`);
    const config = { ...cfg, links,
      lists: Object.fromEntries($$("[data-list]").map((t) => [t.dataset.list, split(t.value)]).filter(([, v]) => v.length)),
      agendas: Object.fromEntries($$("[data-agenda]").map((t) => [t.dataset.agenda, split(t.value)])),
      owners: split($("#wsOwners").value), working_exclude: split($("#wsWorking").value), chief_name: $("#wsChief").value.trim() || undefined, ...extra.config };
    await db.rpc("update_workspace", { p: { name: $("#wsName").value.trim(), logo_url: $("#wsLogo").value.trim(), config, ...(extra.template ? { template: extra.template } : {}) } });
    await loadWorkspace(); applyWorkspaceLists();
  };
  $("#wsSave").addEventListener("click", async () => { try { await save(); toast("Saved"); } catch (e) { toast(e.message); } });
  $("#wsReset").addEventListener("click", async () => {
    const k = $("#wsPack").value;
    if (!confirm(`Replace the lists and agendas with the ${window.PULSE_PACKS[k].label} pack?`)) return;
    try { await save({ template: k, config: { lists: {}, agendas: {}, working_exclude: null } }); toast("Starter pack applied"); WorkspaceSettings(); } catch (e) { toast(e.message); }
  });
  $("#wsDelete").addEventListener("click", async () => {
    if ($("#wsDelName").value.trim() !== w.name) return toast(`Type ${w.name} exactly to confirm`);
    if (!confirm(`Delete ${w.name} and everything in it? This can't be undone.`)) return;
    try { await db.rpc("delete_workspace", { p_confirm: $("#wsDelName").value.trim() }); await sb.auth.signOut(); location.href = HUB; } catch (e) { toast(e.message); }
  });
}

boot();
