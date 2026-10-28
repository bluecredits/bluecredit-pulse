/* BlueCredit Pulse — vanilla JS single-page app. No build step. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { schema: null, user: null };
const today = () => new Date().toLocaleDateString("en-CA");
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const daysUntil = (iso) => Math.round((new Date(iso + "T12:00:00") - new Date(today() + "T12:00:00")) / 864e5);
const money = (n) => n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const short = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: iso.slice(0, 4) === today().slice(0, 4) ? undefined : "numeric" }) : "";
const ago = (ts) => { const m = Math.round((Date.now() - new Date(ts)) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}, ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Signed out"); }
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).detail || m; } catch {} throw new Error(m); }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2400); }

/* ---------------------------------------------------------------- status styling */
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

/* ---------------------------------------------------------------- boot / auth */
async function boot() {
  const me = await api("/api/me");
  $$(".app-name").forEach((e) => (e.textContent = me.app_name));
  document.title = me.app_name;
  if (!me.user) return showLogin();
  S.user = me.user;
  S.schema = await api("/api/schema");
  $("#login").hidden = true; $("#shell").hidden = false;
  $("#whoami").textContent = cap(S.user);
  route();
}
function showLogin() { $("#shell").hidden = true; $("#login").hidden = false; $("#loginForm input").focus(); }
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await api("/api/login", { method: "POST", body: { username: f.get("username"), password: f.get("password") } }); $("#loginError").textContent = ""; boot(); }
  catch (err) { $("#loginError").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); location.hash = ""; showLogin(); });

