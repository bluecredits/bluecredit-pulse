/* Pulse · Admin → Billing: the workspace's plan, seats and monthly total; choose a plan (PayPal subscription when it's
   switched on, otherwise a request to be invoiced); and, for Pulse operators, every company's plan.
   Plans and prices are in core.js (PLANS); the database decides what each plan opens. */
"use strict";
const BILL = { cycle: "month", back: null };
// PayPal sends the admin back to /admin/?paypal=return&subscription_id=I-… (or ?paypal=cancel); confirm once, then tidy the address
async function paypalReturn() {
  const q = new URLSearchParams(location.search);
  if (!q.get("paypal")) return;
  history.replaceState(null, "", location.pathname + location.hash);
  if (q.get("paypal") === "cancel") { BILL.back = "cancel"; return; }
  const id = q.get("subscription_id");
  if (!id) { BILL.back = "done"; return; }
  try { const r = await callFn("billing", { action: "confirm", subscription_id: id }); BILL.back = r.ok && r.status === "ACTIVE" ? "ok" : "pending"; }
  catch (err) { BILL.back = "error:" + err.message; }
}
const bicon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const appName = (k) => k !== "documents" && FEATURE_NAMES[k] || PULSE_APPS.find((a) => a.key === k)?.name || k;
const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

async function Billing() {
  await paypalReturn();
  await loadWorkspace();
  const b = S.billing;
  if (!b) { $("#main").innerHTML = `<section class="panel"><h2>One-time setup needed</h2><p>Billing needs the latest database update.</p></section>`; return; }
  const admin = S.profile.role === "admin";
  const paid = b.paid_until && new Date(b.paid_until) > new Date();
  const eff = PLANS[b.effective], seats = Math.max(1, b.seats);
  const status = b.comped ? `Complimentary ${PLANS[b.plan].name}${b.note ? ` · ${esc(b.note)}` : ""}`
    : paid ? `${PLANS[b.plan].name}, paid through ${fmtDate(b.paid_until)} (${b.cycle === "year" ? "yearly" : "monthly"})`
    : b.trial_days_left > 0 ? `Pro trial · ${b.trial_days_left} day${b.trial_days_left === 1 ? "" : "s"} left (ends ${fmtDate(b.trial_ends_at)})`
    : "Starter (free trial ended; no paid plan yet)";
  const total = (p, cycle) => cycle === "year" ? PLANS[p].price * 10 * seats : PLANS[p].price * seats;
  const back = BILL.back || ""; BILL.back = null;
  const backMsg = back === "ok" ? `<div class="notice-bar">${bicon("check")}<div><b>Thank you!</b> Your PayPal subscription is active and your plan is switched on.</div></div>`
    : back === "pending" || back === "done" ? `<div class="notice-bar">${bicon("check")}<div><b>Thank you!</b> PayPal is finishing the payment. Your plan switches on as soon as PayPal confirms it, usually within a minute.</div></div>`
    : back === "cancel" ? `<div class="notice-bar">${bicon("alert")}<div>You left PayPal before finishing. Nothing was charged; choose a plan whenever you're ready.</div></div>`
    : back.startsWith("error:") ? `<div class="notice-bar">${bicon("alert")}<div>${esc(back.slice(6))} If PayPal charged you, email support@bluecredits.org and we'll sort it out.</div></div>` : "";
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Plan and billing</h1><p class="muted">Priced per staff user. Contractors and consultants are free.</p></div></div>
    ${backMsg}
    <section class="panel bill-now">
      <div><span class="muted small">Current plan</span><b class="bill-plan">${eff.name}</b><span>${status}</span></div>
      <div><span class="muted small">Users</span><b>${b.seats}</b><span>${b.contractors} contractor${b.contractors === 1 ? "" : "s"} free</span></div>
      <div><span class="muted small">${b.comped ? "You pay" : paid ? "Your plan costs" : b.trial_days_left > 0 ? "Pro after the trial" : "Starter for your team"}</span>
        <b>${b.comped ? "$0" : "$" + total(paid ? b.plan : b.trial_days_left > 0 ? "pro" : "starter", paid ? b.cycle : "month").toLocaleString()}</b><span>${b.comped ? "complimentary" : paid && b.cycle === "year" ? "per year" : "per month"}</span></div>
    </section>
    ${b.plan === "starter" && !b.comped && b.seats > 10 ? `<div class="notice-bar">${bicon("alert")}<div>Starter covers up to 10 users; you have ${b.seats}. Pro has no limit.</div></div>` : ""}
    <section class="panel">
      <div class="bill-head"><h2>Plans</h2><div class="tabs" role="tablist">${[["month", "Monthly"], ["year", "Yearly · 2 months free"]].map(([k, l]) => `<button role="tab" data-cycle="${k}" aria-selected="${BILL.cycle === k}">${l}</button>`).join("")}</div></div>
      <div class="price-grid">${PLAN_ORDER.map((k, i) => { const p = PLANS[k], current = (paid || b.comped) && b.plan === k;
        return `<div class="price-card ${k === "pro" ? "best" : ""} ${current ? "current" : ""}">${current ? `<span class="price-flag">Your plan</span>` : k === "pro" ? `<span class="price-flag">Most popular</span>` : ""}
          <h3>${p.name}</h3><p class="price"><b>$${BILL.cycle === "year" ? p.price * 10 : p.price}</b> /user/${BILL.cycle === "year" ? "year" : "month"}</p>
          <p class="muted small">${esc(p.blurb)} For your ${seats} user${seats === 1 ? "" : "s"}: <b>$${total(k, BILL.cycle).toLocaleString()}</b> a ${BILL.cycle}.</p>
          <ul>${i ? `<li><b>Everything in ${PLANS[PLAN_ORDER[i - 1]].name}</b></li>` : ""}${p.apps.map((a) => `<li>${esc(appName(a))}</li>`).join("")}<li class="muted">${esc(p.limit)}</li></ul>
          ${admin && !b.comped && !current ? `<button class="btn ${k === "pro" ? "primary" : ""}" data-choose="${k}">${paid && planRank(k) < planRank(b.plan) ? "Switch to" : "Choose"} ${p.name}</button>` : ""}</div>`; }).join("")}</div>
      ${admin && b.has_paypal ? `<div class="actions-row" style="margin-top:12px"><button class="btn" id="syncSeats">Update user count on the subscription</button><button class="btn" id="manage">Payment method and receipts (PayPal)</button><button class="btn danger" id="cancelSub">Cancel subscription</button></div>
        <p class="muted small">Paid through PayPal. Changing plans or the user count takes you to PayPal to approve the new amount.</p>` : ""}
      ${admin ? "" : `<p class="muted">Only admins can change the plan.</p>`}
    </section>
    ${admin ? `<section class="panel"><h2>Billing contact</h2><form id="billForm" class="form-grid">
      <label>Billing email <small class="muted">(receipts and invoices)</small><input name="email" type="email" value="${esc(b.billing_email || S.profile.email || "")}"></label>
      <label>Billing cycle<select name="cycle"><option value="month" ${b.cycle !== "year" ? "selected" : ""}>Monthly</option><option value="year" ${b.cycle === "year" ? "selected" : ""}>Yearly</option></select></label>
      <div class="actions-row" style="grid-column:1/-1"><button class="btn">Save</button></div></form></section>` : ""}
    ${b.operator ? `<section class="panel" id="opPanel"><h2>All workspaces <small>Pulse operators only</small></h2><p class="muted">Set plans for invoiced or complimentary companies, or extend a trial.</p><div id="opList"><p class="muted">Loading…</p></div></section>` : ""}`;
  $$("[data-cycle]").forEach((t) => t.addEventListener("click", () => { BILL.cycle = t.dataset.cycle; Billing(); }));
  $$("[data-choose]").forEach((btn) => btn.addEventListener("click", () => choose(btn.dataset.choose, b, btn)));
  $("#manage")?.addEventListener("click", async (e) => { e.target.disabled = true; try { window.open((await callFn("billing", { action: "manage" })).url, "_blank", "noopener"); } catch (err) { toast(err.message); } e.target.disabled = false; });
  $("#syncSeats")?.addEventListener("click", async (e) => { e.target.disabled = true;
    try { const r = await callFn("billing", { action: "sync_seats" }); if (r.url) { location.href = r.url; return; } toast(`Subscription set to ${r.seats} users`); } catch (err) { toast(err.message); } e.target.disabled = false; });
  $("#cancelSub")?.addEventListener("click", async (e) => {
    if (!confirm(`Cancel the PayPal subscription? You keep ${PLANS[b.plan].name} until ${fmtDate(b.paid_until)}; after that the workspace drops to Starter. Nothing is deleted.`)) return;
    e.target.disabled = true;
    try { await callFn("billing", { action: "cancel", reason: "Cancelled from Pulse" }); toast("Subscription cancelled"); Billing(); } catch (err) { toast(err.message); e.target.disabled = false; } });
  $("#billForm")?.addEventListener("submit", async (e) => { e.preventDefault(); const f = e.target;
    try { await db.rpc("billing_contact", { p_email: f.email.value.trim() || null, p_cycle: f.cycle.value }); toast("Saved"); } catch (err) { toast(err.message); } });
  if (b.operator) Operators();
}

// PayPal (PayPal balance, bank or card) when it's switched on; otherwise ask to be invoiced.
// An existing subscription is revised (PayPal asks the payer to approve the new amount) instead of starting a second one.
async function choose(plan, b, btn) {
  btn.disabled = true;
  try {
    const r = await callFn("billing", { action: b.has_paypal ? "change" : "checkout", plan, cycle: BILL.cycle });
    if (r.url) { location.href = r.url; return; }
    toast(`Switched to ${PLANS[plan].name}`); Billing(); return;
  } catch (err) {
    if (!(err.setup || /Not set up yet|503|Couldn't reach/i.test(err.message))) { toast(err.message); btn.disabled = false; return; }
  }
  btn.disabled = false;
  const p = PLANS[plan], seats = Math.max(1, b.seats), amt = BILL.cycle === "year" ? p.price * 10 * seats : p.price * seats;
  const body = `Hello,\n\nPlease switch ${S.workspace.name} to Pulse ${p.name}, billed ${BILL.cycle === "year" ? "yearly" : "monthly"}.\n\nUsers: ${seats}\nAmount: $${amt} per ${BILL.cycle}\nBilling email: ${b.billing_email || S.profile.email}\n\nThanks,\n${S.profile.display_name}`;
  $("#drawerTitle").textContent = `Upgrade to ${p.name}`;
  $("#drawerBody").innerHTML = `<p>Online payment isn't switched on yet, so we'll send you an invoice for <b>$${amt}</b> per ${BILL.cycle} (${seats} user${seats === 1 ? "" : "s"} × $${BILL.cycle === "year" ? p.price * 10 : p.price}).
      We switch your plan on when we receive the request, usually within one business day.</p>
    <label>Message<textarea id="upBody" rows="10" style="width:100%">${esc(body)}</textarea></label>
    <div class="actions-row" style="margin-top:10px"><a class="btn primary" id="upMail" href="mailto:support@bluecredits.org?subject=${encodeURIComponent("Pulse " + p.name + ": " + S.workspace.name)}&body=${encodeURIComponent(body)}">${bicon("send")}Send the request</a></div>`;
  openDrawer();
  $("#upBody").addEventListener("input", () => ($("#upMail").href = `mailto:support@bluecredits.org?subject=${encodeURIComponent("Pulse " + p.name + ": " + S.workspace.name)}&body=${encodeURIComponent($("#upBody").value)}`));
}

// Pulse operators: every company and its plan
async function Operators() {
  let rows = [];
  try { rows = await db.rpc("billing_workspaces", {}) || []; } catch (e) { $("#opList").textContent = e.message; return; }
  const st = (w) => w.comped ? "Complimentary" : w.paid_until && new Date(w.paid_until) > new Date() ? `Paid to ${fmtDate(w.paid_until)}` : w.trial_ends_at && new Date(w.trial_ends_at) > new Date() ? `Trial to ${fmtDate(w.trial_ends_at)}` : "Starter";
  $("#opList").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Company</th><th>Users</th><th>Plan</th><th>Status</th><th>Monthly</th><th></th></tr></thead><tbody>
    ${rows.map((w) => `<tr style="cursor:default"><td><b>${esc(w.name)}</b>${w.note ? `<small class="muted" style="display:block">${esc(w.note)}</small>` : ""}</td><td class="num">${w.seats}</td>
      <td>${esc(PLANS[w.effective]?.name || w.effective)}</td><td>${esc(st(w))}</td><td class="num">${w.comped ? "$0" : "$" + (PLANS[w.effective].price * Math.max(1, w.seats))}</td>
      <td><button class="btn small" data-op="${w.id}">Change</button></td></tr>`).join("")}</tbody></table></div>`;
  $$("[data-op]").forEach((btn) => btn.addEventListener("click", () => opEdit(rows.find((w) => w.id === btn.dataset.op))));
}
function opEdit(w) {
  const d = (ts) => ts ? new Date(ts).toLocaleDateString("en-CA") : "";
  $("#drawerTitle").textContent = `Plan for ${w.name}`;
  $("#drawerBody").innerHTML = `<form id="opForm" class="form-grid">
    <label>Plan<select name="plan">${PLAN_ORDER.map((k) => `<option value="${k}" ${k === w.plan ? "selected" : ""}>${PLANS[k].name} ($${PLANS[k].price})</option>`).join("")}</select></label>
    <label>Paid through <small class="muted">(after an invoice is paid)</small><input name="paid" type="date" value="${d(w.paid_until)}"></label>
    <label>Trial ends<input name="trial" type="date" value="${d(w.trial_ends_at)}"></label>
    <label class="check" style="align-self:end"><input type="checkbox" name="comped" ${w.comped ? "checked" : ""}> Complimentary (no charge, no end date)</label>
    <label style="grid-column:1/-1">Note<input name="note" value="${esc(w.note || "")}" placeholder="e.g. Invoice INV-104 paid Nov 8"></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button></div></form>`;
  openDrawer();
  $("#opForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target;
    const end = (v) => v ? new Date(v + "T23:59:59").toISOString() : null;
    try {
      await db.rpc("billing_set_plan", { p_ws: w.id, p_plan: f.plan.value, p_paid_until: end(f.paid.value), p_comped: f.comped.checked, p_trial_ends: end(f.trial.value), p_note: f.note.value.trim() || null });
      toast("Plan saved"); closeDrawer(); Billing();
    } catch (err) { toast(err.message); }
  });
}
