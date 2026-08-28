// Shared between client.js (live drawing) and view.js (replay of a saved page)
// so what you see while writing matches exactly what gets shown at the end.

/**
 * Draw one stroke onto a 2D canvas context. Dispatches on stroke.tool:
 *  - pen / highlighter: freehand path (pressure + tilt vary the pen width)
 *  - line / rect / ellipse / arrow: geometric shape from first→last point
 */
function drawStroke(ctx, stroke) {
  drawStrokePartial(ctx, stroke, stroke.points.length);
}

/**
 * Like drawStroke, but only renders points [from, upto). `from` lets the live
 * pen draw ONLY the newly-added segments each move instead of repainting the
 * whole stroke — an O(1)-per-move cost that matters on low-power devices
 * (e.g. a Raspberry Pi). Shapes/highlighter always render whole (from ignored).
 */
function drawStrokePartial(ctx, stroke, upto, from) {
  const tool = stroke.tool || "pen";
  const pts = stroke.points;
  const n = Math.min(upto, pts.length);
  from = from || 0;
  if (n === 0) return;

  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "arrow") {
    drawShape(ctx, stroke, pts[0], pts[n - 1]);
    ctx.restore();
    return;
  }

  if (tool === "highlighter") {
    ctx.globalAlpha = 0.4;
    ctx.globalCompositeOperation = "multiply";
    ctx.lineWidth = Math.max(6, stroke.baseWidth * 4);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (n === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y); // a lone dot
    ctx.stroke();
    ctx.restore();
    return;
  }

  // pen (default): pressure/tilt-varied width, smoothed through midpoints
  if (n === 1 && from === 0) {
    const p = pts[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, penWidth(stroke.baseWidth, p) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  for (let i = Math.max(1, from); i < n; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const mid = { x: (prev.x + curr.x) / 2, y: (prev.y + curr.y) / 2 };
    ctx.beginPath();
    ctx.lineWidth = penWidth(stroke.baseWidth, curr);
    ctx.moveTo(prev.x, prev.y);
    ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShape(ctx, stroke, a, b) {
  ctx.lineWidth = Math.max(1, stroke.baseWidth);
  const tool = stroke.tool;
  if (tool === "line" || tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (tool === "arrow") {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(10, stroke.baseWidth * 3);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 6), b.y - head * Math.sin(ang - Math.PI / 6));
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 6), b.y - head * Math.sin(ang + Math.PI / 6));
      ctx.stroke();
    }
  } else if (tool === "rect") {
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (tool === "ellipse") {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Pen width from pressure AND tilt: a firmer press or a more upright pen gives
// a wider mark, mimicking a real nib/brush (HUION reports tilt in degrees).
function penWidth(baseWidth, p) {
  const pressure = Number.isFinite(p.pressure) && p.pressure > 0 ? p.pressure : 0.5;
  const tilt = Math.min(90, Math.hypot(p.tiltX || 0, p.tiltY || 0));
  const tiltFactor = 1 + (tilt / 90) * 0.6; // leaning the pen broadens the stroke
  return Math.max(0.75, baseWidth * (0.4 + pressure * 1.2) * tiltFactor);
}

function drawAllStrokes(ctx, strokes, width, height, background, bgImage) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  if (bgImage) drawBgImage(ctx, bgImage, width, height);
  drawBackground(ctx, width, height, background || "blank");
  for (const stroke of strokes) drawStroke(ctx, stroke);
}

// A dropped background image to trace/annotate over: fit the whole image inside
// the page (contain), centred, drawn under the paper lines and ink.
function drawBgImage(ctx, img, width, height) {
  if (!img || !img.width || !img.height) return;
  const scale = Math.min(width / img.width, height / img.height);
  const w = img.width * scale, h = img.height * scale;
  try { ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h); } catch (e) { /* image not ready */ }
}

// Ruled / grid / dotted paper, drawn under the ink.
function drawBackground(ctx, width, height, background) {
  if (background === "blank") return;
  const step = 40;
  ctx.save();
  if (background === "ruled") {
    ctx.strokeStyle = "#d7e3f4";
    ctx.lineWidth = 1;
    for (let y = step; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }
  } else if (background === "grid") {
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    for (let x = step; x < width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
    for (let y = step; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }
  } else if (background === "dotted") {
    ctx.fillStyle = "#cbd5e1";
    for (let x = step; x < width; x += step) {
      for (let y = step; y < height; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
