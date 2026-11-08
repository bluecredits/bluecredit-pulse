/* Pulse · People → Hiring: openings, the candidate pipeline, interviews and blind scorecards.
   The database decides who sees what (see "Hiring" in schema.sql): admins, the hiring manager, the candidate's
   owner and that candidate's interviewers. Applicants apply through ../apply/?t=<token> without signing in. */
"use strict";

const HSTAGES = ["Applied", "Screen", "Interview", "Work sample", "Final", "Offer"];
const HCLOSED = ["Hired", "Rejected", "Withdrew"];
const HKINDS = ["Employee", "Contractor", "Consultant", "Intern", "Advisor"];
const HSCHED = ["Full-time", "Part-time", "As needed"];
const HREMOTE = ["Remote", "Hybrid", "On-site"];
const HSTATUS = ["Draft", "Open", "On hold", "Filled", "Closed"];
const ISTYPES = ["Screen", "Interview", "Work sample review", "Final", "Reference check"];
const RECS = ["Strong yes", "Yes", "No", "Strong no"];
const REJECT_REASONS = ["Missing must-haves", "Not enough experience", "Skills didn't match in interview", "Work sample below the bar",
  "Another candidate chosen", "Pay or location mismatch", "No response from candidate", "Other"];
const SOURCES = ["Apply link", "Referral", "LinkedIn", "Indeed", "University", "Added by hand", "Other"];
const DEFAULT_CRITERIA = ["Technical skill", "Problem solving", "Communication", "Ownership", "Fit with our mission"];
// what moving to each stage usually means (shown on the candidate)
const STAGE_HINT = {
  Applied: "Read the resume against the must-haves. Advance to a screen or reject within 3 days.",
  Screen: "20–30 minute call: must-haves, availability, pay and location expectations.",
  Interview: "Role interview with two interviewers. Each fills a scorecard before seeing the other's.",
  "Work sample": "A short, time-boxed task like the real work. Review it against the scorecard criteria.",
  Final: "Values and working-style conversation with the founder; check two references.",
  Offer: "Send the offer. When it's accepted, mark them hired to start onboarding.",
};
const DEFAULT_EMAILS = {
  screen: { label: "Invite to a screen", subject: "{role} at {company}: quick call?", body: "Hi {first},\n\nThank you for applying for the {role} position at {company}. We'd like to set up a 20–30 minute call to learn more about you and answer your questions.\n\nCould you share a few times that work for you this week or next?\n\nBest,\n{me}" },
  interview: { label: "Invite to interview", subject: "{role} at {company}: interview", body: "Hi {first},\n\nThanks for the conversation. We'd like to invite you to an interview with the team (about 45 minutes, by video).\n\nPlease share a few times that work for you, or pick one here: {scheduler}\n\nBest,\n{me}" },
  sample: { label: "Send the work sample", subject: "{role} at {company}: work sample", body: "Hi {first},\n\nAs the next step we'd like you to complete a short work sample. It should take no more than 3–4 hours; please don't spend longer.\n\n[Describe the task, what to send back and by when]\n\nBest,\n{me}" },
  reject: { label: "Decline (polite)", subject: "Your application for {role} at {company}", body: "Hi {first},\n\nThank you for your interest in {company} and for the time you spent on your application. After careful consideration we've decided not to move forward for the {role} position.\n\nWe appreciate it and wish you the very best in your search.\n\nKind regards,\n{me}" },
  offer: { label: "Offer", subject: "Offer: {role} at {company}", body: "Hi {first},\n\nWe're delighted to offer you the {role} position at {company}.\n\n[Start date, pay, type of engagement and anything else]\n\nPlease reply to accept, or let us know if you have any questions.\n\nBest,\n{me}" },
};
const SAMPLE_OPENING = {
  title: "Applications Developer", kind: "Contractor", schedule: "Part-time", remote: "Remote",
  description: "Build and ship features for our web apps: a multi-company workspace (Pulse), water-modeling tools and a credit marketplace.\n\nYou'll work across JavaScript front ends and a Postgres/Supabase back end, turn requests into small, tested releases, and help keep our GitHub delivery on track.",
  must_haves: "• 2+ years building web apps with JavaScript (no-framework or React) and SQL\n• Postgres (row-level security, functions) or Supabase\n• Git and GitHub pull requests\n• Clear written English; comfortable working remotely and asynchronously\n• Nice to have: Python, GIS or water/environmental data",
  criteria: ["JavaScript and front-end", "SQL and data design", "Problem solving", "Communication", "Ownership and reliability"],
};
const hEmails = () => ({ ...DEFAULT_EMAILS, ...(S.workspace?.config?.hiring_emails || {}) });
const hCriteria = () => S.workspace?.config?.hiring_criteria?.length ? S.workspace.config.hiring_criteria : DEFAULT_CRITERIA;
const HF = { opening: "", q: "", closed: false };
const daysIn = (ts) => Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 864e5));
const staleAt = (stage) => (stage === "Applied" ? 3 : 7);
const applyUrl = (o) => location.origin + location.pathname.replace(/people\/?(index\.html)?$/, "") + "apply/?t=" + o.apply_token;
const staffList = () => S.team.filter((p) => p.active && isStaffRole(p.role));
const fill = (t, c, o) => t.replace(/\{(\w+)\}/g, (m, k) => ({ first: (c.name || "").split(" ")[0], name: c.name, role: o?.title || "the", company: S.workspace?.name || "", me: firstName(),
  scheduler: location.origin + location.pathname.replace(/people\/?(index\.html)?$/, "") + "scheduler/" }[k] ?? m));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const recClass = { "Strong yes": "s-won", Yes: "s-active", No: "s-high", "Strong no": "s-lost" };

