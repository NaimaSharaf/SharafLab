/* Sharaf Lab colour palette, shared by all the tools.
   Every colour picker on the page offers these colours (Chrome shows them in the picker's drop-down). */
(function () {
  "use strict";
  var PALETTE = ["#000000", "#515151", "#929292", "#ffffff", "#151549", "#564087", "#ababbb", "#4e9d9c", "#8dcd7b", "#efe75a", "#f19737", "#b24434", "#c6327c"];
  window.SHARAF_PALETTE = PALETTE;
  function attach(root) {
    if (root.matches && root.matches("input[type=color]") && !root.hasAttribute("list")) root.setAttribute("list", "sharafPalette");
    if (root.querySelectorAll) root.querySelectorAll("input[type=color]:not([list])").forEach(function (i) { i.setAttribute("list", "sharafPalette"); });
  }
  function init() {
    if (!document.getElementById("sharafPalette")) {
      var dl = document.createElement("datalist");
      dl.id = "sharafPalette";
      PALETTE.forEach(function (c) { var o = document.createElement("option"); o.value = c; dl.appendChild(o); });
      document.body.appendChild(dl);
    }
    attach(document);
    new MutationObserver(function (ms) { ms.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) attach(n); }); }); })
      .observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
