/* Pulse · Opportunities — saved searches over federal contracts (SAM.gov) and grants (Grants.gov). The database pulls
   new notices on a timer (see "Opportunities" in schema.sql) and matches every search locally; this page shows the
   matches, lets you save, dismiss, add a contract to Business Review's pipeline or a grant to Funding, and holds the
   searches and settings. */
"use strict";

const FD = { source: "SAM.gov", status: "New", search: "", q: "", sort: "posted", level: "", kw: "", naics: "" };
const LEVELS = ["Federal", "State", "Local", "Education"];
const SRC = { "SAM.gov": { tab: "contracts", label: "Contracts", noun: "notices", site: "SAM.gov" }, "Grants.gov": { tab: "grants", label: "Grants", noun: "grants", site: "Grants.gov" }, BidMatch: { tab: "contracts/bids", label: "Bids", noun: "bids", site: "MyBidMatch" } };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const isAdmin = () => S.profile?.role === "admin";

const SET_ASIDES = [
  ["SBA", "Total Small Business"], ["SBP", "Partial Small Business"], ["8A", "8(a)"], ["8AN", "8(a) sole source"],
  ["HZC", "HUBZone"], ["HZS", "HUBZone sole source"], ["SDVOSBC", "Service-Disabled Veteran-Owned"], ["SDVOSBS", "SDVOSB sole source"],
  ["WOSB", "Women-Owned Small Business"], ["WOSBSS", "WOSB sole source"], ["EDWOSB", "Economically Disadvantaged WOSB"], ["EDWOSBSS", "EDWOSB sole source"],
  ["VSA", "Veteran-Owned (VA)"], ["VSS", "Veteran-Owned sole source (VA)"], ["IEE", "Indian Economic Enterprise"], ["ISBEE", "Indian Small Business Economic Enterprise"],
  ["BICiv", "Buy Indian"], ["LAS", "Local Area Set-Aside"],
];
const GRANT_TYPES = ["Posted", "Forecasted"];
// PSC / FSG first letter (service category); digits are supply groups
const PSC = { A: "Research & development", B: "Special studies & analysis", C: "Architect & engineering", D: "IT & telecom", E: "Purchase of structures", F: "Natural resources management",
  G: "Social services", H: "Quality control & testing", J: "Maintenance & repair of equipment", K: "Modification of equipment", L: "Technical representative", M: "Operation of facilities",
  N: "Installation of equipment", P: "Salvage", Q: "Medical", R: "Professional & support services", S: "Utilities & housekeeping", T: "Photo, mapping & printing", U: "Education & training",
  V: "Transportation & travel", W: "Lease or rental of equipment", X: "Lease or rental of facilities", Y: "Construction of structures", Z: "Maintenance of real property" };
