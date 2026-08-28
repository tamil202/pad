import { readFileSync } from "fs";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { PageRecord } from "./store";
import { renderPageSVG } from "./render-svg";

// Shared server-side page rasterizer. Both the MCP `get_page_image` tool and the
// Claude extraction pipeline need a PNG of a page's ink, so the resvg-wasm setup
// lives here once rather than being duplicated per caller.
//
// resvg-wasm needs its .wasm binary loaded once before first use. Reading it from
// disk (rather than fetch()) keeps this working with no network access — the same
// offline-first approach as the Note Mode OCR vendoring.
let wasmReady: Promise<void> | null = null;
function ensureResvgWasm(): Promise<void> {
  return (wasmReady ??= initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
}

type RenderablePage = Pick<PageRecord, "width" | "height" | "background" | "strokes">;

export function renderPageSvgMarkup(page: RenderablePage): string {
  return renderPageSVG(page.width, page.height, page.background, page.strokes);
}

// Rasterize a page's strokes to a PNG buffer (white paper + ink), ready to hand
// to Claude's vision as an image file or to serve directly.
export async function renderPagePng(page: RenderablePage): Promise<Buffer> {
  await ensureResvgWasm();
  const svg = renderPageSVG(page.width, page.height, page.background, page.strokes);
  return Buffer.from(new Resvg(svg).render().asPng());
}
