/* Pulse · Assign work — give someone a task, a milestone or a role on a project, from anywhere.
   Used by Projects (portfolio, a project page, My work) and Tickets ("Make it a project task").
   openAssign({ kind: "task" | "milestone" | "project", project_id, title, description, ticket_id, assignee, onDone }) */
"use strict";

async function openAssign(o = {}) {
  const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
  let projects = [];
  try {
    projects = must(await sb.from("projects").select("id, name, client, status, manager_id, approver_id, limited").in("status", ["Active", "Planned", "Paused"]).order("name"));
  } catch (e) { toast(e.message); return; }
  const team = S.team.filter((p) => p.active).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const roleTag = (p) => ({ admin: "admin", member: "member", employee: "employee", contractor: "contractor" }[p.role] || p.role);
  const st = { kind: o.kind || "task", project: o.project_id ? +o.project_id : projects[0]?.id || null, ms: [], tasks: [] };
  $("#drawerTitle").textContent = "Assign work";
  $("#drawerBody").innerHTML = `
    ${o.ticket_id ? `<p class="muted" style="margin-top:0">This request becomes a task on a project. Its timeline will say where the work went.</p>` : ""}
    <div class="seg as-kind" role="group" aria-label="What to assign">
      ${[["task", "Task", "check"], ["milestone", "Milestone", "calendar"], ["project", "Project role", "briefcase"]].map(([k, l, i]) => `<button type="button" data-k="${k}" aria-pressed="${st.kind === k}" ${o.ticket_id && k !== "task" ? "hidden" : ""}>${ic(i)}${l}</button>`).join("")}
    </div>
    <form class="form" id="asForm" style="margin-top:14px">
      <label class="full">Assign to<select name="assignee" required><option value="">Pick a person</option>
        ${team.map((p) => `<option value="${p.id}" ${p.id === o.assignee ? "selected" : ""}>${esc(p.display_name)} · ${roleTag(p)}</option>`).join("")}</select></label>
      <label class="full">Project<select name="project_id" required>${projects.length ? projects.map((p) => `<option value="${p.id}" ${p.id === st.project ? "selected" : ""}>${esc(p.name)}${p.client ? " · " + esc(p.client) : ""}${p.status !== "Active" ? " (" + p.status.toLowerCase() + ")" : ""}</option>`).join("") : `<option value="">No open projects</option>`}</select></label>
      <div id="asFields" class="full form" style="padding:0"></div>
    </form>
    <p class="muted small" id="asNote"></p>
    <div class="form-foot"><button class="btn primary" id="asGo">Assign</button><button class="btn" data-close>Cancel</button></div>`;
  openDrawer();
  const f = $("#asForm");
  const loadProject = async () => {
    st.project = +f.project_id.value || null; st.ms = []; st.tasks = [];
    if (st.project) {
      [st.ms, st.tasks] = await Promise.all([
        sb.from("project_milestones").select("id, name, due_date, owner_id, done_at").eq("project_id", st.project).order("sort").then((r) => r.data || []),
        sb.from("project_tasks").select("id, title, assignee_id, status").eq("project_id", st.project).neq("status", "Done").order("sort").then((r) => r.data || []),
      ]);
    }
    paint();
  };
  const msOpts = (blank) => `<option value="">${blank}</option>${st.ms.filter((m) => !m.done_at).map((m) => `<option value="${m.id}">${esc(m.name)}${m.due_date ? " · due " + short(m.due_date) : ""}${m.owner_id ? " · " + esc(S.team.find((p) => p.id === m.owner_id)?.display_name || "") : ""}</option>`).join("")}`;
  const paint = () => {
    $$(".as-kind button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.k === st.kind));
    const box = $("#asFields");
    if (st.kind === "task") box.innerHTML = `
      ${st.tasks.length && !o.ticket_id ? `<label class="full">Task<select name="task_id"><option value="">A new task</option>${st.tasks.map((t) => `<option value="${t.id}">Reassign: ${esc(t.title)}${t.assignee_id ? " (" + esc(S.team.find((p) => p.id === t.assignee_id)?.display_name || "") + ")" : " (unassigned)"}</option>`).join("")}</select></label>` : ""}
      <label class="full as-new">Title<input name="title" maxlength="200" value="${esc(o.title || "")}" placeholder="e.g. Delineate drainage areas for outfalls 1–20"></label>
      <label class="full">Milestone <small class="muted">(optional)</small><select name="milestone_id">${msOpts("No milestone")}</select></label>
      <label class="as-new">Due<input type="date" name="due_date"></label>
      <label class="as-new">Priority<select name="priority"><option>Low</option><option selected>Normal</option><option>High</option><option>Urgent</option></select></label>
      <label class="as-new">Estimate (hours)<input name="estimate_hours" type="number" min="0" step="0.5"></label>
      <label class="full as-new">Details<textarea name="description" rows="3">${esc(o.description || "")}</textarea></label>`;
    if (st.kind === "milestone") box.innerHTML = `
      ${st.ms.some((m) => !m.done_at) ? `<label class="full">Milestone<select name="milestone_id">${msOpts("A new milestone")}</select></label>` : ""}
      <label class="full as-new">Name<input name="name" maxlength="200" placeholder="e.g. Draft floodplain screening report"></label>
      <label class="as-new">Start<input type="date" name="start_date"></label><label class="as-new">Due<input type="date" name="due_date"></label>
      <label class="check full as-new"><input type="checkbox" name="deliverable"> It's a deliverable to the client</label>`;
    if (st.kind === "project") {
      const p = projects.find((x) => x.id === st.project), nm = (id) => S.team.find((x) => x.id === id)?.display_name;
      box.innerHTML = `<fieldset class="full as-roles"><legend>Role</legend>
        <label class="check"><input type="radio" name="role" value="manager" checked> Project manager <small class="muted">${p?.manager_id ? "now " + esc(nm(p.manager_id) || "") : "none yet"}</small></label>
        <label class="check"><input type="radio" name="role" value="approver"> Approves timesheets and expenses <small class="muted">${p?.approver_id ? "now " + esc(nm(p.approver_id) || "") : "none yet"}</small></label>
        <label class="check"><input type="radio" name="role" value="member"> Team member <small class="muted">can see the project and log time to it</small></label></fieldset>`;
    }
    const syncNew = () => {
      const existing = (st.kind === "task" && f.task_id?.value) || (st.kind === "milestone" && f.milestone_id?.value);
      $$(".as-new", box).forEach((el) => (el.hidden = !!existing));
      if (f.title) f.title.required = st.kind === "task" && !existing; if (f.name) f.name.required = st.kind === "milestone" && !existing;
    };
    box.querySelectorAll("select").forEach((s) => s.addEventListener("change", syncNew)); syncNew();
    note();
  };
  const note = () => {
    const who = team.find((p) => p.id === f.assignee.value), p = projects.find((x) => x.id === st.project);
    $("#asNote").textContent = who && p && !["admin", "member"].includes(who.role) ? `${who.display_name.split(" ")[0]} will be added to ${p.name} so they can see it.` : "";
    $("#asGo").disabled = !projects.length;
  };
  $$(".as-kind button").forEach((b) => b.addEventListener("click", () => { st.kind = b.dataset.k; paint(); }));
  f.project_id.addEventListener("change", loadProject);
  f.assignee.addEventListener("change", note);
  await loadProject();
  $("#asGo").addEventListener("click", async (e) => {
    if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f)); d.kind = st.kind; d.deliverable = !!f.deliverable?.checked; if (o.ticket_id) d.ticket_id = o.ticket_id;
    e.target.disabled = true;
    try {
      const r = await db.rpc("pm_assign", { p: d });
      toast(st.kind === "project" ? `${r.who} is now ${{ manager: "the project manager", approver: "the approver", member: "on the team" }[r.role]}` : `${st.kind === "task" ? "Task" : "Milestone"} assigned to ${r.who}`);
      closeDrawer(); o.onDone && o.onDone(r);
    } catch (err) { toast(err.message); e.target.disabled = false; }
  });
}
