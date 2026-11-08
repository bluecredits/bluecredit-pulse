/* Pulse · Projects — run funded work: overview, schedule (milestones), task board and list, team, budget vs. actual
   (labor from Timecards plus other costs), documents (agreements), risks/issues and status reports, then close-out.
   Uses ../core.js helpers; the database decides who can see and change what (see "Projects (execution)" in schema.sql). */
"use strict";

const PJ = { tab: "overview", filter: "active" };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const isAdmin = () => S.profile?.role === "admin";
const isStaff = () => S.profile && isStaffRole(S.profile.role);
const nameOf = (id) => S.team.find((p) => p.id === id)?.display_name || "";
const firstOf = (id) => nameOf(id).split(" ")[0];
const usd = (n) => n == null || n === "" ? "—" : "$" + Math.round(+n).toLocaleString("en-US");
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const HEALTH = { "On track": "s-won", "At risk": "s-high", "Off track": "s-lost" };
const hpill = (h) => `<span class="pill ${HEALTH[h] || ""}">${esc(h || "—")}</span>`;
const STATUSES = ["Planned", "Active", "Paused", "Complete", "Closed"];
const COLS = ["To do", "Doing", "Blocked", "Done"];
const COST_CATS = ["Subcontractor", "Consultant", "Materials", "Equipment", "Travel", "Software", "Permits and fees", "Other"];
const bar = (p, cls = "") => `<div class="budget-bar ${cls}"><i style="width:${Math.min(100, Math.max(0, p))}%"></i></div>`;
const canManage = (p) => isStaff() && (isAdmin() || !p.manager_id || p.manager_id === S.user.id);

/* ================================================================ portfolio */
async function Portfolio() {
  const rows = await db.rpc("project_rollup", {});
  const groups = { active: (r) => ["Active", "Planned", "Paused"].includes(r.status), done: (r) => ["Complete", "Closed"].includes(r.status), all: () => true };
  const list = rows.filter(groups[PJ.filter]);
  const act = rows.filter((r) => r.status === "Active");
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><p class="muted">Funded work from kickoff to close-out: schedule, tasks, team, budget and status.</p></div>
      ${isStaff() ? `<div class="actions-row"><a class="btn primary" href="#/new">${icon("plus")}New project</a></div>` : ""}</div>
    ${isStaff() ? `<div class="kpis">
      <div class="kpi panel"><div><span>Active projects</span><b>${act.length}</b><small>${act.filter((r) => r.health !== "On track").length} need attention</small></div><div class="bubble">${icon("briefcase")}</div></div>
      <div class="kpi panel"><div><span>Late tasks</span><b>${act.reduce((a, r) => a + r.tasks_late, 0)}</b><small>past their due date</small></div><div class="bubble">${icon("alert")}</div></div>
      <div class="kpi panel"><div><span>Spent on active work</span><b>${usd(act.reduce((a, r) => a + +r.labor + +(r.costs || 0), 0))}</b><small>of ${usd(act.reduce((a, r) => a + +(r.budget_amount || 0), 0))} budgeted</small></div><div class="bubble">${icon("banknotes")}</div></div></div>` : ""}
    <div class="filters"><div class="tabs">${[["active", "Current"], ["done", "Complete and closed"], ["all", "All"]].map(([k, l]) => `<button data-f="${k}" aria-selected="${PJ.filter === k}">${l}</button>`).join("")}</div></div>
    <div class="proj-grid">${list.map((r) => { const spent = +r.labor + +(r.costs || 0), done = pct(r.tasks_done, r.tasks);
      return `<a class="appr-card proj-card" href="#/p/${r.id}"><header>${icon("briefcase")}<div><span class="tno">${esc(r.client || "")}${r.code ? " · " + esc(r.code) : ""}</span><h3>${esc(r.name)}</h3></div>${hpill(r.health)}</header>
        <div class="proj-meta"><span>${esc(r.status)}</span>${r.manager_id ? `<span>PM ${esc(firstOf(r.manager_id))}</span>` : ""}${r.end_date ? `<span>Ends ${short(r.end_date)}</span>` : ""}</div>
        <div class="proj-stat"><span>Tasks</span>${bar(done)}<small>${r.tasks_done}/${r.tasks}${r.tasks_late ? ` · <b class="red">${r.tasks_late} late</b>` : ""}</small></div>
        ${r.budget_amount && isStaff() ? `<div class="proj-stat"><span>Budget</span>${bar(pct(spent, r.budget_amount), spent > r.budget_amount ? "over" : pct(spent, r.budget_amount) > 85 ? "warn" : "")}<small>${usd(spent)} of ${usd(r.budget_amount)}</small></div>` : ""}
        ${r.next_milestone ? `<p class="muted small">Next: ${esc(r.next_milestone.name)}${r.next_milestone.due ? " · " + short(r.next_milestone.due) : ""}</p>` : ""}</a>`; }).join("")
      || `<div class="empty">No projects here yet.${isStaff() ? ` <a href="#/new">Start one</a>, or turn a won opportunity into a project.` : ""}</div>`}</div>`;
  $$("[data-f]").forEach((b) => b.addEventListener("click", () => { PJ.filter = b.dataset.f; Portfolio(); }));
}

/* ================================================================ new project */
async function New() {
  if (!isStaff()) return Portfolio();
  const won = must(await sb.from("opportunities").select("id, title, agency, value, stage").eq("stage", "Won").order("updated_at", { ascending: false }).limit(200));
  const staff = S.team.filter((p) => p.active && isStaffRole(p.role));
  $("#main").innerHTML = `<div class="page-head"><div><h1>New project</h1><p class="muted">Start from a won opportunity, or from scratch.</p></div></div>
    <section class="panel"><form id="npForm" class="form-grid">
      <label style="grid-column:1/-1">From a won opportunity<select name="opp"><option value="">None, start from scratch</option>${won.map((o) => `<option value="${o.id}">${esc(o.title)}${o.agency ? " · " + esc(o.agency) : ""}</option>`).join("")}</select></label>
      <label>Project name<input name="name" required></label><label>Client<input name="client"></label>
      <label>Code / contract number<input name="code"></label><label>Project manager<select name="manager_id">${staff.map((p) => `<option value="${p.id}" ${p.id === S.user.id ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label>
      <label>Start<input type="date" name="start_date" value="${today()}"></label><label>End<input type="date" name="end_date"></label>
      <label>Contract value (USD)<input type="number" step="any" name="contract_value"></label><label>Cost budget (USD)<input type="number" step="any" name="budget_amount"></label>
      <label>Budget hours<input type="number" step="any" name="budget_hours"></label><label>Billing rate per hour<input type="number" step="any" name="rate"></label>
      <label style="grid-column:1/-1">Description<textarea name="description" rows="3"></textarea></label>
      <label class="check" style="grid-column:1/-1"><input type="checkbox" name="starter" checked> Add starter milestones (Kickoff, Midpoint review, Final deliverable, Close-out)</label>
      <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Create project</button></div></form></section>`;
  const f = $("#npForm");
  f.opp.addEventListener("change", () => { const o = won.find((x) => String(x.id) === f.opp.value); if (!o) return; f.name.value ||= o.title; f.client.value ||= o.agency || ""; if (o.value) f.contract_value.value ||= o.value; });
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    const num = (k) => (d[k] === "" ? null : +d[k]);
    try {
      const p = must(await sb.from("projects").insert({ name: d.name.trim(), client: d.client || null, code: d.code || null, manager_id: d.manager_id || null, start_date: d.start_date || null,
        end_date: d.end_date || null, contract_value: num("contract_value"), budget_amount: num("budget_amount"), budget_hours: num("budget_hours"), rate: num("rate"),
        description: d.description || null, opportunity_id: d.opp ? +d.opp : null, status: "Active", health: "On track" }).select("*").single());
      if (d.starter) {
        const s = d.start_date || today(), e2 = d.end_date || addDays(s, 90), mid = new Date((Date.parse(s) + Date.parse(e2)) / 2).toISOString().slice(0, 10);
        must(await sb.from("project_milestones").insert([["Kickoff", s, false], ["Midpoint review", mid, false], ["Final deliverable", addDays(e2, -7), true], ["Close-out", e2, false]]
          .map(([name, due, deliverable], i) => ({ project_id: p.id, name, due_date: due, deliverable, sort: i }))));
      }
      if (d.manager_id && isAdmin()) { try { must(await sb.from("project_people").insert({ project_id: p.id, user_id: d.manager_id })); } catch { /* already on it */ } }
      toast("Project created"); location.hash = `#/p/${p.id}`;
    } catch (err) { toast(err.message); }
  });
}

