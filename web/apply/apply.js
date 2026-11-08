/* Pulse · public apply page: ../apply/?t=<token>. No sign-in. Shows the opening (hire_opening_public)
   and sends the application with the resume (hire_apply). Nothing else is readable from here. */
"use strict";
window.onAuthLost = () => {};   // no sign-in on this page
const token = new URLSearchParams(location.search).get("t") || "";
const para = (t) => esc(t || "").split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");

async function load() {
  const main = $("#main");
  if (!sb) { main.innerHTML = `<div class="empty">This site isn't set up yet.</div>`; return; }
  let o = null;
  try { if (token.length >= 32) o = must(await sb.rpc("hire_opening_public", { p_token: token })); } catch { o = null; }
  if (!o) { main.innerHTML = `<section class="panel apply-card"><h1>Position not found</h1><p class="muted">This apply link isn't valid. Please check the link you were given.</p></section>`; return; }
  document.title = `${o.title} · ${o.company}`;
  main.innerHTML = `
    <section class="panel apply-card">
      <p class="apply-co">${esc(o.company)}</p>
      <h1>${esc(o.title)}</h1>
      <p class="muted">${esc([o.kind, o.schedule, o.remote, o.location, o.pay].filter(Boolean).join(" · "))}</p>
      ${o.description ? `<h2>About the role</h2>${para(o.description)}` : ""}
      ${o.must_haves ? `<h2>What you'll need</h2>${para(o.must_haves)}` : ""}
    </section>
    ${o.open ? `<form class="panel apply-card form-grid" id="apForm" novalidate>
      <h2 style="grid-column:1/-1">Apply</h2>
      <label>Full name *<input name="name" required autocomplete="name"></label>
      <label>Email *<input name="email" type="email" required autocomplete="email"></label>
      <label>Phone<input name="phone" type="tel" autocomplete="tel"></label>
      <label>Where you're based<input name="location" placeholder="City, country"></label>
      <label>LinkedIn<input name="linkedin" type="url" placeholder="https://linkedin.com/in/…"></label>
      <label>GitHub<input name="github" type="url" placeholder="https://github.com/…"></label>
      <label style="grid-column:1/-1">Portfolio or website<input name="portfolio" type="url" placeholder="https://"></label>
      <label style="grid-column:1/-1">Resume * <small class="muted">(PDF or Word, up to 5 MB)</small><input name="file" type="file" required accept=".pdf,.doc,.docx,.rtf,.odt,.txt"></label>
      <label style="grid-column:1/-1">Why this role? <small class="muted">(optional, a few sentences)</small><textarea name="cover" rows="5" maxlength="6000"></textarea></label>
      <label class="check" style="grid-column:1/-1"><input type="checkbox" name="ok" required> I agree that ${esc(o.company)} may use the information I send to consider me for this role.</label>
      <p class="form-error" id="apErr" style="grid-column:1/-1" hidden></p>
      <div class="actions-row" style="grid-column:1/-1"><button class="btn primary">Send application</button></div>
    </form>` : `<section class="panel apply-card"><p><b>This position isn't taking applications right now.</b></p></section>`}`;
  $("#apForm")?.addEventListener("submit", submit);
}

async function submit(e) {
  e.preventDefault();
  const f = e.target, err = $("#apErr"), b = $("button.primary", f), file = f.file.files[0];
  const fail = (m) => { err.textContent = m; err.hidden = false; b.disabled = false; b.textContent = "Send application"; };
  err.hidden = true;
  if (!f.name.value.trim() || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f.email.value.trim())) return fail("Please enter your name and a valid email address.");
  if (!file) return fail("Please attach your resume.");
  if (file.size > 5e6) return fail("Your resume is over 5 MB. Please send a smaller file.");
  if (!/\.(pdf|docx?|rtf|odt|txt)$/i.test(file.name)) return fail("Please attach your resume as a PDF or Word file.");
  if (!f.ok.checked) return fail("Please tick the box to agree to how your information is used.");
  b.disabled = true; b.textContent = "Sending…";
  try {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("Couldn't read that file.")); r.readAsDataURL(file); });
    const links = Object.fromEntries(["linkedin", "github", "portfolio"].map((k) => [k, f[k].value.trim()]).filter(([, v]) => /^https?:\/\//i.test(v)));
    const msg = must(await sb.rpc("hire_apply", { p_token: token, p_name: f.name.value.trim(), p_email: f.email.value.trim(), p_phone: f.phone.value.trim(),
      p_location: f.location.value.trim(), p_links: links, p_cover: f.cover.value.trim(), p_file_name: file.name, p_file_mime: file.type || "application/octet-stream", p_file_b64: b64 }));
    f.outerHTML = `<section class="panel apply-card apply-done">${icon("check")}<h2>Application sent</h2><p>${esc(msg)}</p><p class="muted">We'll be in touch by email.</p></section>`;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (x) { fail(x.message.replace(/^.*?ERROR:\s*/, "")); }
}
const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
load();
