/* Pulse · public signing page. Anyone with a private signing link (sign/#<token>) can read the agreement and sign or
   decline it; no Pulse account needed. The token stays in the URL fragment (never sent to servers in requests or
   referrers) and is passed only to the sign_view / sign_submit / sign_decline database functions. */
"use strict";
const A = window.PULSE_AGREEMENTS;
const token = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;

async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(error.message); return data; }

function docHtml(d) {
  const tpl = A.BUILTIN_TEMPLATES.find((t) => t.key === d.template_key) || { kind: "other", signers: (d.signers || []).map((s) => ({ role: s.role, label: s.label })) };
  let html = d.body_html || "";
  if ((d.signers || []).some((s) => s.status === "Signed")) html = html.replace(/<!--sigs-->[\s\S]*?<!--\/sigs-->/, A.signatureBlocks(tpl, A.agreementVars(tpl, d.fields || {}), d.signers));
  return html;
}
function render(d) {
  // the sender's name is in the heading (the header chip that used to hold it was removed on Nov 6, which broke this page)
  document.title = `${d.title} · Review and sign`;
  const me = d.me, open = d.status === "Out for signature" && !["Signed", "Declined"].includes(me.status);
  const others = (d.signers || []).filter((s) => !(s.name === me.name && s.role === me.role));
  $("#main").innerHTML = `
    <section class="panel sign-head"><div><p class="muted small">${esc(d.company)} sent you this agreement${d.sent_at ? " on " + new Date(d.sent_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : ""}</p>
      <h1>${esc(d.title)}</h1><p class="muted">For <b>${esc(me.name)}</b>${me.label ? " · " + esc(me.label) : ""}</p></div>
      <div class="sign-status">${me.status === "Signed" ? `<span class="pill s-won">You signed ${new Date(me.signed_at).toLocaleDateString()}</span>` : me.status === "Declined" ? `<span class="pill s-lost">You declined</span>`
        : d.status === "Out for signature" ? `<span class="pill s-submitted">Waiting for your signature</span>` : `<span class="pill">${esc(d.status)}</span>`}
        ${d.status === "Active" || d.status === "Closed out" || d.status === "Expired" || d.status === "Terminated" ? `<button class="btn small" id="printIt">${ic("arrow-out")}Download / print</button>` : ""}</div></section>
    ${others.length ? `<p class="muted small sign-others">Other signers: ${others.map((s) => `${esc(s.name)} (${esc(s.status === "Signed" ? "signed" : "not yet signed")})`).join(" · ")}</p>` : ""}
    <section class="panel agr-doc-wrap"><div class="agr-doc">${docHtml(d)}</div></section>
    ${open ? `<section class="panel sign-box" id="signBox"><h2>Sign</h2>
      <form id="signForm"><div class="form-grid"><label>Full legal name<input name="name" value="${esc(me.name)}" required autocomplete="name"></label>
        <label>Title (if signing for a company)<input name="title" value="${esc(me.title || "")}" autocomplete="organization-title"></label></div>
        <div id="pad"></div>
        <label class="check consent"><input type="checkbox" name="consent" required> I have read this agreement. I agree to do business electronically and to sign it with an electronic signature, which is as binding as my handwritten signature. I can ask the sender for a paper copy.</label>
        <div class="actions-row" style="margin-top:12px"><button class="btn primary">${ic("check")}Sign agreement</button><button class="btn" type="button" id="declineBtn">Decline…</button></div>
        <p class="muted small">Your name, the time, your IP address and browser are recorded with your signature. The document's fingerprint is <code>${esc((d.doc_hash || "").slice(0, 16))}…</code></p>
      </form></section>` : ""}
    ${me.status === "Signed" && d.status === "Out for signature" ? `<div class="notice-bar ok">${ic("check")}<div>Thanks, you've signed. You'll be able to download the final copy from this link once everyone has signed.</div></div>` : ""}`;
  // exhibits attached as separate files: download through the signing link
  $$("[data-exfile]").forEach((el) => {
    el.insertAdjacentHTML("beforeend", ` <button class="btn small" type="button">${ic("arrow-out")}Download exhibit</button>`);
    $("button", el).addEventListener("click", async () => {
      try {
        const f = await rpc("sign_exhibit", { p_token: token, p_file: +el.dataset.exfile });
        const bin = atob(String(f.data_b64).replace(/^data:[^,]+,/, "")), u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([u8], { type: f.mime || "application/octet-stream" })), l = document.createElement("a");
        l.href = url; l.download = f.name; l.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) { toast(e.message); }
    });
  });
  $("#printIt")?.addEventListener("click", () => {
    const w = window.open("", "_blank"); if (!w) return toast("Allow pop-ups to download");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title><link rel="stylesheet" href="${location.origin + location.pathname.replace(/sign\/?(index\.html)?$/, "")}style.css">
      <style>body{background:#fff;margin:0}.agr-doc{box-shadow:none;border:0;max-width:7.5in;margin:0 auto;padding:.6in .5in}@media print{.agr-doc{padding:0}}</style></head><body><div class="agr-doc">${docHtml(d)}
      <div class="agr-cert"><h2>Signature record</h2><table class="agr-table"><tr><th>Document fingerprint</th><td><code>${esc(d.doc_hash || "")}</code></td></tr>
      ${(d.signers || []).map((s) => `<tr><th>${esc(s.label || s.role)}</th><td>${esc(s.name)} · ${s.status === "Signed" ? "signed " + new Date(s.signed_at).toLocaleString() : esc(s.status)}</td></tr>`).join("")}</table></div></div><script>setTimeout(()=>print(),400)<\/script></body></html>`);
    w.document.close();
  });
  if (!open) return;
  const pad = window.PulseSigPad($("#pad")); pad.setTyped(me.name);
  $("#signForm [name=name]").addEventListener("input", (e) => pad.setTyped(e.target.value));
  $("#signForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target, sig = pad.value();
    if (!f.consent.checked) return toast("Tick the box to agree to sign electronically");
    if (!sig.data) return toast("Add your signature");
    const btn = $("button.primary", f); btn.disabled = true;
    try { const out = await rpc("sign_submit", { p_token: token, p_name: f.name.value, p_title: f.title.value, p_kind: sig.kind, p_data: sig.data, p_consent: true, p_user_agent: navigator.userAgent }); toast("Signed. Thank you"); render(out); window.scrollTo(0, 0); }
    catch (err) { btn.disabled = false; toast(err.message); }
  });
  $("#declineBtn").addEventListener("click", async () => {
    const r = prompt("Tell the sender why you're declining (for example, what needs to change):"); if (!r) return;
    try { await rpc("sign_decline", { p_token: token, p_reason: r }); load(); } catch (err) { toast(err.message); }
  });
}
async function load() {
  if (!sb) { $("#main").innerHTML = `<div class="empty">This site isn't connected yet.</div>`; return; }
  if (!/^[0-9a-f]{20,}$/i.test(token)) { $("#main").innerHTML = `<section class="panel"><h1>Link incomplete</h1><p>Open the full link from your email. If it still doesn't work, ask the sender for a new one.</p></section>`; return; }
  try { render(await rpc("sign_view", { p_token: token })); }
  catch (e) { $("#main").innerHTML = `<section class="panel"><h1>Can't open this agreement</h1><p>${esc(e.message)}</p></section>`; }
}
history.replaceState(null, "", location.pathname + location.hash);   // keep the token out of any later referrers
window.addEventListener("hashchange", () => location.reload());   // a different link pasted into the same tab
load();