const pscLabel = (c) => (c ? (PSC[String(c)[0].toUpperCase()] ? `${c} · ${PSC[String(c)[0].toUpperCase()]}` : /^[0-9]/.test(c) ? `${c} · Supplies` : c) : "");
// keywords that put a notice in front of you: MyBidMatch's own profile terms, or the search keywords found in the title
function keywordsOf(r) {
  if (r.source === "BidMatch") return String(r.bm_keywords || "").split(";").map((k) => k.trim()).filter((k) => k && !/^naics!/i.test(k)).map((k) => k.replace(/^ti:/i, "").replace(/[*?]+$/, ""));
  const t = (r.title || "").toLowerCase(), out = new Set();
  (r.searches || []).forEach((id) => (KW[id] || []).forEach((k) => { if (t.includes(k.toLowerCase())) out.add(k); }));
  return [...out];
}
const naicsOf = (r) => [...new Set([...(r.naics_all || []), r.naics].filter(Boolean))];
let KW = {};
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
  const grants = FD.source === "Grants.gov", bm = FD.source === "BidMatch", src = SRC[FD.source];
  const [allSearches, st, counts] = await Promise.all([must(await sb.from("fed_searches").select("id, name, active, source, keywords").order("name")), db.rpc("fed_status", {}), db.rpc("fed_counts", {})]);
  const searches = allSearches.filter((s) => s.source === FD.source);
  if (FD.search && !searches.some((s) => String(s.id) === FD.search)) FD.search = "";
  KW = Object.fromEntries(allSearches.map((s) => [s.id, s.keywords || []]));
  let rows = await db.rpc("fed_list", { p_source: FD.source, p_status: FD.status, p_search: FD.search ? +FD.search : null, p_sort: FD.sort });
  const kwAll = {}, naicsAll = {};
  rows.forEach((r) => { keywordsOf(r).forEach((k) => (kwAll[k] = (kwAll[k] || 0) + 1)); naicsOf(r).forEach((n) => (naicsAll[n] = (naicsAll[n] || 0) + 1)); });
  if (FD.kw && !kwAll[FD.kw]) FD.kw = ""; if (FD.naics && !naicsAll[FD.naics]) FD.naics = "";
  const levelCounts = {}; if (bm) rows.forEach((r) => (levelCounts[r.level || "Other"] = (levelCounts[r.level || "Other"] || 0) + 1));
  if (bm && FD.level) rows = rows.filter((r) => (r.level || "Other") === FD.level);
  if (FD.kw) rows = rows.filter((r) => keywordsOf(r).includes(FD.kw));
  if (FD.naics) rows = rows.filter((r) => naicsOf(r).includes(FD.naics));
  if (FD.q) { const t = FD.q.toLowerCase(); rows = rows.filter((r) => [r.title, r.sol_number, r.agency, r.subtier, r.office, r.naics, (r.aln || []).join(" "), r.summary].join(" ").toLowerCase().includes(t)); }
  const sname = Object.fromEntries(searches.map((s) => [s.id, s.name]));
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${grants ? "Grants" : "Contracts"}</h1><p class="muted">${bm ? "Bids from your APEX Accelerator MyBidMatch lists: federal, state, local and education." : (grants ? "Open and forecasted Grants.gov grants" : "Federal notices from SAM.gov") + " that match your searches."} ${bm ? bmLine(st) : statusLine(st, grants)}</p></div>
      <div class="actions-row"><button class="btn" id="runNow">${icon("return")}Check now</button>${bm ? `<a class="btn" href="#/settings">${icon("cog")}MyBidMatch link</a>` : `<a class="btn primary" href="#/searches/new?${grants ? "grants" : "contracts"}">${icon("plus")}New search</a>`}</div></div>
    ${grants ? "" : `<div class="tabs src-tabs">${[["SAM.gov", "#/contracts", "SAM.gov"], ["BidMatch", "#/contracts/bids", "APEX BidMatch"]].map(([k, href, l]) => `<a href="${href}" aria-selected="${k === FD.source}">${l}${counts.by_source?.[k] ? ` <span class="count">${counts.by_source[k]}</span>` : ""}</a>`).join("")}</div>`}
    ${bm ? bmBanner(st) : banner(st, searches, grants)}
    ${bm ? `<div class="fed-levels">${["", ...LEVELS].map((l) => `<button class="chip ${FD.level === l ? "on" : ""}" data-lv="${l}">${l || "All"}${l ? ` <span>${levelCounts[l] || 0}</span>` : ""}</button>`).join("")}</div>` : ""}
    <div class="filters">
      <div class="tabs">${["New", "Saved", "Added", "Dismissed", "All"].map((k) => `<button data-st="${k}" aria-selected="${FD.status === k}">${k}</button>`).join("")}</div>
      <select id="fSearch" ${bm ? "hidden" : ""}><option value="">All searches</option>${searches.map((s) => `<option value="${s.id}" ${String(s.id) === FD.search ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      ${grants ? "" : `<select id="fKw"><option value="">All keywords</option>${Object.entries(kwAll).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<option value="${esc(k)}" ${k === FD.kw ? "selected" : ""}>${esc(k)} (${n})</option>`).join("")}</select>
      <select id="fNaics"><option value="">All NAICS</option>${Object.entries(naicsAll).sort().map(([k, n]) => `<option value="${esc(k)}" ${k === FD.naics ? "selected" : ""}>${esc(k)} (${n})</option>`).join("")}</select>`}
      <select id="fSort"><option value="posted" ${FD.sort === "posted" ? "selected" : ""}>Newest first</option><option value="due" ${FD.sort === "due" ? "selected" : ""}>Due soonest</option></select>
      <input id="fQ" type="search" placeholder="Filter by title, agency, ${grants ? "assistance listing" : bm ? "text" : "NAICS"}…" value="${esc(FD.q)}">
    </div>
    <div class="fed-list">${rows.map((r) => card(r, sname)).join("") || `<div class="empty">${FD.status === "New" ? "No new matches right now." : "Nothing here."}${bm || searches.length ? "" : ` <a href="#/searches/new?${grants ? "grants" : "contracts"}">Create your first ${grants ? "grants" : "contracts"} search</a>.`}</div>`}</div>`;
  $$("[data-st]").forEach((b) => b.addEventListener("click", () => { FD.status = b.dataset.st; Matches(); }));
  $$("[data-lv]").forEach((b) => b.addEventListener("click", () => { FD.level = b.dataset.lv; Matches(); }));
  $("#fSearch").addEventListener("change", (e) => { FD.search = e.target.value; Matches(); });
  $("#fSort").addEventListener("change", (e) => { FD.sort = e.target.value; Matches(); });
  $("#fKw")?.addEventListener("change", (e) => { FD.kw = e.target.value; Matches(); });
  $("#fNaics")?.addEventListener("change", (e) => { FD.naics = e.target.value; Matches(); });
  $$("[data-more]").forEach((b) => b.addEventListener("click", () => { const p = b.previousElementSibling; const open = p.classList.toggle("open"); b.textContent = open ? "Show less" : "Show full description"; }));
  $("#fQ").addEventListener("input", debounce((e) => { FD.q = e.target.value; Matches().then(() => { const i = $("#fQ"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300));
  $("#runNow").addEventListener("click", runNow);
  $$("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, b.closest("[data-nid]").dataset.nid, b)));
  rowsCache = Object.fromEntries(rows.map((r) => [r.notice_id, r]));
}
let rowsCache = {};
function classes(r) {
  const kws = keywordsOf(r), codes = naicsOf(r), rows = [];
  if (codes.length) rows.push(`<div><dt>NAICS</dt><dd>${codes.map((c) => `<button type="button" class="tag" data-pick-naics="${esc(c)}">${esc(c)}</button>`).join(" ")}</dd></div>`);
  if (kws.length) rows.push(`<div><dt>Keywords</dt><dd>${kws.map((k) => `<button type="button" class="tag kw" data-pick-kw="${esc(k)}">${esc(k)}</button>`).join(" ")}</dd></div>`);
  if (r.psc) rows.push(`<div><dt>Category</dt><dd>${esc(pscLabel(r.psc))}</dd></div>`);
  if (r.set_aside) rows.push(`<div><dt>Set-aside</dt><dd>${esc(r.set_aside)}</dd></div>`);
  if (r.level) rows.push(`<div><dt>Level</dt><dd>${esc(r.level)}</dd></div>`);
  return rows.length ? `<dl class="fed-class">${rows.join("")}</dl>` : "";
}
document.addEventListener("click", (e) => {
  const n = e.target.closest("[data-pick-naics]"), k = e.target.closest("[data-pick-kw]");
  if (n) { FD.naics = n.dataset.pickNaics; Matches(); } else if (k) { FD.kw = k.dataset.pickKw; Matches(); }
});
function bmLine(st) {
  if (!st.has_bidmatch) return "";
  return st.bidmatch_fetch_at ? `Last read ${ago(st.bidmatch_fetch_at)}.` : "First read in progress.";
}
function bmBanner(st) {
  const msgs = [];
  if (!st.has_bidmatch) msgs.push(isAdmin() ? `Paste your MyBidMatch link in <a href="#/settings">Settings</a> (from any MyBidMatch email: “mybidmatch.outreachsystems.com/go?sub=…”).` : "An admin needs to add the MyBidMatch link in Settings.");
  else if (!st.has_net || !st.timer) msgs.push(`Automatic checks are off: the database timer isn't set up yet.`);
  if (st.bidmatch_error) msgs.push(esc(st.bidmatch_error));
  return msgs.map((m) => `<div class="notice-bar">${icon("alert")}<div>${m}</div></div>`).join("");
}
function card(r, sname) {
  const hits = (r.searches || []).map((id) => sname[id]).filter(Boolean), grant = r.source === "Grants.gov", bmr = r.source === "BidMatch";
  const done = grant ? `<a class="btn small" href="../funding/#/funding/${r.funding_id}">${icon("check")}In Funding</a>` : `<a class="btn small" href="../review/#/opportunities/${r.opportunity_id}">${icon("check")}In pipeline</a>`;
  return `<article class="panel fed-card ${r.status === "Dismissed" ? "muted" : ""}" data-nid="${esc(r.notice_id)}">
    <div class="fed-main">
      <div class="fed-top">${bmr ? `<span class="pill lv-${esc((r.level || "other").toLowerCase())}">${esc(r.level || "Other")}</span>` : ""}<span class="pill ${r.notice_type === "Forecasted" ? "s-high" : ""}">${esc(r.notice_type || "Notice")}</span>${r.set_aside ? `<span class="pill s-won" title="${esc(r.set_aside)}">${esc(r.set_aside_code || "Set-aside")}</span>` : ""}
        ${hits.map((h) => `<span class="fed-hit">${icon("search")}${esc(h)}</span>`).join("")}</div>
      <h3><a href="${esc(r.ui_link || "https://sam.gov/opp/" + r.notice_id + "/view")}" target="_blank" rel="noopener">${esc(r.title || "(untitled)")} <svg class="ic ext-ic"><use href="#i-external"/></svg></a></h3>
      <p class="muted small">${esc(grant ? [r.agency, r.subtier].filter(Boolean).join(" · ") : [r.agency, r.subtier, r.office].filter((x, i, a) => x && a.indexOf(x) === i).join(" · "))}</p>
      ${r.summary ? `<p class="fed-sum">${esc(r.summary.replace(/^[A-Z0-9]{1,2} -{1,2} /, ""))}</p>${r.summary.length > 320 ? `<button type="button" class="link-btn" data-more>Show full description</button>` : ""}` : ""}
      ${grant ? "" : classes(r)}
      <dl class="fed-facts">
        <div><dt>${grant ? "Opens" : bmr ? "Listed" : "Posted"}</dt><dd>${short(r.posted_date) || "—"}</dd></div>
        <div><dt>${grant ? "Closes" : "Due"}</dt><dd>${dueTxt(r.response_deadline)}</dd></div>
        ${grant ? `<div><dt>Assistance listing</dt><dd>${esc((r.aln || []).join(", ") || "—")}</dd></div><div><dt>Opportunity #</dt><dd>${esc(r.sol_number || "—")}</dd></div>`
          : `<div><dt>Sol. #</dt><dd>${esc(r.sol_number || "—")}</dd></div>`}
        ${r.state || r.city ? `<div><dt>Place</dt><dd>${esc([r.city, r.state].filter(Boolean).join(", "))}</dd></div>` : ""}
        ${r.awardee ? `<div><dt>Awarded</dt><dd>${esc(r.awardee)}${r.award_amount ? " · " + money(r.award_amount) : ""}</dd></div>` : ""}
      </dl>
    </div>
    <div class="fed-actions">
      ${r.status === "Added" ? done
        : `<button class="btn small primary" data-act="add" title="${grant ? "Adds it to the Funding app" : "Adds it to Business Review → Opportunities"}">${icon("plus")}${grant ? "Add to Funding" : "Add to pipeline"}</button>
           ${r.status !== "Saved" ? `<button class="btn small" data-act="Saved">Save</button>` : `<button class="btn small" data-act="New">Unsave</button>`}
           ${r.status !== "Dismissed" ? `<button class="btn small" data-act="Dismissed">Dismiss</button>` : `<button class="btn small" data-act="New">Restore</button>`}`}
    </div></article>`;
}
async function act(what, nid, btn) {
  btn.disabled = true;
  try {
    if (what === "add" && FD.source === "Grants.gov") {
      const id = await db.rpc("fed_add_to_funding", { p_notice: nid });
      toast("Added to Funding");
      btn.closest(".fed-card").querySelector(".fed-actions").innerHTML = `<a class="btn small" href="../funding/#/funding/${id}">${icon("check")}In Funding</a>`;
    } else if (what === "add") {
      const kinds = workspaceSettings(S.workspace).lists["opportunities.kind"] || [];
      const lvl = FD.source === "BidMatch" ? (rowsCache[nid]?.level || "") : "Federal";
      const kind = lvl === "Federal" ? kinds.find((k) => /federal/i.test(k)) || kinds.find((k) => /contract/i.test(k)) || ""
        : kinds.find((k) => /state|local/i.test(k)) || kinds.find((k) => /contract/i.test(k)) || "";
      const id = await db.rpc("fed_add_to_opportunities", { p_notice: nid, p_kind: kind || null });
      toast("Added to the pipeline"); const c = btn.closest(".fed-card");
      c.querySelector(".fed-actions").innerHTML = `<a class="btn small" href="../review/#/opportunities/${id}">${icon("check")}In pipeline</a>`;
    } else {
      await db.rpc("fed_set_status", { p_notices: [nid], p_status: what });
      const c = btn.closest(".fed-card"); if (FD.status !== "All") { c.remove(); } else Matches();
      toast(what === "Dismissed" ? "Dismissed" : what === "Saved" ? "Saved" : "Moved back to New");
    }
  } catch (e) { btn.disabled = false; toast(e.message); }
}
function statusLine(st, grants) {
  const every = (EVERY.find(([m]) => m === st.every_min) || [, `every ${st.every_min} min`])[1].toLowerCase();
  const last = grants ? st.grants_fetch_at : st.last_fetch_at;
  if (!grants && !st.has_key) return "";
  return `Checks ${grants ? "Grants.gov" : "SAM.gov"} ${every}${last ? `; last check ${ago(last)}` : ""}.`;
}
function banner(st, searches, grants) {
  const msgs = [];
  if (!grants && !st.has_key) msgs.push(isAdmin() ? `Add your SAM.gov API key in <a href="#/settings">Settings</a> to start pulling contract notices.` : `An admin needs to add the SAM.gov API key in Settings.`);
  else if (!st.has_net || !st.timer) msgs.push(`Automatic checks are off: the database timer isn't set up yet. ${isAdmin() ? `See <a href="#/settings">Settings</a>.` : "Ask an admin."}`);
  const err = grants ? st.grants_error : st.last_error;
  if (err) msgs.push(esc(err));
  else if (!grants && /^Paused/.test(st.last_status || "")) msgs.push(esc(st.last_status));
  if (!grants && st.has_key && !searches.length) msgs.push(`Notices are coming in. <a href="#/searches/new?contracts">Create a search</a> to see the ones that fit.`);
  if (grants && !searches.length) msgs.push(`<a href="#/searches/new?grants">Create a grants search</a>; Pulse then reads Grants.gov's open and forecasted grants (no key needed).`);
  return msgs.map((m) => `<div class="notice-bar">${icon("alert")}<div>${m}</div></div>`).join("");
}
async function runNow() {
  const b = $("#runNow"); b.disabled = true;
  try { await db.rpc("fed_run_now", {}); toast("Checking now; results arrive within a few minutes"); setTimeout(() => { if (/^#\/?(contracts|contracts\/bids|grants)?$/.test(location.hash)) Matches(); }, 90000); }
  catch (e) { toast(e.message); }
  b.disabled = false;
}
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

/* ================================================================ searches */
async function Searches(sub) {
  const rows = must(await sb.from("fed_searches").select("*").order("source").order("name"));
  const n = (await db.rpc("fed_counts", {})).by_search || {};
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Searches</h1><p class="muted">Every active search is checked against each new batch of notices and grants. Searches don't use extra SAM.gov requests.</p></div>
      <div class="actions-row"><button class="btn" id="newG">${icon("plus")}Grants search</button><button class="btn primary" id="newS">${icon("plus")}Contracts search</button></div></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Search</th><th>For</th><th>Criteria</th><th>New matches</th><th>Active</th></tr></thead><tbody>
    ${rows.map((s) => `<tr data-sid="${s.id}" tabindex="0"><td><b>${esc(s.name)}</b><div class="muted small">${esc(nameOf(s.owner_id))}</div></td><td>${s.source === "Grants.gov" ? "Grants" : "Contracts"}</td><td class="small">${esc(summary(s))}</td>
      <td><a href="#/${SRC[s.source].tab}" data-show="${s.id}" data-src="${s.source}">${n[s.id] || 0}</a></td><td>${s.active ? "Yes" : "<span class='muted'>Paused</span>"}</td></tr>`).join("")
      || `<tr><td colspan="5" class="empty">No searches yet. Start with your NAICS codes or assistance listings and a few keywords.</td></tr>`}</tbody></table></div></section>`;
  $("#newS").addEventListener("click", () => editSearch(null, "SAM.gov"));
  $("#newG").addEventListener("click", () => editSearch(null, "Grants.gov"));
  $$("tr[data-sid]").forEach((tr) => tr.addEventListener("click", (e) => { if (e.target.closest("[data-show]")) return; editSearch(rows.find((s) => s.id === +tr.dataset.sid)); }));
  $$("[data-show]").forEach((a) => a.addEventListener("click", () => { FD.source = a.dataset.src; FD.search = a.dataset.show; FD.status = "New"; }));
  if (sub === "new") editSearch(null, /grants/.test(location.hash) ? "Grants.gov" : "SAM.gov");
}
const nameOf = (id) => S.team.find((p) => p.id === id)?.display_name || "";
function summary(s) {
  const p = [];
  if (s.naics?.length) p.push("NAICS " + s.naics.join(", "));
  if (s.aln?.length) p.push("Listing " + s.aln.join(", "));
  if (s.agencies?.length) p.push(s.agencies.join(", "));
  if (s.source !== "Grants.gov" && s.size !== "any") p.push(SIZES.find(([k]) => k === s.size)[1]);
  if (s.set_asides?.length) p.push(s.set_asides.join(", "));
  if (s.notice_types?.length) p.push(s.notice_types.join(", "));
  if (s.keywords?.length) p.push("“" + s.keywords.join("”, “") + "”");
  if (s.exclude?.length) p.push("not " + s.exclude.join(", "));
  return p.join(" · ") || "Everything";
}
function editSearch(s, source) {
  const src = s?.source || source || "SAM.gov", grants = src === "Grants.gov";
  const v = s || { name: "", naics: [], aln: [], agencies: [], size: "any", set_asides: [], keywords: [], exclude: [], open_only: true, active: true,
    notice_types: grants ? ["Posted", "Forecasted"] : ["Solicitation", "Combined Synopsis/Solicitation", "Presolicitation", "Sources Sought"] };
  $("#drawerTitle").textContent = `${s ? "Edit" : "New"} ${grants ? "grants" : "contracts"} search`;
  $("#drawerBody").innerHTML = `<form id="sForm" class="form-grid">
    <p class="muted small" style="grid-column:1/-1;margin:0">${grants ? "Open and forecasted grants from Grants.gov." : "Contract notices from SAM.gov."}</p>
    <label style="grid-column:1/-1">Name<input name="name" required value="${esc(v.name)}" placeholder="${grants ? "e.g. Water infrastructure grants" : "e.g. Stormwater, small business, EPA + USACE"}"></label>
    ${grants ? `<label style="grid-column:1/-1">Assistance listings (CFDA) <small class="muted">comma-separated; "66." matches every EPA listing</small><input name="aln" value="${esc((v.aln || []).join(", "))}" placeholder="66.458, 10.760, 15."></label>`
      : `<label style="grid-column:1/-1">NAICS codes <small class="muted">comma-separated; 3–5 digits match every code that starts with them</small><input name="naics" value="${esc(v.naics.join(", "))}" placeholder="237110, 541330, 5413"></label>`}
    <label style="grid-column:1/-1">Agencies <small class="muted">any part of the agency name${grants ? " or code" : " or office"}</small><input name="agencies" value="${esc(v.agencies.join(", "))}" placeholder="${grants ? "EPA, USDA, Bureau of Reclamation" : "Environmental Protection Agency, Corps of Engineers, Interior"}"></label>
    <label style="grid-column:1/-1">Keywords in the title <small class="muted">any of these</small><input name="keywords" value="${esc(v.keywords.join(", "))}" placeholder="water, stormwater, groundwater, hydrology"></label>
    <label style="grid-column:1/-1">Leave out titles with<input name="exclude" value="${esc(v.exclude.join(", "))}" placeholder="${grants ? "fellowship, training" : "janitorial, bottled water"}"></label>
    ${grants ? "" : `<label>Business size<select name="size">${SIZES.map(([k, l]) => `<option value="${k}" ${k === v.size ? "selected" : ""}>${l}</option>`).join("")}</select></label>`}
    <label class="check" style="align-self:end"><input type="checkbox" name="open_only" ${v.open_only ? "checked" : ""}> Hide ${grants ? "grants past their closing date" : "notices past their due date"}</label>
    ${grants ? "" : `<fieldset style="grid-column:1/-1"><legend>Set-aside type <small class="muted">none ticked = any</small></legend><div class="fed-checks">
      ${SET_ASIDES.map(([k, l]) => `<label class="check"><input type="checkbox" name="sa" value="${k}" ${v.set_asides.includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div></fieldset>`}
    <fieldset style="grid-column:1/-1"><legend>${grants ? "Status" : "Notice type"} <small class="muted">none ticked = any</small></legend><div class="fed-checks">
      ${(grants ? GRANT_TYPES : TYPES).map((k) => `<label class="check"><input type="checkbox" name="nt" value="${esc(k)}" ${v.notice_types.includes(k) ? "checked" : ""}> ${esc(k)}</label>`).join("")}</div></fieldset>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="active" ${v.active ? "checked" : ""}> Active</label>
    <div class="fed-preview" id="preview" style="grid-column:1/-1"></div>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save search</button>${s ? `<button type="button" class="btn danger" id="delS">Delete</button>` : ""}</div></form>`;
  openDrawer();
  const f = $("#sForm");
  const read = () => ({ source: src, name: f.name.value.trim(), agencies: list(f.agencies.value), keywords: list(f.keywords.value), exclude: list(f.exclude.value),
    open_only: f.open_only.checked, active: f.active.checked, notice_types: $$("[name=nt]:checked", f).map((x) => x.value),
    naics: grants ? [] : list(f.naics.value).map((x) => x.replace(/\D/g, "")).filter(Boolean), aln: grants ? list(f.aln.value).map((x) => x.replace(/[^\d.]/g, "")).filter(Boolean) : [],
    size: grants ? "any" : f.size.value, set_asides: grants ? [] : $$("[name=sa]:checked", f).map((x) => x.value) });
  const preview = debounce(async () => {
    try { const p = await db.rpc("fed_preview", { p: read() });
      $("#preview").innerHTML = `<b>${p.count}</b> ${grants ? "grant" : "notice"}${p.count === 1 ? "" : "s"} ${grants ? "currently listed" : "from the last three weeks"} match.${p.sample.length ? `<ul>${p.sample.map((x) => `<li>${esc(x.title)} <span class="muted">· ${esc(x.agency || "")} · ${short(x.posted_date)}</span></li>`).join("")}</ul>` : ""}`;
    } catch (e) { $("#preview").textContent = ""; }
  }, 400);
  f.addEventListener("input", preview); preview();
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const d = read();
    try {
      const row = must(s ? await sb.from("fed_searches").update(d).eq("id", s.id).select("id").single() : await sb.from("fed_searches").insert(d).select("id").single());
      const added = await db.rpc("fed_apply_search", { p_id: row.id });
      closeDrawer(); toast(`Search saved${added ? ` · ${added} match${added === 1 ? "" : "es"}` : grants ? " · reading Grants.gov" : ""}`); Searches();
    } catch (err) { toast(err.message); }
  });
  $("#delS")?.addEventListener("click", async () => {
    if (!confirm(`Delete the search “${s.name}”? Items you saved or added stay.`)) return;
    try { must(await sb.from("fed_searches").delete().eq("id", s.id)); closeDrawer(); toast("Search deleted"); Searches(); } catch (err) { toast(err.message); }
  });
}

/* ================================================================ settings */
async function Settings() {
  const st = await db.rpc("fed_status", {});
  const calls = must(await sb.from("fed_calls").select("created_at, source, ref, page_offset, posted_from, posted_to, status, http_status, records, total, error").order("id", { ascending: false }).limit(12));
  const ok = (b) => (b ? `<span class="pill s-won">${icon("check")}On</span>` : `<span class="pill s-lost">Off</span>`);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p class="muted">Where contracts and grants come from and how often Pulse checks.</p></div></div>
    <section class="panel"><h2>SAM.gov API key</h2>
      ${st.has_key ? `<p>Saved (${esc(st.key_hint)}). It's stored encrypted in the database and can't be shown again.</p>` : `<p>Not set. Pulse uses your own key to read public notices from SAM.gov.</p>`}
      ${isAdmin() ? `<form id="keyForm" class="add-action" style="grid-template-columns:1fr auto auto"><input name="key" type="password" autocomplete="off" placeholder="${st.has_key ? "Paste a new key to replace it" : "SAM-xxxxxxxx-xxxx-…"}">
        <button class="btn primary">${st.has_key ? "Replace" : "Save key"}</button>${st.has_key ? `<button type="button" class="btn" id="clearKey">Remove</button>` : ""}</form>
      <p class="muted small">Get it on SAM.gov → your name → Account Details → Public API Key. SAM.gov keys expire every 90 days; Pulse shows an error here when it needs a new one.
        Without a role on your entity's SAM registration a personal key allows only 10 requests a day; with a role, 1,000.</p>` : `<p class="muted">Only admins can change the key.</p>`}
    </section>
    <section class="panel"><h2>Grants.gov</h2>
      <p>No key needed. When you have at least one active grants search, each check reads all open and forecasted grants (about 2–4 requests).
        ${st.grants_fetch_at ? `Last read ${ago(st.grants_fetch_at)}; ${st.grants} grants listed.` : "Not read yet."}</p>
      ${st.grants_error ? `<div class="notice-bar">${icon("alert")}<div>${esc(st.grants_error)}</div></div>` : ""}
    </section>
    <section class="panel"><h2>MyBidMatch</h2>
      ${st.has_bidmatch ? `<p>Linked (${esc(st.bidmatch_hint)}). ${st.bidmatch_fetch_at ? `Last read ${ago(st.bidmatch_fetch_at)}; ${st.bidmatch} bids from the last 3 days.` : "First read in progress."}</p>` : `<p>Not linked. Pulse reads your daily MyBidMatch lists (federal, state, local and education bids matched by your APEX profile) and sorts them by level.</p>`}
      ${isAdmin() ? `<form id="bmForm" class="add-action" style="grid-template-columns:1fr auto auto"><input name="link" type="password" autocomplete="off" placeholder="https://mybidmatch.outreachsystems.com/go?sub=…">
        <button class="btn primary">${st.has_bidmatch ? "Replace" : "Save link"}</button>${st.has_bidmatch ? `<button type="button" class="btn" id="clearBm">Remove</button>` : ""}</form>
        <p class="muted small">The link is in every MyBidMatch email. It's stored encrypted like the API key. Pulse reads the last 3 days of lists, and each bid's details once.</p>` : ""}
      ${st.bidmatch_error ? `<div class="notice-bar">${icon("alert")}<div>${esc(st.bidmatch_error)}</div></div>` : ""}
    </section>
    <section class="panel"><h2>Schedule</h2>
      <form id="cfgForm" class="form-grid">
        <label>Check for new contracts and grants<select name="every_min" ${isAdmin() ? "" : "disabled"}>${EVERY.map(([m, l]) => `<option value="${m}" ${m === st.every_min ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Daily request limit<input name="daily_budget" type="number" min="1" max="10000" value="${st.daily_budget}" ${isAdmin() ? "" : "disabled"}></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="enabled" ${st.enabled ? "checked" : ""} ${isAdmin() ? "" : "disabled"}> Automatic checks on</label>
        ${isAdmin() ? `<div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save schedule</button><button type="button" class="btn" id="runNow">${icon("return")}Check now</button></div>` : ""}
      </form>
      <p class="muted small">Each SAM.gov check reads today's notices in pages of 200 (about 5–15 requests); once a day it also re-reads yesterday's to catch late postings. Once a day uses about 10–25 SAM.gov requests; hourly 150–300; every 15 minutes more than most keys allow. The daily limit counts SAM.gov requests only.
        Used today: <b>${st.used_today}</b> of ${st.daily_budget}. ${st.last_status ? esc(st.last_status) + "." : ""} ${st.next_fetch_at && st.enabled ? `Next check ${new Date(st.next_fetch_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.` : ""}</p>
      ${st.last_error ? `<div class="notice-bar">${icon("alert")}<div>${esc(st.last_error)}</div></div>` : ""}
    </section>
    <section class="panel"><h2>Database timer</h2>
      <table class="agr-table"><tr><th>Web requests from the database (pg_net)</th><td>${ok(st.has_net)}</td></tr><tr><th>Timer (pg_cron job “pulse-federal”)</th><td>${ok(st.timer)}</td></tr><tr><th>Encrypted key storage (Vault)</th><td>${ok(st.has_vault)}</td></tr></table>
      ${st.has_net && st.timer && st.has_vault ? "" : `<p class="muted small">In Supabase: Database → Extensions, turn on <b>pg_net</b> and <b>pg_cron</b> (Vault is on by default), then run the latest <code>supabase/schema.sql</code> once more to create the timer.</p>`}
    </section>
    <section class="panel" style="padding:0"><h2 style="padding:16px 18px 0">Recent requests</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>Source</th><th>Posted dates</th><th>Page</th><th>Result</th></tr></thead><tbody>
      ${calls.map((c) => `<tr style="cursor:default"><td>${ago(c.created_at)}</td><td>${esc(c.source)}</td><td>${c.source === "BidMatch" ? esc({ sub: "List of days", doc: "Day's list", article: "Bid details" }[(c.ref || "").split(":")[0]] || "") : c.posted_from ? short(c.posted_from) + (c.posted_to !== c.posted_from ? "–" + short(c.posted_to) : "") : "All open"}</td><td>${c.source === "BidMatch" ? (c.page_offset || "") : Math.floor(c.page_offset / (c.source === "SAM.gov" ? 200 : 1000)) + 1}</td>
        <td>${c.status === "done" ? `${c.records} of ${c.total}` : c.status === "pending" ? "Waiting…" : `<span class="red">${esc(c.http_status ? "Error " + c.http_status : "Error")}</span> <span class="muted small">${esc((c.error || "").slice(0, 120))}</span>`}</td></tr>`).join("")
        || `<tr><td colspan="5" class="empty">No requests yet.</td></tr>`}</tbody></table></div></section>
    <section class="panel"><h2>Other sources</h2><p class="muted">Contracts posted on FedConnect over $25,000 also appear on SAM.gov, so they come through here.
      DOE funding notices on FedConnect also post to Grants.gov, so the Grants tab catches them. Virginia eVA and other state and local bids come through MyBidMatch (Contracts → Bids).</p></section>`;
  if (!isAdmin()) return;
  $("#keyForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const k = e.target.key.value.trim(); if (!k) return;
    try { await db.rpc("fed_set_key", { p_key: k }); e.target.key.value = ""; toast("API key saved"); Settings(); } catch (err) { toast(err.message); }
  });
  $("#bmForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const k = e.target.link.value.trim(); if (!k) return;
    try { await db.rpc("fed_set_bidmatch", { p_link: k }); e.target.link.value = ""; toast("MyBidMatch linked; reading your lists now"); Settings(); } catch (err) { toast(err.message); }
  });
  $("#clearBm")?.addEventListener("click", async () => { if (!confirm("Remove the MyBidMatch link? Bids already read stay.")) return;
    try { await db.rpc("fed_set_bidmatch", { p_link: "" }); toast("Link removed"); Settings(); } catch (err) { toast(err.message); } });
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
  if (parts[0] === "bidmatch") { location.replace("#/contracts/bids"); return; }
  const key = { contracts: 1, grants: 1, searches: 1, settings: 1 }[parts[0]] ? parts[0] : "contracts";
  if (key === "contracts") FD.source = parts[1] === "bids" ? "BidMatch" : "SAM.gov"; if (key === "grants") FD.source = "Grants.gov";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve({ contracts: Matches, grants: Matches, searches: () => Searches((parts[1] || "").split("?")[0]), settings: Settings }[key]())
    .catch((e) => ($("#main").innerHTML = setupNeeded(e)
      ? `<section class="panel"><h2>One-time setup needed</h2><p>Opportunities needs the latest database update. An admin runs the latest <code>supabase/schema.sql</code> in the Supabase SQL Editor.</p></section>`
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
