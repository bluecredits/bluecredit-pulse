/* Pulse · Tickets — My requests, My approvals, My assets.
   Loaded after ../core.js; uses its helpers ($, esc, db, sb, S, toast, pill, short, ago, money, openDrawer…)
   at call time. Every change to a request goes through the desk_* database functions, which enforce
   who may do what; this file only decides which buttons to show. */
"use strict";

const DESK_TYPES = [
  { type: "IT support", icon: "wrench", blurb: "Something isn't working: email, VPN, software, printer.", asset: "optional", title: "What's not working?" },
  { type: "New equipment", icon: "computer", blurb: "A laptop, phone, monitor or other gear you need.", approval: true, ref: "What do you need?", needed: true, title: "e.g. Laptop for the new analyst" },
  { type: "Purchase or expense", icon: "banknotes", blurb: "Get approval before buying something. To get paid back for something you already bought, use Expenses in Timecards.", approval: true, amount: "Amount (USD)", ref: "Vendor", needed: true, title: "e.g. Design software annual license" },
  { type: "Time off", icon: "sun", blurb: "Vacation, a sick day or personal leave.", approval: true, dates: true, title: "e.g. Thanksgiving week" },
  { type: "Travel", icon: "globe", blurb: "Client visits, conferences or site work.", approval: true, dates: true, amount: "Estimated cost (USD)", ref: "Destination", title: "e.g. Industry conference, Chicago" },
  { type: "Access or account", icon: "key", blurb: "Access to a system, shared drive or tool.", approval: true, ref: "System or account", needed: true, title: "e.g. Access to the shared finance drive" },
  { type: "Asset problem", icon: "alert", blurb: "Something is wrong with equipment assigned to you.", asset: "required", title: "e.g. Screen flickers" },
  { type: "Return an asset", icon: "return", blurb: "Hand back equipment you no longer need.", asset: "required", title: "e.g. Returning old phone" },
  { type: "Other", icon: "chat", blurb: "Anything else. Pick an approver if it needs sign-off.", optionalApproval: true, title: "What do you need?" },
];
const DESK_TYPE = Object.fromEntries(DESK_TYPES.map((t) => [t.type, t]));
const DESK_OPEN = ["Pending approval", "Open", "Approved", "In progress"];
const DESK_CLOSED = ["Done", "Rejected", "Cancelled"];
const DESK_WORK = ["Open", "Approved", "In progress"];
const ASSET_CATEGORIES = ["Laptop", "Desktop", "Monitor", "Phone", "Tablet", "Software license", "Vehicle", "Field equipment", "Furniture", "Other"];
const ASSET_STATUSES = ["In use", "Available", "In repair", "Lost", "Retired"];
const ASSET_ICON = { Laptop: "computer", Desktop: "computer", Monitor: "computer", Phone: "phone", Tablet: "phone", Vehicle: "truck", "Software license": "key" };
const DESK = { reqTab: "mine", reqFilter: "open", apprTab: "waiting", assetTab: "mine", assetQ: "", assetStatus: "", counts: null };

const ticketNo = (id) => "REQ-" + String(id).padStart(4, "0");
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const me = () => S.user?.id;
const isAdmin = () => S.profile?.role === "admin";
const person = (id) => S.team.find((p) => p.id === id);
const personName = (id, fallback = "—") => (id ? person(id)?.display_name || "Former member" : fallback);
const dateRange = (a, b) => !a ? "" : !b || a === b ? short(a) : `${short(a)} – ${short(b)}`;
const days = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 864e5) + 1 : a ? 1 : 0);
function deskMissing(err) {
  return /tickets|assets|desk_|schema cache|does not exist|could not find/i.test(err?.message || "");
}
function deskSetupNotice() {
  return `<section class="panel"><h2>One-time setup needed</h2>
    <p>The service desk needs a database update before it can be used.${isAdmin() ? ` In Supabase, open the SQL Editor, paste the latest <code>supabase/schema.sql</code> from the repo and click Run. It's safe to run again; it only adds what's missing.` : " Ask an admin to run the Pulse database update."}</p></section>`;
}

/* ---------------- sidebar badges */
async function refreshDeskBadges() {
  try { DESK.counts = await db.rpc("desk_counts", {}); } catch { DESK.counts = null; }
  const c = DESK.counts || {};
  const set = (id, n) => { const b = $("#" + id); if (!b) return; b.hidden = !n; b.textContent = n > 99 ? "99+" : n || ""; };
  set("nb-approvals", c.approvals); set("nb-requests", (c.my_open || 0) + (c.to_work || 0));
  return c;
}

/* ---------------- shared bits */
function tabs(list, current, attr) {
  return `<div class="tabs" role="tablist">${list.map(([v, l]) => `<button role="tab" ${attr}="${v}" aria-selected="${v === current}">${l}</button>`).join("")}</div>`;
}
function deskFacts(t) {
  const cfg = DESK_TYPE[t.type] || {};
  const rows = [];
  if (t.amount != null) rows.push([cfg.amount || "Amount", money(t.amount)]);
  if (t.start_date) rows.push(["Dates", `${dateRange(t.start_date, t.end_date)} · ${days(t.start_date, t.end_date || t.start_date)} day${days(t.start_date, t.end_date || t.start_date) === 1 ? "" : "s"}`]);
  if (t.reference) rows.push([cfg.ref || "Reference", esc(t.reference)]);
  if (t.needed_by) rows.push(["Needed by", dueCell(t.needed_by, DESK_OPEN.includes(t.status))]);
  if (t.asset_label) rows.push(["Asset", esc(t.asset_label)]);
  return rows;
}

