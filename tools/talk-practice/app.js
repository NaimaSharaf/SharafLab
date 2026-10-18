// Talk Practice (Sharaf Lab tools) — PNGs to PowerPoint, plus a practice video for each slide.
// Pick the folder that holds your slide PNGs. Notes and videos are saved into that folder:
//   <your PNG folder>/practice/{practice.json, notes.md, videos/<png name>.mp4}
// Your PNG files are never changed. Plain script (no modules) so it also runs when opened from disk.
(() => {
  const $ = (id) => document.getElementById(id);
  const IMG = /\.(png|jpe?g|gif)$/i;
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const stem = (n) => n.replace(/\.[^.]+$/, "");
  const fmt = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  let slides = [];            // {name, file, url, note, video:{file,seconds,mime}|null, blob}
  let dir = null, pdir = null; // picked folder and its practice/ subfolder (null when PNG files were picked)
  let saveTimer = 0, dragName = null, at = -1, stream = null, rec = null, tick = 0, playUrl = "";

  function tell(t, cls) { const s = $("status"); s.textContent = t || ""; s.className = "tp-status" + (cls ? " " + cls : ""); }

  /* ---------- remembered folder ---------- */
  const dbp = new Promise((res) => { try { const r = indexedDB.open("talk-practice-2", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); } });
  async function kv(k, v) { const db = await dbp; if (!db) return; return new Promise((res) => { try { const tx = db.transaction("kv", v === undefined ? "readonly" : "readwrite"), s = tx.objectStore("kv"), q = v === undefined ? s.get(k) : s.put(v, k); q.onsuccess = () => res(q.result); q.onerror = () => res(); } catch { res(); } }); }

  /* ---------- files ---------- */
  async function write(d, name, data) { const h = await d.getFileHandle(name, { create: true }), w = await h.createWritable(); try { await w.write(data); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; } }
  async function getFile(d, path) { const p = path.split("/"); let x = d; for (const n of p.slice(0, -1)) x = await x.getDirectoryHandle(n); return (await x.getFileHandle(p.at(-1))).getFile(); }
  async function removeFile(d, path) { const p = path.split("/"); let x = d; for (const n of p.slice(0, -1)) x = await x.getDirectoryHandle(n); await x.removeEntry(p.at(-1)); }

  /* ---------- open a folder ---------- */
  async function openFolder(h, ask) {
    let p = await h.queryPermission({ mode: "readwrite" });
    if (p !== "granted") { if (!ask) return false; p = await h.requestPermission({ mode: "readwrite" }); if (p !== "granted") { tell("Folder access was not allowed.", "err"); return false; } }
    await flush(); clear();
    const found = [];
    for await (const [name, e] of h.entries()) if (e.kind === "file" && !name.startsWith(".") && IMG.test(name)) found.push({ name, file: await e.getFile() });
    if (!found.length) { tell(`No PNG, JPG or GIF images were found in “${h.name}”.`, "err"); return false; }
    dir = h; pdir = await h.getDirectoryHandle("practice", { create: true });
    let saved = {}; try { saved = JSON.parse(await (await getFile(pdir, "practice.json")).text()); } catch {}
    const info = saved.slides || {}, order = saved.order || [];
    const rank = (n) => { const i = order.indexOf(n); return i < 0 ? Infinity : i; };
    found.sort((a, b) => rank(a.name) - rank(b.name) || byName(a.name, b.name));
    slides = found.map((f) => ({ name: f.name, file: f.file, url: URL.createObjectURL(f.file), note: (info[f.name] || {}).note || "", video: (info[f.name] || {}).video || null }));
    // forget videos that were deleted from the folder by hand
    for (const s of slides) if (s.video) { try { await getFile(pdir, s.video.file); } catch { s.video = null; } }
    if (saved.title) $("outName").value = saved.title; else $("outName").value = h.name;
    await kv("root", h); $("reconnect").hidden = true;
    $("where").textContent = "Folder: " + h.name;
    render();
    const nv = slides.filter((s) => s.video).length;
    tell(`Opened “${h.name}”: ${slides.length} slide${slides.length > 1 ? "s" : ""}${nv ? `, ${nv} with a video` : ""}. Notes and videos save into its “practice” folder.`, "ok");
    return true;
  }
  $("pickDir").onclick = async () => {
    if (!window.showDirectoryPicker) { tell("Choosing a folder needs Chrome or Edge. Use “Pick PNG files instead” (notes and videos then are not saved; download them).", "err"); return; }
    try { await openFolder(await window.showDirectoryPicker({ id: "talk-practice", mode: "readwrite" }), true); }
    catch (e) { if (e.name === "AbortError") return; tell(e.name === "SecurityError" ? "This page cannot open a folder here because it is shown inside another site. Use “Pick PNG files instead”, or open the tool on the lab website." : "That folder could not be opened: " + e.message, "err"); }
  };
  $("reconnect").onclick = async () => { try { const h = await kv("root"); if (h) await openFolder(h, true); } catch (e) { tell(e.message, "err"); } };
  $("pickFiles").onclick = () => $("fileIn").click();
  $("fileIn").onchange = async () => {
    const files = [...$("fileIn").files].filter((f) => !f.name.startsWith(".") && IMG.test(f.name)).sort((a, b) => byName(a.name, b.name)); $("fileIn").value = "";
    if (!files.length) return;
    await flush(); clear();
    slides = files.map((f) => ({ name: f.name, file: f, url: URL.createObjectURL(f), note: "", video: null }));
    $("where").textContent = "Files picked (not saved to a folder)"; render();
    tell("Notes and videos are only kept until you close this page in this mode. Download videos with ⤓ and the PowerPoint keeps your notes, or choose a folder to save everything.", "err");
  };
  function clear() { for (const s of slides) URL.revokeObjectURL(s.url); slides = []; dir = pdir = null; }

  /* ---------- cards ---------- */
  function render() {
    const list = $("list"); list.innerHTML = "";
    slides.forEach((s, i) => {
      const li = document.createElement("li"); li.className = "tp-card"; li.draggable = true;
      li.innerHTML = `<img class="pic" alt="Slide ${i + 1}" title="Open slide ${i + 1} to practice">
        <div class="tp-meta"><span class="tp-num">${i + 1}</span><span class="tp-name"></span>
        <button type="button" data-a="up" title="Move earlier"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" data-a="down" title="Move later"${i === slides.length - 1 ? " disabled" : ""}>↓</button></div>
        <textarea rows="3" placeholder="Notes: what you'll say on this slide" aria-label="Notes for slide ${i + 1}"></textarea>
        <div class="tp-vid"><button type="button" class="recb" data-a="rec">● Record</button><span class="vs"></span></div>`;
      li.querySelector("img").src = s.url; li.querySelector(".tp-name").textContent = s.name; li.querySelector(".tp-name").title = s.name;
      li.querySelector(".vs").innerHTML = s.video ? `<span class="has">Video ${fmt(s.video.seconds)}</span> <button type="button" data-a="play">▶ Play</button>` : "No video yet";
      li.querySelector("img").onclick = () => openModal(i);
      li.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => {
        const a = b.dataset.a;
        if (a === "rec") openModal(i, true); else if (a === "play") openModal(i, false, true);
        else { const j = a === "up" ? i - 1 : i + 1; [slides[i], slides[j]] = [slides[j], slides[i]]; render(); changed(); }
      }));
      const ta = li.querySelector("textarea"); ta.value = s.note;
      ta.oninput = () => { s.note = ta.value; changed(); };
      ta.onfocus = () => (li.draggable = false); ta.onblur = () => (li.draggable = true);
      li.addEventListener("dragstart", (e) => { dragName = s.name; li.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.name); });
      li.addEventListener("dragend", () => { dragName = null; render(); });
      li.addEventListener("dragover", (e) => { if (dragName == null) return; e.preventDefault(); li.classList.add("over"); });
      li.addEventListener("dragleave", () => li.classList.remove("over"));
      li.addEventListener("drop", (e) => { if (dragName == null) return; e.preventDefault(); const from = slides.findIndex((x) => x.name === dragName); if (from !== i) { const [m] = slides.splice(from, 1); slides.splice(i, 0, m); changed(); } dragName = null; render(); });
      list.appendChild(li);
    });
    $("empty").hidden = slides.length > 0;
    const nv = slides.filter((s) => s.video).length;
    $("count").textContent = slides.length ? `${slides.length} slide${slides.length === 1 ? "" : "s"} · ${nv} video${nv === 1 ? "" : "s"}` : "Slides";
    ["make", "sortAZ", "practice"].forEach((id) => ($(id).disabled = !slides.length));
    $("run").disabled = !nv;
  }
  $("sortAZ").onclick = () => { slides.sort((a, b) => byName(a.name, b.name)); render(); changed(); };
  $("practice").onclick = () => openModal(0);

  /* ---------- saving into <folder>/practice ---------- */
  function markdown() {
    const out = [`# ${$("outName").value || "Practice"}`, ""];
    slides.forEach((s, i) => {
      out.push(`## Slide ${i + 1}: ${s.name}`, "", `![Slide ${i + 1}](../${encodeURI(s.name)})`, "");
      if (s.note.trim()) out.push("> " + s.note.trim().replace(/\n/g, "\n> "), "");
      if (s.video) out.push(`Video: [${s.video.file}](${encodeURI(s.video.file)}) (${fmt(s.video.seconds)})`, "");
    });
    return out.join("\n");
  }
  function changed(now) { if (!pdir) return; tell("Saving…"); clearTimeout(saveTimer); saveTimer = setTimeout(save, now ? 50 : 600); }
  async function save() {
    clearTimeout(saveTimer); saveTimer = 0; if (!pdir) return;
    const data = { version: 1, title: $("outName").value, updated: new Date().toISOString(), order: slides.map((s) => s.name), slides: {} };
    for (const s of slides) data.slides[s.name] = { note: s.note, video: s.video };
    try { await write(pdir, "practice.json", JSON.stringify(data, null, 2)); await write(pdir, "notes.md", markdown()); tell("Saved " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), "ok"); }
    catch (e) { tell("Not saved (" + e.message + "). Click “Reopen last folder”.", "err"); $("reconnect").hidden = false; }
  }
  async function flush() { if (saveTimer) await save(); }
  $("outName").oninput = () => changed();
  addEventListener("pagehide", () => { if (saveTimer) save(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) save(); });
  addEventListener("beforeunload", (e) => { if (rec || (!pdir && slides.some((s) => s.blob))) { e.preventDefault(); e.returnValue = ""; } });

  /* ---------- practice window: slide + camera + notes ---------- */
  const vid = $("mVid");
  const MIMES = ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  async function camOn() {
    if (stream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $("mOff").textContent = "This browser cannot use the camera."; return false; }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } }); return true; }
    catch (e) { $("mOff").textContent = "Camera or microphone not available (" + e.message + "). Allow them in the address bar, then close and reopen."; $("mOff").hidden = false; return false; }
  }
  function camOff() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }
  function live() {
    if (playUrl) { vid.pause(); vid.removeAttribute("src"); vid.load(); URL.revokeObjectURL(playUrl); playUrl = ""; }
    vid.controls = false; vid.muted = true; $("mLive").hidden = true;
    if (stream) { vid.srcObject = stream; vid.classList.add("live"); vid.play().catch(() => {}); $("mOff").hidden = true; }
    else { vid.srcObject = null; $("mOff").hidden = false; }
  }
  async function openModal(i, startRec, playIt) {
    $("modal").hidden = false; document.body.style.overflow = "hidden"; show(i);
    $("mOff").textContent = "Starting camera…"; $("mOff").hidden = false;
    const ok = await camOn(); if ($("modal").hidden) return; live();
    if (playIt) play(); else if (startRec && ok) startRecording();
  }
  function show(i) {
    if (rec) return; at = Math.max(0, Math.min(i, slides.length - 1)); const s = slides[at];
    $("mImg").src = s.url; $("mImg").alt = "Slide " + (at + 1);
    $("mTitle").textContent = `Slide ${at + 1} of ${slides.length} · ${s.name}`;
    $("mNote").value = s.note; $("mPrev").disabled = at === 0; $("mNext").disabled = at === slides.length - 1;
    const has = !!s.video; $("mPlay").hidden = $("mDel").hidden = $("mDl").hidden = !has;
    $("mRec").textContent = has ? "● Re-record" : "● Record";
    if (stream) live();
  }
  function closeModal() {
    if (rec) { rec.onstop = null; rec.stop(); rec = null; clearInterval(tick); if (comp) { comp.stop(); comp = null; } setRec(false); tell("Recording cancelled.", "err"); }
    live(); camOff(); vid.srcObject = null; $("modal").hidden = true; document.body.style.overflow = ""; render();
  }
  $("mClose").onclick = closeModal;
  $("mPrev").onclick = () => show(at - 1); $("mNext").onclick = () => show(at + 1);
  $("mNote").oninput = () => { slides[at].note = $("mNote").value; changed(); };
  $("mLive").onclick = live;
  addEventListener("keydown", (e) => {
    if (!$("runModal").hidden) { runKeys(e); return; }
    if ($("modal").hidden) return;
    if (e.key === "Escape") { closeModal(); return; }
    if (e.target.closest("textarea,input,select")) return;
    if (e.key === "ArrowLeft") show(at - 1); if (e.key === "ArrowRight") show(at + 1);
    if (e.key === "r" || e.key === "R") { e.preventDefault(); $("mRec").click(); }
  });

  try { if (localStorage.tpMode) $("mMode").value = localStorage.tpMode; } catch {}
  $("mMode").onchange = () => { try { localStorage.tpMode = $("mMode").value; } catch {} };
  // "slide + me": draw the slide with the camera in the bottom-right corner onto a canvas and record that
  let comp = null;
  function startComposite(slideUrl) {
    const W = 1280, H = 720, c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d"), img = new Image(), cam = document.createElement("video");
    img.src = slideUrl; cam.srcObject = stream; cam.muted = true; cam.playsInline = true; cam.play().catch(() => {});
    const draw = () => {
      x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
      if (img.naturalWidth) { const k = Math.min(W / img.naturalWidth, H / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k; x.drawImage(img, (W - w) / 2, (H - h) / 2, w, h); }
      if (cam.readyState >= 2 && cam.videoWidth) {
        const cw = W * 0.26, ch = cw * cam.videoHeight / cam.videoWidth, px = W - cw - 24, py = H - ch - 24;
        x.save(); x.shadowColor = "rgba(0,0,0,.35)"; x.shadowBlur = 16; x.fillStyle = "#000"; x.beginPath(); x.roundRect(px, py, cw, ch, 14); x.fill(); x.restore();
        x.save(); x.beginPath(); x.roundRect(px, py, cw, ch, 14); x.clip(); x.drawImage(cam, px, py, cw, ch); x.restore();
      }
    };
    draw(); const iv = setInterval(draw, 1000 / 30);
    const out = c.captureStream(30); stream.getAudioTracks().forEach((t) => out.addTrack(t));
    return { stream: out, stop() { clearInterval(iv); out.getVideoTracks().forEach((t) => t.stop()); cam.srcObject = null; } };
  }
  $("mRec").onclick = () => (rec ? rec.stop() : startRecording());
  async function startRecording() {
    if (!(await camOn())) return; live();
    const s = slides[at];
    if (s.video && !confirm(`Replace the video for slide ${at + 1}?`)) return;
    const m = window.MediaRecorder ? MIMES.find((x) => MediaRecorder.isTypeSupported(x)) || "" : "";
    const mode = $("mMode").value;
    let src = stream;
    if (mode === "overlay") { comp = startComposite(s.url); src = comp.stream; vid.srcObject = src; vid.classList.remove("live"); vid.play().catch(() => {}); }
    try { rec = new MediaRecorder(src, m ? { mimeType: m } : undefined); } catch (e) { if (comp) { comp.stop(); comp = null; } live(); tell("Recording is not supported here: " + e.message, "err"); return; }
    const chunks = [], started = Date.now(), mime = rec.mimeType || m || "video/webm";
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => { clearInterval(tick); rec = null; if (comp) { comp.stop(); comp = null; } live(); setRec(false); saveVideo(s, new Blob(chunks, { type: mime }), (Date.now() - started) / 1000, mode); };
    rec.start(1000); setRec(true);
    const limit = +$("limit").value;
    tick = setInterval(() => { const t = (Date.now() - started) / 1000; $("mTimer").textContent = fmt(t) + (limit ? " / " + fmt(limit) : ""); if (limit && t >= limit && rec) rec.stop(); }, 250);
  }
  function setRec(on) {
    $("mRec").textContent = on ? "■ Stop" : slides[at] && slides[at].video ? "● Re-record" : "● Record"; $("mRec").classList.toggle("stop", on);
    $("mCam").classList.toggle("recording", on); ["mPrev", "mNext", "mPlay", "mDel", "mDl", "mMode"].forEach((id) => ($(id).disabled = on));
    if (on) { $("mPrev").disabled = true; $("mNext").disabled = true; } else { $("mTimer").textContent = ""; $("mPrev").disabled = at === 0; $("mNext").disabled = at === slides.length - 1; }
  }
  async function saveVideo(s, blob, seconds, mode) {
    const ext = /mp4/.test(blob.type) ? "mp4" : "webm", file = "videos/" + stem(s.name) + "." + ext;
    try {
      if (pdir) {
        if (s.video && s.video.file !== file) await removeFile(pdir, s.video.file).catch(() => {});
        const vd = await pdir.getDirectoryHandle("videos", { create: true }); await write(vd, stem(s.name) + "." + ext, blob);
      } else s.blob = blob;
      s.video = { file, seconds: Math.round(seconds), mime: blob.type, mode: mode || "camera", recorded: new Date().toISOString() };
      changed(true); if (slides[at] === s) show(at);
      tell(`Saved the ${fmt(seconds)} video for ${s.name}${pdir ? " in practice/" + file : " (download it with ⤓)"}.`, "ok");
    } catch (e) { tell("Could not save the video: " + e.message, "err"); }
  }
  async function videoBlob(s) { return pdir ? getFile(pdir, s.video.file) : s.blob; }
  async function play() {
    const s = slides[at]; if (!s.video || rec) return;
    try { const b = await videoBlob(s); live(); vid.srcObject = null; vid.classList.remove("live"); playUrl = URL.createObjectURL(b); vid.src = playUrl; vid.muted = false; vid.controls = true; $("mOff").hidden = true; $("mLive").hidden = !stream; await vid.play().catch(() => {}); }
    catch (e) { tell("Could not open that video: " + e.message, "err"); }
  }
  $("mPlay").onclick = play;
  $("mDl").onclick = async () => { const s = slides[at]; if (!s.video) return; const a = document.createElement("a"); a.href = URL.createObjectURL(await videoBlob(s)); a.download = s.video.file.split("/")[1]; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
  $("mDel").onclick = async () => { const s = slides[at]; if (!s.video || !confirm(`Delete the video for slide ${at + 1}?`)) return; live(); if (pdir) await removeFile(pdir, s.video.file).catch(() => {}); s.video = null; s.blob = null; changed(true); show(at); };

  /* ---------- full run-through: every slide in order, playing its video ---------- */
  const rVid = $("rVid"), NOVID = 3; // seconds to show a slide that has no video
  let ri = 0, rUrl = "", rTimer = 0, rPaused = false, rToken = 0;
  function runOpen() {
    if (!slides.some((s) => s.video)) return;
    $("runModal").hidden = false; document.body.style.overflow = "hidden"; rPaused = false;
    try { $("rNotes").checked = localStorage.tpRunNotes === "1"; } catch {}
    runShow(0);
  }
  function runStop() { clearTimeout(rTimer); rTimer = 0; rVid.pause(); rVid.onended = null; rVid.removeAttribute("src"); rVid.load(); if (rUrl) { URL.revokeObjectURL(rUrl); rUrl = ""; } }
  async function runShow(i) {
    runStop(); const token = ++rToken;
    if (i >= slides.length) { ri = slides.length; $("rMsg").textContent = "End of run-through · " + fmt(slides.reduce((t, s) => t + (s.video ? s.video.seconds : 0), 0)) + " of video"; $("rPause").textContent = "↺ Start again"; rPaused = true; $("rNext").disabled = true; return; }
    ri = Math.max(0, i); const s = slides[ri];
    $("rImg").src = s.url; $("rImg").alt = "Slide " + (ri + 1);
    $("rPos").textContent = `Slide ${ri + 1} of ${slides.length}`; $("rPrev").disabled = ri === 0; $("rNext").disabled = false;
    $("rNote").textContent = s.note || "No notes for this slide."; $("rNote").hidden = !$("rNotes").checked;
    $("rPause").textContent = rPaused ? "▶ Play" : "⏸ Pause";
    $("rStage").classList.toggle("full", !!(s.video && s.video.mode === "overlay"));
    if (s.video) {
      $("rMsg").textContent = ""; rVid.hidden = false;
      try { const b = await videoBlob(s); if (token !== rToken) return; rUrl = URL.createObjectURL(b); rVid.src = rUrl; rVid.onended = () => runShow(ri + 1); if (!rPaused) rVid.play().catch(() => {}); }
      catch { rVid.hidden = true; $("rMsg").textContent = "This slide's video could not be opened"; if (!rPaused) rTimer = setTimeout(() => runShow(ri + 1), NOVID * 1000); }
    } else { rVid.hidden = true; $("rMsg").textContent = "No video for this slide"; if (!rPaused) rTimer = setTimeout(() => runShow(ri + 1), NOVID * 1000); }
  }
  function runToggle() {
    if (ri >= slides.length) { rPaused = false; runShow(0); return; }
    rPaused = !rPaused; $("rPause").textContent = rPaused ? "▶ Play" : "⏸ Pause";
    const s = slides[ri];
    if (s.video && rUrl) { rPaused ? rVid.pause() : rVid.play().catch(() => {}); }
    else { clearTimeout(rTimer); if (!rPaused) rTimer = setTimeout(() => runShow(ri + 1), NOVID * 1000); }
  }
  function runClose() { runStop(); ++rToken; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); $("runModal").hidden = true; document.body.style.overflow = ""; }
  function runKeys(e) {
    if (e.key === "Escape" && !document.fullscreenElement) runClose();
    else if (e.key === " ") { e.preventDefault(); runToggle(); }
    else if (e.key === "ArrowRight") runShow(ri + 1); else if (e.key === "ArrowLeft") runShow(Math.min(ri, slides.length) - 1);
  }
  $("run").onclick = runOpen; $("rClose").onclick = runClose; $("rPause").onclick = runToggle;
  $("rNext").onclick = () => runShow(ri + 1); $("rPrev").onclick = () => runShow(Math.min(ri, slides.length) - 1);
  $("rNotes").onchange = () => { $("rNote").hidden = !$("rNotes").checked; try { localStorage.tpRunNotes = $("rNotes").checked ? "1" : "0"; } catch {} };
  $("rFull").onclick = () => { const st = $("rStage"); if (document.fullscreenElement) document.exitFullscreen(); else if (st.requestFullscreen) st.requestFullscreen().catch(() => {}); };

  /* ---------- PowerPoint (same layout as PNGs to PowerPoint) ---------- */
  const SIZES = { "16x9": [13.333, 7.5], "4x3": [10, 7.5], "7x4": [7, 4] };
  const dataUrl = (b) => new Promise((r, j) => { const f = new FileReader(); f.onload = () => r(f.result); f.onerror = j; f.readAsDataURL(b); });
  const dims = (url) => new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r([1600, 900]); i.src = url; });
  $("make").onclick = async () => {
    if (!slides.length) return;
    if (!window.PptxGenJS) { tell("The PowerPoint engine did not load. Reload the page and try again.", "err"); return; }
    const [W, H] = SIZES[$("size").value], M = 0.25, addVid = $("addVid").checked, b = $("make");
    b.disabled = true; b.textContent = "Building…";
    try {
      const pptx = new PptxGenJS(); pptx.defineLayout({ name: "TP", width: W, height: H }); pptx.layout = "TP";
      let skipped = 0;
      for (const s of slides) {
        const sl = pptx.addSlide(), [pw, ph] = await dims(s.url), k = Math.min((W - 2 * M) / pw, (H - 2 * M) / ph), w = pw * k, h = ph * k;
        sl.addImage({ data: await dataUrl(s.file), x: (W - w) / 2, y: (H - h) / 2, w, h, altText: s.name });
        if (s.note.trim()) sl.addNotes(s.note.trim());
        if (addVid && s.video) {
          if (!/mp4/.test(s.video.mime || s.video.file)) { skipped++; continue; }
          const vw = W * 0.24, vh = vw * 9 / 16, d = await dataUrl(await videoBlob(s));
          sl.addMedia({ type: "video", data: d.replace(/^data:/, ""), x: W - vw - 0.1, y: H - vh - 0.1, w: vw, h: vh });
        }
      }
      const name = (($("outName").value || "practice").trim().replace(/\.pptx$/i, "").replace(/[\\/:*?"<>|]+/g, "-") || "practice") + ".pptx";
      await pptx.writeFile({ fileName: name });
      tell(`${name} downloaded (${slides.length} slides${addVid ? ", with videos" : ""}).` + (skipped ? ` ${skipped} video(s) were WebM and could not go into PowerPoint.` : ""), "ok");
    } catch (e) { console.error(e); tell("The PowerPoint file could not be made. " + (e && e.message ? e.message : ""), "err"); }
    finally { b.disabled = false; b.textContent = "Download PowerPoint →"; }
  };

  /* ---------- start: reopen the last folder if Chrome still allows it ---------- */
  render();
  (async () => {
    if (!window.showDirectoryPicker) return;
    const h = await kv("root"); if (!h) return;
    try { if (await openFolder(h, false)) return; } catch {}
    $("reconnect").hidden = false; $("reconnect").textContent = `Reopen “${h.name}”`;
  })();
})();