/* ================================================================ project page */
const TABS = [["overview", "Overview", "home"], ["schedule", "Schedule", "calendar"], ["board", "Board", "grid"], ["list", "List", "clipboard"], ["team", "Team", "team"],
  ["cost", "Cost", "banknotes", true], ["documents", "Documents", "book"], ["risks", "Risks & issues", "alert", true], ["reports", "Reports", "chart", true]];
async function Project(id, tab) {
  PJ.tab = tab || PJ.tab || "overview";
  const p = must(await sb.from("projects").select("*").eq("id", id).maybeSingle());
  if (!p) { $("#main").innerHTML = `<div class="empty">Project not found.</div>`; return; }
  const [roll] = await db.rpc("project_rollup", { p_id: id });
  PJ.p = p; PJ.roll = roll;
  const tabs = TABS.filter((t) => !t[3] || isStaff());
  if (!tabs.some((t) => t[0] === PJ.tab)) PJ.tab = "overview";
  $("#main").innerHTML = `
    <div class="page-head"><div><p class="muted small"><a href="#/portfolio">Projects</a>${p.client ? " › " + esc(p.client) : ""}</p><h1>${esc(p.name)}</h1>
      <p class="muted">${hpill(p.health)} ${esc(p.status)}${p.manager_id ? " · PM " + esc(nameOf(p.manager_id)) : ""}${p.start_date ? " · " + short(p.start_date) + (p.end_date ? " – " + short(p.end_date) : "") : ""}${p.code ? " · " + esc(p.code) : ""}</p></div>
      ${canManage(p) ? `<div class="actions-row"><button class="btn" id="editProj">Edit project</button>${["Active", "Paused", "Planned", "Complete"].includes(p.status) ? `<button class="btn" id="closeProj">Close out…</button>` : ""}</div>` : ""}</div>
    <nav class="proj-toolbar" role="tablist">${tabs.map(([k, l, ic]) => `<a href="#/p/${id}/${k}" role="tab" aria-selected="${PJ.tab === k}">${icon(ic)}<span>${l}</span></a>`).join("")}</nav>
    <div id="ptab"></div>`;
  $("#editProj")?.addEventListener("click", () => editProject(p));
  $("#closeProj")?.addEventListener("click", () => closeProject(p));
  await ({ overview: Overview, schedule: Schedule, board: Board, list: TaskList, team: Team, cost: Cost, documents: Documents, risks: Risks, reports: Reports })[PJ.tab](p, roll);
}
const reload = () => Project(PJ.p.id, PJ.tab);

