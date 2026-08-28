// ===========================================================================
// Pen Pad — drawing client
// ===========================================================================

const canvas = document.getElementById("padCanvas");
const ctx = canvas.getContext("2d");

const colorInput = document.getElementById("color");
const widthInput = document.getElementById("width");
const widthValue = document.getElementById("widthValue");
const titleInput = document.getElementById("title");
const statusEl = document.getElementById("status");
const swatchesEl = document.getElementById("swatches");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const finishBtn = document.getElementById("finishBtn");
const importFile = document.getElementById("importFile");
const padScroll = document.getElementById("padScroll");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomResetBtn = document.getElementById("zoomReset");
const panToggleBtn = document.getElementById("panToggle");

// ---- State -----------------------------------------------------------------
/** @type {Array} */ let strokes = [];
/** Snapshot undo/redo stacks (each entry is a full clone of `strokes`). */
let history = [];
let future = [];
let gesture = null;             // the in-progress pointer gesture
let strokeStartTime = 0;
let lastPenTime = 0;            // for palm rejection
let currentTool = "pen";
let background = "blank";
let editingId = null;          // set when editing an existing saved page
let recentColors = ["#111111", "#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#7c3aed"];
let autosaveTimer = null;

// ---- Zoom / scroll state ---------------------------------------------------
// The page is a fixed sheet at the canvas's intrinsic resolution; `zoom` only
// changes its on-screen size, and the .pad-scroll container handles panning.
const PAGE_W = canvas.width;   // intrinsic page width  (px) — never changes
const PAGE_H = canvas.height;  // intrinsic page height (px)
const ZOOM_MIN = 0.1, ZOOM_MAX = 6;
let zoom = 1;
let fitMode = true;            // track the viewport width on resize until the user zooms
let panMode = false;           // hand tool: drag pans instead of draws
let spaceHeld = false;         // holding Space temporarily pans

// Dropped background image to trace/annotate over (data URL + loaded element).
let bgImageData = null;
let bgImageEl = null;

const SHAPE_TOOLS = ["line", "rect", "ellipse", "arrow"];
const isShape = (t) => SHAPE_TOOLS.includes(t);
const clone = (v) => JSON.parse(JSON.stringify(v));
const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(16).slice(2) + performance.now());

// ---- Init ------------------------------------------------------------------
loadSettings();
applyTool(currentTool);
renderSwatches();
syncWidthLabel();
initViewport();
updateHistoryButtons();
window.addEventListener("resize", onResize);

// Load an existing page for editing (?id=…), else restore an autosaved draft.
(function bootstrap() {
  const id = new URLSearchParams(location.search).get("id");
  if (id) loadForEdit(id);
  else restoreDraft();
})();

// ---- Canvas sizing / zoom / scroll -----------------------------------------
// The canvas bitmap stays at PAGE_W × PAGE_H; we scale its CSS size by `zoom`
// and the .pad-scroll container scrolls. pointFromEvent already maps pointer →
// page coordinates via getBoundingClientRect, so drawing stays correct at any
// zoom or scroll position with no extra math.
function initViewport() {
  fitWidth();
  padScroll.scrollTop = 0;
  redraw();
}

function onResize() {
  if (fitMode) fitWidth(); // keep the page fitted to the width until the user zooms
}

function applyZoom() {
  canvas.style.width = Math.round(PAGE_W * zoom) + "px";
  canvas.style.height = Math.round(PAGE_H * zoom) + "px";
  zoomResetBtn.textContent = Math.round(zoom * 100) + "%";
}

// Fit the page width into the visible scroll area (accounting for the paper's
// 28px margins), so the sheet fills the width and scrolls vertically.
function fitWidth() {
  const avail = padScroll.clientWidth - 2 * 28 - 4;
  zoom = clampZoom(avail > 0 ? avail / PAGE_W : 1);
  fitMode = true;
  applyZoom();
}

function clampZoom(z) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

// Zoom to `z`, keeping the page point under (cx,cy) — a viewport point, default
// the centre of the scroll area — fixed on screen.
function setZoom(z, cx, cy) {
  z = clampZoom(z);
  const area = padScroll.getBoundingClientRect();
  if (cx == null) { cx = area.left + area.width / 2; cy = area.top + area.height / 2; }
  const before = canvas.getBoundingClientRect();
  const px = (cx - before.left) / zoom; // page coords under the cursor
  const py = (cy - before.top) / zoom;
  zoom = z;
  fitMode = false;
  applyZoom();
  // Re-measure after the reflow and nudge the scroll so (px,py) is back under
  // the cursor. Increasing scrollLeft moves content left, so the delta is the
  // amount the point drifted right of the cursor.
  const after = canvas.getBoundingClientRect();
  padScroll.scrollLeft += (after.left + px * zoom) - cx;
  padScroll.scrollTop += (after.top + py * zoom) - cy;
}

function zoomIn(cx, cy) { setZoom(zoom * 1.25, cx, cy); }
function zoomOut(cx, cy) { setZoom(zoom / 1.25, cx, cy); }
function resetZoom() { fitWidth(); padScroll.scrollTop = 0; }

// ---- Panning (hand tool / Space-drag) --------------------------------------
function canPan() { return panMode || spaceHeld; }
function updatePanCursor() { padScroll.classList.toggle("can-pan", canPan()); }

function setPanMode(on) {
  panMode = on;
  panToggleBtn.classList.toggle("active", on);
  updatePanCursor();
}

function beginPan(e) {
  canvas.setPointerCapture(e.pointerId);
  padScroll.classList.add("grabbing");
  gesture = {
    type: "pan",
    startX: e.clientX,
    startY: e.clientY,
    startLeft: padScroll.scrollLeft,
    startTop: padScroll.scrollTop,
  };
}

function redraw() {
  drawAllStrokes(ctx, strokes, canvas.width, canvas.height, background, bgImageEl);
}

