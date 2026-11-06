/* Pulse · Onboarding — bring on contractors, consultants and new hires with a checklist, then offboard them.
   Uses ../core.js helpers. Staff see everyone; the person being onboarded sees their own checklist once they
   join with the contractor code (matched by email). The database enforces who may change what. */
"use strict";

const OB = { tab: "onboarding", q: "" };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const isAdmin = () => S.profile?.role === "admin";
const isStaff = () => S.profile && S.profile.role !== "contractor";
const nameOf = (id) => S.team.find((p) => p.id === id)?.display_name || "";
const KINDS = ["Contractor", "Consultant", "Employee", "Intern", "Advisor"];
const UNITS = { hour: "/hour", day: "/day", month: "/month", year: "/year", fixed: " fixed" };
const STAGES = ["Planned", "In progress", "Active", "Offboarding", "Offboarded"];
const DEFAULT_CHECKLIST = [
  { id: "agreement", text: "Send the agreement (MSA and SOW, or offer letter)", who: "us" },
  { id: "sign", text: "Sign the agreement", who: "them" },
  { id: "nda", text: "Sign the NDA / confidentiality agreement", who: "them" },
  { id: "tax", text: "Send a W-9 (US) or W-8BEN (outside the US)", who: "them" },
  { id: "payment", text: "Set up payment in the payroll or AP tool", who: "us" },
  { id: "pulse", text: "Invite to Pulse with the contractor code", who: "us" },
  { id: "accounts", text: "Create email and tool accounts", who: "us" },
  { id: "projects", text: "Add to their Timecards projects", who: "us" },
  { id: "equipment", text: "Assign equipment (Tickets → Assets)", who: "us" },
  { id: "handbook", text: "Read the handbook and policies", who: "them" },
  { id: "kickoff", text: "Kickoff meeting with their manager", who: "us" },
];
const OFFBOARD = [
  { id: "off-access", text: "Remove access to email and tools", who: "us", off: true },
  { id: "off-equipment", text: "Collect equipment", who: "us", off: true },
  { id: "off-time", text: "Final timesheet approved", who: "us", off: true },
  { id: "off-invoice", text: "Final invoice paid", who: "us", off: true },
];
const template = () => S.workspace?.config?.onboarding_checklist?.length ? S.workspace.config.onboarding_checklist : DEFAULT_CHECKLIST;
const progress = (o) => { const l = (o.checklist || []).filter((i) => !i.off || o.status.startsWith("Offboard")); return [l.filter((i) => i.done).length, l.length]; };
const newId = () => Math.random().toString(36).slice(2, 9);

