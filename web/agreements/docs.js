/* Pulse · Documents: policies (Starter), invoices (Pro) and the compliance calendar, alongside agreements (agreements.js).
   Policies: admins write, load from the starter library, publish (a new version asks people to certify again) and retire.
   People read and certify them in People → My policies, or right here. Invoices: built from projects and approved hours,
   numbered by the database, printed to PDF, marked sent and paid. Compliance: dates for filings, licenses and postings. */
"use strict";
const DOC = { ptab: "Published", itab: "open", ctab: "open" };
const POL_CATS = ["Workplace", "Employee relations", "Safety and health", "Ethics and conduct", "Finance", "Data and IT", "Benefits and leave", "Other"];
const COMP_CATS = ["Registration", "License", "Tax", "Insurance", "Safety and health", "Employment", "Posting", "Certification", "Other"];
const REPEATS = ["Once", "Monthly", "Quarterly", "Yearly", "Every 2 years", "Every 3 years", "Every 5 years"];
const fmtD = (d) => d ? new Date(String(d).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
const field = (label, html, wide) => `<label${wide ? ' style="grid-column:1/-1"' : ""}>${label}${html}</label>`;
const opts = (list, v) => list.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("");

/* ================================================================ policies */
async function Policies() {
  const rows = must(await sb.from("doc_policies").select("id, title, category, owner_title, audience, requires_ack, status, version, effective_date, next_review, summary").order("title"));
  let st = []; if (isAdmin()) { try { st = await db.rpc("policy_status", {}); } catch { st = []; } }
  let mine = []; try { mine = await db.rpc("my_policies", {}); } catch { mine = []; }
  const signed = (id) => { const p = st.find((x) => x.id === id); if (!p) return ""; const n = p.people.filter((u) => u.acked_at).length; return `${n} of ${p.people.length}`; };
  const myAck = (id) => mine.find((m) => m.id === id);
  const tabs = isAdmin() ? [["Published", "Published"], ["Draft", "Drafts"], ["Retired", "Retired"], ["all", "All"]] : [];
  const list = rows.filter((r) => DOC.ptab === "all" || !isAdmin() || r.status === DOC.ptab);
  const due = rows.filter((r) => r.status === "Published" && r.next_review && daysUntil(r.next_review) <= 30).length;
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Policies</h1><p class="muted">${isAdmin() ? "Your company's policy register. Publish a policy and the people it applies to read and certify it, once per version, in a click." : "The policies that apply to you. Certify the ones you haven't yet in People → My policies, or open one here."}</p></div>
      ${isAdmin() ? `<div class="actions-row"><button class="btn" id="polLib">${icon("book")}Add from library</button><a class="btn primary" href="#/policy-edit/new">${icon("plus")}New policy</a></div>` : ""}</div>
    ${due ? `<p class="notice-bar">${icon("clock")}<span>${due} ${due === 1 ? "policy is" : "policies are"} due for review in the next 30 days.</span></p>` : ""}
    ${tabs.length ? `<div class="filters"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-ptab="${k}" aria-selected="${DOC.ptab === k}">${l} <span class="muted">${k === "all" ? rows.length : rows.filter((r) => r.status === k).length}</span></button>`).join("")}</div></div>` : ""}
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Policy</th><th>Category</th>${isAdmin() ? "<th>Owner</th><th>Status</th>" : ""}<th>Version</th><th>Effective</th>${isAdmin() ? "<th>Next review</th><th>Certified</th>" : "<th>You</th>"}</tr></thead>
      <tbody>${list.map((r) => { const m = myAck(r.id);
        return `<tr data-href="#/policy/${r.id}" tabindex="0"><td><b>${esc(r.title)}</b>${r.summary ? `<small class="muted" style="display:block">${esc(r.summary)}</small>` : ""}</td><td>${esc(r.category)}</td>
        ${isAdmin() ? `<td>${esc(r.owner_title || "")}</td><td>${pill(r.status === "Published" ? "Active" : r.status === "Draft" ? "Draft" : "Dormant").replace(/>[^<]+</, `>${esc(r.status)}<`)}</td>` : ""}
        <td>v${r.version}</td><td class="date">${fmtD(r.effective_date)}</td>
        ${isAdmin() ? `<td class="date">${r.next_review ? dueCell(r.next_review, r.status === "Published") : "—"}</td><td>${r.status === "Published" && r.requires_ack ? signed(r.id) : r.requires_ack ? "" : '<span class="muted">No sign-off</span>'}</td>`
          : `<td>${!r.requires_ack ? '<span class="muted">For reference</span>' : m?.acked_at ? `${icon("check")} ${short(m.acked_at)}` : '<b class="txt-amber">To certify</b>'}</td>`}</tr>`; }).join("")
        || `<tr><td colspan="8" class="empty">${rows.length ? "Nothing in this view." : isAdmin() ? "No policies yet. Add the starter policies from the library, or write your own." : "No policies have been published yet."}</td></tr>`}</tbody></table></div></section>
    ${isAdmin() ? `<p class="muted small">Starter policies are plain-English starting points for a small US company, not legal advice. Edit them for your company and the states you work in, and have counsel review them.</p>` : ""}`;
  $$("[data-ptab]").forEach((b) => b.addEventListener("click", () => { DOC.ptab = b.dataset.ptab; Policies(); }));
  rowLinks();
  $("#polLib")?.addEventListener("click", () => policyLibrary(rows));
}
function rowLinks() { $$("tr[data-href]").forEach((r) => { r.addEventListener("click", (e) => { if (!e.target.closest("a,button,input")) location.hash = r.dataset.href; }); r.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = r.dataset.href; }); }); }

