/* Pulse · People — base rates, tax forms and the 1099 summary.
   * Rates (admins): the default base rate new people start with (workspace config.base_rate), shown with what it
     comes to for a 6–8 hour day and the benchmark it was taken from. Each person's rate can still be changed.
   * On a person or company: which tax form is needed (W-9, W-8BEN, W-8BEN-E, W-4), its status and the tax
     classification, plus their Documents (signed forms, insurance certificates, subcontracts…). Uploading a signed
     W-9 / W-8 marks the form received. People upload their own form from My checklist.
   * Tax forms & 1099 (admins): who still owes a form, and what each contractor was paid in a year vs the 1099-NEC threshold.
   Uses ../core.js and people.js helpers. */
"use strict";

const TAX_FORMS = { "W-9": "https://www.irs.gov/pub/irs-pdf/fw9.pdf", "W-8BEN": "https://www.irs.gov/pub/irs-pdf/fw8ben.pdf",
  "W-8BEN-E": "https://www.irs.gov/pub/irs-pdf/fw8bene.pdf", "W-4": "https://www.irs.gov/pub/irs-pdf/fw4.pdf" };
const TAX_CLASSES = ["Individual / sole proprietor", "Single-member LLC", "LLC (partnership)", "Partnership", "LLC (S corporation)", "S corporation",
  "LLC (C corporation)", "C corporation", "Trust / estate", "Foreign individual", "Foreign entity", "Employee (W-2)"];
const DOC_KINDS = ["W-9", "W-8BEN", "W-8BEN-E", "W-4", "I-9", "Insurance certificate", "Agreement", "ID or certification", "Other"];
const BENCH_URL = "https://buy.gsa.gov/pricing/qr/mas?page=1&page_size=20&histogram=12&experience_range=0,45&price_range=15,500&ordering=current_price&acceptsDataDisclosure=true&sort=asc";
const RATE_DEFAULT = { hourly: 20.1, day_min: 6, day_max: 8, source: BENCH_URL,
  note: "GSA CALC+ (MAS awarded labor rates, 0–45 yrs experience, $15–$500): lowest awarded rate $20.10/h on Nov 14 2026 (10th percentile $65.54, median $128.00)." };
const baseRate = () => ({ ...RATE_DEFAULT, ...(S.workspace?.config?.base_rate || {}) });
const usd = (n) => "$" + (+n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// what an hourly rate comes to for the workspace's working day (6–8 hours by default)
function dayRange(rate, unit = "hour") {
  if (rate == null || rate === "" || unit !== "hour") return "";
  const b = baseRate();
  return `${usd(rate * b.day_min)}–${usd(rate * b.day_max)} for a ${b.day_min}–${b.day_max} h day`;
}
// which form a new record needs, from what we know so far
function taxFormFor(o) {
  if (o.kind === "Employee" || o.kind === "Intern" && o.tax_class === "Employee (W-2)") return "W-4";
  if (o.us_person === false) return o.entity === "Company" ? "W-8BEN-E" : "W-8BEN";
  return "W-9";
}
const onbB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("Couldn't read that file.")); r.readAsDataURL(file); });
async function downloadOnbFile(id) {
  const f = must(await sb.from("onboarding_files").select("name, mime, data_b64").eq("id", id).single());
  const bin = atob(f.data_b64), u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([u8], { type: f.mime || "application/octet-stream" })), a = document.createElement("a");
  a.href = url; a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function uploadOnbFile(onbId, kind, file) {
  if (!file) return toast("Pick a file first");
  if (file.size > 10 * 1024 * 1024) return toast("That file is over 10 MB.");
  must(await sb.from("onboarding_files").insert({ onboarding_id: onbId, kind, name: file.name, mime: file.type || "application/octet-stream", size: file.size, data_b64: await onbB64(file), uploaded_by: S.user.id }));
  toast(`${kind} uploaded`);
}

