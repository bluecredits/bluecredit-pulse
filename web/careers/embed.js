/* Pulse careers widget. Put this where the jobs should appear on your own website:
   <script src="https://pulse.bluecredits.org/careers/embed.js" data-company="your-address" async></script>
   It shows your open positions from Pulse and stays up to date; Apply opens the Pulse apply page in a new tab. */
(function () {
  var s = document.currentScript; if (!s) return;
  var c = s.getAttribute("data-company") || "";
  var f = document.createElement("iframe");
  f.src = new URL("./?embed=1&c=" + encodeURIComponent(c), s.src).href;
  f.title = "Open positions"; f.loading = "lazy";
  f.style.cssText = "display:block;width:100%;min-height:240px;border:0;background:transparent";
  s.parentNode.insertBefore(f, s.nextSibling);
  window.addEventListener("message", function (e) {
    if (e.source === f.contentWindow && e.data && e.data.height) f.style.height = Math.ceil(e.data.height) + "px";
  });
})();