function policyLibrary(existing) {
  const have = new Set(existing.map((r) => r.title.toLowerCase()));
  $("#drawerTitle").textContent = "Add starter policies";
  $("#drawerBody").innerHTML = `<p class="muted">Each is added as a <b>Draft</b> for you to edit (fill in the [bracketed] parts) and publish. Not legal advice: check your state's rules and have counsel review.</p>
    <div class="lib-list">${POLICY_LIBRARY.map((p) => `<label class="lib-item"><input type="checkbox" value="${p.key}" ${have.has(p.title.toLowerCase()) ? "disabled" : ""}>
      <span><b>${esc(p.title)}</b> <small class="muted">${esc(p.category)}</small>${have.has(p.title.toLowerCase()) ? ' <small class="muted">· already added</small>' : ""}<small>${esc(p.summary)}</small></span></label>`).join("")}</div>
    <div class="actions-row" style="margin-top:12px"><button class="btn" id="libAll" type="button">Select all</button><button class="btn primary" id="libAdd" type="button">Add as drafts</button></div>`;
  openDrawer();
  $("#libAll").addEventListener("click", () => $$(".lib-item input:not(:disabled)").forEach((c) => (c.checked = true)));
  $("#libAdd").addEventListener("click", async () => {
    const keys = $$(".lib-item input:checked").map((c) => c.value); if (!keys.length) return toast("Pick at least one");
    const ins = POLICY_LIBRARY.filter((p) => keys.includes(p.key)).map((p) => ({ title: p.title, category: p.category, audience: p.audience, review_months: p.review_months,
      summary: p.summary, body: p.body.replace(/\[Company\]/g, S.workspace.name), status: "Draft", source: "library:" + p.key, updated_by: S.profile.display_name }));
    try { must(await sb.from("doc_policies").insert(ins)); closeDrawer(); toast(`${ins.length} added as drafts`); DOC.ptab = "Draft"; Policies(); } catch (e) { toast(e.message); }
  });
}

async function PolicyView(id) {
  const p = must(await sb.from("doc_policies").select("*").eq("id", id).maybeSingle());
  if (!p) { $("#main").innerHTML = `<div class="empty">Policy not found.</div>`; return; }
  let mine = []; try { mine = await db.rpc("my_policies", {}); } catch { mine = []; }
  const m = mine.find((x) => x.id === p.id);
  let st = null; if (isAdmin() && p.status === "Published" && p.requires_ack) { try { st = (await db.rpc("policy_status", {})).find((x) => x.id === p.id); } catch { st = null; } }
  const done = st ? st.people.filter((u) => u.acked_at) : [], waiting = st ? st.people.filter((u) => !u.acked_at) : [];
  $("#main").innerHTML = `
    <p class="crumbs"><a href="#/policies">Policies</a> › ${esc(p.title)}</p>
    <div class="page-head"><div><h1>${esc(p.title)}</h1><p class="muted">${esc(p.category)} · v${p.version} · ${p.status}${p.effective_date ? " · effective " + fmtD(p.effective_date) : ""}${p.owner_title ? " · owner: " + esc(p.owner_title) : ""} · applies to ${esc(p.audience.toLowerCase())}</p></div>
      ${isAdmin() ? `<div class="actions-row"><a class="btn" href="#/policy-edit/${p.id}">Edit</a>${p.status === "Published" ? `<button class="btn" id="polNew">Publish new version</button><button class="btn" id="polRetire">Retire</button>` : `<button class="btn primary" id="polPub">Publish</button>`}<button class="btn" onclick="window.print()">Print</button></div>` : `<div class="actions-row"><button class="btn" onclick="window.print()">Print</button></div>`}</div>
    ${isAdmin() && st ? `<section class="panel no-print"><h2>Certified ${done.length} of ${st.people.length}</h2>
      ${waiting.length ? `<p class="muted">Waiting on: ${waiting.map((u) => esc(u.name)).join(", ")}. ${remindLink(p, waiting)}</p>` : `<p class="muted">Everyone it applies to has certified this version.</p>`}</section>` : ""}
    ${p.status === "Published" && p.requires_ack && m && !m.acked_at ? certifyBox([p]) : m?.acked_at ? `<p class="notice-bar ok no-print">${icon("check")}<span>You certified this version on ${short(m.acked_at)}.</span></p>` : ""}
    <article class="panel doc-body">${p.summary ? `<p class="doc-sum">${esc(p.summary)}</p>` : ""}${mdDoc(p.body) || '<p class="muted">No text yet.</p>'}</article>`;
  wireCertify(() => PolicyView(id));
  const pub = async (nv) => { try { const r = await db.rpc("policy_publish", { p_id: p.id, p_new_version: nv }); toast(nv ? `Published v${r.version}; people will be asked to certify it` : "Published"); PolicyView(id); } catch (e) { toast(e.message); } };
  $("#polPub")?.addEventListener("click", () => pub(false));
  $("#polNew")?.addEventListener("click", () => { if (confirm("Publish a new version? Everyone it applies to will be asked to certify it again. Use this for real changes, not typo fixes.")) pub(true); });
  $("#polRetire")?.addEventListener("click", async () => { if (!confirm("Retire this policy? People will no longer see it.")) return; try { must(await sb.from("doc_policies").update({ status: "Retired", updated_by: S.profile.display_name }).eq("id", p.id)); PolicyView(id); } catch (e) { toast(e.message); } });
}
function remindLink(p, waiting) {
  const to = waiting.map((u) => S.team.find((t) => t.id === u.user_id)?.email).filter(Boolean);
  if (!to.length) return "";
  const url = new URL("../people/#/policies", location.href).href;
  return `<a href="mailto:?bcc=${encodeURIComponent(to.join(","))}&subject=${encodeURIComponent("Please read and certify: " + p.title)}&body=${encodeURIComponent(`Hi,\n\nPlease take a few minutes to read "${p.title}" and certify it in Pulse:\n${url}\n\nThanks,\n${S.profile.display_name}`)}">Email a reminder</a>`;
}
// the read-and-certify box: one name, one click, for one or several policies
function certifyBox(list) {
  return `<section class="panel certify no-print" id="certBox"><h2>${list.length === 1 ? "Read and certify" : `${list.length} policies to read and certify`}</h2>
    <label class="check"><input type="checkbox" id="certOk"> I have read ${list.length === 1 ? "this policy" : "these policies"}, understand ${list.length === 1 ? "it" : "them"}, and will follow ${list.length === 1 ? "it" : "them"}.</label>
    <div class="row"><input id="certName" value="${esc(S.profile.display_name)}" aria-label="Your full name" placeholder="Your full name"><button class="btn primary" id="certGo" data-ids="${list.map((p) => p.id).join(",")}">Certify</button></div>
    <p class="muted small">Your typed name, the time and the version are recorded.</p></section>`;
}
function wireCertify(after) {
  $("#certGo")?.addEventListener("click", async (e) => {
    if (!$("#certOk").checked) return toast("Tick the box to confirm you've read it");
    const ids = e.currentTarget.dataset.ids.split(",").map(Number);
    try { const n = await db.rpc("policy_ack", { p_ids: ids, p_name: $("#certName").value }); toast(n ? "Thank you, certified" : "Already certified"); after(); } catch (err) { toast(err.message); }
  });
}

