(async function main() {
  const canvas = document.getElementById("viewCanvas");
  const ctx = canvas.getContext("2d");

  const playBtn = document.getElementById("playBtn");
  const playUse = playBtn.querySelector("use");
  const restartBtn = document.getElementById("restartBtn");
  const scrubber = document.getElementById("scrubber");
  const speedBtn = document.getElementById("speedBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const shareBtn = document.getElementById("shareBtn");

  const res = await fetch(`/api/pages/${window.__PAGE_ID__}`);
  if (!res.ok) {
    document.body.insertAdjacentHTML("beforeend", "<p style='padding:24px'>Failed to load page.</p>");
    return;
  }
  const page = await res.json();

  // Render at full stored resolution; CSS scales it to fit the viewport.
  canvas.width = page.width;
  canvas.height = page.height;
  canvas.style.aspectRatio = `${page.width} / ${page.height}`;

  // A dropped background image the page was traced over, if any (drawn under ink).
  let bgImageEl = null;
  if (page.bgImage) {
    const im = new Image();
    im.onload = () => { bgImageEl = im; renderAt(elapsed); };
    im.src = page.bgImage;
  }

  // Build a global replay timeline: each stroke's points carry timestamps
  // relative to that stroke's start, so we lay strokes end-to-end with a gap.
  const GAP = 160;
  const timeline = [];
  let acc = 0;
  for (const s of page.strokes) {
    const dur = s.points.length ? Math.max(1, s.points[s.points.length - 1].t) : 1;
    timeline.push({ stroke: s, start: acc, dur });
    acc += dur + GAP;
  }
  const total = Math.max(1, acc);

  let elapsed = total;       // start fully drawn
  let playing = false;
  let speed = 1;
  let lastFrame = 0;

  function renderAt(ms) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (bgImageEl) drawBgImage(ctx, bgImageEl, canvas.width, canvas.height);
    drawBackground(ctx, canvas.width, canvas.height, page.background || "blank");
    for (const item of timeline) {
      if (ms >= item.start + item.dur) {
        drawStroke(ctx, item.stroke);
      } else if (ms > item.start) {
        const localT = ms - item.start;
        const s = item.stroke;
        let count = 1;
        for (let i = 0; i < s.points.length; i++) { if (s.points[i].t <= localT) count = i + 1; }
        drawStrokePartial(ctx, s, count);
      }
    }
  }

  function setScrubber() { scrubber.value = String(Math.round((elapsed / total) * 1000)); }
  function setPlayIcon() { playUse.setAttribute("href", playing ? "#i-pause" : "#i-play"); }

  function frame(now) {
    if (!playing) return;
    const dt = (now - lastFrame) * speed;
    lastFrame = now;
    elapsed += dt;
    if (elapsed >= total) { elapsed = total; playing = false; setPlayIcon(); }
    renderAt(elapsed);
    setScrubber();
    if (playing) requestAnimationFrame(frame);
  }

  function play() {
    if (elapsed >= total) elapsed = 0; // replay from the top
    playing = true;
    setPlayIcon();
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
  function pause() { playing = false; setPlayIcon(); }

  playBtn.addEventListener("click", () => (playing ? pause() : play()));
  restartBtn.addEventListener("click", () => { elapsed = 0; play(); });
  speedBtn.addEventListener("click", () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    speedBtn.textContent = speed + "×";
  });
  scrubber.addEventListener("input", () => {
    pause();
    elapsed = (Number(scrubber.value) / 1000) * total;
    renderAt(elapsed);
  });
  downloadBtn.addEventListener("click", () => {
    renderAt(total); // ensure the full page is drawn
    elapsed = total; setScrubber();
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (page.title || "pen-pad").replace(/[^\w.-]+/g, "_").slice(0, 60) + ".png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  });
  shareBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      shareBtn.title = "Link copied ✓";
    } catch { shareBtn.title = "Copy failed"; }
  });

  // ---- Claude text extraction panel --------------------------------------
  // Extraction runs automatically on the server when a page is saved: it renders
  // the ink to a PNG and has the Claude CLI read it (native vision → text +
  // optional Mermaid), storing the result on the page. This panel reflects that
  // — it shows the stored result, live-updates while a background extraction is
  // still running, and offers a manual re-run.
  const extractBtn = document.getElementById("extractBtn");
  const extractPanel = document.getElementById("extractPanel");
  const extractClose = document.getElementById("extractClose");
  const extractRun = document.getElementById("extractRun");
  const extractStatus = document.getElementById("extractStatus");
  const extractTextEl = document.getElementById("extractText");
  const extractTextLabel = document.getElementById("extractTextLabel");
  const extractMermaidEl = document.getElementById("extractMermaid");
  const extractMermaidLabel = document.getElementById("extractMermaidLabel");
  const extractAnswerEl = document.getElementById("extractAnswer");
  const extractAnswerLabel = document.getElementById("extractAnswerLabel");

  let extractPolling = false;

  function setStatus(msg, isError) {
    extractStatus.textContent = msg;
    extractStatus.className = isError ? "extract-status error" : "extract-status";
  }

  function hasResult(p) {
    return !!(
      (p.ocrText && p.ocrText.trim()) ||
      (p.mermaid && p.mermaid.trim()) ||
      (p.answer && p.answer.trim())
    );
  }

  function showExtractResult(text, mermaid, answer) {
    const hasText = !!(text && text.trim());
    extractTextEl.textContent = hasText ? text : "(no handwriting text found)";
    extractTextEl.hidden = false;
    extractTextLabel.hidden = false;
    const hasMermaid = !!(mermaid && mermaid.trim());
    extractMermaidEl.textContent = hasMermaid ? mermaid : "";
    extractMermaidEl.hidden = !hasMermaid;
    extractMermaidLabel.hidden = !hasMermaid;
    const hasAnswer = !!(answer && answer.trim());
    extractAnswerEl.textContent = hasAnswer ? answer : "";
    extractAnswerEl.hidden = !hasAnswer;
    extractAnswerLabel.hidden = !hasAnswer;
  }

  // Paint the panel to match a page record's extraction state.
  function reflectState(p) {
    if (hasResult(p)) showExtractResult(p.ocrText, p.mermaid, p.answer);
    if (p.extractStatus === "pending") {
      setStatus("Extracting with Claude… this can take a while.");
      extractRun.disabled = true;
      extractRun.textContent = "Extracting…";
    } else if (p.extractStatus === "error") {
      setStatus("Automatic extraction failed — click to retry.", true);
      extractRun.disabled = false;
      extractRun.textContent = "Retry extraction";
    } else if (hasResult(p)) {
      setStatus(p.extractedAt ? "Extracted automatically ✓" : "Showing saved text.");
      extractRun.disabled = false;
      extractRun.textContent = "Re-extract with Claude";
    } else {
      setStatus("No text extracted yet.");
      extractRun.disabled = false;
      extractRun.textContent = "Extract with Claude";
    }
  }

  // While the server is extracting in the background, re-fetch the page until
  // it settles, so the text appears on its own without a reload.
  async function pollExtraction() {
    if (extractPolling) return;
    extractPolling = true;
    try {
      for (let i = 0; i < 60; i++) { // ~3 min ceiling
        await new Promise((r) => setTimeout(r, 3000));
        const rr = await fetch(`/api/pages/${window.__PAGE_ID__}`);
        if (!rr.ok) break;
        const fresh = await rr.json();
        page.ocrText = fresh.ocrText;
        page.mermaid = fresh.mermaid;
        page.answer = fresh.answer;
        page.extractStatus = fresh.extractStatus;
        page.extractedAt = fresh.extractedAt;
        reflectState(fresh);
        if (fresh.extractStatus !== "pending") break;
      }
    } catch (e) {
      setStatus("Lost connection while extracting: " + (e && e.message ? e.message : e), true);
    } finally {
      extractPolling = false;
    }
  }

  function openExtractPanel() {
    extractPanel.hidden = false;
    reflectState(page);
    if (page.extractStatus === "pending") pollExtraction();
  }

  extractBtn.addEventListener("click", openExtractPanel);
  extractClose.addEventListener("click", () => { extractPanel.hidden = true; });

  extractRun.addEventListener("click", async () => {
    extractRun.disabled = true;
    setStatus("Extracting with Claude… this can take a while.");
    try {
      // Send the fully-drawn page (ink + any traced background image) so Claude
      // reads both and can answer questions written in the image.
      renderAt(total);
      elapsed = total; setScrubber();
      const image = canvas.toDataURL("image/png");
      const r = await fetch(`/api/pages/${window.__PAGE_ID__}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
      page.ocrText = data.text;
      page.mermaid = data.mermaid;
      page.answer = data.answer;
      page.extractStatus = data.extractStatus || "done";
      page.extractedAt = new Date().toISOString();
      showExtractResult(data.text, data.mermaid, data.answer);
      setStatus("Done ✓ — saved to the page.");
      extractRun.textContent = "Re-extract with Claude";
    } catch (e) {
      setStatus("Extraction failed: " + (e && e.message ? e.message : e), true);
    } finally {
      extractRun.disabled = false;
    }
  });

  // Auto-surface the result: if the server is extracting (or has extracted)
  // this page, open the panel without a click — that's the point of making
  // extraction automatic.
  if (page.extractStatus === "pending" || hasResult(page)) {
    openExtractPanel();
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === " ") { e.preventDefault(); playing ? pause() : play(); }
  });

  renderAt(elapsed);
  setScrubber();
  setPlayIcon();
})();
