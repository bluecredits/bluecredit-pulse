/* Pulse · public careers page: careers/?c=<company address>. No sign-in. Lists the company's open openings
   (hire_careers_public); each links to its apply page. Add &embed=1 for the version shown inside a company's own
   website (no page chrome; links open in a new tab; tells the parent page its height so the frame fits). */
"use strict";
window.onAuthLost = () => {};
const qs = new URLSearchParams(location.search), slug = (qs.get("c") || "").trim().toLowerCase(), embed = qs.get("embed") === "1";
if (embed) document.body.classList.add("embed");

function fit() { if (embed && parent !== window) parent.postMessage({ pulseCareers: slug, height: document.documentElement.scrollHeight }, "*"); }
new ResizeObserver(fit).observe(document.body);

async function load() {
  const main = $("#main");
  if (!sb) { main.innerHTML = `<div class="empty">This site isn't set up yet.</div>`; return; }
  let d = null;
  try { if (slug) d = must(await sb.rpc("hire_careers_public", { p_slug: slug })); } catch { d = null; }
  if (!d) { main.innerHTML = `<section class="panel apply-card"><h1>Careers page not found</h1><p class="muted">This careers page isn't available. Check the address you were given.</p></section>`; return; }
  const target = embed ? ` target="_blank" rel="noopener"` : "";
  const meta = (o) => esc([...new Set([o.kind, o.schedule, o.remote, o.location].filter(Boolean))].join(" · "));
  if (!embed) document.title = `Careers · ${d.company}`;
  main.innerHTML = `
    ${embed ? "" : `<header class="careers-head">${d.logo_url ? `<img src="${esc(d.logo_url)}" alt="">` : ""}<div><p class="apply-co">${esc(d.company)}</p><h1>Open positions</h1></div></header>`}
    ${d.openings.length ? `<div class="careers-list">${d.openings.map((o) => `
      <a class="panel careers-job" href="../apply/?t=${encodeURIComponent(o.token)}"${target}>
        <div><h2>${esc(o.title)}</h2><p class="muted">${meta(o)}${o.pay ? ` · ${esc(o.pay)}` : ""}</p>${o.summary ? `<p class="careers-sum">${esc(o.summary)}${o.summary.length >= 220 ? "…" : ""}</p>` : ""}</div>
        <span class="btn primary small">View and apply</span></a>`).join("")}</div>`
      : `<section class="panel apply-card"><p><b>No open positions right now.</b></p><p class="muted">Please check back later.</p></section>`}`;
  // let search engines list the jobs (Google for Jobs) on the full page
  if (!embed && d.openings.length) {
    const ld = document.createElement("script"); ld.type = "application/ld+json";
    ld.textContent = JSON.stringify(d.openings.map((o) => ({ "@context": "https://schema.org", "@type": "JobPosting", title: o.title, description: o.summary || o.title,
      datePosted: o.posted, hiringOrganization: { "@type": "Organization", name: d.company }, employmentType: { "Full-time": "FULL_TIME", "Part-time": "PART_TIME" }[o.schedule] || (o.kind === "Contractor" || o.kind === "Consultant" ? "CONTRACTOR" : o.kind === "Intern" ? "INTERN" : "OTHER"),
      ...(o.remote === "Remote" ? { jobLocationType: "TELECOMMUTE" } : {}), ...(o.location ? { jobLocation: { "@type": "Place", address: o.location } } : {}),
      url: new URL("../apply/?t=" + o.token, location.href).href })));
    document.head.appendChild(ld);
  }
  fit();
}
load();