async function PolicyEdit(id) {
  if (!isAdmin()) return Policies();
  const p = id === "new" ? { title: "", category: "Workplace", audience: "Everyone", requires_ack: true, review_months: 12, status: "Draft", body: "", summary: "", owner_title: "" }
    : must(await sb.from("doc_policies").select("*").eq("id", id).maybeSingle());
  $("#main").innerHTML = `
    <p class="crumbs"><a href="#/policies">Policies</a> › ${id === "new" ? "New policy" : esc(p.title)}</p>
    <div class="page-head"><div><h1>${id === "new" ? "New policy" : "Edit policy"}</h1><p class="muted">${p.status === "Published" ? "Small fixes save straight to the published version. For real changes, save and then use <b>Publish new version</b> so people certify it again." : "Save as a draft, then publish it when it's ready."}</p></div>
      <div class="actions-row"><button class="btn" id="peView" type="button">Preview</button><button class="btn primary" id="peSave" type="button">Save</button></div></div>
    <form class="panel form-grid" id="peForm">
      ${field("Title *", `<input name="title" required value="${esc(p.title)}">`)}
      ${field("Category", `<select name="category">${opts(POL_CATS, p.category)}</select>`)}
      ${field("Applies to", `<select name="audience">${opts(["Everyone", "Staff", "Contractors"], p.audience)}</select>`)}
      ${field("Owner (keeps it current)", `<input name="owner_title" value="${esc(p.owner_title || "")}" placeholder="CEO / People">`)}
      ${field("Effective date", `<input name="effective_date" type="date" value="${p.effective_date || ""}">`)}
      ${field("Review every (months)", `<input name="review_months" type="number" min="0" value="${p.review_months ?? 12}">`)}
      <label class="check" style="grid-column:1/-1"><input type="checkbox" name="requires_ack" ${p.requires_ack ? "checked" : ""}> People must read and certify it (untick for reference documents)</label>
      ${field("One-line summary", `<input name="summary" maxlength="240" value="${esc(p.summary || "")}">`, true)}
      ${field(`Text <small class="muted">(Markdown: # headings, - lists, **bold**, | tables |)</small>`, `<textarea name="body" rows="22" class="mono">${esc(p.body || "")}</textarea>`, true)}
    </form><article class="panel doc-body" id="pePrev" hidden></article>`;
  $("#peView").addEventListener("click", () => { const pr = $("#pePrev"); pr.hidden = !pr.hidden; pr.innerHTML = mdDoc($("#peForm").body.value); if (!pr.hidden) pr.scrollIntoView({ behavior: "smooth" }); });
  $("#peSave").addEventListener("click", async () => {
    const f = $("#peForm"); if (!f.title.value.trim()) return toast("Give it a title");
    const row = { title: f.title.value.trim(), category: f.category.value, audience: f.audience.value, owner_title: f.owner_title.value.trim() || null, effective_date: f.effective_date.value || null,
      review_months: +f.review_months.value || null, requires_ack: f.requires_ack.checked, summary: f.summary.value.trim() || null, body: f.body.value, updated_by: S.profile.display_name, updated_at: new Date().toISOString() };
    if (row.effective_date && row.review_months) { const d = new Date(row.effective_date + "T12:00:00"); d.setMonth(d.getMonth() + row.review_months); row.next_review = d.toLocaleDateString("en-CA"); }
    try {
      const r = id === "new" ? must(await sb.from("doc_policies").insert(row).select("id").single()) : (must(await sb.from("doc_policies").update(row).eq("id", id)), { id });
      toast("Saved"); location.hash = `#/policy/${r.id}`;
    } catch (e) { toast(e.message); }
  });
}

/* ================================================================ invoices */
const invCfg = () => ({ prefix: "INV-", terms_days: 30, payment: "", notes: "Thank you for your business.", ...(S.workspace?.config?.invoice || {}) });
const curSym = (c) => ({ USD: "$", EUR: "€", GBP: "£", CAD: "CA$", AUD: "A$" }[c] || (c ? c + " " : "$"));
const fmtMoney = (n, c) => curSym(c) + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function invTotals(i) {
  const sub = (i.items || []).reduce((s, x) => s + (+x.qty || 0) * (+x.rate || 0), 0), disc = +i.discount || 0, tax = (sub - disc) * (+i.tax_rate || 0) / 100;
  return { sub, disc, tax, total: sub - disc + tax };
}
const invState = (i) => i.status === "Sent" && i.due_date && daysUntil(i.due_date) < 0 ? "Overdue" : i.status;
const INV_PILL = { Draft: "Draft", Sent: "Submitted", Overdue: "Lost", Paid: "Won", Void: "Dropped" };

