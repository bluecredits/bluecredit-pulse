/* Pulse · Federal opportunities — saved searches over SAM.gov notices. The database pulls new notices on a timer
   (see "Federal opportunities" in schema.sql) and matches every search locally; this page shows the matches, lets you
   save, dismiss or add one to Business Review → Opportunities, and holds the searches and the SAM.gov settings. */
"use strict";

const FD = { status: "New", search: "", q: "", sort: "posted" };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const isAdmin = () => S.profile?.role === "admin";

const SET_ASIDES = [
  ["SBA", "Total Small Business"], ["SBP", "Partial Small Business"], ["8A", "8(a)"], ["8AN", "8(a) sole source"],
  ["HZC", "HUBZone"], ["HZS", "HUBZone sole source"], ["SDVOSBC", "Service-Disabled Veteran-Owned"], ["SDVOSBS", "SDVOSB sole source"],
  ["WOSB", "Women-Owned Small Business"], ["WOSBSS", "WOSB sole source"], ["EDWOSB", "Economically Disadvantaged WOSB"], ["EDWOSBSS", "EDWOSB sole source"],
  ["VSA", "Veteran-Owned (VA)"], ["VSS", "Veteran-Owned sole source (VA)"], ["IEE", "Indian Economic Enterprise"], ["ISBEE", "Indian Small Business Economic Enterprise"],
  ["BICiv", "Buy Indian"], ["LAS", "Local Area Set-Aside"],
];
const TYPES = ["Solicitation", "Combined Synopsis/Solicitation", "Presolicitation", "Sources Sought", "Special Notice", "Award Notice", "Justification", "Sale of Surplus Property", "Intent to Bundle Requirements (DoD-Funded)"];
const SIZES = [["any", "Any size"], ["small", "Small-business set-asides only"], ["unrestricted", "Unrestricted only (no set-aside)"]];
const EVERY = [[15, "Every 15 minutes"], [30, "Every 30 minutes"], [60, "Every hour"], [120, "Every 2 hours"], [240, "Every 4 hours"], [720, "Twice a day"], [1440, "Once a day"]];
const list = (v) => String(v || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const daysLeft = (ts) => (ts ? Math.ceil((new Date(ts) - Date.now()) / 864e5) : null);
const dueTxt = (ts) => { const d = daysLeft(ts); if (d == null) return "—"; const s = new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d < 0 ? `<span class="muted">${s} (closed)</span>` : `<span class="${d <= 7 ? "red" : ""}">${s} · ${d === 0 ? "today" : d + "d"}</span>`; };
const setupNeeded = (e) => /fed_|schema cache|does not exist/i.test(e.message || "");

/* ================================================================ matches */
async function Matches() {
  const [searches, st] = await Promise.all([must(await sb.from("fed_searches").select("id, name, active").order("name")), db.rpc("fed_status", {})]);
  let rows = await db.rpc("fed_list", { p_status: FD.status, p_search: FD.search ? +FD.search : null, p_sort: FD.sort });
  if (FD.q) { const t = FD.q.toLowerCase(); rows = rows.filter((r) => [r.title, r.sol_number, r.agency, r.subtier, r.office, r.naics].join(" ").toLowerCase().includes(t)); }
  const sname = Object.fromEntries(searches.map((s) => [s.id, s.name]));
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Federal opportunities</h1><p class="muted">New SAM.gov notices that match your searches. ${statusLine(st)}</p></div>
      <div class="actions-row"><button class="btn" id="runNow">${icon("return")}Check now</button><a class="btn primary" href="#/searches/new">${icon("plus")}New search</a></div></div>
    ${banner(st, searches)}
    <div class="filters">
      <div class="tabs">${["New", "Saved", "Added", "Dismissed", "All"].map((k) => `<button data-st="${k}" aria-selected="${FD.status === k}">${k}</button>`).join("")}</div>
      <select id="fSearch"><option value="">All searches</option>${searches.map((s) => `<option value="${s.id}" ${String(s.id) === FD.search ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      <select id="fSort"><option value="posted" ${FD.sort === "posted" ? "selected" : ""}>Newest first</option><option value="due" ${FD.sort === "due" ? "selected" : ""}>Due soonest</option></select>
      <input id="fQ" type="search" placeholder="Filter by title, agency, NAICS…" value="${esc(FD.q)}">
    </div>
    <div class="fed-list">${rows.map((r) => card(r, sname)).join("") || `<div class="empty">${FD.status === "New" ? "No new matches right now." : "Nothing here."}${searches.length ? "" : ` <a href="#/searches/new">Create your first search</a>.`}</div>`}</div>`;
  $$("[data-st]").forEach((b) => b.addEventListener("click", () => { FD.status = b.dataset.st; Matches(); }));
  $("#fSearch").addEventListener("change", (e) => { FD.search = e.target.value; Matches(); });
  $("#fSort").addEventListener("change", (e) => { FD.sort = e.target.value; Matches(); });
  $("#fQ").addEventListener("input", debounce((e) => { FD.q = e.target.value; Matches().then(() => { const i = $("#fQ"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300));
  $("#runNow").addEventListener("click", runNow);
  $$("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, b.closest("[data-nid]").dataset.nid, b)));
}
function card(r, sname) {
  const hits = (r.searches || []).map((id) => sname[id]).filter(Boolean);
  return `<article class="panel fed-card ${r.status === "Dismissed" ? "muted" : ""}" data-nid="${esc(r.notice_id)}">
    <div class="fed-main">
      <div class="fed-top"><span class="pill">${esc(r.notice_type || "Notice")}</span>${r.set_aside ? `<span class="pill s-won" title="${esc(r.set_aside)}">${esc(r.set_aside_code || "Set-aside")}</span>` : ""}
        ${hits.map((h) => `<span class="fed-hit">${icon("search")}${esc(h)}</span>`).join("")}</div>
      <h3><a href="${esc(r.ui_link || "https://sam.gov/opp/" + r.notice_id + "/view")}" target="_blank" rel="noopener">${esc(r.title || "(untitled)")} <svg class="ic ext-ic"><use href="#i-external"/></svg></a></h3>
      <p class="muted small">${esc([r.agency, r.subtier, r.office].filter((x, i, a) => x && a.indexOf(x) === i).join(" · "))}</p>
      <dl class="fed-facts">
        <div><dt>Posted</dt><dd>${short(r.posted_date)}</dd></div>
        <div><dt>Due</dt><dd>${dueTxt(r.response_deadline)}</dd></div>
        <div><dt>NAICS</dt><dd>${esc(r.naics || "—")}</dd></div>
        <div><dt>Sol. #</dt><dd>${esc(r.sol_number || "—")}</dd></div>
        ${r.state || r.city ? `<div><dt>Place</dt><dd>${esc([r.city, r.state].filter(Boolean).join(", "))}</dd></div>` : ""}
        ${r.awardee ? `<div><dt>Awarded</dt><dd>${esc(r.awardee)}${r.award_amount ? " · " + money(r.award_amount) : ""}</dd></div>` : ""}
      </dl>
    </div>
    <div class="fed-actions">
      ${r.status === "Added" ? `<a class="btn small" href="../review/#/opportunities/${r.opportunity_id}">${icon("check")}In Opportunities</a>`
        : `<button class="btn small primary" data-act="add">${icon("plus")}Add to Opportunities</button>
           ${r.status !== "Saved" ? `<button class="btn small" data-act="Saved">Save</button>` : `<button class="btn small" data-act="New">Unsave</button>`}
           ${r.status !== "Dismissed" ? `<button class="btn small" data-act="Dismissed">Dismiss</button>` : `<button class="btn small" data-act="New">Restore</button>`}`}
    </div></article>`;
}
async function act(what, nid, btn) {
  btn.disabled = true;
  try {
    if (what === "add") {
      const kinds = workspaceSettings(S.workspace).lists["opportunities.kind"] || [];
      const kind = kinds.find((k) => /federal/i.test(k)) || kinds.find((k) => /contract/i.test(k)) || "";
      const id = await db.rpc("fed_add_to_opportunities", { p_notice: nid, p_kind: kind || null });
      toast("Added to Opportunities"); const c = btn.closest(".fed-card");
      c.querySelector(".fed-actions").innerHTML = `<a class="btn small" href="../review/#/opportunities/${id}">${icon("check")}In Opportunities</a>`;
    } else {
      await db.rpc("fed_set_status", { p_notices: [nid], p_status: what });
      const c = btn.closest(".fed-card"); if (FD.status !== "All") { c.remove(); } else Matches();
      toast(what === "Dismissed" ? "Dismissed" : what === "Saved" ? "Saved" : "Moved back to New");
    }
  } catch (e) { btn.disabled = false; toast(e.message); }
}
function statusLine(st) {
  if (!st.has_key) return "";
  const every = (EVERY.find(([m]) => m === st.every_min) || [, `every ${st.every_min} min`])[1].toLowerCase();
  return `Checks SAM.gov ${every}${st.last_fetch_at ? `; last check ${ago(st.last_fetch_at)}` : ""}.`;
}
function banner(st, searches) {
  const msgs = [];
  if (!st.has_key) msgs.push(isAdmin() ? `Add your SAM.gov API key in <a href="#/settings">Settings</a> to start pulling notices.` : `An admin needs to add the SAM.gov API key in Settings.`);
  else if (!st.has_net || !st.timer) msgs.push(`Automatic checks are off: the database timer isn't set up yet. ${isAdmin() ? `See <a href="#/settings">Settings</a>.` : "Ask an admin."}`);
  if (st.last_error) msgs.push(esc(st.last_error));
  else if (/^Paused/.test(st.last_status || "")) msgs.push(esc(st.last_status));
  if (st.has_key && !searches.length) msgs.push(`Notices are coming in. <a href="#/searches/new">Create a search</a> to see the ones that fit.`);
  return msgs.map((m) => `<div class="notice-bar">${icon("alert")}<div>${m}</div></div>`).join("");
}
async function runNow() {
  const b = $("#runNow"); b.disabled = true;
  try { await db.rpc("fed_run_now", {}); toast("Checking SAM.gov; results arrive within a few minutes"); setTimeout(() => { if (/^#\/?(matches)?$/.test(location.hash)) Matches(); }, 90000); }
  catch (e) { toast(e.message); }
  b.disabled = false;
}
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

/* ================================================================ searches */
async function Searches(sub) {
  const rows = must(await sb.from("fed_searches").select("*").order("name"));
  const n = (await db.rpc("fed_counts", {})).by_search || {};
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Searches</h1><p class="muted">Every active search is checked against each new batch of SAM.gov notices. Searches don't use extra API requests.</p></div>
      <div class="actions-row"><button class="btn primary" id="newS">${icon("plus")}New search</button></div></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Search</th><th>Criteria</th><th>New matches</th><th>Active</th></tr></thead><tbody>
    ${rows.map((s) => `<tr data-sid="${s.id}" tabindex="0"><td><b>${esc(s.name)}</b><div class="muted small">${esc(nameOf(s.owner_id))}</div></td><td class="small">${esc(summary(s))}</td>
      <td><a href="#/matches" data-show="${s.id}">${n[s.id] || 0}</a></td><td>${s.active ? "Yes" : "<span class='muted'>Paused</span>"}</td></tr>`).join("")
      || `<tr><td colspan="4" class="empty">No searches yet. Start with your NAICS codes and a few keywords.</td></tr>`}</tbody></table></div></section>`;
  $("#newS").addEventListener("click", () => editSearch(null));
  $$("tr[data-sid]").forEach((tr) => tr.addEventListener("click", (e) => { if (e.target.closest("[data-show]")) return; editSearch(rows.find((s) => s.id === +tr.dataset.sid)); }));
  $$("[data-show]").forEach((a) => a.addEventListener("click", () => { FD.search = a.dataset.show; FD.status = "New"; }));
  if (sub === "new") editSearch(null);
}
const nameOf = (id) => S.team.find((p) => p.id === id)?.display_name || "";
function summary(s) {
  const p = [];
  if (s.naics?.length) p.push("NAICS " + s.naics.join(", "));
  if (s.agencies?.length) p.push(s.agencies.join(", "));
  if (s.size !== "any") p.push(SIZES.find(([k]) => k === s.size)[1]);
  if (s.set_asides?.length) p.push(s.set_asides.join(", "));
  if (s.notice_types?.length) p.push(s.notice_types.join(", "));
  if (s.keywords?.length) p.push("“" + s.keywords.join("”, “") + "”");
  if (s.exclude?.length) p.push("not " + s.exclude.join(", "));
  return p.join(" · ") || "Everything";
}
function editSearch(s) {
  const v = s || { name: "", naics: [], agencies: [], size: "any", set_asides: [], notice_types: ["Solicitation", "Combined Synopsis/Solicitation", "Presolicitation", "Sources Sought"], keywords: [], exclude: [], open_only: true, active: true };
  $("#drawerTitle").textContent = s ? "Edit search" : "New search";
  $("#drawerBody").innerHTML = `<form id="sForm" class="form-grid">
    <label style="grid-column:1/-1">Name<input name="name" required value="${esc(v.name)}" placeholder="e.g. Stormwater, small business, EPA + USACE"></label>
    <label style="grid-column:1/-1">NAICS codes <small class="muted">comma-separated; 3–5 digits match every code that starts with them</small><input name="naics" value="${esc(v.naics.join(", "))}" placeholder="237110, 541330, 5413"></label>
    <label style="grid-column:1/-1">Agencies <small class="muted">any part of the agency or office name</small><input name="agencies" value="${esc(v.agencies.join(", "))}" placeholder="Environmental Protection Agency, Corps of Engineers, Interior"></label>
    <label style="grid-column:1/-1">Keywords in the title <small class="muted">any of these</small><input name="keywords" value="${esc(v.keywords.join(", "))}" placeholder="water, stormwater, groundwater, hydrology"></label>
    <label style="grid-column:1/-1">Leave out titles with<input name="exclude" value="${esc(v.exclude.join(", "))}" placeholder="janitorial, bottled water"></label>
    <label>Business size<select name="size">${SIZES.map(([k, l]) => `<option value="${k}" ${k === v.size ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="check" style="align-self:end"><input type="checkbox" name="open_only" ${v.open_only ? "checked" : ""}> Hide notices past their due date</label>
    <fieldset style="grid-column:1/-1"><legend>Set-aside type <small class="muted">none ticked = any</small></legend><div class="fed-checks">
      ${SET_ASIDES.map(([k, l]) => `<label class="check"><input type="checkbox" name="sa" value="${k}" ${v.set_asides.includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div></fieldset>
    <fieldset style="grid-column:1/-1"><legend>Notice type <small class="muted">none ticked = any</small></legend><div class="fed-checks">
      ${TYPES.map((k) => `<label class="check"><input type="checkbox" name="nt" value="${esc(k)}" ${v.notice_types.includes(k) ? "checked" : ""}> ${esc(k)}</label>`).join("")}</div></fieldset>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="active" ${v.active ? "checked" : ""}> Active</label>
    <div class="fed-preview" id="preview" style="grid-column:1/-1"></div>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save search</button>${s ? `<button type="button" class="btn danger" id="delS">Delete</button>` : ""}</div></form>`;
  openDrawer();
  const f = $("#sForm");
  const read = () => ({ name: f.name.value.trim(), naics: list(f.naics.value).map((x) => x.replace(/\D/g, "")).filter(Boolean), agencies: list(f.agencies.value),
    keywords: list(f.keywords.value), exclude: list(f.exclude.value), size: f.size.value, open_only: f.open_only.checked, active: f.active.checked,
    set_asides: $$("[name=sa]:checked", f).map((x) => x.value), notice_types: $$("[name=nt]:checked", f).map((x) => x.value) });
  const preview = debounce(async () => {
    try { const p = await db.rpc("fed_preview", { p: read() });
      $("#preview").innerHTML = `<b>${p.count}</b> notice${p.count === 1 ? "" : "s"} from the last three weeks match.${p.sample.length ? `<ul>${p.sample.map((x) => `<li>${esc(x.title)} <span class="muted">· ${esc(x.agency || "")} · ${short(x.posted_date)}</span></li>`).join("")}</ul>` : ""}`;
    } catch (e) { $("#preview").textContent = ""; }
  }, 400);
  f.addEventListener("input", preview); preview();
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const d = read();
    try {
      const row = must(s ? await sb.from("fed_searches").update(d).eq("id", s.id).select("id").single() : await sb.from("fed_searches").insert(d).select("id").single());
      const added = await db.rpc("fed_apply_search", { p_id: row.id });
      closeDrawer(); toast(`Search saved${added ? ` · ${added} match${added === 1 ? "" : "es"}` : ""}`); Searches();
    } catch (err) { toast(err.message); }
  });
  $("#delS")?.addEventListener("click", async () => {
    if (!confirm(`Delete the search “${s.name}”? Notices you saved or added stay.`)) return;
    try { must(await sb.from("fed_searches").delete().eq("id", s.id)); closeDrawer(); toast("Search deleted"); Searches(); } catch (err) { toast(err.message); }
  });
}

/* ================================================================ settings */
async function Settings() {
  const st = await db.rpc("fed_status", {});
  const calls = must(await sb.from("fed_calls").select("created_at, page_offset, posted_from, posted_to, status, http_status, records, total, error").order("id", { ascending: false }).limit(12));
  const ok = (b) => (b ? `<span class="pill s-won">${icon("check")}On</span>` : `<span class="pill s-lost">Off</span>`);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Federal settings</h1><p class="muted">Where notices come from and how often Pulse checks.</p></div></div>
    <section class="panel"><h2>SAM.gov API key</h2>
      ${st.has_key ? `<p>Saved (${esc(st.key_hint)}). It's stored encrypted in the database and can't be shown again.</p>` : `<p>Not set. Pulse uses your own key to read public notices from SAM.gov.</p>`}
      ${isAdmin() ? `<form id="keyForm" class="add-action" style="grid-template-columns:1fr auto auto"><input name="key" type="password" autocomplete="off" placeholder="${st.has_key ? "Paste a new key to replace it" : "SAM-xxxxxxxx-xxxx-…"}">
        <button class="btn primary">${st.has_key ? "Replace" : "Save key"}</button>${st.has_key ? `<button type="button" class="btn" id="clearKey">Remove</button>` : ""}</form>
      <p class="muted small">Get it on SAM.gov → your name → Account Details → Public API Key. SAM.gov keys expire every 90 days; Pulse shows an error here when it needs a new one.
        Without a role on your entity's SAM registration a personal key allows only 10 requests a day; with a role, 1,000.</p>` : `<p class="muted">Only admins can change the key.</p>`}
    </section>
    <section class="panel"><h2>Schedule</h2>
      <form id="cfgForm" class="form-grid">
        <label>Check SAM.gov<select name="every_min" ${isAdmin() ? "" : "disabled"}>${EVERY.map(([m, l]) => `<option value="${m}" ${m === st.every_min ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Daily request limit<input name="daily_budget" type="number" min="1" max="10000" value="${st.daily_budget}" ${isAdmin() ? "" : "disabled"}></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="enabled" ${st.enabled ? "checked" : ""} ${isAdmin() ? "" : "disabled"}> Automatic checks on</label>
        ${isAdmin() ? `<div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save schedule</button><button type="button" class="btn" id="runNow">${icon("return")}Check now</button></div>` : ""}
      </form>
      <p class="muted small">Each check reads today's notices (about 1–4 requests); once a day it also re-reads yesterday's to catch late postings. Every 15 minutes uses roughly 150–400 requests a day, hourly about 40–100.
        Used today: <b>${st.used_today}</b> of ${st.daily_budget}. ${st.last_status ? esc(st.last_status) + "." : ""} ${st.next_fetch_at && st.enabled ? `Next check ${new Date(st.next_fetch_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.` : ""}</p>
      ${st.last_error ? `<div class="notice-bar">${icon("alert")}<div>${esc(st.last_error)}</div></div>` : ""}
    </section>
    <section class="panel"><h2>Database timer</h2>
      <table class="agr-table"><tr><th>Web requests from the database (pg_net)</th><td>${ok(st.has_net)}</td></tr><tr><th>Timer (pg_cron job “pulse-federal”)</th><td>${ok(st.timer)}</td></tr><tr><th>Encrypted key storage (Vault)</th><td>${ok(st.has_vault)}</td></tr></table>
      ${st.has_net && st.timer && st.has_vault ? "" : `<p class="muted small">In Supabase: Database → Extensions, turn on <b>pg_net</b> and <b>pg_cron</b> (Vault is on by default), then run the latest <code>supabase/schema.sql</code> once more to create the timer.</p>`}
    </section>
    <section class="panel" style="padding:0"><h2 style="padding:16px 18px 0">Recent requests</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>Posted dates</th><th>Page</th><th>Result</th></tr></thead><tbody>
      ${calls.map((c) => `<tr style="cursor:default"><td>${ago(c.created_at)}</td><td>${short(c.posted_from)}${c.posted_to !== c.posted_from ? "–" + short(c.posted_to) : ""}</td><td>${c.page_offset / 1000 + 1}</td>
        <td>${c.status === "done" ? `${c.records} of ${c.total} notices` : c.status === "pending" ? "Waiting…" : `<span class="red">${esc(c.http_status ? "Error " + c.http_status : "Error")}</span> <span class="muted small">${esc((c.error || "").slice(0, 120))}</span>`}</td></tr>`).join("")
        || `<tr><td colspan="4" class="empty">No requests yet.</td></tr>`}</tbody></table></div></section>
    <section class="panel"><h2>Other sources</h2><p class="muted">Contracts posted on FedConnect over $25,000 also appear on SAM.gov, so they come through here.
      Grants.gov (federal grants, including DOE funding notices) and eVA (Virginia) aren't connected yet; eVA has no API for open bids, so use its email alerts by NIGP code for now.</p></section>`;
  if (!isAdmin()) return;
  $("#keyForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const k = e.target.key.value.trim(); if (!k) return;
    try { await db.rpc("fed_set_key", { p_key: k }); e.target.key.value = ""; toast("API key saved"); Settings(); } catch (err) { toast(err.message); }
  });
  $("#clearKey")?.addEventListener("click", async () => { if (!confirm("Remove the SAM.gov API key? Pulse stops checking until a new key is saved.")) return;
    try { await db.rpc("fed_clear_key", {}); toast("Key removed"); Settings(); } catch (err) { toast(err.message); } });
  $("#cfgForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target;
    try { await db.rpc("fed_save_config", { p: { every_min: +f.every_min.value, daily_budget: +f.daily_budget.value, enabled: f.enabled.checked } }); toast("Schedule saved"); Settings(); } catch (err) { toast(err.message); }
  });
  $("#runNow").addEventListener("click", async () => { try { await db.rpc("fed_run_now", {}); toast("Checking SAM.gov now"); setTimeout(() => location.hash === "#/settings" && Settings(), 20000); } catch (err) { toast(err.message); } });
}

/* ================================================================ router */
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const key = { matches: 1, searches: 1, settings: 1 }[parts[0]] ? parts[0] : "matches";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve({ matches: Matches, searches: () => Searches(parts[1]), settings: Settings }[key]())
    .catch((e) => ($("#main").innerHTML = setupNeeded(e)
      ? `<section class="panel"><h2>One-time setup needed</h2><p>Federal opportunities needs the latest database update. An admin runs the latest <code>supabase/schema.sql</code> in the Supabase SQL Editor.</p></section>`
      : `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try {
    if (!(await requireMember())) return;
    if (S.profile.role === "contractor") { location.replace("../"); return; }
    showShell(); route();
  } catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
