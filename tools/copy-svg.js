/* Sharaf Lab tools: adds a "Copy SVG" button next to every SVG download/export button.
   Copy SVG runs the tool's own export, catches the SVG it produces instead of saving a file,
   and puts it on the clipboard (as an SVG image and as SVG text) so it can be pasted into
   Affinity, Illustrator, PowerPoint, etc. */
(function () {
  "use strict";
  let capture = null, suppress = 0;
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    if (capture && obj instanceof Blob && /svg/i.test(obj.type)) { const c = capture; capture = null; suppress++; c.resolve(obj); }
    return origCreate(obj);
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (suppress && this.download && /\.svg$/i.test(this.download)) { suppress--; return; } // copying, not saving
    return origClick.apply(this, arguments);
  };

  function toast(msg) {
    let t = document.getElementById("copySvgToast");
    if (!t) {
      t = document.createElement("div"); t.id = "copySvgToast"; t.setAttribute("role", "status");
      t.style.cssText = "position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:#102a33;color:#fff;padding:10px 16px;border-radius:8px;font:600 14px Manrope,Arial,sans-serif;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.2);transition:opacity .3s";
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = "1";
    clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.opacity = "0"), 2600);
  }

  function copyFrom(btn) {
    if (btn.disabled) return;
    const got = new Promise((resolve, reject) => {
      capture = { resolve };
      setTimeout(() => { if (capture) { capture = null; reject(new Error("no svg")); } }, 20000);
    });
    btn.click(); // run the tool's own export
    const svgBlob = got.then((b) => new Blob([b], { type: "image/svg+xml" }));
    const textBlob = got.then((b) => b.text()).then((t) => new Blob([t], { type: "text/plain" }));
    const done = () => toast("SVG copied — paste it into your figure.");
    try {
      navigator.clipboard.write([new ClipboardItem({ "image/svg+xml": svgBlob, "text/plain": textBlob })]).then(done).catch(() =>
        got.then((b) => b.text()).then((t) => navigator.clipboard.writeText(t)).then(done).catch(() => toast("Couldn't copy here. Use the download button instead.")));
    } catch (e) {
      got.then((b) => b.text()).then((t) => navigator.clipboard.writeText(t)).then(done).catch(() => toast("Couldn't copy here. Use the download button instead."));
    }
  }

  function addButtons() {
    document.querySelectorAll("button").forEach((btn) => {
      const label = (btn.textContent || "").trim();
      if (btn.dataset.copySvgDone || btn.dataset.copySvg || !/svg/i.test(label) || !/(download|export|save)/i.test(label)) return;
      btn.dataset.copySvgDone = "1";
      const copy = document.createElement("button");
      copy.type = "button"; copy.dataset.copySvg = "1";
      copy.className = btn.className.replace(/\b(primary|topo-primary)\b/g, "").trim();
      copy.textContent = /legend/i.test(label) ? "Copy legend SVG" : "Copy SVG";
      copy.title = "Copy this picture as SVG to paste into another program";
      copy.addEventListener("click", () => copyFrom(btn));
      btn.insertAdjacentElement("afterend", copy);
      const sync = () => { copy.disabled = btn.disabled; copy.hidden = btn.hidden; };
      sync();
      new MutationObserver(sync).observe(btn, { attributes: true, attributeFilter: ["disabled", "hidden"] });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButtons); else addButtons();
})();
