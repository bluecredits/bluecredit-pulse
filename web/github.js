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
        <li><b>Resource owner:</b> the account or organization the repositories belong to (one token per owner). <b>Repository access:</b> only the repositories Pulse should see.</li>
        <li><b>Permissions → Repository:</b> Issues <i>Read-only</i> (Metadata is added for you). Nothing else.</li>
        <li>Generate, copy it and paste it here. Pulse keeps it encrypted; nobody can read it back.</li></ol>
      <div class="add-action" style="grid-template-columns:1fr auto;margin:8px 0 0"><input id="ghTok" type="password" autocomplete="off" placeholder="github_pat_…" aria-label="GitHub token"><button class="btn ${st.app ? "" : "primary"}" id="ghTokSave">Connect</button></div>
      <p class="muted small" style="margin:6px 0 0">Tokens expire (GitHub suggests 90 days). Pulse tells you when it stops working; paste a new one here.</p></div></div>`;
}
function ghConnected(st, links, pname) {
  const repos = st.repos || [], app = st.method === "app";
  return `<div class="gh-conns">${st.conns.map((c) => `<div class="gh-conn ${c.last_error ? "bad" : ""}">
        <span class="gh-av">${esc((c.account || "?").slice(0, 2).toUpperCase())}</span>
        <div><b>${esc(c.account || "Checking…")}</b><span class="muted small">${c.method === "app" ? "Pulse for GitHub app" : "Token " + esc(c.token_hint || "")} · ${c.repos_at ? `${c.repos} repositor${c.repos === 1 ? "y" : "ies"}` : "reading repositories…"} · ${c.connected_by ? "by " + esc(c.connected_by) + " · " : ""}${ghAgo(c.connected_at)}</span>
          ${c.last_error ? `<span class="small" style="color:var(--red)">${esc(c.last_error)}</span>` : ""}</div>
        <div class="actions-row" style="margin:0">${c.method === "token" ? `<button class="btn small" data-ghreplace="${c.id}">Replace token</button>` : ""}<button class="btn small danger" data-ghremove="${c.id}">Remove</button></div></div>`).join("")}
      <details class="gh-add"><summary>${ghIc("plus")}Add another GitHub account or organization</summary>
        <p class="muted small">Connect each place your repositories live (for example both <b>BlueCredit</b> and <b>bluecredits</b>). Pulse reads each repository through its owner's connection.</p>${ghConnect(st)}</details></div>
    <div class="gh-facts">
      <div><small class="muted">Updates</small><b>${app ? "Instantly" : "Every"} <select id="ghEvery" aria-label="Check every">${[5, 10, 15, 30, 60].map((m) => `<option value="${m}" ${+st.every_min === m ? "selected" : ""}>${m} min</option>`).join("")}</select></b>
        <span class="muted small">${app ? "through GitHub's notices, plus a full check on this schedule" : "Pulse checks your linked repositories on this schedule"}</span></div>
      <div><small class="muted">Repositories Pulse can see</small><b>${repos.length}</b><span class="muted small"><a href="#" id="ghRefresh">Refresh list</a></span></div>
      <div><small class="muted">Linked to projects</small><b>${links.length}</b><span class="muted small">${new Set(links.map((l) => l.project_id)).size} project${new Set(links.map((l) => l.project_id)).size === 1 ? "" : "s"}</span></div></div>
    ${repos.length ? `<details class="gh-repos"><summary>Show repositories</summary><ul>${repos.map((r) => `<li>${ghIc(r.private ? "key" : "globe")}<span>${esc(r.full_name)}</span></li>`).join("")}</ul></details>` : ""}
    <h3 class="ck-h">Linked to projects</h3>
    ${links.length ? `<div class="table-wrap" style="border:0"><table><thead><tr><th>Project</th><th>Repository</th><th>Only</th><th>Issues</th><th>Last sync</th></tr></thead><tbody>
      ${links.map((l) => `<tr data-href="../projects/#/p/${l.project_id}/github"><td><b>${esc(pname(l.project_id))}</b></td><td>${esc(l.repo)}</td><td>${esc([l.milestone && "milestone " + l.milestone, l.label && "label " + l.label].filter(Boolean).join(", ") || "everything")}</td>
        <td>${l.issues}</td><td>${l.last_error ? `<span class="pill s-lost" title="${esc(l.last_error)}">Problem</span>` : esc(l.last_status || "")} <small class="muted">${ghAgo(l.last_sync_at)}</small></td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">No projects linked yet. Open a project in <a href="../projects/">Projects</a> → <b>GitHub</b> tab and link a repository.</p>`}
    <div class="actions-row" style="margin-top:14px"><a class="btn primary" href="../projects/#/new?github=1">${ghIc("plus")}New project from GitHub</a><a class="btn" href="../projects/">${ghIc("briefcase")}Open Projects</a></div>`;
}
function ghPeopleTable(st, only) {
  const people = only ? st.people.filter((p) => only.has(p.login.toLowerCase())) : st.people;
  const guess = (login) => { const l = login.toLowerCase().replace(/[^a-z]/g, ""); return S.team.find((u) => u.active && u.display_name.toLowerCase().split(/\s+/).some((w) => w.length > 2 && l.includes(w))); };
  return `<div class="table-wrap" style="border:0"><table class="gh-people"><thead><tr><th>GitHub username</th><th>Who it is</th></tr></thead><tbody>
    ${people.map((p) => { const g = !p.user_id && !p.label ? guess(p.login) : null;
      return `<tr><td><a href="https://github.com/${encodeURIComponent(p.login)}" target="_blank" rel="noopener">@${esc(p.login)}</a></td>
      <td><div class="gh-who"><select data-ghlogin="${esc(p.login)}" aria-label="Pulse person for ${esc(p.login)}"><option value="">${p.label ? "Not in Pulse" : "Not matched"}</option>${S.team.filter((u) => u.active).map((u) => `<option value="${u.id}" ${u.id === p.user_id ? "selected" : ""}>${esc(u.display_name)}</option>`).join("")}</select>
        ${p.user_id ? "" : `<input data-ghlabel="${esc(p.login)}" value="${esc(p.label || "")}" placeholder="or type who it is (e.g. Chifundo, shared dev account)">`}
        ${g ? `<button class="btn small" data-ghguess="${esc(p.login)}" data-uid="${g.id}">${esc(g.display_name)}?</button>` : ""}</div></td></tr>`; }).join("")}</tbody></table></div>`;
}
function wirePeople(root, after) {
  const save = async (login, user, label) => { try { await db.rpc("gh_map_person", { p_login: login, p_user: user || null, p_label: label || null }); toast(user ? "Matched" : label ? "Saved" : "Cleared"); after?.(); } catch (e) { toast(e.message); } };
  $$("[data-ghlogin]", root).forEach((sel) => sel.addEventListener("change", () => save(sel.dataset.ghlogin, sel.value, null)));
  $$("[data-ghlabel]", root).forEach((inp) => inp.addEventListener("change", () => save(inp.dataset.ghlabel, null, inp.value.trim())));
  $$("[data-ghguess]", root).forEach((b) => b.addEventListener("click", () => save(b.dataset.ghguess, b.dataset.uid, null)));
}
function wireIntegrations(st) {
  $$("#ghApp").forEach((b) => b.addEventListener("click", async (e) => { e.target.disabled = true; try { location.href = await db.rpc("gh_install_url", {}); } catch (err) { toast(err.message); e.target.disabled = false; } }));
  const saveTok = async (conn) => {
    const inp = $("#ghTok"), btn = $("#ghTokSave"), v = inp.value.trim(); if (!v) return toast("Paste the token first");
    btn.disabled = true; btn.textContent = "Checking…";
    try { await db.rpc("gh_set_token", { p_token: v, p_conn: conn || null }); const r = await ghWait(null); toast(r.last_error ? "GitHub said no: " + r.last_error : "GitHub connected"); Integrations(); }
    catch (err) { toast(err.message); btn.disabled = false; btn.textContent = "Connect"; }
  };
  $("#ghTokSave")?.addEventListener("click", () => saveTok($("#ghTokSave").dataset.conn));
  $("#ghTok")?.addEventListener("keydown", (e) => { if (e.key === "Enter") saveTok($("#ghTokSave").dataset.conn); });
  $$("[data-ghreplace]").forEach((b) => b.addEventListener("click", () => {
    const d = $(".gh-add"); d.open = true; $(".gh-way.best", d)?.remove();
    $("#ghTokSave").dataset.conn = b.dataset.ghreplace; $("#ghTokSave").textContent = "Replace";
    $("h3", $(".gh-way", d)).textContent = `New token for ${st.conns.find((c) => c.id === +b.dataset.ghreplace)?.account || "this account"}`; $("#ghTok").focus();
  }));
  $$("[data-ghremove]").forEach((b) => b.addEventListener("click", async () => {
    const c = st.conns.find((x) => x.id === +b.dataset.ghremove);
    if (!confirm(`Remove the ${c?.account || "GitHub"} connection? Projects keep the issues they have, but repositories under ${c?.account || "it"} stop updating until you connect it again.`)) return;
    try { await db.rpc("gh_disconnect", { p_conn: c.id }); toast("Removed"); Integrations(); } catch (err) { toast(err.message); }
  }));
  $("#ghRefresh")?.addEventListener("click", async (e) => { e.preventDefault(); try { await db.rpc("gh_refresh_repos", {}); await ghWait(null); Integrations(); } catch (err) { toast(err.message); } });
  $("#ghEvery")?.addEventListener("change", async (e) => { try { await db.rpc("gh_set_every", { p_min: +e.target.value }); toast("Saved"); } catch (err) { toast(err.message); } });
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
    ${manage ? `<section class="panel"><h2>${links.length ? "Add another repository" : "Pick the repositories for this project"}</h2>
      <div class="gh-pick">${ghRepoChoices(st, links.map((l) => l.repo.toLowerCase()))}</div>
      <details class="gh-more"><summary>Only part of a repository, or one that isn't listed</summary>
        <form id="ghLinkForm" class="form-grid" style="margin-top:10px">
          <label style="grid-column:1/-1">Repository<input name="repo" list="ghRepoList" required placeholder="owner/name, or paste the GitHub link" autocomplete="off">
            <datalist id="ghRepoList">${repos.map((r) => `<option value="${esc(r)}">`).join("")}</datalist></label>
          <label>Only this milestone<input name="milestone" placeholder="e.g. MVP"></label>
          <label>Only this label<input name="label" placeholder="e.g. it-ops"></label>
          <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">${ghIc("plus")}Link and sync</button></div></form></details>
      <p class="muted small" style="margin-bottom:0">Closed issues = Done, label <code>blocked</code> = Blocked, labelled <code>in progress</code> or assigned and active this fortnight = Doing, otherwise To do. A milestone is done when all its issues are closed.</p></section>` : ""}
    ${logins.size ? `<section class="panel"><h2>People ${unmatched ? `<small class="pill s-high">${unmatched} to match</small>` : ""}</h2><p class="muted">Match GitHub usernames to people so tasks show who's on them.</p>${ghPeopleTable(st, logins)}</section>` : ""}`;
  $("#ghSync")?.addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.innerHTML = `${ghIc("clock")}Syncing…`;
    try { await db.rpc("gh_sync_project", { p_project: p.id, p_full: e.shiftKey }); await ghWait(p.id, (r) => r.links.forEach((l) => { const c = $(`[data-ghstat="${l.id}"]`); if (c) c.innerHTML = ghLinkStatus(l); })); toast("GitHub synced"); reload(); }
    catch (err) { toast(err.message); e.target.disabled = false; }
  });
  $$("[data-ghpick]", host).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.innerHTML = `${ghIc("clock")}Reading…`;
    try { await db.rpc("gh_link_add", { p_project: p.id, p_repo: b.dataset.ghpick }); await ghWait(p.id); toast(`${b.dataset.ghpick} linked`); reload(); }
    catch (err) { toast(err.message); b.disabled = false; b.textContent = "Link"; }
  }));
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
// the connected repositories as one-click choices (already-linked ones left out), most recently active first
function ghRepoChoices(st, linked = [], mode = "button") {
  const list = (st.repos || []).filter((r) => !linked.includes(r.full_name.toLowerCase()));
  if (!list.length) return `<p class="muted small" style="margin:0">${(st.repos || []).length ? "Every repository Pulse can see is linked." : "No repositories yet. Check the connection in Admin → Integrations."}</p>`;
  return list.map((r) => mode === "check"
    ? `<label class="gh-repo"><input type="checkbox" name="ghrepo" value="${esc(r.full_name)}">${ghIc(r.private ? "key" : "globe")}<span><b>${esc(r.full_name.split("/")[1])}</b><small class="muted">${esc(r.full_name.split("/")[0])}</small></span></label>`
    : `<div class="gh-repo">${ghIc(r.private ? "key" : "globe")}<span><b>${esc(r.full_name.split("/")[1])}</b><small class="muted">${esc(r.full_name.split("/")[0])}</small></span><button class="btn small" data-ghpick="${esc(r.full_name)}">Link</button></div>`).join("");
}
function ghLinkStatus(l) {
  if (l.sync_started_at) return `<span class="pill">Syncing…</span>`;
  if (l.last_error) return `<span class="pill s-lost">Problem</span> <small class="muted" style="display:block">${esc(l.last_error)}</small>`;
  return `<span class="pill s-won">${esc(l.last_status || "Waiting")}</span> <small class="muted">${ghAgo(l.last_sync_at)}</small>`;
}
