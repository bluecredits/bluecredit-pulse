/* BlueCredit Pulse — landing page: signs people in (or lets them join with the company code)
   and lists the team's business productivity apps. Shared helpers come from core.js. */
"use strict";
window.onAuthLost = () => showAuth("signin");

const APPS = [
  { key: "review", name: "Business Review", icon: "chart", href: "./review/", blurb: "Pipeline, funding, contacts, and daily to quarterly business reviews." },
  { key: "tickets", name: "Tickets", icon: "ticket", href: "./tickets/", blurb: "Ask for equipment, purchases, time off or IT help; approve requests; see your assets." },
];

// ?next=review#/contacts → back to where someone was when they had to sign in
function goNext() {
  const p = new URLSearchParams(location.search), next = p.get("next");
  const app = APPS.find((a) => a.key === next);
  if (!app) return false;
  location.replace(app.href + (/^#\//.test(location.hash) ? location.hash : ""));
  return true;
}

async function Launcher() {
  const h = new Date().getHours();
  const admin = S.profile.role === "admin";
  $("#main").innerHTML = `
    <section class="hub-hero"><h1>${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${esc(firstName())}</h1>
      <p class="muted">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · Pick up where you left off.</p></section>
    <h2 class="hub-h">Workspace apps</h2>
    <div class="hub-apps">${APPS.map((a) => `<a class="hub-app" href="${a.href}" data-app="${a.key}">
        <div class="hub-ic">${icon(a.icon)}</div><div class="hub-body"><h3>${esc(a.name)}</h3><p>${esc(a.blurb)}</p>
        <div class="hub-stats" id="stats-${a.key}"><span class="muted">Loading…</span></div></div></a>`).join("")}</div>
    ${admin ? `<p class="hub-admin"><a href="./review/#/team">Team and company code</a> · People join from this page with the company code.</p>` : ""}`;
  loadStats();
}
function icon(name, cls = "ic") { return `<svg class="${cls}"><use href="#i-${name}"/></svg>`; }
async function loadStats() {
  const stat = (n, label, href, alert) => `<span class="hub-stat ${alert && n ? "alert" : ""}" ${href ? `data-href="${href}"` : ""}><b>${Number(n).toLocaleString()}</b> ${label}</span>`;
  db.rpc("dashboard_data", { p_owner: firstName() }).then((d) => {
    const k = d.kpis;
    $("#stats-review").innerHTML = [stat(d.due_soon.length, "deadlines in 14 days", "./review/#/dashboard", false),
      stat(k.open_actions, "open actions", "./review/#/actions", k.overdue_actions), stat(k.active_opps, "active opportunities", "./review/#/opportunities")].join("");
  }).catch(() => ($("#stats-review").innerHTML = ""));
  db.rpc("desk_counts", {}).then((c) => {
    $("#stats-tickets").innerHTML = [stat(c.approvals, "waiting for your approval", "./tickets/#/approvals", true),
      stat(c.my_open, "of your requests open", "./tickets/#/requests"), c.to_work ? stat(c.to_work, "to work on", "./tickets/#/requests") : "",
      stat(c.my_assets, "assets assigned to you", "./tickets/#/assets")].join("");
  }).catch(() => ($("#stats-tickets").innerHTML = S.profile.role === "admin" ? `<span class="hub-stat alert">One-time database update needed</span>` : `<span class="muted">Not set up yet</span>`));
}
document.addEventListener("click", (e) => {
  const s = e.target.closest("[data-href]");
  if (s) { e.preventDefault(); location.href = s.dataset.href; }
});

/* ================================================================ auth */
let authMode = "signin";
function showAuth(mode, notice = "") {
  authMode = mode;
  $("#shell").hidden = true; $("#topbar").hidden = true; $("#setup").hidden = true; $("#login").hidden = false;
  $("#authTabs").hidden = !["signin", "join"].includes(mode);
  $$("#authTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  $$(".auth-form").forEach((f) => (f.hidden = f.dataset.mode !== mode));
  $("#authError").textContent = ""; $("#authNotice").textContent = notice;
  setTimeout(() => $(`.auth-form[data-mode="${mode}"] input`)?.focus(), 30);
}
$$("#authTabs button").forEach((b) => b.addEventListener("click", () => showAuth(b.dataset.mode)));
const authErr = (e) => { $("#authNotice").textContent = ""; $("#authError").textContent = e.message || String(e); };
const busy = (form, on) => $$("button", form).forEach((b) => (b.disabled = on));

$("#signinForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  try {
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    if (error) throw new Error(/confirm/i.test(error.message) ? "Confirm your email first — check your inbox for the link." : "Wrong email or password.");
    await afterSignIn();
  } catch (err) { authErr(err); } finally { busy(e.target, false); }
});

$("#joinForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  const code = f.get("code").trim(), name = f.get("name").trim();
  try {
    const { data, error } = await sb.auth.signUp({ email: f.get("email").trim(), password: f.get("password"),
      options: { data: { display_name: name, company_code: code }, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    if (!data.session) { showAuth("signin", "Check your email and click the confirmation link, then sign in here. You won't need the code again."); return; }
    await db.rpc("join_company", { p_code: code, p_name: name });
    await afterSignIn();
  } catch (err) { authErr(err); } finally { busy(e.target, false); }
});

$("#finishForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(e.target); busy(e.target, true);
  try { await db.rpc("join_company", { p_code: f.get("code").trim(), p_name: f.get("name").trim() }); await afterSignIn(); }
  catch (err) { authErr(err); } finally { busy(e.target, false); }
});

$("#forgotBtn").addEventListener("click", async () => {
  const email = $("#signinForm [name=email]").value.trim();
  if (!email) { authErr(new Error("Enter your email above, then click “Forgot password?” again.")); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) return authErr(error);
  $("#authError").textContent = ""; $("#authNotice").textContent = "If that email has an account, a reset link is on its way.";
});

$("#resetForm").addEventListener("submit", async (e) => {
  e.preventDefault(); busy(e.target, true);
  try { const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get("password") }); if (error) throw error; toast("Password updated"); await afterSignIn(); }
  catch (err) { authErr(err); } finally { busy(e.target, false); }
});