// Batch full repaints to at most one per animation frame. Coalesced pointer
// events can fire many times between frames; on a Raspberry Pi an unbatched
// redraw-per-event is the difference between smooth and janky.
let redrawQueued = false;
function requestRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; redraw(); });
}

// ---- Pointer capture -------------------------------------------------------
canvas.addEventListener("pointerdown", (e) => {
  if (shouldRejectPalm(e)) return;
  // Hand tool, Space-drag, or middle-mouse → pan the page instead of drawing.
  if (canPan() || e.button === 1) { e.preventDefault(); beginPan(e); return; }
  if (e.pointerType === "pen") lastPenTime = performance.now();
  canvas.setPointerCapture(e.pointerId);
  strokeStartTime = performance.now();

  // Stylus eraser tip (flip the pen) → erase regardless of selected tool.
  // Gated to pen input so a mouse/finger can never accidentally trigger it.
  const eraserOverride = e.pointerType === "pen" && ((e.buttons & 32) !== 0 || e.button === 5);
  const tool = eraserOverride ? "eraser" : currentTool;
  const p = pointFromEvent(e);

  pushHistory();

  if (tool === "eraser") {
    gesture = { type: "eraser", erasedAny: false };
    eraseAt(p);
    return;
  }
  if (isShape(tool)) {
    const s = newStroke(tool, [p, { ...p }]);
    strokes.push(s);
    gesture = { type: "shape", stroke: s };
    redraw();
    return;
  }
  // freehand: pen / highlighter
  const s = newStroke(tool, [p]);
  strokes.push(s);
  gesture = { type: "free", stroke: s, drawnCount: 1 };
  drawStroke(ctx, s);
});

canvas.addEventListener("pointermove", (e) => {
  if (!gesture) return;
  if (gesture.type === "pan") {
    padScroll.scrollLeft = gesture.startLeft - (e.clientX - gesture.startX);
    padScroll.scrollTop = gesture.startTop - (e.clientY - gesture.startY);
    return;
  }
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

  if (gesture.type === "eraser") {
    for (const ev of events) eraseAt(pointFromEvent(ev));
    return;
  }
  if (gesture.type === "shape") {
    gesture.stroke.points[1] = pointFromEvent(e);
    requestRedraw();
    return;
  }
  // free
  for (const ev of events) gesture.stroke.points.push(pointFromEvent(ev));
  if (gesture.stroke.tool === "highlighter") {
    requestRedraw(); // alpha: repaint cleanly (batched to one frame)
  } else {
    // pen: paint only the new segments since last frame — cheap, no full repaint
    drawStrokePartial(ctx, gesture.stroke, gesture.stroke.points.length, gesture.drawnCount);
    gesture.drawnCount = gesture.stroke.points.length;
  }
});

["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
  canvas.addEventListener(ev, endGesture)
);

function endGesture() {
  if (!gesture) return;
  if (gesture.type === "pan") {
    padScroll.classList.remove("grabbing");
    gesture = null;
    return;
  }
  if (gesture.type === "shape") {
    const [a, b] = gesture.stroke.points;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 3) {
      strokes = strokes.filter((s) => s !== gesture.stroke); // drop zero-size shape
      history.pop();                                         // ...and its undo step
      redraw();
    }
  } else if (gesture.type === "eraser" && !gesture.erasedAny) {
    history.pop(); // erased nothing → no undo step
  }
  // In Note Mode, hand the finished ink stroke to whichever recognizer is active.
  if (noteMode && gesture.type === "free") {
    if (hwSupported) feedStrokeToHw(gesture.stroke);
    else if (tessReady) scheduleTessRecognize();
  }
  gesture = null;
  updateHistoryButtons();
  scheduleAutosave();
}

function newStroke(tool, points) {
  return { id: uuid(), tool, color: colorInput.value, baseWidth: Number(widthInput.value), points };
}

function pointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  // Clamp to the canvas bounds so a pen that strays past the mapped edge still
  // writes ONLY inside the white area (never off-page).
  const x = Math.min(canvas.width, Math.max(0, (e.clientX - rect.left) * scaleX));
  const y = Math.min(canvas.height, Math.max(0, (e.clientY - rect.top) * scaleY));
  return {
    x,
    y,
    pressure: e.pressure ?? 0.5,
    tiltX: e.tiltX ?? 0,
    tiltY: e.tiltY ?? 0,
    t: Math.round(performance.now() - strokeStartTime),
  };
}

// ---- Zoom / pan controls ---------------------------------------------------
function isTypingTarget(el) {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

zoomInBtn.addEventListener("click", () => zoomIn());
zoomOutBtn.addEventListener("click", () => zoomOut());
zoomResetBtn.addEventListener("click", resetZoom);
panToggleBtn.addEventListener("click", () => setPanMode(!panMode));

// Ctrl/⌘ + wheel (or pinch on a trackpad) zooms toward the cursor; a plain
// wheel / two-finger swipe scrolls the page natively (up/down and sideways).
padScroll.addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }
}, { passive: false });

// Hold Space to drag-pan (swipe to scroll); release to go back to drawing.
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !isTypingTarget(e.target) && !e.repeat) {
    e.preventDefault();
    spaceHeld = true;
    updatePanCursor();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") { spaceHeld = false; updatePanCursor(); }
});

// ---- Drop an image to trace over -------------------------------------------
// Drop an image file onto the pad to place it as a background you can write
// over. It's stored with the page (and shows in the viewer), but is NOT sent to
// Claude — extraction only ever reads your ink, never the traced image.
function setBgImage(dataUrl) {
  bgImageData = dataUrl || null;
  if (!dataUrl) { bgImageEl = null; redraw(); return; }
  const img = new Image();
  img.onload = () => { bgImageEl = img; redraw(); };
  img.src = dataUrl;
}

// Read a dropped image and downscale it so the stored data URL stays small.
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

