/* Pulse · Timecards — weekly timesheets by project (plus time off), expenses, approvals, projects and reports.
   Uses ../core.js helpers. The database decides who may log, see and approve (see "Timecards" in schema.sql);
   this file only chooses what to show. */
"use strict";

const TC = { week: null, projects: [], mine: new Set(), entries: [], sheet: null, from: null, to: null };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const isAdmin = () => S.profile?.role === "admin";
const isStaff = () => S.profile && isStaffRole(S.profile.role);
const isTeam = () => ["admin", "member", "employee"].includes(S.profile?.role);   // paid staff: open projects and time off
const canStart = () => ["admin", "member"].includes(S.profile?.role);   // who can start a project (employees and contractors log to existing ones)
const nameOf = (id) => S.team.find((p) => p.id === id)?.display_name || "Former member";
const hrs = (n) => (Math.round((+n || 0) * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
const weekOf = (iso) => { const d = new Date(iso + "T12:00:00"); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.toLocaleDateString("en-CA"); };
const weekDays = (w) => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(w, i));
const dayHead = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
const weekLabel = (w) => `${short(w)} – ${short(addDays(w, 6))}`;
const STATUS_PILL = { Draft: "Draft", Submitted: "Submitted", Approved: "Approved", Rejected: "Rejected" };

async function loadProjects() {
  TC.projects = must(await sb.from("projects").select("*").order("name"));
  TC.mine = new Set(must(await sb.from("project_people").select("project_id").eq("user_id", S.user.id)).map((r) => r.project_id));
}
const canLog = (p) => p.status === "Active" && ((!p.limited && isTeam()) || TC.mine.has(p.id));
const projName = (id) => TC.projects.find((p) => p.id === id)?.name || "Project";

async function refreshBadge() {
  try {
    const rows = must(await sb.from("timesheets").select("user_id").eq("status", "Submitted"));
    const ex = await sb.from("expense_reports").select("user_id").eq("status", "Submitted").then((r) => r.data || []);
    const n = rows.filter((r) => r.user_id !== S.user.id).length + ex.filter((r) => r.user_id !== S.user.id).length, b = $("#nb-approvals");
    if (b) { b.hidden = !n; b.textContent = n; }
  } catch { /* table missing: handled on the page */ }
}

/* ================================================================ My timesheet */
// rows are projects ("p12") or time off ("kPTO"); time off is for staff, and only Holiday and PTO can be entered ahead
const LEAVE = { Holiday: "Company holiday", PTO: "Paid time off", Sick: "Sick" };
const AHEAD = new Set(["Holiday", "PTO"]);
const rowKey = (e) => (e.kind && e.kind !== "Work" ? "k" + e.kind : "p" + e.project_id);
const rowLabel = (k) => (k[0] === "k" ? LEAVE[k.slice(1)] || k.slice(1) : projName(+k.slice(1)));
const usedHours = async () => {   // all-time hours per project, for the budget line
  try { const rep = await db.rpc("ts_report", { p_from: "2000-01-01", p_to: addDays(today(), 366) }); const u = {}; rep.forEach((r) => (u[r.project_id] = (u[r.project_id] || 0) + +r.hours)); return u; }
  catch { return {}; }
};
async function loadHolidays() { TC.holidays = await sb.from("company_holidays").select("day, name").order("day").then((r) => r.data || []).catch(() => []); }
const holidayOn = (d) => (TC.holidays || []).find((h) => h.day === d);
function cellRule(key, d) {   // why a cell is closed, or "" when it's open
  const kind = key[0] === "k" ? key.slice(1) : "Work";
  if (d > today() && !AHEAD.has(kind)) return "Hours can't be logged ahead. Only holidays and paid time off can.";
  if (kind === "Holiday" && (TC.holidays || []).length && !holidayOn(d)) return "Not a company holiday";
  return "";
}

async function Week(param) {
  TC.week = param && /^\d{4}-\d{2}-\d{2}$/.test(param) ? weekOf(param) : TC.week || weekOf(today());
  await Promise.all([loadProjects(), loadHolidays()]);
  const days = weekDays(TC.week);
  TC.entries = must(await sb.from("time_entries").select("*").eq("user_id", S.user.id).gte("work_date", days[0]).lte("work_date", days[6]));
  TC.sheet = must(await sb.from("timesheets").select("*").eq("user_id", S.user.id).eq("week_start", TC.week).maybeSingle());
  TC.used = await usedHours();
  const st = TC.sheet?.status || "Draft", locked = st === "Submitted" || st === "Approved";
  const rows = [...new Set(TC.entries.map(rowKey))];
  (TC.extraRows?.[TC.week] || []).forEach((k) => !rows.includes(k) && rows.push(k));
  rows.sort((a, b) => (a[0] === b[0] ? 0 : a[0] === "p" ? -1 : 1));
  const loggable = TC.projects.filter((p) => canLog(p) && !rows.includes("p" + p.id));
  const leaveOpts = isTeam() ? Object.keys(LEAVE).filter((k) => !rows.includes("k" + k)) : [];
  const cell = (k, d) => TC.entries.find((e) => rowKey(e) === k && e.work_date === d);
  const total = TC.entries.reduce((a, e) => a + +e.hours, 0);
  const budgetLine = (pid) => {
    const p = TC.projects.find((x) => x.id === pid); if (!p?.budget_hours) return "";
    const used = TC.used[pid] || 0, left = p.budget_hours - used, pct = Math.round(100 * used / p.budget_hours);
    return `<small class="tc-budget ${pct > 100 ? "over" : pct >= 85 ? "warn" : ""}" data-budget="${pid}">${hrs(used)} of ${hrs(p.budget_hours)} h budget · ${left >= 0 ? hrs(left) + " h left" : hrs(-left) + " h over"}</small>`;
  };
  const anyAddable = loggable.length || leaveOpts.length || canStart();
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>My timesheet</h1><p class="muted">Log hours by project each day, then submit the week for approval. Time off and holidays can be entered ahead; work hours can't.</p></div>
      <div class="actions-row week-nav">
        <a class="btn small" href="#/week/${addDays(TC.week, -7)}" aria-label="Previous week">${icon("chevron-left")}</a>
        <b class="week-label">${weekLabel(TC.week)}</b>
        <a class="btn small" href="#/week/${addDays(TC.week, 7)}" aria-label="Next week">${icon("chevron-right")}</a>
        ${TC.week !== weekOf(today()) ? `<a class="btn small" href="#/week/${weekOf(today())}">This week</a>` : ""}</div></div>
    ${st === "Rejected" ? `<div class="notice-bar alert">${icon("alert")}<div><b>Sent back by ${esc(nameOf(TC.sheet.decided_by))}:</b> ${esc(TC.sheet.decision_note || "")}<br><span class="muted">Fix the hours and submit again.</span></div></div>` : ""}
    ${st === "Approved" ? `<div class="notice-bar ok">${icon("check")}<div>Approved by ${esc(nameOf(TC.sheet.decided_by))} ${ago(TC.sheet.decided_at)}.</div></div>` : ""}
    ${st === "Submitted" ? `<div class="notice-bar">${icon("clock")}<div>Submitted ${ago(TC.sheet.submitted_at)}. Waiting for approval. <button class="link" id="pullBack">Pull it back to edit</button></div></div>` : ""}
    <section class="panel tc-panel"><div class="table-wrap"><table class="tc-grid">
      <thead><tr><th>Project</th>${days.map((d) => `<th class="num ${d === today() ? "today" : ""} ${d > today() ? "future" : ""}">${dayHead(d)}${holidayOn(d) ? `<small class="tc-hol" title="${esc(holidayOn(d).name)}">${esc(holidayOn(d).name)}</small>` : ""}</th>`).join("")}<th class="num">Total</th></tr></thead>
      <tbody>${rows.length ? rows.map((k) => {
        const rt = days.reduce((a, d) => a + +(cell(k, d)?.hours || 0), 0), pid = k[0] === "p" ? +k.slice(1) : null, pr = pid && TC.projects.find((p) => p.id === pid);
        return `<tr class="${pid ? "" : "tc-leave"}" data-row="${k}"><td class="tc-proj">${!locked ? `<button class="tc-del" type="button" data-del="${k}" title="Remove this line from the week" aria-label="Remove ${esc(rowLabel(k))} from this week">&times;</button>` : ""}<b>${pid ? "" : icon("sun", "ic tiny") + " "}${esc(rowLabel(k))}</b>${pr?.client ? `<small>${esc(pr.client)}</small>` : ""}${pid ? budgetLine(pid) : ""}</td>
          ${days.map((d) => { const why = cellRule(k, d), c = cell(k, d);
            return `<td class="num"><input class="tc-in" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-k="${k}" data-d="${d}"
            value="${c ? +c.hours : ""}" ${locked || (why && !c) ? "disabled" : ""} ${why ? `title="${esc(why)}"` : ""} aria-label="${esc(rowLabel(k))} ${dayHead(d)}"></td>`; }).join("")}
          <td class="num"><b>${hrs(rt)}</b></td></tr>`; }).join("")
        : `<tr><td colspan="9" class="empty">${anyAddable ? "No hours this week yet. Add a project below." : TC.projects.length ? "You aren't on any open projects. Ask an admin to add you." : "No projects yet. Ask an admin to add one."}</td></tr>`}</tbody>
      <tfoot><tr><td>${!locked && anyAddable ? `<select id="addRow" aria-label="Add a row"><option value="">+ Add a project${leaveOpts.length ? " or time off" : ""}…</option>
          ${loggable.length ? `<optgroup label="Projects">${loggable.map((p) => `<option value="p${p.id}">${esc(p.name)}${p.client ? " · " + esc(p.client) : ""}</option>`).join("")}</optgroup>` : ""}
          ${leaveOpts.length ? `<optgroup label="Time off">${leaveOpts.map((k) => `<option value="k${k}">${LEAVE[k]}</option>`).join("")}</optgroup>` : ""}
          ${canStart() ? `<option value="new">+ New project…</option>` : ""}</select>` : "<b>Total</b>"}</td>
        ${days.map((d) => `<td class="num">${hrs(TC.entries.filter((e) => e.work_date === d).reduce((a, e) => a + +e.hours, 0)) || ""}</td>`).join("")}<td class="num"><b id="weekTotal">${hrs(total)}</b></td></tr></tfoot>
    </table></div>
    <div class="tc-foot"><label>Notes for the approver<textarea id="weekNote" rows="2" ${locked ? "disabled" : ""} placeholder="Anything they should know about this week">${esc(TC.sheet?.note || "")}</textarea></label>
      <div class="actions-row">${pill(STATUS_PILL[st])}${!locked ? `<button class="btn primary" id="submitWeek" ${total ? "" : "disabled"}>Submit ${hrs(total)} hours</button>` : ""}</div></div></section>`;
  const addRow = (k) => { TC.extraRows = TC.extraRows || {}; (TC.extraRows[TC.week] ||= []).push(k); Week(TC.week); };
  $("#addRow")?.addEventListener("change", (e) => {
    const v = e.target.value; if (!v) return;
    if (v === "new") { e.target.value = ""; quickProject((p) => addRow("p" + p.id)); return; }
    addRow(v);
  });
  $$(".tc-in").forEach((inp) => inp.addEventListener("change", () => saveCell(inp)));
  wireSheet($(".tc-grid"));
  $$(".tc-del").forEach((b) => b.addEventListener("click", () => removeRow(b.dataset.del, days)));
  $("#submitWeek")?.addEventListener("click", async () => {
    try { await db.rpc("ts_submit", { p_week: TC.week, p_note: $("#weekNote").value }); toast("Week submitted for approval"); Week(TC.week); } catch (e) { toast(e.message); }
  });
  $("#pullBack")?.addEventListener("click", async () => {
    try { await db.rpc("ts_reopen", { p_user: S.user.id, p_week: TC.week }); toast("Back to draft"); Week(TC.week); } catch (e) { toast(e.message); }
  });
  refreshBadge();
}
// "6", "6.5", "6:30", "6h", "6.5 h" → hours; "" → 0; anything else → NaN
function parseHours(t) {
  t = String(t || "").trim().toLowerCase().replace(/\s*(h|hrs?|hours?)$/, "").replace(",", ".");
  if (!t) return 0;
  const m = t.match(/^(\d{1,2}):([0-5]\d)$/); if (m) return +m[1] + +m[2] / 60;
  return /^\d*\.?\d+$/.test(t) ? +t : NaN;
}
// spreadsheet keys for the timesheet: arrows, Enter, Tab, Esc, Delete, and pasting a block copied from Excel
function wireSheet(grid) {
  if (!grid) return;
  const cells = () => [...grid.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll(".tc-in")]);
  const pos = (inp) => { const g = cells(); for (let r = 0; r < g.length; r++) { const c = g[r].indexOf(inp); if (c >= 0) return [r, c, g]; } return [-1, -1, g]; };
  const go = (inp, dr, dc) => {
    let [r, c, g] = pos(inp);
    while (true) {
      r += dr; c += dc;
      if (r < 0 || r >= g.length || c < 0 || c >= (g[r]?.length || 0)) return;
      if (!g[r][c].disabled) { g[r][c].focus(); return; }
    }
  };
  grid.addEventListener("focusin", (e) => { if (e.target.classList?.contains("tc-in")) { e.target.dataset.was = e.target.value; e.target.select(); } });
  grid.addEventListener("keydown", (e) => {
    const inp = e.target; if (!inp.classList?.contains("tc-in")) return;
    const all = inp.selectionStart === 0 && inp.selectionEnd === inp.value.length;
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); go(inp, e.shiftKey ? -1 : 1, 0); }
    else if (e.key === "ArrowDown") { e.preventDefault(); go(inp, 1, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(inp, -1, 0); }
    else if (e.key === "ArrowRight" && (all || inp.selectionStart === inp.value.length)) { e.preventDefault(); go(inp, 0, 1); }
    else if (e.key === "ArrowLeft" && (all || inp.selectionEnd === 0)) { e.preventDefault(); go(inp, 0, -1); }
    else if (e.key === "Escape") { inp.value = inp.dataset.was ?? inp.value; inp.select(); }
  });
  grid.addEventListener("paste", async (e) => {
    const inp = e.target; if (!inp.classList?.contains("tc-in")) return;
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    const block = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    if (block.length === 1 && block[0].length === 1) return;   // one value: let the browser paste it
    e.preventDefault();
    const [r0, c0, g] = pos(inp), todo = [];
    block.forEach((line, i) => line.forEach((v, j) => { const t = g[r0 + i]?.[c0 + j]; if (t && !t.disabled) { t.value = v.trim(); todo.push(t); } }));
    for (const t of todo) await saveCell(t);
  });
}
async function removeRow(k, days) {
  const ent = TC.entries.filter((e) => rowKey(e) === k && days.includes(e.work_date)), h = ent.reduce((a, e) => a + +e.hours, 0);
  if (h && !confirm(`Remove ${rowLabel(k)} from this week? This deletes the ${hrs(h)} hours logged to it this week.`)) return;
  try {
    if (ent.length) must(await sb.from("time_entries").delete().in("id", ent.map((e) => e.id)));
    if (TC.extraRows?.[TC.week]) TC.extraRows[TC.week] = TC.extraRows[TC.week].filter((x) => x !== k);
    toast(h ? `Removed ${rowLabel(k)} and its ${hrs(h)} hours` : `Removed ${rowLabel(k)}`);
    Week(TC.week);
  } catch (e) { toast(e.message); }
}
async function saveCell(inp) {
  const raw = parseHours(inp.value), k = inp.dataset.k, d = inp.dataset.d, v = Math.round(raw * 100) / 100;
  if (Number.isNaN(raw) || v < 0 || v > 24) { toast("Enter hours between 0 and 24, like 6.5 or 6:30"); const c = TC.entries.find((e) => rowKey(e) === k && e.work_date === d); inp.value = c ? +c.hours : ""; return; }
  inp.value = v || "";
  const cur = TC.entries.find((e) => rowKey(e) === k && e.work_date === d), why = cellRule(k, d);
  if (v && why) { toast(why); inp.value = cur ? +cur.hours : ""; return; }
  const pid = k[0] === "p" ? +k.slice(1) : null, before = cur ? +cur.hours : 0;
  try {
    if (cur && !v) { must(await sb.from("time_entries").delete().eq("id", cur.id)); TC.entries = TC.entries.filter((e) => e !== cur); }
    else if (cur) { must(await sb.from("time_entries").update({ hours: v }).eq("id", cur.id)); cur.hours = v; }
    else if (v) { const r = must(await sb.from("time_entries").insert(pid ? { project_id: pid, kind: "Work", work_date: d, hours: v } : { project_id: null, kind: k.slice(1), work_date: d, hours: v }).select("*").single()); TC.entries.push(r); }
    if (!document.contains(inp)) return;   // the page moved on while saving (e.g. typed, then clicked the next week)
    inp.classList.add("saved"); setTimeout(() => inp.classList.remove("saved"), 700);
    const total = TC.entries.reduce((a, e) => a + +e.hours, 0);
    $("#weekTotal").textContent = hrs(total);
    const btn = $("#submitWeek"); if (btn) { btn.disabled = !total; btn.textContent = `Submit ${hrs(total)} hours`; }
    const row = inp.closest("tr"), rt = $$(".tc-in", row).reduce((a, i) => a + (parseHours(i.value) || 0), 0); row.lastElementChild.innerHTML = `<b>${hrs(rt)}</b>`;
    const col = [...row.children].indexOf(inp.closest("td")), foot = $(".tc-grid tfoot tr").children[col];
    foot.textContent = hrs(TC.entries.filter((e) => e.work_date === d).reduce((a, e) => a + +e.hours, 0)) || "";
    if (pid) {   // keep the budget line current and say so when the project goes over
      const p = TC.projects.find((x) => x.id === pid), was = TC.used[pid] || 0; TC.used[pid] = was - before + v;
      const el = $(`[data-budget="${pid}"]`);
      if (p?.budget_hours && el) {
        const used = TC.used[pid], left = p.budget_hours - used, pct = Math.round(100 * used / p.budget_hours);
        el.className = `tc-budget ${pct > 100 ? "over" : pct >= 85 ? "warn" : ""}`;
        el.textContent = `${hrs(used)} of ${hrs(p.budget_hours)} h budget · ${left >= 0 ? hrs(left) + " h left" : hrs(-left) + " h over"}`;
        if (was <= p.budget_hours && used > p.budget_hours) toast(`${p.name} is now over its ${hrs(p.budget_hours)} hour budget. Let the project manager know.`);
      }
    }
  } catch (e) { toast(e.message); inp.value = cur ? +cur.hours : ""; }
}
// a new project anyone on staff can start from their timesheet; it opens in Projects too (same project)
function quickProject(done) {
  $("#drawerTitle").textContent = "New project";
  $("#drawerBody").innerHTML = `<form id="qpForm" class="form-grid">
    <p class="muted" style="grid-column:1/-1">The project shows up in Projects too, where you can add milestones, tasks and costs. Hours logged here count against its budget.</p>
    <label style="grid-column:1/-1">Project name<input name="name" required placeholder="e.g. Fairfax stormwater inventory"></label>
    <label>Client<input name="client"></label>
    <label>Code <small class="muted">(PO or charge code)</small><input name="code"></label>
    <label>Budget (hours)<input name="budget_hours" type="number" min="0" step="0.5" placeholder="e.g. 120"></label>
    <label>Billing rate per hour (USD)<input name="rate" type="number" min="0" step="0.01"></label>
    <label>Start<input name="start_date" type="date" value="${today()}"></label>
    <label>End<input name="end_date" type="date"></label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="billable" checked> Billable to the client</label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Create and add to my timesheet</button></div></form>`;
  openDrawer();
  $("#qpForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target), num = (k) => (f.get(k) === "" ? null : +f.get(k));
    try {
      const p = must(await sb.from("projects").insert({ name: f.get("name").trim(), client: f.get("client").trim() || null, code: f.get("code").trim() || null,
        budget_hours: num("budget_hours"), rate: num("rate"), billable: !!f.get("billable"), start_date: f.get("start_date") || null, end_date: f.get("end_date") || null,
        status: "Active", manager_id: S.user.id }).select("*").single());
      toast(`${p.name} created`); closeDrawer(); done(p);
    } catch (err) { toast(err.message); }
  });
}

/* ================================================================ Approvals */
async function Approvals() {
  await loadProjects();
  const sheets = must(await sb.from("timesheets").select("*").order("week_start", { ascending: false }).limit(200)).filter((t) => t.user_id !== S.user.id);
  const waiting = sheets.filter((t) => t.status === "Submitted"), decided = sheets.filter((t) => ["Approved", "Rejected"].includes(t.status)).slice(0, 30);
  const totals = {};
  if (sheets.length) {
    const ents = must(await sb.from("time_entries").select("user_id, work_date, hours").gte("work_date", sheets[sheets.length - 1].week_start).neq("user_id", S.user.id));
    ents.forEach((e) => { const k = e.user_id + "|" + weekOf(e.work_date); totals[k] = (totals[k] || 0) + +e.hours; });
  }
  // who hasn't submitted last week (admins)
  let missing = [];
  if (isAdmin()) {
    const last = addDays(weekOf(today()), -7);
    const done = new Set(must(await sb.from("timesheets").select("user_id, status").eq("week_start", last)).filter((t) => t.status !== "Draft").map((t) => t.user_id));
    const logging = new Set(must(await sb.from("time_entries").select("user_id").gte("work_date", addDays(last, -28))).map((e) => e.user_id));
    missing = S.team.filter((p) => p.active && logging.has(p.id) && !done.has(p.id));
  }
  const card = (t, act) => `<article class="appr-card tc-card" data-sheet="${t.user_id}|${t.week_start}">
      <header>${icon("timer")}<div><span class="tno">${weekLabel(t.week_start)}</span><h3>${esc(nameOf(t.user_id))}</h3></div>${pill(t.status)}</header>
      <p class="muted">${hrs(totals[t.user_id + "|" + t.week_start] || 0)} hours${t.note ? ` · “${esc(t.note)}”` : ""}${t.decision_note ? ` · ${esc(t.decision_note)}` : ""}</p>
      ${act ? `<div class="actions-row"><button class="btn small" data-view>Review hours</button></div>` : ""}</article>`;
  const exWait = await sb.from("expense_reports").select("*").eq("status", "Submitted").neq("user_id", S.user.id).order("submitted_at").then((r) => r.data || []);
  const exTot = await expTotals(exWait.map((r) => r.id));
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Approvals</h1><p class="muted">${isAdmin() ? "Admins approve every timesheet. Project approvers approve weeks with hours on their projects." : "Weeks with hours on projects you approve."}</p></div></div>
    ${missing.length ? `<div class="notice-bar">${icon("alert")}<div><b>Not submitted for ${weekLabel(addDays(weekOf(today()), -7))}:</b> ${missing.map((p) => esc(p.display_name)).join(", ")}</div></div>` : ""}
    <h2 class="hub-h">Waiting for you <small class="muted">${waiting.length}</small></h2>
    <div class="appr-grid">${waiting.map((t) => card(t, true)).join("") || `<div class="empty">Nothing waiting. 🎉</div>`}</div>
    ${exWait.length ? `<h2 class="hub-h">Expense reports waiting <small class="muted">${exWait.length}</small></h2>
      <div class="appr-grid">${exWait.map((r) => `<article class="appr-card tc-card"><header>${icon("banknotes")}<div><span class="tno">EXP-${String(r.number).padStart(4, "0")}</span><h3>${esc(nameOf(r.user_id))}</h3></div>${pill("Submitted")}</header>
        <p class="muted">${esc(r.title)} · ${usd(exTot[r.id] || 0)}${r.note ? ` · “${esc(r.note)}”` : ""}</p><div class="actions-row"><a class="btn small" href="#/expense/${r.id}">Review expenses</a></div></article>`).join("")}</div>` : ""}
    ${decided.length ? `<h2 class="hub-h">Recently decided</h2><div class="appr-grid">${decided.map((t) => card(t, false)).join("")}</div>` : ""}`;
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { const [u, w] = b.closest("[data-sheet]").dataset.sheet.split("|"); openSheet(u, w); }));
  refreshBadge();
}
async function openSheet(user, week) {
  const days = weekDays(week);
  const ents = must(await sb.from("time_entries").select("*").eq("user_id", user).gte("work_date", days[0]).lte("work_date", days[6]));
  const t = must(await sb.from("timesheets").select("*").eq("user_id", user).eq("week_start", week).maybeSingle());
  const pids = [...new Set(ents.map(rowKey))];
  const h = (p, d) => ents.filter((e) => rowKey(e) === p && e.work_date === d).reduce((a, e) => a + +e.hours, 0);
  $("#drawerTitle").textContent = `${nameOf(user)} · ${weekLabel(week)}`;
  $("#drawerBody").innerHTML = `
    <div class="table-wrap"><table class="tc-grid ro"><thead><tr><th>Project</th>${days.map((d) => `<th class="num">${dayHead(d)}</th>`).join("")}<th class="num">Total</th></tr></thead>
      <tbody>${pids.map((p) => `<tr><td>${esc(rowLabel(p))}</td>${days.map((d) => `<td class="num">${hrs(h(p, d)) === "0" ? "" : hrs(h(p, d))}</td>`).join("")}<td class="num"><b>${hrs(days.reduce((a, d) => a + h(p, d), 0))}</b></td></tr>`).join("")}</tbody>
      <tfoot><tr><td><b>Total</b></td>${days.map((d) => `<td class="num">${hrs(ents.filter((e) => e.work_date === d).reduce((a, e) => a + +e.hours, 0)) || ""}</td>`).join("")}<td class="num"><b>${hrs(ents.reduce((a, e) => a + +e.hours, 0))}</b></td></tr></tfoot></table></div>
    ${t?.note ? `<p><b>Their note:</b> ${esc(t.note)}</p>` : ""}
    ${t?.status === "Submitted" ? `<label>Reason (needed to send back)<textarea id="decNote" rows="2"></textarea></label>
      <div class="actions-row" style="margin-top:12px"><button class="btn primary" id="approve">${icon("check")}Approve</button><button class="btn danger" id="reject">Send back</button></div>`
      : t?.status === "Approved" ? `<div class="actions-row"><button class="btn" id="reopen">Reopen for edits</button></div>` : ""}`;
  openDrawer();
  const decide = async (ok) => { try { await db.rpc("ts_decide", { p_user: user, p_week: week, p_approve: ok, p_note: $("#decNote").value }); toast(ok ? "Approved" : "Sent back"); closeDrawer(); Approvals(); } catch (e) { toast(e.message); } };
  $("#approve")?.addEventListener("click", () => decide(true));
  $("#reject")?.addEventListener("click", () => decide(false));
  $("#reopen")?.addEventListener("click", async () => { try { await db.rpc("ts_reopen", { p_user: user, p_week: week }); toast("Reopened"); closeDrawer(); Approvals(); } catch (e) { toast(e.message); } });
}

