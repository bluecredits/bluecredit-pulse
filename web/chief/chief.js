/* Pulse · Chief of Staff — an AI chief of staff (Claude) for each person: a prioritized daily brief, answers about
   the workspace, and suggestions accepted with one click. The server function (supabase/functions/chief) reads only
   what this person can see; nothing changes unless they click to accept a suggestion. */
"use strict";

const CH = { history: [] };
try { CH.history = JSON.parse(sessionStorage.getItem("chief:history") || "[]"); } catch { CH.history = []; }
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isStaff = () => S.profile && isStaffRole(S.profile.role);
const chiefName = () => S.workspace?.config?.chief_name || "Chief of Staff";
const saveHistory = () => { try { sessionStorage.setItem("chief:history", JSON.stringify(CH.history.slice(-20))); } catch { /* private mode */ } };
function problem(e) {
  if (!e.setup && e.status !== 503) return `<div class="empty">${esc(e.message)}</div>`;
  return `<section class="panel"><h2>${esc(chiefName())} isn't switched on yet</h2>
    <p>${S.profile.role === "admin" ? "The assistant runs on a small server function that needs a Claude API key. See <b>deploy/DEPLOY_CONTABO.md</b> in the repo (or hand it to your developer)." : "Ask an admin to finish setting up the assistant."}</p>
    <p class="muted">${esc(e.message)}</p></section>`;
}