/* ---------------------------------------------------------------- on a person or company (drawer) */
async function personTaxHtml(o, canEdit) {
  const files = await sb.from("onboarding_files").select("id, kind, name, size, created_at, uploaded_by").eq("onboarding_id", o.id).order("created_at").then((r) => r.data || []).catch(() => null);
  if (files === null) return "";
  const form = o.tax_form || taxFormFor(o), link = TAX_FORMS[form];
  const st = o.tax_status || "Needed";
  return `<h3 class="ck-h">Tax form <small class="muted">${st === "Received" ? `received ${o.tax_received ? short(o.tax_received) : ""}` : st === "Not needed" ? "not needed" : "still needed"}</small></h3>
    <div class="tax-box ${st === "Needed" ? "due" : ""}">
      ${canEdit ? `<div class="form-grid tax-grid">
        <label>Form<select data-tax="tax_form">${["W-9", "W-8BEN", "W-8BEN-E", "W-4", "None"].map((k) => `<option ${k === form ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label>Status<select data-tax="tax_status">${["Needed", "Received", "Not needed"].map((k) => `<option ${k === st ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label>Tax classification<select data-tax="tax_class"><option value="">—</option>${TAX_CLASSES.map((k) => `<option ${k === o.tax_class ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label>US person?<select data-tax="us_person"><option value="">Not sure yet</option><option value="true" ${o.us_person === true ? "selected" : ""}>Yes (W-9)</option><option value="false" ${o.us_person === false ? "selected" : ""}>No (W-8)</option></select></label></div>`
      : `<p><b>${esc(form)}</b> · ${esc(st)}${o.tax_class ? ` · ${esc(o.tax_class)}` : ""}</p>`}
      <p class="muted small">${link ? `Blank form: <a href="${link}" target="_blank" rel="noopener">IRS ${esc(form)}</a>. ` : ""}${form === "W-9" ? "Collect a signed W-9 before the first payment; it gives the legal name, classification and tax ID for the 1099." : form.startsWith("W-8") ? "Someone outside the US gives you a W-8 instead; no 1099 for work done outside the US." : form === "W-4" ? "Employees fill in a W-4 (and Virginia VA-4) and an I-9 with ID on day one." : ""}
        Upload the signed form below: Pulse keeps the file only, never the tax ID in a field.</p>
    </div>
    <h3 class="ck-h">Documents</h3>
    <ul class="checklist">${files.map((f) => `<li class="ck"><span><b>${esc(f.kind)}</b> · <button type="button" class="linkish" data-onbf="${f.id}">${esc(f.name)}</button> <small class="muted">${short(f.created_at)}</small></span>
      ${canEdit || f.uploaded_by === S.user.id ? `<button type="button" class="btn small" data-onbf-rm="${f.id}">Remove</button>` : ""}</li>`).join("") || `<li class="muted small" style="padding:4px 10px">No documents yet.</li>`}</ul>
    <div class="add-action" style="grid-template-columns:auto 1fr auto;margin:8px 0 16px"><select id="docKind" aria-label="Document type">${DOC_KINDS.map((k) => `<option ${k === form ? "selected" : ""}>${k}</option>`).join("")}</select>
      <input type="file" id="docFile" aria-label="File"><button class="btn small" id="docUp">Upload</button></div>`;
}
function wirePersonTax(o, reload) {
  $$("[data-tax]").forEach((s) => s.addEventListener("change", async () => {
    const k = s.dataset.tax, v = s.value === "" ? null : k === "us_person" ? s.value === "true" : s.value;
    const patch = { [k]: v };
    if (k === "tax_status" && v === "Received" && !o.tax_received) patch.tax_received = today();
    if (k === "us_person" && !o.tax_form) patch.tax_form = taxFormFor({ ...o, us_person: v });
    try { must(await sb.from("onboardings").update(patch).eq("id", o.id)); toast("Saved"); reload(); } catch (e) { toast(e.message); }
  }));
  $$("[data-onbf]").forEach((b) => b.addEventListener("click", () => downloadOnbFile(+b.dataset.onbf).catch((e) => toast(e.message))));
  $$("[data-onbf-rm]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this document?")) return;
    try { must(await sb.from("onboarding_files").delete().eq("id", +b.dataset.onbfRm)); reload(); } catch (e) { toast(e.message); }
  }));
  $("#docUp")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { await uploadOnbFile(o.id, $("#docKind").value, $("#docFile").files[0]); reload(); } catch (err) { toast(err.message); e.target.disabled = false; }
  });
}
// pay floor on a project (e.g. SCA wage determination): who is below it
function belowFloor(rate, floor) { return floor != null && rate != null && +rate < +floor; }

/* ---------------------------------------------------------------- Rates (admins) */
async function Rates() {
  if (!isAdmin()) return Mine();
  await loadWorkspace();
  const b = baseRate();
  const [onb, projects] = await Promise.all([
    sb.from("onboardings").select("id, name, kind, entity, rate, rate_unit, status, user_id").neq("status", "Offboarded").order("name").then((r) => r.data || []),
    sb.from("projects").select("id, name, status, pay_floor, pay_floor_note").neq("status", "Closed").order("name").then((r) => r.data || []).catch(() => [])]);
  // who is paid below a project's floor: their project rate, or their own hourly rate when the project has none
  const pp = await sb.from("project_people").select("project_id, user_id, rate").then((r) => r.data || []).catch(() => []);
  const under = {};   // onboarding id -> [project names]
  const underN = {};  // project id -> count
  for (const x of pp) {
    const pj = projects.find((p) => p.id === x.project_id), o = onb.find((y) => y.user_id && y.user_id === x.user_id);
    if (!pj || pj.pay_floor == null || !o) continue;
    const r = x.rate ?? (o.rate_unit === "hour" || !o.rate_unit ? o.rate : null);
    if (belowFloor(r, pj.pay_floor)) { (under[o.id] = under[o.id] || []).push(pj.name); underN[pj.id] = (underN[pj.id] || 0) + 1; }
  }
  $("#main").innerHTML = `<div class="page-head"><div><h1>Rates</h1><p class="muted">The base rate every new person starts with. You can still set a different rate for anyone, and a pay floor for a project.</p></div></div>
    <section class="panel"><h2>Default base rate</h2>
      <form id="rateForm" class="form-grid">
        <label>Base rate (USD per hour)<input name="hourly" type="number" min="0" step="0.01" value="${b.hourly}" required></label>
        <label>Working day <small class="muted">(hours, from–to)</small><span style="display:flex;gap:6px"><input name="day_min" type="number" min="1" max="24" step="0.5" value="${b.day_min}" aria-label="Shortest day"><input name="day_max" type="number" min="1" max="24" step="0.5" value="${b.day_max}" aria-label="Longest day"></span></label>
        <p class="full" id="dayOut"><b>${dayRange(b.hourly)}</b></p>
        <label class="full">Where it comes from<input name="source" type="url" value="${esc(b.source || "")}" placeholder="https://…"></label>
        <label class="full">Note<textarea name="note" rows="2">${esc(b.note || "")}</textarea></label>
        <div class="actions-row full"><button class="btn primary">Save</button>${b.source ? `<a class="btn" href="${esc(b.source)}" target="_blank" rel="noopener">Open the benchmark</a>` : ""}</div></form>
      <p class="muted small">New contractors, consultants and interns start at this rate (per hour). Partners, advisors and employees start blank. GSA CALC+ shows what the government pays contractors per hour (fully loaded, with overhead and profit); for your own people you'll usually pay less, and on a federal service contract never below the wage determination for the job.</p></section>
    <section class="panel"><h2>Everyone's rate <small class="muted">${onb.length}</small></h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th class="num">Rate</th><th>Day</th><th></th></tr></thead><tbody>
      ${onb.map((o) => `<tr style="cursor:default"><td><b>${esc(o.name)}</b>${o.entity === "Company" ? ` <small class="muted">company</small>` : ""}</td><td>${esc(o.kind)}</td>
        <td class="num">${o.rate != null ? usd(o.rate) + (UNITS[o.rate_unit] || "") : `<span class="muted">—</span>`}</td><td class="small">${dayRange(o.rate, o.rate_unit)}${under[o.id] ? `<span class="pill s-high" style="display:inline-block;margin-top:2px" title="Below the pay floor">Below floor on ${esc(under[o.id].join(", "))}</span>` : ""}</td>
        <td><button class="btn small" data-rate="${o.id}">${o.rate == null && ["Contractor", "Consultant", "Intern"].includes(o.kind) ? "Use base rate" : "Change"}</button></td></tr>`).join("")}</tbody></table></div></section>
    <section class="panel"><h2>Project pay floors</h2><p class="muted">On a federal service contract the Service Contract Act wage determination sets the lowest hourly pay (plus health &amp; welfare) for each job. Pulse warns when someone's project rate is below the floor.</p>
      <div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">Floor per hour</th><th>Basis</th><th></th></tr></thead><tbody>
      ${projects.map((p) => `<tr style="cursor:default"><td><b>${esc(p.name)}</b></td><td class="num">${p.pay_floor != null ? usd(p.pay_floor) : "—"}</td><td class="small">${esc(p.pay_floor_note || "")}${underN[p.id] ? ` <span class="pill s-high">${underN[p.id]} paid below it</span>` : ""}</td>
        <td><button class="btn small" data-floor="${p.id}">Set</button></td></tr>`).join("") || `<tr><td colspan="4" class="empty">No open projects.</td></tr>`}</tbody></table></div></section>`;
  const f = $("#rateForm");
  f.addEventListener("input", () => { const t = { ...baseRate(), day_min: +f.day_min.value || 6, day_max: +f.day_max.value || 8 };
    $("#dayOut").innerHTML = f.hourly.value ? `<b>${usd(f.hourly.value * t.day_min)}–${usd(f.hourly.value * t.day_max)} for a ${t.day_min}–${t.day_max} h day</b>` : ""; });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = { hourly: +f.hourly.value, day_min: +f.day_min.value || 6, day_max: +f.day_max.value || 8, source: f.source.value.trim() || null, note: f.note.value.trim() || null };
    if (v.day_min > v.day_max) return toast("The shortest day can't be longer than the longest.");
    if (v.source && !/^https:\/\//i.test(v.source)) return toast("The link must start with https://");
    try { await db.rpc("update_workspace", { p: { config: { ...(S.workspace.config || {}), base_rate: v } } }); await loadWorkspace(); toast("Base rate saved"); Rates(); } catch (err) { toast(err.message); }
  });
  $$("[data-rate]").forEach((btn) => btn.addEventListener("click", async () => {
    const o = onb.find((x) => x.id === +btn.dataset.rate);
    const ans = prompt(`Rate for ${o.name} (USD per ${o.rate_unit || "hour"}). Base rate: ${usd(baseRate().hourly)}/hour.`, o.rate ?? baseRate().hourly);
    if (ans === null) return;
    const rate = ans.trim() === "" ? null : +ans;
    if (rate != null && !(rate >= 0)) return toast("Enter a number");
    try { must(await sb.from("onboardings").update({ rate, rate_unit: o.rate_unit || "hour" }).eq("id", o.id)); toast("Rate saved"); Rates(); } catch (e) { toast(e.message); }
  }));
  $$("[data-floor]").forEach((btn) => btn.addEventListener("click", async () => {
    const p = projects.find((x) => x.id === +btn.dataset.floor);
    const amt = prompt(`Lowest hourly pay on ${p.name} (blank for none):`, p.pay_floor ?? "");
    if (amt === null) return;
    const note = amt.trim() === "" ? null : prompt("Basis (e.g. SCA WD 2015-4283 Rev 37, Environmental Technician $31.79 + H&W $5.55):", p.pay_floor_note || "");
    try { must(await sb.from("projects").update({ pay_floor: amt.trim() === "" ? null : +amt, pay_floor_note: note }).eq("id", p.id)); toast("Saved"); Rates(); } catch (e) { toast(e.message); }
  }));
}

/* ---------------------------------------------------------------- Tax forms & 1099 (admins) */
const TAX = { year: new Date().getFullYear() };
// 1099-NEC is due January 31 of the next year, or the next business day when that's a weekend
function due1099(year) {
  const d = new Date(Date.UTC(year + 1, 0, 31)), w = d.getUTCDay();
  if (w === 6) d.setUTCDate(d.getUTCDate() + 2); else if (w === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
async function Taxes() {
  if (!isAdmin()) return Mine();
  let d;
  try { d = await db.rpc("tax_1099", { p_year: TAX.year }); } catch (e) { $("#main").innerHTML = `<section class="panel"><h2>One-time setup needed</h2><p>${esc(e.message)}</p></section>`; return; }
  const rows = d.rows || [], owe = rows.filter((r) => r.tax_status === "Needed" && r.status !== "Offboarded"), due = rows.filter((r) => r.needs_1099);
  const yrs = [TAX.year + 1, TAX.year, TAX.year - 1, TAX.year - 2].filter((y) => y <= new Date().getFullYear() + 1);
  $("#main").innerHTML = `<div class="page-head"><div><h1>Tax forms &amp; 1099s</h1><p class="muted">Collect a W-9 (or W-8) from every contractor before paying them; file a 1099-NEC for each US contractor paid ${usd(d.threshold).replace(".00", "")} or more in ${d.year} (not corporations).</p></div>
      <div class="actions-row"><select id="taxYear" aria-label="Year">${yrs.map((y) => `<option ${y === TAX.year ? "selected" : ""}>${y}</option>`).join("")}</select></div></div>
    <div class="kpis">${[["Forms still needed", owe.length, owe.length ? "alert" : ""], [`1099-NEC due for ${d.year}`, due.length, ""], ["Paid to contractors", usd(rows.reduce((a, r) => a + +r.paid, 0)), ""], ["1099 threshold", usd(d.threshold), ""]].map(([k, v, c]) =>
      `<div class="kpi ${c}"><div><span>${k}</span><b>${v}</b></div></div>`).join("")}</div>
    <section class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Form</th><th>Classification</th><th class="num">Paid in ${d.year}</th><th>1099-NEC</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-ob="${r.id}" tabindex="0"><td><b>${esc(r.name)}</b>${r.entity === "Company" ? ` <small class="muted">company</small>` : ""}</td><td>${esc(r.kind)}</td>
        <td>${esc(r.tax_form || "W-9")} ${r.tax_status === "Received" ? pill("Active").replace(/>[^<]+</, ">Received<") : r.tax_status === "Not needed" ? `<span class="muted">not needed</span>` : `<span class="pill s-high">Needed</span>`}</td>
        <td class="small">${esc(r.tax_class || (r.us_person === false ? "Outside the US" : "—"))}</td><td class="num">${usd(r.paid)}</td>
        <td>${r.needs_1099 ? `<b>File by ${due1099(d.year)}</b>` : r.us_person === false ? `<span class="muted">No (W-8)</span>` : /corporation/i.test(r.tax_class || "") ? `<span class="muted">No (corporation)</span>` : `<span class="muted">Not yet</span>`}</td></tr>`).join("")
        || `<tr><td colspan="6" class="empty">No contractors yet.</td></tr>`}</tbody></table></div></section>
    <p class="muted small">Paid = project costs in ${d.year} linked to the person's agreements, or with their name (or firm) as the vendor. 1099-NEC goes to the contractor and the IRS by ${due1099(d.year)}; Virginia only wants a copy when you withheld Virginia tax. Not tax advice: check with your accountant.</p>`;
  $("#taxYear").addEventListener("change", (e) => { TAX.year = +e.target.value; Taxes(); });
  $$("[data-ob]").forEach((r) => r.addEventListener("click", () => openPerson(+r.dataset.ob)));
}
