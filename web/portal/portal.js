/* Pulse — Employee portal. Employees and contractors sign in here and see only their own things: what needs doing
   (policies to certify, contracts to sign, onboarding steps, devices to confirm, a timesheet to submit), quick ways to
   ask for time off, equipment or help, their requests, devices and place on the org chart. Admins and members can open
   it too to see their own. Helpers and the Supabase client come from ../core.js. */
"use strict";
window.onAuthLost = () => showLogin("signin");
function icon(name, cls = "ic") { return `<svg class="${cls}"><use href="#i-${name}"/></svg>`; }
const safe = (p, fb) => Promise.resolve(p).then((r) => (r && "data" in r ? (r.error ? fb : r.data ?? fb) : r ?? fb)).catch(() => fb);
const on = (key) => CFG.apps?.[key] !== false && hasApp(key);
const monday = (shiftDays = 0) => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + shiftDays); return d.toLocaleDateString("en-CA"); };

/* ================================================================ sign in */
function showLogin(mode, notice = "") {
  $("#shell").hidden = true; $("#topbar").hidden = true; $("#login").hidden = false;
  $("#pTabs").hidden = !["signin", "join"].includes(mode);
  $$("#pTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  $$("#login .auth-form").forEach((f) => (f.hidden = f.dataset.mode !== mode));
  $("#authError").textContent = ""; $("#authNotice").textContent = notice;
  setTimeout(() => $(`#login .auth-form[data-mode="${mode}"] input:not([type=hidden])`)?.focus(), 30);
}
const authErr = (e) => { $("#authNotice").textContent = ""; $("#authError").textContent = e.message || String(e); };
const busy = (form, b) => $$("button", form).forEach((x) => (x.disabled = b));
$$("#pTabs button").forEach((b) => b.addEventListener("click", () => showLogin(b.dataset.mode)));

$("#pSignin").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  try {
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    if (error) throw new Error(/confirm/i.test(error.message) ? "Confirm your email first: check your inbox for the link." : "Wrong email or password.");
    await afterSignIn();
  } catch (err) { authErr(err); } finally { busy(e.target, false); }
});
$("#pJoin").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  const code = f.get("code").trim(), name = f.get("name").trim();
  try {
    const { data, error } = await sb.auth.signUp({ email: f.get("email").trim(), password: f.get("password"),
      options: { data: { display_name: name, company_code: code }, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    if (!data.session) { showLogin("signin", "Check your email and click the confirmation link, then sign in here. You won't need the code again."); return; }
    await db.rpc("join_company", { p_code: code, p_name: name });
    await afterSignIn();
  } catch (err) { authErr(err); } finally { busy(e.target, false); }
});
$("#pFinish").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  try { await db.rpc("join_company", { p_code: f.get("code").trim(), p_name: f.get("name").trim() }); await afterSignIn(); }
  catch (err) { authErr(err); } finally { busy(e.target, false); }
});
$("#pForgot").addEventListener("click", async () => {
  const email = $("#pSignin [name=email]").value.trim();
  if (!email) return authErr(new Error("Enter your email above, then click “Forgot password?” again."));
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) return authErr(error);
  $("#authError").textContent = ""; $("#authNotice").textContent = "If that email has an account, a reset link is on its way.";
});
$("#pReset").addEventListener("submit", async (e) => {
  e.preventDefault(); busy(e.target, true);
  try { const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get("password") }); if (error) throw error; toast("Password updated"); await afterSignIn(); }
  catch (err) { authErr(err); } finally { busy(e.target, false); }
});

async function afterSignIn() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showLogin("signin");
  S.user = user;
  let prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  const meta = user.user_metadata || {};
  if (!prof && meta.company_code) {   // confirmed their email after signing up: finish joining
    try { await db.rpc("join_company", { p_code: meta.company_code, p_name: meta.display_name || user.email.split("@")[0] }); }
    catch (err) { showLogin("finish"); authErr(err); return; }
    prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  }
  if (!prof) { showLogin("finish"); $("#pFinish [name=name]").value = meta.display_name || ""; return; }
  if (!prof.active) { await sb.auth.signOut(); showLogin("signin"); authErr(new Error("This login is turned off. Ask your admin to turn it back on.")); return; }
  S.profile = prof;
  await loadWorkspace();
  S.team = must(await sb.from("profiles").select("*").order("display_name"));
  $("#login").hidden = true; showShell();
  Home();
}

