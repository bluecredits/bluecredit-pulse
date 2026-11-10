/* Pulse · Agreements — create contracts from templates, send them for e-signature (or attach a signed copy),
   and manage them through amendments, expiry or termination, to close-out.
   The database enforces the rules (see "Agreements" in schema.sql): text locks when sent, only signers sign,
   contractors see only their own agreements. Templates and rendering live in templates.js. */
"use strict";

const A = window.PULSE_AGREEMENTS;
const AG = { tab: "open", q: "", form: null };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const isAdmin = () => S.profile?.role === "admin";
const isStaff = () => S.profile && isStaffRole(S.profile.role);
const ref = (a) => "AGR-" + String(a.number || a.id).padStart(4, "0");
const SITE = () => location.origin + location.pathname.replace(/agreements\/?(index\.html)?$/, "");
const STATUS_PILL = { Draft: "Draft", "Out for signature": "Submitted", Active: "Active", Expired: "Dormant", Terminated: "Lost", "Closed out": "Won", Voided: "Dropped", Declined: "Lost" };
const spill = (s) => pill(STATUS_PILL[s] || s).replace(/>[^<]+</, `>${esc(s)}<`);
const legal = () => S.workspace?.config?.legal || {};
const SIGNER_COLS = "id, agreement_id, role, label, sign_order, name, email, title, user_id, token_expires_at, status, viewed_at, consent_at, signed_at, signature_kind, signature_data, ip, user_agent, decline_reason";

/* ---------------- templates: built-ins, replaced by the workspace's customized copy when there is one */
async function loadTemplates() {
  let custom = [];
  try { custom = must(await sb.from("agreement_templates").select("*").eq("active", true).order("name")); } catch { custom = []; }
  const byKey = Object.fromEntries(custom.map((t) => [t.key, t]));
  const list = A.BUILTIN_TEMPLATES.map((b) => byKey[b.key] ? { ...b, ...pickCustom(byKey[b.key]), customized: true, dbId: byKey[b.key].id } : b);
  custom.filter((t) => !A.BUILTIN_TEMPLATES.some((b) => b.key === t.key)).forEach((t) => list.push({ ...pickCustom(t), customized: true, dbId: t.id, icon: "clipboard" }));
  return list;
}
function pickCustom(t) {
  const base = A.BUILTIN_TEMPLATES.find((b) => b.key === (t.based_on || t.key));
  return { key: t.key, kind: t.kind, name: t.name, blurb: t.blurb || base?.blurb || "", body: t.body,
    fields: t.fields?.length ? t.fields : base?.fields || [], signers: t.signers?.length ? t.signers : base?.signers || [{ role: "company", label: "Your company" }, { role: "party", label: "Other party" }],
    checklist: t.checklist || [], amendment: base?.amendment };
}

/* ================================================================ list */
async function List() {
  const rows = must(await sb.from("agreements").select("id, number, title, party_name, template_name, kind, status, sent_at, executed_at, end_date, value, currency, updated_at, parent_id").order("updated_at", { ascending: false }).limit(1000));
  const soon = (r) => r.status === "Active" && r.end_date && daysUntil(r.end_date) <= 60;
  const groups = { open: (r) => ["Draft", "Out for signature", "Declined"].includes(r.status), active: (r) => r.status === "Active", ending: soon,
    closeout: (r) => ["Expired", "Terminated"].includes(r.status), closed: (r) => ["Closed out", "Voided"].includes(r.status), all: () => true };
  const q = AG.q.toLowerCase();
  const list = rows.filter(groups[AG.tab]).filter((r) => !q || [ref(r), r.title, r.party_name, r.template_name].join(" ").toLowerCase().includes(q));
  const n = (k) => rows.filter(groups[k]).length;
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Agreements</h1><p class="muted">Teaming agreements, consulting contracts, confidentiality agreements and amendments, from draft to close-out.</p></div>
      ${isStaff() ? `<div class="actions-row"><a class="btn primary" href="#/new">${icon("plus")}New agreement</a></div>` : ""}</div>
    <div class="filters"><div class="tabs" role="tablist">${[["open", "In progress"], ["active", "Active"], ["ending", "Ending in 60 days"], ["closeout", "To close out"], ["closed", "Closed"], ["all", "All"]].map(([k, l]) =>
      `<button role="tab" data-tab="${k}" aria-selected="${AG.tab === k}">${l} <span class="muted">${n(k)}</span></button>`).join("")}</div>
      <input type="search" id="agq" placeholder="Search agreements…" value="${esc(AG.q)}"></div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Ref</th><th>Agreement</th><th>With</th><th>Status</th><th>Signed</th><th>Ends</th><th class="num">Value</th></tr></thead>
      <tbody>${list.map((r) => `<tr data-agr="${r.id}" tabindex="0"><td class="tno">${ref(r)}</td><td><b>${esc(r.title)}</b><small class="muted" style="display:block">${esc(r.template_name)}${r.parent_id ? " · amendment" : ""}</small></td>
        <td>${esc(r.party_name || "")}</td><td>${spill(r.status)}</td><td class="date">${r.executed_at ? short(r.executed_at) : r.sent_at ? "Sent " + short(r.sent_at) : "—"}</td>
        <td class="date">${r.end_date ? dueCell(r.end_date, r.status === "Active") : "—"}</td><td class="num">${r.value ? (r.currency && r.currency !== "USD" ? esc(r.currency) + " " : "$") + Number(r.value).toLocaleString() : ""}</td></tr>`).join("")
        || `<tr><td colspan="7" class="empty">${rows.length ? "Nothing in this view." : "No agreements yet. Create one from a template."}</td></tr>`}</tbody></table></div></section>`;
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { AG.tab = b.dataset.tab; List(); }));
  $("#agq").addEventListener("input", (e) => { AG.q = e.target.value; clearTimeout(AG.t); AG.t = setTimeout(() => List().then(() => { const i = $("#agq"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 250); });
  $$("[data-agr]").forEach((r) => r.addEventListener("click", () => (location.hash = `#/view/${r.dataset.agr}`)));
}