async function Invoices() {
  const rows = must(await sb.from("inv_invoices").select("*").order("seq", { ascending: false }).limit(1000));
  const tabs = { open: (r) => ["Draft", "Sent"].includes(r.status), overdue: (r) => invState(r) === "Overdue", paid: (r) => r.status === "Paid", all: () => true };
  const out = rows.filter((r) => r.status === "Sent"), owed = out.reduce((s, r) => s + invTotals(r).total, 0), late = out.filter((r) => invState(r) === "Overdue");
  const yr = new Date().getFullYear(), paidYr = rows.filter((r) => r.status === "Paid" && String(r.paid_at || "").startsWith(yr)).reduce((s, r) => s + (+r.paid_amount || invTotals(r).total), 0);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Invoices</h1><p class="muted">Bill clients from your projects and approved hours, print or save as PDF, and track what's been paid.</p></div>
      <div class="actions-row"><a class="btn" href="#/invoice-settings">${icon("cog")}Settings</a><a class="btn primary" href="#/invoice-edit/new">${icon("plus")}New invoice</a></div></div>
    <div class="snap-tiles inv-tiles"><div class="snap-tile"><b>${fmtMoney(owed)}</b><span>Outstanding (${out.length})</span></div><div class="snap-tile ${late.length ? "warn" : ""}"><b>${fmtMoney(late.reduce((s, r) => s + invTotals(r).total, 0))}</b><span>Overdue (${late.length})</span></div><div class="snap-tile"><b>${fmtMoney(paidYr)}</b><span>Paid in ${yr}</span></div></div>
    <div class="filters"><div class="tabs" role="tablist">${[["open", "Open"], ["overdue", "Overdue"], ["paid", "Paid"], ["all", "All"]].map(([k, l]) => `<button role="tab" data-itab="${k}" aria-selected="${DOC.itab === k}">${l} <span class="muted">${rows.filter(tabs[k]).length}</span></button>`).join("")}</div></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Number</th><th>Client</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Total</th></tr></thead>
      <tbody>${rows.filter(tabs[DOC.itab]).map((r) => { const s = invState(r); return `<tr data-href="#/invoice/${r.id}" tabindex="0"><td class="tno">${esc(r.number)}</td><td><b>${esc(r.client_name)}</b>${r.reference ? `<small class="muted" style="display:block">${esc(r.reference)}</small>` : ""}</td>
        <td class="date">${fmtD(r.issue_date)}</td><td class="date">${r.due_date ? (r.status === "Sent" ? dueCell(r.due_date, true) : fmtD(r.due_date)) : "—"}</td><td>${pill(INV_PILL[s]).replace(/>[^<]+</, `>${s}<`)}</td><td class="num">${fmtMoney(invTotals(r).total, r.currency)}</td></tr>`; }).join("")
        || `<tr><td colspan="6" class="empty">${rows.length ? "Nothing in this view." : "No invoices yet."}</td></tr>`}</tbody></table></div></section>`;
  $$("[data-itab]").forEach((b) => b.addEventListener("click", () => { DOC.itab = b.dataset.itab; Invoices(); }));
  rowLinks();
}

async function InvoiceEdit(id) {
  const c = invCfg();
  const [contacts, projects] = await Promise.all([sb.from("contacts").select("id, name, organization, email, location").order("organization").limit(2000).then(must), sb.from("projects").select("id, name, client, rate, status").order("name").then(must)]);
  const due = new Date(); due.setDate(due.getDate() + (+c.terms_days || 30));
  const inv = id === "new" ? { client_name: "", items: [{ description: "", qty: 1, rate: 0 }], issue_date: today(), due_date: due.toLocaleDateString("en-CA"), currency: "USD", tax_rate: 0, discount: 0, notes: c.notes, terms: `Payment due within ${c.terms_days || 30} days.` }
    : must(await sb.from("inv_invoices").select("*").eq("id", id).maybeSingle());
  if (inv.status && inv.status !== "Draft" && !confirm(`This invoice is ${inv.status}. Edit it anyway?`)) { location.hash = `#/invoice/${id}`; return; }
  const projOpt = projects.filter((p) => p.status !== "Closed" || p.id === inv.project_id).map((p) => `<option value="${p.id}" ${p.id === inv.project_id ? "selected" : ""}>${esc(p.name)}${p.client ? " · " + esc(p.client) : ""}</option>`).join("");
  const conOpt = contacts.map((k) => `<option value="${k.id}" ${k.id === inv.contact_id ? "selected" : ""}>${esc(k.organization ? `${k.organization} (${k.name || ""})` : k.name || "")}</option>`).join("");
  $("#main").innerHTML = `
    <p class="crumbs"><a href="#/invoices">Invoices</a> › ${id === "new" ? "New invoice" : esc(inv.number)}</p>
    <div class="page-head"><div><h1>${id === "new" ? "New invoice" : "Edit " + esc(inv.number)}</h1></div><div class="actions-row"><button class="btn primary" id="ieSave">Save</button></div></div>
    <form class="panel form-grid" id="ieForm">
      ${field("From Contacts", `<select name="contact_id"><option value="">Type the client below, or pick a contact</option>${conOpt}</select>`)}
      ${field("Client name *", `<input name="client_name" required value="${esc(inv.client_name)}">`)}
      ${field("Client email", `<input name="client_email" type="email" value="${esc(inv.client_email || "")}">`)}
      ${field("Client address", `<textarea name="client_address" rows="2">${esc(inv.client_address || "")}</textarea>`)}
      ${field("Project", `<select name="project_id"><option value="">None</option>${projOpt}</select>`)}
      ${field("PO / contract reference", `<input name="reference" value="${esc(inv.reference || "")}">`)}
      ${field("Issue date", `<input name="issue_date" type="date" value="${inv.issue_date || ""}">`)}
      ${field("Due date", `<input name="due_date" type="date" value="${inv.due_date || ""}">`)}
      ${field("Currency", `<select name="currency">${opts(["USD", "EUR", "GBP", "CAD", "AUD", "KES", "ZAR", "NGN", "INR", "PKR"], inv.currency)}</select>`)}
    </form>
    <section class="panel"><div class="bill-head"><h2>Line items</h2><div class="actions-row"><button class="btn small" id="ieHours" type="button">${icon("timer")}Add approved hours</button><button class="btn small" id="ieAdd" type="button">${icon("plus")}Add line</button></div></div>
      <div id="ieHoursBox" hidden class="row inv-hours"><label>From<input type="date" id="ihFrom"></label><label>To<input type="date" id="ihTo" value="${today()}"></label><button class="btn small primary" id="ihGo" type="button">Add hours</button><span class="muted small">Approved timesheets on the project above, at its billing rate (or each person's rate).</span></div>
      <div class="table-wrap"><table class="inv-items"><thead><tr><th>Description</th><th class="num">Qty / hours</th><th class="num">Rate</th><th class="num">Amount</th><th></th></tr></thead><tbody id="ieRows"></tbody></table></div>
      <div class="inv-sum" id="ieSum"></div>
      <div class="form-grid" style="margin-top:12px">${field("Discount (amount)", `<input id="ieDisc" type="number" step="0.01" value="${inv.discount || 0}">`)}${field("Tax rate (%)", `<input id="ieTax" type="number" step="0.01" value="${inv.tax_rate || 0}">`)}
        ${field("Notes to the client", `<textarea id="ieNotes" rows="2">${esc(inv.notes || "")}</textarea>`, true)}${field("Terms", `<input id="ieTerms" value="${esc(inv.terms || "")}">`, true)}</div></section>`;
  let items = (inv.items || []).map((x) => ({ ...x }));
  const paint = () => {
    $("#ieRows").innerHTML = items.map((x, i) => `<tr><td><input data-i="${i}" data-k="description" value="${esc(x.description || "")}" placeholder="Service or item"></td><td class="num"><input data-i="${i}" data-k="qty" type="number" step="0.01" value="${x.qty ?? 1}"></td>
      <td class="num"><input data-i="${i}" data-k="rate" type="number" step="0.01" value="${x.rate ?? 0}"></td><td class="num">${fmtMoney((+x.qty || 0) * (+x.rate || 0), $("#ieForm").currency.value)}</td><td><button class="icon-btn" type="button" data-del="${i}" aria-label="Remove line">✕</button></td></tr>`).join("");
    sum();
  };
  const sum = () => { const t = invTotals({ items, discount: $("#ieDisc").value, tax_rate: $("#ieTax").value }), cur = $("#ieForm").currency.value;
    $("#ieSum").innerHTML = `<div><span>Subtotal</span><b>${fmtMoney(t.sub, cur)}</b></div>${t.disc ? `<div><span>Discount</span><b>−${fmtMoney(t.disc, cur)}</b></div>` : ""}${t.tax ? `<div><span>Tax</span><b>${fmtMoney(t.tax, cur)}</b></div>` : ""}<div class="tot"><span>Total</span><b>${fmtMoney(t.total, cur)}</b></div>`; };
  paint();
  $("#ieRows").addEventListener("input", (e) => { const t = e.target; if (t.dataset.i == null) return; items[+t.dataset.i][t.dataset.k] = t.dataset.k === "description" ? t.value : +t.value; if (t.dataset.k !== "description") { const tr = t.closest("tr"); tr.children[3].textContent = fmtMoney((+items[+t.dataset.i].qty || 0) * (+items[+t.dataset.i].rate || 0), $("#ieForm").currency.value); sum(); } });
  $("#ieRows").addEventListener("click", (e) => { const b = e.target.closest("[data-del]"); if (b) { items.splice(+b.dataset.del, 1); paint(); } });
  ["#ieDisc", "#ieTax"].forEach((s) => $(s).addEventListener("input", sum)); $("#ieForm").currency.addEventListener("change", paint);
  $("#ieAdd").addEventListener("click", () => { items.push({ description: "", qty: 1, rate: 0 }); paint(); });
  $("#ieForm").contact_id.addEventListener("change", (e) => { const k = contacts.find((x) => x.id === +e.target.value); if (!k) return; const f = $("#ieForm");
    f.client_name.value = k.organization || k.name || ""; f.client_email.value = k.email || ""; if (!f.client_address.value) f.client_address.value = k.location || ""; });
  $("#ieForm").project_id.addEventListener("change", (e) => { const p = projects.find((x) => x.id === +e.target.value); if (p?.client && !$("#ieForm").client_name.value) $("#ieForm").client_name.value = p.client; });
  $("#ieHours").addEventListener("click", () => { const b = $("#ieHoursBox"); b.hidden = !b.hidden; if (!$("#ihFrom").value) { const d = new Date(); d.setDate(1); $("#ihFrom").value = d.toLocaleDateString("en-CA"); } });
  $("#ihGo").addEventListener("click", async () => {
    const pid = +$("#ieForm").project_id.value; if (!pid) return toast("Pick the project first");
    try {
      const rows = await db.rpc("inv_hours", { p_project: pid, p_from: $("#ihFrom").value, p_to: $("#ihTo").value }), pn = projects.find((p) => p.id === pid)?.name || "";
      if (!rows.length) return toast("No approved hours on that project in those dates");
      items = items.filter((x) => x.description || +x.rate); rows.forEach((r) => items.push({ description: `${pn}: ${r.name}, ${fmtD($("#ihFrom").value)} – ${fmtD($("#ihTo").value)}`, qty: +r.hours, rate: +r.rate }));
      paint(); $("#ieHoursBox").hidden = true; toast(`Added ${rows.length} line${rows.length === 1 ? "" : "s"}`);
    } catch (e) { toast(e.message); }
  });
  $("#ieSave").addEventListener("click", async () => {
    const f = $("#ieForm"); if (!f.client_name.value.trim()) return toast("Add the client's name");
    const p = { client_name: f.client_name.value.trim(), client_email: f.client_email.value.trim() || null, client_address: f.client_address.value.trim() || null, contact_id: f.contact_id.value || null,
      project_id: f.project_id.value || null, reference: f.reference.value.trim() || null, issue_date: f.issue_date.value || today(), due_date: f.due_date.value || null, currency: f.currency.value,
      items: items.filter((x) => x.description || +x.rate).map((x) => ({ description: x.description || "", qty: +x.qty || 0, rate: +x.rate || 0 })), tax_rate: +$("#ieTax").value || 0, discount: +$("#ieDisc").value || 0,
      notes: $("#ieNotes").value.trim() || null, terms: $("#ieTerms").value.trim() || null };
    try {
      const nid = id === "new" ? await db.rpc("inv_create", { p }) : (must(await sb.from("inv_invoices").update({ ...p, updated_by: S.profile.display_name, updated_at: new Date().toISOString() }).eq("id", id)), +id);
      toast("Saved"); location.hash = `#/invoice/${nid}`;
    } catch (e) { toast(e.message); }
  });
}

