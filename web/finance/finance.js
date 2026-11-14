/* Pulse · Finance — income statement, cash flow, balance sheet, budget, project profitability, receivables and taxes.
   Laid out like the SBDC financial model (monthly income statement and cash flow, payroll and loan planners) and fed
   by what Pulse records: invoices, project costs, expense reports, and transactions entered or imported here.
   Uses ../core.js helpers. The database keeps Finance to admins on the Enterprise plan (see "fix z" and "fix z2" in schema.sql). */
"use strict";

const F = { rep: {}, accounts: [], ready: false };
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const isAdmin = () => S.profile?.role === "admin";
const SECTIONS = ["Revenue", "Cost of revenue", "Payroll", "Professional services", "Sales and marketing", "Operating expenses", "Other income", "Other expenses", "Owner and financing"];
const OPEX = ["Payroll", "Professional services", "Sales and marketing", "Operating expenses"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const COST_CATS = ["Subcontractor", "Consultant", "Materials", "Equipment", "Travel", "Software", "Permits and fees", "Other"];
const EXP_CATS = ["Airfare", "Lodging", "Meals", "Ground transport", "Mileage", "Parking and tolls", "Per diem", "Supplies", "Software and subscriptions",
  "Training and conferences", "Phone and internet", "Shipping and postage", "Other"];
const TAX_LINES = {
  "1a": "Gross receipts or sales", "2": "Cost of goods sold", "5": "Interest", "10": "Other income", "12": "Compensation of officers", "13": "Salaries and wages",
  "14": "Repairs and maintenance", "16": "Rents", "17": "Taxes and licenses", "18": "Interest", "22": "Advertising", "23": "Pension, profit-sharing plans",
  "24": "Employee benefit programs", "26": "Other deductions",
};

/* ---------------------------------------------------------------- numbers and dates */
const usd = (n, dec = 0) => {
  const v = Math.round((+n || 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (v < 0 ? "−$" : "$") + s;
};
const cell$ = (n) => (Math.abs(+n || 0) < 0.005 ? `<span class="z">–</span>` : usd(n));
const pct = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 10 + "%" : "–");
const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const ym = (iso) => String(iso).slice(0, 7);
const ymAdd = (m, n) => { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const ymEnd = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo, 0).toLocaleDateString("en-CA"); };
const ymLabel = (m, long) => { const [y, mo] = m.split("-").map(Number); return `${(long ? MONTHS_LONG : MONTHS)[mo - 1]} ${long ? y : String(y).slice(2)}`; };
const thisMonth = () => ym(today());
const safe = async (q) => { try { return must(await q) || []; } catch { return []; } };

/* ---------------------------------------------------------------- settings (workspaces.config.finance) */
const cfg = () => ({ fy_start: 1, basis: "cash", opening_cash: 0, opening_date: null, ...(S.workspace?.config?.finance || {}) });
async function saveCfg(patch) {
  const next = { ...cfg(), ...patch };
  must(await sb.rpc("update_workspace", { p: { config: { ...(S.workspace.config || {}), finance: next } } }));
  await loadWorkspace();
}
// fiscal year y starts in month fy_start of year y; a calendar year when fy_start is 1
const fyOf = (iso) => { const s = cfg().fy_start, [y, m] = ym(iso).split("-").map(Number); return m >= s ? y : y - 1; };
const fyMonths = (y) => { const s = cfg().fy_start; return Array.from({ length: 12 }, (_, i) => ymAdd(`${y}-${String(s).padStart(2, "0")}`, i)); };
const fyRange = (y) => { const ms = fyMonths(y); return { from: ms[0] + "-01", to: ymEnd(ms[11]), months: ms }; };
const fyLabel = (y) => (cfg().fy_start === 1 ? String(y) : `FY ${y}–${String(y + 1).slice(2)}`);
const fyLong = (y) => { const ms = fyMonths(y); return cfg().fy_start === 1 ? `January – December ${y}` : `${ymLabel(ms[0], true)} – ${ymLabel(ms[11], true)}`; };
const yearParam = (p, def) => (/^\d{4}$/.test(p || "") ? +p : def);

/* ---------------------------------------------------------------- data */
async function ensureSetup() {
  if (F.ready) return;
  must(await sb.rpc("fin_setup"));
  F.ready = true;
}
// actual[a][m] = amount; src[a][m] = {invoice, cost, expense, entry}; budget[a][m] = {q, v}
async function report(from, to, basis) {
  const key = `${from}|${to}|${basis}`;
  const d = must(await sb.rpc("fin_report", { p_from: from, p_to: to, p_basis: basis }));
  const actual = {}, src = {}, budget = {};
  d.actual.forEach((r) => {
    ((actual[r.a] ||= {})[r.m] = (actual[r.a]?.[r.m] || 0) + +r.v);
    (((src[r.a] ||= {})[r.m] ||= {})[r.src] = { v: +r.v, n: +r.n });
  });
  d.budget.forEach((r) => ((budget[r.a] ||= {})[r.m] = { q: r.q == null ? null : +r.q, v: +r.v }));
  F.accounts = d.accounts;
  return (F.rep[key] = { accounts: d.accounts, actual, src, budget });
}
const acct = (id) => F.accounts.find((a) => a.id === id);
const sign = (a) => (a.direction === "in" ? 1 : -1);
const inPnl = (a) => a.section !== "Owner and financing";
const sumA = (map, a, months) => months.reduce((t, m) => t + (map[a.id]?.[m] || 0), 0);
const sumB = (map, a, months) => months.reduce((t, m) => t + (map[a.id]?.[m]?.v || 0), 0);

// the income statement as rows: {kind: 'head'|'acct'|'sub'|'total'|'pct', label, acct?, vals: {m: v}}
function pnlRows(R, months, which) {
  const val = (a, m) => (which === "budget" ? R.budget[a.id]?.[m]?.v || 0 : R.actual[a.id]?.[m] || 0);
  // the same lines for actual and budget, so the two can be compared row by row
  const accts = (sec) => R.accounts.filter((a) => a.section === sec && (a.active || months.some((m) => R.actual[a.id]?.[m] || R.budget[a.id]?.[m]?.v)));
  const add = (x, y, k = 1) => Object.fromEntries(months.map((m) => [m, (x[m] || 0) + k * (y[m] || 0)]));
  const zero = Object.fromEntries(months.map((m) => [m, 0]));
  const rows = [];
  const block = (sec, label, groups) => {
    const list = accts(sec); let tot = { ...zero };
    rows.push({ kind: "head", label });
    const grpNames = [...new Set(list.map((a) => a.grp || ""))];
    for (const g of grpNames) {
      const inG = list.filter((a) => (a.grp || "") === g); let gt = { ...zero };
      if (groups && g && grpNames.length > 1) rows.push({ kind: "grp", label: g });
      for (const a of inG) { const v = Object.fromEntries(months.map((m) => [m, val(a, m)])); rows.push({ kind: "acct", label: a.name, acct: a, vals: v }); gt = add(gt, v); }
      if (groups && g && grpNames.length > 1 && inG.length > 1) rows.push({ kind: "sub", label: `Total ${g.toLowerCase()}`, vals: gt, good: sec === "Revenue" || sec === "Other income" ? 1 : -1 });
      tot = add(tot, gt);
    }
    return tot;
  };
  const rev = block("Revenue", "Revenue", true); rows.push({ kind: "total", label: "Total revenue", vals: rev, good: 1 });
  const cor = block("Cost of revenue", "Cost of revenue"); rows.push({ kind: "total", label: "Total cost of revenue", vals: cor, good: -1 });
  const gm = add(rev, cor, -1); rows.push({ kind: "total strong", label: "Gross margin", vals: gm, good: 1 });
  rows.push({ kind: "pct", label: "Gross margin %", vals: Object.fromEntries(months.map((m) => [m, rev[m] ? gm[m] / rev[m] : NaN])), num: gm, den: rev });
  rows.push({ kind: "head", label: "Operating expenses" });
  let opex = { ...zero };
  for (const sec of OPEX) {
    const list = accts(sec); if (!list.length) continue;
    const nm = sec === "Operating expenses" ? "Other operating expenses" : sec;
    rows.push({ kind: "grp", label: nm }); let st = { ...zero };
    for (const a of list) { const v = Object.fromEntries(months.map((m) => [m, val(a, m)])); rows.push({ kind: "acct", label: a.name, acct: a, vals: v }); st = add(st, v); }
    rows.push({ kind: "sub", label: `Total ${nm.toLowerCase()}`, vals: st, good: -1 }); opex = add(opex, st);
  }
  rows.push({ kind: "total", label: "Total operating expenses", vals: opex, good: -1 });
  const op = add(gm, opex, -1); rows.push({ kind: "total strong", label: "Operating income", vals: op, good: 1 });
  const oi = block("Other income", "Other income and expenses"); const ox = {};
  const oxList = accts("Other expenses"); let oxt = { ...zero };
  for (const a of oxList) { const v = Object.fromEntries(months.map((m) => [m, val(a, m)])); rows.push({ kind: "acct", label: a.name, acct: a, vals: v, neg: true }); oxt = add(oxt, v); }
  const ni = add(add(op, oi), oxt, -1); rows.push({ kind: "total net", label: "Net income", vals: ni, good: 1 });
  return { rows, rev, cor, gm, opex, op, ni, oi, ox: oxt };
}

/* ---------------------------------------------------------------- shared bits */
function head(title, sub, right = "") {
  return `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ""}</div><div class="actions-row no-print">${right}</div></div>`;
}
function yearNav(route, y) {
  return `<div class="actions-row week-nav"><a class="btn small" href="#/${route}/${y - 1}" aria-label="Previous year">${icon("chevron-left")}</a>
    <b class="week-label">${fyLabel(y)}</b><a class="btn small" href="#/${route}/${y + 1}" aria-label="Next year">${icon("chevron-right")}</a>
    ${y !== fyOf(today()) ? `<a class="btn small" href="#/${route}">This year</a>` : ""}</div>`;
}
const basisNote = (b) => (b === "accrual" ? "Accrual basis: revenue when invoiced, expenses when approved." : "Cash basis: revenue when paid, expenses when paid.");
function kpi(label, value, small, cls = "") {
  return `<div class="kpi panel ${cls}"><div><span>${label}</span><b>${value}</b>${small ? `<small>${small}</small>` : ""}</div></div>`;
}
function csvFrom(name, table) {
  const rows = [...table.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => td.dataset.v ?? td.innerText.replace(/\s+/g, " ").trim()));
  downloadCsv(name, rows[0], rows.slice(1));
}

/* ================================================================ Overview */
async function Overview() {
  await ensureSetup();
  const c = cfg(), y = fyOf(today()), { from, to, months } = fyRange(y), now = thisMonth();
  const ytd = months.filter((m) => m <= now);
  const R = await report(from, to, c.basis), P = pnlRows(R, months, "actual"), B = pnlRows(R, months, "budget");
  const t = (o, ms = ytd) => ms.reduce((s, m) => s + (o[m] || 0), 0);
  const inv = await safe(sb.from("inv_invoices").select("*").eq("status", "Sent"));
  const ar = (inv || []).reduce((s, i) => s + invTotal(i), 0), late = (inv || []).filter((i) => i.due_date && i.due_date < today());
  const cash = await cashNow();
  const hasBudget = Object.keys(R.budget).length > 0;
  const max = Math.max(1, ...months.map((m) => Math.max(P.rev[m] || 0, (P.cor[m] || 0) + (P.opex[m] || 0), B.rev[m] || 0)));
  $("#main").innerHTML = `
    ${head("Finance", `${esc(fyLong(y))} · ${basisNote(c.basis)}`, `<a class="btn" href="#/taxes">Taxes</a><a class="btn primary" href="#/pnl">Income statement</a>`)}
    ${!c.opening_date ? `<div class="notice-bar">${icon("alert")}<div><b>Set your opening cash</b> so the cash flow and balance sheet start from the right number. <a href="#/settings">Settings</a></div></div>` : ""}
    <div class="kpis">
      ${kpi("Revenue this year", usd(t(P.rev)), hasBudget ? `budget ${usd(t(B.rev))} to date` : `${ytd.length} months so far`)}
      ${kpi("Expenses this year", usd(t(P.cor) + t(P.opex)), hasBudget ? `budget ${usd(t(B.cor) + t(B.opex))} to date` : "cost of revenue and operating")}
      ${kpi("Net income this year", usd(t(P.ni)), hasBudget ? `budget ${usd(t(B.ni))} to date` : "", t(P.ni) < 0 ? "neg" : "")}
      ${kpi("Cash", c.opening_date ? usd(cash) : "Not set", c.opening_date ? `from ${short(c.opening_date)} opening plus activity` : "add opening cash in Settings")}
      ${kpi("Owed to you", usd(ar), late.length ? `${late.length} invoice${late.length > 1 ? "s" : ""} past due` : "unpaid invoices", late.length ? "alert" : "")}
    </div>
    <section class="panel"><div class="panel-head"><h2>Month by month</h2><span class="legend"><i class="lg rev"></i>Revenue <i class="lg exp"></i>Expenses${hasBudget ? ` <i class="lg bud"></i>Budgeted revenue` : ""}</span></div>
      <div class="fin-bars">${months.map((m) => {
        const r = P.rev[m] || 0, e = (P.cor[m] || 0) + (P.opex[m] || 0), b = B.rev[m] || 0;
        return `<div class="fin-bar ${m > now ? "future" : ""}" title="${ymLabel(m, true)}: revenue ${usd(r)}, expenses ${usd(e)}${hasBudget ? `, budgeted revenue ${usd(b)}` : ""}">
          <div class="bars"><i class="rev" style="height:${(100 * r / max).toFixed(1)}%"></i><i class="exp" style="height:${(100 * e / max).toFixed(1)}%"></i>${hasBudget ? `<i class="bud" style="height:${(100 * b / max).toFixed(1)}%"></i>` : ""}</div>
          <small>${MONTHS[+m.slice(5) - 1]}</small></div>`; }).join("")}</div></section>
    <div class="fin-cards">
      <a class="panel fin-card" href="#/pnl"><b>Income statement</b><span>Monthly, actual vs. budget, by account</span></a>
      <a class="panel fin-card" href="#/cash"><b>Cash flow</b><span>Actuals to date, then the budget as a forecast</span></a>
      <a class="panel fin-card" href="#/projects"><b>Project profitability</b><span>Billed, collected, costs and margin by project</span></a>
      <a class="panel fin-card" href="#/receivables"><b>Receivables</b><span>Unpaid invoices by how late they are</span></a>
      <a class="panel fin-card" href="#/budget"><b>Budget</b><span>Plan by month, payroll and loan planners, model import</span></a>
      <a class="panel fin-card" href="#/taxes"><b>Taxes</b><span>Form 1120 lines, 1099s, year-end package for your CPA</span></a>
    </div>`;
}
function invNet(i) { return Math.max(0, (i.items || []).reduce((s, x) => s + (+x.qty || 0) * (+x.rate || 0), 0) - (+i.discount || 0)); }
function invTotal(i) { return invNet(i) * (1 + (+i.tax_rate || 0) / 100); }
// cash today = opening cash + every cash-basis movement since the opening date (financing included)
async function cashNow(asof = today()) {
  const c = cfg(); if (!c.opening_date) return 0;
  const R = await report(c.opening_date, asof, "cash");
  let v = +c.opening_cash || 0;
  for (const a of R.accounts) for (const m in R.actual[a.id] || {}) v += sign(a) * R.actual[a.id][m];
  return v;
}