/* ================================================================ Projects */
async function Projects() {
  await loadProjects();
  const rep = await db.rpc("ts_report", { p_from: "2000-01-01", p_to: addDays(today(), 366) });
  const month = await db.rpc("ts_report", { p_from: today().slice(0, 8) + "01", p_to: today() });
  const sum = (list, pid) => list.filter((r) => r.project_id === pid).reduce((a, r) => a + +r.hours, 0);
  const show = TC.showClosed ? TC.projects : TC.projects.filter((p) => p.status !== "Closed");
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><p class="muted">${isAdmin() ? "Add projects people can log time to. Limit a project to its assigned people, set rates and a budget." : "Projects you can log time to."}</p></div>
      <div class="actions-row"><label class="check"><input type="checkbox" id="showClosed" ${TC.showClosed ? "checked" : ""}> Show closed</label>
        ${isAdmin() ? `<button class="btn primary" id="newProj">${icon("plus")}New project</button>` : ""}</div></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Project</th><th>Client</th><th>Who can log</th><th class="num">Rate</th><th class="num">This month</th><th class="num">All time</th><th>Budget</th><th>Status</th></tr></thead>
      <tbody>${show.map((p) => { const all = sum(rep, p.id), pct = p.budget_hours ? Math.round(100 * all / p.budget_hours) : null;
        return `<tr data-proj="${p.id}" tabindex="0"><td><b>${esc(p.name)}</b>${p.code ? ` <span class="muted">${esc(p.code)}</span>` : ""}</td><td>${esc(p.client || "")}</td>
          <td>${p.limited ? "Assigned people" : "All staff + assigned"}</td><td class="num">${p.billable ? (p.rate ? money(p.rate) + "/h" : "Billable") : "Non-billable"}</td>
          <td class="num">${hrs(sum(month, p.id))}</td><td class="num">${hrs(all)}</td>
          <td>${pct == null ? "—" : `<div class="budget-bar ${pct > 100 ? "over" : pct > 85 ? "warn" : ""}"><i style="width:${Math.min(pct, 100)}%"></i></div><small>${pct}% of ${hrs(p.budget_hours)} h</small>`}</td><td>${pill(p.status === "Active" ? "Active" : p.status === "Closed" ? "Dropped" : "Dormant").replace(/>(Dropped|Dormant)</, `>${p.status}<`)}</td></tr>`; }).join("")
        || `<tr><td colspan="8" class="empty">No projects yet.</td></tr>`}</tbody></table></div></section>`;
  $("#showClosed").addEventListener("change", (e) => { TC.showClosed = e.target.checked; Projects(); });
  $("#newProj")?.addEventListener("click", () => editProject(null));
  $$("[data-proj]").forEach((r) => r.addEventListener("click", () => isAdmin() ? editProject(TC.projects.find((p) => p.id === +r.dataset.proj)) : null));
}
async function editProject(p) {
  const people = p ? must(await sb.from("project_people").select("*").eq("project_id", p.id)) : [];
  S.team = must(await sb.from("profiles").select("*").order("display_name"));  // pick up anyone who just joined
  const on = (id) => people.find((x) => x.user_id === id);
  const active = S.team.filter((m) => m.active);
  $("#drawerTitle").textContent = p ? `Edit ${p.name}` : "New project";
  $("#drawerBody").innerHTML = `<form id="projForm" class="form-grid">
    <label>Name<input name="name" required value="${esc(p?.name || "")}"></label>
    <label>Client<input name="client" value="${esc(p?.client || "")}"></label>
    <label>Code <small class="muted">(optional, e.g. PO or charge code)</small><input name="code" value="${esc(p?.code || "")}"></label>
    <label>Status<select name="status">${["Active", "Paused", "Closed"].map((s) => `<option ${s === (p?.status || "Active") ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    <label>Billable rate per hour (USD)<input name="rate" type="number" min="0" step="0.01" value="${p?.rate ?? ""}"></label>
    <label>Budget (hours)<input name="budget_hours" type="number" min="0" step="0.5" value="${p?.budget_hours ?? ""}"></label>
    <label>Approver <small class="muted">(besides admins)</small><select name="approver_id"><option value="">Admins only</option>${active.filter((m) => isStaffRole(m.role)).map((m) => `<option value="${m.id}" ${m.id === p?.approver_id ? "selected" : ""}>${esc(m.display_name)}</option>`).join("")}</select></label>
    <label class="check"><input type="checkbox" name="billable" ${p?.billable !== false ? "checked" : ""}> Billable</label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="limited" ${p?.limited ? "checked" : ""}> Only the people below can log time (otherwise all staff can, plus anyone below)</label>
    <fieldset class="people-pick" style="grid-column:1/-1"><legend>People on this project <small class="muted">rate overrides the project rate</small></legend>
      ${active.map((m) => `<div class="pp-row"><label class="check"><input type="checkbox" data-pp="${m.id}" ${on(m.id) ? "checked" : ""}> ${esc(m.display_name)} ${!isStaffRole(m.role) ? `<span class="pill s-high">${roleName(m.role)}</span>` : ""}</label>
        <input type="number" min="0" step="0.01" placeholder="Rate" data-pprate="${m.id}" value="${on(m.id)?.rate ?? ""}" aria-label="Rate for ${esc(m.display_name)}"></div>`).join("")}</fieldset>
    <label style="grid-column:1/-1">Notes<textarea name="notes" rows="2">${esc(p?.notes || "")}</textarea></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button>${p ? `<button class="btn danger" type="button" id="delProj">Delete</button>` : ""}</div></form>`;
  openDrawer();
  $("#projForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const row = { name: f.get("name").trim(), client: f.get("client").trim() || null, code: f.get("code").trim() || null, status: f.get("status"),
      rate: f.get("rate") === "" ? null : +f.get("rate"), budget_hours: f.get("budget_hours") === "" ? null : +f.get("budget_hours"),
      approver_id: f.get("approver_id") || null, billable: !!f.get("billable"), limited: !!f.get("limited"), notes: f.get("notes").trim() || null };
    try {
      const saved = p ? must(await sb.from("projects").update(row).eq("id", p.id).select("*").single()) : must(await sb.from("projects").insert(row).select("*").single());
      const want = $$("[data-pp]").filter((c) => c.checked).map((c) => ({ project_id: saved.id, user_id: c.dataset.pp, rate: $(`[data-pprate="${c.dataset.pp}"]`).value === "" ? null : +$(`[data-pprate="${c.dataset.pp}"]`).value }));
      for (const x of people) if (!want.some((w) => w.user_id === x.user_id)) must(await sb.from("project_people").delete().eq("project_id", saved.id).eq("user_id", x.user_id));
      for (const w of want) {
        const had = people.find((x) => x.user_id === w.user_id);
        if (!had) must(await sb.from("project_people").insert(w));
        else if (had.rate !== w.rate) must(await sb.from("project_people").update({ rate: w.rate }).eq("project_id", saved.id).eq("user_id", w.user_id));
      }
      toast("Project saved"); closeDrawer(); Projects();
    } catch (err) { toast(err.message); }
  });
  $("#delProj")?.addEventListener("click", async () => {
    if (!confirm(`Delete ${p.name} and all hours logged to it? Closing it keeps the history.`)) return;
    try { must(await sb.from("projects").delete().eq("id", p.id)); toast("Deleted"); closeDrawer(); Projects(); } catch (err) { toast(err.message); }
  });
}