/* ---------------- suggestions → one-click actions */
const KIND = {
  propose_action_item: { icon: "check", label: "Action item", btn: "Add to action items" },
  propose_reminder: { icon: "clock", label: "Reminder", btn: "Set reminder" },
  draft_email: { icon: "send", label: "Email draft", btn: "Open draft" },
  propose_meeting: { icon: "calendar", label: "Meeting", btn: "Find a time" },
};
function proposalCard(p, i) {
  const k = KIND[p.type]; if (!k) return "";
  const title = p.text || p.subject || p.title || "";
  const meta = p.type === "propose_action_item" ? [p.owner, p.due_date && short(p.due_date)].filter(Boolean).join(" · ")
    : p.type === "propose_reminder" ? new Date(p.remind_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : p.type === "draft_email" ? (p.to ? "To " + p.to : "")
    : p.type === "propose_meeting" ? `${(p.with || []).join(", ")} · ${p.minutes || 30} min${p.by_date ? " · by " + short(p.by_date) : ""}` : "";
  return `<article class="appr-card prop" data-prop="${i}"><header>${icon(k.icon)}<div><span class="tno">${k.label}</span><h3>${esc(title)}</h3></div></header>
    ${meta ? `<p class="muted small">${esc(meta)}</p>` : ""}${p.why ? `<p class="appr-desc">${esc(p.why)}</p>` : ""}
    <div class="actions-row"><button class="btn small primary" data-accept="${i}">${k.btn}</button><button class="btn small" data-dismiss="${i}">Dismiss</button></div></article>`;
}
async function accept(p, card) {
  try {
    if (p.type === "propose_action_item" && isStaff()) {
      must(await sb.from("actions").insert({ text: p.text, owner: p.owner || firstName(), due_date: /^\d{4}-\d{2}-\d{2}$/.test(p.due_date || "") ? p.due_date : null, status: "Open" }));
      done(card, "Added to action items");
    } else if (p.type === "propose_action_item" || p.type === "propose_reminder") {
      const at = new Date(p.remind_at || (p.due_date ? p.due_date + "T09:00" : Date.now() + 864e5));
      must(await sb.from("reminders").insert({ text: p.text, remind_at: (isNaN(at) ? new Date(Date.now() + 864e5) : at).toISOString(), from_chief: true }));
      done(card, "Reminder set"); badge();
    } else if (p.type === "draft_email") emailDraft(p);
    else if (p.type === "propose_meeting") {
      const q = new URLSearchParams({ with: (p.with || []).join(","), minutes: p.minutes || 30, title: p.title || "" });
      location.href = `../scheduler/#/find?${q}`;
    }
  } catch (e) { toast(e.message); }
}
function done(card, msg) { toast(msg); if (card) { card.classList.add("accepted"); $(".actions-row", card).innerHTML = `<span class="pill s-won">${esc(msg)}</span>`; } }
function emailDraft(p) {
  $("#drawerTitle").textContent = "Email draft";
  $("#drawerBody").innerHTML = `<p class="muted">Review it, then send it from your own email.</p>
    <label>To<input id="emTo" value="${esc(/@/.test(p.to || "") ? p.to : "")}" placeholder="${esc(p.to || "name@example.com")}"></label>
    <label>Subject<input id="emSub" value="${esc(p.subject || "")}"></label>
    <label>Message<textarea id="emBody" rows="12">${esc(p.body || "")}</textarea></label>
    <div class="actions-row" style="margin-top:10px"><button class="btn" id="emCopy">Copy</button><button class="btn primary" id="emOpen">${icon("send")}Open in email</button></div>`;
  openDrawer();
  $("#emCopy").addEventListener("click", async () => { await navigator.clipboard.writeText(`Subject: ${$("#emSub").value}\n\n${$("#emBody").value}`); toast("Copied"); });
  $("#emOpen").addEventListener("click", () => { location.href = `mailto:${encodeURIComponent($("#emTo").value)}?subject=${encodeURIComponent($("#emSub").value)}&body=${encodeURIComponent($("#emBody").value)}`; });
}
function wireProposals(list, root) {
  $$("[data-accept]", root).forEach((b) => b.addEventListener("click", () => accept(list[+b.dataset.accept], b.closest(".prop"))));
  $$("[data-dismiss]", root).forEach((b) => b.addEventListener("click", () => b.closest(".prop").remove()));
}

/* ================================================================ My brief */
async function Brief(refresh = false) {
  const h = new Date().getHours();
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${esc(firstName())}</h1>
      <p class="muted">${esc(chiefName())}'s brief for ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p></div>
      <div class="actions-row"><button class="btn" id="refresh">${icon("sparkles")}Refresh brief</button><a class="btn primary" href="#/ask">${icon("chat")}Ask ${esc(chiefName())}</a></div></div>
    <section class="panel brief"><div class="thinking">${icon("sparkles")} Reading your day…</div></section>`;
  $("#refresh").addEventListener("click", () => Brief(true));
  try {
    const r = await callFn("chief", { mode: "brief", tz: TZ, refresh });
    $(".brief").innerHTML = `<div class="md">${md(r.text)}</div><p class="muted small">${r.cached ? "Prepared " + ago(r.created_at) + ". Refresh for an update." : "Just prepared."} ${esc(chiefName())} only sees what you can see in Pulse, and can be wrong: check before you act.</p>`;
    if (r.proposals?.length) {
      $(".brief").insertAdjacentHTML("afterend", `<h2 class="hub-h">Suggested next steps</h2><div class="appr-grid" id="props">${r.proposals.map(proposalCard).join("")}</div>`);
      wireProposals(r.proposals, $("#props"));
    }
  } catch (e) { $(".brief").outerHTML = problem(e); }
}

/* ================================================================ Ask */
const STARTERS = () => isStaff()
  ? ["What's slipping this week?", "Prep me for today", "Who needs a follow-up from me?", "What should I delegate?", "Draft my weekly update for the team"]
  : ["What do I still need to do for onboarding?", "Is my timesheet up to date?", "What's on my plate this week?"];
function Ask() {
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Ask ${esc(chiefName())}</h1><p class="muted">Questions about your work in Pulse: deadlines, follow-ups, approvals, timecards, meetings.</p></div>
      ${CH.history.length ? `<div class="actions-row"><button class="btn small" id="clear">New conversation</button></div>` : ""}</div>
    <section class="panel chat"><div id="msgs">${CH.history.length ? CH.history.map(msgHtml).join("") : `<div class="starters">${STARTERS().map((q) => `<button class="chip-check starter">${esc(q)}</button>`).join("")}</div>`}</div>
      <form id="askForm" class="ask-row"><textarea id="q" rows="2" placeholder="Ask anything about your work…" aria-label="Question"></textarea><button class="btn primary">${icon("send")}Ask</button></form></section>`;
  $$(".starter").forEach((b) => b.addEventListener("click", () => { $("#q").value = b.textContent; $("#askForm").requestSubmit(); }));
  $("#clear")?.addEventListener("click", () => { CH.history = []; saveHistory(); Ask(); });
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#askForm").requestSubmit(); } });
  $("#askForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const q = $("#q").value.trim(); if (!q) return;
    $(".starters")?.remove();
    const history = CH.history.map(({ role, content }) => ({ role, content }));
    CH.history.push({ role: "user", content: q }); $("#q").value = "";
    $("#msgs").insertAdjacentHTML("beforeend", msgHtml(CH.history.at(-1)) + `<div class="msg ai thinking" id="wait">${icon("sparkles")} Thinking…</div>`);
    $("#wait").scrollIntoView({ block: "nearest" });
    try {
      const r = await callFn("chief", { mode: "ask", question: q, history, tz: TZ });
      CH.history.push({ role: "assistant", content: r.text || "(no answer)", proposals: r.proposals || [] }); saveHistory();
      $("#wait").outerHTML = msgHtml(CH.history.at(-1), CH.history.length - 1);
      const last = $$("#msgs .msg.ai").at(-1); wireProposals(r.proposals || [], last); last.scrollIntoView({ block: "nearest" });
    } catch (err) { CH.history.pop(); $("#wait").outerHTML = err.setup || err.status === 503 ? problem(err) : `<div class="msg ai err">${esc(err.message)}</div>`; }
  });
}
function msgHtml(m) {
  if (m.role === "user") return `<div class="msg me">${esc(m.content)}</div>`;
  return `<div class="msg ai"><div class="md">${md(m.content)}</div>${(m.proposals || []).length ? `<div class="appr-grid">${m.proposals.map(proposalCard).join("")}</div>` : ""}</div>`;
}