/* ================================================================ Income statement */
async function Pnl(param) {
  await ensureSetup();
  const c = cfg(), y = yearParam(param, fyOf(today())), { from, to, months } = fyRange(y), now = thisMonth();
  const view = F.pnlView || "actual", hide = F.pnlHide ?? true;
  const R = await report(from, to, c.basis);
  const A = pnlRows(R, months, "actual"), B = pnlRows(R, months, "budget");
  const ytd = months.filter((m) => m <= now), past = ytd.length === 12 || months[11] < now || !ytd.length ? months : ytd;
  const tot = (vals, ms = months) => ms.reduce((s, m) => s + (vals?.[m] || 0), 0);
  let table;
  if (view === "compare") {
    const bRow = (r, i) => B.rows[i];
    table = `<table class="fin-table cmp"><thead><tr><th>Account</th><th class="num">Actual${past !== months ? " to date" : ""}</th><th class="num">Budget${past !== months ? " to date" : ""}</th><th class="num">Variance</th><th class="num">%</th><th class="num">Full-year budget</th></tr></thead><tbody>
      ${tidyRows(A.rows.map((r, i) => {
        if (r.kind === "head" || r.kind === "grp") return `<tr class="${r.kind}"><td colspan="6">${esc(r.label)}</td></tr>`;
        const br = bRow(r, i);
        if (r.kind === "pct") { const a = tot(r.num, past) / tot(r.den, past), b = tot(br.num, past) / tot(br.den, past); return `<tr class="pct"><td>${r.label}</td><td class="num">${pct(a)}</td><td class="num">${pct(b)}</td><td></td><td></td><td></td></tr>`; }
        const a = tot(r.vals, past), b = br ? tot(br.vals, past) : 0, fb = br ? tot(br.vals) : 0;
        if (hide && r.kind === "acct" && !a && !fb) return "";
        const good = r.acct ? (r.acct.direction === "in" ? a - b : b - a) : (r.good || 1) * (a - b);
        return `<tr class="${r.kind}"><td>${esc(r.label)}</td><td class="num" data-v="${r2(a)}">${cell$(a)}</td><td class="num" data-v="${r2(b)}">${cell$(b)}</td>
          <td class="num ${b || a ? (good >= 0 ? "pos" : "neg") : ""}" data-v="${r2(a - b)}">${b || a ? usd(a - b) : ""}</td><td class="num">${b ? pct((a - b) / Math.abs(b)) : ""}</td><td class="num" data-v="${r2(fb)}">${cell$(fb)}</td></tr>`;
      }).join(""))}</tbody></table>`;
  } else {
    const P = view === "budget" ? B : A;
    table = `<table class="fin-table"><thead><tr><th>Account</th>${months.map((m) => `<th class="num ${m > now && view === "actual" ? "future" : ""}">${ymLabel(m)}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>
      ${tidyRows(P.rows.map((r) => {
        if (r.kind === "head" || r.kind === "grp") return `<tr class="${r.kind}"><td colspan="${months.length + 2}">${esc(r.label)}</td></tr>`;
        if (r.kind === "pct") return `<tr class="pct"><td>${r.label}</td>${months.map((m) => `<td class="num">${r.den[m] ? pct(r.vals[m]) : ""}</td>`).join("")}<td class="num">${pct(tot(r.num) / tot(r.den))}</td></tr>`;
        const T = tot(r.vals);
        if (hide && r.kind === "acct" && !T && !months.some((m) => r.vals[m])) return "";
        return `<tr class="${r.kind}"><td>${esc(r.label)}</td>${months.map((m) => `<td class="num ${r.acct && view === "actual" && r.vals[m] ? "drill" : ""}" ${r.acct ? `data-a="${r.acct.id}" data-m="${m}"` : ""} data-v="${r2(r.vals[m])}">${cell$(r.vals[m])}</td>`).join("")}<td class="num" data-v="${r2(T)}"><b>${cell$(T)}</b></td></tr>`;
      }).join(""))}</tbody></table>`;
  }
  const hasBudget = Object.keys(R.budget).length > 0;
  $("#main").innerHTML = `
    ${head("Income statement", `${esc(fyLong(y))} · ${basisNote(c.basis)}`, `${yearNav("pnl", y)}`)}
    <div class="filters no-print"><div class="tabs" role="tablist">${[["actual", "Actual"], ["budget", "Budget"], ["compare", "Actual vs. budget"]].map(([k, l]) => `<button role="tab" aria-selected="${view === k}" data-view="${k}">${l}</button>`).join("")}</div>
      <label class="check"><input type="checkbox" id="hideZero" ${hide ? "checked" : ""}> Hide empty lines</label>
      <span class="spacer"></span><button class="btn small" id="csv">Download CSV</button><button class="btn small" onclick="print()">Print or save as PDF</button></div>
    ${view !== "actual" && !hasBudget ? `<div class="notice-bar">${icon("alert")}<div>No budget for ${esc(fyLabel(y))} yet. <a href="#/budget/${y}">Plan it in Budget</a> or import a financial model there.</div></div>` : ""}
    <section class="panel fin-panel"><div class="print-only"><h2>${esc(S.workspace?.name || "")} · Income statement · ${esc(fyLabel(y))}</h2><p>${basisNote(c.basis)} ${view === "budget" ? "Budget." : view === "compare" ? "Actual vs. budget." : "Actual."}</p></div>
      <div class="table-wrap">${table}</div></section>
    <p class="muted small no-print">Click an amount to see where it came from. Revenue comes from invoices; costs from Projects, expense reports and the transactions in <a href="#/ledger">Transactions</a>. Which account each category posts to is in <a href="#/settings">Settings</a>.</p>`;
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { F.pnlView = b.dataset.view; Pnl(String(y)); }));
  $("#hideZero").addEventListener("change", (e) => { F.pnlHide = e.target.checked; Pnl(String(y)); });
  $("#csv").addEventListener("click", () => csvFrom(`income-statement-${fyLabel(y).replace(/\s+/g, "-")}.csv`, $(".fin-table")));
  $$("td.drill").forEach((td) => td.addEventListener("click", () => drill(+td.dataset.a, td.dataset.m, R)));
}
// drop group headings and subtotals whose lines are all hidden
function tidyRows(html) {
  const box = document.createElement("tbody"); box.innerHTML = html;
  const trs = [...box.children];
  trs.forEach((tr, i) => {
    if (!tr.classList.contains("grp")) return;
    let j = i + 1, any = false;
    while (j < trs.length && !trs[j].classList.contains("grp") && !trs[j].classList.contains("head") && !trs[j].classList.contains("total")) { if (trs[j].classList.contains("acct")) any = true; j++; }
    if (!any) for (let k = i; k < j; k++) trs[k].remove();
    else if (trs.slice(i + 1, j).filter((t) => t.classList.contains("acct")).length === 1) trs.slice(i + 1, j).filter((t) => t.classList.contains("sub")).forEach((t) => t.remove());   // no subtotal for a single line
  });
  const left = [...box.children];
  left.forEach((tr, i) => {   // a section heading with no lines under it
    if (!tr.classList.contains("head")) return;
    let j = i + 1, any = false;
    while (j < left.length && !left[j].classList.contains("head") && !left[j].classList.contains("total")) { if (left[j].classList.contains("acct")) any = true; j++; }
    if (!any) tr.remove();
  });
  return box.innerHTML;
}
// where one account's month came from
async function drill(aid, m, R) {
  const a = acct(aid), s = R.src[aid]?.[m] || {}, c = cfg();
  const names = { invoice: "Invoices", cost: "Project costs", expense: "Expense reports", entry: "Transactions entered or imported" };
  const links = { invoice: "../agreements/#/invoices", cost: "../projects/", expense: "../timecards/#/expenses/all", entry: `#/ledger?a=${aid}&m=${m}` };
  const ent = s.entry ? must(await sb.from("fin_entries").select("*").eq("account_id", aid).gte("entry_date", m + "-01").lte("entry_date", ymEnd(m)).order("entry_date")) : [];
  $("#drawerTitle").textContent = `${a?.name || "Account"} · ${ymLabel(m, true)}`;
  $("#drawerBody").innerHTML = `<p class="muted">${esc(a?.section || "")} · ${basisNote(c.basis)}</p>
    <table class="mini"><tbody>${Object.entries(s).map(([k, x]) => `<tr><td><a href="${links[k]}">${names[k]}</a> <small class="muted">(${x.n})</small></td><td class="num">${usd(x.v, 2)}</td></tr>`).join("")}
      <tr class="total"><td>Total</td><td class="num">${usd(Object.values(s).reduce((t, x) => t + x.v, 0), 2)}</td></tr></tbody></table>
    ${ent.length ? `<h3>Transactions</h3><table class="mini"><tbody>${ent.map((e) => `<tr><td>${short(e.entry_date)}</td><td>${esc(e.payee || e.memo || "")}${e.batch ? ` <small class="muted">imported</small>` : ""}</td><td class="num">${usd(e.amount, 2)}</td></tr>`).join("")}</tbody></table>` : ""}`;
  openDrawer();
}

/* ================================================================ Cash flow */
async function Cash(param) {
  await ensureSetup();
  const c = cfg(), y = yearParam(param, fyOf(today())), { from, to, months } = fyRange(y), now = thisMonth();
  const R = await report(from, to, "cash");
  // opening balance for this year: opening cash plus every movement between the opening date and the year's start
  let begin = +c.opening_cash || 0, note = "";
  if (c.opening_date && c.opening_date < from) {
    const P = await report(c.opening_date, addDays(from, -1), "cash");
    for (const a of P.accounts) for (const m in P.actual[a.id] || {}) begin += sign(a) * P.actual[a.id][m];
  } else if (!c.opening_date) note = "No opening cash set, so this starts from $0.";
  else if (c.opening_date > to) { begin = 0; note = `Your opening cash is dated ${short(c.opening_date)}, after this year.`; }
  const useBud = (m) => m > now, val = (a, m) => (useBud(m) ? R.budget[a.id]?.[m]?.v || 0 : (c.opening_date && m < ym(c.opening_date) ? 0 : R.actual[a.id]?.[m] || 0));
  const group = (pred) => Object.fromEntries(months.map((m) => [m, R.accounts.filter(pred).reduce((s, a) => s + sign(a) * val(a, m), 0)]));
  const inOps = group((a) => inPnl(a) && a.direction === "in"), outOps = group((a) => inPnl(a) && a.direction === "out");
  const finIn = R.accounts.filter((a) => a.section === "Owner and financing" && a.direction === "in"), finOut = R.accounts.filter((a) => a.section === "Owner and financing" && a.direction === "out");
  const ops = Object.fromEntries(months.map((m) => [m, inOps[m] + outOps[m]]));
  const fin = group((a) => a.section === "Owner and financing");
  let run = begin; const beg = {}, end = {}, chg = {};
  for (const m of months) { beg[m] = run; chg[m] = ops[m] + fin[m]; run += chg[m]; end[m] = run; }
  const live = months.filter((m) => !(c.opening_date && m < ym(c.opening_date)));
  const minM = (live.length ? live : months).reduce((a, m) => (end[m] < end[a] ? m : a), (live.length ? live : months)[0]);
  const pre = (m) => c.opening_date && m < ym(c.opening_date);
  const row = (label, vals, cls = "", neg = false) => `<tr class="${cls}"><td>${label}</td>${months.map((m) => `<td class="num ${useBud(m) ? "fc" : ""}" data-v="${pre(m) ? "" : r2(vals[m])}">${pre(m) ? `<span class="z">·</span>` : cell$(neg ? -vals[m] : vals[m])}</td>`).join("")}</tr>`;
  const acctRow = (a) => { const v = Object.fromEntries(months.map((m) => [m, val(a, m)])); return months.some((m) => v[m]) ? row(esc(a.name), v, "acct") : ""; };
  $("#main").innerHTML = `
    ${head("Cash flow", `${esc(fyLong(y))} · actual cash in and out to date, then your budget as the forecast`, yearNav("cash", y))}
    <div class="filters no-print"><span class="legend"><i class="lg act"></i>Actual <i class="lg fc"></i>Forecast from the budget</span><span class="spacer"></span><button class="btn small" id="csv">Download CSV</button><button class="btn small" onclick="print()">Print or save as PDF</button></div>
    ${note ? `<div class="notice-bar">${icon("alert")}<div>${note} <a href="#/settings">Set opening cash</a></div></div>` : ""}
    ${end[minM] < 0 ? `<div class="notice-bar alert">${icon("alert")}<div><b>Cash goes below zero in ${ymLabel(minM, true)}</b> (${usd(end[minM])}). Plan funding, collect sooner or trim costs before then.</div></div>` : ""}
    <section class="panel fin-panel"><div class="print-only"><h2>${esc(S.workspace?.name || "")} · Cash flow · ${esc(fyLabel(y))}</h2></div><div class="table-wrap"><table class="fin-table">
      <thead><tr><th></th>${months.map((m) => `<th class="num ${useBud(m) ? "future" : ""}">${ymLabel(m)}${useBud(m) ? "<small>forecast</small>" : ""}</th>`).join("")}</tr></thead><tbody>
      ${row("Beginning cash", beg, "total")}
      <tr class="head"><td colspan="13">Operations</td></tr>
      ${row("Cash in (revenue and other income)", inOps)}
      ${row("Cash out (costs and expenses)", outOps, "", true)}
      ${row("Net cash from operations", ops, "sub")}
      <tr class="head"><td colspan="13">Owner and financing</td></tr>
      ${finIn.map(acctRow).join("")}${finOut.map((a) => { const v = Object.fromEntries(months.map((m) => [m, -val(a, m)])); return months.some((m) => v[m]) ? row(esc(a.name), v, "acct") : ""; }).join("")}
      ${row("Net cash from owner and financing", fin, "sub")}
      ${row("Change in cash", chg, "total")}
      ${row("Ending cash", end, "total net")}
      </tbody></table></div></section>
    <p class="muted small">Lowest point this year: <b>${usd(end[minM])}</b> at the end of ${ymLabel(minM, true)}. Cash flow is always cash basis. Opening cash is set in <a href="#/settings">Settings</a>.</p>`;
  $("#csv").addEventListener("click", () => csvFrom(`cash-flow-${fyLabel(y).replace(/\s+/g, "-")}.csv`, $(".fin-table")));
}

/* ================================================================ Balance sheet */
async function Balance(param) {
  await ensureSetup();
  const c = cfg(), asof = /^\d{4}-\d{2}-\d{2}$/.test(param || "") ? param : today();
  const cash = await cashNow(asof), b = must(await sb.rpc("fin_balances", { p_asof: asof }));
  let loans = 0, invest = 0, draws = 0;
  if (c.opening_date) {
    const R = await report(c.opening_date, asof, "cash");
    for (const a of R.accounts) {
      const t = Object.values(R.actual[a.id] || {}).reduce((s, v) => s + v, 0);
      if (a.sys === "fin_loan_in") loans += t; if (a.sys === "fin_loan_out") loans -= t;
      if (a.sys === "fin_invest") invest += t; if (a.sys === "fin_draw") draws += t;
    }
  }
  const ar = +b.receivable || 0, reimb = +b.reimburse || 0;
  const assets = cash + ar, liab = Math.max(0, loans) + reimb, capital = (+c.opening_cash || 0) + invest - draws, re = assets - liab - capital;
  const line = (l, v, cls = "") => `<tr class="${cls}"><td>${l}</td><td class="num">${usd(v, 2)}</td></tr>`;
  $("#main").innerHTML = `
    ${head("Balance sheet", `As of ${short(asof)} · from what Pulse records`, `<label class="inline">As of <input type="date" id="asof" value="${asof}"></label><button class="btn small" onclick="print()">Print or save as PDF</button>`)}
    ${!c.opening_date ? `<div class="notice-bar">${icon("alert")}<div><b>Set your opening cash</b> in <a href="#/settings">Settings</a> (for example, your bank balance on the first day you track in Pulse).</div></div>` : ""}
    <div class="fin-bs">
      <section class="panel"><h2>Assets</h2><table class="mini"><tbody>
        ${line("Cash", cash)}${line("Accounts receivable (unpaid invoices)", ar)}${line("Total assets", assets, "total")}</tbody></table></section>
      <section class="panel"><h2>Liabilities and equity</h2><table class="mini"><tbody>
        ${line("Loans outstanding", Math.max(0, loans))}${line("Expense reports approved, not yet reimbursed", reimb)}${line("Total liabilities", liab, "total")}
        ${line("Opening balance", +c.opening_cash || 0)}${line("Owner investment, less draws", invest - draws)}${line("Retained earnings (to date)", re)}
        ${line("Total equity", assets - liab, "total")}${line("Total liabilities and equity", assets, "total net")}</tbody></table></section>
    </div>
    <p class="muted small">Pulse keeps simple books: cash, what clients owe you, loans and reimbursements owed. Retained earnings is what's left after those and the owner's capital, so the sheet always balances.
      Your CPA's balance sheet will also include equipment and software you capitalized, prepaid items, credit card balances and anything paid outside Pulse.${b.sales_tax > 0 ? ` Invoices include ${usd(b.sales_tax, 2)} of sales tax, which you owe to the state once collected.` : ""}</p>`;
  $("#asof").addEventListener("change", (e) => e.target.value && (location.hash = `#/balance/${e.target.value}`));
}

/* ================================================================ Project profitability */
async function Projects(param) {
  await ensureSetup();
  const y = /^\d{4}$/.test(param || "") ? +param : null, range = y ? fyRange(y) : { from: "2000-01-01", to: addDays(today(), 366) };
  const rows = must(await sb.rpc("fin_projects", { p_from: range.from, p_to: range.to })).filter((r) => r.billed || r.costs || r.hours || r.status === "Active");
  const T = (k) => rows.reduce((s, r) => s + (+r[k] || 0), 0);
  const margin = (r) => +r.billed - +r.costs - +r.staff_cost;
  $("#main").innerHTML = `
    ${head("Project profitability", y ? esc(fyLong(y)) : "All time", `<div class="tabs">${[["", "All time"], [String(fyOf(today())), fyLabel(fyOf(today()))], [String(fyOf(today()) - 1), fyLabel(fyOf(today()) - 1)]].map(([k, l]) => `<a role="tab" href="#/projects${k ? "/" + k : ""}" aria-selected="${String(y || "") === k}">${l}</a>`).join("")}</div>`)}
    <div class="kpis">${kpi("Billed", usd(T("billed")), `${usd(T("collected"))} collected`)}${kpi("Costs recorded", usd(T("costs")), "subcontractors, consultants, materials, travel")}${kpi("Staff time (at pay rates)", usd(T("staff_cost")), "employees' approved hours × their rates")}${kpi("Margin", usd(T("billed") - T("costs") - T("staff_cost")), T("billed") ? pct((T("billed") - T("costs") - T("staff_cost")) / T("billed")) + " of billed" : "", T("billed") - T("costs") - T("staff_cost") < 0 ? "neg" : "")}</div>
    <section class="panel fin-panel"><div class="table-wrap"><table class="fin-table proj"><thead><tr><th>Project</th><th class="num">Contract</th><th class="num">Billed</th><th class="num">Collected</th><th class="num">Hours</th><th class="num">Work at billing rates</th><th class="num">Not billed yet</th><th class="num">Costs recorded</th><th class="num">Staff time</th><th class="num">Margin</th><th class="num">Contractor time at their rates</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => { const mg = margin(r), unb = Math.max(0, +r.labor_value - +r.billed); return `<tr><td><a href="../projects/#/project/${r.id}"><b>${esc(r.name)}</b></a><small>${esc([r.code, r.client].filter(Boolean).join(" · "))}</small></td>
        <td class="num">${r.contract_value ? usd(r.contract_value) : ""}</td><td class="num">${cell$(r.billed)}</td><td class="num">${cell$(r.collected)}</td><td class="num">${(+r.hours || 0).toLocaleString("en-US", { maximumFractionDigits: 1 })}</td>
        <td class="num">${cell$(r.labor_value)}</td><td class="num ${unb > 0 ? "warn" : ""}">${cell$(unb)}</td><td class="num">${cell$(r.costs)}</td><td class="num">${cell$(r.staff_cost)}</td>
        <td class="num ${mg < 0 ? "neg" : mg > 0 ? "pos" : ""}"><b>${cell$(mg)}</b>${+r.billed ? `<small>${pct(mg / +r.billed)}</small>` : ""}</td><td class="num muted">${cell$(r.contractor_cost)}</td></tr>`; }).join("")
        : `<tr><td colspan="11" class="empty">No project activity in this period.</td></tr>`}</tbody></table></div></section>
    <p class="muted small"><b>Margin</b> = billed − costs recorded on the project − employees' approved hours at their pay rates. Contractors are paid through the costs you record (their invoices or agreement payments), so their time is shown for reference only.
      <b>Not billed yet</b> = approved hours at billing rates minus what's been invoiced: work you can still invoice.</p>`;
}

/* ================================================================ Receivables */
async function Receivables(param) {
  await ensureSetup();
  const all = param === "all";
  const inv = must(await sb.from("inv_invoices").select("*").neq("status", "Void").order("issue_date", { ascending: false }));
  const accts = F.accounts.length ? F.accounts : (await report(today(), today(), "cash")).accounts;
  const revAccts = accts.filter((a) => a.section === "Revenue" || a.section === "Other income");
  const open = inv.filter((i) => i.status === "Sent");
  const late = (i) => (i.due_date ? daysUntil(i.due_date) * -1 : 0);
  const bucket = (i) => { const d = late(i); return d <= 0 ? "Not due yet" : d <= 30 ? "1–30 days late" : d <= 60 ? "31–60 days late" : d <= 90 ? "61–90 days late" : "Over 90 days late"; };
  const B = ["Not due yet", "1–30 days late", "31–60 days late", "61–90 days late", "Over 90 days late"];
  const byB = Object.fromEntries(B.map((b) => [b, open.filter((i) => bucket(i) === b).reduce((s, i) => s + invTotal(i), 0)]));
  const clients = {}; open.forEach((i) => { const c = (clients[i.client_name] ||= { total: 0, n: 0, oldest: 0 }); c.total += invTotal(i); c.n++; c.oldest = Math.max(c.oldest, late(i)); });
  const list = all ? inv : open;
  $("#main").innerHTML = `
    ${head("Receivables", "Invoices sent and not yet paid, by how late they are", `<div class="tabs"><a role="tab" href="#/receivables" aria-selected="${!all}">Unpaid</a><a role="tab" href="#/receivables/all" aria-selected="${all}">All invoices</a></div><a class="btn" href="../agreements/#/invoices">Open invoices</a>`)}
    <div class="kpis fin-aging">${B.map((b, k) => kpi(b, usd(byB[b]), `${open.filter((i) => bucket(i) === b).length} invoices`, k >= 3 && byB[b] ? "alert" : "")).join("")}</div>
    ${!all && Object.keys(clients).length ? `<section class="panel fin-panel"><div class="panel-head"><h2>By client</h2></div><div class="table-wrap"><table class="fin-table"><thead><tr><th>Client</th><th class="num">Invoices</th><th class="num">Owed</th><th class="num">Most days late</th></tr></thead><tbody>
      ${Object.entries(clients).sort((a, b) => b[1].total - a[1].total).map(([n, c]) => `<tr><td><b>${esc(n)}</b></td><td class="num">${c.n}</td><td class="num">${usd(c.total, 2)}</td><td class="num ${c.oldest > 60 ? "neg" : ""}">${c.oldest > 0 ? c.oldest : "–"}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
    <section class="panel fin-panel"><div class="table-wrap"><table class="fin-table"><thead><tr><th>Invoice</th><th>Client</th><th>Issued</th><th>Due</th><th class="num">Total</th><th>Status</th><th>Income account</th></tr></thead><tbody>
      ${list.length ? list.map((i) => `<tr><td><a href="../agreements/#/invoice/${i.id}">${esc(i.number)}</a></td><td>${esc(i.client_name)}</td><td>${short(i.issue_date)}</td><td>${i.due_date ? short(i.due_date) : ""}</td><td class="num">${usd(invTotal(i), 2)}</td>
        <td>${i.status === "Sent" ? `<span class="pill ${late(i) > 0 ? "s-lost" : "s-submitted"}">${late(i) > 0 ? late(i) + " days late" : "Sent"}</span>` : pill(i.status)}</td>
        <td><select data-inv="${i.id}" aria-label="Income account for ${esc(i.number)}"><option value="">Default (${esc(revAccts.find((a) => a.sys === "rev_services")?.name || "Consulting services")})</option>${revAccts.map((a) => `<option value="${a.id}" ${a.id === i.fin_account_id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></td></tr>`).join("")
        : `<tr><td colspan="7" class="empty">${all ? "No invoices yet." : "Nothing outstanding. Every sent invoice is paid."}</td></tr>`}</tbody></table></div></section>`;
  $$("[data-inv]").forEach((s) => s.addEventListener("change", async () => {
    try { must(await sb.from("inv_invoices").update({ fin_account_id: s.value ? +s.value : null }).eq("id", +s.dataset.inv)); toast("Saved"); } catch (e) { toast(e.message); }
  }));
}

/* ================================================================ Budget */
async function Budget(param) {
  await ensureSetup();
  const y = yearParam(param, fyOf(today())), { from, to, months } = fyRange(y), mode = F.budMode || "amount";
  const R = await report(from, to, cfg().basis);
  const list = R.accounts.filter((a) => a.active);
  const v = (a, m) => R.budget[a.id]?.[m] || null;
  const rowTot = (a) => months.reduce((s, m) => s + (v(a, m)?.v || 0), 0);
  const editable = (a) => mode === "amount" || a.driver !== "amount";
  $("#main").innerHTML = `
    ${head("Budget", `${esc(fyLong(y))} · plan by month. Type in a cell like a spreadsheet; it saves as you go.`, yearNav("budget", y))}
    <div class="filters no-print"><div class="tabs" role="tablist"><button role="tab" data-mode="amount" aria-selected="${mode === "amount"}">Amounts</button><button role="tab" data-mode="units" aria-selected="${mode === "units"}">Units and hours</button></div>
      <span class="spacer"></span>
      <button class="btn small" id="bCopy">Start from another year</button><button class="btn small" id="bPayroll">Payroll planner</button><button class="btn small" id="bLoan">Loan planner</button><button class="btn small" id="bImport">Import a financial model</button><button class="btn small" id="bCsv">Download CSV</button></div>
    ${mode === "units" ? `<div class="notice-bar">${icon("alert")}<div>Enter units (credits, subscriptions) or hours for accounts planned that way. Pulse multiplies by the price or rate and, where a direct cost per unit is set, fills the matching cost of revenue line. Set prices and drivers in <a href="#/settings">Settings → Accounts</a>.</div></div>` : ""}
    <div class="kpis" id="budKpis"></div>
    <section class="panel fin-panel"><div class="table-wrap"><table class="fin-table sheet" id="budGrid"><thead><tr><th>Account</th>${mode === "units" ? `<th class="num">Price</th>` : ""}${months.map((m) => `<th class="num">${ymLabel(m)}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>
      ${SECTIONS.map((sec) => { const as = list.filter((a) => a.section === sec && (mode === "amount" || a.driver !== "amount")); if (!as.length) return "";
        return `<tr class="head"><td colspan="${months.length + (mode === "units" ? 3 : 2)}">${sec}</td></tr>` + as.map((a) => `<tr data-a="${a.id}"><td class="tc-proj">${esc(a.name)}${a.grp ? `<small>${esc(a.grp)}</small>` : ""}</td>
          ${mode === "units" ? `<td class="num muted">${a.unit_price ? usd(a.unit_price, 2) + (a.driver === "hours" ? "/h" : "") : "–"}</td>` : ""}
          ${months.map((m) => { const b = v(a, m), val = mode === "units" ? b?.q : b?.v; return `<td class="num"><input class="tc-in" type="text" inputmode="decimal" data-a="${a.id}" data-m="${m}" value="${val ? +val : ""}" ${editable(a) ? "" : "disabled"} aria-label="${esc(a.name)} ${ymLabel(m)}"></td>`; }).join("")}
          <td class="num"><b>${cell$(rowTot(a))}</b></td></tr>`).join(""); }).join("")}
    </tbody></table></div></section>
    <p class="muted small no-print">Arrow keys, Tab and Enter move between cells; you can paste a block copied from Excel. Accounts are in <a href="#/settings">Settings</a>.</p>`;
  budKpis(R, months);
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => { F.budMode = b.dataset.mode; Budget(String(y)); }));
  $$("#budGrid .tc-in").forEach((inp) => inp.addEventListener("change", () => saveBud(inp, R, y)));
  wireSheet($("#budGrid"), (inp) => saveBud(inp, R, y));
  $("#bCsv").addEventListener("click", () => csvFrom(`budget-${fyLabel(y).replace(/\s+/g, "-")}.csv`, $("#budGrid")));
  $("#bCopy").addEventListener("click", () => copyBudget(y));
  $("#bPayroll").addEventListener("click", () => payrollPlanner(y));
  $("#bLoan").addEventListener("click", () => loanPlanner(y));
  $("#bImport").addEventListener("click", () => importModel());
}
function budKpis(R, months) {
  const B = pnlRows(R, months, "budget"), t = (o) => Object.values(o).reduce((s, x) => s + x, 0), el = $("#budKpis"); if (!el) return;
  el.innerHTML = kpi("Budgeted revenue", usd(t(B.rev))) + kpi("Budgeted expenses", usd(t(B.cor) + t(B.opex)), "cost of revenue and operating") + kpi("Budgeted net income", usd(t(B.ni)), "", t(B.ni) < 0 ? "neg" : "");
}
async function saveBud(inp, R, y) {
  const a = acct(+inp.dataset.a), m = inp.dataset.m, units = (F.budMode || "amount") === "units";
  const raw = parseNum(inp.value);
  if (Number.isNaN(raw)) { toast("Enter a number"); inp.value = ""; return; }
  try {
    if (units) {
      const amt = r2(raw * (+a.unit_price || 0));
      await putBudget([{ account_id: a.id, month: m + "-01", qty: raw || null, amount: amt }]);
      if (a.section === "Revenue" && +a.unit_cost) {
        const cor = await companionCost(a);
        await putBudget([{ account_id: cor.id, month: m + "-01", qty: raw || null, amount: r2(raw * +a.unit_cost) }]);
        ((R.budget[cor.id] ||= {})[m] = { q: raw || null, v: r2(raw * +a.unit_cost) });
      }
    } else await putBudget([{ account_id: a.id, month: m + "-01", qty: R.budget[a.id]?.[m]?.q ?? null, amount: raw }]);
    inp.classList.add("saved"); setTimeout(() => inp.classList.remove("saved"), 700);
    // keep the page as it is (you may be typing in the next cell); just refresh this row's total and the totals at the top
    const b = ((R.budget[a.id] ||= {})[m] ||= { q: null, v: 0 });
    if (units) { b.q = raw || null; b.v = r2(raw * (+a.unit_price || 0)); } else b.v = raw;
    const tr = inp.closest("tr"); if (tr) tr.lastElementChild.innerHTML = `<b>${cell$(Object.values(R.budget[a.id]).reduce((s, x) => s + (x.v || 0), 0))}</b>`;
    budKpis(R, fyMonths(y));
  } catch (e) { toast(e.message); }
}
async function putBudget(rows) {
  const ws = S.profile.workspace_id;
  const del = rows.filter((r) => !r.amount && !r.qty), up = rows.filter((r) => r.amount || r.qty);
  for (let i = 0; i < up.length; i += 500) must(await sb.from("fin_budget").upsert(up.slice(i, i + 500).map((r) => ({ workspace_id: ws, ...r })), { onConflict: "account_id,month" }));
  for (const r of del) must(await sb.from("fin_budget").delete().eq("account_id", r.account_id).eq("month", r.month));
}
async function companionCost(a) {
  let c = F.accounts.find((x) => x.section === "Cost of revenue" && x.name === a.name);
  if (!c) { c = must(await sb.from("fin_accounts").insert({ workspace_id: S.profile.workspace_id, section: "Cost of revenue", name: a.name, direction: "out", tax_line: "2", sort: 100 + (a.sort || 0) }).select("*").single()); F.accounts.push(c); }
  return c;
}
const parseNum = (t) => { t = String(t || "").replace(/[$,\s]/g, ""); if (!t) return 0; if (/^\(.*\)$/.test(t)) t = "-" + t.slice(1, -1); return /^-?\d*\.?\d+$/.test(t) ? +t : NaN; };
// spreadsheet keys: arrows, Enter, Tab, Esc, and pasting a block from Excel
function wireSheet(grid, save) {
  if (!grid) return;
  const cells = () => [...grid.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll(".tc-in")]).filter((r) => r.length);
  const pos = (inp) => { const g = cells(); for (let r = 0; r < g.length; r++) { const c = g[r].indexOf(inp); if (c >= 0) return [r, c, g]; } return [-1, -1, g]; };
  const go = (inp, dr, dc) => { let [r, c, g] = pos(inp); while (true) { r += dr; c += dc; if (r < 0 || r >= g.length || c < 0 || c >= (g[r]?.length || 0)) return; if (!g[r][c].disabled) { g[r][c].focus(); return; } } };
  grid.addEventListener("focusin", (e) => { if (e.target.classList?.contains("tc-in")) { e.target.dataset.was = e.target.value; e.target.select(); } });
  grid.addEventListener("keydown", (e) => {
    const inp = e.target; if (!inp.classList?.contains("tc-in")) return;
    const all = inp.selectionStart === 0 && inp.selectionEnd === inp.value.length;
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); go(inp, e.shiftKey ? -1 : 1, 0); }
    else if (e.key === "ArrowDown") { e.preventDefault(); go(inp, 1, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(inp, -1, 0); }
    else if (e.key === "ArrowRight" && (all || inp.selectionStart === inp.value.length)) { e.preventDefault(); go(inp, 0, 1); }
    else if (e.key === "ArrowLeft" && (all || inp.selectionEnd === 0)) { e.preventDefault(); go(inp, 0, -1); }
    else if (e.key === "Escape") { inp.value = inp.dataset.was ?? inp.value; inp.select(); }
  });
  grid.addEventListener("paste", async (e) => {
    const inp = e.target; if (!inp.classList?.contains("tc-in")) return;
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    const block = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    if (block.length === 1 && block[0].length === 1) return;
    e.preventDefault();
    const [r0, c0, g] = pos(inp), todo = [];
    block.forEach((line, i) => line.forEach((v, j) => { const t = g[r0 + i]?.[c0 + j]; if (t && !t.disabled) { t.value = v.trim(); todo.push(t); } }));
    for (const t of todo) await save(t);
  });
}
// copy another year's budget or actuals into this year, with a growth percentage
function copyBudget(y) {
  $("#drawerTitle").textContent = `Start ${fyLabel(y)} from another year`;
  $("#drawerBody").innerHTML = `<form id="cpForm" class="form-grid">
    <label>From<select name="year">${[y - 1, y - 2, y + 1].map((k) => `<option value="${k}">${fyLabel(k)}</option>`).join("")}</select></label>
    <label>Use<select name="what"><option value="actual">Actuals</option><option value="budget">Budget</option></select></label>
    <label>Change by (%)<input name="growth" type="number" step="0.1" value="0"></label>
    <label style="grid-column:1/-1" class="check"><input type="checkbox" name="replace" checked> Replace what's already budgeted for those accounts</label>
    <p class="muted" style="grid-column:1/-1">Each month copies to the same month this year. Owner and financing lines are copied too; check them afterwards.</p>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Copy</button></div></form>`;
  openDrawer();
  $("#cpForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target), src = +f.get("year"), g = 1 + (+f.get("growth") || 0) / 100;
    try {
      const S0 = fyRange(src), R = await report(S0.from, S0.to, cfg().basis), T = fyMonths(y), rows = [];
      const cur = await report(fyRange(y).from, fyRange(y).to, cfg().basis);
      for (const a of R.accounts) S0.months.forEach((m, i) => {
        const val = f.get("what") === "budget" ? R.budget[a.id]?.[m]?.v || 0 : R.actual[a.id]?.[m] || 0;
        const q = f.get("what") === "budget" ? R.budget[a.id]?.[m]?.q : null;
        if (!val && !q) return;
        if (!f.get("replace") && cur.budget[a.id]?.[T[i]]) return;
        rows.push({ account_id: a.id, month: T[i] + "-01", qty: q ? r2(q * g) : null, amount: r2(val * g) });
      });
      if (!rows.length) { toast("Nothing to copy from that year"); return; }
      await putBudget(rows); closeDrawer(); toast(`Copied ${rows.length} amounts`); Budget(String(y));
    } catch (err) { toast(err.message); }
  });
}
// the SBDC model's payroll tab: positions, start and end month, benefits, 401k, employer taxes, payroll fees, onboarding
function payrollPlanner(y) {
  const c = cfg(), p = { tax_load: 0.087, fee: 45, onboard: 100, benefits: 0, k401: 0, positions: [], ...(c.payroll || {}) };
  const posRow = (x = {}) => `<tr><td><input name="title" value="${esc(x.title || "")}" placeholder="e.g. Project manager"></td>
    <td><select name="type"><option ${x.type !== "PT" ? "selected" : ""}>FT</option><option ${x.type === "PT" ? "selected" : ""}>PT</option></select></td>
    <td><input name="annual" type="number" step="100" value="${x.annual || ""}" placeholder="annual"></td><td><input name="hourly" type="number" step="0.01" value="${x.hourly || ""}" placeholder="or hourly"></td>
    <td><input name="hours" type="number" step="1" value="${x.hours || ""}" placeholder="h/week"></td>
    <td><input name="start" type="month" value="${x.start || fyMonths(y)[0]}"></td><td><input name="end" type="month" value="${x.end || ""}"></td>
    <td><button type="button" class="tc-del" data-rm aria-label="Remove">&times;</button></td></tr>`;
  $("#drawerTitle").textContent = "Payroll planner";
  $("#drawerBody").innerHTML = `<form id="pyForm"><p class="muted">W-2 employees only (contractors are costs on projects). Fills ${esc(fyLabel(y))}'s payroll lines in the budget, replacing what's there.</p>
    <div class="table-wrap"><table class="mini pos"><thead><tr><th>Position</th><th>FT/PT</th><th>Annual pay</th><th>Hourly</th><th>Hours/week</th><th>Start</th><th>End</th><th></th></tr></thead><tbody id="posRows">${(p.positions.length ? p.positions : [{}]).map(posRow).join("")}</tbody></table></div>
    <button type="button" class="btn small" id="addPos">+ Add a position</button>
    <div class="form-grid" style="margin-top:14px">
      <label>Employer payroll taxes (% of wages)<input name="tax_load" type="number" step="0.1" value="${r2(p.tax_load * 100)}"></label>
      <label>Payroll fees per employee per month<input name="fee" type="number" step="1" value="${p.fee}"></label>
      <label>Onboarding cost per new employee<input name="onboard" type="number" step="1" value="${p.onboard}"></label>
      <label>Benefits per employee per month<input name="benefits" type="number" step="1" value="${p.benefits}"></label>
      <label>401k per employee per month<input name="k401" type="number" step="1" value="${p.k401}"></label></div>
    <div class="actions-row" style="margin-top:12px"><button class="btn primary">Fill the budget</button></div></form>`;
  openDrawer();
  const wireRm = () => $$("[data-rm]").forEach((b) => (b.onclick = () => b.closest("tr").remove()));
  wireRm(); $("#addPos").onclick = () => { $("#posRows").insertAdjacentHTML("beforeend", posRow()); wireRm(); };
  $("#pyForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const positions = $$("#posRows tr").map((tr) => { const g = (n) => tr.querySelector(`[name=${n}]`).value; return { title: g("title").trim(), type: g("type"), annual: +g("annual") || 0, hourly: +g("hourly") || 0, hours: +g("hours") || 0, start: g("start"), end: g("end") }; }).filter((x) => x.title && (x.annual || x.hourly));
    const np = { tax_load: (+f.get("tax_load") || 0) / 100, fee: +f.get("fee") || 0, onboard: +f.get("onboard") || 0, benefits: +f.get("benefits") || 0, k401: +f.get("k401") || 0, positions };
    try {
      await saveCfg({ payroll: np });
      const ms = fyMonths(y), by = (sys) => F.accounts.find((a) => a.sys === sys), out = { pay_wages: {}, pay_tax: {}, pay_fees: {}, pay_onboard: {}, pay_benefits: {}, pay_401k: {} };
      for (const m of ms) {
        const on = positions.filter((x) => x.start <= m && (!x.end || x.end >= m));
        const wages = on.reduce((s, x) => s + (x.annual ? x.annual / 12 : x.hourly * x.hours * 52 / 12), 0);
        out.pay_wages[m] = wages; out.pay_tax[m] = wages * np.tax_load; out.pay_fees[m] = on.length * np.fee; out.pay_benefits[m] = on.length * np.benefits; out.pay_401k[m] = on.length * np.k401;
        out.pay_onboard[m] = positions.filter((x) => x.start === m).length * np.onboard;
      }
      const rows = [];
      for (const [sys, vals] of Object.entries(out)) { const a = by(sys); if (a) ms.forEach((m) => rows.push({ account_id: a.id, month: m + "-01", qty: null, amount: r2(vals[m]) })); }
      await putBudget(rows); closeDrawer(); toast("Payroll budget filled"); Budget(String(y));
    } catch (err) { toast(err.message); }
  });
}
// the SBDC model's loan tab: amortization → loan proceeds, interest and principal by month
function loanPlanner(y) {
  const loans = cfg().loans || [];
  const row = (x = {}) => `<tr><td><input name="name" value="${esc(x.name || "")}" placeholder="e.g. SBA microloan"></td><td><input name="amount" type="number" step="100" value="${x.amount || ""}"></td>
    <td><input name="years" type="number" step="1" value="${x.years || 10}"></td><td><input name="rate" type="number" step="0.01" value="${x.rate ?? 10.75}"></td>
    <td><input name="start" type="month" value="${x.start || fyMonths(y)[0]}"></td><td><input name="first" type="month" value="${x.first || ymAdd(fyMonths(y)[0], 1)}"></td><td><button type="button" class="tc-del" data-rm aria-label="Remove">&times;</button></td></tr>`;
  $("#drawerTitle").textContent = "Loan planner";
  $("#drawerBody").innerHTML = `<form id="lnForm"><p class="muted">Fills loan proceeds, loan interest and principal payments in ${esc(fyLabel(y))}'s budget, replacing what's there.</p>
    <div class="table-wrap"><table class="mini pos"><thead><tr><th>Loan</th><th>Amount</th><th>Years</th><th>Rate %</th><th>Received</th><th>First payment</th><th></th></tr></thead><tbody id="lnRows">${(loans.length ? loans : [{}]).map(row).join("")}</tbody></table></div>
    <button type="button" class="btn small" id="addLn">+ Add a loan</button><div id="lnSum" class="muted" style="margin-top:10px"></div>
    <div class="actions-row" style="margin-top:12px"><button class="btn primary">Fill the budget</button></div></form>`;
  openDrawer();
  const read = () => $$("#lnRows tr").map((tr) => { const g = (n) => tr.querySelector(`[name=${n}]`).value; return { name: g("name").trim() || "Loan", amount: +g("amount") || 0, years: +g("years") || 0, rate: +g("rate") || 0, start: g("start"), first: g("first") }; }).filter((x) => x.amount && x.years);
  const sched = (L) => { const n = L.years * 12, r = L.rate / 1200, pmt = r ? L.amount * r / (1 - Math.pow(1 + r, -n)) : L.amount / n; const out = {}; let bal = L.amount, m = L.first;
    for (let k = 0; k < n && bal > 0.005; k++, m = ymAdd(m, 1)) { const i = bal * r, p = Math.min(bal, pmt - i); bal -= p; out[m] = { i, p }; } return { pmt, out }; };
  const show = () => { $("#lnSum").innerHTML = read().map((L) => { const s = sched(L), tot = Object.values(s.out).reduce((t, x) => t + x.i, 0); return `${esc(L.name)}: ${usd(s.pmt, 2)} a month, ${usd(tot)} total interest`; }).join("<br>"); };
  const wireRm = () => { $$("[data-rm]").forEach((b) => (b.onclick = () => { b.closest("tr").remove(); show(); })); $$("#lnRows input").forEach((i) => (i.oninput = show)); };
  wireRm(); show(); $("#addLn").onclick = () => { $("#lnRows").insertAdjacentHTML("beforeend", row()); wireRm(); };
  $("#lnForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const L = read();
    try {
      await saveCfg({ loans: L });
      const ms = fyMonths(y), by = (sys) => F.accounts.find((a) => a.sys === sys), acc = { fin_loan_in: {}, op_interest: {}, fin_loan_out: {} };
      for (const l of L) { const s = sched(l); if (ms.includes(l.start)) acc.fin_loan_in[l.start] = (acc.fin_loan_in[l.start] || 0) + l.amount; for (const m of ms) if (s.out[m]) { acc.op_interest[m] = (acc.op_interest[m] || 0) + s.out[m].i; acc.fin_loan_out[m] = (acc.fin_loan_out[m] || 0) + s.out[m].p; } }
      const rows = [];
      for (const [sys, vals] of Object.entries(acc)) { const a = by(sys); if (a) ms.forEach((m) => rows.push({ account_id: a.id, month: m + "-01", qty: null, amount: r2(vals[m] || 0) })); }
      await putBudget(rows); closeDrawer(); toast("Loan budget filled"); Budget(String(y));
    } catch (err) { toast(err.message); }
  });
}

