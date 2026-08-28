import { PaperBackground, Stroke } from "./store";

// Mirrors public/client.js's strokesToSVG(), so a page looks the same whether
// exported from the browser or rendered here for the MCP image tool. Strokes
// can arrive from a remote MCP store_page/update_page call, so — unlike the
// browser version, which only ever renders the user's own trusted ink —
// string fields are escaped before landing in markup.
function esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

export function renderPageSVG(
  width: number,
  height: number,
  background: PaperBackground,
  strokes: Stroke[]
): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  parts.push(`<defs>
    <pattern id="ruled" width="40" height="40" patternUnits="userSpaceOnUse"><line x1="0" y1="39.5" x2="40" y2="39.5" stroke="#d7e3f4"/></pattern>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#e2e8f0"/></pattern>
    <pattern id="dotted" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="40" cy="40" r="1.4" fill="#cbd5e1"/></pattern>
  </defs>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  if (background !== "blank") parts.push(`<rect width="${width}" height="${height}" fill="url(#${background})"/>`);

  for (const s of strokes) {
    if (!s.points.length) continue;
    const a = s.points[0];
    const b = s.points[s.points.length - 1];
    const color = esc(s.color);
    if (s.tool === "rect") {
      parts.push(
        `<rect x="${r(Math.min(a.x, b.x))}" y="${r(Math.min(a.y, b.y))}" width="${r(Math.abs(b.x - a.x))}" height="${r(Math.abs(b.y - a.y))}" fill="none" stroke="${color}" stroke-width="${s.baseWidth}"/>`
      );
    } else if (s.tool === "ellipse") {
      parts.push(
        `<ellipse cx="${r((a.x + b.x) / 2)}" cy="${r((a.y + b.y) / 2)}" rx="${r(Math.abs(b.x - a.x) / 2)}" ry="${r(Math.abs(b.y - a.y) / 2)}" fill="none" stroke="${color}" stroke-width="${s.baseWidth}"/>`
      );
    } else if (s.tool === "line" || s.tool === "arrow") {
      parts.push(
        `<line x1="${r(a.x)}" y1="${r(a.y)}" x2="${r(b.x)}" y2="${r(b.y)}" stroke="${color}" stroke-width="${s.baseWidth}" stroke-linecap="round"/>`
      );
    } else {
      const d = s.points.map((p, i) => `${i ? "L" : "M"}${r(p.x)} ${r(p.y)}`).join(" ");
      const opacity = s.tool === "highlighter" ? 0.4 : 1;
      const strokeWidth = s.tool === "highlighter" ? Math.max(6, s.baseWidth * 4) : Math.max(1, s.baseWidth);
      parts.push(
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`
      );
    }
  }
  parts.push("</svg>");
  return parts.join("");
}