/* ================================================================ Openings */
async function Openings() {
  const [ops, cands] = await Promise.all([must(await sb.from("hire_openings").select("*").order("created_at", { ascending: false })),
    must(await sb.from("hire_candidates").select("opening_id, stage"))]);
  const cnt = (id, stages) => cands.filter((c) => c.opening_id === id && stages.includes(c.stage)).length;
  const order = { Open: 0, Draft: 1, "On hold": 2, Filled: 3, Closed: 4 };
  ops.sort((a, b) => order[a.status] - order[b.status]);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Openings</h1><p class="muted">One per role. Post each apply link on LinkedIn or Indeed, or list every open role on your website with the careers page. Applications land in Candidates.</p></div>
      ${isAdmin() ? `<div class="actions-row"><a class="btn" href="#/hiring-setup">${icon("globe")}Careers page</a><button class="btn primary" id="newOpening">${icon("plus")}New opening</button></div>` : ""}</div>
    ${ops.length ? `<div class="hire-openings">${ops.map((o) => `<article class="panel hire-op ${o.status === "Open" ? "" : "dim"}" data-op="${o.id}" tabindex="0">
        <div class="hire-op-h"><div><h2>${esc(o.title)}</h2><p class="muted small">${esc([o.kind, o.schedule, o.remote, o.location].filter(Boolean).join(" · "))}${o.hiring_manager ? ` · Hiring manager ${esc(nameOf(o.hiring_manager))}` : ""}</p></div>
          <span class="pill ${o.status === "Open" ? "s-active" : o.status === "Filled" ? "s-won" : ""}">${esc(o.status)}</span></div>
        <div class="hire-op-n">${[["To review", ["Applied"]], ["In process", HSTAGES.slice(1)], ["Hired", ["Hired"]]].map(([l, st]) => `<a href="#/candidates?o=${o.id}"><b>${cnt(o.id, st)}</b><span>${l}</span></a>`).join("")}</div>
        <div class="actions-row">${o.status === "Open" ? `<button class="btn small" data-copy="${esc(applyUrl(o))}">${icon("send")}Copy apply link</button>` : ""}
          <a class="btn small" href="#/candidates?o=${o.id}">Candidates</a>${isAdmin() || o.hiring_manager === S.user.id ? `<button class="btn small" data-edit="${o.id}">Edit</button>` : ""}</div></article>`).join("")}</div>`
      : `<div class="empty">No openings yet.${isAdmin() ? ` <a href="#" id="firstOpening">Create the first one</a> (there's a sample Applications Developer description to start from).` : ""}</div>`}`;
  $("#newOpening")?.addEventListener("click", () => editOpening(null));
  $("#firstOpening")?.addEventListener("click", (e) => { e.preventDefault(); editOpening(null); });
  $$("[data-edit]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); editOpening(ops.find((o) => o.id === +b.dataset.edit)); }));
  $$("[data-copy]").forEach((b) => b.addEventListener("click", async (e) => { e.stopPropagation(); await navigator.clipboard.writeText(b.dataset.copy); toast("Apply link copied"); }));
  $$("[data-op]").forEach((c) => c.addEventListener("click", (e) => { if (!e.target.closest("a,button")) location.hash = `#/candidates?o=${c.dataset.op}`; }));
}

async function editOpening(o) {
  const P = await orgPositions(), curPos = o && P ? P.find((x) => x.opening_id === o.id) : null;
  const v = o || { kind: "Employee", remote: "Remote", status: "Draft", criteria: hCriteria(), work_sample: true, hiring_manager: S.user.id };
  $("#drawerTitle").textContent = o ? `Edit ${o.title}` : "New opening";
  $("#drawerBody").innerHTML = `<form id="opForm" class="form-grid">
    ${o ? "" : `<p class="muted small" style="grid-column:1/-1">Hiring a developer? <button type="button" class="link-btn" id="useSample">Start from the Applications Developer sample</button></p>`}
    <label style="grid-column:1/-1">Job title<input name="title" required value="${esc(v.title || "")}" placeholder="e.g. Applications Developer"></label>
    <label>Type<select name="kind">${HKINDS.map((k) => `<option ${k === v.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Hours<select name="schedule">${HSCHED.map((k) => `<option ${k === (v.schedule || "Full-time") ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Where<select name="remote">${HREMOTE.map((k) => `<option ${k === v.remote ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Location <small class="muted">(optional)</small><input name="location" value="${esc(v.location || "")}" placeholder="e.g. Alexandria, VA or US time zones"></label>
    <label>Hiring manager<select name="hiring_manager">${staffList().map((p) => `<option value="${p.id}" ${p.id === v.hiring_manager ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label>
    <label>Status<select name="status">${HSTATUS.map((k) => `<option ${k === v.status ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Pay <small class="muted">(optional; shown on the apply page)</small><input name="pay" value="${esc(v.pay || "")}" placeholder="e.g. $45–60/hour"></label>
    <label style="grid-column:1/-1">About the role<textarea name="description" rows="6">${esc(v.description || "")}</textarea></label>
    <label style="grid-column:1/-1">Must-haves<textarea name="must_haves" rows="5" placeholder="One per line">${esc(v.must_haves || "")}</textarea></label>
    <label style="grid-column:1/-1">Scorecard criteria <small class="muted">(one per line; interviewers rate each 1–5)</small><textarea name="criteria" rows="5">${esc((v.criteria || []).join("\n"))}</textarea></label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="work_sample" ${v.work_sample ? "checked" : ""}> Include a work sample stage</label>
    ${orgPicker(P, curPos, "Position on the org chart")}
    ${o ? `<div class="apply-box" style="grid-column:1/-1"><b>Apply link</b> <span class="muted small">${o.status === "Open" ? "Anyone with this link can apply." : "Applications are closed while the opening isn't Open."}</span>
      <code>${esc(applyUrl(o))}</code><div class="actions-row"><button type="button" class="btn small" id="cpLink">Copy</button><a class="btn small" href="${esc(applyUrl(o))}" target="_blank" rel="noopener">Open</a>
      <button type="button" class="btn small" id="newLink">New link</button></div></div>` : ""}
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">${o ? "Save" : "Create opening"}</button>${o && isAdmin() ? `<button type="button" class="btn danger" id="opDel">Delete</button>` : ""}</div></form>`;
  openDrawer();
  const f = $("#opForm");
  $("#useSample")?.addEventListener("click", () => { Object.entries(SAMPLE_OPENING).forEach(([k, val]) => { if (f[k]) f[k].value = Array.isArray(val) ? val.join("\n") : val; }); });
  $("#cpLink")?.addEventListener("click", async () => { await navigator.clipboard.writeText(applyUrl(o)); toast("Apply link copied"); });
  $("#newLink")?.addEventListener("click", async () => {
    if (!confirm("Make a new apply link? The old link stops working.")) return;
    const tok = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    try { must(await sb.from("hire_openings").update({ apply_token: tok }).eq("id", o.id)); toast("New link made"); editOpening({ ...o, apply_token: tok }); } catch (e) { toast(e.message); }
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const row = Object.fromEntries(["title", "kind", "schedule", "remote", "location", "hiring_manager", "status", "pay", "description", "must_haves"].map((k) => [k, f[k].value.trim() || null]));
    row.criteria = f.criteria.value.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!row.criteria.length) row.criteria = hCriteria();
    row.work_sample = f.work_sample.checked;
    try {
      let oid = o?.id;
      if (o) must(await sb.from("hire_openings").update(row).eq("id", o.id));
      else oid = must(await sb.from("hire_openings").insert(row).select("id").single()).id;
      const pick = orgPick(f.orgpos?.value);
      if (pick) await db.rpc("org_link_opening", { p_opening: oid, p_position: pick.position, p_parent: pick.parent, p_dept: null });
      toast(o ? "Saved" : row.status === "Open" ? "Opening created. Copy its apply link to post it." : "Opening created as a draft. Set it to Open to take applications.");
      closeDrawer(); route();
    } catch (err) { toast(err.message); }
  });
  $("#opDel")?.addEventListener("click", async () => {
    if (!confirm(`Delete ${o.title} and all its candidates? This can't be undone. (To stop applications, set it to Closed instead.)`)) return;
    try { must(await sb.from("hire_openings").delete().eq("id", o.id)); closeDrawer(); route(); toast("Deleted"); } catch (err) { toast(err.message); }
  });
}

/* ================================================================ Candidates board */
async function Candidates(qs) {
  const p = new URLSearchParams(qs || ""); if (p.has("o")) HF.opening = p.get("o");
  const [ops, cands, scores] = await Promise.all([must(await sb.from("hire_openings").select("id, title, status, work_sample, hiring_manager").order("title")),
    must(await sb.from("hire_candidates").select("id, opening_id, name, email, stage, stage_at, next_step, next_date, owner_id, source, created_at, reject_reason").order("stage_at")),
    must(await sb.from("hire_scores").select("candidate_id, ratings, recommendation, submitted_at")).filter((r) => r.submitted_at)]);
  if (HF.opening && !ops.some((o) => String(o.id) === HF.opening)) HF.opening = "";
  const opOf = Object.fromEntries(ops.map((o) => [o.id, o]));
  const q = HF.q.toLowerCase();
  const rows = cands.filter((c) => (!HF.opening || String(c.opening_id) === HF.opening) && (!q || `${c.name} ${c.email}`.toLowerCase().includes(q)));
  const showSample = HF.opening ? opOf[HF.opening]?.work_sample : ops.some((o) => o.work_sample);
  const cols = HSTAGES.filter((s) => s !== "Work sample" || showSample || rows.some((c) => c.stage === s));
  const scoreOf = (id) => { const s = scores.filter((x) => x.candidate_id === id); if (!s.length) return "";
    const all = s.flatMap((x) => Object.values(x.ratings || {}).map(Number).filter(Boolean)); const a = avg(all);
    return `<span class="hire-score" title="${s.length} scorecard${s.length > 1 ? "s" : ""}">${a ? a.toFixed(1) : "–"}★ · ${s.map((x) => esc((x.recommendation || "").replace("Strong ", "S. "))).join(", ")}</span>`; };
  const canAdd = isAdmin() || ops.some((o) => o.hiring_manager === S.user.id);
  const closed = rows.filter((c) => HCLOSED.includes(c.stage));
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Candidates</h1><p class="muted">${HF.opening ? esc(opOf[HF.opening].title) + " · " : ""}${rows.filter((c) => !HCLOSED.includes(c.stage)).length} in the pipeline. Click a card to review, score, move or decline.</p></div>
      ${canAdd && ops.length ? `<div class="actions-row"><button class="btn primary" id="addCand">${icon("plus")}Add candidate</button></div>` : ""}</div>
    <div class="filters"><select id="hOp" aria-label="Opening"><option value="">All openings</option>${ops.map((o) => `<option value="${o.id}" ${String(o.id) === HF.opening ? "selected" : ""}>${esc(o.title)}${o.status !== "Open" ? ` (${o.status})` : ""}</option>`).join("")}</select>
      <input type="search" id="hq" placeholder="Search candidates…" value="${esc(HF.q)}">
      <label class="check"><input type="checkbox" id="hClosed" ${HF.closed ? "checked" : ""}> Show hired and declined (${closed.length})</label></div>
    ${ops.length ? "" : `<div class="empty">Create an <a href="#/openings">opening</a> first; its apply link brings candidates in here.</div>`}
    <div class="hire-board" style="--cols:${cols.length}">${cols.map((st) => { const list = rows.filter((c) => c.stage === st);
      return `<section class="hire-col"><h3>${st} <span class="c">${list.length}</span></h3>${list.map((c) => { const d = daysIn(c.stage_at);
        return `<button type="button" class="hire-card" data-cand="${c.id}"><b>${esc(c.name)}</b>${HF.opening ? "" : `<span class="muted small">${esc(opOf[c.opening_id]?.title || "")}</span>`}
          <span class="hire-meta"><span class="${d >= staleAt(st) ? "due-over" : "muted"}" title="Days in this stage">${d}d</span>${scoreOf(c.id)}</span>
          ${c.next_step ? `<span class="small">${esc(c.next_step)}${c.next_date ? " · " + dueCell(c.next_date) : ""}</span>` : ""}</button>`; }).join("") || `<p class="muted small hire-empty">None</p>`}</section>`; }).join("")}</div>
    ${HF.closed && closed.length ? `<section class="panel" style="padding:0;margin-top:16px"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Opening</th><th>Outcome</th><th>Reason</th><th>When</th></tr></thead><tbody>
      ${closed.map((c) => `<tr data-cand="${c.id}" tabindex="0"><td><b>${esc(c.name)}</b></td><td>${esc(opOf[c.opening_id]?.title || "")}</td><td>${pill(c.stage === "Hired" ? "Won" : "Lost").replace(/>[^<]+</, `>${c.stage}<`)}</td><td>${esc(c.reject_reason || "")}</td><td>${short(c.stage_at)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
  $("#hOp").addEventListener("change", (e) => { HF.opening = e.target.value; location.hash = HF.opening ? `#/candidates?o=${HF.opening}` : "#/candidates"; });
  $("#hq").addEventListener("input", (e) => { HF.q = e.target.value; clearTimeout(HF.t); HF.t = setTimeout(() => Candidates().then(() => { const i = $("#hq"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 250); });
  $("#hClosed").addEventListener("change", (e) => { HF.closed = e.target.checked; Candidates(); });
  $("#addCand")?.addEventListener("click", () => addCandidate(ops));
  $$("[data-cand]").forEach((b) => b.addEventListener("click", () => openCand(+b.dataset.cand)));
}

const readB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("Couldn't read that file.")); r.readAsDataURL(file); });

function addCandidate(ops) {
  const mine = ops.filter((o) => isAdmin() || o.hiring_manager === S.user.id);
  $("#drawerTitle").textContent = "Add candidate";
  $("#drawerBody").innerHTML = `<form id="cForm" class="form-grid">
    <label style="grid-column:1/-1">Opening<select name="opening_id">${mine.map((o) => `<option value="${o.id}" ${String(o.id) === HF.opening ? "selected" : ""}>${esc(o.title)}</option>`).join("")}</select></label>
    <label>Name<input name="name" required></label><label>Email<input name="email" type="email"></label>
    <label>Phone<input name="phone"></label><label>Location<input name="location"></label>
    <label>Source<select name="source">${SOURCES.filter((s) => s !== "Apply link").map((s) => `<option ${s === "Referral" ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    <label>Owner<select name="owner_id">${staffList().map((p) => `<option value="${p.id}" ${p.id === S.user.id ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label>
    <label>LinkedIn<input name="linkedin" type="url" placeholder="https://"></label><label>GitHub<input name="github" type="url" placeholder="https://"></label>
    <label style="grid-column:1/-1">Portfolio / website<input name="portfolio" type="url" placeholder="https://"></label>
    <label style="grid-column:1/-1">Resume <small class="muted">(PDF or Word, up to 7 MB)</small><input name="file" type="file" accept=".pdf,.doc,.docx,.rtf,.txt,.odt"></label>
    <label style="grid-column:1/-1">Notes<textarea name="notes" rows="3" placeholder="Who referred them, first impressions…"></textarea></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Add candidate</button></div></form>`;
  openDrawer();
  $("#cForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target, b = $("button.primary", f); b.disabled = true;
    const links = Object.fromEntries(["linkedin", "github", "portfolio"].map((k) => [k, f[k].value.trim()]).filter(([, v]) => /^https?:\/\//i.test(v)));
    const row = { opening_id: +f.opening_id.value, name: f.name.value.trim(), email: f.email.value.trim().toLowerCase() || null, phone: f.phone.value.trim() || null,
      location: f.location.value.trim() || null, source: f.source.value, owner_id: f.owner_id.value, notes: f.notes.value.trim() || null, links };
    try {
      const c = must(await sb.from("hire_candidates").insert(row).select("id").single());
      const file = f.file.files[0];
      if (file) { if (file.size > 7e6) throw new Error("That resume is over 7 MB."); await db.rpc("hire_upload", { p_candidate: c.id, p_name: file.name, p_mime: file.type || "application/octet-stream", p_b64: await readB64(file) }); }
      toast(`${row.name} added`); route(); openCand(c.id);
    } catch (err) { toast(/ux_hire_cand_email/.test(err.message) ? "That email has already applied for this opening." : err.message); b.disabled = false; }
  });
}

/* ================================================================ one candidate */
async function openCand(id) {
  const c = must(await sb.from("hire_candidates").select("*").eq("id", id).single());
  const [o, files, ints, scores, evs] = await Promise.all([
    must(await sb.from("hire_openings").select("*").eq("id", c.opening_id).single()),
    must(await sb.from("hire_files").select("id, name, size, uploaded_by, created_at").eq("candidate_id", id).order("created_at")),
    must(await sb.from("hire_interviews").select("*").eq("candidate_id", id).order("scheduled_at", { nullsFirst: false })),
    must(await sb.from("hire_scores").select("*").eq("candidate_id", id)),
    must(await sb.from("hire_events").select("ts, who, text").eq("candidate_id", id).order("ts", { ascending: false }).limit(40))]);
  const lead = isAdmin() || o.hiring_manager === S.user.id || c.owner_id === S.user.id;
  const stages = HSTAGES.filter((s) => s !== "Work sample" || o.work_sample || c.stage === s);
  const i = stages.indexOf(c.stage), next = i >= 0 && i < stages.length - 1 ? stages[i + 1] : null;
  const crit = o.criteria?.length ? o.criteria : hCriteria();
  const done = scores.filter((s) => s.submitted_at);
  const L = c.links || {};
  const emails = hEmails();
  const suggested = { Applied: "screen", Screen: "interview", Interview: o.work_sample ? "sample" : "interview", "Work sample": "interview", Final: "offer", Offer: "offer" }[c.stage];
  const mailto = (k) => `mailto:${encodeURIComponent(c.email || "")}?subject=${encodeURIComponent(fill(emails[k].subject, c, o))}&body=${encodeURIComponent(fill(emails[k].body, c, o))}`;
  const myOpen = ints.filter((x) => x.status !== "Cancelled" && (x.interviewer_ids || []).includes(S.user.id) && !scores.some((s) => s.interview_id === x.id && s.interviewer_id === S.user.id && s.submitted_at));
  $("#drawerTitle").textContent = c.name;
  $("#drawerBody").innerHTML = `
    <div class="hire-steps">${[...stages, ...(HCLOSED.includes(c.stage) ? [c.stage] : [])].map((s, k) => `<span class="${s === c.stage ? "on" : k < i ? "past" : ""} ${["Rejected", "Withdrew"].includes(s) ? "out" : ""}">${s}</span>`).join("")}</div>
    ${STAGE_HINT[c.stage] ? `<p class="muted small" style="margin:-4px 0 12px">${STAGE_HINT[c.stage]}</p>` : ""}
    <div class="ob-facts">${[["Opening", esc(o.title)], ["Email", c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "—"], ["Phone", esc(c.phone || "—")], ["Location", esc(c.location || "—")],
      ["Source", esc(c.source)], ["Owner", esc(nameOf(c.owner_id) || "—")], ["Applied", short(c.created_at)], ["In this stage", `${daysIn(c.stage_at)} days`]].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>
    ${Object.keys(L).length ? `<div class="chips" style="margin:6px 0 10px">${Object.entries(L).map(([k, v]) => `<a class="chip" href="${esc(v)}" target="_blank" rel="noopener">${esc(cap(k === "github" ? "GitHub" : k === "linkedin" ? "LinkedIn" : k))} ↗</a>`).join("")}</div>` : ""}

    ${lead && !HCLOSED.includes(c.stage) ? `<div class="actions-row hire-acts">
        ${c.stage === "Offer" ? `<button class="btn primary" id="hHire">${icon("check")}Offer accepted: mark hired</button>` : next ? `<button class="btn primary" id="hNext">Move to ${next}</button>` : ""}
        <button class="btn" id="hReject">Decline…</button><button class="btn" id="hWithdrew">Candidate withdrew</button></div>` : ""}
    ${c.onboarding_id ? `<p class="notice-bar" style="margin:8px 0">${icon("check")}<span>Hired. <a href="#/people" data-onb="${c.onboarding_id}">Open their onboarding checklist</a> · <a href="../agreements/#/new?template=consulting&onboarding=${c.onboarding_id}">Create their agreement</a></span></p>` : ""}

    ${c.email ? `<h3 class="ck-h">Email</h3><div class="chips">${Object.entries(emails).map(([k, e]) => `<a class="chip ${k === suggested ? "on" : ""}" href="${mailto(k)}">${esc(e.label)}</a>`).join("")}</div>` : ""}

    <h3 class="ck-h">Next step</h3>
    ${lead ? `<div class="add-action" style="grid-template-columns:1fr 150px auto"><input id="nsText" value="${esc(c.next_step || "")}" placeholder="e.g. Screen call with Barasa" aria-label="Next step">
      <input id="nsDate" type="date" value="${c.next_date || ""}" aria-label="Date"><button class="btn small" id="nsSave">Save</button></div>`
      : `<p>${esc(c.next_step || "—")}${c.next_date ? " · " + dueCell(c.next_date) : ""}</p>`}

    <h3 class="ck-h">Resume and files</h3>
    <ul class="checklist">${files.map((f) => `<li class="ck"><span>${icon("clipboard", "ic tiny")} <b>${esc(f.name)}</b> <span class="muted small">${Math.round((f.size || 0) / 1024)} KB · ${esc(f.uploaded_by || "")} ${short(f.created_at)}</span></span>
      <span class="meta"><button class="btn small" data-dl="${f.id}">Download</button></span></li>`).join("") || `<li class="muted small" style="padding:4px 10px">No resume yet.</li>`}</ul>
    ${lead ? `<label class="btn small file-btn">${icon("plus")}Add file<input type="file" id="hFile" hidden accept=".pdf,.doc,.docx,.rtf,.txt,.odt,.png,.jpg,.zip"></label>` : ""}
    ${c.cover_letter ? `<h3 class="ck-h">Cover note</h3><p class="hire-cover">${esc(c.cover_letter)}</p>` : ""}

    <h3 class="ck-h">Interviews</h3>
    ${myOpen.length ? `<p class="notice-bar">${icon("sparkles")}<span>You have a scorecard to fill for this candidate. <button class="link-btn" data-score="${myOpen[0].id}">Fill it now</button></span></p>` : ""}
    <ul class="checklist">${ints.map((x) => { const sc = scores.filter((s) => s.interview_id === x.id);
      return `<li class="ck"><span><b>${esc(x.kind)}</b> · ${x.scheduled_at ? new Date(x.scheduled_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "time not set"}
        ${x.place ? ` · ${/^https?:/.test(x.place) ? `<a href="${esc(x.place)}" target="_blank" rel="noopener">join</a>` : esc(x.place)}` : ""}<br>
        <span class="muted small">${(x.interviewer_ids || []).map((u) => { const s = sc.find((y) => y.interviewer_id === u);
          return `${esc(nameOf(u))} ${s?.submitted_at ? "✓" : "…"}`; }).join(" · ")}${x.status !== "Scheduled" ? " · " + esc(x.status) : ""}</span></span>
        <span class="meta">${(x.interviewer_ids || []).includes(S.user.id) && x.status !== "Cancelled" ? `<button class="btn small" data-score="${x.id}">Scorecard</button>` : ""}
          ${lead && x.status === "Scheduled" ? `<button class="btn small" data-int-done="${x.id}">Done</button><button class="btn small" data-int-cancel="${x.id}">Cancel</button>` : ""}</span></li>`; }).join("") || `<li class="muted small" style="padding:4px 10px">None scheduled.</li>`}</ul>
    ${lead && !HCLOSED.includes(c.stage) ? `<button class="btn small" id="hSched">${icon("calendar")}Schedule interview</button>` : ""}

    <h3 class="ck-h">Scorecards <small class="muted">${done.length} submitted${!lead && !done.some((s) => s.interviewer_id === S.user.id) ? " · others' scores show after you submit yours" : ""}</small></h3>
    ${done.length ? `<div class="table-wrap"><table class="hire-scores"><thead><tr><th>Criterion</th>${done.map((s) => `<th>${esc(nameOf(s.interviewer_id))}</th>`).join("")}<th>Avg</th></tr></thead><tbody>
      ${crit.map((k) => { const vals = done.map((s) => Number(s.ratings?.[k]) || null); const a = avg(vals.filter(Boolean));
        return `<tr style="cursor:default"><td>${esc(k)}</td>${vals.map((v) => `<td class="num">${v ?? "–"}</td>`).join("")}<td class="num"><b>${a ? a.toFixed(1) : "–"}</b></td></tr>`; }).join("")}
      <tr style="cursor:default"><td><b>Recommendation</b></td>${done.map((s) => `<td><span class="pill ${recClass[s.recommendation] || ""}">${esc(s.recommendation || "—")}</span></td>`).join("")}<td></td></tr></tbody></table></div>
      ${done.filter((s) => s.notes).map((s) => `<p class="small"><b>${esc(nameOf(s.interviewer_id))}:</b> ${esc(s.notes)}</p>`).join("")}` : `<p class="muted small">None yet.</p>`}

    <h3 class="ck-h">Notes</h3>
    ${lead ? `<textarea id="hNotes" rows="3" style="width:100%">${esc(c.notes || "")}</textarea><button class="btn small" id="hNotesSave" style="margin-top:6px">Save notes</button>` : `<p class="hire-cover">${esc(c.notes || "—")}</p>`}

    <h3 class="ck-h">History</h3>
    <ul class="list hire-ev">${evs.map((e) => `<li><span>${esc(e.text)}</span><span class="meta">${esc(e.who || "")} · ${ago(e.ts)}</span></li>`).join("")}</ul>
    ${isAdmin() ? `<div class="actions-row" style="margin-top:14px"><button class="btn danger small" id="hDel">Delete candidate</button></div>` : ""}`;
  openDrawer();
  const save = async (patch, msg) => { try { must(await sb.from("hire_candidates").update(patch).eq("id", id)); toast(msg); openCand(id); if (/candidates/.test(location.hash) || !location.hash) Candidates(); } catch (e) { toast(e.message); } };
  $("#hNext")?.addEventListener("click", () => save({ stage: next, reject_reason: null }, `${c.name} moved to ${next}`));
  $("#hWithdrew")?.addEventListener("click", () => { if (confirm(`Mark ${c.name} as withdrawn?`)) save({ stage: "Withdrew", next_step: null, next_date: null }, "Marked withdrawn"); });
  $("#hReject")?.addEventListener("click", () => rejectBox(c, o));
  $("#hHire")?.addEventListener("click", () => hireBox(c, o));
  $("#nsSave")?.addEventListener("click", () => save({ next_step: $("#nsText").value.trim() || null, next_date: $("#nsDate").value || null }, "Next step saved"));
  $("#hNotesSave")?.addEventListener("click", () => save({ notes: $("#hNotes").value.trim() || null }, "Notes saved"));
  $("#hSched")?.addEventListener("click", () => scheduleBox(c, o));
  $$("[data-score]").forEach((b) => b.addEventListener("click", () => scoreBox(c, o, ints.find((x) => x.id === +b.dataset.score), scores.find((s) => s.interview_id === +b.dataset.score && s.interviewer_id === S.user.id))));
  $$("[data-int-done]").forEach((b) => b.addEventListener("click", async () => { try { must(await sb.from("hire_interviews").update({ status: "Done" }).eq("id", +b.dataset.intDone)); openCand(id); } catch (e) { toast(e.message); } }));
  $$("[data-int-cancel]").forEach((b) => b.addEventListener("click", async () => { if (!confirm("Cancel this interview?")) return; try { must(await sb.from("hire_interviews").update({ status: "Cancelled" }).eq("id", +b.dataset.intCancel)); openCand(id); } catch (e) { toast(e.message); } }));
  $$("[data-dl]").forEach((b) => b.addEventListener("click", async () => {
    try { const f = must(await sb.from("hire_files").select("name, mime, data_b64").eq("id", +b.dataset.dl).single());
      const a = document.createElement("a"); a.href = `data:${f.mime || "application/octet-stream"};base64,${f.data_b64}`; a.download = f.name; a.click(); } catch (e) { toast(e.message); }
  }));
  $("#hFile")?.addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 7e6) return toast("That file is over 7 MB.");
    try { await db.rpc("hire_upload", { p_candidate: id, p_name: file.name, p_mime: file.type || "application/octet-stream", p_b64: await readB64(file) }); toast("File added"); openCand(id); } catch (err) { toast(err.message); }
  });
  $("[data-onb]")?.addEventListener("click", (e) => { e.preventDefault(); closeDrawer(); location.hash = "#/people"; setTimeout(() => openPerson(c.onboarding_id), 300); });
  $("#hDel")?.addEventListener("click", async () => {
    if (!confirm(`Delete ${c.name}, their resume, interviews and scorecards? This can't be undone.`)) return;
    try { must(await sb.from("hire_candidates").delete().eq("id", id)); closeDrawer(); route(); toast("Deleted"); } catch (e) { toast(e.message); }
  });
}

function rejectBox(c, o) {
  const e = hEmails().reject;
  $("#drawerTitle").textContent = `Decline ${c.name}`;
  $("#drawerBody").innerHTML = `<form id="rjForm" class="form-grid">
    <label style="grid-column:1/-1">Reason <small class="muted">(internal; helps you see where candidates drop out)</small><select name="reason">${REJECT_REASONS.map((r) => `<option>${r}</option>`).join("")}</select></label>
    <label style="grid-column:1/-1">Email to the candidate<textarea name="body" rows="9">${esc(fill(e.body, c, o))}</textarea></label>
    <div class="actions-row" style="grid-column:1/-1">${c.email ? `<button class="btn primary" name="go" value="mail">Decline and open the email</button>` : ""}<button class="btn" name="go" value="quiet">Decline without email</button>
      <button type="button" class="btn" id="rjBack">Back</button></div></form>`;
  $("#rjBack").addEventListener("click", () => openCand(c.id));
  $("#rjForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const f = ev.target, how = ev.submitter?.value;
    try {
      must(await sb.from("hire_candidates").update({ stage: "Rejected", reject_reason: f.reason.value, next_step: null, next_date: null }).eq("id", c.id));
      if (how === "mail") location.href = `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(fill(e.subject, c, o))}&body=${encodeURIComponent(f.body.value)}`;
      toast(`${c.name} declined`); openCand(c.id); if (/candidates/.test(location.hash)) Candidates();
    } catch (err) { toast(err.message); }
  });
}

async function hireBox(c, o) {
  const P = await orgPositions(), linked = P?.find((x) => x.opening_id === o.id && !x.holder);
  $("#drawerTitle").textContent = `Hire ${c.name}`;
  $("#drawerBody").innerHTML = `<form id="hiForm" class="form-grid">
    <p style="grid-column:1/-1">This marks ${esc(c.name)} hired for <b>${esc(o.title)}</b> and starts their onboarding checklist (${esc(o.kind)}) in People, owned by the hiring manager.</p>
    <label>Start date<input name="start" type="date" required value="${addDays(today(), 14)}"></label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" name="fill" ${o.status === "Open" ? "checked" : ""}> Mark the opening Filled (stops new applications)</label>
    ${linked ? `<p class="notice-bar ok" style="grid-column:1/-1">${icon("team")}<span>${esc(c.name)} goes into <b>${esc(linked.title)}</b> on the org chart.</span></p>` : orgPicker(P, null)}
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Mark hired and start onboarding</button><button type="button" class="btn" id="hiBack">Back</button></div></form>`;
  $("#hiBack").addEventListener("click", () => openCand(c.id));
  $("#hiForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const f = ev.target;
    try {
      const oid = await db.rpc("hire_mark_hired", { p_candidate: c.id, p_start: f.start.value, p_checklist: template().map((i) => ({ ...i, id: i.id || newId(), done: false })) });
      const pick = !linked && orgPick(f.orgpos?.value);
      if (pick && oid) await db.rpc("org_place", { p_onboarding: oid, p_position: pick.position, p_parent: pick.parent, p_title: o.title, p_dept: null }).catch((e) => toast(e.message));
      if (f.fill.checked) must(await sb.from("hire_openings").update({ status: "Filled" }).eq("id", o.id));
      toast(`${c.name} hired. Onboarding started.`); openCand(c.id); if (/candidates/.test(location.hash)) Candidates();
    } catch (err) { toast(err.message); }
  });
}

function scheduleBox(c, o) {
  const kind = { Applied: "Screen", Screen: "Screen", Interview: "Interview", "Work sample": "Work sample review", Final: "Final", Offer: "Reference check" }[c.stage] || "Interview";
  $("#drawerTitle").textContent = `Schedule: ${c.name}`;
  $("#drawerBody").innerHTML = `<form id="scForm" class="form-grid">
    <label>Type<select name="kind">${ISTYPES.map((k) => `<option ${k === kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>When<input name="when" type="datetime-local"></label>
    <label>Length (minutes)<input name="dur" type="number" min="10" step="5" value="${kind === "Screen" ? 30 : 45}"></label>
    <label>Where <small class="muted">(video link or place)</small><input name="place" placeholder="https://meet.google.com/…"></label>
    <fieldset style="grid-column:1/-1"><legend>Interviewers <small class="muted">(each fills a scorecard; they can see this candidate)</small></legend><div class="fed-checks">
      ${staffList().map((p) => `<label class="check"><input type="checkbox" name="iv" value="${p.id}" ${p.id === S.user.id ? "checked" : ""}> ${esc(p.display_name)}</label>`).join("")}</div></fieldset>
    <label style="grid-column:1/-1">Notes for interviewers<textarea name="notes" rows="3" placeholder="What to focus on"></textarea></label>
    <p class="muted small" style="grid-column:1/-1">Need a time that suits everyone? <a href="../scheduler/" target="_blank" rel="noopener">Find a time in Scheduler</a>, then enter it here.</p>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Schedule</button><button type="button" class="btn" id="scBack">Back</button></div></form>`;
  $("#scBack").addEventListener("click", () => openCand(c.id));
  $("#scForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const f = ev.target, ivs = $$("[name=iv]:checked", f).map((x) => x.value);
    if (!ivs.length) return toast("Pick at least one interviewer.");
    try {
      must(await sb.from("hire_interviews").insert({ candidate_id: c.id, kind: f.kind.value, scheduled_at: f.when.value ? new Date(f.when.value).toISOString() : null,
        duration_min: +f.dur.value || 45, place: f.place.value.trim() || null, interviewer_ids: ivs, notes: f.notes.value.trim() || null }));
      toast("Interview scheduled"); openCand(c.id);
    } catch (err) { toast(err.message); }
  });
}

function scoreBox(c, o, iv, mine) {
  const crit = o.criteria?.length ? o.criteria : hCriteria(), r = mine?.ratings || {}, locked = !!mine?.submitted_at;
  $("#drawerTitle").textContent = `Scorecard: ${c.name}`;
  $("#drawerBody").innerHTML = `<form id="sfForm" class="form-grid">
    <p class="muted small" style="grid-column:1/-1">${esc(iv.kind)} for ${esc(o.title)}. Rate what you saw, not what you expect: 1 = well below the bar, 3 = meets it, 5 = well above. ${locked ? "Submitted; you can still change it." : "Other interviewers' scores show after you submit."}</p>
    ${iv.notes ? `<p class="small" style="grid-column:1/-1"><b>Focus:</b> ${esc(iv.notes)}</p>` : ""}
    ${crit.map((k, n) => `<fieldset class="score-row" style="grid-column:1/-1"><legend>${esc(k)}</legend><div class="score-pick">${[1, 2, 3, 4, 5].map((v) =>
      `<label><input type="radio" name="c${n}" value="${v}" ${+r[k] === v ? "checked" : ""}><span>${v}</span></label>`).join("")}</div></fieldset>`).join("")}
    <fieldset style="grid-column:1/-1"><legend>Recommendation</legend><div class="score-pick wide">${RECS.map((v) => `<label><input type="radio" name="rec" value="${v}" ${mine?.recommendation === v ? "checked" : ""}><span>${v}</span></label>`).join("")}</div></fieldset>
    <label style="grid-column:1/-1">Evidence and notes<textarea name="notes" rows="5" placeholder="What did they say or do that supports your scores?">${esc(mine?.notes || "")}</textarea></label>
    <div class="actions-row" style="grid-column:1/-1"><button class="btn primary" name="go" value="submit">${locked ? "Update scorecard" : "Submit scorecard"}</button><button class="btn" name="go" value="draft">Save draft</button><button type="button" class="btn" id="sfBack">Back</button></div></form>`;
  $("#sfBack").addEventListener("click", () => openCand(c.id));
  $("#sfForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const f = ev.target, submit = ev.submitter?.value === "submit";
    const ratings = Object.fromEntries(crit.map((k, n) => [k, +($(`[name=c${n}]:checked`, f)?.value || 0)]).filter(([, v]) => v));
    const rec = $("[name=rec]:checked", f)?.value || null;
    if (submit && (Object.keys(ratings).length < crit.length || !rec)) return toast("Rate every criterion and choose a recommendation to submit (or save a draft).");
    const row = { interview_id: iv.id, candidate_id: c.id, ratings, recommendation: rec, notes: f.notes.value.trim() || null, submitted_at: submit ? mine?.submitted_at || new Date().toISOString() : mine?.submitted_at || null };
    try {
      if (mine) must(await sb.from("hire_scores").update(row).eq("id", mine.id)); else must(await sb.from("hire_scores").insert(row));
      toast(submit ? "Scorecard submitted" : "Draft saved"); openCand(c.id);
    } catch (err) { toast(err.message); }
  });
}

/* ================================================================ Interviews */
async function Interviews() {
  const [ints, cands, ops, mine] = await Promise.all([must(await sb.from("hire_interviews").select("*").neq("status", "Cancelled").order("scheduled_at", { nullsFirst: false })),
    must(await sb.from("hire_candidates").select("id, name, opening_id, stage")), must(await sb.from("hire_openings").select("id, title")),
    must(await sb.from("hire_scores").select("interview_id, submitted_at").eq("interviewer_id", S.user.id))]);
  const cOf = Object.fromEntries(cands.map((c) => [c.id, c])), oOf = Object.fromEntries(ops.map((o) => [o.id, o]));
  const now = Date.now();
  const toScore = ints.filter((i) => (i.interviewer_ids || []).includes(S.user.id) && (!i.scheduled_at || Date.parse(i.scheduled_at) <= now + 36e5) && !mine.some((s) => s.interview_id === i.id && s.submitted_at));
  const upcoming = ints.filter((i) => i.status === "Scheduled" && i.scheduled_at && Date.parse(i.scheduled_at) > now - 36e5);
  const past = ints.filter((i) => !upcoming.includes(i)).slice(-15).reverse();
  const row = (i) => { const c = cOf[i.candidate_id] || {}; return `<li><span><a href="#" data-cand="${i.candidate_id}">${esc(c.name || "Candidate")}</a> · ${esc(i.kind)}<br>
      <span class="meta">${esc(oOf[c.opening_id]?.title || "")} · ${(i.interviewer_ids || []).map((u) => esc(nameOf(u))).join(", ")}</span></span>
      <span class="meta">${i.scheduled_at ? new Date(i.scheduled_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "no time set"}</span></li>`; };
  $("#main").innerHTML = `<div class="page-head"><div><h1>Interviews</h1><p class="muted">Upcoming interviews and the scorecards waiting for you. Schedule new ones from a candidate.</p></div></div>
    <section class="panel"><h2>Scorecards to fill <small>${toScore.length}</small></h2>${toScore.length ? `<ul class="list">${toScore.map(row).join("")}</ul>` : `<p class="muted">You're all caught up.</p>`}</section>
    <section class="panel"><h2>Upcoming <small>${upcoming.length}</small></h2>${upcoming.length ? `<ul class="list">${upcoming.map(row).join("")}</ul>` : `<p class="muted">Nothing scheduled.</p>`}</section>
    ${past.length ? `<section class="panel"><h2>Recent</h2><ul class="list">${past.map(row).join("")}</ul></section>` : ""}`;
  $$("[data-cand]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openCand(+a.dataset.cand); }));
}

/* ================================================================ Hiring setup (admins) */
async function HiringSetup() {
  if (!isAdmin()) return Candidates();
  await loadWorkspace();
  const em = hEmails();
  let car = null; try { car = must(await sb.rpc("hire_careers_get")); } catch { car = null; }
  $("#main").innerHTML = `<div class="page-head"><div><h1>Hiring setup</h1><p class="muted">Defaults for new openings and the emails you send candidates. Placeholders: {first}, {name}, {role}, {company}, {me}, {scheduler}.</p></div>
      <div class="actions-row"><button class="btn primary" id="hsSave">Save</button></div></div>
    ${careersPanel(car)}
    <section class="panel"><h2>The process</h2><ol class="hire-process">${HSTAGES.map((s) => `<li><b>${s}</b> ${STAGE_HINT[s]}</li>`).join("")}<li><b>Hired</b> Onboarding starts automatically; create their agreement from Agreements.</li></ol>
      <p class="muted small">Candidates waiting more than 3 days in Applied, or 7 days in any other stage, are flagged on the board.</p></section>
    <section class="panel"><h2>Default scorecard criteria</h2><p class="muted small">New openings start with these (one per line). Each opening can change its own.</p>
      <textarea id="hsCrit" rows="6" style="width:100%">${esc(hCriteria().join("\n"))}</textarea></section>
    <section class="panel"><h2>Email templates</h2>${Object.entries(em).map(([k, e]) => `<div class="hs-email" data-k="${k}"><h3>${esc(e.label)}</h3>
      <label>Subject<input data-f="subject" value="${esc(e.subject)}"></label><label>Body<textarea data-f="body" rows="7">${esc(e.body)}</textarea></label></div>`).join("")}
      <button class="btn small" id="hsReset" type="button">Reset emails to the defaults</button></section>`;
  wireCareers(car);
  $("#hsReset").addEventListener("click", () => $$(".hs-email").forEach((d) => { const e = DEFAULT_EMAILS[d.dataset.k]; $("[data-f=subject]", d).value = e.subject; $("[data-f=body]", d).value = e.body; }));
  $("#hsSave").addEventListener("click", async () => {
    const crit = $("#hsCrit").value.split("\n").map((x) => x.trim()).filter(Boolean);
    const emails = Object.fromEntries($$(".hs-email").map((d) => [d.dataset.k, { label: DEFAULT_EMAILS[d.dataset.k].label, subject: $("[data-f=subject]", d).value, body: $("[data-f=body]", d).value }]));
    try { await db.rpc("update_workspace", { p: { config: { ...(S.workspace.config || {}), hiring_criteria: crit.length ? crit : DEFAULT_CRITERIA, hiring_emails: emails } } }); await loadWorkspace(); toast("Saved"); }
    catch (e) { toast(e.message); }
  });
}

// ── Careers page: one public page with every open opening, to link to or embed on the company's own website ──
const careersUrl = (slug, embed) => new URL(`../careers/?c=${encodeURIComponent(slug)}${embed ? "&embed=1" : ""}`, location.href).href;
const careersEmbed = (slug) => `<script src="${new URL("../careers/embed.js", location.href).href}" data-company="${slug}" async></script>`;
const suggestSlug = () => (S.workspace?.name || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "careers";
function careersPanel(car) {
  if (!car) return `<section class="panel careers-setup"><h2>Careers page</h2><p class="muted">The careers page needs a database update (supabase/fix_20261108c_careers.sql). Ask whoever runs Pulse to run it.</p></section>`;
  const slug = car.careers_slug || suggestSlug(), on = !!car.careers_on;
  return `<section class="panel careers-setup" id="careersBox"><h2>Careers page</h2>
    <p class="muted">Lists every <b>Open</b> opening on one public page that updates itself. Link to it from your website, or embed the list in your own careers page, so you never copy apply links by hand.</p>
    <label class="check"><input type="checkbox" id="carOn" ${on ? "checked" : ""}> Show my open positions on a public careers page</label>
    <div class="row"><label style="flex:1">Page address<input type="text" id="carSlug" value="${esc(slug)}" maxlength="40" placeholder="acme-robotics"></label><button class="btn primary" id="carSave" type="button">Save careers page</button></div>
    <div id="carOut">${on && car.careers_slug ? careersLinks(car.careers_slug) : ""}</div></section>`;
}
function careersLinks(slug) {
  return `<p><b>Link</b> (for your website's Careers menu, email signatures, LinkedIn): <a href="${careersUrl(slug)}" target="_blank" rel="noopener">${esc(careersUrl(slug))}</a> <button class="btn small" type="button" data-carcopy="${esc(careersUrl(slug))}">Copy link</button></p>
    <p><b>Embed</b> (paste into your website's careers page where the jobs should appear; works on WordPress, Squarespace, Wix and plain HTML):</p>
    <code>${esc(careersEmbed(slug))}</code><div class="row"><button class="btn small" type="button" data-carcopy="${esc(careersEmbed(slug))}">Copy embed code</button></div>
    <p class="muted small">Opening or closing an opening in Pulse updates both straight away. Search engines can list the jobs from the careers page too.</p>`;
}
function wireCareers(car) {
  const box = $("#careersBox"); if (!box) return;
  box.addEventListener("click", async (e) => { const b = e.target.closest("[data-carcopy]"); if (b) { await navigator.clipboard.writeText(b.dataset.carcopy); toast("Copied"); } });
  $("#carSave").addEventListener("click", async () => {
    try {
      const r = must(await sb.rpc("hire_careers_set", { p_on: $("#carOn").checked, p_slug: $("#carSlug").value }));
      $("#carSlug").value = r.slug; $("#carOut").innerHTML = r.on ? careersLinks(r.slug) : "";
      toast(r.on ? "Careers page is on" : "Careers page is off");
    } catch (e) { toast(e.message); }
  });
}