/* ---------------------------------------------------------------- importing a financial model (SBDC template) */
// SBDC line → Pulse account (by section); anything not listed becomes a new account with the model's name
const MODEL_MAP = {
  "Payroll": { "salaries & wages": "pay_wages", "employee benefits": "pay_benefits", "employee 401k": "pay_401k", "payroll taxes": "pay_tax", "payroll fees": "pay_fees", "onboarding": "pay_onboard" },
  "Professional services": { "legal": "ps_legal", "accounting": "ps_acct", "other": "ps_other" },
  "Sales and marketing": { "advertising": "sm_ads", "social media & digital marketing": "sm_digital", "promotional materials": "sm_promo", "registrations": "sm_reg" },
  "Operating expenses": { "rent": "op_rent", "utilities": "op_util", "telephone & internet": "op_phone", "insurance": "op_ins", "office supplies": "op_supplies", "general equipment": "op_equip",
    "software": "op_software", "repairs & maintenance": "op_repairs", "subscription fee": "op_software", "travel & meals": "op_travel", "bank fees": "op_bank", "merchant account fees": "op_bank",
    "licenses & fees": "op_taxes", "printing & postage": "op_print", "loan interest": "op_interest", "project costs": "cor_other", "etc": "misc", "misc.": "misc", "misc": "misc" },
  "Owner and financing:in": { "owner investment": "fin_invest", "loans": "fin_loan_in" },
  "Owner and financing:out": { "owners draw/distributions": "fin_draw", "loan payments": "fin_loan_out", "cc payments": "fin_cc" },
  "Revenue": { "other income": "rev_other" },
};
const SKIP = /^(total|subtotal|%gm|gross margin|net income|offset|change in cash|beginning cash|ending cash|min cash|total cash adjustments|description)/i;
function excelDate(v) {
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return ym(v);
  const n = +v; if (!(n > 30000 && n < 80000)) return null;
  const d = new Date(Math.round((n - 25569) * 864e5)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
// read the income statement / cash flow sheet of an SBDC-style model into lines with monthly amounts
function parseModel(book) {
  const sheet = book.sheets.find((s) => s.rows.some((r) => r.some((c) => /^total revenue$/i.test(String(c).trim()))) && s.rows.some((r) => r.some((c) => /^net income$/i.test(String(c).trim()))));
  if (!sheet) throw new Error("Couldn't find an income statement in this file (looking for Total Revenue and Net Income rows).");
  const rows = sheet.rows;
  let hr = -1, cols = [];
  for (let i = 0; i < Math.min(rows.length, 15); i++) { const c = rows[i].map((v, j) => [j, excelDate(v)]).filter(([, m]) => m); if (c.length >= 6) { hr = i; cols = c; break; } }
  if (hr < 0) throw new Error("Couldn't find the row of month dates in the income statement.");
  // months must be distinct; when two columns land on the same month (e.g. Jun 30 then Jul 1), keep both but shift later ones forward
  const seen = new Set(); cols = cols.map(([j, m]) => { while (seen.has(m)) m = ymAdd(m, 1); seen.add(m); return [j, m]; });
  const first = cols[0][0];
  const textCount = Array.from({ length: first }, (_, j) => rows.filter((r) => r[j] && isNaN(+r[j])).length);
  const lc = textCount.indexOf(Math.max(...textCount)), pc = lc + 1 < first ? lc + 1 : -1;
  const lines = [], qty = {};
  let mode = "", section = "", grp = "", dir = "";
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i], label = String(r[lc] ?? "").trim(); if (!label) continue;
    const L = label.toLowerCase();
    const vals = Object.fromEntries(cols.map(([j, m]) => [m, +r[j]]).filter(([, v]) => Number.isFinite(v) && v !== 0));
    if (/^fixed-fee work$/i.test(label)) { mode = "qty"; grp = "Fixed-fee"; continue; }
    if (/^hourly work$/i.test(label)) { mode = "qty"; grp = "Hourly"; continue; }
    if (L === "revenue") { mode = "lines"; section = "Revenue"; grp = ""; continue; }
    if (mode === "qty") { if (Object.keys(vals).length) qty[grp + "|" + L] = vals; continue; }
    if (L === "fixed-fee" && section === "Revenue") { grp = "Fixed-fee"; continue; }
    if (L === "hourly" && section === "Revenue") { grp = "Hourly"; continue; }
    if (L === "cost of goods sold") { section = "Cost of revenue"; grp = ""; continue; }
    if (L === "operating expenses") { section = "Operating expenses"; continue; }
    if (L === "payroll") { section = "Payroll"; continue; }
    if (L === "professional services") { section = "Professional services"; continue; }
    if (L === "sales & marketing" || L === "sales and marketing") { section = "Sales and marketing"; continue; }
    if (L === "other sg&a") { section = "Operating expenses"; continue; }
    if (L === "non-operating changes to cash") { section = "Owner and financing"; continue; }
    if (L === "cash in") { dir = "in"; continue; }
    if (L === "cash out") { dir = "out"; continue; }
    if (/^ending cash/i.test(label)) break;
    if (SKIP.test(label) || !section) continue;
    let price = pc >= 0 ? +r[pc] : NaN;
    if (/%/.test(label) && price > 0 && price <= 1) price = NaN;   // a percentage (e.g. a 10% fee), not a unit price
    lines.push({ section, grp: section === "Revenue" ? grp : "", dir: section === "Owner and financing" ? dir : "", name: label, price: Number.isFinite(price) ? price : null, vals, qty: section === "Revenue" ? qty[grp + "|" + L] || null : null });
  }
  return { sheet: sheet.name, months: cols.map(([, m]) => m), lines };
}
function importModel() {
  $("#drawerTitle").textContent = "Import a financial model";
  $("#drawerBody").innerHTML = `<p class="muted">Upload a model built on the SBDC financial model template (for example your "IS and CF" or "Income Statement" sheet). Pulse reads each line by month, matches it to your accounts and adds any it doesn't have, such as your own revenue lines with their prices and unit costs.</p>
    <label class="btn primary" style="justify-self:start">Choose the model (.xlsx)<input type="file" id="mdFile" accept=".xlsx" hidden></label><div id="mdOut"></div>`;
  openDrawer();
  $("#mdFile").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const M = parseModel(await readSheetFile(file)), c = cfg(), startMo = +M.months[0].slice(5);
      const totals = M.lines.reduce((t, l) => { const s = Object.values(l.vals).reduce((a, b) => a + b, 0); t[l.section] = (t[l.section] || 0) + s; return t; }, {});
      $("#mdOut").innerHTML = `<div class="panel" style="margin-top:14px;padding:14px"><b>${esc(file.name)}</b> · sheet “${esc(M.sheet)}”<br>
        ${M.lines.length} lines, ${ymLabel(M.months[0], true)} to ${ymLabel(M.months[M.months.length - 1], true)}
        <table class="mini" style="margin-top:8px"><tbody>${Object.entries(totals).map(([s, v]) => `<tr><td>${esc(s)}</td><td class="num">${usd(v)}</td></tr>`).join("")}</tbody></table></div>
        <form id="mdForm" class="form-grid" style="margin-top:12px">
          <label style="grid-column:1/-1">Bring it in as<select name="as"><option value="budget">Budget (the plan)</option><option value="actual">Actual history (monthly totals, as imported transactions)</option></select></label>
          ${startMo !== c.fy_start ? `<label style="grid-column:1/-1" class="check"><input type="checkbox" name="fy" ${c.fy_start === 1 ? "checked" : ""}> Use ${MONTHS_LONG[startMo - 1]} as the start of the fiscal year (the model's first month)</label>` : ""}
          <p class="muted" style="grid-column:1/-1">Budget replaces those months' amounts for the lines in the model. Actual history adds one transaction per line and month; you can undo the whole import in Transactions.</p>
          <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Import</button></div></form>`;
      $("#mdForm").addEventListener("submit", async (ev) => {
        ev.preventDefault(); const f = new FormData(ev.target);
        try {
          if (f.get("fy")) await saveCfg({ fy_start: startMo });
          const n = await runImport(M, f.get("as"), file.name);
          closeDrawer(); toast(n);
          const next = f.get("as") === "budget" ? `#/budget/${fyOf(M.months[0] + "-01")}` : `#/pnl/${fyOf(M.months[0] + "-01")}`;
          if (location.hash === next) route(); else location.hash = next;
        } catch (err) { toast(err.message); }
      });
    } catch (err) { $("#mdOut").innerHTML = `<p class="notice-bar alert" style="margin-top:12px">${esc(err.message)}</p>`; }
  });
}
async function runImport(M0, as, fname) {
  let M = M0;
  const ws = S.profile.workspace_id;
  await report(today(), today(), "cash");   // fresh account list
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const findAcct = async (l) => {
    const key = l.section === "Owner and financing" ? `Owner and financing:${l.dir || "out"}` : l.section;
    const sys = MODEL_MAP[key]?.[norm(l.name)];
    let a = sys && F.accounts.find((x) => x.sys === sys);
    if (!a) a = F.accounts.find((x) => x.section === l.section && norm(x.name) === norm(l.name));
    if (!a) {
      const isRev = l.section === "Revenue", drv = isRev && l.price ? (l.grp === "Hourly" ? "hours" : "units") : "amount";
      const name = l.section === "Owner and financing" && norm(l.name) === "other" ? (l.dir === "in" ? "Other cash in" : "Other cash out") : norm(l.name) === "other" ? `Other ${l.section.toLowerCase()}` : l.name;
      a = F.accounts.find((x) => x.section === l.section && norm(x.name) === norm(name));
      if (!a) {
        a = must(await sb.from("fin_accounts").insert({ workspace_id: ws, section: l.section, grp: isRev ? l.grp || null : null, name, driver: drv, unit_price: isRev && l.price ? l.price : null,
          direction: l.section === "Owner and financing" ? l.dir || "out" : ["Revenue", "Other income"].includes(l.section) ? "in" : "out",
          tax_line: isRev ? "1a" : l.section === "Cost of revenue" ? "2" : l.section === "Owner and financing" ? null : "26", sort: (SECTIONS.indexOf(l.section) + 1) * 100 + 90 }).select("*").single());
        F.accounts.push(a);
      }
    }
    return a;
  };
  // revenue prices and matching unit costs
  // lines with nothing in them only matter when they match an account you have, or carry a price or unit cost
  const useful = (l) => Object.keys(l.vals).length || (["Revenue", "Cost of revenue"].includes(l.section) && +l.price);
  const lineAcct = new Map();
  for (const l of M.lines) {
    if (!useful(l)) {
      const key = l.section === "Owner and financing" ? `Owner and financing:${l.dir || "out"}` : l.section, sys = MODEL_MAP[key]?.[norm(l.name)];
      if (!(sys && F.accounts.some((x) => x.sys === sys)) && !F.accounts.some((x) => x.section === l.section && norm(x.name) === norm(l.name))) continue;
    }
    lineAcct.set(l, await findAcct(l));
  }
  M = { ...M, lines: M.lines.filter((l) => lineAcct.has(l)) };
  for (const l of M.lines.filter((x) => x.section === "Cost of revenue" && x.price)) {
    const rev = M.lines.find((x) => x.section === "Revenue" && norm(x.name) === norm(l.name));
    if (rev) { const ra = lineAcct.get(rev); if (+ra.unit_cost !== l.price) must(await sb.from("fin_accounts").update({ unit_cost: l.price }).eq("id", ra.id)); }
  }
  for (const l of M.lines.filter((x) => x.section === "Revenue" && x.price)) {
    const ra = lineAcct.get(l); if (!ra.unit_price) must(await sb.from("fin_accounts").update({ unit_price: l.price, driver: l.grp === "Hourly" ? "hours" : ra.driver === "amount" ? "units" : ra.driver }).eq("id", ra.id));
  }
  // sum lines that land on the same account and month
  const agg = {};
  for (const l of M.lines) { const a = lineAcct.get(l); for (const [m, v] of Object.entries(l.vals)) { const k = a.id + "|" + m; agg[k] ||= { a: a.id, m, v: 0, q: null }; agg[k].v += v; if (l.qty?.[m]) agg[k].q = (agg[k].q || 0) + l.qty[m]; } }
  const rows = Object.values(agg).filter((x) => Math.abs(x.v) >= 0.005 || x.q);
  if (as === "budget") {
    await putBudget(rows.map((x) => ({ account_id: x.a, month: x.m + "-01", qty: x.q ? r2(x.q) : null, amount: r2(x.v) })));
    return `Budget imported: ${rows.length} amounts`;
  }
  const batch = `${fname} · ${new Date().toLocaleString("en-US")}`;
  const ins = rows.filter((x) => Math.abs(x.v) >= 0.005).map((x) => ({ workspace_id: ws, entry_date: x.m + "-01", account_id: x.a, amount: r2(x.v), memo: `Monthly total from ${fname} (${M.sheet})`, batch }));
  for (let i = 0; i < ins.length; i += 500) must(await sb.from("fin_entries").insert(ins.slice(i, i + 500)));
  return `Imported ${ins.length} monthly totals as transactions`;
}

