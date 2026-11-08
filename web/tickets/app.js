/* Pulse · Tickets — router and start-up. Pages live in desk.js; helpers and sign-in in ../core.js. */
"use strict";

const routes = { requests: DeskRequests, approvals: DeskApprovals, assets: DeskAssets };
window.addEventListener("hashchange", route);
function route() {
  if (!S.profile) return;
  const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const [name = "requests"] = path.split("/");
  const preset = new URLSearchParams(qs || "").get("new");   // links like #/requests?new=Time%20off open that request form
  $$("#nav a[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === (routes[name] ? name : "requests")));
  document.body.classList.remove("nav-open");
  closeDrawer();
  const main = $("#main");
  main.innerHTML = `<p class="muted">Loading…</p>`;
  Promise.resolve((routes[name] || DeskRequests)()).then(() => {
    if (preset && DESK_TYPE[preset]) { history.replaceState(null, "", "#/" + (routes[name] ? name : "requests")); openNewRequest({ type: preset }); }
  }).catch((e) => (main.innerHTML = deskMissing(e) ? deskSetupNotice() : `<div class="empty">Couldn't load this page: ${esc(e.message)}</div>`));
  main.focus({ preventScroll: true });
}

async function boot() {
  if (!sb) { $("#setup").hidden = false; return; }
  try {
    if (!(await requireMember())) return;
    showShell();
    route();
  } catch (e) { showShell(); $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
boot();