async function InvoiceView(id) {
  const i = must(await sb.from("inv_invoices").select("*").eq("id", id).maybeSingle());
  if (!i) { $("#main").innerHTML = `<div class="empty">Invoice not found.</div>`; return; }
  const L = legal(), c = invCfg(), t = invTotals(i), s = invState(i), w = S.workspace;
  $("#main").innerHTML = `
    <p class="crumbs no-print"><a href="#/invoices">Invoices</a> › ${esc(i.number)}</p>
    <div class="page-head no-print"><div><h1>${esc(i.number)} ${pill(INV_PILL[s]).replace(/>[^<]+</, `>${s}<`)}</h1><p class="muted">${esc(i.client_name)} · ${fmtMoney(t.total, i.currency)}${i.paid_at ? ` · paid ${fmtD(i.paid_at)}` : ""}</p></div>
      <div class="actions-row"><a class="btn" href="#/invoice-edit/${i.id}">Edit</a><button class="btn" id="ivPrint">${icon("arrow-out")}Print / PDF</button>
        ${i.status === "Draft" ? `<button class="btn primary" id="ivSent">Mark sent</button>` : ""}${i.status === "Sent" ? `<button class="btn primary" id="ivPaid">Mark paid</button>` : ""}
        ${i.client_email ? `<a class="btn" href="mailto:${esc(i.client_email)}?subject=${encodeURIComponent(`Invoice ${i.number} from ${L.name || w.name}`)}&body=${encodeURIComponent(`Hello,\n\nPlease find attached invoice ${i.number} for ${fmtMoney(t.total, i.currency)}, due ${fmtD(i.due_date)}.\n\n${c.payment ? "Payment details:\n" + c.payment + "\n\n" : ""}Thank you,\n${S.profile.display_name}`)}">${icon("send")}Email</a>` : ""}
        ${["Draft", "Sent"].includes(i.status) ? `<button class="btn" id="ivVoid">Void</button>` : ""}</div></div>
    <article class="panel invoice-doc">
      <header class="inv-top"><div>${w.logo_url ? `<img class="inv-logo" src="${esc(w.logo_url)}" alt="">` : ""}<b class="inv-co">${esc(L.name || w.name)}</b>${L.address ? `<div class="muted">${esc(L.address).replace(/\n/g, "<br>")}</div>` : ""}${L.signer_email ? `<div class="muted">${esc(L.signer_email)}</div>` : ""}</div>
        <div class="inv-meta"><h2>INVOICE</h2><div><span>Number</span><b>${esc(i.number)}</b></div><div><span>Issued</span><b>${fmtD(i.issue_date)}</b></div>${i.due_date ? `<div><span>Due</span><b>${fmtD(i.due_date)}</b></div>` : ""}${i.reference ? `<div><span>Reference</span><b>${esc(i.reference)}</b></div>` : ""}</div></header>
      <div class="inv-bill"><span class="muted small">BILL TO</span><b>${esc(i.client_name)}</b>${i.client_address ? `<div>${esc(i.client_address).replace(/\n/g, "<br>")}</div>` : ""}${i.client_email ? `<div>${esc(i.client_email)}</div>` : ""}</div>
      <table class="inv-lines"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${(i.items || []).map((x) => `<tr><td>${esc(x.description)}</td><td class="num">${(+x.qty).toLocaleString()}</td><td class="num">${fmtMoney(x.rate, i.currency)}</td><td class="num">${fmtMoney((+x.qty || 0) * (+x.rate || 0), i.currency)}</td></tr>`).join("")}</tbody></table>
      <div class="inv-sum"><div><span>Subtotal</span><b>${fmtMoney(t.sub, i.currency)}</b></div>${t.disc ? `<div><span>Discount</span><b>−${fmtMoney(t.disc, i.currency)}</b></div>` : ""}${t.tax ? `<div><span>Tax (${+i.tax_rate}%)</span><b>${fmtMoney(t.tax, i.currency)}</b></div>` : ""}<div class="tot"><span>Total due</span><b>${fmtMoney(t.total, i.currency)}</b></div></div>
      ${c.payment ? `<div class="inv-pay"><b>How to pay</b><div>${esc(c.payment).replace(/\n/g, "<br>")}</div></div>` : ""}
      ${i.notes || i.terms ? `<p class="muted">${esc([i.terms, i.notes].filter(Boolean).join(" "))}</p>` : ""}</article>`;
  const upd = async (row, msg) => { try { must(await sb.from("inv_invoices").update({ ...row, updated_by: S.profile.display_name, updated_at: new Date().toISOString() }).eq("id", i.id)); toast(msg); InvoiceView(id); } catch (e) { toast(e.message); } };
  $("#ivPrint").addEventListener("click", () => { const t0 = document.title; document.title = `${i.number} ${i.client_name}`; window.print(); document.title = t0; });
  $("#ivSent")?.addEventListener("click", () => upd({ status: "Sent", sent_at: new Date().toISOString() }, "Marked sent"));
  $("#ivVoid")?.addEventListener("click", () => { if (confirm("Void this invoice? It keeps its number but no longer counts.")) upd({ status: "Void" }, "Voided"); });
  $("#ivPaid")?.addEventListener("click", () => {
    $("#drawerTitle").textContent = `Mark ${i.number} paid`;
    $("#drawerBody").innerHTML = `<form class="form-grid" id="payForm">${field("Paid on", `<input name="d" type="date" value="${today()}">`)}${field("Amount received", `<input name="a" type="number" step="0.01" value="${t.total.toFixed(2)}">`)}${field("Note (check no., transfer ref.)", `<input name="n">`, true)}<div class="actions-row"><button class="btn primary">Mark paid</button></div></form>`;
    openDrawer();
    $("#payForm").addEventListener("submit", (e) => { e.preventDefault(); const f = e.target; closeDrawer(); upd({ status: "Paid", paid_at: f.d.value, paid_amount: +f.a.value, paid_note: f.n.value || null }, "Marked paid"); });
  });
}