/* ================================================================ Transactions */
async function Ledger() {
  await ensureSetup();
  const q = new URLSearchParams(location.hash.split("?")[1] || ""), y = yearParam(q.get("y"), fyOf(today()));
  const range = q.get("m") ? { from: q.get("m") + "-01", to: ymEnd(q.get("m")) } : fyRange(y);
  if (!F.accounts.length) await report(today(), today(), "cash");
  let qry = sb.from("fin_entries").select("*").gte("entry_date", range.from).lte("entry_date", range.to).order("entry_date", { ascending: false }).limit(2000);
  if (q.get("a")) qry = qry.eq("account_id", +q.get("a"));
  const rows = must(await qry);
  const batches = (await safe(sb.from("fin_entries").select("batch, amount, created_at").order("created_at", { ascending: false }).limit(20000))).filter((b) => b.batch);
  const bsum = {}; batches.forEach((b) => { const x = (bsum[b.batch] ||= { n: 0, v: 0 }); x.n++; x.v += +b.amount; });   // newest import first
  const projects = must(await sb.from("projects").select("id, name").order("name"));
  F.projects = projects;
  $("#main").innerHTML = `
    ${head("Transactions", `Money in and out that isn't already in an invoice, project cost or expense report: bills paid, owner investment, loans, history`, `<button class="btn" id="tImport">Import bank or card CSV</button><button class="btn primary" id="tAdd">+ Add transaction</button>`)}
    <div class="filters"><div class="tabs">${[y - 1, y].map((k) => `<a role="tab" href="#/ledger?y=${k}" aria-selected="${!q.get("m") && k === y}">${fyLabel(k)}</a>`).join("")}</div>
      <select id="fAcct"><option value="">All accounts</option>${SECTIONS.map((s) => `<optgroup label="${s}">${F.accounts.filter((a) => a.section === s).map((a) => `<option value="${a.id}" ${+q.get("a") === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>`).join("")}</select>
      ${q.get("m") ? `<span class="pill">${ymLabel(q.get("m"), true)} <a href="#/ledger">×</a></span>` : ""}
      <input type="search" id="fq" placeholder="Search payee or memo"></div>
    <section class="panel fin-panel"><div class="table-wrap"><table class="fin-table" id="tTable"><thead><tr><th>Date</th><th>Account</th><th>Payee</th><th>Memo</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map((e) => { const a = acct(e.account_id); return `<tr data-id="${e.id}" data-s="${esc((e.payee || "") + " " + (e.memo || "")).toLowerCase()}"><td>${short(e.entry_date)}</td><td>${esc(a?.name || "")}<small>${esc(a?.section || "")}</small></td><td>${esc(e.payee || "")}</td>
        <td>${esc(e.memo || "")}${e.batch ? ` <span class="pill">imported</span>` : ""}</td><td class="num ${a?.direction === "in" ? "pos" : ""}">${(() => { const v = (a?.direction === "in" ? 1 : -1) * +e.amount; return (v > 0 ? "+" : "") + usd(v, 2); })()}</td><td><button class="btn small" data-edit="${e.id}">Edit</button></td></tr>`; }).join("")
        : `<tr><td colspan="6" class="empty">No transactions here yet.</td></tr>`}</tbody></table></div></section>
    ${Object.keys(bsum).length ? `<section class="panel"><div class="panel-head"><h2>Imports</h2></div><table class="mini"><tbody>${Object.entries(bsum).map(([b, x]) => `<tr><td>${esc(b)}</td><td class="num">${x.n} rows</td><td class="num">${usd(x.v)}</td><td><button class="btn small" data-undo="${esc(b)}">Undo import</button></td></tr>`).join("")}</tbody></table></section>` : ""}`;
  $("#tAdd").addEventListener("click", () => editEntry(null));
  $("#tImport").addEventListener("click", importBank);
  $("#fAcct").addEventListener("change", (e) => (location.hash = `#/ledger?y=${y}${e.target.value ? "&a=" + e.target.value : ""}`));
  $("#fq").addEventListener("input", (e) => { const t = e.target.value.toLowerCase(); $$("#tTable tbody tr[data-s]").forEach((tr) => (tr.hidden = t && !tr.dataset.s.includes(t))); });
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => editEntry(rows.find((r) => r.id === +b.dataset.edit))));
  $$("[data-undo]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Undo "${b.dataset.undo}"? This deletes the ${bsum[b.dataset.undo].n} transactions it added.`)) return;
    try { must(await sb.from("fin_entries").delete().eq("batch", b.dataset.undo)); toast("Import undone"); Ledger(); } catch (e) { toast(e.message); }
  }));
}
const acctOptions = (sel) => SECTIONS.map((s) => `<optgroup label="${s}">${F.accounts.filter((a) => a.section === s && (a.active || a.id === sel)).map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>`).join("");
function editEntry(e) {
  $("#drawerTitle").textContent = e ? "Edit transaction" : "Add transaction";
  $("#drawerBody").innerHTML = `<form id="eForm" class="form-grid">
    <label>Date<input name="entry_date" type="date" required value="${e?.entry_date || today()}"></label>
    <label>Amount (USD)<input name="amount" type="number" step="0.01" required value="${e ? +e.amount : ""}"></label>
    <label style="grid-column:1/-1">Account<select name="account_id" required>${acctOptions(e?.account_id || F.accounts.find((a) => a.sys === "misc")?.id)}</select></label>
    <label>Payee or source<input name="payee" value="${esc(e?.payee || "")}" placeholder="e.g. Delaware Division of Corporations"></label>
    <label>Reference<input name="ref" value="${esc(e?.ref || "")}" placeholder="check, receipt or confirmation no."></label>
    <label style="grid-column:1/-1">Memo<input name="memo" value="${esc(e?.memo || "")}"></label>
    <label style="grid-column:1/-1">Project <small class="muted">(optional)</small><select name="project_id"><option value="">None</option>${(F.projects || []).map((p) => `<option value="${p.id}" ${p.id === e?.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
    <p class="muted" style="grid-column:1/-1">Enter the amount as a positive number; the account decides whether it's money in or out. Use a negative amount for a refund. Don't record invoices, project costs or expense reports here; they're counted already.</p>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button>${e ? `<button type="button" class="btn danger" id="eDel">Delete</button>` : ""}</div></form>`;
  openDrawer();
  $("#eForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
    const row = { entry_date: f.entry_date, amount: +f.amount, account_id: +f.account_id, payee: f.payee.trim() || null, ref: f.ref.trim() || null, memo: f.memo.trim() || null, project_id: f.project_id ? +f.project_id : null };
    try { if (e) must(await sb.from("fin_entries").update(row).eq("id", e.id)); else must(await sb.from("fin_entries").insert({ workspace_id: S.profile.workspace_id, ...row })); closeDrawer(); toast("Saved"); Ledger(); } catch (err) { toast(err.message); }
  });
  $("#eDel")?.addEventListener("click", async () => { if (!confirm("Delete this transaction?")) return; try { must(await sb.from("fin_entries").delete().eq("id", e.id)); closeDrawer(); toast("Deleted"); Ledger(); } catch (err) { toast(err.message); } });
}
// bank or card export: date, description, amount (or debit/credit columns) → one transaction per row, account chosen per row
const GUESS = [[/anthropic|github|google|microsoft|adobe|aws|amazon web|openai|zoom|slack|notion|xero|quickbooks|software|saas|vercel|supabase|contabo/i, "op_software"],
  [/delaware|franchise|scc|secretary of state|license|tax/i, "op_taxes"], [/uber|lyft|airline|delta|united|american air|southwest|hotel|marriott|hilton|airbnb|amtrak|bolt/i, "op_travel"],
  [/restaurant|cafe|coffee|starbucks|grubhub|doordash/i, "op_meals"], [/verizon|at&t|comcast|t-mobile|internet/i, "op_phone"], [/law|legal|attorney|dentons/i, "ps_legal"],
  [/cpa|account|bookkeep/i, "ps_acct"], [/insurance/i, "op_ins"], [/fee|interest charge/i, "op_bank"], [/usps|fedex|ups|postage/i, "op_print"], [/staples|office depot|lenovo|dell|best buy/i, "op_supplies"]];
