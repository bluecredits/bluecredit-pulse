/* Pulse · Timecards — weekly timesheets by project, approvals, projects and reports.
   Uses ../core.js helpers. The database decides who may log, see and approve (see "Timecards" in schema.sql);
   this file only chooses what to show. */
"use strict";

const TC = { week: null, projects: [], mine: new Set(), entries: [], sheet: null, from: null, to: null };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const isAdmin = () => S.profile?.role === "admin";
const isStaff = () => S.profile && isStaffRole(S.profile.role);
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
const canLog = (p) => p.status === "Active" && ((!p.limited && isStaff()) || TC.mine.has(p.id));
const projName = (id) => TC.projects.find((p) => p.id === id)?.name || "Project";

async function refreshBadge() {
  try {
    const rows = must(await sb.from("timesheets").select("user_id").eq("status", "Submitted"));
    const n = rows.filter((r) => r.user_id !== S.user.id).length, b = $("#nb-approvals");
    if (b) { b.hidden = !n; b.textContent = n; }
  } catch { /* table missing: handled on the page */ }
}

/* ================================================================ My timesheet */
async function Week(param) {
  TC.week = param && /^\d{4}-\d{2}-\d{2}$/.test(param) ? weekOf(param) : TC.week || weekOf(today());
  await loadProjects();
  const days = weekDays(TC.week);
  TC.entries = must(await sb.from("time_entries").select("*").eq("user_id", S.user.id).gte("work_date", days[0]).lte("work_date", days[6]));
  TC.sheet = must(await sb.from("timesheets").select("*").eq("user_id", S.user.id).eq("week_start", TC.week).maybeSingle());
  const st = TC.sheet?.status || "Draft", locked = st === "Submitted" || st === "Approved";
  const rows = [...new Set(TC.entries.map((e) => e.project_id))];
  (TC.extraRows?.[TC.week] || []).forEach((id) => !rows.includes(id) && rows.push(id));
  const loggable = TC.projects.filter((p) => canLog(p) && !rows.includes(p.id));
  const cell = (pid, d) => TC.entries.find((e) => e.project_id === pid && e.work_date === d);
  const total = TC.entries.reduce((a, e) => a + +e.hours, 0);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>My timesheet</h1><p class="muted">Log hours by project each day, then submit the week for approval.</p></div>
      <div class="actions-row week-nav">
        <a class="btn small" href="#/week/${addDays(TC.week, -7)}" aria-label="Previous week">${icon("chevron-left")}</a>
        <b class="week-label">${weekLabel(TC.week)}</b>
        <a class="btn small" href="#/week/${addDays(TC.week, 7)}" aria-label="Next week">${icon("chevron-right")}</a>
        ${TC.week !== weekOf(today()) ? `<a class="btn small" href="#/week/${weekOf(today())}">This week</a>` : ""}</div></div>
    ${st === "Rejected" ? `<div class="notice-bar alert">${icon("alert")}<div><b>Sent back by ${esc(nameOf(TC.sheet.decided_by))}:</b> ${esc(TC.sheet.decision_note || "")}<br><span class="muted">Fix the hours and submit again.</span></div></div>` : ""}
    ${st === "Approved" ? `<div class="notice-bar ok">${icon("check")}<div>Approved by ${esc(nameOf(TC.sheet.decided_by))} ${ago(TC.sheet.decided_at)}.</div></div>` : ""}
    ${st === "Submitted" ? `<div class="notice-bar">${icon("clock")}<div>Submitted ${ago(TC.sheet.submitted_at)}. Waiting for approval. <button class="link" id="pullBack">Pull it back to edit</button></div></div>` : ""}
    <section class="panel tc-panel"><div class="table-wrap"><table class="tc-grid">
      <thead><tr><th>Project</th>${days.map((d) => `<th class="num ${d === today() ? "today" : ""}">${dayHead(d)}</th>`).join("")}<th class="num">Total</th></tr></thead>
      <tbody>${rows.length ? rows.map((pid) => {
        const rt = days.reduce((a, d) => a + +(cell(pid, d)?.hours || 0), 0);
        return `<tr><td class="tc-proj"><b>${esc(projName(pid))}</b>${TC.projects.find((p) => p.id === pid)?.client ? `<small>${esc(TC.projects.find((p) => p.id === pid).client)}</small>` : ""}</td>
          ${days.map((d) => `<td class="num"><input class="tc-in" type="number" min="0" max="24" step="0.25" inputmode="decimal" data-p="${pid}" data-d="${d}"
            value="${cell(pid, d) ? +cell(pid, d).hours : ""}" ${locked ? "disabled" : ""} aria-label="${esc(projName(pid))} ${dayHead(d)}"></td>`).join("")}
          <td class="num"><b>${hrs(rt)}</b></td></tr>`; }).join("")
        : `<tr><td colspan="9" class="empty">${loggable.length ? "No hours this week yet. Add a project below." : TC.projects.length ? "You aren't on any open projects. Ask an admin to add you." : "No projects yet." + (isAdmin() ? ` <a href="#/projects">Add one</a>.` : " Ask an admin to add one.")}</td></tr>`}</tbody>
      <tfoot><tr><td>${!locked && loggable.length ? `<select id="addRow" aria-label="Add a project"><option value="">+ Add a project…</option>${loggable.map((p) => `<option value="${p.id}">${esc(p.name)}${p.client ? " · " + esc(p.client) : ""}</option>`).join("")}</select>` : "<b>Total</b>"}</td>
        ${days.map((d) => `<td class="num">${hrs(TC.entries.filter((e) => e.work_date === d).reduce((a, e) => a + +e.hours, 0)) || ""}</td>`).join("")}<td class="num"><b id="weekTotal">${hrs(total)}</b></td></tr></tfoot>
    </table></div>
    <div class="tc-foot"><label>Notes for the approver<textarea id="weekNote" rows="2" ${locked ? "disabled" : ""} placeholder="Anything they should know about this week">${esc(TC.sheet?.note || "")}</textarea></label>
      <div class="actions-row">${pill(STATUS_PILL[st])}${!locked ? `<button class="btn primary" id="submitWeek" ${total ? "" : "disabled"}>Submit ${hrs(total)} hours</button>` : ""}</div></div></section>`;
  $("#addRow")?.addEventListener("change", (e) => {
    const id = +e.target.value; if (!id) return;
    TC.extraRows = TC.extraRows || {}; (TC.extraRows[TC.week] ||= []).push(id); Week(TC.week);
  });
  $$(".tc-in").forEach((inp) => inp.addEventListener("change", () => saveCell(inp)));
  $("#submitWeek")?.addEventListener("click", async () => {
    try { await db.rpc("ts_submit", { p_week: TC.week, p_note: $("#weekNote").value }); toast("Week submitted for approval"); Week(TC.week); } catch (e) { toast(e.message); }
  });
  $("#pullBack")?.addEventListener("click", async () => {
    try { await db.rpc("ts_reopen", { p_user: S.user.id, p_week: TC.week }); toast("Back to draft"); Week(TC.week); } catch (e) { toast(e.message); }
  });
  refreshBadge();
}
async function saveCell(inp) {
  const pid = +inp.dataset.p, d = inp.dataset.d, v = inp.value === "" ? 0 : Math.round(+inp.value * 100) / 100;
  if (v < 0 || v > 24 || Number.isNaN(v)) { toast("Enter between 0 and 24 hours"); return; }
  const cur = TC.entries.find((e) => e.project_id === pid && e.work_date === d);
  try {
    if (cur && !v) { must(await sb.from("time_entries").delete().eq("id", cur.id)); TC.entries = TC.entries.filter((e) => e !== cur); }
    else if (cur) { must(await sb.from("time_entries").update({ hours: v }).eq("id", cur.id)); cur.hours = v; }
    else if (v) { const r = must(await sb.from("time_entries").insert({ project_id: pid, work_date: d, hours: v }).select("*").single()); TC.entries.push(r); }
    inp.classList.add("saved"); setTimeout(() => inp.classList.remove("saved"), 700);
    const total = TC.entries.reduce((a, e) => a + +e.hours, 0);
    $("#weekTotal").textContent = hrs(total);
    const btn = $("#submitWeek"); if (btn) { btn.disabled = !total; btn.textContent = `Submit ${hrs(total)} hours`; }
    const row = inp.closest("tr"), rt = $$(".tc-in", row).reduce((a, i) => a + (+i.value || 0), 0); row.lastElementChild.innerHTML = `<b>${hrs(rt)}</b>`;
    const col = [...row.children].indexOf(inp.closest("td")), foot = $(".tc-grid tfoot tr").children[col];
    foot.textContent = hrs(TC.entries.filter((e) => e.work_date === d).reduce((a, e) => a + +e.hours, 0)) || "";
  } catch (e) { toast(e.message); inp.value = cur ? +cur.hours : ""; }
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
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Approvals</h1><p class="muted">${isAdmin() ? "Admins approve every timesheet. Project approvers approve weeks with hours on their projects." : "Weeks with hours on projects you approve."}</p></div></div>
    ${missing.length ? `<div class="notice-bar">${icon("alert")}<div><b>Not submitted for ${weekLabel(addDays(weekOf(today()), -7))}:</b> ${missing.map((p) => esc(p.display_name)).join(", ")}</div></div>` : ""}
    <h2 class="hub-h">Waiting for you <small class="muted">${waiting.length}</small></h2>
    <div class="appr-grid">${waiting.map((t) => card(t, true)).join("") || `<div class="empty">Nothing waiting. 🎉</div>`}</div>
    ${decided.length ? `<h2 class="hub-h">Recently decided</h2><div class="appr-grid">${decided.map((t) => card(t, false)).join("")}</div>` : ""}`;
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { const [u, w] = b.closest("[data-sheet]").dataset.sheet.split("|"); openSheet(u, w); }));
  refreshBadge();
}
async function openSheet(user, week) {
  const days = weekDays(week);
  const ents = must(await sb.from("time_entries").select("*").eq("user_id", user).gte("work_date", days[0]).lte("work_date", days[6]));
  const t = must(await sb.from("timesheets").select("*").eq("user_id", user).eq("week_start", week).maybeSingle());
  const pids = [...new Set(ents.map((e) => e.project_id))];
  const h = (p, d) => ents.filter((e) => e.project_id === p && e.work_date === d).reduce((a, e) => a + +e.hours, 0);
  $("#drawerTitle").textContent = `${nameOf(user)} · ${weekLabel(week)}`;
  $("#drawerBody").innerHTML = `
    <div class="table-wrap"><table class="tc-grid ro"><thead><tr><th>Project</th>${days.map((d) => `<th class="num">${dayHead(d)}</th>`).join("")}<th class="num">Total</th></tr></thead>
      <tbody>${pids.map((p) => `<tr><td>${esc(projName(p))}</td>${days.map((d) => `<td class="num">${hrs(h(p, d)) === "0" ? "" : hrs(h(p, d))}</td>`).join("")}<td class="num"><b>${hrs(days.reduce((a, d) => a + h(p, d), 0))}</b></td></tr>`).join("")}</tbody>
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
    ${Object.values(byProj).map((p) => `<section class="panel"><h2>${esc(p.name)} <small>${esc(p.client || "")} · ${hrs(tot(p.rows, "hours"))} h${tot(p.rows, "amount") ? " · " + money(tot(p.rows, "amount")) : ""}</small></h2>
      <div class="table-wrap"><table><thead><tr><th>Person</th><th class="num">Hours</th><th class="num">Approved</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${p.rows.map((r) => `<tr style="cursor:default"><td>${esc(r.person)}</td><td class="num">${hrs(r.hours)}</td><td class="num">${hrs(r.approved_hours)}</td><td class="num">${r.rate ? money(r.rate) : "—"}</td><td class="num">${r.billable && r.amount ? money(r.amount) : "—"}</td></tr>`).join("")}</tbody></table></div></section>`).join("")
      || `<div class="empty">No hours in this range.</div>`}`;
  $$("[data-range]").forEach((b) => b.addEventListener("click", () => { [TC.from, TC.to] = b.dataset.range.split("|"); Reports(); }));
  ["rFrom", "rTo"].forEach((id) => $("#" + id).addEventListener("change", () => { TC.from = $("#rFrom").value || m0; TC.to = $("#rTo").value || t; Reports(); }));
  $("#csv").addEventListener("click", () => downloadCsv(`timecards-${TC.from}-to-${TC.to}.csv`,
    ["project", "client", "person", "hours", "approved_hours", "rate", "amount", "billable"], rows));
}

/* ================================================================ router */
const routes = { week: Week, approvals: Approvals, projects: Projects, reports: Reports };
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [name, param] = location.hash.replace(/^#\/?/, "").split("/");
  const key = routes[name] ? name : "week";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve(routes[key](param)).catch((e) => ($("#main").innerHTML = /projects|time_entries|timesheets|ts_|schema cache|does not exist/i.test(e.message)
    ? `<section class="panel"><h2>One-time setup needed</h2><p>Timecards needs the latest database update. ${isAdmin() ? "Run the latest <code>supabase/schema.sql</code> in the Supabase SQL Editor." : "Ask an admin to run the Pulse database update."}</p></section>`
    : `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try { if (!(await requireMember())) return; showShell(); route(); }
  catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