/* ================================================================ People */
async function People() {
  if (!isStaff()) return Mine();
  const rows = must(await sb.from("onboardings").select("*").order("start_date", { ascending: true, nullsFirst: false }));
  const groups = { onboarding: ["Planned", "In progress"], active: ["Active"], off: ["Offboarding", "Offboarded"], all: STAGES };
  const q = OB.q.toLowerCase();
  const list = rows.filter((o) => groups[OB.tab].includes(o.status) && (!q || [o.name, o.email, o.firm, o.role_title].join(" ").toLowerCase().includes(q)));
  const n = (k) => rows.filter((o) => groups[k].includes(o.status)).length;
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>People</h1><p class="muted">Contractors, consultants and new hires: paperwork, access and equipment from first day to last.</p></div>
      <div class="actions-row"><button class="btn" id="invite">${icon("send")}Invite instructions</button><button class="btn primary" id="addPerson">${icon("plus")}Add person</button></div></div>
    <div class="filters"><div class="tabs" role="tablist">${[["onboarding", "Onboarding"], ["active", "Active"], ["off", "Offboarding"], ["all", "All"]].map(([k, l]) =>
      `<button role="tab" data-tab="${k}" aria-selected="${OB.tab === k}">${l} <span class="muted">${n(k)}</span></button>`).join("")}</div>
      <input type="search" id="obq" placeholder="Search people…" value="${esc(OB.q)}"></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Firm / role</th><th>Start</th><th>Owner</th><th>Checklist</th><th>Status</th></tr></thead>
      <tbody>${list.map((o) => { const [d, t] = progress(o);
        return `<tr data-ob="${o.id}" tabindex="0"><td><b>${esc(o.name)}</b>${o.email ? `<small class="muted" style="display:block">${esc(o.email)}</small>` : ""}</td><td>${esc(o.kind)}</td>
          <td>${esc([o.firm, o.role_title].filter(Boolean).join(" · "))}</td><td class="date">${o.start_date ? dueCell(o.start_date, o.status === "Planned") : "—"}</td><td>${esc(nameOf(o.owner_id))}</td>
          <td><div class="budget-bar ${d === t && t ? "" : ""}"><i style="width:${t ? Math.round(100 * d / t) : 0}%"></i></div><small>${d} of ${t}</small></td>
          <td>${pill(o.status === "Active" ? "Active" : o.status === "Offboarded" ? "Dropped" : o.status === "Planned" ? "Identified" : "Pursuing").replace(/>[^<]+</, `>${o.status}<`)}</td></tr>`; }).join("")
        || `<tr><td colspan="7" class="empty">Nobody here yet. Add a contractor or consultant to start their checklist.</td></tr>`}</tbody></table></div></section>`;
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { OB.tab = b.dataset.tab; People(); }));
  $("#obq").addEventListener("input", (e) => { OB.q = e.target.value; clearTimeout(OB.t); OB.t = setTimeout(() => { People().then(() => { const i = $("#obq"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); });
  $("#addPerson").addEventListener("click", () => editPerson(null));
  $("#invite").addEventListener("click", () => inviteBox(null));
  $$("[data-ob]").forEach((r) => r.addEventListener("click", () => openPerson(+r.dataset.ob)));
}

async function editPerson(o) {
  const owners = S.team.filter((p) => p.active && p.role !== "contractor");
  $("#drawerTitle").textContent = o ? `Edit ${o.name}` : "Add person";
  $("#drawerBody").innerHTML = `<form id="obForm" class="form-grid">
    <label>Name<input name="name" required value="${esc(o?.name || "")}"></label>
    <label>Email <small class="muted">(links their Pulse login when they join)</small><input name="email" type="email" value="${esc(o?.email || "")}"></label>
    <label>Type<select name="kind">${KINDS.map((k) => `<option ${k === (o?.kind || "Contractor") ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Their firm<input name="firm" value="${esc(o?.firm || "")}" placeholder="If they work through a company"></label>
    <label>Role / scope<input name="role_title" value="${esc(o?.role_title || "")}" placeholder="e.g. GIS analyst, 20 h/week"></label>
    <label>Phone<input name="phone" value="${esc(o?.phone || "")}"></label>
    <label>Start date<input name="start_date" type="date" value="${o?.start_date || ""}"></label>
    <label>End date <small class="muted">(optional)</small><input name="end_date" type="date" value="${o?.end_date || ""}"></label>
    <label>Rate (USD)<input name="rate" type="number" min="0" step="0.01" value="${o?.rate ?? ""}"></label>
    <label>Per<select name="rate_unit">${Object.entries(UNITS).map(([k, v]) => `<option value="${k}" ${k === (o?.rate_unit || "hour") ? "selected" : ""}>${v.replace("/", "").trim()}</option>`).join("")}</select></label>
    <label>Owner<select name="owner_id">${owners.map((p) => `<option value="${p.id}" ${p.id === (o?.owner_id || S.user.id) ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label>
    <label style="grid-column:1/-1">Notes<textarea name="notes" rows="3">${esc(o?.notes || "")}</textarea></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">${o ? "Save" : "Add and start checklist"}</button>${o && isAdmin() ? `<button type="button" class="btn danger" id="obDel">Delete</button>` : ""}</div></form>`;
  openDrawer();
  $("#obForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const row = Object.fromEntries(["name", "email", "kind", "firm", "role_title", "phone", "start_date", "end_date", "rate_unit", "owner_id", "notes"].map((k) => [k, (f.get(k) || "").trim() || null]));
    row.rate = f.get("rate") === "" ? null : +f.get("rate");
    try {
      if (o) { must(await sb.from("onboardings").update(row).eq("id", o.id)); toast("Saved"); openPerson(o.id); }
      else {
        row.checklist = template().map((i) => ({ ...i, id: i.id || newId(), done: false }));
        const r = must(await sb.from("onboardings").insert(row).select("*").single());
        // already in Pulse? link them now
        const p = row.email && S.team.find((m) => (m.email || "").toLowerCase() === row.email.toLowerCase());
        if (p) must(await sb.from("onboardings").update({ user_id: p.id, status: "In progress" }).eq("id", r.id));
        toast(`${row.name} added`); openPerson(r.id);
      }
      People();
    } catch (err) { toast(/ux_onb_email/.test(err.message) ? "Someone with that email is already being onboarded." : err.message); }
  });
  $("#obDel")?.addEventListener("click", async () => {
    if (!confirm(`Delete ${o.name}'s onboarding record? Their Pulse login (if any) isn't affected.`)) return;
    try { must(await sb.from("onboardings").delete().eq("id", o.id)); closeDrawer(); People(); toast("Deleted"); } catch (err) { toast(err.message); }
  });
}

async function openPerson(id) {
  const o = must(await sb.from("onboardings").select("*").eq("id", id).single());
  const canEdit = isAdmin() || o.owner_id === S.user.id, mine = o.user_id === S.user.id;
  const projects = isStaff() && o.user_id ? must(await sb.from("project_people").select("project_id").eq("user_id", o.user_id)) : [];
  const allProj = isStaff() ? must(await sb.from("projects").select("id, name, status").order("name")) : [];
  const [d, t] = progress(o);
  const show = (o.checklist || []).filter((i) => !i.off || o.status.startsWith("Offboard"));
  const item = (i) => `<li class="ck ${i.done ? "done" : ""}"><label class="check"><input type="checkbox" data-item="${esc(i.id)}" ${i.done ? "checked" : ""}
      ${canEdit || (mine && i.who === "them") ? "" : "disabled"}> <span>${esc(i.text)}${i.link ? ` · <a href="${esc(i.link)}" target="_blank" rel="noopener">link</a>` : ""}</span></label>
      <span class="meta">${i.who === "them" ? `<span class="pill s-high">${mine ? "You" : "Them"}</span>` : ""}${i.done ? ` ${esc(i.done_by || "")} ${i.done_at ? short(i.done_at) : ""}` : ""}</span></li>`;
  const next = { Planned: "In progress", "In progress": "Active", Active: "Offboarding", Offboarding: "Offboarded" }[o.status];
  $("#drawerTitle").textContent = o.name;
  $("#drawerBody").innerHTML = `
    <div class="ob-facts">${[["Type", esc(o.kind)], ["Firm / role", esc([o.firm, o.role_title].filter(Boolean).join(" · ") || "—")], ["Email", esc(o.email || "—")],
      ["Dates", o.start_date ? `${short(o.start_date)}${o.end_date ? " – " + short(o.end_date) : ""}` : "—"], ["Rate", o.rate != null ? money(o.rate) + (UNITS[o.rate_unit] || "") : "—"],
      ["Owner", esc(nameOf(o.owner_id) || "—")], ["Pulse login", o.user_id ? `${esc(nameOf(o.user_id))} ${pill("Active")}` : `<span class="muted">Not joined yet</span>`],
      ["Status", pill(o.status === "Active" ? "Active" : "Pursuing").replace(/>[^<]+</, `>${o.status}<`)]].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>
    ${o.notes ? `<p class="muted" style="white-space:pre-wrap">${esc(o.notes)}</p>` : ""}
    <h3 class="ck-h">Checklist <small class="muted">${d} of ${t} done</small></h3>
    <ul class="checklist">${show.filter((i) => !i.off).map(item).join("")}</ul>
    ${o.status.startsWith("Offboard") ? `<h3 class="ck-h">Offboarding</h3><ul class="checklist">${show.filter((i) => i.off).map(item).join("")}</ul>` : ""}
    ${canEdit ? `<div class="add-action" style="grid-template-columns:1fr auto auto;margin:8px 0 16px"><input id="ckText" placeholder="Add a checklist item" aria-label="New item">
      <select id="ckWho" aria-label="Who does it"><option value="us">We do it</option><option value="them">They do it</option></select><button class="btn small" id="ckAdd">Add</button></div>` : ""}
    ${isStaff() && o.user_id ? `<h3 class="ck-h">Timecards projects</h3><div class="chips">${allProj.filter((p) => p.status !== "Closed").map((p) =>
        `<label class="chip-check"><input type="checkbox" data-proj="${p.id}" ${projects.some((x) => x.project_id === p.id) ? "checked" : ""} ${isAdmin() ? "" : "disabled"}> ${esc(p.name)}</label>`).join("") || `<span class="muted">No projects yet. Add them in <a href="../timecards/#/projects">Timecards</a>.</span>`}</div>` : ""}
    ${canEdit ? `<div class="actions-row" style="margin-top:18px">
        ${next ? `<button class="btn primary" id="obNext">${next === "Offboarding" ? "Start offboarding" : next === "Offboarded" ? "Finish offboarding" : next === "Active" ? "Mark active" : "Start onboarding"}</button>` : ""}
        ${!o.user_id && o.status !== "Offboarded" ? `<button class="btn" id="obInvite">${icon("send")}Invite to Pulse</button>` : ""}
        <button class="btn" id="obEdit">Edit</button></div>` : ""}`;
  openDrawer();
  $$("[data-item]").forEach((c) => c.addEventListener("change", async () => {
    try { await db.rpc("onb_tick", { p_id: o.id, p_item: c.dataset.item, p_done: c.checked }); c.closest("li").classList.toggle("done", c.checked); if (isStaff()) People(); }
    catch (e) { c.checked = !c.checked; toast(e.message); }
  }));
  $("#ckAdd")?.addEventListener("click", async () => {
    const text = $("#ckText").value.trim(); if (!text) return;
    const list = [...(o.checklist || []), { id: newId(), text, who: $("#ckWho").value, done: false, off: o.status.startsWith("Offboard") || undefined }];
    try { must(await sb.from("onboardings").update({ checklist: list }).eq("id", o.id)); openPerson(o.id); } catch (e) { toast(e.message); }
  });
  $$("[data-proj]").forEach((c) => c.addEventListener("change", async () => {
    try {
      if (c.checked) must(await sb.from("project_people").insert({ project_id: +c.dataset.proj, user_id: o.user_id }));
      else must(await sb.from("project_people").delete().eq("project_id", +c.dataset.proj).eq("user_id", o.user_id));
      toast(c.checked ? "Added to project" : "Removed from project");
    } catch (e) { c.checked = !c.checked; toast(e.message); }
  }));
  $("#obEdit")?.addEventListener("click", () => editPerson(o));
  $("#obInvite")?.addEventListener("click", () => inviteBox(o));
  $("#obNext")?.addEventListener("click", async () => {
    const patch = { status: next };
    if (next === "Offboarding" && !(o.checklist || []).some((i) => i.off)) patch.checklist = [...(o.checklist || []), ...OFFBOARD.map((i) => ({ ...i, done: false }))];
    if (next === "Offboarded") {
      if (!confirm(`Finish offboarding ${o.name}?${o.user_id ? " Their Pulse login is turned off and they're removed from their projects." : ""}`)) return;
      if (o.user_id && isAdmin()) {
        try {
          await db.rpc("set_member", { p_id: o.user_id, p_role: S.team.find((p) => p.id === o.user_id)?.role || "contractor", p_active: false });
          for (const p of projects) must(await sb.from("project_people").delete().eq("project_id", p.project_id).eq("user_id", o.user_id));
        } catch (e) { return toast(e.message); }
      }
    }
    try { must(await sb.from("onboardings").update(patch).eq("id", o.id)); toast(`${o.name}: ${next}`); openPerson(o.id); People(); } catch (e) { toast(e.message); }
  });
}

// What to send someone so they can join: the site, the contractor code, and what they'll see
async function inviteBox(o) {
  let code = "";
  try { code = isAdmin() ? await db.rpc("get_contractor_code") : ""; } catch { code = ""; }
  const site = location.origin + location.pathname.replace(/onboarding\/?(index\.html)?$/, "");
  const body = `Hi ${o ? o.name.split(" ")[0] : "there"},\n\nWelcome to ${S.workspace.name}! We use Pulse for timesheets, requests and onboarding.\n\n1. Open ${site}\n2. Choose "Join with code" and enter: ${code || "(ask an admin for the contractor code)"}\n3. Use ${o?.email ? "this email address (" + o.email + ")" : "your work email"} so your onboarding checklist shows up.\n\nYou'll see your checklist, the projects you log time to, and can raise requests for equipment or access.\n\nThanks,\n${firstName()}`;
  $("#drawerTitle").textContent = o ? `Invite ${o.name}` : "Invite contractors and consultants";
  $("#drawerBody").innerHTML = `
    <p class="muted">Contractors and consultants join with the <b>contractor code</b>. They only see Timecards (their own projects), their onboarding checklist, Tickets and the Scheduler: never your contacts, pipeline or funding.</p>
    ${isAdmin() ? `<div class="code-box"><b id="ccode">${esc(code)}</b><button class="btn" id="copyCode">Copy code</button><button class="btn" id="newCcode">Change</button></div>` : `<p>Ask an admin for the contractor code.</p>`}
    <label style="margin-top:14px">Message<textarea id="invBody" rows="12">${esc(body)}</textarea></label>
    <div class="actions-row" style="margin-top:10px"><button class="btn" id="copyMsg">Copy message</button>
      <a class="btn primary" href="mailto:${encodeURIComponent(o?.email || "")}?subject=${encodeURIComponent("Join " + S.workspace.name + " on Pulse")}&body=${encodeURIComponent(body)}" id="mailIt">${icon("send")}Open in email</a></div>`;
  openDrawer();
  $("#copyCode")?.addEventListener("click", async () => { await navigator.clipboard.writeText(code); toast("Code copied"); });
  $("#copyMsg").addEventListener("click", async () => { await navigator.clipboard.writeText($("#invBody").value); toast("Message copied"); });
  $("#invBody").addEventListener("input", () => { $("#mailIt").href = `mailto:${encodeURIComponent(o?.email || "")}?subject=${encodeURIComponent("Join " + S.workspace.name + " on Pulse")}&body=${encodeURIComponent($("#invBody").value)}`; });
  $("#newCcode")?.addEventListener("click", async () => {
    if (!confirm("Make a new contractor code? The old one stops working for new sign-ups.")) return;
    try { await db.rpc("rotate_company_code", { p_code: null, p_kind: "contractor" }); inviteBox(o); } catch (e) { toast(e.message); }
  });
}

/* ================================================================ My checklist */
async function Mine() {
  const mine = must(await sb.from("onboardings").select("*").eq("user_id", S.user.id));
  $("#main").innerHTML = `<div class="page-head"><div><h1>My checklist</h1><p class="muted">What's left to get you set up at ${esc(S.workspace.name)}.</p></div></div>
    ${mine.length ? mine.map((o) => { const [d, t] = progress(o); return `<section class="panel"><h2>${esc(o.role_title || o.kind)} <small>${d} of ${t} done</small></h2>
      <ul class="checklist">${(o.checklist || []).filter((i) => !i.off || o.status.startsWith("Offboard")).map((i) => `<li class="ck ${i.done ? "done" : ""}"><label class="check">
        <input type="checkbox" data-o="${o.id}" data-item="${esc(i.id)}" ${i.done ? "checked" : ""} ${i.who === "them" ? "" : "disabled"}> <span>${esc(i.text)}</span></label>
        <span class="meta">${i.who === "them" ? `<span class="pill s-high">You</span>` : `<span class="muted">${esc(S.workspace.name)}</span>`}</span></li>`).join("")}</ul></section>`; }).join("")
      : `<div class="empty">No onboarding checklist for you${isStaff() ? "." : " yet. Your contact may have used a different email: ask them to check it."}</div>`}`;
  $$("[data-item]").forEach((c) => c.addEventListener("change", async () => {
    try { await db.rpc("onb_tick", { p_id: +c.dataset.o, p_item: c.dataset.item, p_done: c.checked }); c.closest("li").classList.toggle("done", c.checked); toast(c.checked ? "Done" : "Unticked"); }
    catch (e) { c.checked = !c.checked; toast(e.message); }
  }));
}

/* ================================================================ Checklist template (admins) */
async function Template() {
  if (!isAdmin()) return Mine();
  await loadWorkspace();
  const list = template();
  const row = (i) => `<div class="tpl-row"><input data-t="text" value="${esc(i.text)}" aria-label="Item"><select data-t="who" aria-label="Who"><option value="us" ${i.who !== "them" ? "selected" : ""}>We do it</option><option value="them" ${i.who === "them" ? "selected" : ""}>They do it</option></select>
    <input data-t="link" value="${esc(i.link || "")}" placeholder="Link (optional, https://…)" aria-label="Link"><input type="hidden" data-t="id" value="${esc(i.id || newId())}"><button class="btn small" type="button" data-rm>Remove</button></div>`;
  $("#main").innerHTML = `<div class="page-head"><div><h1>Checklist template</h1><p class="muted">New people start with this list. Changing it doesn't change checklists already started.</p></div>
      <div class="actions-row"><button class="btn primary" id="tplSave">Save template</button></div></div>
    <section class="panel"><div id="tpl">${list.map(row).join("")}</div><button class="btn small" id="tplAdd" type="button">Add item</button>
      <button class="btn small" id="tplReset" type="button">Use the default list</button></section>`;
  $("#tplAdd").addEventListener("click", () => $("#tpl").insertAdjacentHTML("beforeend", row({ text: "", who: "us" })));
  $("#tpl").addEventListener("click", (e) => e.target.closest("[data-rm]")?.closest(".tpl-row").remove());
  $("#tplReset").addEventListener("click", () => ($("#tpl").innerHTML = DEFAULT_CHECKLIST.map(row).join("")));
  $("#tplSave").addEventListener("click", async () => {
    const items = $$(".tpl-row").map((r) => Object.fromEntries($$("[data-t]", r).map((i) => [i.dataset.t, i.value.trim()]))).filter((i) => i.text)
      .map((i) => ({ id: i.id, text: i.text, who: i.who, ...(i.link ? { link: i.link } : {}) }));
    if (items.some((i) => i.link && !/^https:\/\//i.test(i.link))) return toast("Links must start with https://");
    try { await db.rpc("update_workspace", { p: { config: { ...(S.workspace.config || {}), onboarding_checklist: items } } }); await loadWorkspace(); toast("Template saved"); }
    catch (e) { toast(e.message); }
  });
}

/* ================================================================ router */
const routes = { people: People, mine: Mine, template: Template };
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [name] = location.hash.replace(/^#\/?/, "").split("/");
  const key = routes[name] ? name : isStaff() ? "people" : "mine";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve(routes[key]()).catch((e) => ($("#main").innerHTML = /onboardings|onb_|schema cache|does not exist/i.test(e.message)
    ? `<section class="panel"><h2>One-time setup needed</h2><p>Onboarding needs the latest database update.</p></section>` : `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try {
    if (!(await requireMember())) return;
    if (!isStaff()) $$('#nav a[data-r="people"], #nav a[data-r="template"]').forEach((a) => a.remove());
    else if (!isAdmin()) $$('#nav a[data-r="template"]').forEach((a) => a.remove());
    showShell(); route();
  } catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