/* ================================================================ create / edit */
async function New(param) {
  if (!isStaff()) return List();
  const p = new URLSearchParams(param || "");
  const tpls = await loadTemplates();
  if (!p.get("template")) {
    $("#main").innerHTML = `<div class="page-head"><div><h1>New agreement</h1><p class="muted">Pick a template. You'll fill in the details next and see the agreement as you type.</p></div></div>
      <div class="appr-grid">${tpls.filter((t) => !t.amendment || p.get("parent")).map((t) => `<a class="appr-card tpl-card" href="#/new?${new URLSearchParams({ ...Object.fromEntries(p), template: t.key })}">
        <header>${icon(t.icon || "clipboard")}<div><h3>${esc(t.name)}</h3>${t.customized ? `<span class="pill s-active">Your wording</span>` : ""}</div></header><p class="appr-desc">${esc(t.blurb)}</p></a>`).join("")}</div>`;
    return;
  }
  const tpl = tpls.find((t) => t.key === p.get("template"));
  if (!tpl) { toast("Template not found"); location.hash = "#/new"; return; }
  // starting values: company details, governing law, today's date, then whatever the link brings (onboarding person, contact, original agreement)
  const v = {}, today_ = today();
  for (const f of A.templateFields(tpl)) {
    if (f.from) v[f.key] = f.from.split(".").reduce((o, k) => o?.[k], { legal: legal() }) ?? "";
    if (!v[f.key] && f.default) v[f.key] = f.default === "today" ? today_ : f.default;
  }
  if (!v.company_name) v.company_name = S.workspace.name;
  const meta = { template_key: tpl.key, template_name: tpl.name, kind: tpl.kind, onboarding_id: p.get("onboarding") || "", contact_id: p.get("contact") || "", project_id: p.get("project") || "", parent_id: p.get("parent") || "" };
  if (meta.onboarding_id) {
    const o = must(await sb.from("onboardings").select("*").eq("id", meta.onboarding_id).maybeSingle());
    if (o) Object.assign(v, { party_name: o.firm || o.name, party_signer_name: o.name, party_signer_email: o.email || "", party_signer_phone: o.phone || "",
      party_signer_title: o.firm ? o.role_title || "" : "", relationship: o.kind === "Employee" ? "Employee" : o.kind === "Advisor" ? "Advisor" : "Consultant",
      services: o.role_title || v.services || "", start_date: o.start_date || v.start_date, end_date: o.end_date || "", fee_rate: o.rate ?? "",
      fee_type: { hour: "Hourly", day: "Daily", month: "Monthly retainer", fixed: "Fixed fee" }[o.rate_unit] || v.fee_type });
    if (tpl.kind === "confidentiality" || tpl.kind === "employment") v.party_name = o.name;
    if (tpl.kind === "employment") Object.assign(v, { position_title: o.role_title || v.position_title || "", pay_rate: o.rate ?? v.pay_rate ?? "", pay_basis: o.rate_unit === "hour" ? "Hourly" : "Annual salary" });
  }
  if (meta.contact_id) {
    const c = must(await sb.from("contacts").select("*").eq("id", meta.contact_id).maybeSingle());
    if (c) Object.assign(v, { party_name: c.organization || c.name, party_signer_name: c.name, party_signer_email: c.email || "", party_signer_phone: c.phone || "", party_signer_title: c.role || "", party_address: c.location || "" });
  }
  if (meta.parent_id) {
    const par = must(await sb.from("agreements").select("*").eq("id", meta.parent_id).maybeSingle());
    if (par) {
      const kids = must(await sb.from("agreements").select("id").eq("parent_id", par.id)).length;
      Object.assign(v, Object.fromEntries(Object.entries(par.fields || {}).filter(([k]) => /^(company|party)_/.test(k))),
        { original_title: par.title, original_ref: ref(par), original_date: (par.executed_at || par.created_at || "").slice(0, 10), amendment_no: String(kids + 1) });
      Object.assign(meta, { onboarding_id: par.onboarding_id || "", project_id: par.project_id || "", contact_id: par.contact_id || "" });
    }
  }
  AG.form = { id: null, tpl, v, meta, special: [], exhibits: [], title: "" };
  renderForm();
}
async function Edit(id) {
  const a = must(await sb.from("agreements").select("*").eq("id", id).single());
  if (a.status !== "Draft") { location.hash = `#/view/${id}`; return; }
  const tpl = (await loadTemplates()).find((t) => t.key === a.template_key);
  if (!tpl) { toast("This agreement's template no longer exists."); return; }
  const { special_provisions = [], exhibits = [], ...v } = a.fields || {};
  AG.form = { id: a.id, tpl, v, special: special_provisions, exhibits, title: a.title, titleTouched: true,
    meta: { template_key: a.template_key, template_name: a.template_name, kind: a.kind, onboarding_id: a.onboarding_id || "", contact_id: a.contact_id || "", project_id: a.project_id || "", parent_id: a.parent_id || "" } };
  renderForm();
}
function fieldInput(f, v) {
  const val = v[f.key] ?? "", req = f.required ? "required" : "", attrs = `name="${f.key}" ${req} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""}`;
  if (f.type === "select") return `<select ${attrs}>${f.options.map((o) => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  if (f.type === "yesno") return `<select ${attrs}><option value="yes" ${val === "yes" ? "selected" : ""}>Yes</option><option value="no" ${val !== "yes" ? "selected" : ""}>No</option></select>`;
  if (f.type === "lines" || f.type === "text") return `<textarea ${attrs} rows="${f.type === "lines" ? 4 : 3}">${esc(val)}</textarea>`;
  if (f.type === "country") return `<select ${attrs}>${Object.keys(A.JURISDICTIONS).map((c) => `<option ${c === val ? "selected" : ""}>${esc(c)}</option>`).join("")}<option value="__other" ${val && !A.JURISDICTIONS[val] ? "selected" : ""}>Other country…</option></select>
    ${val && !A.JURISDICTIONS[val] ? `<input name="law_country_other" value="${esc(val)}" placeholder="Country" required>` : ""}`;
  if (f.type === "region") {
    const regs = A.JURISDICTIONS[v.law_country]?.regions || [];
    return regs.length ? `<select ${attrs}><option value="">Choose…</option>${regs.map((r) => `<option ${r === val ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>`
      : `<input ${attrs} value="${esc(val)}" placeholder="Optional (e.g. a county, state or city)">`;
  }
  return `<input ${attrs} type="${f.type === "date" ? "date" : f.type === "number" ? "number" : f.type === "email" ? "email" : "text"}" ${f.type === "number" ? 'step="any"' : ""} value="${esc(val)}">`;
}
function renderForm() {
  const F = AG.form, fields = A.templateFields(F.tpl), groups = {};
  fields.forEach((f) => (groups[f.group || "Details"] ||= []).push(f));
  const warnFor = (f) => f.warn === "noncompete" && F.v.noncompete === "yes" ? A.noncompeteWarning(F.v.law_country, F.v.law_region) : "";
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${F.id ? "Edit draft" : "New " + esc(F.tpl.name)}</h1><p class="muted">Fill in anything highlighted in the preview. Nothing is sent until you choose <b>Send for signature</b>.</p></div>
      <div class="actions-row"><button class="btn" id="saveDraft">Save draft</button><button class="btn primary" id="toSend">${icon("send")}Send for signature…</button></div></div>
    <div class="agr-editor">
      <form id="agrForm" class="agr-form" novalidate>
        <section class="panel"><label>Agreement title<input name="__title" value="${esc((F.autoTitle = F.titleTouched || F.id ? F.title : defaultTitle(), F.titleTouched || F.id ? F.title : F.autoTitle))}" required></label></section>
        ${Object.entries(groups).map(([g, fs]) => `<section class="panel"><h2>${esc(g)}</h2><div class="form-grid">${fs.filter((f) => !f.showIf || F.v[f.showIf] === "yes").map((f) =>
          `<label class="${["lines", "text"].includes(f.type) ? "wide" : ""}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}${fieldInput(f, F.v)}${warnFor(f) ? `<small class="warn">${esc(warnFor(f))}</small>` : ""}</label>`).join("")}</div></section>`).join("")}
        <section class="panel"><h2>Special provisions <small>added as numbered sections at the end</small></h2>
          <div id="specials">${F.special.map((s, i) => specialRow(s, i)).join("")}</div>
          <button class="btn small" type="button" id="addSpecial">${icon("plus")}Add a special provision</button></section>
        <section class="panel"><h2>Exhibits <small>attached after the signatures; one standard clause makes them part of the agreement</small></h2>
          <div id="exhibits">${F.exhibits.map((x, i) => exhibitRow(x, i)).join("")}</div>
          <div class="actions-row ex-add">${F.exhibits.some((x) => /statement of work/i.test(x.title || "")) ? "" : `<button class="btn small" type="button" data-ex-add="sow">${icon("plus")}Statement of Work</button>`}
            <select id="exAddMore" aria-label="Add another exhibit"><option value="">Add another exhibit…</option>${A.EXHIBIT_PRESETS.filter((p) => p.key !== "sow").map((p) => `<option value="${p.key}">${esc(p.title || "Other (blank)")}</option>`).join("")}<option value="sow">Statement of Work</option></select></div>
          <p class="muted small">Type it (<code># heading</code>, <code>- bullet</code>, <code>1. numbered</code>; <code>[[ ]]</code> marks something still to fill in) or attach a PDF or Word file. An attached file is identified in the agreement by its fingerprint, so it can't be swapped after signing.</p></section>
        <section class="panel"><h2>Link it to</h2><div class="form-grid" id="links"></div></section>
      </form>
      <aside class="agr-preview"><div class="agr-preview-head"><b>Preview</b><span class="muted small" id="blankCount"></span></div><div class="agr-doc" id="preview"></div></aside>
    </div>`;
  fillLinks();
  const form = $("#agrForm");
  form.addEventListener("input", onFormChange);
  form.addEventListener("change", (e) => { onFormChange(); if (["law_country", "insurance", "noncompete", "law_region"].includes(e.target.name) || e.target.name === "law_country") renderFormKeep(); });
  $("#addSpecial").addEventListener("click", () => { collect(); F.special.push({ title: "", text: "" }); renderFormKeep(); $$("#specials [data-sp-title]").at(-1)?.focus(); });
  $("#specials").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sp-act]"); if (!b) return; collect();
    const i = +b.dataset.i, act = b.dataset.spAct;
    if (act === "del") F.special.splice(i, 1);
    if (act === "up" && i > 0) [F.special[i - 1], F.special[i]] = [F.special[i], F.special[i - 1]];
    if (act === "down" && i < F.special.length - 1) [F.special[i + 1], F.special[i]] = [F.special[i], F.special[i + 1]];
    renderFormKeep();
  });
  const addEx = (key) => { collect(); const p = A.EXHIBIT_PRESETS.find((x) => x.key === key); if (!p) return; F.exhibits.push({ title: p.title, mode: "text", text: p.text(A.exhibitWho(F.tpl.kind)) }); renderFormKeep(); $$("#exhibits [data-ex-title]").at(-1)?.focus(); };
  $$("[data-ex-add]").forEach((b) => b.addEventListener("click", () => addEx(b.dataset.exAdd)));
  $("#exAddMore").addEventListener("change", (e) => addEx(e.target.value));
  $("#exhibits").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ex-act]"); if (!b) return; collect();
    const i = +b.dataset.i, act = b.dataset.exAct, x = F.exhibits[i];
    if (act === "del") { if (x.file_id && !confirm(`Remove ${x.title || "this exhibit"} and its attached file?`)) return; await dropExFile(x); F.exhibits.splice(i, 1); }
    if (act === "up" && i > 0) [F.exhibits[i - 1], F.exhibits[i]] = [F.exhibits[i], F.exhibits[i - 1]];
    if (act === "down" && i < F.exhibits.length - 1) [F.exhibits[i + 1], F.exhibits[i]] = [F.exhibits[i], F.exhibits[i + 1]];
    if (act === "text" && x.file_id) { if (!confirm("Type this exhibit instead? The attached file will be removed.")) return; await dropExFile(x); }
    if (act === "text" || act === "file") x.mode = act;
    if (act === "unfile") { await dropExFile(x); x.mode = "file"; }
    renderFormKeep();
    if (F.id && ["del", "unfile", "text"].includes(act)) saveDraft();
  });
  $("#exhibits").addEventListener("change", (e) => { if (e.target.matches("[data-ex-file]")) attachExFile(+e.target.dataset.exFile, e.target.files[0]); });
  $("#saveDraft").addEventListener("click", () => saveDraft().then((id) => id && toast("Draft saved")));
  $("#toSend").addEventListener("click", async () => { const id = await saveDraft(); if (id) sendDialog(id); });
  updatePreview();
}
function renderFormKeep() { const y = window.scrollY; renderForm(); window.scrollTo(0, y); }
function specialRow(s, i) {
  return `<div class="sp-row"><input data-sp-title="${i}" value="${esc(s.title)}" placeholder="Heading, e.g. Key Personnel" aria-label="Heading">
    <div class="sp-btns"><button type="button" class="btn small" data-sp-act="up" data-i="${i}" aria-label="Move up">↑</button><button type="button" class="btn small" data-sp-act="down" data-i="${i}" aria-label="Move down">↓</button>
    <button type="button" class="btn small danger" data-sp-act="del" data-i="${i}">Remove</button></div>
    <textarea data-sp-text="${i}" rows="3" placeholder="The provision's text" aria-label="Text">${esc(s.text)}</textarea></div>`;
}
function exhibitRow(x, i) {
  const letter = String.fromCharCode(A.exhibitStart(AG.form.tpl.body) + i), file = x.mode === "file";
  return `<div class="ex-row" data-ex="${i}"><div class="ex-head"><b class="ex-letter">Exhibit ${letter}</b>
      <input data-ex-title="${i}" value="${esc(x.title || "")}" placeholder="Title, e.g. Statement of Work" aria-label="Exhibit ${letter} title">
      <div class="sp-btns"><button type="button" class="btn small" data-ex-act="up" data-i="${i}" aria-label="Move up">↑</button><button type="button" class="btn small" data-ex-act="down" data-i="${i}" aria-label="Move down">↓</button>
      <button type="button" class="btn small danger" data-ex-act="del" data-i="${i}">Remove</button></div></div>
    <div class="seg ex-mode" role="group" aria-label="How the exhibit is provided"><button type="button" data-ex-act="text" data-i="${i}" aria-pressed="${!file}">Type it</button><button type="button" data-ex-act="file" data-i="${i}" aria-pressed="${file}">Attach a file</button></div>
    ${file ? (x.file_id ? `<div class="ex-file">${icon("clipboard", "ic tiny")} <b>${esc(x.file_name)}</b> <span class="muted small">${Math.round((x.size || 0) / 1024)} KB · fingerprint ${esc((x.sha256 || "").slice(0, 12))}…</span>
          <button type="button" class="btn small" data-ex-act="unfile" data-i="${i}">Replace</button></div>`
        : `<label class="ex-drop">PDF, Word or image, up to 10 MB<input type="file" data-ex-file="${i}" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"></label>`)
      : `<textarea data-ex-text="${i}" rows="9" aria-label="Exhibit ${letter} text">${esc(x.text || "")}</textarea>`}</div>`;
}
async function dropExFile(x) {
  if (!x.file_id) return;
  try { await db.rpc("agr_exhibit_remove", { p_file: +x.file_id }); } catch (e) { toast(e.message); }
  delete x.file_id; delete x.file_name; delete x.sha256; delete x.size;
}
async function attachExFile(i, file) {
  const F = AG.form; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast("That file is over 10 MB."); return; }
  collect();
  const id = F.id || await saveDraft(); if (!id) return;   // the file belongs to the draft, so save it first
  toast("Attaching…");
  try {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("Couldn't read that file.")); r.readAsDataURL(file); });
    const f = await db.rpc("agr_exhibit_add", { p_id: id, p_name: file.name, p_mime: file.type || "application/octet-stream", p_b64: b64 });
    Object.assign(F.exhibits[i], { mode: "file", file_id: f.id, file_name: f.name, sha256: f.sha256, size: f.size });
    if (!F.exhibits[i].title) F.exhibits[i].title = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    renderFormKeep(); await saveDraft(); toast("Exhibit attached");
  } catch (e) { toast(e.message); }
}
function defaultTitle() { const F = AG.form; return F.tpl.amendment ? `Amendment ${F.v.amendment_no || ""} to ${F.v.original_title || "agreement"}` : `${F.tpl.name}${F.v.party_name ? " — " + F.v.party_name : ""}`; }
async function fillLinks() {
  const F = AG.form;
  const [onb, proj] = await Promise.all([sb.from("onboardings").select("id, name, status").order("name"), sb.from("projects").select("id, name, status").order("name")]);
  $("#links").innerHTML = `
    <label>Onboarding record<select name="__onboarding"><option value="">None</option>${(onb.data || []).map((o) => `<option value="${o.id}" ${String(o.id) === String(F.meta.onboarding_id) ? "selected" : ""}>${esc(o.name)} · ${esc(o.status)}</option>`).join("")}</select></label>
    <label>Project<select name="__project"><option value="">None</option>${(proj.data || []).filter((x) => x.status !== "Closed" || String(x.id) === String(F.meta.project_id)).map((x) => `<option value="${x.id}" ${String(x.id) === String(F.meta.project_id) ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    <p class="muted small" style="grid-column:1/-1">When it's signed, the onboarding checklist ticks the matching item and the signed copy shows on the person's record${proj.data?.length ? " and the project" : ""}.</p>`;
}
function collect() {
  const F = AG.form, fd = new FormData($("#agrForm"));
  for (const f of A.templateFields(F.tpl)) if (fd.has(f.key)) F.v[f.key] = String(fd.get(f.key)).trim();
  if (F.v.law_country === "__other") F.v.law_country = String(fd.get("law_country_other") || "").trim();
  const typed = String(fd.get("__title") || "").trim();
  if (typed && typed !== F.autoTitle) F.titleTouched = true;
  F.title = F.titleTouched ? typed : defaultTitle();
  if (!F.titleTouched) { F.autoTitle = F.title; const ti = $("#agrForm [name=__title]"); if (ti && ti.value !== F.title) ti.value = F.title; }
  if (fd.has("__onboarding")) F.meta.onboarding_id = fd.get("__onboarding");
  if (fd.has("__project")) F.meta.project_id = fd.get("__project");
  F.special = $$("#specials .sp-row").map((r) => ({ title: $("[data-sp-title]", r).value.trim(), text: $("[data-sp-text]", r).value.trim() }));
  $$("#exhibits .ex-row").forEach((r) => { const x = F.exhibits[+r.dataset.ex]; if (!x) return; x.title = $("[data-ex-title]", r).value.trim(); const t = $("[data-ex-text]", r); if (t) x.text = t.value; });
}
function onFormChange() { collect(); updatePreview(); }
function rendered() {
  const F = AG.form, vars = A.agreementVars(F.tpl, { ...F.v, special_provisions: F.special, exhibits: F.exhibits });
  return A.renderTemplate(F.tpl.body, vars, A.signatureBlocks(F.tpl, vars, []));
}
function updatePreview() {
  const html = rendered(); $("#preview").innerHTML = html;
  const n = (html.match(/agr-blank/g) || []).length;
  $("#blankCount").textContent = n ? `${n} blank${n === 1 ? "" : "s"} to fill` : "Ready to send";
  $("#blankCount").classList.toggle("warn", !!n);
}
async function saveDraft() {
  collect();
  const F = AG.form, v = F.v;
  if (!F.title) { toast("Give the agreement a title"); return null; }
  const value = v.fee_cap || (v.fee_type === "Fixed fee" ? v.fee_rate : "") || "";
  try {
    const id = await db.rpc("agr_save", { p: { id: F.id, ...F.meta, title: F.title, party_name: v.party_name || v.party_signer_name || "", party_email: v.party_signer_email || "",
      fields: { ...v, special_provisions: F.special, exhibits: F.exhibits }, body_html: rendered(), value, currency: v.currency || "", start_date: v.start_date || v.effective_date || "", end_date: v.end_date || "" } });
    F.id = id; history.replaceState(null, "", `#/edit/${id}`);
    return id;
  } catch (e) { toast(e.message); return null; }
}

/* ---------------- send */
async function sendDialog(id) {
  const a = must(await sb.from("agreements").select("*").eq("id", id).single());
  const tpl = (await loadTemplates()).find((t) => t.key === a.template_key) || { signers: [{ role: "company", label: "Your company" }, { role: "party", label: "Other party" }] };
  const v = a.fields || {};
  if (/agr-blank/.test(a.body_html || "")) { toast("Fill in the highlighted blanks first"); return; }
  if (a.kind === "amendment" && !(v.special_provisions || []).some((p) => p.text)) { toast("Add at least one change (as a special provision) before sending"); return; }
  const def = (s) => s.role === "company" ? { name: v.company_signer_name, email: v.company_signer_email || (S.profile.display_name === v.company_signer_name ? S.user.email : ""), title: v.company_signer_title }
    : { name: v.party_signer_name || v.party_name, email: v.party_signer_email, title: tpl.kind === "confidentiality" ? v.relationship : tpl.kind === "employment" ? v.position_title : v.party_signer_title };
  $("#drawerTitle").textContent = `Send ${ref(a)} for signature`;
  $("#drawerBody").innerHTML = `<p class="muted">Each signer gets a private link. The text is locked once you send it; to change it after that you void it and make a corrected copy.</p>
    <form id="sendForm">${tpl.signers.map((s, i) => { const d = def(s); return `<fieldset class="people-pick"><legend>${esc(s.label)}</legend><div class="form-grid">
      <input type="hidden" name="role" value="${s.role}"><input type="hidden" name="label" value="${esc(s.label)}">
      <label>Name<input name="name" value="${esc(d.name || "")}" required></label><label>Email<input name="email" type="email" value="${esc(d.email || "")}" required></label>
      <label>Title<input name="title" value="${esc(d.title || "")}"></label><label>Order<input name="order" type="number" min="1" value="${i + 1}"></label></div></fieldset>`; }).join("")}
      <label>Links work for<select name="days"><option value="14">14 days</option><option value="30" selected>30 days</option><option value="60">60 days</option></select></label>
      <div class="actions-row" style="margin-top:12px"><button class="btn primary">${icon("send")}Lock and create signing links</button></div></form>`;
  openDrawer();
  $("#sendForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const sets = $$("#sendForm fieldset").map((fs) => Object.fromEntries($$("input", fs).map((i) => [i.name, i.value.trim()])));
    try {
      const links = await db.rpc("agr_send", { p_id: id, p_signers: sets.map((s) => ({ role: s.role, label: s.label, name: s.name, email: s.email, title: s.title, sign_order: +s.order || 1 })), p_days: +e.target.days.value });
      showLinks(a, links);
    } catch (err) { toast(err.message); }
  });
}
function signUrl(token) { return `${SITE()}sign/#${token}`; }
function mailFor(a, l) {
  const sub = `Please sign: ${a.title}`;
  const body = `Hi ${String(l.name).split(" ")[0]},\n\n${S.workspace.name} has sent you "${a.title}" (${ref(a)}) to review and sign electronically.\n\nOpen this private link to read and sign it:\n${signUrl(l.token)}\n\nThe link is just for you; please don't forward it. Reply to this email with any questions.\n\nThanks,\n${S.profile.display_name}`;
  return `mailto:${encodeURIComponent(l.email)}?subject=${encodeURIComponent(sub)}&body=${encodeURIComponent(body)}`;
}
function showLinks(a, links) {
  $("#drawerTitle").textContent = `${ref(a)}: signing links`;
  $("#drawerBody").innerHTML = `<div class="notice-bar ok">${icon("check")}<div>Locked and ready. Send each person their link. Links are shown only now; you can make a new one later if needed.</div></div>
    ${links.map((l, i) => `<div class="link-card"><div><b>${esc(l.name)}</b> <span class="muted">${esc(l.email)}</span></div>
      <input readonly value="${esc(signUrl(l.token))}" aria-label="Signing link" onclick="this.select()">
      <div class="actions-row">${l.email === S.user.email ? `<a class="btn small primary" href="${esc(signUrl(l.token))}" target="_blank" rel="noopener">Sign now</a>` : ""}
        <button class="btn small" data-copy="${i}">Copy link</button><a class="btn small" href="${mailFor(a, l)}">${icon("send")}Email it</a></div></div>`).join("")}
    <div class="actions-row" style="margin-top:14px"><a class="btn" href="#/view/${a.id}">Done</a></div>`;
  $$("[data-copy]").forEach((b) => b.addEventListener("click", async () => { await navigator.clipboard.writeText(signUrl(links[+b.dataset.copy].token)); toast("Link copied"); }));
  openDrawer();
}

/* ================================================================ agreement page */
async function View(id) {
  const a = must(await sb.from("agreements").select("*").eq("id", id).single());
  const [signers, files, events, kids, onb, parent] = await Promise.all([
    sb.from("agreement_signers").select(SIGNER_COLS).eq("agreement_id", id).order("sign_order").then(must),
    sb.from("agreement_files").select("id, name, mime, size, sha256, uploaded_by, created_at").eq("agreement_id", id).order("created_at").then(must),
    isStaff() ? sb.from("agreement_events").select("*").eq("agreement_id", id).order("ts").then(must) : Promise.resolve([]),
    sb.from("agreements").select("id, number, title, status").eq("parent_id", id).then(must),
    a.onboarding_id ? sb.from("onboardings").select("id, name").eq("id", a.onboarding_id).maybeSingle().then(must) : Promise.resolve(null),
    a.parent_id ? sb.from("agreements").select("id, number, title").eq("id", a.parent_id).maybeSingle().then(must) : Promise.resolve(null)]);
  const me = signers.find((s) => s.user_id === S.user.id && !["Signed", "Declined"].includes(s.status));
  const staff = isStaff(), st = a.status, done = signers.filter((s) => s.status === "Signed").length;
  const tab = AG.viewTab || "doc";
  const actions = [
    st === "Draft" && staff ? `<a class="btn" href="#/edit/${id}">Edit</a><button class="btn primary" id="send">${icon("send")}Send for signature</button>` : "",
    st === "Out for signature" && me ? `<button class="btn primary" id="signNow">Sign now</button>` : "",
    ["Active", "Expired", "Terminated", "Closed out"].includes(st) ? `<button class="btn" id="print">${icon("arrow-out")}Download / print</button>` : "",
    st === "Active" && staff ? `<a class="btn" href="#/new?template=amendment&parent=${id}">Amend</a><button class="btn" id="end">End agreement…</button>` : "",
    ["Draft", "Out for signature", "Declined"].includes(st) && staff ? `<button class="btn" id="upload">Upload signed copy</button><button class="btn danger" id="void">Void</button>` : "",
    st === "Declined" && staff ? `<button class="btn primary" id="copy">Make a corrected copy</button>` : "",
    st === "Voided" && staff ? `<button class="btn" id="copy">Copy as new draft</button>` : "",
  ].join("");
  $("#main").innerHTML = `
    <div class="page-head"><div><p class="muted small"><a href="#/list">Agreements</a> › ${ref(a)}</p><h1>${esc(a.title)}</h1>
      <p class="muted">${spill(st)} ${esc(a.template_name)}${a.party_name ? " with " + esc(a.party_name) : ""}${parent ? ` · amends <a href="#/view/${parent.id}">${ref(parent)}</a>` : ""}${onb ? ` · <a href="../people/#/people">${esc(onb.name)}'s onboarding</a>` : ""}</p></div>
      <div class="actions-row">${actions}</div></div>
    ${lifecycleBar(a)}
    ${st === "Declined" ? `<div class="notice-bar alert">${icon("alert")}<div><b>Declined</b> by ${esc(signers.find((s) => s.status === "Declined")?.name || "")}: ${esc(signers.find((s) => s.status === "Declined")?.decline_reason || "")}</div></div>` : ""}
    ${st === "Out for signature" ? `<div class="notice-bar">${icon("clock")}<div>${done} of ${signers.length} signed. ${staff ? "Waiting on " + signers.filter((s) => s.status !== "Signed").map((s) => esc(s.name)).join(", ") + "." : ""}</div></div>` : ""}
    ${kids.length ? `<div class="notice-bar">${icon("clipboard")}<div>Amendments: ${kids.map((k) => `<a href="#/view/${k.id}">${ref(k)} ${esc(k.title)}</a> (${esc(k.status)})`).join(" · ")}</div></div>` : ""}
    <div class="tabs" role="tablist" style="margin-bottom:14px">${[["doc", "Document"], ["signers", `Signers ${done}/${signers.length || "–"}`], ["files", `Files ${files.length}`], ...(staff ? [["activity", "Audit trail"]] : []),
      ...(["Expired", "Terminated", "Closed out"].includes(st) ? [["closeout", "Close-out"]] : [])].map(([k, l]) => `<button role="tab" data-vt="${k}" aria-selected="${tab === k}">${l}</button>`).join("")}</div>
    <div id="vbody"></div>`;
  const body = $("#vbody");
  if (tab === "doc") { body.innerHTML = `<section class="panel agr-doc-wrap"><div class="agr-doc">${executedHtml(a, signers, false)}</div></section>`;
    $$("[data-exfile]", body).forEach((el) => el.insertAdjacentHTML("beforeend", ` <button class="btn small" type="button" data-file="${+el.dataset.exfile}">Download exhibit</button>`)); }
  const exOf = Object.fromEntries((a.fields?.exhibits || []).filter((x) => x.file_id).map((x) => [x.file_id, x]));
  if (tab === "signers") body.innerHTML = `<section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Signer</th><th>Role</th><th>Status</th><th>Signed</th><th>From</th>${st === "Out for signature" && staff ? "<th></th>" : ""}</tr></thead><tbody>
      ${signers.map((s) => `<tr style="cursor:default"><td><b>${esc(s.name)}</b><small class="muted" style="display:block">${esc(s.email || "")}${s.title ? " · " + esc(s.title) : ""}</small></td><td>${esc(s.label || s.role)}</td>
        <td>${spill(s.status === "Signed" ? "Closed out" : s.status === "Declined" ? "Declined" : s.status === "Viewed" ? "Out for signature" : "Draft").replace(/>[^<]+</, `>${esc(s.status)}<`)}</td>
        <td class="date">${s.signed_at ? new Date(s.signed_at).toLocaleString() : s.viewed_at ? "Opened " + ago(s.viewed_at) : "—"}</td><td class="small">${esc(s.ip || "")}</td>
        ${st === "Out for signature" && staff ? `<td>${s.status === "Signed" ? "" : `<button class="btn small" data-relink="${s.id}">New link</button>`}</td>` : ""}</tr>`).join("") || `<tr><td colspan="6" class="empty">Not sent yet.</td></tr>`}</tbody></table></div></section>`;
  if (tab === "files") body.innerHTML = `<section class="panel"><ul class="checklist">${files.map((f) => `<li class="ck"><span>${icon("clipboard", "ic tiny")} <b>${esc(f.name)}</b>${exOf[f.id] ? ` <span class="pill">Exhibit: ${esc(exOf[f.id].title || "")}</span>` : ""} <span class="muted small">${Math.round((f.size || 0) / 1024)} KB · ${esc(f.uploaded_by || "")} ${short(f.created_at)}</span></span>
      <span class="meta"><button class="btn small" data-file="${f.id}">Download</button></span></li>`).join("") || `<li class="empty">No files. The e-signed copy is the Document tab; uploaded signed copies and attachments show here.</li>`}</ul>
      ${staff && !["Voided", "Closed out"].includes(st) ? `<button class="btn small" id="addFile">${icon("plus")}Add a file</button>` : ""}</section>`;
  if (tab === "activity") body.innerHTML = `<section class="panel"><ul class="timeline">${events.map((e) => `<li><b>${esc(e.actor || "")}</b> ${esc(e.detail || e.kind)} <span class="muted small">· ${new Date(e.ts).toLocaleString()}${e.ip ? " · " + esc(e.ip) : ""}</span></li>`).join("")}</ul>
      ${a.doc_hash ? `<p class="muted small">Document fingerprint (SHA-256): <code>${esc(a.doc_hash)}</code></p>` : ""}</section>`;
  if (tab === "closeout") renderCloseout(a, body);
  $$("[data-vt]").forEach((b) => b.addEventListener("click", () => { AG.viewTab = b.dataset.vt; View(id); }));
  $("#send")?.addEventListener("click", () => sendDialog(id));
  $("#signNow")?.addEventListener("click", () => memberSign(a, me));
  $("#print")?.addEventListener("click", () => printCopy(a, signers, events));
  $("#void")?.addEventListener("click", async () => { const r = prompt("Why are you voiding it? (signers' links stop working)"); if (!r) return; try { await db.rpc("agr_void", { p_id: id, p_reason: r }); toast("Voided"); View(id); } catch (e) { toast(e.message); } });
  $("#copy")?.addEventListener("click", async () => { try { const n = await db.rpc("agr_copy", { p_id: id }); location.hash = `#/edit/${n}`; } catch (e) { toast(e.message); } });
  $("#upload")?.addEventListener("click", () => uploadDialog(a, true));
  $("#addFile")?.addEventListener("click", () => uploadDialog(a, false));
  $("#end")?.addEventListener("click", () => endDialog(a));
  $$("[data-relink]").forEach((b) => b.addEventListener("click", async () => {
    try { const tok = await db.rpc("agr_new_link", { p_signer: +b.dataset.relink }); const s = signers.find((x) => x.id === +b.dataset.relink); showLinks(a, [{ name: s.name, email: s.email, token: tok }]); } catch (e) { toast(e.message); }
  }));
  $$("[data-file]").forEach((b) => b.addEventListener("click", async () => {
    const f = must(await sb.from("agreement_files").select("name, mime, data_b64").eq("id", +b.dataset.file).single());
    const bin = atob(f.data_b64.replace(/^data:[^,]+,/, "")), u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([u8], { type: f.mime || "application/octet-stream" })); const l = document.createElement("a"); l.href = url; l.download = f.name; l.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }));
}
function lifecycleBar(a) {
  const steps = ["Draft", "Out for signature", "Active", "Ended", "Closed out"];
  const at = { Draft: 0, "Out for signature": 1, Declined: 1, Voided: 1, Active: 2, Expired: 3, Terminated: 3, "Closed out": 4 }[a.status] ?? 0;
  return `<ol class="lifecycle">${steps.map((s, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}">${i === 3 && ["Expired", "Terminated"].includes(a.status) ? a.status : s}</li>`).join("")}</ol>`;
}
// the locked text with signatures in place, plus a certificate of completion when executed
function executedHtml(a, signers, withCert) {
  const tpl = A.BUILTIN_TEMPLATES.find((t) => t.key === a.template_key) || { kind: a.kind, signers: signers.map((s) => ({ role: s.role, label: s.label })) };
  const vars = A.agreementVars(tpl, a.fields || {});
  let html = a.body_html || "";
  if (signers.some((s) => s.status === "Signed")) html = html.replace(/<!--sigs-->[\s\S]*?<!--\/sigs-->/, A.signatureBlocks(tpl, vars, signers));
  if (!withCert || !a.executed_at) return html;
  return html + `<div class="agr-cert"><h2>Certificate of completion</h2>
    <p>${esc(a.title)} · ${ref(a)} · ${esc(S.workspace?.name || "")}</p>
    <table class="agr-table"><tr><th>Executed</th><td>${new Date(a.executed_at).toLocaleString()} (${esc(a.executed_via || "")})</td></tr>
    <tr><th>Sent</th><td>${a.sent_at ? new Date(a.sent_at).toLocaleString() : "—"}</td></tr>
    <tr><th>Document fingerprint</th><td><code>${esc(a.doc_hash || "")}</code> (SHA-256 of the text as sent; signatures can't be applied to changed text)</td></tr>
    ${signers.map((s) => `<tr><th>${esc(s.label || s.role)}</th><td>${esc(s.name)}${s.title ? ", " + esc(s.title) : ""} · ${esc(s.email || "")}<br>${s.status === "Signed" ? `Signed ${new Date(s.signed_at).toLocaleString()} · ${esc(s.signature_kind)} signature · agreed to sign electronically ${s.consent_at ? new Date(s.consent_at).toLocaleString() : ""}${s.ip ? " · IP " + esc(s.ip) : ""}` : esc(s.status)}</td></tr>`).join("")}</table></div>`;
}
function printCopy(a, signers) {
  const w = window.open("", "_blank");
  if (!w) { toast("Allow pop-ups to download the copy"); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(ref(a) + " " + a.title)}</title><link rel="stylesheet" href="${SITE()}style.css">
    <style>body{background:#fff;margin:0} .agr-doc{box-shadow:none;border:0;max-width:7.5in;margin:0 auto;padding:.6in .5in} @media print{.agr-doc{padding:0}}</style></head>
    <body><div class="agr-doc">${executedHtml(a, signers, true)}</div><script>setTimeout(()=>print(),400)<\/script></body></html>`);
  w.document.close();
}
// the signature pad lives in sigpad.js (shared with the public signing page)
function memberSign(a, me) {
  $("#drawerTitle").textContent = `Sign ${ref(a)}`;
  $("#drawerBody").innerHTML = `<form id="msign"><label>Full name<input name="name" value="${esc(me.name || S.profile.display_name)}" required></label>
    <label>Title<input name="title" value="${esc(me.title || "")}"></label><div id="pad"></div>
    <label class="check"><input type="checkbox" name="consent" required> I agree to sign this agreement electronically and that my electronic signature is as binding as a handwritten one.</label>
    <div class="actions-row" style="margin-top:12px"><button class="btn primary">Sign</button></div></form>`;
  openDrawer();
  const pad = window.PulseSigPad($("#pad")); pad.setTyped(me.name || S.profile.display_name);
  $("#msign").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target, sig = pad.value();
    if (!sig.data) return toast("Add your signature");
    try { await db.rpc("agr_sign_member", { p_id: a.id, p_name: f.name.value, p_title: f.title.value, p_kind: sig.kind, p_data: sig.data, p_consent: f.consent.checked, p_user_agent: navigator.userAgent }); toast("Signed"); closeDrawer(); View(a.id); }
    catch (err) { toast(err.message); }
  });
}
function uploadDialog(a, executes) {
  $("#drawerTitle").textContent = executes ? "Upload signed copy" : "Add a file";
  $("#drawerBody").innerHTML = `<form id="up">${executes ? `<p class="muted">Signed on paper, in DocuSign or Adobe Sign? Attach the fully signed PDF. ${ref(a)} becomes Active and any signing links stop working.</p>
      <label>Date it was fully signed<input type="date" name="date" value="${today()}"></label>` : ""}
    <label>File (PDF, Word or image, up to 10 MB)<input type="file" name="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" required></label>
    <div class="actions-row" style="margin-top:12px"><button class="btn primary">${executes ? "Attach and mark executed" : "Attach"}</button></div>
    <p class="form-error" id="upErr" role="alert" hidden></p></form>`;
  openDrawer();
  $("#up").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target, file = f.file.files[0], btn = $("button.primary", f), err = $("#upErr"); if (!file) return;
    err.hidden = true;
    if (file.size > 10 * 1024 * 1024) { err.textContent = "That file is over 10 MB."; err.hidden = false; return; }
    const label = btn.textContent; btn.disabled = true; btn.textContent = "Uploading…";
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("Couldn't read that file.")); r.readAsDataURL(file); });
      await db.rpc("agr_upload_signed", { p_id: a.id, p_name: file.name, p_mime: file.type || "application/octet-stream", p_b64: b64, p_executed: executes ? f.date.value : null });
      toast(executes ? "Signed copy attached. Agreement is active" : "File added"); closeDrawer(); View(a.id);
    } catch (ex) { err.textContent = `Upload failed: ${ex.message}`; err.hidden = false; btn.disabled = false; btn.textContent = label; }
  });
}
function endDialog(a) {
  $("#drawerTitle").textContent = `End ${ref(a)}`;
  $("#drawerBody").innerHTML = `<form id="endf"><label>How did it end?<select name="status"><option value="Expired">Reached its end date / work complete</option><option value="Terminated">Terminated early</option></select></label>
    <label>Date<input type="date" name="date" value="${a.end_date && a.end_date < today() ? a.end_date : today()}"></label>
    <label>Reason or note<textarea name="reason" rows="3" placeholder="Required for terminations"></textarea></label>
    <p class="muted small">Next comes the close-out checklist: final deliverables, final invoice, timesheets, equipment and access, IP, evaluation and archiving.</p>
    <div class="actions-row"><button class="btn primary">End agreement</button></div></form>`;
  openDrawer();
  $("#endf").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target;
    try { await db.rpc("agr_end", { p_id: a.id, p_status: f.status.value, p_reason: f.reason.value, p_date: f.date.value }); AG.viewTab = "closeout"; closeDrawer(); View(a.id); } catch (err) { toast(err.message); }
  });
}
function renderCloseout(a, el) {
  const items = a.closeout || [], closed = a.status === "Closed out";
  el.innerHTML = `<section class="panel"><h2>Close-out ${closed ? `<small>closed ${short(a.closed_at)}</small>` : ""}</h2>
    ${a.end_reason ? `<p class="muted">${esc(a.status === "Closed out" ? "Ended" : a.status)}: ${esc(a.end_reason)}</p>` : ""}
    <ul class="checklist">${items.map((i, k) => `<li class="ck ${i.done ? "done" : ""}"><label class="check"><input type="checkbox" data-co="${k}" ${i.done ? "checked" : ""} ${closed ? "disabled" : ""}> <span>${esc(i.text)}</span></label>
      <span class="meta"><label class="check small"><input type="checkbox" data-na="${k}" ${i.na ? "checked" : ""} ${closed ? "disabled" : ""}> N/A</label></span></li>`).join("")}</ul>
    ${closed ? (a.closeout_note ? `<p>${esc(a.closeout_note)}</p>` : "") : `<div class="add-action" style="grid-template-columns:1fr auto;margin:10px 0"><input id="coNew" placeholder="Add a close-out item"><button class="btn small" id="coAdd">Add</button></div>
      <label>Close-out note<textarea id="coNote" rows="2" placeholder="Final value, lessons learned, where records are kept">${esc(a.closeout_note || "")}</textarea></label>
      <div class="actions-row" style="margin-top:10px"><button class="btn" id="coSave">Save progress</button><button class="btn primary" id="coClose">Close out</button></div>`}</section>`;
  if (closed) return;
  const gather = () => items.map((i, k) => ({ ...i, done: $(`[data-co="${k}"]`).checked, na: $(`[data-na="${k}"]`).checked }));
  $("#coAdd").addEventListener("click", () => { const t = $("#coNew").value.trim(); if (!t) return; a.closeout = [...gather(), { id: Math.random().toString(36).slice(2, 8), text: t, done: false }]; renderCloseout(a, el); });
  const save = async (close) => { try { await db.rpc("agr_closeout", { p_id: a.id, p_items: gather(), p_note: $("#coNote").value, p_close: close }); toast(close ? "Closed out" : "Saved"); View(a.id); } catch (e) { toast(e.message); } };
  $("#coSave").addEventListener("click", () => save(false));
  $("#coClose").addEventListener("click", () => save(true));
}

