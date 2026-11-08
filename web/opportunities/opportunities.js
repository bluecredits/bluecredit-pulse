/* Pulse · Opportunities — federal contracts (SAM.gov), APEX MyBidMatch bids and grants (Grants.gov). The database pulls
   new notices on a timer (see "Opportunities" in schema.sql) and matches them against your profile (NAICS codes and
   keywords); this page shows the matches, lets you save, dismiss, add a contract to Business Review's pipeline or a grant
   to Funding (contacts go to the Contacts list), and holds the profile and settings. */
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
// The NAICS codes and keywords in your profile are what every card and filter is built around.
let MY = { naics: [], kw: [] };
// "hydrological" also finds "hydrologic", "environmental" finds "environment", "floods" finds "flood"
const stem = (k) => { const w = k.toLowerCase().trim(), r = w.replace(/(ical|al|ing|ed|es|s)$/, ""); return r.length >= 4 ? r : w; };
// keywords from your profile found in the title or description (plus MyBidMatch's own profile terms)
function keywordsOf(r) {
  const t = `${r.title || ""} ${r.summary || ""}`.toLowerCase(), out = new Set();
  MY.kw.forEach((k) => { if (t.includes(stem(k))) out.add(k); });
  if (r.source === "BidMatch") String(r.bm_keywords || "").split(";").map((k) => k.trim().replace(/^ti:/i, "").replace(/[*?]+$/, ""))
    .filter((k) => k && !/^naics!/i.test(k)).forEach((k) => { if (![...out].some((o) => o.toLowerCase() === k.toLowerCase())) out.add(k); });
  return [...out];
}
const naicsOf = (r) => [...new Set([...(r.naics_all || []), r.naics].filter(Boolean))];
const isMine = (code) => MY.naics.some((m) => String(code).startsWith(m));
// titles for common codes (2022 NAICS); anything else shows the number alone
const NAICS = { "541620": "Environmental Consulting", "541330": "Engineering Services", "541370": "Surveying & Mapping", "541715": "R&D: Physical, Engineering & Life Sciences",
  "541511": "Custom Computer Programming", "541512": "Computer Systems Design", "518210": "Computing Infrastructure & Data Processing", "541519": "Other Computer Services",
  "541690": "Other Scientific & Technical Consulting", "541611": "Management Consulting", "541618": "Other Management Consulting", "541990": "Other Professional & Technical Services",
  "541360": "Geophysical Surveying & Mapping", "541380": "Testing Laboratories", "541340": "Drafting Services", "541320": "Landscape Architecture", "541310": "Architectural Services",
  "237110": "Water & Sewer Line Construction", "237990": "Other Heavy & Civil Construction", "221310": "Water Supply & Irrigation Systems", "221320": "Sewage Treatment Facilities",
  "562910": "Remediation Services", "924110": "Air, Water & Waste Program Administration", "541720": "R&D: Social Sciences & Humanities", "611430": "Professional & Management Training",
  "561720": "Janitorial Services", "236220": "Commercial Building Construction", "238910": "Site Preparation" };