/* ================================================================ home */
async function Home() {
  const me = S.user.id, wk = monday(0), lastWk = monday(-7);
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  const [pol, signers, obs, assets, entries, sheet, tickets, chart, tasks] = await Promise.all([
    on("people") || on("documents") ? safe(db.rpc("my_policies", {}), []) : [],
    safe(sb.from("agreement_signers").select("agreement_id, status, label").eq("user_id", me).in("status", ["Waiting", "Viewed"]), []),
    safe(sb.from("onboardings").select("id, role_title, kind, status, checklist, start_date").eq("user_id", me), []),
    safe(sb.from("assets").select("id, name, serial, tag, ack_at, assigned_to, onboarding_id, assigned_since").eq("status", "In use"), []),
    on("timecards") ? safe(sb.from("time_entries").select("hours, work_date").eq("user_id", me).gte("work_date", lastWk), []) : [],
    on("timecards") ? safe(sb.from("timesheets").select("status").eq("user_id", me).eq("week_start", lastWk).maybeSingle(), null) : null,
    on("tickets") ? safe(sb.from("tickets").select("id, number, type, title, status, start_date, end_date, created_at").eq("requester_id", me).order("created_at", { ascending: false }).limit(6), []) : [],
    safe(db.rpc("org_chart", {}), null),
    on("projects") ? safe(db.rpc("my_tasks", {}), []) : [],
  ]);
  const agrIds = [...new Set(signers.map((s) => s.agreement_id))];
  const agrs = agrIds.length ? await safe(sb.from("agreements").select("id, title, status").in("id", agrIds).eq("status", "Out for signature"), []) : [];
  const obIds = obs.map((o) => o.id), myDevices = assets.filter((a) => a.assigned_to === me || obIds.includes(a.onboarding_id));
  const steps = obs.filter((o) => o.status !== "Offboarded").flatMap((o) => o.checklist || []).filter((i) => i.who === "them" && !i.done && !i.off);
  const polTodo = pol.filter((p) => p.requires_ack && !p.acked_at);
  const devTodo = myDevices.filter((a) => !a.ack_at);
  const sum = (rows) => rows.reduce((x, r) => x + +r.hours, 0);
  const hrsThis = sum(entries.filter((e) => e.work_date >= wk)), hrsLast = sum(entries.filter((e) => e.work_date < wk));
  const sheetDue = on("timecards") && hrsLast > 0 && !["Submitted", "Approved"].includes(sheet?.status);

  // my place on the org chart
  const P = chart?.positions || [], pos = P.find((p) => p.holder_user === me);
  const boss = pos && P.find((p) => p.id === pos.reports_to), dept = pos && (chart.departments || []).find((d) => d.id === pos.department_id);
  const reports = pos ? P.filter((p) => p.reports_to === pos.id) : [];

  const todo = [
    ...agrs.map((a) => ({ ic: "send", text: `Sign <b>${esc(a.title)}</b>`, href: `../agreements/#/view/${a.id}`, btn: "Review and sign" })),
    polTodo.length ? { ic: "book", text: `Read and certify <b>${polTodo.length} ${polTodo.length === 1 ? "policy" : "policies"}</b>${polTodo.length <= 3 ? `: ${polTodo.map((p) => esc(p.title)).join(", ")}` : ""}`, href: "../people/#/policies", btn: "Read" } : null,
    steps.length ? { ic: "check", text: `<b>${steps.length}</b> onboarding ${steps.length === 1 ? "step" : "steps"} left: ${esc(steps[0].text)}${steps.length > 1 ? "…" : ""}`, href: "../people/#/mine", btn: "Open checklist" } : null,
    devTodo.length ? { ic: "computer", text: `Confirm you received <b>${devTodo.map((a) => esc(a.name)).join(", ")}</b>`, href: "#devices", btn: "Confirm" } : null,
    sheetDue ? { ic: "timer", text: `Submit your timesheet for the week of <b>${short(lastWk)}</b> (${hrsLast} h)`, href: `../timecards/#/week/${lastWk}`, btn: "Submit" } : null,
  ].filter(Boolean);

  const qa = [
    on("timecards") && ["timer", "Log my hours", "../timecards/"],
    on("tickets") && ["sun", "Request time off", "../tickets/#/requests?new=" + encodeURIComponent("Time off")],
    on("tickets") && ["computer", "Ask for equipment", "../tickets/#/requests?new=" + encodeURIComponent("New equipment")],
    on("tickets") && ["wrench", "Get IT help", "../tickets/#/requests?new=" + encodeURIComponent("IT support")],
    on("tickets") && ["banknotes", "Expense or purchase", "../tickets/#/requests?new=" + encodeURIComponent("Purchase or expense")],
    (on("people") || on("documents")) && ["book", "Company policies", "../people/#/policies"],
    on("people") && ["team", "Org chart", "../people/#/org"],
    on("projects") && tasks.length && ["briefcase", `My tasks (${tasks.length})`, "../projects/#/mytasks"],
    on("agreements") && ["clipboard", "My documents", "../agreements/#/list"],
  ].filter(Boolean);

  const links = (S.workspace?.config?.links || []).filter((l) => /^https:\/\//i.test(l.url || ""));
  const h = new Date().getHours();
  $("#main").innerHTML = `
    ${isStaffRole(S.profile.role) ? `<div class="notice-bar">${icon("home")}<div>This is your own portal, the same page employees and contractors see when they sign in. <a href="../">Back to all apps</a>${S.profile.role === "admin" ? ` · <a href="../admin/#/team">Team and access</a>` : ""}</div></div>` : ""}
    <section class="hub-hero portal-hero"><div>
      <h1>${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${esc(firstName())}</h1>
      <p class="muted">${pos ? `<b>${esc(pos.title)}</b>${dept ? ` · ${esc(dept.name)}` : ""}${boss ? ` · reports to ${esc(boss.title)}${boss.holder ? ` (${esc(boss.holder)})` : ""}` : ""}` : esc(roleName(S.profile.role))} · ${esc(S.workspace?.name || "")}</p></div>
      ${S.workspace?.logo_url ? `<img class="portal-logo" src="${esc(S.workspace.logo_url)}" alt="">` : ""}</section>

    <div class="portal-grid">
      <div>
        <section class="panel"><h2>${todo.length ? `To do <small>${todo.length}</small>` : "To do"}</h2>
          ${todo.length ? `<ul class="todo-list">${todo.map((t) => `<li>${icon(t.ic)}<span>${t.text}</span><a class="btn small ${t === todo[0] ? "primary" : ""}" href="${t.href}">${t.btn}</a></li>`).join("")}</ul>`
            : `<div class="portal-clear">${icon("check")}<div><b>You're all caught up.</b><span class="muted">New policies, contracts and requests that need you will show up here.</span></div></div>`}
        </section>
        ${qa.length ? `<section class="panel"><h2>Quick actions</h2><div class="qa-grid">${qa.map(([ic, l, href]) => `<a class="qa" href="${href}">${icon(ic)}<span>${esc(l)}</span></a>`).join("")}</div></section>` : ""}
        ${on("tickets") ? `<section class="panel"><h2>My requests <a class="small" href="../tickets/#/requests">See all</a></h2>
          ${tickets.length ? `<ul class="req-list">${tickets.map((t) => `<li><a href="../tickets/#/requests"><b>${esc(t.title)}</b><small class="muted">${esc(t.type)}${t.start_date ? ` · ${short(t.start_date)}${t.end_date && t.end_date !== t.start_date ? "–" + short(t.end_date) : ""}` : ""} · ${short(t.created_at)}</small></a>${pill(t.status)}</li>`).join("")}</ul>`
            : `<p class="muted" style="margin:0">No requests yet. Ask for time off, equipment or help above.</p>`}</section>` : ""}
      </div>
      <div>
        ${on("timecards") ? `<section class="panel portal-stat"><h2>This week</h2><p><b>${hrsThis.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b> hours logged</p><a class="btn small" href="../timecards/">Open timecard</a></section>` : ""}
        <section class="panel" id="devices"><h2>My devices</h2>
          ${myDevices.length ? `<ul class="checklist">${myDevices.map((a) => `<li class="ck ${a.ack_at ? "done" : ""}"><span><b>${esc(a.name)}</b>${a.serial ? ` · S/N ${esc(a.serial)}` : ""}${a.tag ? ` · ${esc(a.tag)}` : ""}</span>
              <span class="meta">${a.ack_at ? `Confirmed ${short(a.ack_at)}` : `<label class="check"><input type="checkbox" class="dev-pick" value="${a.id}" checked> I received it</label>`}</span></li>`).join("")}</ul>
            ${devTodo.length ? `<div class="row certify-row"><input id="devName" value="${esc(S.profile.display_name)}" aria-label="Your full name"><button class="btn primary" id="devAck">Confirm receipt</button></div>
              <p class="muted small">You're responsible for these until you hand them back. Type your full name to confirm.</p>` : ""}
            ${on("tickets") ? `<p class="small" style="margin:8px 0 0"><a href="../tickets/#/requests?new=${encodeURIComponent("Asset problem")}">Report a problem</a> · <a href="../tickets/#/requests?new=${encodeURIComponent("Return an asset")}">Return a device</a></p>` : ""}`
            : `<p class="muted" style="margin:0">No company devices issued to you.</p>`}
        </section>
        ${pos ? `<section class="panel"><h2>My team</h2>
          ${boss ? `<p class="portal-person"><small class="muted">Reports to</small><b>${esc(boss.holder || "Open")}</b><span class="muted">${esc(boss.title)}</span></p>` : ""}
          ${reports.length ? `<p class="portal-person"><small class="muted">Reporting to you</small>${reports.map((r) => `<span><b>${esc(r.holder || "Open")}</b> <span class="muted">· ${esc(r.title)}</span></span>`).join("")}</p>` : ""}
          ${on("people") ? `<a class="small" href="../people/#/org">See the whole org chart</a>` : ""}</section>` : ""}
        ${links.length ? `<section class="panel"><h2>Company links</h2><ul class="req-list">${links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener"><b>${esc(l.label || "Link")}</b><small class="muted">${esc(l.note || new URL(l.url).hostname)}</small></a>${icon("external")}</li>`).join("")}</ul></section>` : ""}
        <p class="muted small">Questions about your job, pay or benefits? Ask your manager${S.team.some((p) => p.role === "admin" && p.active) ? ` or ${esc(S.team.filter((p) => p.role === "admin" && p.active).map((p) => p.display_name).slice(0, 2).join(" or "))}` : ""}. Trouble with Pulse? <a href="../help/#start/portal" target="_blank" rel="noopener">Help</a></p>
      </div>
    </div>`;
  $("#devAck")?.addEventListener("click", async () => {
    const ids = $$(".dev-pick:checked").map((c) => +c.value); if (!ids.length) return toast("Tick the devices you received");
    try { for (const id of ids) await db.rpc("asset_ack", { p_id: id, p_name: $("#devName").value }); toast("Thanks, confirmed"); Home(); } catch (e) { toast(e.message); }
  });
}

/* ================================================================ start */
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  const qs = new URLSearchParams(location.search);
  if (qs.get("code")) { $("#pJoin [name=code]").value = qs.get("code"); $("#pFinish [name=code]").value = qs.get("code"); }
  sb.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") showLogin("reset"); });
  if (/type=recovery/.test(location.hash)) return;
  const { data: { session } } = await sb.auth.getSession();
  if (session) afterSignIn().catch((e) => { showLogin("signin"); authErr(e); });
  else showLogin(qs.get("code") ? "join" : "signin", qs.get("code") ? "Welcome! Create your login below." : "");
}
boot();