function handleDroppedFiles(files) {
  const image = Array.from(files).find((f) => f.type && f.type.startsWith("image/"));
  if (!image) { setStatus("Drop an image file to trace over.", "error"); return; }
  readScaledImage(image, 1600, (url) => {
    if (!url) { setStatus("Couldn't read that image.", "error"); return; }
    setBgImage(url);
    scheduleAutosave();
    setStatus("Background image added — write over it (Clear removes it).");
  });
}

function isFileDrag(e) { return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"); }
["dragenter", "dragover"].forEach((ev) =>
  padScroll.addEventListener(ev, (e) => { if (isFileDrag(e)) { e.preventDefault(); padScroll.classList.add("drop-hover"); } })
);
padScroll.addEventListener("dragleave", (e) => { if (e.target === padScroll) padScroll.classList.remove("drop-hover"); });
padScroll.addEventListener("drop", (e) => {
  padScroll.classList.remove("drop-hover");
  if (!isFileDrag(e)) return;
  e.preventDefault();
  handleDroppedFiles(e.dataTransfer.files);
});

// ---- Full-screen writing mode ----------------------------------------------
// Hides the toolbar and (best-effort) enters browser fullscreen so the white
// canvas fills the whole screen — aligning an absolute pen tablet's surface
// exactly to the writable white area.
function setFocus(on) {
  document.body.classList.toggle("focus", on);
  const btnUse = document.querySelector("#focusBtn use");
  if (btnUse) btnUse.setAttribute("href", on ? "#i-minimize" : "#i-maximize");
  if (on) {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el)?.catch?.(() => {});
  } else if (document.fullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document)?.catch?.(() => {});
  }
  // The writable area changed size — refit the canvas on the next frame.
  requestAnimationFrame(fitWidth);
}
function toggleFocus() { setFocus(!document.body.classList.contains("focus")); }

document.getElementById("focusBtn").addEventListener("click", toggleFocus);
document.getElementById("exitFocus").addEventListener("click", () => setFocus(false));
document.addEventListener("fullscreenchange", () => {
  // If the user leaves fullscreen via Esc/browser, drop focus mode to match.
  if (!document.fullscreenElement && document.body.classList.contains("focus")) {
    document.body.classList.remove("focus");
    const btnUse = document.querySelector("#focusBtn use");
    if (btnUse) btnUse.setAttribute("href", "#i-maximize");
    requestAnimationFrame(fitWidth);
  }
});

function shouldRejectPalm(e) {
  return e.pointerType === "touch" && performance.now() - lastPenTime < 1500;
}

// ---- Eraser (whole-stroke) -------------------------------------------------
function eraseAt(p) {
  const r = Math.max(10, Number(widthInput.value) * 2 + 6);
  const before = strokes.length;
  strokes = strokes.filter((s) => !strokeHit(s, p.x, p.y, r));
  if (strokes.length !== before) {
    gesture.erasedAny = true;
    requestRedraw();
  }
}

function strokeHit(s, x, y, r) {
  const pts = s.points;
  if (!pts.length) return false;
  if (s.tool === "line" || s.tool === "arrow") return distToSeg(x, y, pts[0], pts[1]) <= r;
  if (s.tool === "rect" || s.tool === "ellipse") {
    const a = pts[0], b = pts[1];
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const nearX = x >= minX - r && x <= maxX + r;
    const nearY = y >= minY - r && y <= maxY + r;
    const onXedge = Math.abs(x - minX) <= r || Math.abs(x - maxX) <= r;
    const onYedge = Math.abs(y - minY) <= r || Math.abs(y - maxY) <= r;
    return (nearX && onYedge) || (nearY && onXedge);
  }
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(pts[i].x - x, pts[i].y - y) <= r) return true;
    if (i > 0 && distToSeg(x, y, pts[i - 1], pts[i]) <= r) return true;
  }
  return false;
}

function distToSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

// ---- History ---------------------------------------------------------------
function pushHistory() {
  history.push(clone(strokes));
  if (history.length > 80) history.shift();
  future = [];
  updateHistoryButtons();
}
function undo() {
  if (!history.length) return;
  future.push(clone(strokes));
  strokes = history.pop();
  redraw();
  updateHistoryButtons();
  scheduleAutosave();
}
function redo() {
  if (!future.length) return;
  history.push(clone(strokes));
  strokes = future.pop();
  redraw();
  updateHistoryButtons();
  scheduleAutosave();
}
function clearPage() {
  pushHistory();
  strokes = [];
  bgImageData = null; bgImageEl = null;
  redraw();
  updateHistoryButtons();
  scheduleAutosave();
}
function updateHistoryButtons() {
  undoBtn.disabled = history.length === 0;
  redoBtn.disabled = future.length === 0;
}

// ---- Tools, color, width, background --------------------------------------
function applyTool(tool) {
  currentTool = tool;
  document.querySelectorAll(".tool-btn[data-tool]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === tool)
  );
  canvas.style.cursor = tool === "eraser" ? "cell" : "crosshair";
  saveSettings();
}

document.querySelectorAll(".tool-btn[data-tool]").forEach((b) =>
  b.addEventListener("click", () => applyTool(b.dataset.tool))
);

colorInput.addEventListener("input", () => {
  pushRecentColor(colorInput.value);
  renderSwatches();
  saveSettings();
});

function renderSwatches() {
  swatchesEl.innerHTML = "";
  for (const c of recentColors.slice(0, 6)) {
    const b = document.createElement("button");
    b.className = "swatch" + (c.toLowerCase() === colorInput.value.toLowerCase() ? " active" : "");
    b.style.background = c;
    b.title = c;
    b.addEventListener("click", () => {
      colorInput.value = c;
      pushRecentColor(c);
      renderSwatches();
      saveSettings();
    });
    swatchesEl.appendChild(b);
  }
}
function pushRecentColor(c) {
  c = c.toLowerCase();
  recentColors = [c, ...recentColors.filter((x) => x.toLowerCase() !== c)].slice(0, 12);
}