/* ================================================================ My requests */
async function DeskRequests() {
  const c = await refreshDeskBadges();
  const showWork = isAdmin() || (c && c.to_work > 0);
  const tabList = [["mine", "Mine"]].concat(showWork ? [["work", `To work on${c?.to_work ? ` <span class="tab-n">${c.to_work}</span>` : ""}`]] : [])
    .concat(isAdmin() ? [["all", "Everyone's"]] : []);
  if (!tabList.some(([v]) => v === DESK.reqTab)) DESK.reqTab = "mine";
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>My requests</h1>
      <p class="muted">Ask for equipment, purchases, time off, travel, access or IT help, and follow it to done.</p></div>
      <div class="actions-row"><button class="btn primary" id="newReq">${icon("plus")}New request</button></div></div>
    <div class="filters">${tabList.length > 1 ? tabs(tabList, DESK.reqTab, "data-rt") : ""}
      ${DESK.reqTab === "work" ? "" : `<select id="reqFilter" aria-label="Show"><option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option></select>`}
      <span class="count" id="reqCount"></span></div>
    <div id="reqList"></div>`;
  if ($("#reqFilter")) $("#reqFilter").value = DESK.reqFilter;
  $("#newReq").addEventListener("click", () => openNewRequest());
  $$("[data-rt]").forEach((b) => b.addEventListener("click", () => { DESK.reqTab = b.dataset.rt; DeskRequests(); }));
  $("#reqFilter")?.addEventListener("change", (e) => { DESK.reqFilter = e.target.value; loadRequests(); });
  await loadRequests();
}
async function loadRequests() {
  const tab = DESK.reqTab;
  let q = sb.from("tickets").select("*");
  if (tab === "mine") q = q.eq("requester_id", me());
  if (tab === "work") q = isAdmin() ? q.in("status", DESK_WORK) : q.eq("assignee_id", me()).in("status", DESK_WORK);
  if (tab !== "work" && DESK.reqFilter !== "all") q = q.in("status", DESK.reqFilter === "open" ? DESK_OPEN : DESK_CLOSED);
  let rows;
  try { rows = must(await q.order("updated_at", { ascending: false }).limit(500)); }
  catch (e) { $("#reqList").innerHTML = deskMissing(e) ? deskSetupNotice() : `<div class="empty">${esc(e.message)}</div>`; return; }
  if (tab === "work" && isAdmin()) rows = rows.filter((t) => !t.assignee_id || t.assignee_id === me()).concat(rows.filter((t) => t.assignee_id && t.assignee_id !== me()));
  $("#reqCount").textContent = `${rows.length} request${rows.length === 1 ? "" : "s"}`;
  const who = tab !== "mine";
  $("#reqList").innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Request</th><th>Type</th>${who ? "<th>Requested by</th>" : ""}<th>Status</th>
      <th>${tab === "work" ? "Assigned to" : "Approver"}</th><th>Updated</th></tr></thead><tbody>
    ${rows.map((t) => `<tr data-ticket="${t.id}" tabindex="0"><td class="wrap"><span class="tno">${ticketNo(t.number ?? t.id)}</span><span class="clip" style="font-weight:600">${esc(t.title)}</span></td>
      <td><span class="type-chip">${icon(DESK_TYPE[t.type]?.icon || "chat", "ic sm")}${esc(t.type)}</span></td>
      ${who ? `<td>${esc(personName(t.requester_id))}</td>` : ""}<td>${pill(t.status)}${t.priority === "High" || t.priority === "Urgent" ? ` <span class="pill s-high">${t.priority}</span>` : ""}</td>
      <td>${esc(tab === "work" ? personName(t.assignee_id, "Unassigned") : t.approver_id ? personName(t.approver_id) : "No approval needed")}</td>
      <td class="date">${ago(t.updated_at)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="panel empty">${tab === "mine" ? (DESK.reqFilter === "closed" ? "No closed requests yet." : `Nothing open. Use <b>New request</b> when you need something.`) : tab === "work" ? "Nothing waiting to be worked on." : "No requests match."}</div>`;
  wireTicketRows($("#reqList"), loadRequests);
}
function wireTicketRows(root, onChange) {
  root.addEventListener("click", (e) => { const r = e.target.closest("[data-ticket]"); if (r && !e.target.closest("button")) openTicket(+r.dataset.ticket, onChange); });
  root.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.ticket) openTicket(+e.target.dataset.ticket, onChange); });
}

/* ---------------- new request */
async function openNewRequest(preset = {}) {
  $("#drawerTitle").textContent = "New request";
  if (!preset.type) {
    $("#drawerBody").innerHTML = `<p class="muted" style="margin-top:0">What do you need?</p>
      <div class="type-grid">${DESK_TYPES.map((t) => `<button class="type-card" data-type="${esc(t.type)}">${icon(t.icon)}<b>${esc(t.type)}</b><span>${esc(t.blurb)}</span>
        ${t.approval ? `<em>Needs approval</em>` : ""}</button>`).join("")}</div>`;
    openDrawer();
    $$("[data-type]").forEach((b) => b.addEventListener("click", () => openNewRequest({ ...preset, type: b.dataset.type })));
    return;
  }
  const cfg = DESK_TYPE[preset.type];
  let myAssets = [];
  if (cfg.asset) { try { myAssets = must(await sb.from("assets").select("*").eq("assigned_to", me()).order("name")); } catch (e) { if (deskMissing(e)) { $("#drawerBody").innerHTML = deskSetupNotice(); openDrawer(); return; } } }
  const approvers = approverOptions();
  const needsAppr = cfg.approval;
  $("#drawerBody").innerHTML = `
    <button class="link" id="backTypes" style="margin-bottom:12px">← All request types</button>
    <div class="type-head">${icon(cfg.icon)}<div><b>${esc(cfg.type)}</b><span class="muted">${esc(cfg.blurb)}</span></div></div>
    <form class="form" id="reqForm" style="margin-top:16px">
      <label class="full">Title<input name="title" required placeholder="${esc(cfg.title)}" maxlength="140"></label>
      ${cfg.asset ? `<label class="full">Asset${cfg.asset === "optional" ? " (optional)" : ""}<select name="asset_id" ${cfg.asset === "required" ? "required" : ""}>
        <option value="">${myAssets.length ? (cfg.asset === "optional" ? "Not about a specific asset" : "Pick one") : "No equipment is assigned to you"}</option>
        ${myAssets.map((a) => `<option value="${a.id}" ${String(preset.asset_id) === String(a.id) ? "selected" : ""}>${esc([a.tag, a.name].filter(Boolean).join(" · "))}</option>`).join("")}</select></label>` : ""}
      ${cfg.dates ? `<label>Start date<input type="date" name="start_date" required></label><label>End date<input type="date" name="end_date"></label>` : ""}
      ${cfg.amount ? `<label>${esc(cfg.amount)}<input name="amount" inputmode="decimal" placeholder="0.00" ${cfg.type === "Purchase or expense" ? "required" : ""}></label>` : ""}
      ${cfg.ref ? `<label${cfg.amount ? "" : ' class="full"'}>${esc(cfg.ref)}<input name="reference"></label>` : ""}
      ${cfg.needed ? `<label>Needed by<input type="date" name="needed_by"></label>` : ""}
      <label>Priority<select name="priority"><option>Low</option><option selected>Normal</option><option>High</option><option>Urgent</option></select></label>
      ${needsAppr || cfg.optionalApproval ? `<label class="${cfg.needed ? "" : ""}">Approver<select name="approver_id">
        ${cfg.optionalApproval ? `<option value="">No approval needed</option>` : ""}
        ${approvers.map((p, i) => `<option value="${p.id}" ${needsAppr && i === 0 ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>` : ""}
      <label class="full">Details<textarea name="description" rows="5" placeholder="Anything that helps: why you need it, links, quotes, the error message…"></textarea></label>
    </form>
    ${needsAppr && !approvers.length ? `<p class="error">There's no one to approve this yet. Ask an admin to join Pulse first.</p>` : ""}
    <div class="form-foot"><button class="btn primary" id="sendReq" ${needsAppr && !approvers.length ? "disabled" : ""}>${needsAppr ? "Send for approval" : "Submit request"}</button>
      <button class="btn" data-close>Cancel</button></div>`;
  openDrawer();
  $("#backTypes").addEventListener("click", () => openNewRequest({}));
  setTimeout(() => $("#reqForm [name=title]")?.focus(), 60);
  $("#sendReq").addEventListener("click", async (e) => {
    const f = $("#reqForm");
    if (!f.reportValidity()) return;
    const data = Object.fromEntries(new FormData(f));
    e.target.disabled = true;
    try {
      const id = await db.rpc("desk_submit", { p: { ...data, type: cfg.type } });
      const appr = data.approver_id ? personName(data.approver_id) : "";
      toast(appr ? `Request sent to ${appr.split(" ")[0]} for approval` : `Request submitted`);
      await refreshDeskBadges();
      const onReq = !location.hash || location.hash.startsWith("#/requests");
      if (onReq) { DESK.reqTab = "mine"; await DeskRequests(); } else location.hash = "#/requests";
      setTimeout(() => openTicket(id, loadRequests), onReq ? 0 : 350);
    } catch (err) { toast(err.message); e.target.disabled = false; }
  });
}
function approverOptions() {
  const active = S.team.filter((p) => p.active);
  const otherAdmins = active.filter((p) => p.role === "admin" && p.id !== me());
  const list = [...otherAdmins, ...active.filter((p) => p.role !== "admin" && p.id !== me())]
    .map((p) => ({ id: p.id, label: p.display_name + (p.role === "admin" ? " (admin)" : "") }));
  if (isAdmin() && !otherAdmins.length) list.unshift({ id: me(), label: "Myself (no other admin yet)" });
  return list;
}

/* ---------------- request detail */
async function openTicket(id, onChange) {
  let t, events;
  try {
    t = must(await sb.from("tickets").select("*").eq("id", id).single());
    events = must(await sb.from("ticket_events").select("*").eq("ticket_id", id).order("ts", { ascending: true }));
  } catch (e) { return toast(deskMissing(e) ? "The service desk needs its one-time database update." : e.message); }
  const cfg = DESK_TYPE[t.type] || { icon: "chat" };
  const mineReq = t.requester_id === me(), approver = t.approver_id === me();
  const worker = isAdmin() || t.assignee_id === me();
  const closed = DESK_CLOSED.includes(t.status);
  const canEdit = (mineReq || isAdmin()) && ["Pending approval", "Open"].includes(t.status);
  const done = async (msg) => { toast(msg); await refreshDeskBadges(); onChange && onChange(); openTicket(id, onChange); };
  const run = async (btn, fn, msg) => { btn.disabled = true; try { await fn(); await done(msg); } catch (err) { toast(err.message); btn.disabled = false; } };

  const facts = [["Requested by", esc(personName(t.requester_id))],
    ["Approver", t.approver_id ? esc(personName(t.approver_id)) : `<span class="muted">No approval needed</span>`],
    ["Assigned to", t.assignee_id ? esc(personName(t.assignee_id)) : `<span class="muted">${isAdmin() ? "Unassigned (admins)" : "The admin team"}</span>`],
    ...deskFacts(t), ["Submitted", `${short(t.created_at.slice(0, 10))} · ${ago(t.created_at)}`]];
  $("#drawerTitle").textContent = ticketNo(t.number ?? t.id);
  $("#drawerBody").innerHTML = `
    <div class="ticket-head">${icon(cfg.icon)}<div><h3 class="ticket-title">${esc(t.title)}</h3>
      <div class="ticket-pills">${pill(t.status)} <span class="type-chip">${esc(t.type)}</span>${t.priority !== "Normal" ? ` <span class="pill ${["High", "Urgent"].includes(t.priority) ? "s-high" : ""}">${esc(t.priority)}</span>` : ""}</div></div></div>
    ${t.status === "Rejected" && t.decision_note ? `<div class="callout bad"><b>Not approved.</b> ${esc(t.decision_note)}</div>` : ""}
    ${t.status === "Pending approval" ? `<div class="callout">${approver ? "This is waiting for <b>your</b> decision." : `Waiting for ${esc(personName(t.approver_id))} to approve.`}</div>` : ""}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${t.description ? `<div class="ticket-desc">${esc(t.description)}</div>` : ""}
    <div id="tActions" class="ticket-actions"></div>
    <section class="history"><h3>Timeline</h3><ol class="tl">${events.map(eventLi).join("")}</ol>
      <div class="comment-box"><textarea id="tComment" rows="2" placeholder="Add a comment or an update…"></textarea><button class="btn small" id="tSend">Comment</button></div></section>`;
  openDrawer();

  const A = $("#tActions"), add = (html) => A.insertAdjacentHTML("beforeend", html);
  if (approver && t.status === "Pending approval") {
    add(`<div class="decide"><textarea id="dNote" rows="2" placeholder="Note for ${esc(personName(t.requester_id).split(" ")[0])} (needed if you reject)"></textarea>
      <div class="actions-row"><button class="btn primary" id="dApprove">Approve</button><button class="btn danger" id="dReject">Reject</button></div></div>`);
    $("#dApprove").addEventListener("click", (e) => run(e.target, () => db.rpc("desk_decide", { p_id: id, p_approve: true, p_note: $("#dNote").value }), "Approved"));
    $("#dReject").addEventListener("click", (e) => { if (!$("#dNote").value.trim()) { $("#dNote").focus(); return toast("Add a reason so they know why"); }
      run(e.target, () => db.rpc("desk_decide", { p_id: id, p_approve: false, p_note: $("#dNote").value }), "Rejected"); });
  }
  const row = [];
  if (worker && DESK_WORK.includes(t.status)) {
    if (t.status !== "In progress") row.push(`<button class="btn" id="aStart">Start work</button>`);
    row.push(`<button class="btn primary" id="aDone">Mark done</button>`);
  }
  if (worker && ["Done", "Cancelled"].includes(t.status)) row.push(`<button class="btn" id="aReopen">Reopen</button>`);
  if (canEdit) row.push(`<button class="btn" id="aEdit">Edit</button>`);
  if ((mineReq || isAdmin()) && !closed) row.push(`<button class="btn danger" id="aCancel">Cancel request</button>`);
  if (row.length) add(`<div class="actions-row">${row.join("")}</div>`);
  if (isAdmin() && !closed) {
    const active = S.team.filter((p) => p.active);
    add(`<div class="form admin-row"><label>Assigned to<select id="aAssign"><option value="">Unassigned (admins)</option>
      ${active.map((p) => `<option value="${p.id}" ${p.id === t.assignee_id ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label>
      ${t.status === "Pending approval" ? `<label>Approver<select id="aApprover">${active.map((p) => `<option value="${p.id}" ${p.id === t.approver_id ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label>` : ""}</div>`);
    $("#aAssign").addEventListener("change", (e) => run(e.target, () => db.rpc("desk_assign", { p_id: id, p_assignee: e.target.value || null }), "Assignment updated"));
    $("#aApprover")?.addEventListener("change", (e) => run(e.target, () => db.rpc("desk_update", { p_id: id, p: { approver_id: e.target.value } }), "Approver changed"));
  }
  const note = () => $("#tComment").value.trim() || null;
  $("#aStart")?.addEventListener("click", (e) => run(e.target, () => db.rpc("desk_set_status", { p_id: id, p_status: "In progress", p_note: note() }), "Marked in progress"));
  $("#aDone")?.addEventListener("click", (e) => run(e.target, () => db.rpc("desk_set_status", { p_id: id, p_status: "Done", p_note: note() }), "Marked done"));
  $("#aReopen")?.addEventListener("click", (e) => run(e.target, () => db.rpc("desk_set_status", { p_id: id, p_status: "Reopen", p_note: note() }), "Reopened"));
  $("#aCancel")?.addEventListener("click", (e) => { if (!confirm("Cancel this request?")) return;
    run(e.target, () => db.rpc("desk_set_status", { p_id: id, p_status: "Cancelled", p_note: note() }), "Request cancelled"); });
  $("#aEdit")?.addEventListener("click", () => editTicket(t, onChange));
  $("#tSend").addEventListener("click", (e) => { if (!note()) return $("#tComment").focus(); run(e.target, () => db.rpc("desk_comment", { p_id: id, p_body: note() }), "Comment added"); });
}
function eventLi(e) {
  const who = `<b>${esc(e.user_name || "Someone")}</b>`;
  const text = {
    created: `${who} submitted the request${e.to_status === "Pending approval" ? " for approval" : ""}`,
    approved: `${who} approved it`, rejected: `${who} rejected it`,
    status: `${who} moved it from ${esc(e.from_status)} to <b>${esc(e.to_status)}</b>`,
    assigned: `${who} assigned it to ${esc(e.body)}`, approver: `${who} changed the approver to ${esc(e.body)}`,
    edited: `${who} edited it`, comment: who, note: esc(e.body),
  }[e.kind] || `${who} ${esc(e.kind)}`;
  const body = ["comment", "approved", "rejected", "status", "edited"].includes(e.kind) && e.body ? `<div class="tl-body ${e.kind === "comment" ? "bubble" : ""}">${esc(e.body)}</div>` : "";
  return `<li class="tl-${e.kind}"><span class="tl-dot"></span><div>${text} <span class="muted">· ${ago(e.ts)}</span>${body}</div></li>`;
}
function editTicket(t, onChange) {
  const cfg = DESK_TYPE[t.type] || {};
  $("#drawerTitle").textContent = `Edit ${ticketNo(t.number ?? t.id)}`;
  $("#drawerBody").innerHTML = `<form class="form" id="edForm">
      <label class="full">Title<input name="title" value="${esc(t.title)}" required maxlength="140"></label>
      ${cfg.dates ? `<label>Start date<input type="date" name="start_date" value="${esc(t.start_date || "")}" required></label><label>End date<input type="date" name="end_date" value="${esc(t.end_date || "")}"></label>` : ""}
      ${cfg.amount ? `<label>${esc(cfg.amount)}<input name="amount" value="${t.amount ?? ""}" inputmode="decimal"></label>` : ""}
      ${cfg.ref ? `<label>${esc(cfg.ref)}<input name="reference" value="${esc(t.reference || "")}"></label>` : ""}
      ${cfg.needed ? `<label>Needed by<input type="date" name="needed_by" value="${esc(t.needed_by || "")}"></label>` : ""}
      <label>Priority<select name="priority">${["Low", "Normal", "High", "Urgent"].map((p) => `<option ${p === t.priority ? "selected" : ""}>${p}</option>`).join("")}</select></label>
      <label class="full">Details<textarea name="description" rows="6">${esc(t.description || "")}</textarea></label></form>
    <div class="form-foot"><button class="btn primary" id="edSave">Save changes</button><button class="btn" id="edBack">Back</button></div>`;
  $("#edBack").addEventListener("click", () => openTicket(t.id, onChange));
  $("#edSave").addEventListener("click", async (e) => {
    if (!$("#edForm").reportValidity()) return;
    e.target.disabled = true;
    try { await db.rpc("desk_update", { p_id: t.id, p: Object.fromEntries(new FormData($("#edForm"))) }); toast("Saved"); onChange && onChange(); openTicket(t.id, onChange); }
    catch (err) { toast(err.message); e.target.disabled = false; }
  });
}

/* ================================================================ My approvals */
async function DeskApprovals() {
  const c = await refreshDeskBadges();
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>My approvals</h1><p class="muted">Requests that need your sign-off. Rejecting needs a short reason, which the requester sees.</p></div></div>
    <div class="filters">${tabs([["waiting", `Waiting for me${c?.approvals ? ` <span class="tab-n">${c.approvals}</span>` : ""}`], ["decided", "Decided"]], DESK.apprTab, "data-at")}</div>
    <div id="apprList"></div>`;
  $$("[data-at]").forEach((b) => b.addEventListener("click", () => { DESK.apprTab = b.dataset.at; DeskApprovals(); }));
  let rows;
  try {
    rows = must(await sb.from("tickets").select("*").eq("approver_id", me())
      .in("status", DESK.apprTab === "waiting" ? ["Pending approval"] : ["Approved", "Rejected", "In progress", "Done", "Cancelled"])
      .order(DESK.apprTab === "waiting" ? "created_at" : "updated_at", { ascending: DESK.apprTab === "waiting" }).limit(300));
  } catch (e) { $("#apprList").innerHTML = deskMissing(e) ? deskSetupNotice() : `<div class="empty">${esc(e.message)}</div>`; return; }
  if (DESK.apprTab === "decided") rows = rows.filter((t) => t.decided_at);
  const L = $("#apprList");
  if (!rows.length) { L.innerHTML = `<div class="panel empty">${DESK.apprTab === "waiting" ? "You're all caught up. Nothing is waiting for your approval." : "You haven't decided on any requests yet."}</div>`; return; }
  if (DESK.apprTab === "decided") {
    L.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Request</th><th>From</th><th>Decision</th><th>Now</th><th>Decided</th></tr></thead><tbody>
      ${rows.map((t) => `<tr data-ticket="${t.id}" tabindex="0"><td class="wrap"><span class="tno">${ticketNo(t.number ?? t.id)}</span><span class="clip" style="font-weight:600">${esc(t.title)}</span></td>
        <td>${esc(personName(t.requester_id))}</td><td>${pill(t.status === "Rejected" ? "Rejected" : "Approved")}</td><td>${pill(t.status)}</td><td class="date">${short(t.decided_at.slice(0, 10))}</td></tr>`).join("")}</tbody></table></div>`;
    wireTicketRows(L, DeskApprovals);
    return;
  }
  L.innerHTML = `<div class="appr-grid">${rows.map((t) => {
    const cfg = DESK_TYPE[t.type] || { icon: "chat" };
    return `<article class="appr-card" data-ticket="${t.id}">
      <header>${icon(cfg.icon)}<div><span class="tno">${ticketNo(t.number ?? t.id)} · ${esc(t.type)}</span><h3>${esc(t.title)}</h3>
        <span class="muted">From ${esc(personName(t.requester_id))} · ${ago(t.created_at)}${t.priority !== "Normal" ? ` · <b>${esc(t.priority)}</b>` : ""}</span></div></header>
      ${deskFacts(t).length ? `<dl class="facts compact">${deskFacts(t).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
      ${t.description ? `<p class="appr-desc">${esc(t.description)}</p>` : ""}
      <div class="appr-reject" hidden><textarea rows="2" placeholder="Reason (the requester will see this)"></textarea></div>
      <div class="actions-row"><button class="btn primary small" data-approve>Approve</button><button class="btn danger small" data-reject>Reject</button><button class="btn small" data-view>Details</button></div>
    </article>`; }).join("")}</div>`;
  L.addEventListener("click", async (e) => {
    const card = e.target.closest(".appr-card"); if (!card) return;
    const id = +card.dataset.ticket, b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-view")) return openTicket(id, DeskApprovals);
    const box = card.querySelector(".appr-reject"), ta = box.querySelector("textarea");
    if (b.hasAttribute("data-reject") && (box.hidden || !ta.value.trim())) { box.hidden = false; ta.focus(); if (!box.dataset.shown) { box.dataset.shown = 1; b.textContent = "Confirm reject"; } else toast("Add a reason first"); return; }
    b.disabled = true;
    try {
      await db.rpc("desk_decide", { p_id: id, p_approve: b.hasAttribute("data-approve"), p_note: ta.value });
      toast(b.hasAttribute("data-approve") ? "Approved" : "Rejected");
      DeskApprovals();
    } catch (err) { toast(err.message); b.disabled = false; }
  });
}

/* ================================================================ My assets */
async function DeskAssets() {
  const tabList = [["mine", "Assigned to me"]].concat(isAdmin() ? [["register", "Asset register"]] : []);
  if (!isAdmin()) DESK.assetTab = "mine";
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>My assets</h1><p class="muted">${DESK.assetTab === "register" ? "Every piece of company equipment and who has it." : "Company equipment assigned to you. Report a problem or hand something back from here."}</p></div>
      <div class="actions-row">${DESK.assetTab === "register" ? `<label class="btn">Import file<input type="file" id="assetImport" accept=".xlsx,.csv,.tsv" hidden></label>
        <button class="btn" id="assetExport">Export CSV</button><button class="btn primary" id="assetAdd">${icon("plus")}Add asset</button>`
        : `<button class="btn primary" id="reqEquip">${icon("plus")}Request equipment</button>`}</div></div>
    <div class="filters">${tabList.length > 1 ? tabs(tabList, DESK.assetTab, "data-st") : ""}
      ${DESK.assetTab === "register" ? `<input type="search" id="assetQ" placeholder="Search tag, name, serial, person…" value="${esc(DESK.assetQ)}">
        <select id="assetStatus"><option value="">Status: any</option>${ASSET_STATUSES.map((s) => `<option ${s === DESK.assetStatus ? "selected" : ""}>${s}</option>`).join("")}</select>` : ""}
      <span class="count" id="assetCount"></span></div>
    <div id="assetList"></div>`;
  $$("[data-st]").forEach((b) => b.addEventListener("click", () => { DESK.assetTab = b.dataset.st; DeskAssets(); }));
  $("#reqEquip")?.addEventListener("click", () => openNewRequest({ type: "New equipment" }));
  $("#assetAdd")?.addEventListener("click", () => openAsset(null));
  let tmr;
  $("#assetQ")?.addEventListener("input", (e) => { clearTimeout(tmr); tmr = setTimeout(() => { DESK.assetQ = e.target.value; loadAssets(); }, 200); });
  $("#assetStatus")?.addEventListener("change", (e) => { DESK.assetStatus = e.target.value; loadAssets(); });
  $("#assetExport")?.addEventListener("click", async () => {
    const rows = (DESK.lastAssets || []).map((a) => ({ ...a, assigned_to: personName(a.assigned_to, "") }));
    downloadCsv(`assets-${today()}.csv`, ["tag", "name", "category", "make_model", "serial", "status", "assigned_to", "assigned_since", "location", "purchase_date", "cost", "vendor", "warranty_end", "notes"], rows);
  });
  $("#assetImport")?.addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { const n = await importAssets(file); toast(`Imported ${n} asset${n === 1 ? "" : "s"}`); loadAssets(); } catch (err) { toast("Import failed: " + err.message); }
    e.target.value = "";
  });
  await loadAssets();
}
async function loadAssets() {
  const L = $("#assetList");
  let rows;
  try {
    let q = sb.from("assets").select("*");
    if (DESK.assetTab === "mine") q = q.eq("assigned_to", me());
    if (DESK.assetTab === "register" && DESK.assetStatus) q = q.eq("status", DESK.assetStatus);
    rows = must(await q.order("tag", { ascending: true, nullsFirst: false }).order("name").limit(2000));
  } catch (e) { L.innerHTML = deskMissing(e) ? deskSetupNotice() : `<div class="empty">${esc(e.message)}</div>`; return; }
  const term = DESK.assetQ.trim().toLowerCase();
  if (DESK.assetTab === "register" && term)
    rows = rows.filter((a) => [a.tag, a.name, a.serial, a.make_model, a.location, a.category, personName(a.assigned_to, "")].join(" ").toLowerCase().includes(term));
  DESK.lastAssets = rows;
  $("#assetCount").textContent = `${rows.length} asset${rows.length === 1 ? "" : "s"}`;
  if (DESK.assetTab === "mine") {
    L.innerHTML = rows.length ? `<div class="asset-grid">${rows.map((a) => `<article class="asset-card" data-asset="${a.id}">
        <div class="asset-ic">${icon(ASSET_ICON[a.category] || "cube")}</div>
        <div class="asset-main"><span class="tno">${esc(a.tag || a.category || "")}</span><h3>${esc(a.name)}</h3>
          <span class="muted">${esc([a.make_model, a.serial && "S/N " + a.serial].filter(Boolean).join(" · "))}</span>
          <div class="asset-meta">${pill(a.status)}${a.assigned_since ? `<span class="muted">Yours since ${short(a.assigned_since)}</span>` : ""}
            ${a.warranty_end ? `<span class="${daysUntil(a.warranty_end) < 0 ? "muted" : daysUntil(a.warranty_end) < 60 ? "due-soon" : "muted"}">Warranty ${daysUntil(a.warranty_end) < 0 ? "ended" : "to"} ${short(a.warranty_end)}</span>` : ""}</div></div>
        <div class="actions-row"><button class="btn small" data-problem>Report a problem</button><button class="btn small" data-return>Return it</button></div></article>`).join("")}</div>`
      : `<div class="panel empty">No equipment is assigned to you yet. Need something? Use <b>Request equipment</b>.</div>`;
    L.onclick = (e) => {
      const card = e.target.closest("[data-asset]"); if (!card) return;
      const id = card.dataset.asset;
      if (e.target.closest("[data-problem]")) return openNewRequest({ type: "Asset problem", asset_id: id });
      if (e.target.closest("[data-return]")) return openNewRequest({ type: "Return an asset", asset_id: id });
      openAsset(+id);
    };
    return;
  }
  L.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Tag</th><th>Name</th><th>Category</th><th>Assigned to</th><th>Status</th><th>Warranty</th><th>Location</th></tr></thead><tbody>
    ${rows.map((a) => `<tr data-asset="${a.id}" tabindex="0"><td class="date" style="font-weight:600">${esc(a.tag || "")}</td><td class="wrap"><span class="clip">${esc(a.name)}</span></td>
      <td>${esc(a.category || "")}</td><td>${a.assigned_to ? esc(personName(a.assigned_to)) : `<span class="muted">—</span>`}</td><td>${pill(a.status)}</td>
      <td class="date">${a.warranty_end ? `<span class="${daysUntil(a.warranty_end) < 0 ? "muted" : daysUntil(a.warranty_end) < 60 ? "due-soon" : ""}">${short(a.warranty_end)}</span>` : ""}</td>
      <td>${esc(a.location || "")}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="panel empty">${term || DESK.assetStatus ? "No assets match." : "The register is empty. Use <b>Add asset</b>, or <b>Import file</b> to load a spreadsheet of equipment."}</div>`;
  L.onclick = (e) => { const r = e.target.closest("[data-asset]"); if (r) openAsset(+r.dataset.asset); };
  L.onkeydown = (e) => { if (e.key === "Enter" && e.target.dataset.asset) openAsset(+e.target.dataset.asset); };
}
async function openAsset(id) {
  let a = { status: "Available" }, related = [];
  if (id) {
    try {
      a = must(await sb.from("assets").select("*").eq("id", id).single());
      related = must(await sb.from("tickets").select("id,title,type,status,updated_at").eq("asset_id", id).order("updated_at", { ascending: false }).limit(50));
    } catch (e) { return toast(e.message); }
  }
  const admin = isAdmin();
  $("#drawerTitle").textContent = id ? [a.tag, a.name].filter(Boolean).join(" · ") : "Add asset";
  const field = (n, l, type = "text", full = false) => `<label class="${full ? "full" : ""}">${l}<input name="${n}" type="${type}" value="${esc(type === "date" ? String(a[n] || "").slice(0, 10) : a[n] ?? "")}" ${admin ? "" : "disabled"}></label>`;
  const sel = (n, l, opts) => `<label>${l}<select name="${n}" ${admin ? "" : "disabled"}><option value=""></option>${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(a[n] ?? "") === String(v) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
  $("#drawerBody").innerHTML = `
    <form class="form" id="assetForm">
      <label class="full">Name<input name="name" required value="${esc(a.name || "")}" placeholder="e.g. Dell XPS 15" ${admin ? "" : "disabled"}></label>
      ${field("tag", "Asset tag")}${sel("category", "Category", ASSET_CATEGORIES.map((c) => [c, c]))}
      ${field("make_model", "Make / model")}${field("serial", "Serial number")}
      ${sel("assigned_to", "Assigned to", S.team.filter((p) => p.active || p.id === a.assigned_to).map((p) => [p.id, p.display_name]))}
      ${sel("status", "Status", ASSET_STATUSES.map((s) => [s, s]))}
      ${field("location", "Location")}${field("vendor", "Vendor")}
      ${field("purchase_date", "Purchased", "date")}${field("cost", "Cost (USD)", "number")}
      ${field("warranty_end", "Warranty ends", "date")}
      <label class="full">Notes<textarea name="notes" rows="3" ${admin ? "" : "disabled"}>${esc(a.notes || "")}</textarea></label>
    </form>
    ${a.assigned_since ? `<p class="meta-box">With ${esc(personName(a.assigned_to))} since ${short(a.assigned_since)}${a.updated_by ? ` · last updated by ${esc(a.updated_by)} ${ago(a.updated_at)}` : ""}</p>` : ""}
    <div class="form-foot">${admin ? `<button class="btn primary" id="aSave">${id ? "Save changes" : "Add asset"}</button><button class="btn" data-close>Cancel</button><span class="spacer"></span>${id ? `<button class="btn danger" id="aDel">Delete</button>` : ""}`
      : `<button class="btn" id="aProblem">Report a problem</button><button class="btn" id="aReturn">Return it</button>`}</div>
    ${related.length ? `<section class="history"><h3>Requests about this asset</h3><ul class="list">${related.map((r) => `<li><a href="#" data-ticket="${r.id}">${ticketNo(r.number ?? r.id)} · ${esc(r.title)}</a><span class="meta">${pill(r.status)}</span></li>`).join("")}</ul></section>` : ""}`;
  openDrawer();
  $("#drawerBody").querySelectorAll("[data-ticket]").forEach((l) => l.addEventListener("click", (e) => { e.preventDefault(); openTicket(+l.dataset.ticket, loadAssets); }));
  $("#aProblem")?.addEventListener("click", () => openNewRequest({ type: "Asset problem", asset_id: id }));
  $("#aReturn")?.addEventListener("click", () => openNewRequest({ type: "Return an asset", asset_id: id }));
  $("#aSave")?.addEventListener("click", async (e) => {
    if (!$("#assetForm").reportValidity()) return;
    const raw = Object.fromEntries(new FormData($("#assetForm")));
    const data = {};
    for (const [k, v] of Object.entries(raw)) data[k] = String(v).trim() === "" ? null : k === "cost" ? parseFloat(String(v).replace(/[$,]/g, "")) : String(v).trim();
    data.status = data.status || "Available";
    e.target.disabled = true;
    try {
      if (id) must(await sb.from("assets").update(data).eq("id", id)); else must(await sb.from("assets").insert(data));
      toast(id ? "Saved" : "Asset added"); closeDrawer(); refreshDeskBadges(); loadAssets();
    } catch (err) { toast(err.message); e.target.disabled = false; }
  });
  $("#aDel")?.addEventListener("click", async () => {
    if (!confirm("Delete this asset from the register? Requests about it are kept. Usually it's better to set the status to Retired.")) return;
    try { must(await sb.from("assets").delete().eq("id", id)); toast("Deleted"); closeDrawer(); loadAssets(); } catch (err) { toast(err.message); }
  });
}
async function importAssets(file) {
  const book = await readSheetFile(file);
  const rows = book.sheets.find((s) => s.rows.length > 1)?.rows || [];
  const hi = findHeaderRow(rows), head = (rows[hi] || []).map((h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  const col = (re) => head.findIndex((h) => re.test(h));
  const map = { tag: col(/^(asset )?(tag|id|number|no)$|asset tag/), name: col(/^(name|asset|asset name|item|description|device)$/), category: col(/category|type|class/),
    make_model: col(/make|model|manufacturer/), serial: col(/serial|s n|sn$/), status: col(/^status|condition/), person: col(/assigned|user|owner|employee|holder|custodian/),
    location: col(/location|site|office/), purchase_date: col(/purchase|acquired|bought/), cost: col(/cost|price|value/), vendor: col(/vendor|supplier/),
    warranty_end: col(/warranty/), notes: col(/notes?|comments?/) };
  if (map.name < 0) map.name = map.make_model >= 0 ? map.make_model : -1;
  if (map.name < 0) throw new Error("Couldn't find a Name, Asset or Item column.");
  const findPerson = (v) => { v = tidy(v).toLowerCase(); if (!v) return null;
    return S.team.find((p) => p.email?.toLowerCase() === v || p.display_name.toLowerCase() === v || p.display_name.toLowerCase().split(" ")[0] === v)?.id || null; };
  const asDate = (v) => { v = tidy(v); if (!v) return null; if (/^\d{5}$/.test(v)) return new Date(Date.UTC(1899, 11, 30) + +v * 864e5).toISOString().slice(0, 10);
    const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
  const out = [], unmatched = new Set();
  for (const r of rows.slice(hi + 1)) {
    const g = (k) => (map[k] >= 0 ? tidy(r[map[k]]) : "");
    if (!g("name")) continue;
    const who = g("person"), pid = findPerson(who);
    if (who && !pid) unmatched.add(who);
    const cat = ASSET_CATEGORIES.find((c) => c.toLowerCase() === g("category").toLowerCase()) || (g("category") ? "Other" : null);
    const st = ASSET_STATUSES.find((s) => s.toLowerCase() === g("status").toLowerCase());
    out.push({ tag: g("tag") || null, name: g("name"), category: cat, make_model: g("make_model") || null, serial: g("serial") || null,
      status: st || (pid ? "In use" : "Available"), assigned_to: pid, location: g("location") || null, purchase_date: asDate(g("purchase_date")),
      cost: g("cost") ? parseFloat(g("cost").replace(/[$,]/g, "")) || null : null, vendor: g("vendor") || null, warranty_end: asDate(g("warranty_end")),
      notes: [g("notes"), who && !pid ? `Listed as assigned to: ${who}` : "", cat === "Other" && g("category") ? `Category in file: ${g("category")}` : ""].filter(Boolean).join("\n") || null });
  }
  if (!out.length) throw new Error("No rows with a name found.");
  for (let i = 0; i < out.length; i += 500) must(await sb.from("assets").insert(out.slice(i, i + 500)));
  if (unmatched.size) setTimeout(() => toast(`${unmatched.size} name${unmatched.size === 1 ? "" : "s"} didn't match a teammate; saved in notes`), 2600);
  return out.length;
}