async function afterSignIn() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showAuth("signin");
  S.user = user;
  let prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  if (!prof) {  // confirmed their email after joining: finish with the code they entered
    const meta = user.user_metadata || {};
    if (meta.company_code) {
      try { await db.rpc("join_company", { p_code: meta.company_code, p_name: meta.display_name || user.email.split("@")[0] }); }
      catch (err) { showAuth("finish"); authErr(err); return; }
      prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
    }
  }
  if (!prof) { showAuth("finish"); $("#finishForm [name=name]").value = user.user_metadata?.display_name || ""; return; }
  if (!prof.active) { await sb.auth.signOut(); showAuth("signin"); authErr(new Error("This account is turned off. Ask an admin to turn it back on.")); return; }
  S.profile = prof;
  S.team = must(await sb.from("profiles").select("*").order("display_name"));
  if (goNext()) return;
  $("#login").hidden = true; $("#setup").hidden = true;
  showShell();
  Launcher();
}

async function boot() {
  // old Business Review links (bluecredit-pulse/#/contacts) moved to /review/
  if (/^#\/[a-z]/.test(location.hash) && !location.search) { location.replace("./review/" + location.hash); return; }
  if (!sb) { $("#setup").hidden = false; return; }
  sb.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") showAuth("reset"); });
  if (/type=recovery/.test(location.hash)) return;
  const { data: { session } } = await sb.auth.getSession();
  if (session) afterSignIn().catch((e) => { showAuth("signin"); authErr(e); });
  else showAuth("signin", new URLSearchParams(location.search).get("next") ? "Sign in to continue." : "");
}
boot();