widthInput.addEventListener("input", () => { syncWidthLabel(); saveSettings(); });
function syncWidthLabel() { if (widthValue) widthValue.textContent = widthInput.value; }

function setBackground(bg) {
  background = bg;
  document.querySelectorAll(".bg-opt").forEach((b) => b.classList.toggle("active", b.dataset.bg === bg));
  redraw();
  saveSettings();
  scheduleAutosave();
}
function cycleBackground() {
  const order = ["blank", "ruled", "grid", "dotted"];
  setBackground(order[(order.indexOf(background) + 1) % order.length]);
}

// ---- Save / load -----------------------------------------------------------
async function savePage(navigate) {
  if (strokes.length === 0 && navigate) { setStatus("Nothing written yet.", "error"); return; }
  setStatus("Saving…", "busy");
  finishBtn.disabled = true;
  try {
    const noteText = document.getElementById("noteText").value.trim();
    const body = {
      title: titleInput.value,
      width: canvas.width,
      height: canvas.height,
      background,
      strokes,
      ocrText: noteText || null, // Note-Mode text → searchable
      bgImage: bgImageData,      // traced-over image, if any
    };
    const url = editingId ? `/api/pages/${editingId}` : "/api/pages";
    const res = await fetch(url, {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    editingId = editingId || data.id;
    clearDraft();
    if (navigate) window.location.href = `/page/${editingId}`;
    else setStatus(data.extractStatus === "pending" ? "Saved ✓ — extracting with Claude…" : "Saved ✓");
  } catch (err) {
    console.error(err);
    setStatus("Save failed — see console.", "error");
  } finally {
    finishBtn.disabled = false;
  }
}

async function loadForEdit(id) {
  try {
    const res = await fetch(`/api/pages/${id}`);
    if (!res.ok) return;
    const page = await res.json();
    editingId = id;
    background = page.background || "blank";
    document.querySelectorAll(".bg-opt").forEach((b) => b.classList.toggle("active", b.dataset.bg === background));
    titleInput.value = page.title && !/^Page \d{4}-/.test(page.title) ? page.title : "";
    const sx = canvas.width / page.width;
    const sy = canvas.height / page.height;
    strokes = (page.strokes || []).map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p, x: p.x * sx, y: p.y * sy })),
    }));
    history = []; future = [];
    setBgImage(page.bgImage || null);
    redraw();
    updateHistoryButtons();
    setStatus("Editing saved page");
  } catch (e) {
    console.error(e);
  }
}

// ---- Autosave draft (localStorage) ----------------------------------------
function scheduleAutosave() {
  if (editingId) return; // don't shadow a real saved page with a draft
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveDraft, 700);
}
function saveDraft() {
  try {
    localStorage.setItem("pad:draft", JSON.stringify({
      title: titleInput.value, background, strokes, w: canvas.width, h: canvas.height,
    }));
  } catch {}
}
function clearDraft() { try { localStorage.removeItem("pad:draft"); } catch {} }
function restoreDraft() {
  try {
    const raw = localStorage.getItem("pad:draft");
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d.strokes || !d.strokes.length) return;
    background = d.background || "blank";
    document.querySelectorAll(".bg-opt").forEach((b) => b.classList.toggle("active", b.dataset.bg === background));
    if (d.title) titleInput.value = d.title;
    const sx = canvas.width / (d.w || canvas.width);
    const sy = canvas.height / (d.h || canvas.height);
    strokes = d.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: p.x * sx, y: p.y * sy })) }));
    redraw();
    setStatus("Draft restored");
  } catch {}
}

// ---- Settings (localStorage) ----------------------------------------------
function saveSettings() {
  try {
    localStorage.setItem("pad:settings", JSON.stringify({
      tool: currentTool, color: colorInput.value, width: widthInput.value, background, recent: recentColors, bullets: noteBullets,
    }));
  } catch {}
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("pad:settings") || "{}");
    // Don't boot into the eraser — otherwise the pen "erases" on first touch,
    // which looks like an undo. Always start on a drawing tool.
    if (s.tool && s.tool !== "eraser") currentTool = s.tool;
    if (s.color) colorInput.value = s.color;
    if (s.width) widthInput.value = s.width;
    if (s.background) background = s.background;
    if (Array.isArray(s.recent) && s.recent.length) recentColors = s.recent;
    if (typeof s.bullets === "boolean") {
      noteBullets = s.bullets;
      if (noteBullets) document.getElementById("noteBullet")?.classList.add("on");
    }
  } catch {}
}