/* ================================================================ Reports */
async function Reports() {
  await loadProjects();
  const t = today(), m0 = t.slice(0, 8) + "01";
  TC.from ||= m0; TC.to ||= t;
  const rows = await db.rpc("ts_report", { p_from: TC.from, p_to: TC.to });
  const byProj = {};
  rows.forEach((r) => (byProj[r.project_id] ||= { name: r.project, client: r.client, rows: [] }).rows.push(r));
  const tot = (list, k) => list.reduce((a, r) => a + (+r[k] || 0), 0);
  const lm = new Date(t + "T12:00:00"); lm.setDate(0); const lmEnd = lm.toLocaleDateString("en-CA"), lmStart = lmEnd.slice(0, 8) + "01";
  const q0 = (() => { const d = new Date(t + "T12:00:00"); return `${d.getFullYear()}-${String(Math.floor(d.getMonth() / 3) * 3 + 1).padStart(2, "0")}-01`; })();
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><p class="muted">${isAdmin() ? "Hours and amounts by project and person." : "Your hours by project."} Approved hours are from approved weeks.</p></div>
      <div class="actions-row"><button class="btn" id="csv">Export CSV</button></div></div>
    <div class="filters"><div class="tabs">${[["This month", m0, t], ["Last month", lmStart, lmEnd], ["This quarter", q0, t]].map(([l, a, b]) =>
        `<button data-range="${a}|${b}" aria-selected="${TC.from === a && TC.to === b}">${l}</button>`).join("")}</div>
      <label class="inline">From <input type="date" id="rFrom" value="${TC.from}"></label><label class="inline">To <input type="date" id="rTo" value="${TC.to}"></label></div>
    <div class="kpis"><div class="kpi panel"><div><span>Hours</span><b>${hrs(tot(rows, "hours"))}</b><small>${hrs(tot(rows, "approved_hours"))} approved</small></div><div class="bubble">${icon("timer")}</div></div>
      <div class="kpi panel"><div><span>Billable amount</span><b>${money(tot(rows.filter((r) => r.billable), "amount"))}</b><small>at project or person rates</small></div><div class="bubble">${icon("banknotes")}</div></div>
      <div class="kpi panel"><div><span>Projects</span><b>${Object.keys(byProj).length}</b><small>with hours in this range</small></div><div class="bubble">${icon("briefcase")}</div></div></div>
    ${await timeOffSection()}
    ${Object.values(byProj).map((p) => `<section class="panel"><h2>${esc(p.name)} <small>${esc(p.client || "")} · ${hrs(tot(p.rows, "hours"))} h${tot(p.rows, "amount") ? " · " + money(tot(p.rows, "amount")) : ""}</small></h2>
      <div class="table-wrap"><table><thead><tr><th>Person</th><th class="num">Hours</th><th class="num">Approved</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${p.rows.map((r) => `<tr style="cursor:default"><td>${esc(r.person)}</td><td class="num">${hrs(r.hours)}</td><td class="num">${hrs(r.approved_hours)}</td><td class="num">${r.rate ? money(r.rate) : "—"}</td><td class="num">${r.billable && r.amount ? money(r.amount) : "—"}</td></tr>`).join("")}</tbody></table></div></section>`).join("")
      || `<div class="empty">No hours in this range.</div>`}`;
  $$("[data-range]").forEach((b) => b.addEventListener("click", () => { [TC.from, TC.to] = b.dataset.range.split("|"); Reports(); }));
  ["rFrom", "rTo"].forEach((id) => $("#" + id).addEventListener("change", () => { TC.from = $("#rFrom").value || m0; TC.to = $("#rTo").value || t; Reports(); }));
  $("#csv").addEventListener("click", () => downloadCsv(`timecards-${TC.from}-to-${TC.to}.csv`,
    ["project", "client", "person", "hours", "approved_hours", "rate", "amount", "billable"], rows));
}

/* ================================================================ Time off in reports */
async function timeOffSection() {
  const rows = await sb.from("time_entries").select("user_id, kind, hours").is("project_id", null).gte("work_date", TC.from).lte("work_date", TC.to).then((r) => r.data || []).catch(() => []);
  if (!rows.length) return "";
  const by = {};
  rows.forEach((r) => { const x = (by[r.user_id] ||= { Holiday: 0, PTO: 0, Sick: 0 }); x[r.kind] = (x[r.kind] || 0) + +r.hours; });
  return `<section class="panel"><h2>Time off <small>${hrs(rows.reduce((a, r) => a + +r.hours, 0))} h</small></h2><div class="table-wrap"><table>
    <thead><tr><th>Person</th><th class="num">Holiday</th><th class="num">PTO</th><th class="num">Sick</th></tr></thead>
    <tbody>${Object.entries(by).map(([u, x]) => `<tr style="cursor:default"><td>${esc(nameOf(u))}</td><td class="num">${hrs(x.Holiday) === "0" ? "" : hrs(x.Holiday)}</td><td class="num">${hrs(x.PTO) === "0" ? "" : hrs(x.PTO)}</td><td class="num">${hrs(x.Sick) === "0" ? "" : hrs(x.Sick)}</td></tr>`).join("")}</tbody></table></div></section>`;
}

/* ================================================================ Expenses
   Expenses go on a report: add each one (receipt, mileage at the company rate, an optional project and whether it's billable),
   submit the report, an admin or the project's approver approves it, and an admin records the reimbursement.
   Approved expenses on a project show in that project's costs in Projects. */
const usd = (n) => "$" + (+n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EXP_CATS = ["Airfare", "Lodging", "Meals", "Ground transport", "Mileage", "Parking and tolls", "Per diem", "Supplies", "Software and subscriptions",
  "Training and conferences", "Phone and internet", "Shipping and postage", "Other"];
const expNo = (r) => "EXP-" + String(r.number || 0).padStart(4, "0");
const EXP_PILL = { Draft: "Draft", Submitted: "Submitted", Approved: "Approved", Rejected: "Rejected", Paid: "Reimbursed" };
async function expSettings() { return (await sb.from("expense_settings").select("*").maybeSingle().then((r) => r.data).catch(() => null)) || { mileage_rate: 0.76, receipt_over: 75 }; }
async function expTotals(ids) {
  if (!ids.length) return {};
  const items = await sb.from("expense_items").select("report_id, amount").in("report_id", ids).then((r) => r.data || []);
  const t = {}; items.forEach((i) => (t[i.report_id] = (t[i.report_id] || 0) + +i.amount)); return t;
}

async function Expenses(param) {
  const all = isAdmin() && param === "all";
  let q = sb.from("expense_reports").select("*").order("created_at", { ascending: false }).limit(300);
  if (!all) q = q.eq("user_id", S.user.id);
  const reps = must(await q), tot = await expTotals(reps.map((r) => r.id));
  const sum = (f) => reps.filter(f).reduce((a, r) => a + (tot[r.id] || 0), 0), yr = today().slice(0, 4);
  const filt = TC.expFilter || "", show = filt ? reps.filter((r) => r.status === filt) : reps;
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${all ? "All expense reports" : "My expenses"}</h1><p class="muted">Put expenses on a report, attach receipts, then submit it for approval and reimbursement.${!all ? " Need approval before buying something? Ask in <a href=\"../tickets/#/requests?new=" + encodeURIComponent("Purchase or expense") + "\">Tickets</a>." : ""}</p></div>
      <div class="actions-row">${isAdmin() ? `<div class="tabs"><a role="tab" href="#/expenses" aria-selected="${!all}">Mine</a><a role="tab" href="#/expenses/all" aria-selected="${all}">Everyone</a></div>` : ""}
        <button class="btn primary" id="newRep">${icon("plus")}New expense report</button></div></div>
    <div class="kpis">
      <div class="kpi panel"><div><span>Drafts</span><b>${usd(sum((r) => ["Draft", "Rejected"].includes(r.status)))}</b><small>not submitted yet</small></div><div class="bubble">${icon("clipboard")}</div></div>
      <div class="kpi panel"><div><span>Waiting for approval</span><b>${usd(sum((r) => r.status === "Submitted"))}</b><small>${reps.filter((r) => r.status === "Submitted").length} reports</small></div><div class="bubble">${icon("clock")}</div></div>
      <div class="kpi panel"><div><span>Approved, to reimburse</span><b>${usd(sum((r) => r.status === "Approved"))}</b><small>${reps.filter((r) => r.status === "Approved").length} reports</small></div><div class="bubble">${icon("banknotes")}</div></div>
      <div class="kpi panel"><div><span>Reimbursed in ${yr}</span><b>${usd(sum((r) => r.status === "Paid" && String(r.paid_at || "").startsWith(yr)))}</b><small>paid out</small></div><div class="bubble">${icon("check")}</div></div></div>
    <div class="filters"><div class="tabs">${["", "Draft", "Submitted", "Approved", "Rejected", "Paid"].map((x) => `<button data-ef="${x}" aria-selected="${filt === x}">${x ? EXP_PILL[x] : "All"}</button>`).join("")}</div></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Report</th>${all ? "<th>Person</th>" : ""}<th>Title</th><th class="num">Total</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${show.map((r) => `<tr data-rep="${r.id}" tabindex="0"><td><b>${expNo(r)}</b></td>${all ? `<td>${esc(nameOf(r.user_id))}</td>` : ""}<td>${esc(r.title)}</td>
        <td class="num">${usd(tot[r.id] || 0)}</td><td>${pill(EXP_PILL[r.status])}</td><td class="muted">${r.status === "Paid" ? "Reimbursed " + short(r.paid_at) : ago(r.updated_at)}</td></tr>`).join("")
        || `<tr><td colspan="6" class="empty">No expense reports${filt ? " here" : " yet"}. ${filt ? "" : "Start one for your next trip or purchase."}</td></tr>`}</tbody></table></div></section>`;
  $$("[data-ef]").forEach((b) => b.addEventListener("click", () => { TC.expFilter = b.dataset.ef; Expenses(param); }));
  $$("[data-rep]").forEach((r) => { const go = () => (location.hash = `#/expense/${r.dataset.rep}`); r.addEventListener("click", go); r.addEventListener("keydown", (e) => e.key === "Enter" && go()); });
  $("#newRep").addEventListener("click", async () => {
    const m = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
    try { const r = must(await sb.from("expense_reports").insert({ title: `Expenses, ${m}` }).select("*").single()); location.hash = `#/expense/${r.id}`; } catch (e) { toast(e.message); }
  });
}

