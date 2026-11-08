/* Pulse · People → Org chart (everyone sees it; admins build it) and Devices (admins).
   The chart is made of positions, not people: a position has a title, a department, who it reports to and who holds it.
   Empty positions show as Open and can link to a Hiring opening; the database (org_chart) works out each holder from
   the member, the person being onboarded, or whoever was hired for the opening, so the chart keeps itself current. */
"use strict";
const ORG = { data: null };
const DEPT_COLORS = ["#2563eb", "#0d9488", "#7c3aed", "#d97706", "#db2777", "#16a34a", "#475569", "#dc2626"];
// suggested starting structures for small businesses; every title and department can be changed after
const ORG_TEMPLATES = [
  { key: "csuite", name: "Startup with a leadership team", blurb: "CEO with CFO, CTO and CSO; each department led by a head under one of them.",
    top: "Chief Executive Officer", officers: [["cfo", "Chief Financial Officer", 1], ["cto", "Chief Technology Officer", 1], ["cso", "Chief Science Officer", 1], ["coo", "Chief Operating Officer", 0], ["cmo", "Chief Marketing Officer", 0]],
    depts: [["Technology", "cto"], ["Operations", "cso"], ["General & Administrative", "cfo"]] },
  { key: "consulting", name: "Consulting or engineering firm", blurb: "Principal-led firm: delivery, business development, and finance and admin.",
    top: "Principal / CEO", officers: [["coo", "Chief Operating Officer", 1], ["cfo", "Chief Financial Officer", 0], ["tech", "Technical Director", 1]],
    depts: [["Project Delivery", "coo"], ["Technical Services", "tech"], ["Business Development", "ceo"], ["Finance & Administration", "coo"]] },
  { key: "govcon", name: "Government contractor", blurb: "Programs, capture and proposals, contracts and compliance, finance and admin.",
    top: "President / CEO", officers: [["coo", "Chief Operating Officer", 1], ["cfo", "Chief Financial Officer", 1], ["bd", "VP, Business Development", 1]],
    depts: [["Programs", "coo"], ["Capture & Proposals", "bd"], ["Contracts & Compliance", "cfo"], ["Finance & Administration", "cfo"]] },
  { key: "software", name: "Software or tech startup", blurb: "Engineering, product, sales and marketing, and operations.",
    top: "Chief Executive Officer", officers: [["cto", "Chief Technology Officer", 1], ["coo", "Chief Operating Officer", 1], ["cmo", "Chief Marketing Officer", 0], ["cpo", "Head of Product", 1]],
    depts: [["Engineering", "cto"], ["Product", "cpo"], ["Sales & Marketing", "ceo"], ["Operations", "coo"]] },
  { key: "owner", name: "Owner-led small business", blurb: "An owner with an operations manager and an office manager.",
    top: "Owner / President", officers: [["ops", "Operations Manager", 1], ["office", "Office Manager", 1], ["sales", "Sales Manager", 0]],
    depts: [["Operations", "ops"], ["Sales & Customer Service", "ceo"], ["Administration", "office"]] },
  { key: "field", name: "Field services or construction", blurb: "Field crews, safety (EHS), estimating, and the office.",
    top: "Owner / President", officers: [["ops", "Operations Manager", 1], ["safety", "Safety (EHS) Manager", 1], ["office", "Office Manager", 1]],
    depts: [["Field Operations", "ops"], ["Estimating & Projects", "ops"], ["Safety & Compliance", "safety"], ["Administration", "office"]] },
  { key: "nonprofit", name: "Nonprofit", blurb: "Board, executive director, programs, development and finance.",
    top: "Executive Director", board: true, officers: [["prog", "Director of Programs", 1], ["dev", "Director of Development", 1], ["fin", "Finance & Operations Manager", 1]],
    depts: [["Programs", "prog"], ["Development & Communications", "dev"], ["Finance & Operations", "fin"]] },
];