async function InvoiceSettings() {
  const c = invCfg();
  $("#main").innerHTML = `<p class="crumbs"><a href="#/invoices">Invoices</a> › Settings</p>
    <div class="page-head"><div><h1>Invoice settings</h1><p class="muted">Your company name and address come from <a href="#/templates">Agreements → Templates → Your company's details</a>; your logo from Workspace settings.</p></div></div>
    <form class="panel form-grid" id="isForm">
      ${field("Number prefix", `<input name="prefix" value="${esc(c.prefix)}">`)}${field("Start numbering at", `<input name="start" type="number" min="1" value="${esc(c.start || "")}" placeholder="1">`)}
      ${field("Default payment terms (days)", `<input name="terms_days" type="number" min="0" value="${esc(c.terms_days)}">`)}
      ${field("How to pay (printed on every invoice)", `<textarea name="payment" rows="4" placeholder="Bank transfer to …, ACH routing …, or check payable to …">${esc(c.payment || "")}</textarea>`, true)}
      ${field("Default note", `<input name="notes" value="${esc(c.notes || "")}">`, true)}
      <div class="actions-row"><button class="btn primary">Save</button></div></form>`;
  $("#isForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target;
    const invoice = { prefix: f.prefix.value, start: f.start.value ? +f.start.value : null, terms_days: +f.terms_days.value || 30, payment: f.payment.value, notes: f.notes.value };
    try { await db.rpc("update_workspace", { p: { config: { ...(S.workspace.config || {}), invoice } } }); await loadWorkspace(); toast("Saved"); } catch (err) { toast(err.message); }
  });
}