/* ---------------- overview */
async function Overview(p, r) {
  const [ms, tasks, risks, ups] = await Promise.all([
    sb.from("project_milestones").select("*").eq("project_id", p.id).order("due_date").then(must),
    sb.from("project_tasks").select("id, title, status, due_date, assignee_id, priority").eq("project_id", p.id).neq("status", "Done").order("due_date").then(must),
    isStaff() ? sb.from("project_risks").select("*").eq("project_id", p.id).eq("status", "Open").then(must) : [],
    isStaff() ? sb.from("project_updates").select("*").eq("project_id", p.id).order("period_end", { ascending: false }).limit(3).then(must) : []]);
  const spent = +r.labor + +(r.costs || 0), timePct = p.start_date && p.end_date ? pct(Date.now() - Date.parse(p.start_date), Date.parse(p.end_date) - Date.parse(p.start_date)) : null;
  $("#ptab").innerHTML = `
    <div class="kpis">
      <div class="kpi panel"><div><span>Tasks done</span><b>${pct(r.tasks_done, r.tasks)}%</b><small>${r.tasks_done} of ${r.tasks}${r.tasks_late ? ` · ${r.tasks_late} late` : ""}</small></div><div class="bubble">${icon("check")}</div></div>
      <div class="kpi panel"><div><span>Milestones</span><b>${r.milestones_done}/${r.milestones}</b><small>${r.next_milestone ? "Next: " + esc(r.next_milestone.name) : "None open"}</small></div><div class="bubble">${icon("calendar")}</div></div>
      ${isStaff() ? `<div class="kpi panel ${p.budget_amount && spent > p.budget_amount ? "alert" : ""}"><div><span>Spent</span><b>${usd(spent)}</b><small>${p.budget_amount ? pct(spent, p.budget_amount) + "% of " + usd(p.budget_amount) : "No budget set"}</small></div><div class="bubble">${icon("banknotes")}</div></div>` : ""}
      <div class="kpi panel"><div><span>Hours logged</span><b>${(+r.hours).toLocaleString()}</b><small>${p.budget_hours ? pct(r.hours, p.budget_hours) + "% of " + p.budget_hours + " h" : "from Timecards"}</small></div><div class="bubble">${icon("timer")}</div></div></div>
    ${timePct != null ? `<section class="panel"><h2>Time vs. progress</h2><div class="tvp"><span>Time elapsed</span>${bar(timePct)}<small>${Math.max(0, Math.min(100, timePct))}%</small>
      <span>Work done</span>${bar(pct(r.tasks_done, r.tasks), pct(r.tasks_done, r.tasks) + 15 < timePct ? "warn" : "")}<small>${pct(r.tasks_done, r.tasks)}%</small></div></section>` : ""}
    <div class="two-col">
      <section class="panel"><h2>Coming up <small><a href="#/p/${p.id}/schedule">Schedule</a></small></h2><ul class="checklist">${ms.filter((m) => !m.done_at).slice(0, 5).map((m) => `<li class="ck"><span>${m.deliverable ? icon("badge", "ic tiny") + " " : ""}${esc(m.name)}</span><span class="meta">${m.due_date ? dueCell(m.due_date, true) : ""}</span></li>`).join("") || `<li class="muted small">No open milestones.</li>`}</ul>
        <h3 class="ck-h">Open tasks due soon</h3><ul class="checklist">${tasks.filter((t) => t.due_date).slice(0, 6).map((t) => `<li class="ck"><span>${esc(t.title)} <span class="muted small">${esc(firstOf(t.assignee_id))}</span></span><span class="meta">${dueCell(t.due_date, true)}</span></li>`).join("") || `<li class="muted small">Nothing with a due date.</li>`}</ul></section>
      <section class="panel">${isStaff() ? `<h2>Latest status <small><a href="#/p/${p.id}/reports">Reports</a></small></h2>${ups.length ? ups.map((u) => `<div class="upd"><div>${hpill(u.health)} <b>${short(u.period_end)}</b> <span class="muted small">${esc(u.author || "")}</span></div><p>${esc(u.summary || "")}</p></div>`).join("") : `<p class="muted">No status reports yet.</p>`}
        <h3 class="ck-h">Open risks and issues <small class="muted">${risks.length}</small></h3><ul class="checklist">${risks.slice(0, 5).map((x) => `<li class="ck"><span><b>${esc(x.kind)}:</b> ${esc(x.title)}</span><span class="meta">${esc(x.impact)}</span></li>`).join("") || `<li class="muted small">None open.</li>`}</ul>` : `<h2>About</h2>`}
        ${p.description ? `<h3 class="ck-h">About</h3><p style="white-space:pre-wrap">${esc(p.description)}</p>` : ""}</section></div>`;
}

/* ---------------- schedule (milestones + timeline) */
async function Schedule(p) {
  const ms = must(await sb.from("project_milestones").select("*").eq("project_id", p.id).order("due_date", { nullsFirst: false }).order("sort"));
  const dates = ms.flatMap((m) => [m.start_date, m.due_date]).concat([p.start_date, p.end_date]).filter(Boolean).sort();
  const t0 = dates.length ? Date.parse(dates[0]) : Date.now(), t1 = dates.length ? Math.max(Date.parse(dates.at(-1)), t0 + 864e5 * 14) : t0 + 864e5 * 90;
  const x = (d) => (100 * (Date.parse(d) - t0)) / (t1 - t0), todayX = x(today());
  const manage = canManage(p);
  $("#ptab").innerHTML = `<section class="panel"><h2>Milestones and deliverables ${manage ? `<button class="btn small" id="addMs">${icon("plus")}Add milestone</button>` : ""}</h2>
    <div class="gantt"><div class="gantt-head"><span>${new Date(t0).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span><span>${new Date(t1).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div>
      ${ms.map((m) => { const late = !m.done_at && m.due_date && m.due_date < today(); const s = m.start_date || m.due_date;
        return `<div class="gantt-row ${m.done_at ? "done" : ""} ${late ? "late" : ""}"><div class="gantt-name"><label class="check"><input type="checkbox" data-msdone="${m.id}" ${m.done_at ? "checked" : ""} ${manage ? "" : "disabled"}> ${m.deliverable ? icon("badge", "ic tiny") : ""} ${esc(m.name)}</label>
          <small class="muted">${m.due_date ? short(m.due_date) : "No date"}${m.done_at ? " · done " + short(m.done_at) : late ? " · late" : ""}</small></div>
          <div class="gantt-track">${todayX >= 0 && todayX <= 100 ? `<b class="gantt-today" style="left:${todayX}%"></b>` : ""}${m.due_date ? (m.start_date && m.start_date < m.due_date
            ? `<i class="gantt-bar" style="left:${x(s)}%;width:${Math.max(1, x(m.due_date) - x(s))}%"></i>` : `<i class="gantt-dot" style="left:${x(m.due_date)}%"></i>`) : ""}</div>
          ${manage ? `<button class="btn small" data-msedit="${m.id}">Edit</button>` : ""}</div>`; }).join("") || `<p class="muted">No milestones yet.</p>`}</div></section>`;
  $("#addMs")?.addEventListener("click", () => editMilestone(p, null));
  $$("[data-msedit]").forEach((b) => b.addEventListener("click", () => editMilestone(p, ms.find((m) => m.id === +b.dataset.msedit))));
  $$("[data-msdone]").forEach((c) => c.addEventListener("change", async () => {
    try { must(await sb.from("project_milestones").update({ done_at: c.checked ? today() : null }).eq("id", +c.dataset.msdone)); toast(c.checked ? "Milestone done" : "Reopened"); reload(); } catch (e) { toast(e.message); c.checked = !c.checked; }
  }));
}
function editMilestone(p, m) {
  $("#drawerTitle").textContent = m ? "Edit milestone" : "Add milestone";
  $("#drawerBody").innerHTML = `<form id="msForm" class="form-grid"><label style="grid-column:1/-1">Name<input name="name" required value="${esc(m?.name || "")}"></label>
    <label>Start (optional)<input type="date" name="start_date" value="${m?.start_date || ""}"></label><label>Due<input type="date" name="due_date" value="${m?.due_date || ""}"></label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="deliverable" ${m?.deliverable ? "checked" : ""}> This is a contract deliverable</label>
    <label style="grid-column:1/-1">Notes<textarea name="notes" rows="2">${esc(m?.notes || "")}</textarea></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button>${m ? `<button type="button" class="btn danger" id="msDel">Delete</button>` : ""}</div></form>`;
  openDrawer();
  $("#msForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    const row = { name: d.name.trim(), start_date: d.start_date || null, due_date: d.due_date || null, deliverable: !!d.deliverable, notes: d.notes || null };
    try { must(m ? await sb.from("project_milestones").update(row).eq("id", m.id) : await sb.from("project_milestones").insert({ ...row, project_id: p.id })); closeDrawer(); reload(); } catch (err) { toast(err.message); }
  });
  $("#msDel")?.addEventListener("click", async () => { if (!confirm("Delete this milestone? Its tasks stay.")) return; try { must(await sb.from("project_milestones").delete().eq("id", m.id)); closeDrawer(); reload(); } catch (err) { toast(err.message); } });
}