// ---- Export / import -------------------------------------------------------
function filenameSafe(t) { return (t || "pen-pad").replace(/[^\w.-]+/g, "_").slice(0, 60) || "pen-pad"; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPNG() {
  canvas.toBlob((blob) => { if (blob) downloadBlob(blob, filenameSafe(titleInput.value) + ".png"); setStatus("PNG downloaded ✓"); }, "image/png");
}
function exportJSON() {
  const page = { title: titleInput.value, width: canvas.width, height: canvas.height, background, strokes, ocrText: null };
  downloadBlob(new Blob([JSON.stringify(page, null, 2)], { type: "application/json" }), filenameSafe(titleInput.value) + ".json");
  setStatus("JSON downloaded ✓");
}
function exportSVG() {
  downloadBlob(new Blob([strokesToSVG()], { type: "image/svg+xml" }), filenameSafe(titleInput.value) + ".svg");
  setStatus("SVG downloaded ✓");
}
async function copyImage() {
  try {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus("Copied to clipboard ✓");
  } catch (e) {
    console.error(e);
    setStatus("Clipboard blocked by browser", "error");
  }
}
function strokesToSVG() {
  const w = canvas.width, h = canvas.height;
  const r = (n) => Math.round(n * 100) / 100;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
  parts.push(`<defs>
    <pattern id="ruled" width="40" height="40" patternUnits="userSpaceOnUse"><line x1="0" y1="39.5" x2="40" y2="39.5" stroke="#d7e3f4"/></pattern>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#e2e8f0"/></pattern>
    <pattern id="dotted" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="40" cy="40" r="1.4" fill="#cbd5e1"/></pattern>
  </defs>`);
  parts.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`);
  if (background !== "blank") parts.push(`<rect width="${w}" height="${h}" fill="url(#${background})"/>`);
  for (const s of strokes) {
    const a = s.points[0], b = s.points[s.points.length - 1];
    if (s.tool === "rect") {
      parts.push(`<rect x="${r(Math.min(a.x, b.x))}" y="${r(Math.min(a.y, b.y))}" width="${r(Math.abs(b.x - a.x))}" height="${r(Math.abs(b.y - a.y))}" fill="none" stroke="${s.color}" stroke-width="${s.baseWidth}"/>`);
    } else if (s.tool === "ellipse") {
      parts.push(`<ellipse cx="${r((a.x + b.x) / 2)}" cy="${r((a.y + b.y) / 2)}" rx="${r(Math.abs(b.x - a.x) / 2)}" ry="${r(Math.abs(b.y - a.y) / 2)}" fill="none" stroke="${s.color}" stroke-width="${s.baseWidth}"/>`);
    } else if (s.tool === "line" || s.tool === "arrow") {
      parts.push(`<line x1="${r(a.x)}" y1="${r(a.y)}" x2="${r(b.x)}" y2="${r(b.y)}" stroke="${s.color}" stroke-width="${s.baseWidth}" stroke-linecap="round"/>`);
    } else {
      const d = s.points.map((p, i) => `${i ? "L" : "M"}${r(p.x)} ${r(p.y)}`).join(" ");
      const opacity = s.tool === "highlighter" ? 0.4 : 1;
      const width = s.tool === "highlighter" ? Math.max(6, s.baseWidth * 4) : Math.max(1, s.baseWidth);
      parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`);
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

importFile.addEventListener("change", async () => {
  const file = importFile.files && importFile.files[0];
  if (!file) return;
  try {
    const page = JSON.parse(await file.text());
    if (!Array.isArray(page.strokes)) throw new Error("no strokes[]");
    pushHistory();
    background = page.background || background;
    document.querySelectorAll(".bg-opt").forEach((b) => b.classList.toggle("active", b.dataset.bg === background));
    if (page.title) titleInput.value = page.title;
    const sx = canvas.width / (page.width || canvas.width);
    const sy = canvas.height / (page.height || canvas.height);
    strokes = page.strokes.map((s) => ({ ...s, tool: s.tool || "pen", points: s.points.map((p) => ({ ...p, x: p.x * sx, y: p.y * sy })) }));
    redraw();
    updateHistoryButtons();
    setStatus("Imported ✓");
  } catch (e) {
    console.error(e);
    setStatus("Import failed — invalid JSON", "error");
  } finally {
    importFile.value = "";
  }
});

// ---- Dialog plumbing -------------------------------------------------------
const pagesDialog = document.getElementById("pagesDialog");
const bgDialog = document.getElementById("bgDialog");
const exportDialog = document.getElementById("exportDialog");
const shortcutsDialog = document.getElementById("shortcutsDialog");

function setStatus(msg, kind) { statusEl.textContent = msg; statusEl.className = "status" + (kind ? " " + kind : ""); }

// Toolbar buttons
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);
document.getElementById("clearBtn").addEventListener("click", clearPage);
finishBtn.addEventListener("click", () => savePage(true));
document.getElementById("bgBtn").addEventListener("click", () => bgDialog.showModal());
document.getElementById("exportBtn").addEventListener("click", () => exportDialog.showModal());
document.getElementById("shortcutsBtn").addEventListener("click", toggleShortcuts);
document.getElementById("closeShortcuts").addEventListener("click", () => shortcutsDialog.close());
document.getElementById("closeDialog").addEventListener("click", () => pagesDialog.close());
document.querySelectorAll(".close-x").forEach((b) => b.addEventListener("click", (e) => e.target.closest("dialog").close()));

// Background options
document.querySelectorAll(".bg-opt").forEach((b) =>
  b.addEventListener("click", () => { setBackground(b.dataset.bg); bgDialog.close(); })
);

// Export menu
document.querySelectorAll("[data-export]").forEach((b) =>
  b.addEventListener("click", () => {
    const kind = b.dataset.export;
    exportDialog.close();
    if (kind === "png") exportPNG();
    else if (kind === "svg") exportSVG();
    else if (kind === "json") exportJSON();
    else if (kind === "clipboard") copyImage();
    else if (kind === "import") importFile.click();
  })
);

function toggleShortcuts() { shortcutsDialog.open ? shortcutsDialog.close() : shortcutsDialog.showModal(); }

// ---- Saved pages browser ---------------------------------------------------
const pagesSearch = document.getElementById("pagesSearch");
let pagesSearchTimer = null;

document.getElementById("pagesLink").addEventListener("click", (e) => { e.preventDefault(); openPages(); });
pagesSearch.addEventListener("input", () => {
  clearTimeout(pagesSearchTimer);
  pagesSearchTimer = setTimeout(() => loadPagesList(pagesSearch.value.trim()), 200);
});

async function openPages() {
  pagesSearch.value = "";
  if (!pagesDialog.open) pagesDialog.showModal();
  loadPagesList("");
}

