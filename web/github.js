/* Pulse — GitHub for Projects. Admin → Integrations connects GitHub (the Pulse for GitHub app in one click, or a read-only
   token); each project's GitHub tab links repositories, optionally narrowed to one milestone or label. Issues become tasks and
   milestones become schedule milestones; GitHub stays the source of truth. Loaded by admin/ and projects/. */
"use strict";
const ghIc = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const ghAgo = (t) => { if (!t) return "never"; const m = Math.round((Date.now() - Date.parse(t)) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : short(t); };
const GH_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const isGhTask = (t) => t && t.gh_number != null;
const ghRef = (t) => `${(t.gh_repo || "").split("/")[1] || ""}#${t.gh_number}`;

// wait for GitHub's answers: the database asks GitHub in the background, so poll until nothing is pending (or ~45 s)
async function ghWait(project, onTick) {
  for (let i = 0; i < 22; i++) {
    await new Promise((r) => setTimeout(r, i ? 2000 : 1200));
    const st = await db.rpc("gh_poll", { p_project: project ?? null });
    onTick?.(st);
    if (!+st.pending) return st;
  }
  return db.rpc("gh_poll", { p_project: project ?? null });
}

/* ================================================================ Admin → Integrations */
async function Integrations() {
  if (S.profile.role !== "admin") { $("#main").innerHTML = `<div class="empty">Only admins can change integrations.</div>`; return; }
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  if (qs.get("github")) { toast(qs.get("github") === "connected" ? "GitHub connected" : "GitHub: " + qs.get("github")); history.replaceState(null, "", "#/integrations"); }
  let st;
  try { st = await db.rpc("gh_status", {}); }
  catch (e) {
    $("#main").innerHTML = /gh_status|schema cache|does not exist/i.test(e.message) ? `<div class="page-head"><div><h1>Integrations</h1></div></div>
      <section class="panel"><h2>One-time setup needed</h2><p>GitHub needs the database update <code>fix_20261108l_github.sql</code>.</p></section>` : `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const [links, projs] = await Promise.all([sb.from("gh_links").select("id, project_id, repo, milestone, label, last_status, last_sync_at, issues, last_error").then((r) => r.data || []),
    sb.from("projects").select("id, name").then((r) => r.data || [])]);
  const pname = (id) => projs.find((p) => p.id === id)?.name || "Project";
  const locked = !hasApp("projects");
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Integrations</h1><p class="muted">Connect the tools your team already uses.</p></div></div>
    <section class="panel gh-card ${st.connected ? "on" : ""}">
      <div class="gh-head"><span class="gh-logo">${ghIc("code")}</span><div><h2 style="margin:0">GitHub ${st.connected ? `<span class="pill s-won">Connected</span>` : ""}</h2>
        <p class="muted" style="margin:2px 0 0">Track IT work from GitHub issues and milestones inside Projects. Developers keep working in GitHub; Pulse shows the business view.</p></div></div>
      ${locked ? `<div class="notice-bar">${ghIc("key")}<div>GitHub syncs into Projects, part of the <b>Pro</b> plan. <a href="#/billing">See plans</a></div></div>` : ""}
      ${st.last_error ? `<div class="notice-bar alert">${ghIc("alert")}<div>${esc(st.last_error)}</div></div>` : ""}
      ${st.connected ? ghConnected(st, links, pname) : ghConnect(st)}
    </section>
    ${st.connected && st.people.length ? `<section class="panel"><h2>GitHub people</h2><p class="muted">Match GitHub usernames to people in Pulse. Their issues are assigned to them in Projects, My tasks and the weekly review.</p>${ghPeopleTable(st)}</section>` : ""}`;
  wireIntegrations(st);
}
function ghConnect(st) {
  return `<div class="gh-ways">
    <div class="gh-way best"><h3>${st.app ? "One click" : "One click (coming soon)"}</h3>
      <p class="muted small">Install <b>Pulse for GitHub</b> on your GitHub account or organization and choose which repositories Pulse may read. Changes show up in Pulse within seconds.</p>
      ${st.app ? `<button class="btn primary" id="ghApp">${ghIc("code")}Connect GitHub</button>` : `<p class="muted small" style="margin:0">Not switched on for this Pulse server yet. Use a token for now; you can switch later without losing anything.</p>`}</div>
    <div class="gh-way"><h3>With a token</h3>
      <ol class="gh-steps small">
        <li><a href="${GH_TOKEN_URL}" target="_blank" rel="noopener">Create a fine-grained token on GitHub</a> (Settings → Developer settings). Name it "Pulse".</li>
        <li><b>Resource owner:</b> your organization (e.g. BlueCredit). <b>Repository access:</b> only the repositories Pulse should see.</li>
        <li><b>Permissions → Repository:</b> Issues <i>Read-only</i> (Metadata is added for you). Nothing else.</li>
        <li>Generate, copy it and paste it here. Pulse keeps it encrypted; nobody can read it back.</li></ol>
      <div class="add-action" style="grid-template-columns:1fr auto;margin:8px 0 0"><input id="ghTok" type="password" autocomplete="off" placeholder="github_pat_…" aria-label="GitHub token"><button class="btn ${st.app ? "" : "primary"}" id="ghTokSave">Connect</button></div>
      <p class="muted small" style="margin:6px 0 0">Tokens expire (GitHub suggests 90 days). Pulse tells you when it stops working; paste a new one here.</p></div></div>`;
}
function ghConnected(st, links, pname) {
  const repos = st.repos || [];
  return `<div class="gh-facts">
      <div><small class="muted">Connected</small><b>${st.method === "app" ? "Pulse for GitHub app" : "Token " + esc(st.token_hint || "")}</b><span class="muted small">${st.account ? esc(st.account) + " · " : ""}${st.connected_by ? "by " + esc(st.connected_by) + " · " : ""}${ghAgo(st.connected_at)}</span></div>
      <div><small class="muted">Updates</small><b>${st.method === "app" ? "Instantly" : "Every"} <select id="ghEvery" aria-label="Check every">${[5, 10, 15, 30, 60].map((m) => `<option value="${m}" ${+st.every_min === m ? "selected" : ""}>${m} min</option>`).join("")}</select></b>
        <span class="muted small">${st.method === "app" ? "through GitHub's notices, plus a full check on this schedule" : "Pulse checks your linked repositories on this schedule"}</span></div>
      <div><small class="muted">Repositories it can see</small><b>${repos.length}${st.repos_at ? "" : " (loading…)"}</b><span class="muted small"><a href="#" id="ghRefresh">Refresh list</a>${st.method === "token" ? ` · <a href="#" id="ghNewTok">Replace token</a>` : ""}</span></div></div>
    ${repos.length ? `<details class="gh-repos"><summary>Show repositories</summary><ul>${repos.map((r) => `<li>${ghIc(r.private ? "key" : "globe")}<span>${esc(r.full_name)}</span></li>`).join("")}</ul></details>` : ""}
    <h3 class="ck-h">Linked to projects</h3>
    ${links.length ? `<div class="table-wrap" style="border:0"><table><thead><tr><th>Project</th><th>Repository</th><th>Only</th><th>Issues</th><th>Last sync</th></tr></thead><tbody>
      ${links.map((l) => `<tr data-href="../projects/#/p/${l.project_id}/github"><td><b>${esc(pname(l.project_id))}</b></td><td>${esc(l.repo)}</td><td>${esc([l.milestone && "milestone " + l.milestone, l.label && "label " + l.label].filter(Boolean).join(", ") || "everything")}</td>
        <td>${l.issues}</td><td>${l.last_error ? `<span class="pill s-lost" title="${esc(l.last_error)}">Problem</span>` : esc(l.last_status || "")} <small class="muted">${ghAgo(l.last_sync_at)}</small></td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">No projects linked yet. Open a project in <a href="../projects/">Projects</a> → <b>GitHub</b> tab and link a repository.</p>`}
    <div class="actions-row" style="margin-top:14px"><a class="btn primary" href="../projects/">${ghIc("briefcase")}Open Projects</a><button class="btn danger" id="ghOff">Disconnect GitHub</button></div>`;
}
function ghPeopleTable(st, only) {
  const people = only ? st.people.filter((p) => only.has(p.login.toLowerCase())) : st.people;
  return `<div class="table-wrap" style="border:0"><table class="gh-people"><thead><tr><th>GitHub username</th><th>Person in Pulse</th></tr></thead><tbody>
    ${people.map((p) => `<tr><td><a href="https://github.com/${encodeURIComponent(p.login)}" target="_blank" rel="noopener">@${esc(p.login)}</a></td>
      <td><select data-ghlogin="${esc(p.login)}" aria-label="Pulse person for ${esc(p.login)}"><option value="">Not matched</option>${S.team.filter((u) => u.active).map((u) => `<option value="${u.id}" ${u.id === p.user_id ? "selected" : ""}>${esc(u.display_name)}</option>`).join("")}</select></td></tr>`).join("")}</tbody></table></div>`;
}
function wirePeople(root, after) {
  $$("[data-ghlogin]", root).forEach((sel) => sel.addEventListener("change", async () => {
    try { await db.rpc("gh_map_person", { p_login: sel.dataset.ghlogin, p_user: sel.value || null }); toast(sel.value ? "Matched" : "Unmatched"); after?.(); } catch (e) { toast(e.message); }
  }));
}
function wireIntegrations(st) {
  $("#ghApp")?.addEventListener("click", async (e) => { e.target.disabled = true; try { location.href = await db.rpc("gh_install_url", {}); } catch (err) { toast(err.message); e.target.disabled = false; } });
  const saveTok = async () => {
    const v = $("#ghTok").value.trim(); if (!v) return toast("Paste the token first");
    $("#ghTokSave").disabled = true; $("#ghTokSave").textContent = "Checking…";
    try { await db.rpc("gh_set_token", { p_token: v }); const r = await ghWait(null); toast(r.last_error ? "GitHub said no: check the token" : "GitHub connected"); Integrations(); }
    catch (err) { toast(err.message); $("#ghTokSave").disabled = false; $("#ghTokSave").textContent = "Connect"; }
  };
  $("#ghTokSave")?.addEventListener("click", saveTok);
  $("#ghTok")?.addEventListener("keydown", (e) => { if (e.key === "Enter") saveTok(); });
  $("#ghNewTok")?.addEventListener("click", (e) => { e.preventDefault(); $(".gh-card").insertAdjacentHTML("beforeend", ghConnect({ app: false })); $(".gh-ways .gh-way.best")?.remove(); wireIntegrations({}); $("#ghTok").focus(); });
  $("#ghRefresh")?.addEventListener("click", async (e) => { e.preventDefault(); try { await db.rpc("gh_refresh_repos", {}); await ghWait(null); Integrations(); } catch (err) { toast(err.message); } });
  $("#ghEvery")?.addEventListener("change", async (e) => { try { await db.rpc("gh_set_every", { p_min: +e.target.value }); toast("Saved"); } catch (err) { toast(err.message); } });
  $("#ghOff")?.addEventListener("click", async () => {
    if (!confirm("Disconnect GitHub? Linked projects keep the tasks they have but stop updating until you connect again.")) return;
    try { await db.rpc("gh_disconnect", {}); Integrations(); } catch (err) { toast(err.message); }
  });
  $$("tr[data-href]").forEach((r) => r.addEventListener("click", () => (location.href = r.dataset.href)));
  wirePeople($("#main"), () => Integrations());
}

/* ================================================================ Projects → GitHub tab */
async function GitHubTab(p) {
  const host = $("#ptab");
  let st;
  try { st = await db.rpc("gh_status", {}); }
  catch (e) { host.innerHTML = `<section class="panel"><h2>One-time setup needed</h2><p>GitHub needs the database update <code>fix_20261108l_github.sql</code>.</p></section>`; return; }
  if (!st.connected) {
    host.innerHTML = `<section class="panel gh-empty"><span class="gh-logo">${ghIc("code")}</span><h2>Track this project's work from GitHub</h2>
      <p class="muted">Link repositories and Pulse turns their issues into tasks and their milestones into this project's schedule, then keeps them in step.</p>
      ${isAdmin() ? `<a class="btn primary" href="../admin/#/integrations">${ghIc("code")}Connect GitHub</a>` : `<p>Ask an admin to connect GitHub in <b>Admin → Integrations</b>.</p>`}</section>`;
    return;
  }
  const links = must(await sb.from("gh_links").select("*").eq("project_id", p.id).order("id"));
  const [tasks, ms] = await Promise.all([sb.from("project_tasks").select("gh_assignee, assignee_id, status, gh_repo, gh_number").eq("project_id", p.id).then((r) => (r.data || []).filter((t) => t.gh_number != null)),
    sb.from("project_milestones").select("name, gh_repo, gh_number").eq("project_id", p.id).then((r) => (r.data || []).filter((m) => m.gh_number != null))]);
  const logins = new Set(tasks.map((t) => (t.gh_assignee || "").toLowerCase()).filter(Boolean));
  const unmatched = st.people.filter((x) => logins.has(x.login.toLowerCase()) && !x.user_id).length;
  const manage = canManage(p), repos = (st.repos || []).map((r) => r.full_name);
  const byStatus = (s) => tasks.filter((t) => t.status === s).length;
  host.innerHTML = `
    ${st.last_error ? `<div class="notice-bar alert">${ghIc("alert")}<div>${esc(st.last_error)} ${isAdmin() ? `<a href="../admin/#/integrations">Integrations</a>` : ""}</div></div>` : ""}
    <section class="panel"><h2>Linked repositories ${links.length ? `<button class="btn small" id="ghSync">${ghIc("clock")}Sync now</button>` : ""}</h2>
      ${links.length ? `<div class="table-wrap" style="border:0"><table><thead><tr><th>Repository</th><th>Only</th><th>Issues</th><th>Status</th>${manage ? "<th></th>" : ""}</tr></thead><tbody id="ghRows">
        ${links.map((l) => `<tr style="cursor:default"><td><a href="https://github.com/${esc(l.repo)}/issues" target="_blank" rel="noopener"><b>${esc(l.repo)}</b></a></td>
          <td>${esc([l.milestone && "milestone “" + l.milestone + "”", l.label && "label “" + l.label + "”"].filter(Boolean).join(", ") || "all issues")}</td>
          <td>${l.issues}</td><td data-ghstat="${l.id}">${ghLinkStatus(l)}</td>
          ${manage ? `<td><button class="btn small danger" data-ghunlink="${l.id}">Unlink</button></td>` : ""}</tr>`).join("")}</tbody></table></div>
        <p class="muted small" style="margin-bottom:0">${tasks.length} issues as tasks (${byStatus("To do")} to do, ${byStatus("Doing")} doing, ${byStatus("Blocked")} blocked, ${byStatus("Done")} done) · ${ms.length} milestones on the schedule.
          Updates ${st.method === "app" ? "arrive as soon as GitHub changes" : `every ${st.every_min} minutes`}.</p>`
        : `<p class="muted">Nothing linked yet. Link a repository below; you can link several, and narrow each to one milestone (for example <b>MVP</b>, <b>Alpha</b> or <b>Beta</b>) so this project tracks exactly that release.</p>`}
    </section>
    ${manage ? `<section class="panel"><h2>Link a repository</h2>
      <form id="ghLinkForm" class="form-grid">
        <label style="grid-column:1/-1">Repository<input name="repo" list="ghRepoList" required placeholder="owner/name, or paste the GitHub link" autocomplete="off">
          <datalist id="ghRepoList">${repos.map((r) => `<option value="${esc(r)}">`).join("")}</datalist></label>
        <label>Only this milestone <small class="muted">(optional)</small><input name="milestone" placeholder="e.g. MVP"></label>
        <label>Only this label <small class="muted">(optional)</small><input name="label" placeholder="e.g. it-ops"></label>
        <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">${ghIc("plus")}Link and sync</button></div></form>
      <p class="muted small">Issues → tasks: closed = Done, label <code>blocked</code> = Blocked, assigned or labelled <code>in progress</code> = Doing, otherwise To do. Labels like <code>urgent</code>, <code>high</code>/<code>P1</code> or <code>low</code> set priority. Pull requests aren't tasks.</p></section>` : ""}
    ${logins.size ? `<section class="panel"><h2>People ${unmatched ? `<small class="pill s-high">${unmatched} to match</small>` : ""}</h2><p class="muted">Match GitHub usernames to people so tasks show who's on them.</p>${ghPeopleTable(st, logins)}</section>` : ""}`;
  $("#ghSync")?.addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.innerHTML = `${ghIc("clock")}Syncing…`;
    try { await db.rpc("gh_sync_project", { p_project: p.id, p_full: e.shiftKey }); await ghWait(p.id, (r) => r.links.forEach((l) => { const c = $(`[data-ghstat="${l.id}"]`); if (c) c.innerHTML = ghLinkStatus(l); })); toast("GitHub synced"); reload(); }
    catch (err) { toast(err.message); e.target.disabled = false; }
  });
  $("#ghLinkForm")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = new FormData(e.target), b = $("button", e.target); b.disabled = true; b.textContent = "Linking…";
    try {
      await db.rpc("gh_link_add", { p_project: p.id, p_repo: f.get("repo"), p_milestone: f.get("milestone") || null, p_label: f.get("label") || null });
      b.textContent = "Reading GitHub…"; await ghWait(p.id); toast("Linked and synced"); reload();
    } catch (err) { toast(err.message); b.disabled = false; b.innerHTML = `${ghIc("plus")}Link and sync`; }
  });
  $$("[data-ghunlink]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Unlink this repository? Its issues and milestones are removed from this project (nothing changes on GitHub).")) return;
    try { await db.rpc("gh_link_remove", { p_link: +b.dataset.ghunlink }); toast("Unlinked"); reload(); } catch (err) { toast(err.message); }
  }));
  wirePeople(host, () => GitHubTab(p));
}
function ghLinkStatus(l) {
  if (l.sync_started_at) return `<span class="pill">Syncing…</span>`;
  if (l.last_error) return `<span class="pill s-lost">Problem</span> <small class="muted" style="display:block">${esc(l.last_error)}</small>`;
  return `<span class="pill s-won">${esc(l.last_status || "Waiting")}</span> <small class="muted">${ghAgo(l.last_sync_at)}</small>`;
}