async function OrgChart() {
  let d;
  try { d = await db.rpc("org_chart", {}); } catch (e) { if (/org_chart|schema cache|does not exist/i.test(e.message)) { $("#main").innerHTML = `<section class="panel"><h2>Not set up yet</h2><p class="muted">The org chart needs a database update (fix_20261108e_org_devices.sql).</p></section>`; return; } throw e; }
  ORG.data = d;
  const P = d.positions, kids = (id) => P.filter((p) => p.reports_to === id);
  const roots = P.filter((p) => !p.reports_to || !P.some((x) => x.id === p.reports_to));
  const dept = (id) => d.departments.find((x) => x.id === id);
  const open = P.filter((p) => !p.holder).length;
  const node = (p) => { const dp = dept(p.department_id), c = kids(p.id);
    return `<li><div class="org-node ${p.holder ? "" : "open"} ${isAI(p) ? "ai" : !["Staff", "Intern"].includes(kindOf(p)) ? "dotted" : ""}" data-pos="${p.id}" ${isAdmin() ? 'draggable="true" tabindex="0"' : ""} style="--dc:${esc(dp?.color || "#94a3b8")}">
      ${isAI(p) ? `<span class="org-ai">${icon("sparkles")}AI</span>` : ""}<span class="org-dept">${esc(dp?.name || "")}</span><b>${esc(p.title)}</b>
      <span class="org-who">${p.holder ? esc(p.holder) : p.opening ? `Open · <a href="#/candidates" data-stop>hiring</a>` : "Open"}</span>
      ${!["Staff", "AI"].includes(kindOf(p)) ? `<small class="org-kind">${esc(kindOf(p))}</small>` : ""}</div>${c.length ? `<ul>${c.map(node).join("")}</ul>` : ""}</li>`; };
  $("#main").innerHTML = `
    <div class="page-head no-print"><div><h1>Org chart</h1><p class="muted">${P.length ? `${P.length} positions${open ? `, ${open} open` : ""}. ${isAdmin() ? "Click a box to edit it, or drag it onto another box to change who it reports to." : ""}` : isAdmin() ? `Build ${esc(S.workspace.name)}'s structure: start from a template, then rename and add positions.` : "Your admin hasn't set up the org chart yet."}</p></div>
      <div class="actions-row">${isAdmin() ? `${P.length ? "" : `<button class="btn primary" id="orgTpl">${icon("sparkles")}Start from a template</button>`}<button class="btn" id="orgDepts">Departments</button><button class="btn" id="orgAddAi">${icon("sparkles")}Add AI agent</button><button class="btn ${P.length ? "primary" : ""}" id="orgAdd">${icon("plus")}Add position</button>` : ""}${P.length ? `<button class="btn" onclick="window.print()">Print</button>` : ""}</div></div>
    ${d.departments.length ? `<div class="org-legend">${d.departments.map((x) => `<span><i style="background:${esc(x.color || "#94a3b8")}"></i>${esc(x.name)}</span>`).join("")}<span><i class="dash"></i>Contractor, consultant, advisor or board</span><span><i class="aisw"></i>AI agent</span></div>` : ""}
    ${P.length ? `<div class="org-wrap"><ul class="org-tree">${roots.map(node).join("")}</ul></div>` : isAdmin() ? `<section class="panel empty">No positions yet.</section>` : ""}`;
  if (!isAdmin()) return;
  $("#orgTpl")?.addEventListener("click", orgTemplate);
  $("#orgDepts").addEventListener("click", orgDepartments);
  $("#orgAdd").addEventListener("click", () => orgEdit({ reports_to: roots[0]?.id || null }));
  $("#orgAddAi").addEventListener("click", () => orgEdit({ reports_to: roots[0]?.id || null, kind: "AI" }));
  $$(".org-node").forEach((n) => {
    n.addEventListener("click", (e) => { if (e.target.closest("[data-stop]")) return; orgEdit(P.find((p) => p.id === +n.dataset.pos)); });
    n.addEventListener("keydown", (e) => { if (e.key === "Enter") orgEdit(P.find((p) => p.id === +n.dataset.pos)); });
    n.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", n.dataset.pos); n.classList.add("dragging"); });
    n.addEventListener("dragend", () => n.classList.remove("dragging"));
    n.addEventListener("dragover", (e) => { e.preventDefault(); n.classList.add("drop"); });
    n.addEventListener("dragleave", () => n.classList.remove("drop"));
    n.addEventListener("drop", async (e) => {
      e.preventDefault(); n.classList.remove("drop");
      const id = +e.dataTransfer.getData("text/plain"), to = +n.dataset.pos; if (!id || id === to) return;
      try { must(await sb.from("org_positions").update({ reports_to: to, updated_by: S.profile.display_name }).eq("id", id)); toast("Moved"); OrgChart(); } catch (err) { toast(err.message); }
    });
  });
}

function orgTemplate() {
  $("#drawerTitle").textContent = "Start from a template";
  $("#drawerBody").innerHTML = `<p class="muted">Pick the structure closest to yours. Then tick the leaders you have, rename anything, and list your departments; each department gets a head who reports to the leader you choose. Everything can be changed afterwards.</p>
    <div class="lib-list" id="tplPick">${ORG_TEMPLATES.map((t, i) => `<label class="lib-item"><input type="radio" name="tpl" value="${t.key}" ${i ? "" : "checked"}><span><b>${esc(t.name)}</b><small>${esc(t.blurb)}</small></span></label>`).join("")}</div>
    <form id="tplForm"></form>`;
  openDrawer();
  const draw = (t) => {
    $("#tplForm").innerHTML = `<h3 class="ck-h">Leadership</h3><div class="org-tpl"><label class="check"><input type="checkbox" checked disabled> <input value="${esc(t.top)}" data-ceo></label>
      ${t.officers.map(([k, title, on]) => `<label class="check"><input type="checkbox" data-off="${k}" ${on ? "checked" : ""}> <input value="${esc(title)}" data-offt="${k}"></label>`).join("")}
      ${t.board ? `<label class="check"><input type="checkbox" data-board checked> Board of directors above the ${esc(t.top)}</label>` : ""}</div>
      <h3 class="ck-h">Departments</h3><div id="tplDepts"></div><button class="btn small" type="button" id="tplAddDept">${icon("plus")}Add department</button>
      <div class="actions-row" style="margin-top:16px"><button class="btn primary">Create org chart</button></div>`;
    const officers = () => [["ceo", $("[data-ceo]").value], ...t.officers.filter(([k]) => $(`[data-off=${k}]`).checked).map(([k]) => [k, $(`[data-offt=${k}]`).value])];
    const row = (name, to) => `<div class="tpl-dept"><input value="${esc(name)}" placeholder="Department name, e.g. Water" data-dn><select data-dr data-want="${to || "ceo"}"></select><button class="icon-btn" type="button" data-rm aria-label="Remove">✕</button></div>`;
    const fill = () => $$(".tpl-dept").forEach((r) => { const sel = $("[data-dr]", r), want = sel.value || sel.dataset.want, offs = officers();
      sel.innerHTML = offs.map(([k, ti]) => `<option value="${k}" ${k === (offs.some(([x]) => x === want) ? want : "ceo") ? "selected" : ""}>reports to ${esc(ti)}</option>`).join(""); });
    $("#tplDepts").innerHTML = t.depts.map(([n, to]) => row(n, to)).join(""); fill();
    $("#tplForm").onchange = (e) => { if (e.target.matches("[data-off]")) fill(); };
    $("#tplForm").oninput = (e) => { if (e.target.matches("[data-offt],[data-ceo]")) fill(); };
    $("#tplDepts").onclick = (e) => { if (e.target.closest("[data-rm]")) e.target.closest(".tpl-dept").remove(); };
    $("#tplAddDept").onclick = () => { $("#tplDepts").insertAdjacentHTML("beforeend", row("", "ceo")); fill(); };
    $("#tplForm").onsubmit = async (e) => {
      e.preventDefault();
      const offs = officers(), depts = $$(".tpl-dept").map((r) => ({ name: $("[data-dn]", r).value.trim(), to: $("[data-dr]", r).value })).filter((x) => x.name), by = S.profile.display_name;
      try {
        const dIns = must(await sb.from("org_departments").insert([{ name: "Leadership", color: "#0f3a5f", sort: 0 }, ...depts.map((x, i) => ({ name: x.name, color: DEPT_COLORS[i % DEPT_COLORS.length], sort: i + 1 }))]).select("id, name"));
        const lead = dIns.find((x) => x.name === "Leadership").id;
        let board = null;
        if (t.board && $("[data-board]")?.checked) [board] = must(await sb.from("org_positions").insert({ title: "Board of Directors", kind: "Board", department_id: lead, sort: 0, updated_by: by }).select("id"));
        const [top] = must(await sb.from("org_positions").insert({ title: offs[0][1], department_id: lead, reports_to: board?.id || null, user_id: S.user.id, sort: 0, updated_by: by }).select("id"));
        const offRows = offs.length > 1 ? must(await sb.from("org_positions").insert(offs.slice(1).map(([k, ti], i) => ({ title: ti, department_id: lead, reports_to: top.id, sort: i + 1, notes: "tpl:" + k, updated_by: by }))).select("id, notes")) : [];
        const offId = (k) => offRows.find((r) => r.notes === "tpl:" + k)?.id || top.id;
        if (depts.length) must(await sb.from("org_positions").insert(depts.map((x, i) => ({ title: `Head of ${x.name}`, department_id: dIns.find((r) => r.name === x.name)?.id, reports_to: offId(x.to), sort: i, updated_by: by }))));
        if (offRows.length) await sb.from("org_positions").update({ notes: null }).in("id", offRows.map((r) => r.id));
        closeDrawer(); toast("Org chart created. Click a box to put someone in it"); OrgChart();
      } catch (err) { toast(err.message); }
    };
  };
  draw(ORG_TEMPLATES[0]);
  $("#tplPick").addEventListener("change", (e) => draw(ORG_TEMPLATES.find((t) => t.key === e.target.value)));
}

// Position types. Databases without fix_20261108j only allow Staff/Contractor/Advisor/Board, so the newer types are saved as the
// nearest older one with "[AI]", "[Consultant]" or "[Intern]" at the start of the notes; fix j converts them.
const ORG_KINDS = ["Staff", "Intern", "Contractor", "Consultant", "Advisor", "Board"];
const NEW_KINDS = { AI: "Staff", Consultant: "Contractor", Intern: "Staff" };
const KIND_MARK = /^\[(AI|Consultant|Intern)\]\s*/;
const kindOf = (p) => KIND_MARK.exec(p.notes || "")?.[1] || p.kind || "Staff";
const isAI = (p) => kindOf(p) === "AI";
const plainNotes = (p) => (p.notes || "").replace(KIND_MARK, "");

async function orgEdit(p) {
  const d = ORG.data, P = d.positions;
  const below = new Set(); const walk = (id) => P.filter((x) => x.reports_to === id).forEach((x) => { below.add(x.id); walk(x.id); }); if (p.id) walk(p.id);
  const [obs, ops] = await Promise.all([sb.from("onboardings").select("id, name, user_id, status, role_title").neq("status", "Offboarded").then((r) => r.data || []),
    hasApp("hiring") ? sb.from("hire_openings").select("id, title, status").in("status", ["Draft", "Open", "On hold"]).then((r) => r.data || []) : Promise.resolve([])]);
  const ai0 = isAI(p);
  const holderVal = p.user_id ? "u:" + p.user_id : p.onboarding_id ? "o:" + p.onboarding_id : p.holder_name ? "n:" : "";
  $("#drawerTitle").textContent = p.id ? "Edit position" : "Add position";
  $("#drawerBody").innerHTML = `<form class="form-grid pos-form ${ai0 ? "is-ai" : ""}" id="posForm">
    <label class="pos-ai-toggle" style="grid-column:1/-1"><input type="checkbox" name="ai" ${ai0 ? "checked" : ""}><span class="org-ai">${icon("sparkles")}AI</span><span>This position is an AI agent</span></label>
    <label style="grid-column:1/-1">Title *<input name="title" required value="${esc(p.title || "")}" placeholder="Head of Water Programs"></label>
    <label class="ai-only" style="grid-column:1/-1">Which AI or agent<input name="ai_name" value="${esc(ai0 ? p.holder_name || "" : "")}" placeholder="e.g. Claude, Pulse Chief of Staff"></label>
    <label>Department<select name="department_id"><option value="">—</option>${d.departments.map((x) => `<option value="${x.id}" ${x.id === p.department_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    <label>Reports to<select name="reports_to"><option value="">No one (top of the chart)</option>${P.filter((x) => x.id !== p.id && !below.has(x.id)).map((x) => `<option value="${x.id}" ${x.id === p.reports_to ? "selected" : ""}>${esc(x.title)}${x.holder ? " · " + esc(x.holder) : ""}</option>`).join("")}</select></label>
    <label class="person-only">Type<select name="kind">${ORG_KINDS.map((k) => `<option ${k === (ai0 ? "Staff" : kindOf(p)) ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label class="person-only">Held by<select name="holder"><option value="">Open (nobody yet)</option>
      <optgroup label="Team">${S.team.filter((u) => u.active).map((u) => `<option value="u:${u.id}" ${holderVal === "u:" + u.id ? "selected" : ""}>${esc(u.display_name)}</option>`).join("")}</optgroup>
      ${obs.filter((o) => !o.user_id).length ? `<optgroup label="Being onboarded">${obs.filter((o) => !o.user_id).map((o) => `<option value="o:${o.id}" ${holderVal === "o:" + o.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</optgroup>` : ""}
      <option value="n:" ${holderVal === "n:" && !ai0 ? "selected" : ""}>Someone without a Pulse login…</option></select></label>
    <label class="person-only" id="hnWrap" ${holderVal === "n:" && !ai0 ? "" : "hidden"}>Their name<input name="holder_name" value="${esc(ai0 ? "" : p.holder_name || "")}"></label>
    ${ops.length || p.opening_id ? `<label class="person-only">Hiring for it<select name="opening_id"><option value="">—</option>${ops.map((o) => `<option value="${o.id}" ${o.id === p.opening_id ? "selected" : ""}>${esc(o.title)} (${esc(o.status)})</option>`).join("")}${p.opening && !ops.some((o) => o.id === p.opening_id) ? `<option value="${p.opening_id}" selected>${esc(p.opening.title)} (${esc(p.opening.status)})</option>` : ""}</select></label>` : ""}
    <label style="grid-column:1/-1">Notes<textarea name="notes" rows="2">${esc(plainNotes(p))}</textarea></label>
    <p class="muted small person-only" style="grid-column:1/-1">Link a Hiring opening and the person you hire fills this position automatically. Offboarding someone sets their position back to Open.</p>
    <div class="actions-row" style="grid-column:1/-1">${p.id ? `<button class="btn danger" type="button" id="posDel">Delete</button><button class="btn" type="button" id="posSub">${icon("plus")}Add a position under this</button>` : ""}<button class="btn primary">Save</button></div></form>`;
  openDrawer();
  const f = $("#posForm");
  f.holder.addEventListener("change", () => ($("#hnWrap").hidden = f.holder.value !== "n:"));
  f.ai.addEventListener("change", () => { f.classList.toggle("is-ai", f.ai.checked); if (f.ai.checked) f.ai_name.focus(); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ai = f.ai.checked, h = ai ? "" : f.holder.value, notes = f.notes.value.trim() || null;
    const row = { title: f.title.value.trim(), department_id: f.department_id.value || null, reports_to: f.reports_to.value || null, kind: ai ? "AI" : f.kind.value,
      user_id: h.startsWith("u:") ? h.slice(2) : null, onboarding_id: h.startsWith("o:") ? +h.slice(2) : null,
      holder_name: ai ? f.ai_name.value.trim() || null : h === "n:" ? f.holder_name.value.trim() || null : null,
      opening_id: ai ? null : f.opening_id ? f.opening_id.value || null : p.opening_id || null, notes, updated_by: S.profile.display_name, updated_at: new Date().toISOString() };
    const save = (r) => p.id ? sb.from("org_positions").update(r).eq("id", p.id) : sb.from("org_positions").insert(r);
    try {
      let res = await save(row);
      // database not updated yet for the newer types: save as the nearest older type, marked in the notes
      if (res.error && NEW_KINDS[row.kind] && /kind_check|check constraint/i.test(res.error.message)) res = await save({ ...row, kind: NEW_KINDS[row.kind], notes: `[${row.kind}]` + (notes ? " " + notes : "") });
      must(res); closeDrawer(); toast("Saved"); OrgChart();
    } catch (err) { toast(err.message); }
  });
  $("#posSub")?.addEventListener("click", () => orgEdit({ reports_to: p.id, department_id: p.department_id }));
  $("#posDel")?.addEventListener("click", async () => {
    const n = P.filter((x) => x.reports_to === p.id).length;
    if (!confirm(`Delete "${p.title}"?${n ? ` The ${n} position${n === 1 ? "" : "s"} under it will report to ${p.reports_to ? "its manager" : "no one"}.` : ""}`)) return;
    try { if (n) must(await sb.from("org_positions").update({ reports_to: p.reports_to || null }).eq("reports_to", p.id)); must(await sb.from("org_positions").delete().eq("id", p.id)); closeDrawer(); OrgChart(); } catch (err) { toast(err.message); }
  });
}

function orgDepartments() {
  const d = ORG.data;
  $("#drawerTitle").textContent = "Departments";
  $("#drawerBody").innerHTML = `<p class="muted">Your company's departments or verticals. Each has a color on the chart.</p>
    <div id="dlist">${d.departments.map((x) => `<div class="tpl-dept" data-id="${x.id}"><input type="color" value="${esc(x.color || "#94a3b8")}" data-c aria-label="Color"><input value="${esc(x.name)}" data-n aria-label="Name"><button class="icon-btn" type="button" data-rm aria-label="Delete">✕</button></div>`).join("")}</div>
    <div class="tpl-dept"><input type="color" value="${DEPT_COLORS[d.departments.length % DEPT_COLORS.length]}" id="ndc" aria-label="Color"><input id="ndn" placeholder="New department, e.g. Water"><button class="btn small" type="button" id="ndAdd">Add</button></div>
    <div class="actions-row" style="margin-top:14px"><button class="btn primary" id="dSave" type="button">Save</button></div>`;
  openDrawer();
  $("#ndAdd").addEventListener("click", async () => { const n = $("#ndn").value.trim(); if (!n) return;
    try { must(await sb.from("org_departments").insert({ name: n, color: $("#ndc").value, sort: d.departments.length + 1 })); ORG.data = await db.rpc("org_chart", {}); orgDepartments(); OrgChart(); } catch (e) { toast(e.message); } });
  $("#dlist").addEventListener("click", async (e) => { const r = e.target.closest("[data-rm]")?.closest("[data-id]"); if (!r) return;
    if (!confirm("Delete this department? Its positions stay, without a department.")) return;
    try { must(await sb.from("org_departments").delete().eq("id", +r.dataset.id)); ORG.data = await db.rpc("org_chart", {}); orgDepartments(); OrgChart(); } catch (err) { toast(err.message); } });
  $("#dSave").addEventListener("click", async () => {
    try { for (const r of $$("#dlist [data-id]")) must(await sb.from("org_departments").update({ name: $("[data-n]", r).value.trim() || "Department", color: $("[data-c]", r).value }).eq("id", +r.dataset.id));
      closeDrawer(); toast("Saved"); OrgChart(); } catch (e) { toast(e.message); }
  });
}

/* ================================================================ devices */
const holderName = (a, obs) => a.assigned_to ? nameOf(a.assigned_to) || "Former member" : obs.find((o) => o.id === a.onboarding_id)?.name || "";
async function Devices() {
  const [assets, obs] = await Promise.all([sb.from("assets").select("*").order("assigned_since", { ascending: true }).then(must), sb.from("onboardings").select("id, name, user_id, status").then(must)]);
  const out = assets.filter((a) => a.status === "In use" && (a.assigned_to || a.onboarding_id));
  const gone = (a) => (a.assigned_to && S.team.find((u) => u.id === a.assigned_to)?.active === false) || obs.some((o) => (o.id === a.onboarding_id || (a.assigned_to && o.user_id === a.assigned_to)) && o.status.startsWith("Offboard"));
  const collect = out.filter(gone), unconfirmed = out.filter((a) => !a.ack_at);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Devices</h1><p class="muted">Equipment issued to employees and contractors. Issue and collect devices from each person in Team &amp; onboarding; the full register is in <a href="../tickets/#/assets">Tickets → Assets</a>.</p></div></div>
    <div class="snap-tiles inv-tiles"><div class="snap-tile"><b>${out.length}</b><span>Issued</span></div><div class="snap-tile ${unconfirmed.length ? "warn" : ""}"><b>${unconfirmed.length}</b><span>Receipt not confirmed</span></div><div class="snap-tile ${collect.length ? "warn" : ""}"><b>${collect.length}</b><span>To collect from people who left</span></div></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Device</th><th>Serial</th><th>With</th><th>Since</th><th>Receipt</th><th></th></tr></thead>
      <tbody>${out.map((a) => `<tr><td><b>${esc(a.name)}</b><small class="muted" style="display:block">${esc([a.tag, a.category, a.make_model].filter(Boolean).join(" · "))}</small></td><td>${esc(a.serial || "")}</td>
        <td>${esc(holderName(a, obs))}${gone(a) ? ' <span class="so-no">Left — collect</span>' : ""}</td><td class="date">${a.assigned_since ? short(a.assigned_since) : "—"}</td>
        <td>${a.ack_at ? `<span class="so-ok">${icon("check")} ${short(a.ack_at)}</span>` : '<span class="muted">Not yet</span>'}</td>
        <td><button class="btn small" data-ret="${a.id}">Returned</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">No devices issued.</td></tr>`}</tbody></table></div></section>`;
  $$("[data-ret]").forEach((b) => b.addEventListener("click", async () => { try { await returnDevice(+b.dataset.ret); Devices(); } catch (e) { toast(e.message); } }));
}
async function returnDevice(id, status = "Available") {
  must(await sb.from("assets").update({ status, assigned_to: null, onboarding_id: null, assigned_since: null, updated_by: S.profile.display_name, updated_at: new Date().toISOString() }).eq("id", id));
  toast(status === "Lost" ? "Marked lost" : "Checked back in");
}
// the Devices section of a person's onboarding drawer (admins)
async function personDevices(o) {
  if (!isAdmin()) return "";
  let q = sb.from("assets").select("*").eq("status", "In use");
  q = o.user_id ? q.or(`onboarding_id.eq.${o.id},assigned_to.eq.${o.user_id}`) : q.eq("onboarding_id", o.id);
  const [mine, avail] = await Promise.all([q.then((r) => r.data || []), sb.from("assets").select("id, name, tag, serial, category").eq("status", "Available").order("name").then((r) => r.data || [])]);
  return { mine, html: `<h3 class="ck-h">Devices <small class="muted">${mine.length} issued</small></h3>
    <ul class="checklist">${mine.map((a) => `<li class="ck"><span><b>${esc(a.name)}</b>${a.serial ? ` · S/N ${esc(a.serial)}` : ""} <small class="muted">${a.ack_at ? `received ${short(a.ack_at)}` : "receipt not confirmed"}</small></span>
      <span class="meta"><button class="btn small" data-dret="${a.id}">Returned</button> <button class="btn small" data-dlost="${a.id}">Lost</button></span></li>`).join("") || `<li class="muted small" style="padding:4px 10px">None.</li>`}</ul>
    ${o.status !== "Offboarded" ? `<div class="add-action" style="grid-template-columns:1fr auto;margin:6px 0 14px"><select id="devPick" aria-label="Device to issue"><option value="">Issue a device…</option>${avail.map((a) => `<option value="${a.id}">${esc(a.name)}${a.tag ? " (" + esc(a.tag) + ")" : ""}${a.serial ? " · " + esc(a.serial) : ""}</option>`).join("")}<option value="new">+ A new device not in the register</option></select><button class="btn small" id="devIssue" type="button">Issue</button></div>` : ""}` };
}
function wirePersonDevices(o, reopen) {
  $$("[data-dret],[data-dlost]").forEach((b) => b.addEventListener("click", async () => { try { await returnDevice(+(b.dataset.dret || b.dataset.dlost), b.dataset.dlost ? "Lost" : "Available"); reopen(); } catch (e) { toast(e.message); } }));
  $("#devIssue")?.addEventListener("click", async () => {
    const v = $("#devPick").value; if (!v) return toast("Pick a device");
    const base = { status: "In use", assigned_to: o.user_id || null, onboarding_id: o.id, assigned_since: today(), updated_by: S.profile.display_name };
    try {
      if (v === "new") {
        const name = prompt("Device name (e.g. MacBook Air 13\")"); if (!name) return; const serial = prompt("Serial number (optional)") || null;
        must(await sb.from("assets").insert({ ...base, name, serial, category: /phone/i.test(name) ? "Phone" : /monitor/i.test(name) ? "Monitor" : "Laptop" }));
      } else must(await sb.from("assets").update(base).eq("id", +v));
      toast("Issued. They'll be asked to confirm they received it"); reopen();
    } catch (e) { toast(e.message); }
  });
}
// devices issued to me, to confirm (shown in My checklist)
async function myDevicesHtml() {
  const mine = await sb.from("assets").select("id, name, serial, tag, ack_at, assigned_since").eq("status", "In use").then((r) => r.data || []).catch(() => []);
  if (!mine.length) return "";
  const todo = mine.filter((a) => !a.ack_at);
  return `<section class="panel"><h2>Devices issued to you</h2><ul class="checklist">${mine.map((a) => `<li class="ck ${a.ack_at ? "done" : ""}"><span><b>${esc(a.name)}</b>${a.serial ? ` · S/N ${esc(a.serial)}` : ""}${a.tag ? ` · ${esc(a.tag)}` : ""}</span>
    <span class="meta">${a.ack_at ? `Confirmed ${short(a.ack_at)}` : `<label class="check"><input type="checkbox" class="dev-pick" value="${a.id}"> I received it</label>`}</span></li>`).join("")}</ul>
    ${todo.length ? `<div class="row certify-row"><input id="devName" value="${esc(S.profile.display_name)}" aria-label="Your full name"><button class="btn primary" id="devAck">Confirm receipt</button></div><p class="muted small">You're responsible for company devices and return them when you leave.</p>` : ""}</section>`;
}
function wireMyDevices(after) {
  $("#devAck")?.addEventListener("click", async () => {
    const ids = $$(".dev-pick:checked").map((c) => +c.value); if (!ids.length) return toast("Tick the devices you received");
    try { for (const id of ids) await db.rpc("asset_ack", { p_id: id, p_name: $("#devName").value }); toast("Thanks, confirmed"); after(); } catch (e) { toast(e.message); }
  });
}

/* ---------------- placing people and openings on the org chart (used by Openings, Hire and Team & onboarding) */
async function orgPositions() { try { return (await db.rpc("org_chart", {})).positions; } catch { return null; } }
// a <select> of open positions plus "new position reporting to …"; `cur` = the position this person/opening is in now
function orgPicker(P, cur, label = "Place on the org chart") {
  if (!P) return "";
  const lbl = (x) => `${esc(x.title)}${x.holder ? " · " + esc(x.holder) : ""}`;
  return `<label style="grid-column:1/-1">${label} <small class="muted">(People → Org chart)</small><select name="orgpos">
    <option value="">${cur ? "Keep: " + lbl(cur) : P.length ? "Not on the org chart yet" : "No org chart yet: build it in People → Org chart"}</option>
    ${P.filter((x) => !x.holder && x.id !== cur?.id).length ? `<optgroup label="Open positions">${P.filter((x) => !x.holder && x.id !== cur?.id).map((x) => `<option value="p:${x.id}">${esc(x.title)}</option>`).join("")}</optgroup>` : ""}
    ${P.length ? `<optgroup label="New position, reporting to">${P.map((x) => `<option value="n:${x.id}">${lbl(x)}</option>`).join("")}</optgroup>` : ""}</select></label>`;
}
const orgPick = (v) => !v ? null : v.startsWith("p:") ? { position: +v.slice(2), parent: null } : { position: null, parent: +v.slice(2) };