/* ---------------------------------------------------------------- router */
const routes = { dashboard: Dashboard, reviews: Reviews, activity: Activity };
window.addEventListener("hashchange", route);
function route() {
  if (!S.schema) return;
  const [name = "dashboard", id] = location.hash.replace(/^#\/?/, "").split("/");
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === name));
  closeDrawer(true);
  const main = $("#main");
  main.innerHTML = `<p class="muted">Loading…</p>`;
  const fn = routes[name] || (S.schema.entities[name] ? () => ListPage(name) : Dashboard);
  Promise.resolve(fn(id)).catch((e) => (main.innerHTML = `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  main.focus({ preventScroll: true });
}

/* ---------------------------------------------------------------- dashboard */
async function Dashboard() {
  const d = await api("/api/x/dashboard");
  const k = d.kpis;
  const last = Object.fromEntries(d.last_reviews.map((r) => [r.cadence, r.last]));
  const greet = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 17 ? "Good afternoon" : "Good evening";
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${greet}, ${esc(cap(S.user))}</h1>
      <p class="muted">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p></div>
      <div class="actions-row"><a class="btn primary" href="#/reviews" id="startDaily">Start today's review</a></div></div>
    <div class="kpis">
      <a class="kpi" href="#/opportunities"><b>${k.active_opps}</b><span>Active opportunities</span></a>
      <a class="kpi" href="#/funding"><b>${k.active_funding}</b><span>Active funding applications</span></a>
      <a class="kpi" href="#/opportunities"><b>${k.submitted}</b><span>Awaiting decision</span></a>
      <a class="kpi" href="#/opportunities"><b>${k.won}</b><span>Won</span></a>
      <a class="kpi ${k.overdue_actions ? "alert" : ""}" href="#/actions"><b>${k.open_actions}</b><span>Open actions${k.overdue_actions ? ` · ${k.overdue_actions} overdue` : ""}</span></a>
      <a class="kpi ${k.followups_due ? "alert" : ""}" href="#/contacts"><b>${k.followups_due}</b><span>Follow-ups due</span></a>
    </div>
    <section class="panel"><h2>Next 14 days <small>${d.due_soon.length} deadlines</small></h2>${gauge(d.due_soon, 14)}
      ${d.due_soon.length ? `<ul class="list">${d.due_soon.map(dueLi).join("")}</ul>` : `<p class="muted">No deadlines in the next two weeks. Qualify something from the forecasts.</p>`}</section>
    <div class="grid2">
      <div>
        <section class="panel"><h2>My open actions <small><a href="#/actions">All actions</a></small></h2>
          ${d.my_actions.length ? `<div>${d.my_actions.map(actionItem).join("")}</div>` : `<p class="muted">Nothing assigned to you. Actions you're given in reviews show up here.</p>`}</section>
        <section class="panel"><h2>Recent activity <small><a href="#/activity">Full log</a></small></h2>
          <ul class="list">${d.recent.filter((a) => a.user !== "import").slice(0, 12).map((a) => `<li><span>${esc(a.summary)}</span><span class="meta">${esc(cap(a.user))} · ${ago(a.ts)}</span></li>`).join("") || `<li class="muted">No edits yet.</li>`}</ul></section>
      </div>
      <div>
        <section class="panel"><h2>Review rhythm</h2><ul class="list">
          ${Object.entries(S.schema.cadences).map(([c, cfg]) => { const l = last[c]; const late = !l || daysUntil(l) < -{ daily: 1, weekly: 7, monthly: 31, quarterly: 92 }[c];
            return `<li><span>${cfg.label}</span><span class="meta ${late ? "due-over" : ""}">${l ? "Last " + short(l) : "Not run yet"}</span></li>`; }).join("")}</ul></section>
        <section class="panel"><h2>Opportunities by stage</h2>${bars(d.opp_by_stage, "opportunities", "stage")}</section>
        <section class="panel"><h2>Funding pipeline</h2>${bars(d.funding_by_status, "funding", "status")}</section>
      </div>
    </div>`;
  wireCommon($("#main"));
}
function dueLi(r) {
  const label = r.entity === "funding" ? "Funding" : "Opportunity";
  return `<li><span><a href="#" data-open="${r.entity}:${r.id}">${esc(r.name)}</a><br><span class="meta">${label}${r.org ? " · " + esc(r.org) : ""}${r.owner ? " · " + esc(r.owner) : ""}</span></span>
    <span class="meta">${dueCell(r.deadline)}<br>${pill(r.status)}</span></li>`;
}
function gauge(items, span) {
  if (!items.length) return "";
  const ticks = span <= 14 ? [0, 3, 7, span] : span <= 30 ? [0, 7, 14, span] : [0, Math.round(span / 4), Math.round(span / 2), Math.round(span * 3 / 4), span];
  const wk = Math.min(100, (7 / span) * 100), urgent = Math.min(100, (1 / span) * 100);
  const track = `background:linear-gradient(90deg,var(--rust) 0 ${urgent}%,var(--ochre) ${urgent}% ${wk}%,var(--teal) ${wk}% 100%)`;
  // group same-day items so markers don't overlap
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
  if (!rows.length) return `<p class="muted">Nothing here yet.</p>`;
  const max = Math.max(...rows.map((r) => r.n));
  const order = (entity === "funding" ? S.schema.entities.funding : S.schema.entities.opportunities).fields.find((f) => f.name === field).options;
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

/* shared click handling: open drawer, toggle actions, filter presets */
function wireCommon(root, onChange) {
  root.addEventListener("click", async (e) => {
    const o = e.target.closest("[data-open]");
    if (o) { e.preventDefault(); const [ent, id] = o.dataset.open.split(":"); openRecord(ent, +id, onChange); return; }
    const p = e.target.closest("[data-preset]");
    if (p) { sessionStorage.setItem("preset:" + p.getAttribute("href").slice(2), p.dataset.preset); }
  });
  root.addEventListener("change", async (e) => {
    const t = e.target.closest("[data-toggle-action]");
    if (!t) return;
    await api(`/api/actions/${t.dataset.toggleAction}`, { method: "PUT", body: { status: t.checked ? "Done" : "Open" } });
    t.closest(".action-item").classList.toggle("done", t.checked);
    toast(t.checked ? "Marked done" : "Reopened");
    onChange && onChange();
  });
}

/* ---------------------------------------------------------------- generic list pages */
const LIST_STATE = {};
const PRESETS = {
  opportunities: [["Active (identified → submitted)", "stage=Identified|Qualifying|Pursuing|Submitted"], ["Due in 30 days", "__due30"], ["Past due, no outcome", "__stale"], ["All", ""]],
  funding: [["Active applications", "status=Identified|Pursuing|Submitted"], ["All applications (not catalog)", "status__not=Catalog"], ["Catalog — open deadlines", "__catalogopen"], ["Catalog — everything", "status=Catalog"], ["All", ""]],
  contacts: [["Working contacts", "category__not=Mailing List|Corporate Prospect|Expert"], ["Follow-ups due", "__followups"], ["All", ""]],
  actions: [["Open", "status=Open"], ["Done", "status=Done"], ["All", ""]],
  resources: [["All", ""]],
};
function presetParams(entity, key) {
  const t = today();
  if (key === "__due30") return { "stage": "Identified|Qualifying|Pursuing|Submitted", "deadline__gte": t, "deadline__lte": addDays(t, 30) };
  if (key === "__stale") return { "stage": "Identified|Qualifying|Pursuing", "deadline__lte": addDays(t, -1) };
  if (key === "__catalogopen") return { "status": "Catalog", "deadline__gte": t };
  if (key === "__followups") return { "next_step_date__lte": t };
  return Object.fromEntries(new URLSearchParams(key));
}

async function ListPage(entity) {
  const ent = S.schema.entities[entity];
  const st = LIST_STATE[entity] ||= { q: "", preset: PRESETS[entity][0][1], extra: {}, sort: "", offset: 0 };
  const pre = sessionStorage.getItem("preset:" + entity);
  if (pre) { sessionStorage.removeItem("preset:" + entity); st.preset = ""; st.extra = Object.fromEntries(new URLSearchParams(pre)); st.offset = 0; }
  const facetFields = ent.fields.filter((f) => f.type === "select" && f.name !== ent.status_field).slice(0, 2);
  if (ent.status_field) facetFields.unshift(ent.fields.find((f) => f.name === ent.status_field));

  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${esc(ent.label)}</h1></div>
      <div class="actions-row no-print">
        <label class="btn" style="display:inline-block">Import CSV<input type="file" accept=".csv" id="importCsv" hidden></label>
        <button class="btn" id="exportCsv">Export CSV</button>
        <button class="btn primary" id="addNew">Add ${esc(ent.singular.toLowerCase())}</button></div></div>
    <div class="filters">
      <input type="search" id="q" placeholder="Search ${esc(ent.label.toLowerCase())}…" value="${esc(st.q)}" aria-label="Search">
      <select id="preset" aria-label="View">${PRESETS[entity].map(([l, v]) => `<option value="${esc(v)}" ${v === st.preset ? "selected" : ""}>${esc(l)}</option>`).join("")}
        ${st.preset === "" && Object.keys(st.extra).length ? `<option value="" selected>Custom filter</option>` : ""}</select>
      ${facetFields.map((f) => `<select data-facet="${f.name}" aria-label="${esc(f.label)}"><option value="">${esc(f.label)}: any</option>
        ${f.options.map((o) => `<option ${st.extra[f.name] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`).join("")}
      <span class="count" id="count"></span>
    </div>
    <div class="table-wrap"><table><thead><tr>${ent.list_fields.map((f) => `<th data-sort="${f}">${esc(fieldLabel(entity, f))}</th>`).join("")}</tr></thead><tbody id="rows"></tbody></table></div>
    <div class="pager" id="pager"></div>`;

  const load = async () => {
    const params = { ...presetParams(entity, st.preset), ...st.extra, q: st.q, sort: st.sort, offset: st.offset, limit: 100 };
    Object.keys(params).forEach((k) => params[k] === "" && delete params[k]);
    st.lastParams = params;
    const data = await api(`/api/${entity}?` + new URLSearchParams(params));
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
  $("#q").addEventListener("input", (e) => { clearTimeout(tmr); tmr = setTimeout(() => { st.q = e.target.value; st.offset = 0; load(); }, 220); });
  $("#preset").addEventListener("change", (e) => { st.preset = e.target.value; st.extra = {}; st.offset = 0; ListPage(entity); });
  $$("[data-facet]").forEach((s) => s.addEventListener("change", () => { if (s.value) st.extra[s.dataset.facet] = s.value; else delete st.extra[s.dataset.facet]; st.offset = 0; load(); }));
  $$("th[data-sort]").forEach((th) => th.addEventListener("click", () => { const f = th.dataset.sort; const cur = st.sort || ent.default_sort; st.sort = cur === f ? "-" + f : f; load(); }));
  $("#rows").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.open) e.target.click(); });
  $("#addNew").addEventListener("click", () => openRecord(entity, null, load));
  $("#exportCsv").addEventListener("click", () => { const p = { ...st.lastParams }; delete p.limit; delete p.offset; location.href = `/api/${entity}/export.csv?` + new URLSearchParams(p); });
  $("#importCsv").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    try { const r = await api(`/api/${entity}/import`, { method: "POST", body: fd }); toast(`Imported ${r.added} rows`); load(); } catch (err) { toast("Import failed: " + err.message); }
  });
  wireCommon($("#main"), load);
  await load();
}
function fieldLabel(entity, f) { if (f === "linked") return "Linked to"; return S.schema.entities[entity].fields.find((x) => x.name === f)?.label || f; }
function cell(entity, f, r) {
  const ent = S.schema.entities[entity];
  const def = ent.fields.find((x) => x.name === f) || {};
  const v = r[f];
  if (f === "linked") return `<td>${r.linked_type ? esc(S.schema.entities[r.linked_type]?.singular || r.linked_type) : ""}</td>`;
  if (f === ent.status_field) return `<td>${pill(v)}</td>`;
  if (f === "priority") return `<td>${v === "High" ? `<span class="pill s-high">High</span>` : esc(v)}</td>`;
  if (def.type === "date") {
    const active = !["Won", "Lost", "Missed", "Not Qualified", "No-Bid", "Cancelled", "Catalog", "Out of Scope", "Withdrawn", "Done", "Dropped"].includes(r[ent.status_field]);
    return `<td class="date">${dueCell(v, active && entity !== "funding" || (entity === "funding" && active))}</td>`;
  }
  if (def.type === "number") return `<td class="num">${f === "value" || f === "amount" ? money(v) : v ?? ""}</td>`;
  if (def.type === "url" && v) return `<td class="wrap"><a href="${esc(v.startsWith("http") ? v : "https://" + v)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open</a></td>`;
  if (def.type === "email" && v) return `<td>${esc(v.split(/[,;\s]+/)[0])}</td>`;
  const first = f === ent.title_field;
  return `<td class="wrap"><span class="clip" ${first ? 'style="font-weight:550"' : ""}>${esc(v || (first ? r.organization || "(untitled)" : ""))}</span></td>`;
}

/* ---------------------------------------------------------------- record drawer */
async function openRecord(entity, id, onSaved) {
  const ent = S.schema.entities[entity];
  const r = id ? await api(`/api/${entity}/${id}`) : { status: entity === "actions" ? "Open" : undefined };
  if (!id && ent.status_field && !r[ent.status_field]) r[ent.status_field] = ent.fields.find((f) => f.name === ent.status_field).options[entity === "funding" ? 1 : 0];
  if (!id && ["opportunities", "funding", "actions", "contacts"].includes(entity)) r.owner = cap(S.user);
  $("#drawerTitle").textContent = id ? (r[ent.title_field] || r.organization || ent.singular) : `New ${ent.singular.toLowerCase()}`;
  const hidden = entity === "actions" ? ["review_id", "linked_type", "linked_id"] : [];
  const full = (f) => ["textarea"].includes(f.type) || [ent.title_field, "url", "next_step"].includes(f.name);
  $("#drawerBody").innerHTML = `
    <form class="form" id="recForm">
      ${ent.fields.filter((f) => !hidden.includes(f.name)).map((f) => `<label class="${full(f) ? "full" : ""}">${esc(f.label)}${input(f, r[f.name])}</label>`).join("")}
    </form>
    <div class="form-foot">
      <button class="btn primary" id="saveRec">${id ? "Save changes" : "Add " + ent.singular.toLowerCase()}</button>
      <button class="btn" data-close>Cancel</button><span class="spacer"></span>
      ${id ? `<button class="btn danger" id="delRec">Delete</button>` : ""}
    </div>
    ${id && entity !== "actions" && entity !== "resources" ? `<section class="history"><h3>Action items</h3>
      <div id="recActions">${(r.actions || []).map(actionItem).join("") || `<p class="muted">No actions linked yet.</p>`}</div>
      <div class="add-action"><input id="naText" placeholder="Next action…" aria-label="New action"><select id="naOwner" aria-label="Owner">${S.schema.owners.map((o) => `<option ${o.toLowerCase() === S.user ? "selected" : ""}>${o}</option>`).join("")}</select>
        <input type="date" id="naDue" aria-label="Due date"><button class="btn small" id="naAdd">Add</button></div></section>` : ""}
    ${id && r.actions === undefined && entity === "actions" && r.review_id ? `<p class="meta-box"><a href="#/reviews/${r.review_id}">From review #${r.review_id}</a></p>` : ""}
    ${id && r.history?.length ? `<section class="history"><h3>History</h3><ul>${r.history.map((h) => `<li>${esc(h.summary)} <span class="muted">— ${esc(cap(h.user))}, ${ago(h.ts)}</span></li>`).join("")}</ul></section>` : ""}
    ${r.meta && typeof r.meta === "object" && Object.keys(r.meta).length ? `<details class="meta-box"><summary>Original import fields</summary><dl>${Object.entries(r.meta).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>` : ""}
    ${id ? `<p class="meta-box">Last updated ${r.updated_at ? ago(r.updated_at) : ""}${r.updated_by ? " by " + esc(cap(r.updated_by)) : ""}${r.source ? "" : ""}</p>` : ""}`;
  openDrawer();
  const done = () => { onSaved && onSaved(); };
  $("#saveRec").addEventListener("click", async () => {
    const data = Object.fromEntries(new FormData($("#recForm")));
    if (!data[ent.title_field] && !(entity === "contacts" && data.organization)) { toast(`Add a ${fieldLabel(entity, ent.title_field).toLowerCase()} first`); return; }
    try {
      await api(id ? `/api/${entity}/${id}` : `/api/${entity}`, { method: id ? "PUT" : "POST", body: data });
      toast(id ? "Saved" : `${ent.singular} added`); closeDrawer(); done();
    } catch (e) { toast(e.message); }
  });
  $("#delRec")?.addEventListener("click", async () => {
    if (!confirm(`Delete this ${ent.singular.toLowerCase()}? It's recorded in the activity log but can't be undone here.`)) return;
    await api(`/api/${entity}/${id}`, { method: "DELETE" }); toast("Deleted"); closeDrawer(); done();
  });
  $("#naAdd")?.addEventListener("click", async () => {
    const text = $("#naText").value.trim(); if (!text) return;
    await api("/api/actions", { method: "POST", body: { text, owner: $("#naOwner").value, due_date: $("#naDue").value, status: "Open", linked_type: entity, linked_id: id } });
    toast("Action added"); openRecord(entity, id, onSaved);
  });
  wireCommon($("#drawerBody"), () => openRecord(entity, id, onSaved));
  setTimeout(() => $("#recForm input, #recForm select")?.focus(), 60);
}
function input(f, v) {
  v = v ?? "";
  const n = `name="${f.name}"`;
  if (f.type === "select") { const opts = f.options.includes(v) || !v ? f.options : [v, ...f.options];
    return `<select ${n}><option value=""></option>${opts.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`; }
  if (f.type === "textarea") return `<textarea ${n} rows="5">${esc(v)}</textarea>`;
  const type = { date: "date", number: "number", email: "text", url: "text" }[f.type] || "text";
  return `<input ${n} type="${type}" value="${esc(v)}" ${f.type === "number" ? 'step="any"' : ""}>`;
}
function openDrawer() { const d = $("#drawer"); d.classList.add("open"); d.setAttribute("aria-hidden", "false"); }
function closeDrawer(instant) { const d = $("#drawer"); d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); }
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

/* ---------------------------------------------------------------- reviews */
async function Reviews(id) {
  if (id) return ReviewDetail(+id);
  const list = await api("/api/x/reviews");
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
      ${list.map((r) => `<tr data-go="${r.id}" tabindex="0"><td class="date">${short(r.review_date)}</td><td style="font-weight:550">${esc(r.title)}</td><td>${esc(cap(r.cadence))}</td>
        <td>${esc(r.attendees || "")}</td><td>${r.n_actions ? `${r.n_actions}${r.n_open ? ` (${r.n_open} open)` : ""}` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">No reviews yet. Start a daily review above.</p>`}</section>`;
  $$("[data-start]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const prevAtt = list.find((r) => r.cadence === b.dataset.start)?.attendees || "";
    const r = await api("/api/x/reviews", { method: "POST", body: { cadence: b.dataset.start, attendees: prevAtt } });
    location.hash = `#/reviews/${r.id}`;
  }));
  $$("tr[data-go]").forEach((tr) => { tr.addEventListener("click", () => (location.hash = `#/reviews/${tr.dataset.go}`)); tr.addEventListener("keydown", (e) => e.key === "Enter" && tr.click()); });
}

async function ReviewDetail(id) {
  const r = await api(`/api/x/reviews/${id}`);
  const s = r.snapshot;
  const sec = (title, n, body) => `<section class="snap-sec"><h3>${title}${n != null ? ` <span class="c">${n}</span>` : ""}</h3>${body}</section>`;
  const recLi = (entity, x, name, sub, right) => `<li><span><a href="#" data-open="${entity}:${x.id}">${esc(name)}</a>${sub ? `<br><span class="meta">${sub}</span>` : ""}</span><span class="meta">${right}</span></li>`;
  const ul = (items, empty) => items.length ? `<ul class="list">${items.join("")}</ul>` : `<p class="muted">${empty}</p>`;

  let snapHtml = `<p class="muted">This review was imported from the old Word document, so it has no pipeline snapshot. Use “Refresh snapshot” to pull one as of ${short(r.review_date)}.</p>`;
  if (s) {
    const dl = [...s.opp_deadlines.map((x) => ({ ...x, entity: "opportunities", name: x.title, org: x.agency, status: x.stage })),
                ...s.funding_deadlines.map((x) => ({ ...x, entity: "funding", org: x.organization }))].sort((a, b) => a.deadline.localeCompare(b.deadline));
    const span = S.schema.cadences[s.cadence].ahead;
    snapHtml = `
      <p class="muted" style="margin-top:0">Snapshot as of ${short(s.as_of)} · looking back to ${short(s.since)}, ahead to ${short(s.until)}.</p>
      ${s.results ? `<div class="stat-row">
        <div><b>${(s.results.opportunities.Submitted || 0) + (s.results.funding.Submitted || 0)}</b><span>Submitted this period</span></div>
        <div><b>${(s.results.opportunities.Won || 0) + (s.results.funding.Won || 0)}</b><span>Won</span></div>
        <div><b>${(s.results.opportunities.Lost || 0) + (s.results.funding.Lost || 0) + (s.results.opportunities.Missed || 0) + (s.results.funding.Missed || 0)}</b><span>Lost or missed</span></div>
        <div><b>${s.results.win_rate == null ? "—" : s.results.win_rate + "%"}</b><span>Win rate</span></div>
        <div><b>${money(s.results.value_won) || "$0"}</b><span>Contract value won</span></div></div>` : ""}
      ${sec("Carry-over from last review", s.carry_over.length, s.previous_review ? ul(s.carry_over.map((a) => `<li><span>${esc(a.text)}</span><span class="meta">${esc(a.owner || "")}</span></li>`),
          `Everything from <a href="#/reviews/${s.previous_review.id}">${esc(s.previous_review.title)}</a> is closed.`) : `<p class="muted">This is the first ${s.cadence} review.</p>`)}
      ${sec("Overdue actions", s.actions_overdue.length, ul(s.actions_overdue.map((a) => `<li><span>${esc(a.text)}</span><span class="meta">${esc(a.owner || "")} · ${dueCell(a.due_date)}</span></li>`), "None overdue."))}
      ${sec(`Deadlines in the next ${span} days`, dl.length, gauge(dl, span) + ul(dl.map(dueLi), "No deadlines in this window."))}
      ${sec("What moved", s.moves.submitted.length + s.moves.won.length + s.moves.lost.length + Object.values(s.created).reduce((a, b) => a + b, 0),
        ul([...s.moves.submitted, ...s.moves.won, ...s.moves.lost].map((a) => `<li><span><a href="#" data-open="${a.entity}:${a.entity_id}">${esc(a.summary)}</a></span><span class="meta">${esc(cap(a.user))} · ${short(a.ts.slice(0, 10))}</span></li>`)
          .concat(Object.entries(s.created).filter(([, n]) => n).map(([e, n]) => `<li><span>${n} new ${esc(S.schema.entities[e].label.toLowerCase())} added</span><span class="meta"></span></li>`)),
          "No submissions, wins, losses or new records in this period."))}
      ${sec("Follow-ups due", s.followups_due.length, ul(s.followups_due.slice(0, 15).map((c) => recLi("contacts", c, c.name || c.organization, esc([c.organization, c.next_step].filter(Boolean).join(" · ")), dueCell(c.next_step_date))), "No contact follow-ups due."))}
      ${s.stale.length ? sec("Past deadline with no outcome — update or close", s.stale.length, ul(s.stale.slice(0, 12).map((x) => recLi(x.entity, x, x.name, esc(x.owner || "Unassigned"), short(x.deadline)))
          .concat(s.stale.length > 12 ? [`<li><a href="#/opportunities" data-preset="stage=Identified|Qualifying|Pursuing&deadline__lte=${addDays(today(), -1)}">See all ${s.stale.length}</a></li>`] : []), "")) : ""}
      ${s.opp_pipeline ? `<div class="grid2" style="gap:18px">${sec("Opportunity pipeline", null, bars(s.opp_pipeline.map((x) => ({ k: x.stage, n: x.n })), "opportunities", "stage"))}
        ${sec("Funding pipeline", null, bars(s.funding_pipeline.map((x) => ({ k: x.status, n: x.n })), "funding", "status"))}</div>` : ""}
      ${s.by_owner ? sec("By owner", null, `<div class="table-wrap"><table><thead><tr><th>Owner</th><th>Active opps</th><th>Active funding</th><th>Submitted</th><th>Won</th></tr></thead><tbody>
        ${s.by_owner.map((o) => `<tr style="cursor:default"><td>${esc(o.owner)}</td><td>${o.active_opps}</td><td>${o.active_funding}</td><td>${o.submitted}</td><td>${o.won}</td></tr>`).join("")}</tbody></table></div>`) : ""}`;
  }
  const agenda = s?.agenda || S.schema.agendas[r.cadence] || [];
  $("#main").innerHTML = `
    <div class="page-head"><div><p class="muted" style="margin:0 0 4px"><a href="#/reviews">Reviews</a> / ${esc(cap(r.cadence))}</p>
      <h1 contenteditable="true" id="rvTitle" spellcheck="false">${esc(r.title)}</h1></div>
      <div class="actions-row no-print"><button class="btn" id="refresh">Refresh snapshot</button><button class="btn" onclick="window.print()">Print</button>
        <button class="btn danger" id="delReview">Delete</button></div></div>
    <div class="review-layout">
      <div>
        <section class="panel"><h2>Agenda</h2><ol class="agenda">${agenda.map((a) => `<li>${esc(a)}</li>`).join("")}</ol></section>
        <section class="panel"><h2>Pipeline snapshot</h2>${snapHtml}</section>
      </div>
      <div class="review-side">
        <section class="panel"><h2>Notes <span class="save-state" id="saveState"></span></h2>
          <div class="form" style="margin-bottom:10px"><label>Date<input type="date" id="rvDate" value="${esc(r.review_date)}"></label>
            <label>Attendees<input id="rvAtt" value="${esc(r.attendees || "")}" placeholder="Barasa, Sohaib…"></label></div>
          <textarea class="notes-area" id="rvNotes" placeholder="Decisions, updates, blockers…">${esc(r.notes || "")}</textarea></section>
        <section class="panel"><h2>Action items <small>${r.actions.filter((a) => a.status === "Open").length} open</small></h2>
          <div id="rvActions">${r.actions.map(actionItem).join("") || `<p class="muted">Capture who does what by when.</p>`}</div>
          <div class="add-action no-print"><input id="naText" placeholder="Action…" aria-label="New action">
            <select id="naOwner" aria-label="Owner">${S.schema.owners.map((o) => `<option ${o.toLowerCase() === S.user ? "selected" : ""}>${o}</option>`).join("")}</select>
            <input type="date" id="naDue" value="${addDays(r.review_date, { daily: 1, weekly: 7, monthly: 30, quarterly: 90 }[r.cadence])}" aria-label="Due date">
            <button class="btn small primary" id="naAdd">Add</button></div></section>
      </div>
    </div>`;
  let tmr;
  const save = (body) => { $("#saveState").textContent = "Saving…"; clearTimeout(tmr);
    tmr = setTimeout(async () => { await api(`/api/x/reviews/${id}`, { method: "PUT", body: body() }); $("#saveState").textContent = "Saved"; }, 600); };
  const all = () => ({ notes: $("#rvNotes").value, attendees: $("#rvAtt").value, review_date: $("#rvDate").value, title: $("#rvTitle").textContent.trim() });
  ["rvNotes", "rvAtt", "rvDate"].forEach((i) => $("#" + i).addEventListener("input", () => save(all)));
  $("#rvTitle").addEventListener("blur", () => save(all));
  $("#rvTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
  $("#refresh").addEventListener("click", async () => { await api(`/api/x/reviews/${id}`, { method: "PUT", body: { refresh: true, ...all() } }); toast("Snapshot refreshed"); ReviewDetail(id); });
  $("#delReview").addEventListener("click", async () => { if (!confirm("Delete this review? Its action items are kept.")) return; await api(`/api/x/reviews/${id}`, { method: "DELETE" }); location.hash = "#/reviews"; });
  const addAction = async () => {
    const text = $("#naText").value.trim(); if (!text) { $("#naText").focus(); return; }
    await api("/api/actions", { method: "POST", body: { text, owner: $("#naOwner").value, due_date: $("#naDue").value, status: "Open", review_id: id } });
    const rr = await api(`/api/x/reviews/${id}`); $("#rvActions").innerHTML = rr.actions.map(actionItem).join("");
    $("#naText").value = ""; $("#naText").focus();
  };
  $("#naAdd").addEventListener("click", addAction);
  $("#naText").addEventListener("keydown", (e) => e.key === "Enter" && addAction());
  wireCommon($("#main"), async () => { const rr = await api(`/api/x/reviews/${id}`); $("#rvActions").innerHTML = rr.actions.map(actionItem).join(""); });
}

/* ---------------------------------------------------------------- activity */
async function Activity() {
  const rows = await api("/api/x/activity?limit=300");
  $("#main").innerHTML = `<div class="page-head"><div><h1>Activity log</h1><p class="muted">Every add, edit, status change and delete, newest first.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
    ${rows.map((a) => `<tr ${a.entity_id && S.schema.entities[a.entity] && a.action !== "delete" ? `data-open="${a.entity}:${a.entity_id}"` : 'style="cursor:default"'}>
      <td class="date">${new Date(a.ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td>${esc(cap(a.user))}</td><td>${esc(a.summary)}</td></tr>`).join("")}</tbody></table></div>`;
  wireCommon($("#main"));
}

boot();