function parseDate(v) {
  const raw = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (/^\d{5}(\.\d+)?$/.test(raw)) return new Date(Math.round((+raw - 25569) * 864e5)).toISOString().slice(0, 10);
  const m = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) { const yy = m[3].length === 2 ? "20" + m[3] : m[3]; return `${yy}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
  const t = new Date(raw); return isNaN(t) ? null : t.toLocaleDateString("en-CA");
}
function importBank() {
  $("#drawerTitle").textContent = "Import bank or card transactions";
  $("#drawerBody").innerHTML = `<p class="muted">Download a CSV from your bank or card and choose it here. Leave out deposits that are invoice payments and anything already in an expense report, so nothing counts twice.</p>
    <label class="btn primary" style="justify-self:start">Choose a file (.csv or .xlsx)<input type="file" id="bkFile" accept=".csv,.xlsx" hidden></label><div id="bkOut"></div>`;
  openDrawer();
  $("#bkFile").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const rows = (await readSheetFile(file)).sheets[0].rows, hi = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /amount|debit|credit/i.test(c)));
      if (hi < 0) throw new Error("Couldn't find Date and Amount columns.");
      const H = rows[hi].map((h) => String(h).toLowerCase()), col = (re) => H.findIndex((h) => re.test(h));
      const cD = col(/date/), cDesc = col(/desc|payee|merchant|name|memo|details/), cAmt = col(/^amount|amount$/), cDeb = col(/debit|withdraw/), cCred = col(/credit|deposit/);
      const items = rows.slice(hi + 1).map((r) => {
        let amt = cAmt >= 0 ? parseNum(r[cAmt]) : (parseNum(r[cCred]) || 0) - (parseNum(r[cDeb]) || 0);
        const dd = parseDate(r[cD]);
        const desc = String(r[cDesc] ?? "").trim();
        const g = GUESS.find(([re]) => re.test(desc)), sys = amt > 0 ? "rev_other" : g ? g[1] : "misc";
        return { date: dd, desc, amt, acct: F.accounts.find((a) => a.sys === sys)?.id };
      }).filter((x) => x.date && Number.isFinite(x.amt) && x.amt);
      if (!items.length) throw new Error("No rows with a date and an amount.");
      $("#bkOut").innerHTML = `<form id="bkForm"><div class="table-wrap" style="max-height:55vh;margin-top:12px"><table class="mini"><thead><tr><th></th><th>Date</th><th>Description</th><th class="num">Amount</th><th>Account</th></tr></thead><tbody>
        ${items.map((x, i) => `<tr><td><input type="checkbox" data-i="${i}" ${x.amt < 0 ? "checked" : ""}></td><td>${short(x.date)}</td><td>${esc(x.desc)}</td><td class="num ${x.amt > 0 ? "pos" : ""}">${usd(x.amt, 2)}</td><td><select data-ac="${i}">${acctOptions(x.acct)}</select></td></tr>`).join("")}</tbody></table></div>
        <p class="muted">Money out is ticked; deposits aren't (they're usually invoice payments). Tick the rows to bring in.</p><div class="actions-row"><button class="btn primary">Import ticked rows</button></div></form>`;
      $("#bkForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const batch = `${file.name} · ${new Date().toLocaleString("en-US")}`;
        const ins = items.map((x, i) => ({ x, i })).filter(({ i }) => $(`[data-i="${i}"]`).checked).map(({ x, i }) => {
          const a = acct(+$(`[data-ac="${i}"]`).value);
          return { workspace_id: S.profile.workspace_id, entry_date: x.date, account_id: a.id, amount: r2(a.direction === "in" ? x.amt : -x.amt), payee: x.desc.slice(0, 200) || null, batch };
        });
        try { for (let i = 0; i < ins.length; i += 500) must(await sb.from("fin_entries").insert(ins.slice(i, i + 500))); closeDrawer(); toast(`Imported ${ins.length} transactions`); Ledger(); } catch (err) { toast(err.message); }
      });
    } catch (err) { $("#bkOut").innerHTML = `<p class="notice-bar alert" style="margin-top:12px">${esc(err.message)}</p>`; }
  });
}

/* ================================================================ Taxes */
async function Taxes(param) {
  await ensureSetup();
  const c = cfg(), y = /^\d{4}$/.test(param || "") ? +param : new Date().getFullYear() - (new Date().getMonth() < 4 ? 1 : 0);
  const from = `${y}-01-01`, to = `${y}-12-31`, months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
  const R = await report(from, to, c.basis);
  const tot = (a) => months.reduce((s, m) => s + (R.actual[a.id]?.[m] || 0), 0);
  const L = {}; const byLine = {};
  for (const a of R.accounts) { const t = tot(a); if (!t || !a.tax_line) continue; const ded = a.sys === "op_meals" ? t * 0.5 : t; L[a.tax_line] = (L[a.tax_line] || 0) + ded; (byLine[a.tax_line] ||= []).push({ a, t, ded }); }
  const notDed = R.accounts.filter((a) => !a.tax_line && inPnl(a) && tot(a));
  const income = (L["1a"] || 0) - (L["2"] || 0) + (L["5"] || 0) + (L["10"] || 0);
  const dedLines = ["12", "13", "14", "16", "17", "18", "22", "23", "24", "26"], deductions = dedLines.reduce((s, k) => s + (L[k] || 0), 0);
  const taxable = income - deductions, est = Math.max(0, taxable) * 0.21;
  let t99 = null; try { t99 = must(await sb.rpc("tax_1099", { p_year: y })); } catch { t99 = null; }
  const due99 = (t99?.rows || []).filter((r) => r.needs_1099);
  const due1099 = (() => { let d = new Date(y + 1, 0, 31); while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1); return d.toLocaleDateString("en-CA"); })();
  const ln = (k, label, v, cls = "") => `<tr class="${cls}"><td class="ln">${k}</td><td>${label}${byLine[k] ? `<small>${byLine[k].map((x) => `${esc(x.a.name)} ${usd(x.t)}${x.a.sys === "op_meals" ? " (50% counted)" : ""}`).join(" · ")}</small>` : ""}</td><td class="num">${usd(v, 2)}</td></tr>`;
  $("#main").innerHTML = `
    ${head(`Taxes · ${y}`, `Calendar year ${y} from Pulse's books (${c.basis} basis). A starting point for your CPA, not a filed return.`, `<div class="actions-row week-nav"><a class="btn small" href="#/taxes/${y - 1}">${icon("chevron-left")}</a><b class="week-label">${y}</b><a class="btn small" href="#/taxes/${y + 1}">${icon("chevron-right")}</a></div><button class="btn primary" id="pkg">Download year-end package (.xlsx)</button><button class="btn" onclick="print()">Print</button>`)}
    <div class="kpis">${kpi("Total income (line 11)", usd(income))}${kpi("Deductions (line 27)", usd(deductions))}${kpi("Taxable income (line 28)", usd(taxable), "before any loss carryover", taxable < 0 ? "neg" : "")}${kpi("Federal tax at 21%", usd(est), "estimate; your CPA decides")}</div>
    <div class="fin-tax">
      <section class="panel"><div class="panel-head"><h2>Form 1120 lines from your books</h2></div><table class="mini tax"><tbody>
        ${ln("1a", "Gross receipts or sales", L["1a"] || 0)}${ln("2", "Cost of goods sold", L["2"] || 0)}${ln("3", "Gross profit", (L["1a"] || 0) - (L["2"] || 0), "total")}
        ${ln("5", "Interest", L["5"] || 0)}${ln("10", "Other income", L["10"] || 0)}${ln("11", "Total income", income, "total")}
        ${dedLines.map((k) => ln(k, TAX_LINES[k], L[k] || 0)).join("")}${ln("27", "Total deductions", deductions, "total")}${ln("28", "Taxable income before net operating loss and special deductions", taxable, "total net")}
      </tbody></table>
      ${notDed.length ? `<p class="muted small">Not on the return: ${notDed.map((a) => `${esc(a.name)} ${usd(tot(a))}`).join(", ")}.</p>` : ""}
      <p class="muted small">Each account's Form 1120 line is set in <a href="#/settings">Settings → Accounts</a>. Ask your CPA about equipment and software you may need to depreciate or amortize, research and development costs, and anything paid outside Pulse.</p></section>
      <section class="panel"><div class="panel-head"><h2>1099-NEC for ${y}</h2><a class="btn small" href="../people/#/taxes">Tax forms</a></div>
        ${t99 ? `<p><b>${due99.length}</b> contractor${due99.length === 1 ? "" : "s"} need a 1099-NEC (paid ${usd(t99.threshold)} or more). Due to them and the IRS by <b>${short(due1099)}</b>.</p>
          <table class="mini"><tbody>${(t99.rows || []).slice(0, 12).map((r) => `<tr><td>${esc(r.name)}<small>${esc(r.tax_form || "No form")} · ${esc(r.tax_status || "")}</small></td><td class="num">${usd(r.paid)}</td><td>${r.needs_1099 ? `<span class="pill s-high">1099 due</span>` : ""}</td></tr>`).join("") || `<tr><td class="muted">No contractor payments this year.</td></tr>`}</tbody></table>`
        : `<p class="muted">The 1099 summary needs the latest database update.</p>`}
        <h3 style="margin-top:18px">Filing calendar</h3>
        <ul class="fin-cal">
          <li><b>1099-NEC</b> to contractors and the IRS: ${short(due1099)}.</li>
          <li><b>Form 1120</b> (C corporation): the 15th day of the 4th month after your tax year ends; April 15 for a calendar year. Form 7004 extends filing, not paying.</li>
          <li><b>Delaware franchise tax and annual report</b> (Delaware corporations): March 1.</li>
          <li><b>State corporate income tax return</b> (Virginia Form 500 for Virginia): check the due date with your CPA.</li>
          <li><b>State annual registration</b> (foreign corporations, e.g. Virginia SCC) and <b>local business license and property returns</b>: dates vary by state and city.</li>
        </ul>
        <p class="muted small">Add these to <a href="../agreements/#/compliance">Documents → Compliance</a> to get reminders.</p></section>
    </div>`;
  $("#pkg").addEventListener("click", () => taxPackage(y, R, months, L, byLine, income, deductions, taxable, t99).catch((e) => toast(e.message)));
}
async function taxPackage(y, R, months, L, byLine, income, deductions, taxable, t99) {
  const c = cfg(), name = S.workspace?.name || "Company";
  const P = pnlRows(R, months, "actual");
  const inv = must(await sb.from("inv_invoices").select("*").neq("status", "Void").gte("issue_date", `${y - 1}-01-01`).lte("issue_date", `${y}-12-31`));
  const ent = must(await sb.from("fin_entries").select("*").gte("entry_date", `${y}-01-01`).lte("entry_date", `${y}-12-31`).order("entry_date"));
  const reps = await safe(sb.from("expense_reports").select("id, status, paid_at").in("status", ["Approved", "Paid"]));
  const exp = (await safe(sb.from("expense_items").select("*").gte("spent_on", `${y}-01-01`).lte("spent_on", `${y}-12-31`).order("spent_on")))
    .map((x) => ({ ...x, expense_reports: reps.find((r) => r.id === x.report_id) })).filter((x) => x.expense_reports);
  const projs = await safe(sb.from("projects").select("id, name"));
  const costs = (await safe(sb.from("project_costs").select("*").is("expense_item_id", null).gte("cost_date", `${y}-01-01`).lte("cost_date", `${y}-12-31`).order("cost_date")))
    .map((x) => ({ ...x, projects: projs.find((p) => p.id === x.project_id) }));
  const sheets = [];
  sheets.push({ name: "Summary", rows: [[`${name} — year-end package for ${y}`], [`Prepared in Pulse on ${today()}. ${c.basis === "accrual" ? "Accrual" : "Cash"} basis, calendar year. Management figures for your CPA; not a filed return.`], [],
    ["Form 1120 line", "Description", "Amount", "Accounts"],
    ...["1a", "2"].map((k) => [k, TAX_LINES[k], r2(L[k] || 0), (byLine[k] || []).map((x) => `${x.a.name} ${r2(x.t)}`).join("; ")]),
    ["3", "Gross profit", r2((L["1a"] || 0) - (L["2"] || 0)), ""], ["5", "Interest", r2(L["5"] || 0), ""], ["10", "Other income", r2(L["10"] || 0), ""], ["11", "Total income", r2(income), ""],
    ...["12", "13", "14", "16", "17", "18", "22", "23", "24", "26"].map((k) => [k, TAX_LINES[k], r2(L[k] || 0), (byLine[k] || []).map((x) => `${x.a.name} ${r2(x.t)}${x.a.sys === "op_meals" ? " (50% counted)" : ""}`).join("; ")]),
    ["27", "Total deductions", r2(deductions), ""], ["28", "Taxable income before NOL and special deductions", r2(taxable), ""], [], ["Open items for the CPA: capitalized equipment and software, research and development costs, owner compensation, anything paid outside Pulse."]] });
  sheets.push({ name: "Income statement", rows: [["Account", ...months.map((m) => ymLabel(m)), "Total"], ...P.rows.filter((r) => r.vals || r.kind === "head" || r.kind === "grp").map((r) => r.vals ? [r.label, ...months.map((m) => r2(r.vals[m])), r2(months.reduce((s, m) => s + (r.vals[m] || 0), 0))] : [r.label])] });
  sheets.push({ name: "Accounts", rows: [["Section", "Account", "Form 1120 line", "Total", "From invoices", "From project costs", "From expense reports", "From transactions"],
    ...R.accounts.map((a) => { const s = (k) => r2(months.reduce((t, m) => t + (R.src[a.id]?.[m]?.[k]?.v || 0), 0)); const t = r2(months.reduce((x, m) => x + (R.actual[a.id]?.[m] || 0), 0)); return t ? [a.section, a.name, a.tax_line || "", t, s("invoice"), s("cost"), s("expense"), s("entry")] : null; }).filter(Boolean)] });
  const byClient = {}; inv.filter((i) => (c.basis === "accrual" ? String(i.issue_date).startsWith(y) : i.status === "Paid" && String(i.paid_at || "").startsWith(y))).forEach((i) => { byClient[i.client_name] = (byClient[i.client_name] || 0) + invNet(i); });
  sheets.push({ name: "Invoices", rows: [["Number", "Client", "Issued", "Due", "Status", "Paid on", "Amount before tax", "Sales tax", "Total"], ...inv.map((i) => [i.number, i.client_name, i.issue_date, i.due_date || "", i.status, i.paid_at || "", r2(invNet(i)), r2(invTotal(i) - invNet(i)), r2(invTotal(i))]), [], ["Revenue by client", "", "", "", "", "", "Amount"], ...Object.entries(byClient).map(([k, v]) => [k, "", "", "", "", "", r2(v)])] });
  sheets.push({ name: "Contractor payments", rows: [["Name", "Type", "Tax form", "Form status", "Tax classification", "US person", "Paid", "1099-NEC due"], ...((t99?.rows) || []).map((r) => [r.name, r.kind, r.tax_form || "", r.tax_status || "", r.tax_class || "", r.us_person == null ? "" : r.us_person ? "Yes" : "No", r2(r.paid), r.needs_1099 ? "Yes" : "No"])] });
  sheets.push({ name: "Project costs", rows: [["Date", "Project", "Category", "Vendor", "Description", "Amount"], ...costs.map((x) => [x.cost_date, x.projects?.name || "", x.category, x.vendor || "", x.description || "", r2(x.amount)])] });
  sheets.push({ name: "Expense reports", rows: [["Date", "Category", "Merchant", "Description", "Amount", "Status", "Reimbursed on"], ...(exp || []).map((x) => [x.spent_on, x.category, x.merchant || "", x.description || "", r2(x.amount), x.expense_reports?.status || "", x.expense_reports?.paid_at || ""])] });
  sheets.push({ name: "Transactions", rows: [["Date", "Account", "Section", "Payee", "Memo", "Reference", "Amount", "Imported from"], ...ent.map((e) => { const a = acct(e.account_id); return [e.entry_date, a?.name || "", a?.section || "", e.payee || "", e.memo || "", e.ref || "", r2(e.amount), e.batch || ""]; })] });
  const blob = makeXlsx(sheets), url = URL.createObjectURL(blob), aEl = document.createElement("a");
  aEl.href = url; aEl.download = `${name.replace(/[^\w]+/g, "-")}-year-end-${y}.xlsx`; document.body.appendChild(aEl); aEl.click(); aEl.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Year-end package downloaded");
}

/* ---------------------------------------------------------------- a small .xlsx writer (no library) */
function makeXlsx(sheets) {
  const enc = new TextEncoder(), xe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const colName = (i) => { let s = ""; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheetXml = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${(r || []).map((v, j) => {
    const ref = colName(j) + (i + 1); if (v === "" || v == null) return "";
    return typeof v === "number" && Number.isFinite(v) ? `<c r="${ref}"${i === 0 ? ' s="1"' : ""}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${i === 0 || (i === 3 && rows[3]?.[0] === "Form 1120 line") ? ' s="1"' : ""}><is><t xml:space="preserve">${xe(v)}</t></is></c>`; }).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const safe = (n, i) => (n.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${i + 1}`);
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xe(safe(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]),
  ];
  // zip, stored (no compression)
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (u) => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = crcT[(c ^ u[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts = [], central = []; let off = 0;
  for (const [n, txt] of files) {
    const name = enc.encode(n), data = enc.encode(txt), c = crc(data);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, c, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, c, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, u) => s + u.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/* ================================================================ Settings */
async function Settings() {
  await ensureSetup();
  const c = cfg();
  const R = await report(today(), today(), "cash");
  const maps = must(await sb.from("fin_map").select("*"));
  const mapOf = (src, cat) => maps.find((m) => m.source === src && m.category === cat)?.account_id;
  const sel = (src, cat, sections) => `<select data-map="${src}|${cat}">${sections.map((s) => `<optgroup label="${s}">${R.accounts.filter((a) => a.section === s && a.active).map((a) => `<option value="${a.id}" ${a.id === mapOf(src, cat) ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>`).join("")}</select>`;
  const costSecs = SECTIONS.filter((s) => !["Revenue", "Other income", "Owner and financing"].includes(s));
  $("#main").innerHTML = `
    ${head("Finance settings", "How the books are kept, your accounts, and where Pulse's records post")}
    <section class="panel"><div class="panel-head"><h2>Books</h2></div><form id="bForm" class="form-grid">
      <label>Basis<select name="basis"><option value="cash" ${c.basis !== "accrual" ? "selected" : ""}>Cash (when money moves)</option><option value="accrual" ${c.basis === "accrual" ? "selected" : ""}>Accrual (when invoiced or approved)</option></select></label>
      <label>Fiscal year starts in<select name="fy_start">${MONTHS_LONG.map((m, i) => `<option value="${i + 1}" ${c.fy_start === i + 1 ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      <label>Opening cash (USD)<input name="opening_cash" type="number" step="0.01" value="${c.opening_cash ?? 0}"></label>
      <label>As of<input name="opening_date" type="date" value="${c.opening_date || ""}"></label>
      <p class="muted" style="grid-column:1/-1">Opening cash is your bank balance (all business accounts) at the start of the day you begin tracking in Pulse; the first day of a month works best. Taxes always use the calendar year; the fiscal year is for the income statement, cash flow and budget. Use the same basis your return uses (most small companies file on the cash basis).</p>
      <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button></div></form></section>
    <section class="panel"><div class="panel-head"><h2>Where Pulse's records post</h2></div>
      <div class="fin-maps"><div><h3>Invoices</h3><label>Default income account ${sel("invoice", "*", ["Revenue", "Other income"])}</label><p class="muted small">Change a single invoice's account in <a href="#/receivables/all">Receivables</a>.</p></div>
        <div><h3>Project costs</h3>${COST_CATS.map((k) => `<label>${k} ${sel("cost", k, costSecs)}</label>`).join("")}</div>
        <div><h3>Expense reports</h3>${EXP_CATS.map((k) => `<label>${k} ${sel("expense", k, costSecs)}</label>`).join("")}</div></div></section>
    <section class="panel fin-panel"><div class="panel-head"><h2>Accounts</h2><button class="btn small primary" id="aAdd">+ Add account</button></div><div class="table-wrap"><table class="fin-table"><thead><tr><th>Account</th><th>Section</th><th>Planned by</th><th class="num">Price or rate</th><th class="num">Direct cost</th><th>Form 1120 line</th><th></th></tr></thead><tbody>
      ${SECTIONS.map((s) => R.accounts.filter((a) => a.section === s).map((a) => `<tr class="${a.active ? "" : "muted"}"><td><b>${esc(a.name)}</b>${a.grp ? `<small>${esc(a.grp)}</small>` : ""}${a.note ? `<small>${esc(a.note)}</small>` : ""}</td><td>${s}${a.section === "Owner and financing" ? ` · money ${a.direction}` : ""}</td>
        <td>${a.driver === "amount" ? "Amount" : a.driver === "units" ? "Units" : "Hours"}</td><td class="num">${a.unit_price ? usd(a.unit_price, 2) : ""}</td><td class="num">${a.unit_cost ? usd(a.unit_cost, 2) : ""}</td><td>${a.tax_line ? `${a.tax_line} · ${esc(TAX_LINES[a.tax_line] || "")}` : `<span class="muted">Not on the return</span>`}</td>
        <td><button class="btn small" data-acct="${a.id}">Edit</button></td></tr>`).join("")).join("")}</tbody></table></div></section>`;
  $("#bForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await saveCfg({ basis: f.get("basis"), fy_start: +f.get("fy_start"), opening_cash: +f.get("opening_cash") || 0, opening_date: f.get("opening_date") || null }); toast("Saved"); } catch (err) { toast(err.message); }
  });
  $$("[data-map]").forEach((s) => s.addEventListener("change", async () => {
    const [source, category] = s.dataset.map.split("|");
    try { must(await sb.from("fin_map").upsert({ workspace_id: S.profile.workspace_id, source, category, account_id: +s.value }, { onConflict: "workspace_id,source,category" })); toast("Saved"); } catch (e) { toast(e.message); }
  }));
  $("#aAdd").addEventListener("click", () => editAcct(null));
  $$("[data-acct]").forEach((b) => b.addEventListener("click", () => editAcct(acct(+b.dataset.acct))));
}
function editAcct(a) {
  $("#drawerTitle").textContent = a ? "Edit account" : "Add account";
  $("#drawerBody").innerHTML = `<form id="aForm" class="form-grid">
    <label style="grid-column:1/-1">Name<input name="name" required value="${esc(a?.name || "")}"></label>
    <label>Section<select name="section" ${a?.sys ? "disabled" : ""}>${SECTIONS.map((s) => `<option ${s === (a?.section || "Operating expenses") ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    <label>Group <small class="muted">(optional)</small><input name="grp" value="${esc(a?.grp || "")}" placeholder="e.g. Hourly, Fixed-fee"></label>
    <label>Money in or out <small class="muted">(owner and financing lines)</small><select name="direction" ${a?.sys ? "disabled" : ""}><option value="out" ${a?.direction !== "in" ? "selected" : ""}>Out</option><option value="in" ${a?.direction === "in" ? "selected" : ""}>In</option></select></label>
    <label>Planned by<select name="driver">${[["amount", "Amount"], ["units", "Units"], ["hours", "Hours"]].map(([k, l]) => `<option value="${k}" ${k === (a?.driver || "amount") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label>Price per unit or hourly rate<input name="unit_price" type="number" step="0.0001" value="${a?.unit_price ?? ""}"></label>
    <label>Direct cost per unit<input name="unit_cost" type="number" step="0.0001" value="${a?.unit_cost ?? ""}"></label>
    <label style="grid-column:1/-1">Form 1120 line<select name="tax_line"><option value="">Not on the return</option>${Object.entries(TAX_LINES).map(([k, l]) => `<option value="${k}" ${k === a?.tax_line ? "selected" : ""}>${k} · ${l}</option>`).join("")}</select></label>
    <label style="grid-column:1/-1">Note<input name="note" value="${esc(a?.note || "")}"></label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="active" ${a?.active === false ? "" : "checked"}> Active (shown in the budget and menus)</label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Save</button>${a && !a.sys ? `<button type="button" class="btn danger" id="aDel">Delete</button>` : ""}</div></form>`;
  openDrawer();
  $("#aForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const row = { name: f.get("name").trim(), grp: f.get("grp").trim() || null, direction: f.get("direction"), driver: f.get("driver"), unit_price: f.get("unit_price") === "" ? null : +f.get("unit_price"),
      unit_cost: f.get("unit_cost") === "" ? null : +f.get("unit_cost"), tax_line: f.get("tax_line") || null, note: f.get("note").trim() || null, active: !!f.get("active") };
    if (!a?.sys) row.section = f.get("section") || a?.section;
    const sec = row.section || a?.section;
    // the section decides the direction, except for owner and financing lines
    if (a?.sys) delete row.direction;
    else if (sec !== "Owner and financing") row.direction = ["Revenue", "Other income"].includes(sec) ? "in" : "out";
    try {
      if (a) must(await sb.from("fin_accounts").update(row).eq("id", a.id));
      else must(await sb.from("fin_accounts").insert({ workspace_id: S.profile.workspace_id, sort: (SECTIONS.indexOf(row.section) + 1) * 100 + 95, ...row }));
      closeDrawer(); toast("Saved"); Settings();
    } catch (err) { toast(/duplicate|unique/i.test(err.message) ? "There's already an account with that name in this section." : err.message); }
  });
  $("#aDel")?.addEventListener("click", async () => {
    if (!confirm(`Delete ${a.name}? Its budget and any transactions posted to it are deleted too. To keep the history, untick Active instead.`)) return;
    try { must(await sb.from("fin_accounts").delete().eq("id", a.id)); closeDrawer(); toast("Deleted"); Settings(); } catch (err) { toast(err.message); }
  });
}

/* ================================================================ router */
const routes = { overview: Overview, pnl: Pnl, cash: Cash, balance: Balance, projects: Projects, receivables: Receivables, budget: Budget, ledger: Ledger, taxes: Taxes, settings: Settings };
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [name, param] = location.hash.replace(/^#\/?/, "").split("?")[0].split("/");
  const key = routes[name] ? name : "overview";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve(routes[key](param)).catch((e) => ($("#main").innerHTML = /fin_|schema cache|does not exist|function/i.test(e.message)
    ? `<section class="panel"><h2>One-time setup needed</h2><p>Finance needs the latest database update. Run the latest <code>supabase/schema.sql</code> in the Supabase SQL Editor.</p><p class="muted small">${esc(e.message)}</p></section>`
    : `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try {
    if (!(await requireMember())) return;
    showShell();
    if (!isAdmin()) { $("#main").innerHTML = `<section class="panel"><h1>Finance is for admins</h1><p class="muted">Ask an admin if you need a report.</p></section>`; $("#nav").hidden = true; return; }
    route();
  } catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