async function Expense(id) {
  await loadProjects();
  const r = must(await sb.from("expense_reports").select("*").eq("id", +id).maybeSingle());
  if (!r) { $("#main").innerHTML = `<div class="empty">That report isn't there, or you can't see it. <a href="#/expenses">Back to expenses</a></div>`; return; }
  const items = must(await sb.from("expense_items").select("*").eq("report_id", r.id).order("spent_on"));
  const rcIds = items.map((i) => i.receipt_id).filter(Boolean);
  const rcs = rcIds.length ? must(await sb.from("expense_receipts").select("id, name, size").in("id", rcIds)) : [];
  const set = await expSettings(), mine = r.user_id === S.user.id, edit = mine && ["Draft", "Rejected"].includes(r.status);
  const canDecide = r.status === "Submitted" && !mine || (r.status === "Submitted" && mine && isAdmin() && S.team.filter((p) => p.role === "admin" && p.active).length === 1);
  const total = items.reduce((a, i) => a + +i.amount, 0), billable = items.filter((i) => i.billable).reduce((a, i) => a + +i.amount, 0);
  const missing = items.filter((i) => !i.receipt_id && !["Mileage", "Per diem"].includes(i.category) && +i.amount >= +set.receipt_over);
  const byCat = {}, byProj = {};
  items.forEach((i) => { byCat[i.category] = (byCat[i.category] || 0) + +i.amount; const k = i.project_id ? projName(i.project_id) : "No project"; byProj[k] = (byProj[k] || 0) + +i.amount; });
  $("#main").innerHTML = `
    <div class="page-head"><div><a class="muted small" href="#/expenses${!mine && isAdmin() ? "/all" : ""}">← Expenses</a>
        <h1>${edit ? `<input id="repTitle" class="title-in" value="${esc(r.title)}" aria-label="Report title">` : esc(r.title)}</h1>
        <p class="muted">${expNo(r)} · ${esc(nameOf(r.user_id))} · ${pill(EXP_PILL[r.status])}${r.submitted_at ? ` · submitted ${ago(r.submitted_at)}` : ""}${r.status === "Paid" ? ` · reimbursed ${short(r.paid_at)}${r.paid_ref ? " (" + esc(r.paid_ref) + ")" : ""}` : ""}</p></div>
      <div class="actions-row"><button class="btn" id="expCsv">Export CSV</button>${edit && !items.length ? `<button class="btn danger" id="delRep">Delete report</button>` : ""}</div></div>
    ${r.status === "Rejected" ? `<div class="notice-bar alert">${icon("alert")}<div><b>Sent back by ${esc(nameOf(r.decided_by))}:</b> ${esc(r.decision_note || "")}<br><span class="muted">Fix it and submit again.</span></div></div>` : ""}
    ${r.status === "Approved" ? `<div class="notice-bar ok">${icon("check")}<div>Approved by ${esc(nameOf(r.decided_by))} ${ago(r.decided_at)}. ${isAdmin() ? "Record the reimbursement when it's paid." : "Reimbursement is on its way."}</div></div>` : ""}
    ${r.status === "Submitted" && mine ? `<div class="notice-bar">${icon("clock")}<div>Waiting for approval. <button class="link" id="pullBack">Pull it back to edit</button></div></div>` : ""}
    <section class="panel tc-panel"><div class="table-wrap"><table class="exp-table">
      <thead><tr><th>Date</th><th>Category</th><th>Merchant and purpose</th><th>Project</th><th>Receipt</th><th class="num">Amount</th>${edit ? "<th></th>" : ""}</tr></thead>
      <tbody>${items.map((i) => { const rc = rcs.find((x) => x.id === i.receipt_id), need = missing.includes(i);
        return `<tr data-item="${i.id}"><td>${short(i.spent_on)}</td><td>${esc(i.category)}${i.category === "Mileage" ? `<small>${hrs(i.miles)} mi × ${usd(set.mileage_rate)}</small>` : ""}</td>
          <td><b>${esc(i.merchant || "")}</b>${i.description ? `<small>${esc(i.description)}</small>` : ""}</td>
          <td>${i.project_id ? esc(projName(i.project_id)) + (i.billable ? ` <span class="pill s-low">Billable</span>` : "") : `<span class="muted">—</span>`}</td>
          <td>${rc ? `<button class="link" data-rc="${rc.id}">${icon("clipboard", "ic tiny")} ${esc(rc.name)}</button>` : need ? `<span class="pill s-high">Receipt needed</span>` : `<span class="muted">—</span>`}</td>
          <td class="num"><b>${usd(i.amount)}</b></td>${edit ? `<td class="num"><button class="btn small" data-edit="${i.id}">Edit</button></td>` : ""}</tr>`; }).join("")
        || `<tr><td colspan="7" class="empty">No expenses on this report yet.${edit ? " Add the first one." : ""}</td></tr>`}</tbody>
      <tfoot><tr><td colspan="${edit ? 3 : 3}">${edit ? `<button class="btn small" id="addItem">${icon("plus")}Add an expense</button>` : "<b>Total</b>"}</td><td colspan="2" class="muted small">${billable ? usd(billable) + " billable to clients" : ""}</td><td class="num"><b>${usd(total)}</b></td>${edit ? "<td></td>" : ""}</tr></tfoot>
    </table></div>
    ${items.length > 1 ? `<div class="exp-sums"><div><h3>By category</h3>${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<p><span>${esc(k)}</span><b>${usd(v)}</b></p>`).join("")}</div>
      <div><h3>By project</h3>${Object.entries(byProj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<p><span>${esc(k)}</span><b>${usd(v)}</b></p>`).join("")}</div></div>` : ""}
    <div class="tc-foot"><label>Note for the approver<textarea id="repNote" rows="2" ${edit ? "" : "disabled"} placeholder="Trip, client or purpose">${esc(r.note || "")}</textarea></label>
      <div class="actions-row">${edit ? `<button class="btn primary" id="submitRep" ${items.length ? "" : "disabled"}>Submit ${usd(total)}</button>` : ""}</div></div>
    ${missing.length && edit ? `<p class="muted small">Receipts are needed for expenses of ${usd(set.receipt_over)} or more (mileage and per diem excepted).</p>` : ""}
    ${canDecide ? `<div class="exp-decide"><label>Reason (needed to send back)<textarea id="decNote" rows="2"></textarea></label>
      <div class="actions-row"><button class="btn primary" id="approve">${icon("check")}Approve ${usd(total)}</button><button class="btn danger" id="reject">Send back</button></div></div>` : ""}
    ${isAdmin() && r.status === "Approved" ? `<form class="exp-decide" id="paidForm"><h3>Record the reimbursement</h3><div class="form-grid">
      <label>Paid on<input type="date" name="date" value="${today()}" required></label><label>Reference <small class="muted">(payroll run, transfer or check no.)</small><input name="ref"></label></div>
      <div class="actions-row"><button class="btn primary">Mark reimbursed</button><button class="btn" type="button" id="reopen">Reopen</button></div></form>` : ""}
    ${isAdmin() && r.status === "Rejected" && !mine ? `<div class="actions-row"><button class="btn" id="reopen">Reopen as draft</button></div>` : ""}
    </section>`;
  const reload = () => Expense(r.id);
  $("#repTitle")?.addEventListener("change", async (e) => { try { must(await sb.from("expense_reports").update({ title: e.target.value.trim() || r.title }).eq("id", r.id)); toast("Saved"); } catch (err) { toast(err.message); } });
  $("#repNote")?.addEventListener("change", async (e) => { if (!edit) return; try { must(await sb.from("expense_reports").update({ note: e.target.value.trim() || null }).eq("id", r.id)); } catch (err) { toast(err.message); } });
  $("#addItem")?.addEventListener("click", () => itemForm(r, null, set, reload));
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => itemForm(r, items.find((i) => i.id === +b.dataset.edit), set, reload)));
  $$("[data-rc]").forEach((b) => b.addEventListener("click", () => openReceipt(+b.dataset.rc)));
  $("#submitRep")?.addEventListener("click", async () => {
    try { await db.rpc("exp_submit", { p_report: r.id, p_note: $("#repNote").value }); toast("Submitted for approval"); reload(); } catch (e) { toast(e.message); }
  });
  $("#pullBack")?.addEventListener("click", async () => { try { await db.rpc("exp_reopen", { p_report: r.id }); toast("Back to draft"); reload(); } catch (e) { toast(e.message); } });
  $("#reopen")?.addEventListener("click", async () => { if (!confirm("Reopen this report as a draft? Its costs come off the projects until it's approved again.")) return; try { await db.rpc("exp_reopen", { p_report: r.id }); toast("Reopened"); reload(); } catch (e) { toast(e.message); } });
  const decide = async (ok) => { try { await db.rpc("exp_decide", { p_report: r.id, p_approve: ok, p_note: $("#decNote").value }); toast(ok ? "Approved" : "Sent back"); refreshBadge(); reload(); } catch (e) { toast(e.message); } };
  $("#approve")?.addEventListener("click", () => decide(true));
  $("#reject")?.addEventListener("click", () => decide(false));
  $("#paidForm")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await db.rpc("exp_paid", { p_report: r.id, p_date: f.get("date"), p_ref: f.get("ref") }); toast("Marked reimbursed"); reload(); } catch (err) { toast(err.message); }
  });
  $("#delRep")?.addEventListener("click", async () => { try { must(await sb.from("expense_reports").delete().eq("id", r.id)); toast("Deleted"); location.hash = "#/expenses"; } catch (e) { toast(e.message); } });
  $("#expCsv").addEventListener("click", () => downloadCsv(`${expNo(r)}.csv`, ["date", "category", "merchant", "description", "project", "billable", "miles", "amount", "receipt"],
    items.map((i) => ({ date: i.spent_on, category: i.category, merchant: i.merchant || "", description: i.description || "", project: i.project_id ? projName(i.project_id) : "",
      billable: i.billable ? "yes" : "", miles: i.miles ?? "", amount: i.amount, receipt: rcs.find((x) => x.id === i.receipt_id)?.name || "" }))));
}