/* ================================================================ compliance calendar */
const nextDue = (d, rep) => { if (!d || rep === "Once") return null; const x = new Date(d + "T12:00:00");
  const m = { Monthly: 1, Quarterly: 3, Yearly: 12, "Every 2 years": 24, "Every 3 years": 36, "Every 5 years": 60 }[rep] || 12; x.setMonth(x.getMonth() + m); return x.toLocaleDateString("en-CA"); };
async function Compliance() {
  const rows = must(await sb.from("doc_compliance").select("*").order("due_date", { ascending: true, nullsFirst: false }));
  const open = rows.filter((r) => r.status === "Open"), late = open.filter((r) => r.due_date && daysUntil(r.due_date) < 0), soon = open.filter((r) => r.due_date && daysUntil(r.due_date) >= 0 && daysUntil(r.due_date) <= 30);
  const view = { open: open, done: rows.filter((r) => r.status !== "Open"), all: rows }[DOC.ctab];
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Compliance calendar</h1><p class="muted">Registrations, licenses, tax filings, insurance and required postings, with their due dates. Mark one done and repeating items roll to the next date.</p></div>
      ${isAdmin() ? `<div class="actions-row"><button class="btn" id="cmSug">${icon("book")}Add common items</button><button class="btn primary" id="cmNew">${icon("plus")}Add item</button></div>` : ""}</div>
    <div class="snap-tiles inv-tiles"><div class="snap-tile ${late.length ? "warn" : ""}"><b>${late.length}</b><span>Overdue</span></div><div class="snap-tile"><b>${soon.length}</b><span>Due in 30 days</span></div><div class="snap-tile"><b>${open.length}</b><span>Open</span></div></div>
    <div class="filters"><div class="tabs" role="tablist">${[["open", "Open"], ["done", "Done"], ["all", "All"]].map(([k, l]) => `<button role="tab" data-ctab="${k}" aria-selected="${DOC.ctab === k}">${l}</button>`).join("")}</div></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th>Who it's with</th><th>Due</th><th>Repeats</th><th>Owner</th>${isAdmin() ? "<th></th>" : ""}</tr></thead>
      <tbody>${view.map((r) => `<tr data-cm="${r.id}" tabindex="0"><td><b>${esc(r.title)}</b>${r.notes ? `<small class="muted" style="display:block">${esc(r.notes)}</small>` : ""}${r.link ? ` <a href="${esc(r.link)}" target="_blank" rel="noopener" class="small">Open</a>` : ""}</td><td>${esc(r.category)}</td><td>${esc(r.authority || "")}</td>
        <td class="date">${r.status === "Open" ? (r.due_date ? dueCell(r.due_date, true) : '<span class="muted">Set a date</span>') : `${esc(r.status)}${r.last_done ? " " + fmtD(r.last_done) : ""}`}</td><td>${esc(r.repeats)}</td><td>${esc(S.team.find((u) => u.id === r.owner_id)?.display_name || "")}</td>
        ${isAdmin() ? `<td>${r.status === "Open" ? `<button class="btn small" data-done="${r.id}">Done</button>` : ""}</td>` : ""}</tr>`).join("")
        || `<tr><td colspan="7" class="empty">${rows.length ? "Nothing here." : isAdmin() ? "Nothing yet. Start with the common items for a small US company." : "Nothing yet."}</td></tr>`}</tbody></table></div></section>`;
  $$("[data-ctab]").forEach((b) => b.addEventListener("click", () => { DOC.ctab = b.dataset.ctab; Compliance(); }));
  if (!isAdmin()) return;
  $("#cmNew").addEventListener("click", () => compEdit({}));
  $("#cmSug").addEventListener("click", () => compSuggest(rows));
  $$("tr[data-cm]").forEach((tr) => tr.addEventListener("click", (e) => { if (e.target.closest("a,button")) return; compEdit(rows.find((r) => r.id === +tr.dataset.cm)); }));
  $$("[data-done]").forEach((b) => b.addEventListener("click", async () => {
    const r = rows.find((x) => x.id === +b.dataset.done), nd = nextDue(r.due_date, r.repeats);
    try { must(await sb.from("doc_compliance").update(nd ? { due_date: nd, last_done: today(), updated_by: S.profile.display_name } : { status: "Done", last_done: today(), updated_by: S.profile.display_name }).eq("id", r.id));
      toast(nd ? `Done. Next due ${fmtD(nd)}` : "Done"); Compliance(); } catch (e) { toast(e.message); }
  }));
}
function compEdit(r) {
  $("#drawerTitle").textContent = r.id ? "Edit item" : "Add item";
  $("#drawerBody").innerHTML = `<form class="form-grid" id="cmForm">
    ${field("What *", `<input name="title" required value="${esc(r.title || "")}">`, true)}${field("Category", `<select name="category">${opts(COMP_CATS, r.category || "Registration")}</select>`)}
    ${field("Who it's with", `<input name="authority" value="${esc(r.authority || "")}" placeholder="IRS, Secretary of State, insurer…">`)}${field("Due date", `<input name="due_date" type="date" value="${r.due_date || ""}">`)}
    ${field("Repeats", `<select name="repeats">${opts(REPEATS, r.repeats || "Yearly")}</select>`)}${field("Owner", `<select name="owner_id"><option value="">—</option>${S.team.filter((u) => u.active && isStaffRole(u.role)).map((u) => `<option value="${u.id}" ${u.id === r.owner_id ? "selected" : ""}>${esc(u.display_name)}</option>`).join("")}</select>`)}
    ${field("Status", `<select name="status">${opts(["Open", "Done", "Not needed"], r.status || "Open")}</select>`)}${field("Reference / account no.", `<input name="reference" value="${esc(r.reference || "")}">`)}
    ${field("Link", `<input name="link" type="url" value="${esc(r.link || "")}" placeholder="https://">`, true)}${field("Notes", `<textarea name="notes" rows="3">${esc(r.notes || "")}</textarea>`, true)}
    <div class="actions-row">${r.id ? `<button class="btn danger" type="button" id="cmDel">Delete</button>` : ""}<button class="btn primary">Save</button></div></form>`;
  openDrawer();
  $("#cmForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target;
    const row = { title: f.title.value.trim(), category: f.category.value, authority: f.authority.value.trim() || null, due_date: f.due_date.value || null, repeats: f.repeats.value, owner_id: f.owner_id.value || null,
      status: f.status.value, reference: f.reference.value.trim() || null, link: f.link.value.trim() || null, notes: f.notes.value.trim() || null, updated_by: S.profile.display_name };
    try { must(r.id ? await sb.from("doc_compliance").update(row).eq("id", r.id) : await sb.from("doc_compliance").insert(row)); closeDrawer(); toast("Saved"); Compliance(); } catch (err) { toast(err.message); }
  });
  $("#cmDel")?.addEventListener("click", async () => { if (!confirm("Delete this item?")) return; try { must(await sb.from("doc_compliance").delete().eq("id", r.id)); closeDrawer(); Compliance(); } catch (err) { toast(err.message); } });
}
function compSuggest(rows) {
  const have = new Set(rows.map((r) => r.title.toLowerCase()));
  $("#drawerTitle").textContent = "Common items for a small US company";
  $("#drawerBody").innerHTML = `<p class="muted">Pick the ones that apply to you, then set the real due dates. Rules depend on your state, size and contracts.</p>
    <div class="lib-list">${COMPLIANCE_SUGGESTIONS.map((c, i) => `<label class="lib-item"><input type="checkbox" value="${i}" ${have.has(c.title.toLowerCase()) ? "disabled" : ""}><span><b>${esc(c.title)}</b> <small class="muted">${esc(c.authority)} · ${esc(c.repeats)}</small><small>${esc(c.note)}</small></span></label>`).join("")}</div>
    <div class="actions-row" style="margin-top:12px"><button class="btn primary" id="sugAdd" type="button">Add selected</button></div>`;
  openDrawer();
  $("#sugAdd").addEventListener("click", async () => {
    const pick = $$(".lib-item input:checked").map((c) => COMPLIANCE_SUGGESTIONS[+c.value]); if (!pick.length) return toast("Pick at least one");
    try { must(await sb.from("doc_compliance").insert(pick.map((c) => ({ title: c.title, category: c.category, authority: c.authority, repeats: c.repeats, notes: c.note, updated_by: S.profile.display_name })))); closeDrawer(); toast(`Added ${pick.length}. Set their due dates.`); Compliance(); } catch (e) { toast(e.message); }
  });
}

/* ================================================================ hook into the Documents router (agreements.js) */
Object.assign(routes, { policies: Policies, policy: (id) => PolicyView(+id), "policy-edit": (id) => PolicyEdit(id === "new" ? "new" : +id),
  invoices: Invoices, invoice: (id) => InvoiceView(+id), "invoice-edit": (id) => InvoiceEdit(id === "new" ? "new" : +id), "invoice-settings": InvoiceSettings, compliance: Compliance });
