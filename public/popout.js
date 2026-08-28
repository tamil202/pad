// ===========================================================================
// Pen Pad — pop-out note pad (Document Picture-in-Picture)
// ===========================================================================
// A small always-on-top window (like Spotify's mini-player). While another tab
// has focus, you jot pen notes here. The note SAVES automatically as you write
// (debounced), and Claude reads it only when you press "Extract now" — the
// composited canvas (ink + any dropped image) is sent so questions in the image
// get answered too. The extracted text/answer shows in the notes area and is
// stored in the database. No repeated Claude calls: extraction is on demand.
//
// Runs in the OPENER document. The PiP window is a SEPARATE document, but the
// render.js draw helpers (drawStroke/drawStrokePartial/drawAllStrokes) are plain
// globals that take a ctx, so we drive the pop-out canvas straight from here —
// no scripts or app state need to live in the PiP window.
(function () {
  const popoutBtn = document.getElementById("popoutBtn");
  if (!popoutBtn) return;

  // Document PiP only exists in a SECURE CONTEXT (https or localhost). On the
  // Pi's plain-HTTP LAN deploy the API is simply absent, so gate on both.
  const SUPPORTED = "documentPictureInPicture" in window && window.isSecureContext;

  // Backing-store geometry of the mini sheet — the resolution Claude reads.
  const PW = 640, PH = 760;
  const SAVE_MS = 1500; // debounce: save this long after the last stroke (no Claude call)

  let pip = null;                 // the PiP Window
  let pcanvas = null, pctx = null;
  let pstrokes = [];
  let pgesture = null;
  let pageId = null;              // server page id for this note session
  let dirty = false;             // strokes changed since last successful save
  let saving = false;
  let saveTimer = null;
  let pcolor = "#111111";
  let statusEl = null, notesEl = null;
  let pbgData = null, pbgEl = null; // dropped background image to trace over

  const puid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(16).slice(2));
  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
  function setBtnActive(on) { popoutBtn.classList.toggle("active", on); }

  popoutBtn.addEventListener("click", async () => {
    if (pip) { try { pip.focus(); } catch {} return; }
    if (!SUPPORTED) {
      const why = window.isSecureContext
        ? "this browser doesn't support Document Picture-in-Picture (use Chrome or Edge)."
        : "the pop-out needs a secure context — open the app via https or http://localhost.";
      window.alert("The pop-out note pad isn't available: " + why);
      return;
    }
    try {
      pip = await documentPictureInPicture.requestWindow({ width: 380, height: 580 });
    } catch (e) {
      console.error("Pop-out open failed:", e);
      return;
    }
    buildPopout();
    setBtnActive(true);
    pip.addEventListener("pagehide", teardown, { once: true });
  });

  function buildPopout() {
    const d = pip.document;
    d.documentElement.lang = "en";
    d.body.innerHTML = "";
    const style = d.createElement("style");
    style.textContent = POP_CSS;
    d.head.appendChild(style);
    d.title = "Quick notes — Pen Pad";

    const wrap = d.createElement("div");
    wrap.className = "pop";
    wrap.innerHTML = POP_HTML;
    d.body.appendChild(wrap);

    pcanvas = d.querySelector("#pcanvas");
    pcanvas.width = PW;
    pcanvas.height = PH;
    pctx = pcanvas.getContext("2d");
    statusEl = d.querySelector("#pstatus");
    notesEl = d.querySelector("#pnotes");

    d.querySelectorAll(".psw").forEach((b) =>
      b.addEventListener("click", () => {
        pcolor = b.dataset.c;
        d.querySelectorAll(".psw").forEach((x) => x.classList.toggle("on", x === b));
      })
    );
    d.querySelector("#pclear").addEventListener("click", clearNote);
    d.querySelector("#pextract").addEventListener("click", extractNow);

    wirePointer();
    wireDrop();
    redrawPop();
    setStatus("Write a note — it saves automatically. Press Extract to read it with Claude.");
  }

  function wirePointer() {
    pcanvas.style.touchAction = "none";
    pcanvas.addEventListener("pointerdown", (e) => {
      try { pcanvas.setPointerCapture(e.pointerId); } catch {}
      const s = { id: puid(), tool: "pen", color: pcolor, baseWidth: 3, points: [ppoint(e)] };
      pstrokes.push(s);
      pgesture = { drawn: 1 };
      drawStroke(pctx, s);
    });
    pcanvas.addEventListener("pointermove", (e) => {
      if (!pgesture) return;
      const s = pstrokes[pstrokes.length - 1];
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (evs.length) { for (const ev of evs) s.points.push(ppoint(ev)); }
      else s.points.push(ppoint(e));
      drawStrokePartial(pctx, s, s.points.length, pgesture.drawn);
      pgesture.drawn = s.points.length;
    });
    const end = () => {
      if (!pgesture) return;
      pgesture = null;
      dirty = true;
      scheduleSave();
    };
    ["pointerup", "pointercancel", "pointerleave"].forEach((t) => pcanvas.addEventListener(t, end));
  }

  // Map a pointer event (in the PiP window's coordinate space) to backing-store
  // page coordinates, clamped to the sheet.
  function ppoint(e) {
    const r = pcanvas.getBoundingClientRect();
    const sx = pcanvas.width / r.width;
    const sy = pcanvas.height / r.height;
    return {
      x: Math.min(pcanvas.width, Math.max(0, (e.clientX - r.left) * sx)),
      y: Math.min(pcanvas.height, Math.max(0, (e.clientY - r.top) * sy)),
      pressure: e.pressure != null ? e.pressure : 0.5,
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
      t: 0,
    };
  }

  function redrawPop() { drawAllStrokes(pctx, pstrokes, PW, PH, "blank", pbgEl); }

  // Drop an image onto the pop-out to trace over it (stored with the note; not
  // sent to Claude). Downscaled so the saved data URL stays small.
  function setPBg(url) {
    pbgData = url || null;
    if (!url) { pbgEl = null; redrawPop(); return; }
    const im = new Image();
    im.onload = () => { pbgEl = im; redrawPop(); };
    im.src = url;
  }

  function readScaledImage(file, maxDim, cb) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const oc = document.createElement("canvas");
        oc.width = w; oc.height = h;
        oc.getContext("2d").drawImage(img, 0, 0, w, h);
        cb(oc.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => cb(null);
      img.src = reader.result;
    };
    reader.onerror = () => cb(null);
    reader.readAsDataURL(file);
  }

  function wireDrop() {
    const stop = (e) => { e.preventDefault(); };
    ["dragenter", "dragover"].forEach((t) => pcanvas.addEventListener(t, (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) { e.preventDefault(); pcanvas.style.outline = "3px dashed #2563eb"; }
    }));
    pcanvas.addEventListener("dragleave", () => { pcanvas.style.outline = ""; });
    pcanvas.addEventListener("drop", (e) => {
      pcanvas.style.outline = "";
      const f = e.dataTransfer && Array.from(e.dataTransfer.files).find((x) => x.type && x.type.startsWith("image/"));
      if (!f) return;
      stop(e);
      readScaledImage(f, 1400, (url) => {
        if (!url) { setStatus("Couldn't read that image."); return; }
        setPBg(url);
        dirty = true;
        setStatus("Image added — trace over it, then press Extract.");
        scheduleSave(); // persists the image with the note (no Claude call)
      });
    });
  }

  function clearNote() {
    pstrokes = [];
    pbgData = null; pbgEl = null;
    redrawPop();
    setStatus("Cleared — write again to make a new note.");
    // Start a fresh note next time so we don't overwrite the saved one with blank ink.
    pageId = null;
    dirty = false;
    clearTimeout(saveTimer);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    setStatus("Saving…");
    saveTimer = setTimeout(() => saveNote(), SAVE_MS);
  }

  // Persist strokes + dropped image. Does NOT call Claude — extraction is on
  // demand only (the Extract button), so writing never spends a CLI call.
  async function saveNote() {
    if (!pstrokes.length && !pbgData) return;
    if (saving) return; // a save is already running; end()/drop re-schedules
    saving = true;
    dirty = false;
    try {
      if (!pageId) {
        const r = await fetch("/api/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Quick note", width: PW, height: PH, background: "blank", strokes: pstrokes, bgImage: pbgData }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        pageId = (await r.json()).id;
      } else {
        const r = await fetch(`/api/pages/${pageId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strokes: pstrokes, bgImage: pbgData }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
      }
      setStatus("Saved ✓ — press Extract to read it with Claude.");
    } catch (e) {
      console.error("Pop-out save failed:", e);
      dirty = true;
      setStatus("Save failed — will retry…");
    } finally {
      saving = false;
      if (dirty) scheduleSave();
    }
  }

  // On-demand extraction: make sure the note is saved, then send the composited
  // pop-out canvas (ink + dropped image) to Claude and show the result.
  let extracting = false;
  async function extractNow() {
    if (extracting) return;
    if (!pstrokes.length && !pbgData) { setStatus("Nothing to extract yet."); return; }
    extracting = true;
    try {
      if (!pageId || dirty) await saveNote();
      if (!pageId) { setStatus("Couldn't save the note — try again."); return; }
      setStatus("Extracting with Claude… this can take a while.");
      const image = pcanvas.toDataURL("image/png");
      const r = await fetch(`/api/pages/${pageId}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || data.error || ("HTTP " + r.status));
      showNotes(data);
    } catch (e) {
      console.error("Pop-out extract failed:", e);
      setStatus("Extraction failed: " + (e && e.message ? e.message : e));
    } finally {
      extracting = false;
    }
  }

  function showNotes(p) {
    if (!notesEl) return;
    const text = p.ocrText != null ? p.ocrText : p.text;
    const parts = [];
    if (text && text.trim()) parts.push(text.trim());
    if (p.answer && p.answer.trim()) parts.push("Answer:\n" + p.answer.trim());
    if (p.mermaid && p.mermaid.trim()) parts.push("Diagram (mermaid):\n" + p.mermaid.trim());
    notesEl.textContent = parts.join("\n\n") || "(no text found — write a bit more)";
    setStatus(p.extractStatus === "error" ? "Extraction failed — try again." : "Extracted ✓ — saved to your pages.");
  }

  function teardown() {
    clearTimeout(saveTimer);
    // A normal async fetch won't finish while the window unloads, so flush the
    // final save (strokes + image) with keepalive so nothing is lost.
    if (dirty && (pstrokes.length || pbgData)) flushSave();
    pip = null; pcanvas = null; pctx = null; pgesture = null; statusEl = null; notesEl = null;
    setBtnActive(false);
  }

  function flushSave() {
    const opts = { headers: { "Content-Type": "application/json" }, keepalive: true };
    try {
      if (!pageId) {
        fetch("/api/pages", { ...opts, method: "POST", body: JSON.stringify({ title: "Quick note", width: PW, height: PH, background: "blank", strokes: pstrokes, bgImage: pbgData }) });
      } else {
        fetch(`/api/pages/${pageId}`, { ...opts, method: "PUT", body: JSON.stringify({ strokes: pstrokes, bgImage: pbgData }) });
      }
    } catch { /* best effort */ }
  }

  const POP_HTML = `
    <div class="pop-head">
      <span class="pop-title"><svg viewBox="0 0 24 24" class="pop-i"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg> Quick notes</span>
      <button id="pextract" class="pop-btn" title="Extract now">Extract now</button>
    </div>
    <div class="pop-canvas-wrap"><canvas id="pcanvas"></canvas></div>
    <div class="pop-tools">
      <button class="psw on" data-c="#111111" style="--c:#111111" title="Black" aria-label="Black"></button>
      <button class="psw" data-c="#e11d48" style="--c:#e11d48" title="Red" aria-label="Red"></button>
      <button class="psw" data-c="#2563eb" style="--c:#2563eb" title="Blue" aria-label="Blue"></button>
      <button class="psw" data-c="#16a34a" style="--c:#16a34a" title="Green" aria-label="Green"></button>
      <span class="pop-sp"></span>
      <button id="pclear" class="pop-btn ghost" title="Clear & start a new note">Clear</button>
    </div>
    <div id="pstatus" class="pop-status"></div>
    <div class="pop-cap">Extracted notes</div>
    <pre id="pnotes" class="pop-notes"></pre>`;

  const POP_CSS = `
    :root{color-scheme:light dark}
    *{box-sizing:border-box}
    body{margin:0;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f5f8;color:#1b1f27}
    .pop{display:flex;flex-direction:column;height:100vh;padding:10px;gap:8px}
    .pop-head{display:flex;align-items:center;gap:8px}
    .pop-title{flex:1;font-weight:700;display:flex;align-items:center;gap:6px}
    .pop-i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .pop-btn{border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;padding:6px 10px;cursor:pointer;font-size:12px}
    .pop-btn.ghost{background:transparent;color:inherit;border:1px solid rgba(0,0,0,.18)}
    .pop-btn:hover{filter:brightness(1.05)}
    .pop-canvas-wrap{background:#fff;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.12);overflow:hidden;line-height:0}
    #pcanvas{display:block;width:100%;height:auto;touch-action:none;cursor:crosshair;background:#fff}
    .pop-tools{display:flex;align-items:center;gap:6px}
    .psw{width:22px;height:22px;border-radius:50%;border:2px solid rgba(0,0,0,.15);background:var(--c);cursor:pointer;padding:0}
    .psw.on{box-shadow:0 0 0 2px #2563eb}
    .pop-sp{flex:1}
    .pop-status{font-size:12px;color:#64748b;min-height:1.2em}
    .pop-cap{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;font-weight:700}
    .pop-notes{margin:0;flex:1;min-height:44px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.04);border-radius:8px;padding:9px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
    @media (prefers-color-scheme:dark){
      body{background:#0f1219;color:#e8eaf0}
      .pop-btn.ghost{border-color:rgba(255,255,255,.2)}
      .pop-canvas-wrap{box-shadow:0 2px 12px rgba(0,0,0,.5)}
      .pop-notes{background:rgba(255,255,255,.06)}
      .pop-status{color:#9aa2b1}
    }`;
})();