/* ================================================================ templates + company details */
async function Templates() {
  const tpls = await loadTemplates(), L = legal();
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Templates</h1><p class="muted">Starting wording for each type of agreement. Have counsel review it for the places you use it.</p></div></div>
    ${isAdmin() ? `<section class="panel"><h2>Your company's details <small>filled into every agreement</small></h2><form id="legalForm" class="form-grid">
      <label>Legal name<input name="name" value="${esc(L.name || S.workspace.name)}"></label><label>Type and place<input name="entity" value="${esc(L.entity || "")}" placeholder="a Delaware corporation"></label>
      <label class="wide">Address<input name="address" value="${esc(L.address || "")}"></label>
      <label>Usual signer<input name="signer_name" value="${esc(L.signer_name || "")}"></label><label>Their title<input name="signer_title" value="${esc(L.signer_title || "")}"></label>
      <label>Their email<input name="signer_email" type="email" value="${esc(L.signer_email || "")}"></label>
      <label>Usual governing law: country<select name="law_country">${Object.keys(A.JURISDICTIONS).map((c) => `<option ${c === (L.law_country || "United States") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>State / province<input name="law_region" value="${esc(L.law_region || "")}" placeholder="e.g. Virginia"></label>
      <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save company details</button></div></form></section>` : ""}
    <div class="appr-grid">${tpls.map((t) => `<article class="appr-card"><header>${icon(t.icon || "clipboard")}<div><h3>${esc(t.name)}</h3>${t.customized ? `<span class="pill s-active">Your wording</span>` : `<span class="pill">Standard</span>`}</div></header>
      <p class="appr-desc">${esc(t.blurb)}</p><div class="actions-row">${!t.amendment ? `<a class="btn small primary" href="#/new?template=${t.key}">Use</a>` : ""}${isAdmin() ? `<button class="btn small" data-edit-tpl="${t.key}">Edit wording</button>` : ""}
      ${isAdmin() && t.customized ? `<button class="btn small" data-reset-tpl="${t.dbId}">Back to standard</button>` : ""}</div></article>`).join("")}</div>
    ${isAdmin() ? `<p><button class="btn" id="newTpl">${icon("plus")}Add your own template</button></p>` : ""}`;
  $("#legalForm")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const legalNew = Object.fromEntries(new FormData(e.target));
    try { await db.rpc("update_workspace", { p: { config: { ...(S.workspace.config || {}), legal: legalNew } } }); await loadWorkspace(); toast("Company details saved"); } catch (err) { toast(err.message); }
  });
  $$("[data-edit-tpl]").forEach((b) => b.addEventListener("click", () => editTemplate(tpls.find((t) => t.key === b.dataset.editTpl))));
  $$("[data-reset-tpl]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Go back to the standard wording? Your edited copy is deleted (agreements already made keep their text).")) return;
    try { must(await sb.from("agreement_templates").delete().eq("id", +b.dataset.resetTpl)); Templates(); } catch (e) { toast(e.message); }
  }));
  $("#newTpl")?.addEventListener("click", () => editTemplate({ key: "custom-" + Date.now().toString(36), kind: "other", name: "", blurb: "", body: `<h1>AGREEMENT</h1>\n<p>This Agreement is made effective as of {{effective_date_long}} between <b>{{company_name}}</b>, {{company_entity}}, and <b>{{party_name}}</b>, of {{party_address}}.</p>\n<ol class="agr-sections">\n<li><b>Purpose.</b> {{purpose}}</li>\n<li><b>Governing Law.</b> This Agreement is governed by the laws of {{law_place}}.</li>\n</ol>\n{{signatures}}`,
    fields: [{ key: "effective_date", label: "Effective date", group: "Terms", type: "date", required: true, default: "today" }, ...A.BUILTIN_TEMPLATES[1].fields.filter((f) => /^(company_|party_|law_)/.test(f.key))],
    signers: [{ role: "company", label: "Your company" }, { role: "party", label: "Other party" }], isNew: true }));
}
function editTemplate(t) {
  $("#drawerTitle").textContent = t.isNew ? "New template" : `Edit wording: ${t.name}`;
  $("#drawerBody").innerHTML = `<form id="tplForm"><div class="form-grid"><label>Name<input name="name" value="${esc(t.name)}" required></label><label>Short description<input name="blurb" value="${esc(t.blurb || "")}"></label></div>
    <label>Wording (HTML)<textarea name="body" rows="22" class="mono">${esc(t.body)}</textarea></label>
    <p class="muted small">Use <code>{{field_name}}</code> for anything filled in per agreement; a new name becomes a form field automatically.
      <code>{{#if field}}…{{/if}}</code> shows text only when a field is filled or "yes". Numbered sections go inside <code>&lt;ol class="agr-sections"&gt;</code>; special provisions are added at its end.
      Put <code>{{signatures}}</code> where the signature blocks go. Built-in wording like <code>{{law_place}}</code>, <code>{{venue_place}}</code>, <code>{{effective_date_long}}</code> is filled automatically.</p>
    <div class="actions-row"><button class="btn primary">Save template</button></div></form>`;
  openDrawer();
  $("#tplForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    if (!/\{\{signatures\}\}/.test(f.body)) return toast("Keep {{signatures}} in the wording");
    const row = { key: t.key, kind: t.kind || "other", name: f.name.trim(), blurb: f.blurb.trim(), body: f.body, fields: t.fields, signers: t.signers, checklist: t.checklist || [], based_on: A.BUILTIN_TEMPLATES.some((b) => b.key === t.key) ? t.key : null };
    try {
      if (t.dbId) must(await sb.from("agreement_templates").update(row).eq("id", t.dbId)); else must(await sb.from("agreement_templates").insert(row));
      toast("Template saved"); closeDrawer(); Templates();
    } catch (err) { toast(err.message); }
  });
}