const naicsLabel = (c) => (NAICS[c] ? `${c} · ${NAICS[c]}` : String(c));
// who to talk to, from SAM.gov's point of contact, the BidMatch POC line or the Grants.gov agency contact
function contactLine(r) {
  const cs = (r.contacts || []).slice(0, 2);
  const fedish = r.source === "SAM.gov" || (r.source === "BidMatch" && r.level === "Federal");
  const label = r.source === "Grants.gov" ? "Grants contact" : fedish ? "Contracting officer" : "Buyer contact";
  if (!cs.length) return r.source === "Grants.gov" ? "" : `<p class="fed-poc muted">${icon("badge")}<b>${label}:</b> not listed in the notice</p>`;
  return `<div class="fed-poc">${icon("badge")}<b>${cs.length > 1 && fedish ? "Contacts" : label}:</b> ${cs.map((c) => `<span class="one">${[
      c.name ? `<span class="nm">${esc(c.name)}</span>${c.title ? ` <span class="muted">(${esc(c.title)})</span>` : ""}` : "",
      c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "", c.phone ? `<a href="tel:${esc(c.phone.replace(/[^0-9+]/g, ""))}">${esc(c.phone)}</a>` : ""]
    .filter(Boolean).join(" · ")}
      ${c.cid ? `<a class="in-contacts" href="../contacts/#/contacts/${c.cid}" title="Open in Contacts">${icon("check")}In Contacts</a>`
        : c.email || c.name ? `<button type="button" class="link-btn save-ct" data-save-ct="${esc(c.email || "")}" title="Add to the Contacts list">${icon("user-plus")}Save to Contacts</button>` : ""}</span>`).join(`<span class="sep">|</span>`)}</div>`;
}
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
  const [prof, st, counts] = await Promise.all([db.rpc("fed_profile", { p_source: grants ? "Grants.gov" : "SAM.gov" }), db.rpc("fed_status", {}), db.rpc("fed_counts", {})]);
  const searches = bm ? [] : [prof]; FD.search = "";
  // contracts and bids use your contracts profile; grants use your grants profile
  const mine = [prof];
  const uniq = (a) => [...new Map(a.filter(Boolean).map((x) => [String(x).toLowerCase(), String(x).trim()])).values()];
  MY = { naics: uniq(mine.flatMap((s) => s.naics || [])).sort(), kw: uniq(mine.flatMap((s) => s.keywords || [])) };
  let rows = await db.rpc("fed_list", { p_source: FD.source, p_status: FD.status, p_search: FD.search ? +FD.search : null, p_sort: FD.sort });
  const kwAll = Object.fromEntries(MY.kw.map((k) => [k, 0])), naicsAll = Object.fromEntries(MY.naics.map((c) => [c, 0])), otherNaics = {};
  rows.forEach((r) => {
    keywordsOf(r).forEach((k) => (kwAll[k] = (kwAll[k] || 0) + 1));
    const codes = naicsOf(r);
    MY.naics.forEach((m) => { if (codes.some((c) => c.startsWith(m))) naicsAll[m]++; });
    codes.filter((c) => !isMine(c)).forEach((c) => (otherNaics[c] = (otherNaics[c] || 0) + 1));
  });
  const levelCounts = {}; if (bm) rows.forEach((r) => (levelCounts[r.level || "Other"] = (levelCounts[r.level || "Other"] || 0) + 1));
  if (bm && FD.level) rows = rows.filter((r) => (r.level || "Other") === FD.level);
  if (FD.kw) rows = rows.filter((r) => keywordsOf(r).some((k) => k.toLowerCase() === FD.kw.toLowerCase()));
  if (FD.naics) rows = rows.filter((r) => naicsOf(r).some((c) => c.startsWith(FD.naics)));
  if (FD.q) { const t = FD.q.toLowerCase(); rows = rows.filter((r) => [r.title, r.sol_number, r.agency, r.subtier, r.office, naicsOf(r).join(" "), keywordsOf(r).join(" "), (r.aln || []).join(" "), r.summary,
    (r.contacts || []).map((c) => `${c.name || ""} ${c.email || ""}`).join(" ")].join(" ").toLowerCase().includes(t)); }
  const opt = (k, n, cur, fmt) => `<option value="${esc(k)}" ${cur && cur.toLowerCase() === k.toLowerCase() ? "selected" : ""}>${esc(fmt(k))} (${n})</option>`;
  const otherOpts = Object.entries(otherNaics).sort((a, b) => b[1] - a[1]);
  if (FD.naics && !MY.naics.includes(FD.naics) && !otherNaics[FD.naics]) otherOpts.unshift([FD.naics, 0]);
  if (FD.kw && !Object.keys(kwAll).some((k) => k.toLowerCase() === FD.kw.toLowerCase())) kwAll[FD.kw] = 0;
  const naicsSel = grants ? "" : `<select id="fNaics" aria-label="NAICS"><option value="">All NAICS codes</option>
      ${MY.naics.length ? `<optgroup label="Your NAICS codes">${MY.naics.map((c) => opt(c, naicsAll[c], FD.naics, naicsLabel)).join("")}</optgroup>` : ""}
      ${otherOpts.length ? `<optgroup label="Other codes in these results">${otherOpts.map(([c, n]) => opt(c, n, FD.naics, naicsLabel)).join("")}</optgroup>` : ""}</select>`;
  const kwEntries = Object.entries(kwAll), mineKw = kwEntries.filter(([k]) => MY.kw.includes(k)).sort((a, b) => b[1] - a[1]), moreKw = kwEntries.filter(([k]) => !MY.kw.includes(k)).sort((a, b) => b[1] - a[1]);
  const kwSel = `<select id="fKw" aria-label="Keyword"><option value="">All keywords</option>
      ${mineKw.length ? `<optgroup label="Your keywords">${mineKw.map(([k, n]) => opt(k, n, FD.kw, (x) => x)).join("")}</optgroup>` : ""}
      ${moreKw.length ? `<optgroup label="${bm ? "MyBidMatch profile terms" : "Other"}">${moreKw.map(([k, n]) => opt(k, n, FD.kw, (x) => x)).join("")}</optgroup>` : ""}</select>`;
  const sname = Object.fromEntries(searches.map((s) => [s.id, s.name]));
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${grants ? "Grants" : "Contracts"}</h1><p class="muted">${bm ? "Bids from your APEX Accelerator MyBidMatch lists: federal, state, local and education." : (grants ? "Open and forecasted Grants.gov grants" : "Federal notices from SAM.gov") + " with your NAICS codes or keywords."} ${bm ? bmLine(st) : statusLine(st, grants)}</p></div>
      <div class="actions-row"><button class="btn" id="runNow">${icon("return")}Check now</button>${bm ? `<a class="btn" href="#/settings">${icon("cog")}MyBidMatch link</a>` : `<a class="btn primary" href="#/profile">${icon("cog")}Edit my NAICS &amp; keywords</a>`}</div></div>
    ${grants ? "" : `<div class="tabs src-tabs">${[["SAM.gov", "#/contracts", "SAM.gov"], ["BidMatch", "#/contracts/bids", "APEX BidMatch"]].map(([k, href, l]) => `<a href="${href}" aria-selected="${k === FD.source}">${l}${counts.by_source?.[k] ? ` <span class="count">${counts.by_source[k]}</span>` : ""}</a>`).join("")}</div>`}
    ${bm ? bmBanner(st) : banner(st, searches, grants)}
    ${bm ? `<div class="fed-levels">${["", ...LEVELS].map((l) => `<button class="chip ${FD.level === l ? "on" : ""}" data-lv="${l}">${l || "All"}${l ? ` <span>${levelCounts[l] || 0}</span>` : ""}</button>`).join("")}</div>` : ""}
    <div class="filters">
      <div class="tabs">${["New", "Saved", "Added", "Dismissed", "All"].map((k) => `<button data-st="${k}" aria-selected="${FD.status === k}">${k}</button>`).join("")}</div>
      ${naicsSel}${kwSel}
      <select id="fSort"><option value="posted" ${FD.sort === "posted" ? "selected" : ""}>Newest first</option><option value="due" ${FD.sort === "due" ? "selected" : ""}>Due soonest</option></select>
      <input id="fQ" type="search" placeholder="Filter by title, agency, ${grants ? "assistance listing" : bm ? "text" : "NAICS"}…" value="${esc(FD.q)}">
    </div>
    ${FD.naics || FD.kw ? `<p class="muted small fed-filtered">Showing ${rows.length} with ${[FD.naics && "NAICS " + naicsLabel(FD.naics), FD.kw && `“${esc(FD.kw)}”`].filter(Boolean).join(" and ")}. <button type="button" class="link-btn" data-clear>Clear</button></p>` : ""}
    <div class="fed-list">${rows.map((r) => card(r, sname)).join("") || `<div class="empty">${FD.status === "New" ? "No new matches right now." : "Nothing here."}${bm || MY.naics.length || MY.kw.length ? "" : ` <a href="#/profile">Add your NAICS codes and keywords</a>.`}</div>`}</div>`;
  $$("[data-st]").forEach((b) => b.addEventListener("click", () => { FD.status = b.dataset.st; Matches(); }));
  $$("[data-lv]").forEach((b) => b.addEventListener("click", () => { FD.level = b.dataset.lv; Matches(); }));
  $("#fSort").addEventListener("change", (e) => { FD.sort = e.target.value; Matches(); });
  $("#fNaics")?.addEventListener("change", (e) => { FD.naics = e.target.value; Matches(); });
  $("#fKw")?.addEventListener("change", (e) => { FD.kw = e.target.value; Matches(); });
  $("[data-clear]")?.addEventListener("click", () => { FD.naics = ""; FD.kw = ""; Matches(); });
  $$("[data-more]").forEach((b) => b.addEventListener("click", () => { const p = b.previousElementSibling; const open = p.classList.toggle("open"); b.textContent = open ? "Show less" : "Show full description"; }));
  $("#fQ").addEventListener("input", debounce((e) => { FD.q = e.target.value; Matches().then(() => { const i = $("#fQ"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300));
  $("#runNow").addEventListener("click", runNow);
  $$("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, b.closest("[data-nid]").dataset.nid, b)));
  $$("[data-save-ct]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { const n = await db.rpc("fed_save_contact", { p_notice: b.closest("[data-nid]").dataset.nid, p_email: b.dataset.saveCt || null });
      toast(n ? "Saved to Contacts" : "Nothing to save"); b.outerHTML = `<span class="in-contacts">${icon("check")}In Contacts</span>`;
    } catch (e) { toast(e.message); b.disabled = false; }
  }));
  rowsCache = Object.fromEntries(rows.map((r) => [r.notice_id, r]));
}
let rowsCache = {};
// NAICS and keywords: always on the card, your own codes highlighted; click one to filter by it
function keyLine(r) {
  const codes = naicsOf(r).sort((a, b) => isMine(b) - isMine(a)), kws = keywordsOf(r), grant = r.source === "Grants.gov";
  return `<div class="fed-keys">
      ${grant ? "" : `<div><span class="lbl">NAICS</span>${codes.length ? codes.map((c) => `<button type="button" class="tag ${isMine(c) ? "mine" : ""}" data-pick-naics="${esc(MY.naics.find((m) => c.startsWith(m)) || c)}" title="${isMine(c) ? "One of your NAICS codes" : "Filter by this code"}">${esc(naicsLabel(c))}</button>`).join("") : `<span class="muted">not listed in the notice</span>`}</div>`}
      <div><span class="lbl">Keywords</span>${kws.length ? kws.map((k) => `<button type="button" class="tag kw" data-pick-kw="${esc(k)}">${esc(k)}</button>`).join("") : `<span class="muted">none of your keywords in the text</span>`}</div>
    </div>`;
}
function classes(r) {
  const rows = [];
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
  if (!st.has_bidmatch) msgs.push(isAdmin() ? `Paste your MyBidMatch link in <a href="#/settings">Settings</a> (from any MyBidMatch email: “mybidmatch.outreachsystems.com/go?sub=…”). <a href="#/help/bidmatch">How to get MyBidMatch</a>` : "An admin needs to add the MyBidMatch link in Settings.");
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
</div>
      <h3><a href="${esc(r.ui_link || "https://sam.gov/opp/" + r.notice_id + "/view")}" target="_blank" rel="noopener">${esc(r.title || "(untitled)")} <svg class="ic ext-ic"><use href="#i-external"/></svg></a></h3>
      <p class="muted small">${esc(grant ? [r.agency, r.subtier].filter(Boolean).join(" · ") : [r.agency, r.subtier, r.office].filter((x, i, a) => x && a.indexOf(x) === i).join(" · "))}</p>
      ${keyLine(r)}
      ${contactLine(r)}
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
      toast((rowsCache[nid]?.contacts || []).length ? "Added to Funding · contact saved to Contacts" : "Added to Funding");
      btn.closest(".fed-card").querySelector(".fed-actions").innerHTML = `<a class="btn small" href="../funding/#/funding/${id}">${icon("check")}In Funding</a>`;
    } else if (what === "add") {
      const kinds = workspaceSettings(S.workspace).lists["opportunities.kind"] || [];
      const lvl = FD.source === "BidMatch" ? (rowsCache[nid]?.level || "") : "Federal";
      const kind = lvl === "Federal" ? kinds.find((k) => /federal/i.test(k)) || kinds.find((k) => /contract/i.test(k)) || ""
        : kinds.find((k) => /state|local/i.test(k)) || kinds.find((k) => /contract/i.test(k)) || "";
      const id = await db.rpc("fed_add_to_opportunities", { p_notice: nid, p_kind: kind || null });
      toast((rowsCache[nid]?.contacts || []).length ? "Added to the pipeline · contact saved to Contacts" : "Added to the pipeline"); const c = btn.closest(".fed-card");
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
  if (!grants && !st.has_key) msgs.push(isAdmin() ? `Add your SAM.gov API key in <a href="#/settings">Settings</a> to start pulling contract notices. <a href="#/help/sam">How to get a key</a>` : `An admin needs to add the SAM.gov API key in Settings.`);
  else if (!st.has_net || !st.timer) msgs.push(`Automatic checks are off: the database timer isn't set up yet. ${isAdmin() ? `See <a href="#/settings">Settings</a>.` : "Ask an admin."}`);
  const err = grants ? st.grants_error : st.last_error;
  if (err) msgs.push(esc(err) + ` <a href="#/help/trouble">What this means</a>`);
  else if (!grants && /^Paused/.test(st.last_status || "")) msgs.push(esc(st.last_status));
  const p = searches[0];
  if (p && !(p.naics || []).length && !(p.keywords || []).length && !(p.aln || []).length)
    msgs.push(`<a href="#/profile">Add your ${grants ? "keywords and assistance listings" : "NAICS codes and keywords"}</a> to see the ${grants ? "grants" : "notices"} that fit.`);
  return msgs.map((m) => `<div class="notice-bar">${icon("alert")}<div>${m}</div></div>`).join("");
}
async function runNow() {
  const b = $("#runNow"); b.disabled = true;
  try { await db.rpc("fed_run_now", {}); toast("Checking now; results arrive within a few minutes"); setTimeout(() => { if (/^#\/?(contracts|contracts\/bids|grants)?$/.test(location.hash)) Matches(); }, 90000); }
  catch (e) { toast(e.message); }
  b.disabled = false;
}
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

/* ================================================================ profile */
// One list of NAICS codes and keywords for contracts, one for grants. A notice shows up when it has ANY of your codes
// OR ANY of your keywords (title or description); the NAICS and keyword drop-downs on the results narrow from there.
async function Profile() {
  const [pc, pg] = await Promise.all([db.rpc("fed_profile", { p_source: "SAM.gov" }), db.rpc("fed_profile", { p_source: "Grants.gov" })]);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>My NAICS codes &amp; keywords</h1><p class="muted">Opportunities shows every notice with <b>any</b> of your NAICS codes <b>or</b> any of your keywords in its title or description. Narrow the results with the NAICS and keyword drop-downs.</p></div></div>
    <div class="grid2 prof-grid">${profForm(pc)}${profForm(pg)}</div>`;
  $$(".prof-form").forEach(wireProf);
}
function profForm(v) {
  const grants = v.source === "Grants.gov", id = grants ? "g" : "c";
  return `<form class="panel prof-form" data-pid="${v.id}" data-src="${v.source}">
    <h2>${icon(grants ? "banknotes" : "gov")} ${grants ? "Grants · Grants.gov" : "Contracts · SAM.gov and BidMatch"}</h2>
    ${grants ? `<label>Keywords <small class="muted">comma-separated</small><textarea name="keywords" rows="3" placeholder="water, watershed, stormwater, flood">${esc((v.keywords || []).join(", "))}</textarea></label>
      <label>Assistance listings (CFDA) <small class="muted">optional; "66." matches every EPA listing</small><input name="aln" value="${esc((v.aln || []).join(", "))}" placeholder="66.458, 10.760, 15."></label>`
    : `<label>NAICS codes <small class="muted">comma-separated; 4–5 digits match every code that starts with them</small><textarea name="naics" rows="2" placeholder="541620, 541330, 541370">${esc((v.naics || []).join(", "))}</textarea></label>
      <div class="prof-tags" data-naics-tags></div>
      <label>Keywords <small class="muted">comma-separated</small><textarea name="keywords" rows="3" placeholder="water, flood, floodplain, stormwater">${esc((v.keywords || []).join(", "))}</textarea></label>`}
    <details class="prof-more"><summary>More filters</summary><div class="form-grid">
      ${grants ? "" : `<label>Business size<select name="size">${SIZES.map(([k, l]) => `<option value="${k}" ${k === v.size ? "selected" : ""}>${l}</option>`).join("")}</select></label>`}
      <label>Agencies only <small class="muted">blank = all</small><input name="agencies" value="${esc((v.agencies || []).join(", "))}" placeholder="${grants ? "EPA, USDA" : "Environmental Protection Agency, Corps of Engineers"}"></label>
      <label style="grid-column:1/-1">Leave out titles with<input name="exclude" value="${esc((v.exclude || []).join(", "))}" placeholder="${grants ? "fellowship, training" : "janitorial, bottled water"}"></label>
      <fieldset style="grid-column:1/-1"><legend>${grants ? "Status" : "Notice type"} <small class="muted">none ticked = any</small></legend><div class="fed-checks">
        ${(grants ? GRANT_TYPES : TYPES).map((k) => `<label class="check"><input type="checkbox" name="nt" value="${esc(k)}" ${(v.notice_types || []).includes(k) ? "checked" : ""}> ${esc(k)}</label>`).join("")}</div></fieldset>
      ${grants ? "" : `<fieldset style="grid-column:1/-1"><legend>Set-aside type <small class="muted">none ticked = any</small></legend><div class="fed-checks">
        ${SET_ASIDES.map(([k, l]) => `<label class="check"><input type="checkbox" name="sa" value="${k}" ${(v.set_asides || []).includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div></fieldset>`}
      <label class="check" style="grid-column:1/-1"><input type="checkbox" name="open_only" ${v.open_only ? "checked" : ""}> Hide ${grants ? "grants past their closing date" : "notices past their due date"}</label>
    </div></details>
    <div class="fed-preview" data-preview></div>
    <div class="actions-row"><button class="btn primary">Save</button><a class="btn" href="#/${grants ? "grants" : "contracts"}">See results</a></div>
  </form>`;
}
function wireProf(f) {
  const grants = f.dataset.src === "Grants.gov";
  const read = () => ({ source: f.dataset.src, match_any: true, keywords: list(f.keywords.value), agencies: list(f.agencies.value), exclude: list(f.exclude.value),
    open_only: f.open_only.checked, notice_types: $$("[name=nt]:checked", f).map((x) => x.value),
    naics: grants ? [] : list(f.naics.value).map((x) => x.replace(/\D/g, "")).filter(Boolean),
    aln: grants ? list(f.aln.value).map((x) => x.replace(/[^\d.]/g, "")).filter(Boolean) : [],
    size: grants ? "any" : f.size.value, set_asides: grants ? [] : $$("[name=sa]:checked", f).map((x) => x.value) });
  const tags = () => { const t = $("[data-naics-tags]", f); if (t) t.innerHTML = read().naics.map((c) => `<span class="tag mine">${esc(naicsLabel(c))}</span>`).join(""); };
  const preview = debounce(async () => {
    try { const p = await db.rpc("fed_preview", { p: read() });
      $("[data-preview]", f).innerHTML = `<b>${p.count}</b> ${grants ? "grant" : "SAM.gov notice"}${p.count === 1 ? "" : "s"} ${grants ? "currently listed" : "already pulled"} fit.${p.sample.length ? `<ul>${p.sample.map((x) => `<li>${esc(x.title)} <span class="muted">· ${esc(x.agency || "")} · ${short(x.posted_date)}</span></li>`).join("")}</ul>` : ""}`;
    } catch (e) { $("[data-preview]", f).textContent = ""; }
  }, 400);
  f.addEventListener("input", () => { tags(); preview(); }); tags(); preview();
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const b = $("button.primary", f); b.disabled = true;
    try {
      must(await sb.from("fed_searches").update(read()).eq("id", +f.dataset.pid));
      const added = await db.rpc("fed_apply_search", { p_id: +f.dataset.pid });
      toast(`Saved${added ? ` · ${added} new match${added === 1 ? "" : "es"}` : ""}`);
    } catch (err) { toast(err.message); }
    b.disabled = false;
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
      <p class="muted small">Get it on SAM.gov → your name → Account Details → Public API Key. Keys expire every 90 days. <a href="#/help/sam">Step-by-step guide →</a></p>` : `<p class="muted">Only admins can change the key.</p>`}
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
        <p class="muted small">The link is in every MyBidMatch email; it's stored encrypted. MyBidMatch comes free through your APEX Accelerator. <a href="#/help/bidmatch">Step-by-step guide →</a></p>` : ""}
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
  if (parts[0] === "searches") { location.replace("#/profile"); return; }
  const key = { contracts: 1, grants: 1, profile: 1, settings: 1, help: 1 }[parts[0]] ? parts[0] : "contracts";
  if (key === "contracts") FD.source = parts[1] === "bids" ? "BidMatch" : "SAM.gov"; if (key === "grants") FD.source = "Grants.gov";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve({ contracts: Matches, grants: Matches, profile: Profile, settings: Settings, help: () => Help(parts[1]) }[key]())
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