async function loadPagesList(q) {
  const list = document.getElementById("pagesList");
  const res = await fetch("/api/pages" + (q ? "?q=" + encodeURIComponent(q) : ""));
  const pages = await res.json();
  if (!pages.length) {
    list.innerHTML = `<li><div class="empty"><svg class="icon"><use href="#i-inbox" /></svg>${q ? "No matches." : "No saved pages yet."}</div></li>`;
    return;
  }
  list.innerHTML = pages.map((p) => `<li>
      <a href="/?id=${p.id}" title="Open for editing">
        <canvas class="p-thumb" data-thumb="${p.id}" width="38" height="50"></canvas>
        <span class="p-body">
          <span class="p-title">${escapeHtml(p.title)}</span>
          <span class="p-meta"><svg class="icon"><use href="#i-clock" /></svg>${formatDate(p.updatedAt || p.createdAt)}</span>
        </span>
        <svg class="icon p-go"><use href="#i-chevron" /></svg>
      </a>
      <button class="p-del" data-del="${p.id}" title="Delete page" aria-label="Delete"><svg class="icon"><use href="#i-trash" /></svg></button>
    </li>`).join("");

  list.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      const id = b.dataset.del;
      await fetch(`/api/pages/${id}`, { method: "DELETE" });
      loadPagesList(pagesSearch.value.trim());
    })
  );
  // Render thumbnails one at a time rather than firing N parallel fetches +
  // canvas decodes at once — gentler on a low-power device.
  (async () => {
    for (const c of list.querySelectorAll("[data-thumb]")) {
      await renderThumb(c, c.dataset.thumb);
    }
  })();
}

async function renderThumb(canvasEl, id) {
  try {
    const res = await fetch(`/api/pages/${id}`);
    if (!res.ok) return;
    const page = await res.json();
    const tctx = canvasEl.getContext("2d");
    const scale = Math.min(canvasEl.width / page.width, canvasEl.height / page.height);
    tctx.fillStyle = "#fff";
    tctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    tctx.save();
    tctx.scale(scale, scale);
    drawAllStrokes(tctx, page.strokes, page.width, page.height, page.background);
    tctx.restore();
  } catch {}
}

// ---- Note Mode (handwriting → text, line by line) --------------------------
// Uses the browser's native Handwriting Recognition API where available
// (offline, no dependency, mostly ChromeOS). Where it isn't, we fall back to
// Tesseract.js running fully offline (self-hosted wasm + English model under
// /vendor — no CDN calls) so auto-convert still works on a plain desktop/Pi
// browser. If even that fails to load, the panel degrades to a typed notes
// area. Either way the text is saved as the page's ocrText → searchable.
let noteMode = false;
let hwRecognizer = null;
let hwDrawing = null;
let hwSupported = false;
let hwTried = false;
let noteCurrentText = "";
let noteRecognizeTimer = null;
let noteAutoCommitTimer = null;
let noteBullets = false;

// Tesseract.js fallback state
let tessWorker = null;
let tessReady = false;
let tessLoading = false;
let tessBusy = false;    // a recognize() call is in flight
let tessDirty = false;   // ink changed again while tessBusy — re-run when it frees up
let noteLineStart = 0;   // strokes[] index where the current (uncommitted) line begins —
                          // keeps pre-existing page ink out of the OCR image, mirroring
                          // how the native recognizer only ever sees strokes fed to it
                          // after Note Mode started.

async function initHw() {
  hwTried = true;
  if ("createHandwritingRecognizer" in navigator) {
    try {
      hwRecognizer = await navigator.createHandwritingRecognizer({ languages: ["en"] });
      hwSupported = true;
      startHwLine();
      return;
    } catch (e) {
      console.warn("Handwriting recognizer unavailable:", e);
      hwSupported = false;
    }
  }
  await initTess();
}
function startHwLine() {
  if (!hwRecognizer) return;
  try { hwDrawing = hwRecognizer.startDrawing({ recognitionType: "text", alternatives: 1 }); }
  catch { hwDrawing = null; }
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out after " + ms + "ms")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function initTess() {
  tessLoading = true;
  setNoteStatus();
  try {
    if (typeof Tesseract === "undefined") await withTimeout(loadScriptOnce("/vendor/tesseract/tesseract.min.js"), 15000);
    // Tesseract.js v7 silently swallows a failed language-data fetch inside
    // createWorker (it never calls its own reject path for that stage), so
    // without a timeout a bad/missing vendor file would hang here forever —
    // leaving Note Mode stuck on "Loading…" with no route to the typed
    // fallback. Race it against our own timeout so we always resolve.
    tessWorker = await withTimeout(Tesseract.createWorker("eng", 1, {
      workerPath: "/vendor/tesseract/worker.min.js",
      corePath: "/vendor/tesseract/tesseract-core-simd-lstm.js",
      langPath: "/vendor/tessdata",
      // All of the above are same-origin, so skip the blob-URL worker wrapper
      // Tesseract.js uses to load cross-origin (CDN) scripts — with it on,
      // the worker's self.location becomes an opaque blob: URL, which breaks
      // the wasm core's *relative* fetch for its sibling .wasm file.
      workerBlobURL: false,
    }), 20000);
    // Each recognize() call gets one handwritten line — segmenting as a single
    // line (rather than a full-page layout guess) is far more accurate here.
    await withTimeout(tessWorker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE }), 5000);
    tessReady = true;
  } catch (e) {
    console.warn("Offline OCR (Tesseract) unavailable:", e);
    tessReady = false;
    tessWorker = null;
  } finally {
    tessLoading = false;
  }
}

async function setNoteMode(on) {
  noteMode = on;
  document.body.classList.toggle("note-mode", on);
  document.getElementById("noteBtn").classList.toggle("note-on", on);
  requestAnimationFrame(fitWidth);
  if (on) noteLineStart = strokes.length;
  if (on && !hwTried) {
    setNoteStatus();
    await initHw();
  }
  if (on) setNoteStatus();
}
function toggleNoteMode() { setNoteMode(!noteMode); }
function setNoteStatus() {
  const el = document.getElementById("noteStatus");
  if (!hwTried) {
    el.textContent = "Checking handwriting recognition…";
    el.className = "note-status";
  } else if (hwSupported) {
    el.textContent = "Write a line on the pad — it's recognized automatically. Enter (or Commit) starts a new line.";
    el.className = "note-status";
  } else if (tessLoading) {
    el.textContent = "Loading offline handwriting recognition (first time only)…";
    el.className = "note-status";
  } else if (tessReady) {
    // Offline OCR (Tesseract) segments characters by the gaps between them —
    // it reads separated print letters well but misreads joined/cursive
    // strokes (measured: a joined "hello" came back "nello" at 85% vs. 96%
    // separated). This is the one thing that reliably moves its accuracy.
    el.textContent = "Offline OCR active — print with small gaps between letters (not cursive) for best accuracy. Pause to recognize, Enter for a new line.";
    el.className = "note-status";
  } else {
    el.textContent = "Handwriting recognition isn't available in this browser. You can type notes here — they're saved with the page and searchable.";
    el.className = "note-status warn";
  }
}