/* ---------------- tasks: board and list */
async function loadTasks(p) {
  const [tasks, ms] = await Promise.all([sb.from("project_tasks").select("*").eq("project_id", p.id).order("sort").order("id").then(must),
    sb.from("project_milestones").select("id, name").eq("project_id", p.id).order("due_date").then(must)]);
  return { tasks, ms };
}
const canMove = (t) => isStaff() || t.assignee_id === S.user.id;
function taskCard(t, ms) {
  return `<article class="task ${t.due_date && t.due_date < today() && t.status !== "Done" ? "late" : ""} pri-${t.priority.toLowerCase()}" draggable="${canMove(t)}" data-task="${t.id}">
    <b>${esc(t.title)}</b><div class="task-meta">${t.assignee_id ? `<span class="avatar mini" title="${esc(nameOf(t.assignee_id))}">${esc(nameOf(t.assignee_id).split(/\s+/).map((w) => w[0]).slice(0, 2).join(""))}</span>` : ""}
    ${t.due_date ? `<span>${short(t.due_date)}</span>` : ""}${t.priority !== "Normal" ? `<span class="pri">${esc(t.priority)}</span>` : ""}${t.milestone_id ? `<span class="muted">${esc(ms.find((m) => m.id === t.milestone_id)?.name || "")}</span>` : ""}</div></article>`;
}
async function Board(p) {
  const { tasks, ms } = await loadTasks(p);
  $("#ptab").innerHTML = `<div class="board">${COLS.map((c) => `<section class="board-col" data-col="${c}"><h3>${c} <span class="muted">${tasks.filter((t) => t.status === c).length}</span></h3>
    <div class="board-list">${tasks.filter((t) => t.status === c).map((t) => taskCard(t, ms)).join("")}</div>
    ${isStaff() ? `<form class="board-add" data-add="${c}"><input placeholder="+ Add a task" aria-label="New task in ${c}"></form>` : ""}</section>`).join("")}</div>
    <p class="muted small">Drag cards between columns${isStaff() ? "" : " (your own tasks)"}; click a card to edit it.</p>`;
  let dragId = null;
  $$(".task").forEach((el) => {
    el.addEventListener("dragstart", () => { dragId = +el.dataset.task; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("click", () => editTask(p, tasks.find((t) => t.id === +el.dataset.task), ms));
  });
  $$(".board-col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("over"); const t = tasks.find((x) => x.id === dragId); if (!t || t.status === col.dataset.col) return;
      try { must(await sb.from("project_tasks").update({ status: col.dataset.col, sort: Date.now() / 1e6 }).eq("id", t.id)); Board(p); } catch (err) { toast(err.message); }
    });
  });
  $$("[data-add]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault(); const v = $("input", f).value.trim(); if (!v) return;
    try { must(await sb.from("project_tasks").insert({ project_id: p.id, title: v, status: f.dataset.add, sort: Date.now() / 1e6 })); Board(p); } catch (err) { toast(err.message); }
  }));
}
async function TaskList(p) {
  const { tasks, ms } = await loadTasks(p);
  PJ.lf ||= { who: "", status: "open" };
  const show = tasks.filter((t) => (PJ.lf.status === "open" ? t.status !== "Done" : PJ.lf.status === "all" || t.status === PJ.lf.status) && (!PJ.lf.who || t.assignee_id === PJ.lf.who));
  $("#ptab").innerHTML = `<div class="filters"><select id="lfS"><option value="open">Open</option>${COLS.map((c) => `<option>${c}</option>`).join("")}<option value="all">All</option></select>
    <select id="lfW"><option value="">Anyone</option>${S.team.filter((x) => x.active).map((x) => `<option value="${x.id}">${esc(x.display_name)}</option>`).join("")}</select>
    ${isStaff() ? `<button class="btn small primary" id="newTask">${icon("plus")}New task</button>` : ""}<button class="btn small" id="csvTasks">Export CSV</button></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Assignee</th><th>Milestone</th><th>Priority</th><th>Due</th></tr></thead><tbody>
    ${show.map((t) => `<tr data-task="${t.id}" tabindex="0"><td><b>${esc(t.title)}</b></td><td>${esc(t.status)}</td><td>${esc(nameOf(t.assignee_id))}</td><td>${esc(ms.find((m) => m.id === t.milestone_id)?.name || "")}</td>
      <td>${esc(t.priority)}</td><td class="date">${t.due_date ? dueCell(t.due_date, t.status !== "Done") : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No tasks.</td></tr>`}</tbody></table></div></section>`;
  $("#lfS").value = PJ.lf.status; $("#lfW").value = PJ.lf.who;
  $("#lfS").addEventListener("change", (e) => { PJ.lf.status = e.target.value; TaskList(p); });
  $("#lfW").addEventListener("change", (e) => { PJ.lf.who = e.target.value; TaskList(p); });
  $("#newTask")?.addEventListener("click", () => editTask(p, null, ms));
  $("#csvTasks").addEventListener("click", () => downloadCsv(`${p.name}-tasks.csv`, ["title", "status", "assignee", "milestone", "priority", "due_date", "estimate_hours"],
    show.map((t) => ({ ...t, assignee: nameOf(t.assignee_id), milestone: ms.find((m) => m.id === t.milestone_id)?.name || "" }))));
  $$("tr[data-task]").forEach((r) => r.addEventListener("click", () => editTask(p, tasks.find((t) => t.id === +r.dataset.task), ms)));
}
async function editTask(p, t, ms) {
  const people = must(await sb.from("project_people").select("user_id").eq("project_id", p.id)).map((x) => x.user_id);
  const team = S.team.filter((x) => x.active && (isStaffRole(x.role) || people.includes(x.id)));
  const ro = t && !isStaff();   // contractors can only move their own task between columns
  $("#drawerTitle").textContent = t ? "Task" : "New task";
  $("#drawerBody").innerHTML = `<form id="tkForm" class="form-grid"><label style="grid-column:1/-1">Title<input name="title" required value="${esc(t?.title || "")}" ${ro ? "readonly" : ""}></label>
    <label>Status<select name="status">${COLS.map((c) => `<option ${c === (t?.status || "To do") ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <label>Priority<select name="priority" ${ro ? "disabled" : ""}>${["Low", "Normal", "High", "Urgent"].map((c) => `<option ${c === (t?.priority || "Normal") ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <label>Assignee<select name="assignee_id" ${ro ? "disabled" : ""}><option value="">Unassigned</option>${team.map((x) => `<option value="${x.id}" ${x.id === t?.assignee_id ? "selected" : ""}>${esc(x.display_name)}</option>`).join("")}</select></label>
    <label>Due<input type="date" name="due_date" value="${t?.due_date || ""}" ${ro ? "readonly" : ""}></label>
    <label>Milestone<select name="milestone_id" ${ro ? "disabled" : ""}><option value="">None</option>${ms.map((m) => `<option value="${m.id}" ${m.id === t?.milestone_id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
    <label>Estimate (hours)<input type="number" step="any" name="estimate_hours" value="${t?.estimate_hours ?? ""}" ${ro ? "readonly" : ""}></label>
    <label style="grid-column:1/-1">Details<textarea name="description" rows="4" ${ro ? "readonly" : ""}>${esc(t?.description || "")}</textarea></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button>${t && isStaff() ? `<button type="button" class="btn danger" id="tkDel">Delete</button>` : ""}</div></form>`;
  openDrawer();
  $("#tkForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    const row = ro ? { status: d.status } : { title: d.title.trim(), status: d.status, priority: d.priority, assignee_id: d.assignee_id || null, due_date: d.due_date || null,
      milestone_id: d.milestone_id ? +d.milestone_id : null, estimate_hours: d.estimate_hours === "" ? null : +d.estimate_hours, description: d.description || null };
    try { must(t ? await sb.from("project_tasks").update(row).eq("id", t.id) : await sb.from("project_tasks").insert({ ...row, project_id: p.id, sort: Date.now() / 1e6 })); closeDrawer(); reload(); } catch (err) { toast(err.message); }
  });
  $("#tkDel")?.addEventListener("click", async () => { if (!confirm("Delete this task?")) return; try { must(await sb.from("project_tasks").delete().eq("id", t.id)); closeDrawer(); reload(); } catch (err) { toast(err.message); } });
}

/* ---------------- team */
async function Team(p) {
  const [pp, rep, onb] = await Promise.all([sb.from("project_people").select("*").eq("project_id", p.id).then(must), db.rpc("ts_report", { p_from: "2000-01-01", p_to: addDays(today(), 366) }),
    isStaff() ? sb.from("onboardings").select("id, name, user_id, status, kind").then(must) : []]);
  const hours = (uid) => rep.filter((r) => r.project_id === p.id && r.user_id === uid).reduce((a, r) => a + +r.hours, 0);
  const loggers = [...new Set(rep.filter((r) => r.project_id === p.id).map((r) => r.user_id))];
  const ids = [...new Set([...pp.map((x) => x.user_id), ...loggers, p.manager_id].filter(Boolean))];
  $("#ptab").innerHTML = `<section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th class="num">Hours</th>${isStaff() ? '<th class="num">Rate</th><th>Onboarding</th>' : ""}</tr></thead><tbody>
    ${ids.map((uid) => { const m = S.team.find((x) => x.id === uid), link = pp.find((x) => x.user_id === uid), o = onb.find((x) => x.user_id === uid);
      return `<tr style="cursor:default"><td><b>${esc(m?.display_name || "Former member")}</b>${m && !isStaffRole(m.role) ? ` <span class="pill s-high">${roleName(m.role)}</span>` : ""}</td>
        <td>${uid === p.manager_id ? "Project manager" : link ? "Assigned" : "Logged time"}</td><td class="num">${hours(uid).toLocaleString()}</td>
        ${isStaff() ? `<td class="num">${link?.rate ? usd(link.rate) : p.rate ? usd(p.rate) : "—"}</td><td>${o ? `<a href="../people/#/people">${esc(o.status)}</a>` : ""}</td>` : ""}</tr>`; }).join("") || `<tr><td colspan="5" class="empty">Nobody yet.</td></tr>`}</tbody></table></div></section>
    ${isAdmin() ? `<p class="muted small">Add or remove people, set their rates and who can log time in <a href="../timecards/#/projects">Timecards → Projects</a>. Bring on a new contractor in <a href="../people/#/people">People</a>.</p>` : ""}`;
}

/* ---------------- cost */
async function Cost(p, r) {
  const [costs, rep] = await Promise.all([sb.from("project_costs").select("*").eq("project_id", p.id).order("cost_date", { ascending: false }).then(must), db.rpc("ts_report", { p_from: "2000-01-01", p_to: addDays(today(), 366) })]);
  const labor = rep.filter((x) => x.project_id === p.id), laborTotal = labor.reduce((a, x) => a + +(x.amount || 0), 0), other = costs.reduce((a, c) => a + +c.amount, 0), spent = laborTotal + other;
  const byCat = COST_CATS.map((c) => [c, costs.filter((x) => x.category === c).reduce((a, x) => a + +x.amount, 0)]).filter(([, v]) => v);
  $("#ptab").innerHTML = `<div class="kpis">
      <div class="kpi panel"><div><span>Contract value</span><b>${usd(p.contract_value)}</b><small>${p.contract_value ? "margin " + usd(p.contract_value - spent) + " so far" : "Not set"}</small></div><div class="bubble">${icon("briefcase")}</div></div>
      <div class="kpi panel ${p.budget_amount && spent > p.budget_amount ? "alert" : ""}"><div><span>Spent</span><b>${usd(spent)}</b><small>${p.budget_amount ? pct(spent, p.budget_amount) + "% of " + usd(p.budget_amount) + " budget" : "No budget set"}</small></div><div class="bubble">${icon("banknotes")}</div></div>
      <div class="kpi panel"><div><span>Remaining budget</span><b>${p.budget_amount ? usd(p.budget_amount - spent) : "—"}</b><small>labor ${usd(laborTotal)} · other ${usd(other)}</small></div><div class="bubble">${icon("chart")}</div></div></div>
    <div class="two-col"><section class="panel"><h2>Labor from Timecards</h2><table><thead><tr><th>Person</th><th class="num">Hours</th><th class="num">Approved</th><th class="num">Amount</th></tr></thead><tbody>
      ${labor.map((x) => `<tr style="cursor:default"><td>${esc(x.person)}</td><td class="num">${(+x.hours).toLocaleString()}</td><td class="num">${(+(x.approved_hours || 0)).toLocaleString()}</td><td class="num">${usd(x.amount)}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No hours logged yet.</td></tr>`}</tbody></table></section>
      <section class="panel"><h2>Other costs by category</h2>${byCat.map(([c, v]) => `<div class="proj-stat"><span>${esc(c)}</span>${bar(pct(v, other))}<small>${usd(v)}</small></div>`).join("") || `<p class="muted">None yet.</p>`}</section></div>
    <section class="panel"><h2>Costs ${isStaff() ? `<span><button class="btn small" id="csvCost">Export CSV</button> <button class="btn small primary" id="addCost">${icon("plus")}Add cost</button></span>` : ""}</h2>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Category</th><th>Vendor</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>
      ${costs.map((c) => `<tr data-cost="${c.id}" tabindex="0"><td class="date">${short(c.cost_date)}</td><td>${esc(c.category)}</td><td>${esc(c.vendor || "")}</td><td>${esc(c.description || "")}</td><td class="num">${usd(c.amount)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No costs recorded.</td></tr>`}</tbody></table></div></section>`;
  $("#addCost")?.addEventListener("click", () => editCost(p, null));
  $$("[data-cost]").forEach((rw) => rw.addEventListener("click", () => editCost(p, costs.find((c) => c.id === +rw.dataset.cost))));
  $("#csvCost")?.addEventListener("click", () => downloadCsv(`${p.name}-costs.csv`, ["cost_date", "category", "vendor", "description", "amount"], costs));
}
async function editCost(p, c) {
  const agrs = must(await sb.from("agreements").select("id, number, title").eq("project_id", p.id));
  $("#drawerTitle").textContent = c ? "Edit cost" : "Add cost";
  $("#drawerBody").innerHTML = `<form id="cForm" class="form-grid"><label>Date<input type="date" name="cost_date" value="${c?.cost_date || today()}"></label>
    <label>Category<select name="category">${COST_CATS.map((k) => `<option ${k === c?.category ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Vendor<input name="vendor" value="${esc(c?.vendor || "")}"></label><label>Amount (USD)<input type="number" step="any" name="amount" required value="${c?.amount ?? ""}"></label>
    <label style="grid-column:1/-1">Description<input name="description" value="${esc(c?.description || "")}"></label>
    <label style="grid-column:1/-1">Under agreement<select name="agreement_id"><option value="">None</option>${agrs.map((g) => `<option value="${g.id}" ${g.id === c?.agreement_id ? "selected" : ""}>AGR-${String(g.number).padStart(4, "0")} ${esc(g.title)}</option>`).join("")}</select></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button>${c ? `<button type="button" class="btn danger" id="cDel">Delete</button>` : ""}</div></form>`;
  openDrawer();
  $("#cForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    const row = { cost_date: d.cost_date, category: d.category, vendor: d.vendor || null, description: d.description || null, amount: +d.amount, agreement_id: d.agreement_id ? +d.agreement_id : null };
    try { must(c ? await sb.from("project_costs").update(row).eq("id", c.id) : await sb.from("project_costs").insert({ ...row, project_id: p.id })); closeDrawer(); reload(); } catch (err) { toast(err.message); }
  });
  $("#cDel")?.addEventListener("click", async () => { if (!confirm("Delete this cost?")) return; try { must(await sb.from("project_costs").delete().eq("id", c.id)); closeDrawer(); reload(); } catch (err) { toast(err.message); } });
}

/* ---------------- documents (agreements) */
async function Documents(p) {
  const agrs = must(await sb.from("agreements").select("id, number, title, template_name, status, party_name, executed_at, end_date").eq("project_id", p.id).order("created_at"));
  $("#ptab").innerHTML = `<section class="panel"><h2>Agreements ${isStaff() ? `<span>${[["teaming", "Teaming"], ["consulting", "Consulting"], ["confidentiality", "Confidentiality"]].map(([k, l]) =>
      `<a class="btn small" href="../agreements/#/new?template=${k}&project=${p.id}">${icon("plus")}${l}</a>`).join(" ")}</span>` : ""}</h2>
    <div class="table-wrap"><table><thead><tr><th>Ref</th><th>Agreement</th><th>With</th><th>Status</th><th>Signed</th><th>Ends</th></tr></thead><tbody>
    ${agrs.map((g) => `<tr data-href="../agreements/#/view/${g.id}" tabindex="0"><td class="tno">AGR-${String(g.number).padStart(4, "0")}</td><td><b>${esc(g.title)}</b></td><td>${esc(g.party_name || "")}</td><td>${esc(g.status)}</td>
      <td class="date">${g.executed_at ? short(g.executed_at) : "—"}</td><td class="date">${g.end_date ? short(g.end_date) : "—"}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No agreements linked to this project yet.</td></tr>`}</tbody></table></div></section>`;
  $$("tr[data-href]").forEach((r) => r.addEventListener("click", () => (location.href = r.dataset.href)));
}

/* ---------------- risks and issues */
async function Risks(p) {
  const rows = must(await sb.from("project_risks").select("*").eq("project_id", p.id).order("status").order("created_at", { ascending: false }));
  $("#ptab").innerHTML = `<section class="panel"><h2>Risks, issues, decisions and changes <button class="btn small primary" id="addRisk">${icon("plus")}Add</button></h2>
    <div class="table-wrap"><table><thead><tr><th>Type</th><th>Title</th><th>Impact</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>
    ${rows.map((x) => `<tr data-risk="${x.id}" tabindex="0" class="${x.status === "Closed" ? "muted" : ""}"><td>${esc(x.kind)}</td><td><b>${esc(x.title)}</b></td><td>${esc(x.impact)}</td><td>${esc(nameOf(x.owner_id))}</td>
      <td class="date">${x.due_date ? dueCell(x.due_date, x.status === "Open") : ""}</td><td>${esc(x.status)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">Nothing logged.</td></tr>`}</tbody></table></div></section>`;
  $("#addRisk").addEventListener("click", () => editRisk(p, null));
  $$("[data-risk]").forEach((r) => r.addEventListener("click", () => editRisk(p, rows.find((x) => x.id === +r.dataset.risk))));
}
function editRisk(p, x) {
  const staff = S.team.filter((m) => m.active && isStaffRole(m.role));
  $("#drawerTitle").textContent = x ? `${x.kind}` : "Add risk or issue";
  $("#drawerBody").innerHTML = `<form id="rForm" class="form-grid"><label>Type<select name="kind">${["Risk", "Issue", "Decision", "Change"].map((k) => `<option ${k === x?.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Impact<select name="impact">${["Low", "Medium", "High"].map((k) => `<option ${k === (x?.impact || "Medium") ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label style="grid-column:1/-1">Title<input name="title" required value="${esc(x?.title || "")}"></label>
    <label style="grid-column:1/-1">Details / mitigation<textarea name="detail" rows="3">${esc(x?.detail || "")}</textarea></label>
    <label>Owner<select name="owner_id"><option value="">None</option>${staff.map((m) => `<option value="${m.id}" ${m.id === x?.owner_id ? "selected" : ""}>${esc(m.display_name)}</option>`).join("")}</select></label>
    <label>Due<input type="date" name="due_date" value="${x?.due_date || ""}"></label>
    <label>Status<select name="status">${["Open", "Closed"].map((k) => `<option ${k === (x?.status || "Open") ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label style="grid-column:1/-1">Resolution<textarea name="resolution" rows="2">${esc(x?.resolution || "")}</textarea></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button></div></form>`;
  openDrawer();
  $("#rForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    const row = { kind: d.kind, impact: d.impact, title: d.title.trim(), detail: d.detail || null, owner_id: d.owner_id || null, due_date: d.due_date || null, status: d.status, resolution: d.resolution || null };
    try { must(x ? await sb.from("project_risks").update(row).eq("id", x.id) : await sb.from("project_risks").insert({ ...row, project_id: p.id })); closeDrawer(); reload(); } catch (err) { toast(err.message); }
  });
}

/* ---------------- status reports */
async function Reports(p, r) {
  const ups = must(await sb.from("project_updates").select("*").eq("project_id", p.id).order("period_end", { ascending: false }));
  $("#ptab").innerHTML = `<section class="panel"><h2>Status reports <button class="btn small primary" id="newUp">${icon("plus")}New status report</button></h2>
    ${ups.map((u) => `<article class="upd"><div>${hpill(u.health)} <b>Week ending ${short(u.period_end)}</b> <span class="muted small">by ${esc(u.author || "")}</span> <button class="btn small" data-print="${u.id}">Print</button></div>
      <p>${esc(u.summary || "")}</p>${u.done ? `<h4>Done</h4><p class="pre">${esc(u.done)}</p>` : ""}${u.next ? `<h4>Next</h4><p class="pre">${esc(u.next)}</p>` : ""}${u.blockers ? `<h4>Blockers and asks</h4><p class="pre">${esc(u.blockers)}</p>` : ""}</article>`).join("") || `<p class="muted">No reports yet. A weekly one keeps the client and the team aligned.</p>`}</section>`;
  $("#newUp").addEventListener("click", () => newUpdate(p, ups[0]));
  $$("[data-print]").forEach((b) => b.addEventListener("click", () => printUpdate(p, ups.find((u) => u.id === +b.dataset.print), r)));
}
async function newUpdate(p, last) {
  const since = last?.period_end || p.start_date || addDays(today(), -7);
  const [tasks, ms] = await Promise.all([sb.from("project_tasks").select("title, status, done_at, due_date").eq("project_id", p.id).then(must),
    sb.from("project_milestones").select("name, due_date, done_at").eq("project_id", p.id).then(must)]);
  const done = [...tasks.filter((t) => t.done_at && t.done_at.slice(0, 10) > since).map((t) => "- " + t.title), ...ms.filter((m) => m.done_at && m.done_at > since).map((m) => "- Milestone: " + m.name)].join("\n");
  const next = [...ms.filter((m) => !m.done_at && m.due_date && m.due_date <= addDays(today(), 21)).map((m) => `- Milestone: ${m.name} (${short(m.due_date)})`),
    ...tasks.filter((t) => t.status !== "Done" && t.due_date && t.due_date <= addDays(today(), 14)).map((t) => `- ${t.title} (${short(t.due_date)})`)].join("\n");
  const blocked = tasks.filter((t) => t.status === "Blocked").map((t) => "- Blocked: " + t.title).join("\n");
  $("#drawerTitle").textContent = "New status report";
  $("#drawerBody").innerHTML = `<form id="uForm"><div class="form-grid"><label>Week ending<input type="date" name="period_end" value="${today()}"></label>
    <label>Overall health<select name="health">${Object.keys(HEALTH).map((h) => `<option ${h === p.health ? "selected" : ""}>${h}</option>`).join("")}</select></label></div>
    <label>Summary<textarea name="summary" rows="3" required placeholder="Two or three sentences for the client or leadership"></textarea></label>
    <label>Done since ${short(since)}<textarea name="done" rows="5">${esc(done)}</textarea></label><label>Next two weeks<textarea name="next" rows="5">${esc(next)}</textarea></label>
    <label>Blockers and asks<textarea name="blockers" rows="3">${esc(blocked)}</textarea></label>
    <p class="muted small">Filled in from tasks and milestones; edit as needed. Saving also sets the project's health.</p>
    <div class="actions-row"><button class="btn primary">Save report</button></div></form>`;
  openDrawer();
  $("#uForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    try {
      must(await sb.from("project_updates").insert({ project_id: p.id, ...d }));
      if (canManage(p) && d.health !== p.health) must(await sb.from("projects").update({ health: d.health }).eq("id", p.id));
      toast("Status report saved"); closeDrawer(); reload();
    } catch (err) { toast(err.message); }
  });
}
function printUpdate(p, u, r) {
  const w = window.open("", "_blank"); if (!w) return toast("Allow pop-ups to print");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.name)} status ${u.period_end}</title><style>body{font:14px/1.5 Georgia,serif;max-width:7in;margin:.6in auto;color:#111}h1{font-size:20px;margin:0}h2{font-size:15px;margin:18px 0 4px}.m{color:#555}pre{white-space:pre-wrap;font:inherit}</style></head><body>
    <h1>${esc(p.name)}: status report</h1><p class="m">${esc(S.workspace.name)} · ${esc(p.client || "")} · week ending ${esc(new Date(u.period_end + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }))} · health: <b>${esc(u.health)}</b></p>
    <p class="m">Tasks ${r.tasks_done}/${r.tasks} done · milestones ${r.milestones_done}/${r.milestones}${r.next_milestone ? " · next: " + esc(r.next_milestone.name) : ""}</p>
    <h2>Summary</h2><p>${esc(u.summary || "")}</p>${u.done ? `<h2>Done</h2><pre>${esc(u.done)}</pre>` : ""}${u.next ? `<h2>Next</h2><pre>${esc(u.next)}</pre>` : ""}${u.blockers ? `<h2>Blockers and asks</h2><pre>${esc(u.blockers)}</pre>` : ""}
    <script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}

/* ---------------- edit and close out */
function editProject(p) {
  const staff = S.team.filter((x) => x.active && isStaffRole(x.role));
  $("#drawerTitle").textContent = "Edit project";
  $("#drawerBody").innerHTML = `<form id="epForm" class="form-grid"><label style="grid-column:1/-1">Name<input name="name" required value="${esc(p.name)}"></label>
    <label>Client<input name="client" value="${esc(p.client || "")}"></label><label>Code<input name="code" value="${esc(p.code || "")}"></label>
    <label>Status<select name="status">${STATUSES.filter((s) => s !== "Closed").map((s) => `<option ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    <label>Health<select name="health">${Object.keys(HEALTH).map((h) => `<option ${h === p.health ? "selected" : ""}>${h}</option>`).join("")}</select></label>
    <label>Project manager<select name="manager_id"><option value="">None</option>${staff.map((x) => `<option value="${x.id}" ${x.id === p.manager_id ? "selected" : ""}>${esc(x.display_name)}</option>`).join("")}</select></label>
    <label>Start<input type="date" name="start_date" value="${p.start_date || ""}"></label><label>End<input type="date" name="end_date" value="${p.end_date || ""}"></label>
    <label>Contract value<input type="number" step="any" name="contract_value" value="${p.contract_value ?? ""}"></label><label>Cost budget<input type="number" step="any" name="budget_amount" value="${p.budget_amount ?? ""}"></label>
    <label>Budget hours<input type="number" step="any" name="budget_hours" value="${p.budget_hours ?? ""}"></label>
    <label style="grid-column:1/-1">Description<textarea name="description" rows="3">${esc(p.description || "")}</textarea></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button></div></form>`;
  openDrawer();
  $("#epForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); const num = (k) => (d[k] === "" ? null : +d[k]);
    try { must(await sb.from("projects").update({ name: d.name.trim(), client: d.client || null, code: d.code || null, status: d.status, health: d.health, manager_id: d.manager_id || null,
      start_date: d.start_date || null, end_date: d.end_date || null, contract_value: num("contract_value"), budget_amount: num("budget_amount"), budget_hours: num("budget_hours"), description: d.description || null }).eq("id", p.id));
      closeDrawer(); reload(); } catch (err) { toast(err.message); }
  });
}
async function closeProject(p) {
  const [tasks, ms, agrs, sheets] = await Promise.all([sb.from("project_tasks").select("id").eq("project_id", p.id).neq("status", "Done").then(must),
    sb.from("project_milestones").select("id, done_at").eq("project_id", p.id).then(must),
    sb.from("agreements").select("id, status").eq("project_id", p.id).then(must),
    sb.from("timesheets").select("user_id, status").eq("status", "Submitted").then(must)]);
  const openMs = ms.filter((m) => !m.done_at);
  const liveAgr = agrs.filter((g) => ["Draft", "Out for signature", "Active", "Expired", "Terminated"].includes(g.status));
  const checks = [[tasks.length === 0, `${tasks.length} open task${tasks.length === 1 ? "" : "s"}`, "All tasks done"],
    [openMs.length === 0, `${openMs.length} milestone${openMs.length === 1 ? "" : "s"} not done`, "All milestones done"],
    [liveAgr.length === 0, `${liveAgr.length} agreement${liveAgr.length === 1 ? "" : "s"} not closed out`, "Agreements closed out"],
    [sheets.length === 0, `${sheets.length} timesheet${sheets.length === 1 ? "" : "s"} waiting for approval`, "Timesheets approved"]];
  $("#drawerTitle").textContent = `Close out ${p.name}`;
  $("#drawerBody").innerHTML = `<ul class="checklist">${checks.map(([ok, bad, good]) => `<li class="ck ${ok ? "done" : "due"}"><span>${ok ? "✓ " + good : "! " + bad}</span></li>`).join("")}</ul>
    <p class="muted small">You can still close it with items open; they stay on record. Closing stops new time being logged to it.</p>
    <form id="cpForm"><label>Final status<select name="status"><option>Complete</option><option>Closed</option></select></label>
      <label>Close-out note<textarea name="note" rows="3" placeholder="Outcome, final value, lessons learned, where records are kept"></textarea></label>
      <div class="actions-row"><button class="btn primary">Close out project</button></div></form>`;
  openDrawer();
  $("#cpForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    try { must(await sb.from("projects").update({ status: d.status, close_note: d.note || null, closed_at: new Date().toISOString() }).eq("id", p.id)); toast(`Project ${d.status.toLowerCase()}`); closeDrawer(); reload(); } catch (err) { toast(err.message); }
  });
}

/* ================================================================ my tasks */
async function MyTasks() {
  const rows = await db.rpc("my_tasks", {});
  $("#main").innerHTML = `<div class="page-head"><div><h1>My tasks</h1><p class="muted">Open tasks assigned to you across projects.</p></div></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Task</th><th>Project</th><th>Status</th><th>Priority</th><th>Due</th></tr></thead><tbody>
    ${rows.map((t) => `<tr style="cursor:default"><td><b>${esc(t.title)}</b></td><td>${esc(t.project)}</td><td><select data-ts="${t.id}">${COLS.map((c) => `<option ${c === t.status ? "selected" : ""}>${c}</option>`).join("")}</select></td>
      <td>${esc(t.priority)}</td><td class="date">${t.due ? dueCell(t.due, true) : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">Nothing assigned to you. 🎉</td></tr>`}</tbody></table></div></section>`;
  $$("[data-ts]").forEach((s) => s.addEventListener("change", async () => { try { must(await sb.from("project_tasks").update({ status: s.value }).eq("id", +s.dataset.ts)); toast("Updated"); } catch (e) { toast(e.message); } }));
}

/* ================================================================ router */
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const key = { portfolio: 1, mytasks: 1, new: 1, p: 1 }[parts[0]] ? parts[0] : "portfolio";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === (key === "p" ? "portfolio" : key)));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  const go = key === "p" ? Project(+parts[1], parts[2]) : { portfolio: Portfolio, mytasks: MyTasks, new: New }[key]();
  Promise.resolve(go).catch((e) => ($("#main").innerHTML = /(relation|function) .*(project|my_tasks).* does not exist|schema cache/i.test(e.message)
    ? `<section class="panel"><h2>One-time setup needed</h2><p>Projects needs the latest database update.</p></section>` : `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try {
    if (!(await requireMember())) return;
    if (!isStaff()) $$('#nav a[data-r="new"]').forEach((a) => a.remove());
    showShell(); route();
  } catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