/* ================================================================ Reminders */
async function Reminders() {
  const rows = must(await sb.from("reminders").select("*").eq("user_id", S.user.id).order("remind_at"));
  const open = rows.filter((r) => !r.done), closed = rows.filter((r) => r.done).slice(-20).reverse();
  const nowT = Date.now();
  const line = (r) => `<li class="ck ${r.done ? "done" : ""} ${!r.done && Date.parse(r.remind_at) < nowT ? "due" : ""}"><label class="check"><input type="checkbox" data-rem="${r.id}" ${r.done ? "checked" : ""}> <span>${esc(r.text)}</span></label>
    <span class="meta">${r.from_chief ? icon("sparkles", "ic tiny") : ""} ${new Date(r.remind_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
    <button class="link" data-del="${r.id}" aria-label="Delete">✕</button></span></li>`;
  const tomorrow9 = new Date(); tomorrow9.setDate(tomorrow9.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0);
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Reminders</h1><p class="muted">Yours only. Due reminders also show on your landing page and in ${esc(chiefName())}'s brief.</p></div></div>
    <section class="panel"><form id="remForm" class="add-action" style="grid-template-columns:1fr 220px auto;margin:0 0 14px">
      <input id="remText" placeholder="Remind me to…" required aria-label="Reminder"><input id="remAt" type="datetime-local" value="${local(tomorrow9)}" aria-label="When"><button class="btn primary">Add</button></form>
      <ul class="checklist">${open.map(line).join("") || `<li class="empty">Nothing coming up.</li>`}</ul></section>
    ${closed.length ? `<h2 class="hub-h">Done</h2><section class="panel"><ul class="checklist">${closed.map(line).join("")}</ul></section>` : ""}`;
  $("#remForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { must(await sb.from("reminders").insert({ text: $("#remText").value.trim(), remind_at: new Date($("#remAt").value).toISOString() })); Reminders(); badge(); } catch (err) { toast(err.message); }
  });
  $$("[data-rem]").forEach((c) => c.addEventListener("change", async () => { try { must(await sb.from("reminders").update({ done: c.checked }).eq("id", +c.dataset.rem)); Reminders(); badge(); } catch (err) { toast(err.message); } }));
  $$("[data-del]").forEach((b) => b.addEventListener("click", async () => { try { must(await sb.from("reminders").delete().eq("id", +b.dataset.del)); Reminders(); badge(); } catch (err) { toast(err.message); } }));
}
async function badge() {
  try {
    const n = must(await sb.from("reminders").select("id, remind_at").eq("user_id", S.user.id).eq("done", false)).filter((r) => Date.parse(r.remind_at) < Date.now()).length;
    const b = $("#nb-reminders"); if (b) { b.hidden = !n; b.textContent = n; }
  } catch { /* not set up */ }
}

/* ================================================================ router */
const routes = { brief: () => Brief(), ask: Ask, reminders: Reminders };
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [name] = location.hash.replace(/^#\/?/, "").split("/");
  const key = routes[name] ? name : "brief";
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.body.classList.remove("nav-open"); closeDrawer();
  $("#main").innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve(routes[key]()).catch((e) => ($("#main").innerHTML = /reminders|schema cache|does not exist/i.test(e.message)
    ? `<section class="panel"><h2>One-time setup needed</h2><p>Chief of Staff needs the latest database update.</p></section>` : problem(e)));
  $("#main").focus({ preventScroll: true });
}
async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try {
    if (!(await requireMember())) return;
    const n = chiefName();
    $$(".crumb, .side-head span").forEach((e) => (e.textContent = n)); document.title = document.title.replace("Chief of Staff", n);
    $$("#nav .nav-label").forEach((e) => (e.textContent = n));
    showShell(); route(); badge();
  } catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