function feedStrokeToHw(stroke) {
  if (!hwDrawing || typeof HandwritingStroke === "undefined") return;
  try {
    const hs = new HandwritingStroke();
    for (const p of stroke.points) hs.addPoint({ x: p.x, y: p.y, t: p.t });
    hwDrawing.addStroke(hs);
    clearTimeout(noteRecognizeTimer);
    noteRecognizeTimer = setTimeout(recognizeCurrent, 600);
    clearTimeout(noteAutoCommitTimer);
    noteAutoCommitTimer = setTimeout(commitLine, 4000); // long pause → new line
  } catch (e) { console.warn(e); }
}
async function recognizeCurrent() {
  if (!hwDrawing) return;
  try {
    const preds = await hwDrawing.getPrediction();
    noteCurrentText = preds && preds.length ? preds[0].text : "";
    document.getElementById("noteCurrent").textContent = noteCurrentText;
  } catch (e) { console.warn(e); }
}

// Tesseract path: there's no incremental "add this stroke" API — instead we
// re-render the whole current line to an offscreen bitmap and re-run OCR on
// it, debounced so a fast scribbler doesn't queue up overlapping recognitions.
function scheduleTessRecognize() {
  clearTimeout(noteRecognizeTimer);
  noteRecognizeTimer = setTimeout(runTessRecognize, 600);
  clearTimeout(noteAutoCommitTimer);
  noteAutoCommitTimer = setTimeout(commitLine, 4000); // long pause → new line
}
function renderLineCanvas() {
  const lineStrokes = strokes.slice(noteLineStart);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of lineStrokes) for (const p of s.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX) || maxX - minX < 2 || maxY - minY < 2) return null;

  const pad = 24;
  const scale = 2; // upscale — Tesseract reads larger text more reliably
  const off = document.createElement("canvas");
  off.width = Math.ceil((maxX - minX + pad * 2) * scale);
  off.height = Math.ceil((maxY - minY + pad * 2) * scale);
  const octx = off.getContext("2d");
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, off.width, off.height);
  octx.translate((pad - minX) * scale, (pad - minY) * scale);
  octx.scale(scale, scale);
  // Force black ink for OCR contrast regardless of the pen's actual color.
  for (const s of lineStrokes) drawStroke(octx, { ...s, color: "#000" });
  return off;
}
async function runTessRecognize() {
  if (!tessReady) return;
  if (tessBusy) { tessDirty = true; return; }
  const img = renderLineCanvas();
  if (!img) return;
  tessBusy = true;
  try {
    const { data } = await tessWorker.recognize(img);
    noteCurrentText = (data.text || "").replace(/\s+/g, " ").trim();
    document.getElementById("noteCurrent").textContent = noteCurrentText;
  } catch (e) {
    console.warn("Tesseract recognize failed:", e);
  } finally {
    tessBusy = false;
    if (tessDirty) { tessDirty = false; runTessRecognize(); }
  }
}

function commitLine() {
  clearTimeout(noteAutoCommitTimer);
  const cur = (noteCurrentText || "").trim();
  const ta = document.getElementById("noteText");
  if (cur) {
    const prefix = noteBullets ? "• " : "";
    ta.value += (ta.value && !ta.value.endsWith("\n") ? "\n" : "") + prefix + cur + "\n";
    ta.scrollTop = ta.scrollHeight;
  }
  noteCurrentText = "";
  tessDirty = false;
  document.getElementById("noteCurrent").textContent = "";
  startHwLine();
  // Clear the ink so the next line has a fresh page to write on — but only when
  // recognition is actually driving the flow (don't wipe a fallback user's ink).
  if ((hwSupported || tessReady) && strokes.length) { pushHistory(); strokes = []; redraw(); updateHistoryButtons(); }
  noteLineStart = strokes.length;
}

document.getElementById("noteBtn").addEventListener("click", toggleNoteMode);
document.getElementById("noteClose").addEventListener("click", () => setNoteMode(false));
document.getElementById("noteCommit").addEventListener("click", commitLine);
document.getElementById("noteCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(document.getElementById("noteText").value); setStatus("Text copied ✓"); }
  catch { setStatus("Copy blocked by browser", "error"); }
});
document.getElementById("noteSave").addEventListener("click", () => {
  const text = document.getElementById("noteText").value;
  downloadBlob(new Blob([text], { type: "text/plain" }), filenameSafe(titleInput.value) + ".txt");
  setStatus("Notes saved ✓");
});
document.getElementById("noteClear").addEventListener("click", () => {
  document.getElementById("noteText").value = "";
  noteCurrentText = "";
  document.getElementById("noteCurrent").textContent = "";
});

// Bullet points: prefix each committed/typed line with "• ".
function toggleBullets() {
  noteBullets = !noteBullets;
  document.getElementById("noteBullet").classList.toggle("on", noteBullets);
  applyBulletFormat(noteBullets);
  saveSettings();
}
function applyBulletFormat(on) {
  const ta = document.getElementById("noteText");
  ta.value = ta.value
    .split("\n")
    .map((line) => {
      const bare = line.replace(/^\s*•\s?/, "");
      return on && bare.trim() ? "• " + bare : bare;
    })
    .join("\n");
}
document.getElementById("noteBullet").addEventListener("click", toggleBullets);