function itemForm(r, it, set, done) {
  const projs = TC.projects.filter((p) => (p.status === "Active" && canLog(p)) || p.id === it?.project_id);
  $("#drawerTitle").textContent = it ? "Edit expense" : "Add an expense";
  $("#drawerBody").innerHTML = `<form id="itForm" class="form-grid">
    <label>Date<input type="date" name="spent_on" required max="${today()}" value="${it?.spent_on || today()}"></label>
    <label>Category<select name="category">${EXP_CATS.map((c) => `<option ${c === (it?.category || "Meals") ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <label class="exp-amt">Amount (USD)<input name="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${it && it.category !== "Mileage" ? it.amount : ""}"></label>
    <label class="exp-mi" hidden>Miles<input name="miles" type="number" min="0" step="0.1" inputmode="decimal" value="${it?.miles ?? ""}"><small class="muted" id="miCalc"></small></label>
    <label>Merchant<input name="merchant" value="${esc(it?.merchant || "")}" placeholder="e.g. Delta, Marriott, Uber"></label>
    <label style="grid-column:1/-1">Business purpose<input name="description" value="${esc(it?.description || "")}" placeholder="e.g. Client site visit, Fairfax County"></label>
    <label>Project <small class="muted">(optional)</small><select name="project_id"><option value="">No project (overhead)</option>${projs.map((p) => `<option value="${p.id}" ${p.id === it?.project_id ? "selected" : ""}>${esc(p.name)}${p.client ? " · " + esc(p.client) : ""}</option>`).join("")}</select></label>
    <label class="check exp-bill"><input type="checkbox" name="billable" ${it?.billable ? "checked" : ""}> Billable to the client</label>
    <div style="grid-column:1/-1" class="exp-rc"><span class="muted small">Receipt</span>
      ${it?.receipt_id ? `<p class="small">A receipt is attached. <button class="link" type="button" id="rcView">View</button> · <button class="link" type="button" id="rcDrop">Remove</button></p>` : ""}
      <input type="file" name="receipt" accept="image/*,.pdf" capture="environment"><small class="muted">Photo or PDF, up to 10 MB. Needed for ${usd(set.receipt_over)} or more.</small></div>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">${it ? "Save" : "Add expense"}</button>${it ? `<button class="btn danger" type="button" id="itDel">Delete</button>` : ""}
      ${!it ? `<button class="btn" type="submit" data-another>Add and start another</button>` : ""}</div></form>`;
  openDrawer();
  const f = $("#itForm"), sync = () => {
    const mi = f.category.value === "Mileage";
    $(".exp-amt", f).hidden = mi; $(".exp-mi", f).hidden = !mi; f.amount.required = !mi; f.miles.required = mi;
    $("#miCalc").textContent = mi ? `${usd((+f.miles.value || 0) * set.mileage_rate)} at ${usd(set.mileage_rate)} a mile` : "";
    $(".exp-bill", f).hidden = !f.project_id.value; if (!f.project_id.value) f.billable.checked = false;
  };
  ["change", "input"].forEach((ev) => f.addEventListener(ev, sync)); sync();
  let dropRc = false;
  $("#rcView")?.addEventListener("click", () => openReceipt(it.receipt_id));
  $("#rcDrop")?.addEventListener("click", (e) => { dropRc = true; e.target.closest("p").remove(); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const again = e.submitter?.hasAttribute("data-another"), d = new FormData(f), file = f.receipt.files[0];
    if (file && file.size > 10 * 1024 * 1024) { toast("That receipt is over 10 MB."); return; }
    const row = { report_id: r.id, spent_on: d.get("spent_on"), category: d.get("category"), merchant: d.get("merchant").trim() || null, description: d.get("description").trim() || null,
      amount: d.get("category") === "Mileage" ? 0 : +d.get("amount") || 0, miles: d.get("category") === "Mileage" ? +d.get("miles") || 0 : null,
      project_id: d.get("project_id") ? +d.get("project_id") : null, billable: !!d.get("billable") };
    try {
      if (file) {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = () => rej(new Error("Couldn't read that file.")); fr.readAsDataURL(file); });
        row.receipt_id = must(await sb.from("expense_receipts").insert({ name: file.name, mime: file.type || "application/octet-stream", size: file.size, data_b64: b64 }).select("id").single()).id;
      } else if (dropRc) row.receipt_id = null;
      if (it) must(await sb.from("expense_items").update(row).eq("id", it.id)); else must(await sb.from("expense_items").insert(row));
      toast(it ? "Saved" : "Expense added");
      if (again) { await done(); itemForm(r, null, set, done); } else { closeDrawer(); done(); }
    } catch (err) { toast(err.message); }
  });
  $("#itDel")?.addEventListener("click", async () => { try { must(await sb.from("expense_items").delete().eq("id", it.id)); toast("Deleted"); closeDrawer(); done(); } catch (err) { toast(err.message); } });
}
async function openReceipt(id) {
  try {
    const f = must(await sb.from("expense_receipts").select("name, mime, data_b64").eq("id", id).single());
    const bin = atob(f.data_b64), u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([u8], { type: f.mime || "application/octet-stream" }));
    const w = window.open(url, "_blank"); if (!w) { const a = document.createElement("a"); a.href = url; a.download = f.name; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast(e.message); }
}

/* ================================================================ Settings (admins): holidays and expense rules */
function usFederal(y) {   // US federal holidays with their observed dates (Saturday → Friday, Sunday → Monday)
  const iso = (d) => d.toLocaleDateString("en-CA");
  const nth = (m, dow, n) => { const d = new Date(y, m, 1); while (d.getDay() !== dow) d.setDate(d.getDate() + 1); d.setDate(d.getDate() + 7 * (n - 1)); return iso(d); };
  const last = (m, dow) => { const d = new Date(y, m + 1, 0); while (d.getDay() !== dow) d.setDate(d.getDate() - 1); return iso(d); };
  const obs = (m, day) => { const d = new Date(y, m, day); if (d.getDay() === 6) d.setDate(d.getDate() - 1); if (d.getDay() === 0) d.setDate(d.getDate() + 1); return iso(d); };
  return [[obs(0, 1), "New Year's Day"], [nth(0, 1, 3), "Martin Luther King Jr. Day"], [nth(1, 1, 3), "Washington's Birthday"], [last(4, 1), "Memorial Day"],
    [obs(5, 19), "Juneteenth"], [obs(6, 4), "Independence Day"], [nth(8, 1, 1), "Labor Day"], [nth(9, 1, 2), "Columbus Day"], [obs(10, 11), "Veterans Day"],
    [nth(10, 4, 4), "Thanksgiving Day"], [obs(11, 25), "Christmas Day"]].map(([day, name]) => ({ day, name }));
}
async function Settings() {
  if (!isAdmin()) { $("#main").innerHTML = `<div class="empty">Only admins can change these settings.</div>`; return; }
  await loadHolidays();
  const set = await expSettings(), y = +today().slice(0, 4);
  const upcoming = TC.holidays.filter((h) => h.day >= y + "-01-01");
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p class="muted">Company holidays for timesheets, and the rules for expenses.</p></div></div>
    <section class="panel"><h2>Company holidays <small>Holiday hours can only go on these dates. Leave the list empty to allow Holiday on any day.</small></h2>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Holiday</th><th></th></tr></thead><tbody>
        ${upcoming.map((h) => `<tr style="cursor:default"><td>${new Date(h.day + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</td><td>${esc(h.name)}</td>
          <td class="num"><button class="btn small danger" data-delhol="${h.day}">Remove</button></td></tr>`).join("") || `<tr><td colspan="3" class="empty">No holidays listed.</td></tr>`}</tbody></table></div>
      <form id="holForm" class="actions-row" style="margin-top:12px"><input type="date" name="day" required aria-label="Holiday date"><input name="name" required placeholder="Holiday name" aria-label="Holiday name"><button class="btn">${icon("plus")}Add</button></form>
      <div class="actions-row" style="margin-top:8px">${[y, y + 1].map((yr) => `<button class="btn small" data-fed="${yr}">Add US federal holidays for ${yr}</button>`).join("")}</div></section>
    <section class="panel"><h2>Expenses</h2><form id="expSet" class="form-grid">
      <label>Mileage rate (USD a mile)<input name="mileage_rate" type="number" min="0" step="0.005" value="${set.mileage_rate}"><small class="muted">The IRS business rate is 76¢ from July 1, 2026 (72.5¢ before).</small></label>
      <label>Receipts required from (USD)<input name="receipt_over" type="number" min="0" step="1" value="${set.receipt_over}"><small class="muted">IRS rules need receipts for lodging and for any expense of $75 or more.</small></label>
      <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button></div></form></section>`;
  $("#holForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { must(await sb.from("company_holidays").upsert({ day: f.get("day"), name: f.get("name").trim() })); toast("Holiday added"); Settings(); } catch (err) { toast(err.message); }
  });
  $$("[data-fed]").forEach((b) => b.addEventListener("click", async () => {
    try { must(await sb.from("company_holidays").upsert(usFederal(+b.dataset.fed), { onConflict: "workspace_id,day", ignoreDuplicates: true })); toast(`US federal holidays for ${b.dataset.fed} added`); Settings(); } catch (err) { toast(err.message); }
  }));
  $$("[data-delhol]").forEach((b) => b.addEventListener("click", async () => { try { must(await sb.from("company_holidays").delete().eq("day", b.dataset.delhol)); Settings(); } catch (err) { toast(err.message); } }));
  $("#expSet").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { must(await sb.from("expense_settings").upsert({ workspace_id: S.profile.workspace_id, mileage_rate: +f.get("mileage_rate"), receipt_over: +f.get("receipt_over"), updated_at: new Date().toISOString() })); toast("Saved"); } catch (err) { toast(err.message); }
  });
}

/* ================================================================ router */
const routes = { week: Week, approvals: Approvals, projects: Projects, reports: Reports, expenses: Expenses, expense: Expense, settings: Settings };

window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [name, param] = location.hash.replace(/^#\/?/, "").split("/");
  const key = routes[name] ? name : "week";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === (key === "expense" ? "expenses" : key)));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve(routes[key](param)).catch((e) => ($("#main").innerHTML = /projects|time_entries|timesheets|ts_|expense|holiday|schema cache|does not exist|kind/i.test(e.message)
    ? `<section class="panel"><h2>One-time setup needed</h2><p>Timecards needs the latest database update. ${isAdmin() ? "Run the latest <code>supabase/schema.sql</code> in the Supabase SQL Editor." : "Ask an admin to run the Pulse database update."}</p></section>`
    : `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try { if (!(await requireMember())) return; showShell(); const ns = $("#navSettings"); if (ns) ns.hidden = !isAdmin(); route(); }
  catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