/* ================================================================ router */
const routes = { list: List, new: New, edit: (id) => Edit(+id), view: (id) => View(+id), templates: Templates };
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [path, rest] = location.hash.replace(/^#\/?/, "").split(/[?](.*)/s);
  const [name, id] = (path || "").split("/");
  const key = routes[name] ? name : "policies";
  if (key !== "view") AG.viewTab = null;
  const navKey = { view: "list", edit: "list", policy: "policies", "policy-edit": "policies", invoice: "invoices", "invoice-edit": "invoices", "invoice-settings": "invoices" }[key] || key;
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === navKey));
  document.body.classList.remove("nav-open"); closeDrawer();
  // plan locks inside Documents: policies and compliance are Starter; agreements and invoices are Pro
  const need = ["list", "new", "edit", "view", "templates"].includes(key) ? "agreements" : /^invoice/.test(key) ? "invoices" : null;
  if (need && !hasApp(need)) { $("#main").innerHTML = lockedPanel(need, FEATURE_NAMES[need]); return; }
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve(routes[key](id || rest)).catch((e) => ($("#main").innerHTML = /(relation|function) .*(agreement|doc_|inv_|polic).* does not exist|schema cache/i.test(e.message)
    ? `<section class="panel"><h2>One-time setup needed</h2><p>Documents needs the latest database update (supabase/fix_20261108d_documents.sql). Ask whoever runs Pulse to run it.</p></section>` : `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try {
    if (!(await requireMember())) return;
    if (!isStaff()) $$('#nav a[data-r="new"], #nav a[data-r="templates"], #nav a[data-r="compliance"], #nav [data-staff]').forEach((a) => a.remove());
    if (!isAdmin()) $$('#nav [data-admin]').forEach((a) => a.remove());
    $$("#nav a[data-r]").forEach((a) => { const need = { list: "agreements", new: "agreements", templates: "agreements", invoices: "invoices" }[a.dataset.r];
      if (need && !hasApp(need)) a.insertAdjacentHTML("beforeend", `<small class="plan-badge">${PLANS[appPlan(need)].name}</small>`); });
    showShell(); route();
  } catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
