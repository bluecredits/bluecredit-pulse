/* Pulse · signature pad — type or draw a signature. Shared by the Agreements app and the public signing page. */
"use strict";
function sigPad(container) {
  container.innerHTML = `<div class="tabs" role="tablist"><button type="button" data-mode="typed" aria-selected="true">Type</button><button type="button" data-mode="drawn" aria-selected="false">Draw</button></div>
    <div class="sig-typed"><input class="sig-input" placeholder="Type your signature" aria-label="Typed signature"><div class="sig-preview agr-typed"></div></div>
    <div class="sig-drawn" hidden><canvas width="520" height="150" aria-label="Draw your signature"></canvas><button type="button" class="link sig-clear">Clear</button></div>`;
  let mode = "typed", inked = false;
  const cv = container.querySelector("canvas"), ctx = cv.getContext("2d");
  ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.strokeStyle = "#0f172a";
  let drawing = false;
  const pos = (e) => { const r = cv.getBoundingClientRect(), t = e.touches?.[0] || e; return [(t.clientX - r.left) * cv.width / r.width, (t.clientY - r.top) * cv.height / r.height]; };
  const start = (e) => { drawing = true; inked = true; ctx.beginPath(); ctx.moveTo(...pos(e)); e.preventDefault(); };
  const move = (e) => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); e.preventDefault(); };
  const stop = () => (drawing = false);
  cv.addEventListener("pointerdown", start); cv.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  container.querySelector(".sig-clear").addEventListener("click", () => { ctx.clearRect(0, 0, cv.width, cv.height); inked = false; });
  container.querySelector(".sig-input").addEventListener("input", (e) => (container.querySelector(".sig-preview").textContent = e.target.value));
  [...container.querySelectorAll("[data-mode]")].forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode; [...container.querySelectorAll("[data-mode]")].forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    container.querySelector(".sig-typed").hidden = mode !== "typed"; container.querySelector(".sig-drawn").hidden = mode !== "drawn";
  }));
  return { value: () => mode === "typed" ? { kind: "typed", data: container.querySelector(".sig-input").value.trim() } : { kind: "drawn", data: inked ? cv.toDataURL("image/png") : "" }, setTyped: (t) => { container.querySelector(".sig-input").value = t; container.querySelector(".sig-preview").textContent = t; } };
}
window.PulseSigPad = sigPad;
