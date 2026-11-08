/* Pulse · People → My policies (everyone) and Policy sign-offs (admins).
   Kept light: the policies that need you are listed first; open one to read it, then certify any number at once with
   one tick and your name. A new version of a policy asks again; nothing else does. */
"use strict";
async function MyPolicies() {
  let list;
  try { list = await db.rpc("my_policies", {}); } catch (e) { if (/my_policies|schema cache|does not exist/i.test(e.message)) { $("#main").innerHTML = `<section class="panel"><h2>Not set up yet</h2><p class="muted">Policies need a database update (fix_20261108d_documents.sql).</p></section>`; return; } throw e; }
  const todo = list.filter((p) => p.requires_ack && !p.acked_at), done = list.filter((p) => !p.requires_ack || p.acked_at);
  const item = (p, check) => `<li class="pol-item">${check ? `<input type="checkbox" class="pol-pick" value="${p.id}" aria-label="Select ${esc(p.title)}">` : `<span class="pol-ok">${p.acked_at ? icon("check") : icon("book")}</span>`}
    <div><a href="#" data-read="${p.id}"><b>${esc(p.title)}</b></a> <small class="muted">${esc(p.category)} · v${p.version}${p.prior_ack && !p.acked_at ? " · updated since you last certified" : ""}</small>
    ${p.summary ? `<small class="muted" style="display:block">${esc(p.summary)}</small>` : ""}${p.acked_at ? `<small class="muted" style="display:block">Certified ${short(p.acked_at)}</small>` : !p.requires_ack ? `<small class="muted" style="display:block">For reference</small>` : ""}</div></li>`;
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>My policies</h1><p class="muted">${todo.length ? `${todo.length} to read and certify. Open each to read it, then certify them together.` : list.length ? "You're up to date. You'll be asked again only when a policy changes." : `${esc(S.workspace.name)} hasn't published any policies yet.`}</p></div></div>
    ${todo.length ? `<section class="panel"><h2>To read and certify</h2><ul class="pol-list">${todo.map((p) => item(p, true)).join("")}</ul>
      <div class="certify">
        <label class="check"><input type="checkbox" id="certOk"> I have read the selected policies, understand them, and will follow them.</label>
        <div class="row"><input id="certName" value="${esc(S.profile.display_name)}" aria-label="Your full name"><button class="btn primary" id="certGo">Certify selected</button></div>
        <p class="muted small">Your typed name, the time and each policy's version are recorded.</p></div></section>` : ""}
    ${done.length ? `<section class="panel"><h2>${todo.length ? "Already certified" : "Your policies"}</h2><ul class="pol-list">${done.map((p) => item(p, false)).join("")}</ul></section>` : ""}`;
  $$("[data-read]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); readPolicy(+a.dataset.read, list); }));
  $("#certGo")?.addEventListener("click", async () => {
    const ids = $$(".pol-pick:checked").map((c) => +c.value);
    if (!ids.length) return toast("Select the policies you've read");
    if (!$("#certOk").checked) return toast("Tick the box to confirm you've read them");
    try { const n = await db.rpc("policy_ack", { p_ids: ids, p_name: $("#certName").value }); toast(`Certified ${n} ${n === 1 ? "policy" : "policies"}. Thank you`); MyPolicies(); } catch (e) { toast(e.message); }
  });
}
async function readPolicy(id, list) {
  const p = must(await sb.from("doc_policies").select("title, summary, body, version, category, effective_date").eq("id", id).maybeSingle());
  const mine = list.find((x) => x.id === id);
  $("#drawerTitle").textContent = p.title;
  $("#drawerBody").innerHTML = `<p class="muted small">${esc(p.category)} · v${p.version}${p.effective_date ? " · effective " + short(p.effective_date) : ""}</p><div class="doc-body">${p.summary ? `<p class="doc-sum">${esc(p.summary)}</p>` : ""}${mdDoc(p.body)}</div>
    ${mine && mine.requires_ack && !mine.acked_at ? `<div class="actions-row" style="margin-top:14px"><button class="btn primary" id="readDone" type="button">I've read it</button></div>` : ""}`;
  openDrawer(); $("#drawerBody").scrollTop = 0;
  $("#readDone")?.addEventListener("click", () => { const c = $(`.pol-pick[value="${id}"]`); if (c) c.checked = true; closeDrawer(); toast("Selected. Certify when you've read the rest"); });
}
async function SignOffs() {
  const st = await db.rpc("policy_status", {});
  const people = [...new Map(st.flatMap((p) => p.people).map((u) => [u.user_id, u])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const total = st.reduce((n, p) => n + p.people.length, 0), got = st.reduce((n, p) => n + p.people.filter((u) => u.acked_at).length, 0);
  const missing = (u) => st.filter((p) => p.people.some((x) => x.user_id === u.user_id && !x.acked_at));
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Policy sign-offs</h1><p class="muted">${st.length ? `${got} of ${total} sign-offs done (${total ? Math.round(100 * got / total) : 100}%). Manage policies in <a href="../agreements/#/policies">Documents → Policies</a>.` : `No published policies need sign-off yet. Publish them in <a href="../agreements/#/policies">Documents → Policies</a>.`}</p></div></div>
    ${st.length ? `<section class="panel" style="padding:0"><div class="table-wrap"><table class="signoff"><thead><tr><th>Person</th>${st.map((p) => `<th title="${esc(p.title)}">${esc(p.title.length > 22 ? p.title.slice(0, 21) + "…" : p.title)} <small class="muted">v${p.version}</small></th>`).join("")}<th></th></tr></thead>
      <tbody>${people.map((u) => { const miss = missing(u), email = S.team.find((t) => t.id === u.user_id)?.email;
        return `<tr><td><b>${esc(u.name)}</b><small class="muted" style="display:block">${esc(u.role)}</small></td>${st.map((p) => { const x = p.people.find((y) => y.user_id === u.user_id);
          return `<td>${!x ? '<span class="muted">n/a</span>' : x.acked_at ? `<span class="so-ok">${icon("check")} ${short(x.acked_at)}</span>` : '<span class="so-no">Not yet</span>'}</td>`; }).join("")}
        <td>${miss.length && email ? `<a class="btn small" href="mailto:${esc(email)}?subject=${encodeURIComponent("Please read and certify company policies")}&body=${encodeURIComponent(`Hi ${u.name.split(" ")[0]},\n\nPlease read and certify these in Pulse when you have a few minutes:\n${miss.map((p) => "- " + p.title).join("\n")}\n\n${new URL("#/policies", location.href).href}\n\nThanks,\n${S.profile.display_name}`)}">Remind</a>` : ""}</td></tr>`; }).join("")}</tbody></table></div></section>` : ""}`;
}