// When typing directly, Enter starts the next bullet automatically.
document.getElementById("noteText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && noteBullets) {
    e.preventDefault();
    const ta = e.target;
    const at = ta.selectionStart;
    const insert = "\n• ";
    ta.value = ta.value.slice(0, at) + insert + ta.value.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = at + insert.length;
  }
});

// ---- Pen Diagnostics -------------------------------------------------------
// Live readout of what the tablet is reporting: pointer type, pressure (+peak),
// tilt, twist, coordinates and which pen buttons are down. Read-only listeners
// that never interfere with drawing.
let diagOn = false;
let diagPeak = 0;
let diagPending = null;
let diagRaf = false;

function setDiag(on) {
  diagOn = on;
  document.body.classList.toggle("diag-on", on);
  document.getElementById("diagBtn").classList.toggle("on", on);
}
function toggleDiag() { setDiag(!diagOn); }

function onDiagEvent(e) {
  if (!diagOn) return;
  diagPending = e;
  if (diagRaf) return;
  diagRaf = true;
  requestAnimationFrame(flushDiag);
}
function flushDiag() {
  diagRaf = false;
  const e = diagPending;
  if (!e) return;
  const type = e.pointerType || "mouse";
  const pressure = Math.max(0, Math.min(1, e.pressure || 0));
  const pct = Math.round(pressure * 100);
  if (pct > diagPeak) diagPeak = pct;

  const typeEl = document.getElementById("diagType");
  typeEl.textContent = type;
  typeEl.className = "diag-badge " + (type === "pen" ? "pen" : type === "mouse" ? "mouse" : "");

  document.getElementById("diagPressureVal").textContent = pct + "%";
  document.getElementById("diagPressureBar").style.width = pct + "%";
  document.getElementById("diagPeak").textContent = diagPeak + "%";

  const tx = Math.round(e.tiltX || 0);
  const ty = Math.round(e.tiltY || 0);
  document.getElementById("diagTiltX").textContent = tx + "°";
  document.getElementById("diagTiltY").textContent = ty + "°";
  document.getElementById("diagTwist").textContent = Math.round(e.twist || 0) + "°";

  const rect = canvas.getBoundingClientRect();
  const cx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
  const cy = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
  document.getElementById("diagXY").textContent = cx + ", " + cy;

  document.getElementById("diagTiltDot").style.transform =
    `translate(${(tx / 90) * 18}px, ${(ty / 90) * 18}px)`;

  const b = e.buttons || 0;
  document.getElementById("btnTip").classList.toggle("on", (b & 1) !== 0);
  document.getElementById("btnBarrel").classList.toggle("on", (b & 2) !== 0);
  document.getElementById("btnEraser").classList.toggle("on", (b & 32) !== 0 || (type === "pen" && e.button === 5));

  const hint = document.getElementById("diagHint");
  if (type === "mouse") {
    hint.textContent = "No pen detected — this is a mouse. Install the tablet driver for pressure & tilt.";
    hint.className = "diag-hint warn";
  } else if (type === "pen" && pressure === 0 && b === 0) {
    hint.textContent = "Pen detected — hovering ✓ (touch down to draw).";
    hint.className = "diag-hint";
  } else if (type === "pen") {
    hint.textContent = "Pen active ✓ pressure & tilt reporting.";
    hint.className = "diag-hint";
  } else {
    hint.textContent = "Touch input detected.";
    hint.className = "diag-hint";
  }
}

["pointerdown", "pointermove", "pointerup", "pointerenter"].forEach((ev) =>
  canvas.addEventListener(ev, onDiagEvent)
);
canvas.addEventListener("pointerrawupdate", onDiagEvent); // finer-grained where supported

document.getElementById("diagBtn").addEventListener("click", toggleDiag);
document.getElementById("diagClose").addEventListener("click", () => setDiag(false));
document.getElementById("diagResetPeak").addEventListener("click", () => {
  diagPeak = 0;
  document.getElementById("diagPeak").textContent = "0%";
});

// ---- Keyboard shortcuts ----------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    else if (k === "s") { e.preventDefault(); savePage(false); }
    else if (k === "enter") { e.preventDefault(); savePage(true); }
    else if (k === "backspace") { e.preventDefault(); clearPage(); }
    return;
  }

  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;

  switch (e.key) {
    case "p": case "P": applyTool("pen"); break;
    case "h": case "H": applyTool("highlighter"); break;
    case "e": case "E": applyTool("eraser"); break;
    case "l": case "L": applyTool("line"); break;
    case "r": case "R": applyTool("rect"); break;
    case "o": case "O": applyTool("ellipse"); break;
    case "a": case "A": applyTool("arrow"); break;
    case "b": case "B": cycleBackground(); break;
    case "f": case "F": e.preventDefault(); toggleFocus(); break;
    case "n": case "N": toggleNoteMode(); break;
    case "d": case "D": toggleDiag(); break;
    case "Enter": if (noteMode) { e.preventDefault(); commitLine(); } break;
    case "[": e.preventDefault(); nudgeWidth(-1); break;
    case "]": e.preventDefault(); nudgeWidth(1); break;
    case "+": case "=": e.preventDefault(); zoomIn(); break;
    case "-": case "_": e.preventDefault(); zoomOut(); break;
    case "0": e.preventDefault(); resetZoom(); break;
    case "s": case "S": e.preventDefault(); openPages(); break;
    case "?": e.preventDefault(); toggleShortcuts(); break;
  }
});

function nudgeWidth(delta) {
  const min = Number(widthInput.min) || 1;
  const max = Number(widthInput.max) || 16;
  widthInput.value = String(Math.min(max, Math.max(min, Number(widthInput.value) + delta)));
  syncWidthLabel();
  saveSettings();
}

// ---- Helpers ---------------------------------------------------------------
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function formatDate(iso) { const d = new Date(iso); return isNaN(d) ? escapeHtml(iso) : d.toLocaleString(); }
