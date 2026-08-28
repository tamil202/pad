import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { z } from "zod";
import {
  createPage,
  getPage,
  listPages,
  updatePage,
  deletePage,
  Stroke,
} from "./store";
import { renderPageSVG } from "./render-svg";

// resvg-wasm needs its .wasm binary loaded once before first use. Reading it
// from disk (rather than fetch()) keeps this working with no network access,
// same offline-first approach as the Note Mode OCR vendoring.
let wasmReady: Promise<void> | null = null;
function ensureResvgWasm(): Promise<void> {
  if (!wasmReady) {
    const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
    wasmReady = initWasm(readFileSync(wasmPath));
  }
  return wasmReady;
}

const strokePointSchema = z.object({
  x: z.number(),
  y: z.number(),
  pressure: z.number().optional().default(0.5),
  tiltX: z.number().optional().default(0),
  tiltY: z.number().optional().default(0),
  t: z.number().optional().default(0),
});

const strokeSchema = z.object({
  id: z.string().optional(),
  tool: z.enum(["pen", "highlighter", "line", "rect", "ellipse", "arrow"]).default("pen"),
  color: z.string(),
  baseWidth: z.number(),
  points: z.array(strokePointSchema).min(1),
});

const backgroundSchema = z.enum(["blank", "ruled", "grid", "dotted"]);

function notFound(id: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `No page found with id "${id}"` }] };
}

export function createPadMcpServer(): McpServer {
  const server = new McpServer({ name: "pen-pad", version: "1.0.0" });

  server.registerTool(
    "list_pages",
    {
      description:
        "List saved Pen Pad pages (id, title, background, timestamps), optionally filtered by a search query matched against the title or extracted handwriting text.",
      inputSchema: {
        q: z.string().optional().describe("Search text to filter by title or extracted (OCR) text"),
      },
    },
    async ({ q }) => {
      let pages = listPages();
      if (q) {
        const needle = q.toLowerCase();
        pages = pages.filter((p) => {
          if (p.title.toLowerCase().includes(needle)) return true;
          const full = getPage(p.id);
          return !!full?.ocrText && full.ocrText.toLowerCase().includes(needle);
        });
      }
      return { content: [{ type: "text", text: JSON.stringify(pages, null, 2) }] };
    }
  );

  server.registerTool(
    "get_page",
    {
      description:
        "Get full details for one saved page: title, dimensions, paper background, stroke count, whether it has extracted text, and timestamps.",
      inputSchema: { id: z.string().describe("Page id") },
    },
    async ({ id }) => {
      const page = getPage(id);
      if (!page) return notFound(id);
      const { strokes, ocrText, ...meta } = page;
      const details = { ...meta, strokeCount: strokes.length, hasExtractedText: !!ocrText };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
    }
  );

  server.registerTool(
    "extract_page_text",
    {
      description:
        "Get the extracted handwriting text for a saved page — the text captured by Note Mode's OCR when the page was written. Returns a note instead if the page has none (it was never written with Note Mode).",
      inputSchema: { id: z.string().describe("Page id") },
    },
    async ({ id }) => {
      const page = getPage(id);
      if (!page) return notFound(id);
      const text = page.ocrText ?? "(no extracted text — this page has no Note Mode OCR text saved)";
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "get_page_image",
    {
      description:
        "Render a saved page's ink strokes as an image, for viewing the page's actual content (layout, drawings, handwriting shapes). Returns a PNG by default, or raw SVG markup.",
      inputSchema: {
        id: z.string().describe("Page id"),
        format: z.enum(["png", "svg"]).optional().describe('Image format, default "png"'),
      },
    },
    async ({ id, format }) => {
      const page = getPage(id);
      if (!page) return notFound(id);
      const svg = renderPageSVG(page.width, page.height, page.background, page.strokes);
      if (format === "svg") {
        return { content: [{ type: "text", text: svg }] };
      }
      await ensureResvgWasm();
      const png = new Resvg(svg).render().asPng();
      return { content: [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }] };
    }
  );

  server.registerTool(
    "store_page",
    {
      description: "Save a new Pen Pad page from stroke data.",
      inputSchema: {
        title: z.string().optional(),
        width: z.number(),
        height: z.number(),
        background: backgroundSchema.optional(),
        strokes: z.array(strokeSchema),
        ocrText: z.string().nullable().optional(),
      },
    },
    async ({ title, width, height, background, strokes, ocrText }) => {
      const page = createPage({
        title,
        width,
        height,
        background,
        strokes: strokes as Stroke[],
        ocrText: ocrText ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify({ id: page.id, createdAt: page.createdAt }) }] };
    }
  );

  server.registerTool(
    "update_page",
    {
      description: "Update an existing Pen Pad page — rename it, replace its strokes, change its background, or update its extracted text.",
      inputSchema: {
        id: z.string().describe("Page id"),
        title: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        background: backgroundSchema.optional(),
        strokes: z.array(strokeSchema).optional(),
        ocrText: z.string().nullable().optional(),
      },
    },
    async ({ id, ...patch }) => {
      const updated = updatePage(id, { ...patch, strokes: patch.strokes as Stroke[] | undefined });
      if (!updated) return notFound(id);
      return { content: [{ type: "text", text: JSON.stringify({ id: updated.id, updatedAt: updated.updatedAt }) }] };
    }
  );

  server.registerTool(
    "delete_page",
    {
      description: "Permanently delete a saved page.",
      inputSchema: { id: z.string().describe("Page id") },
    },
    async ({ id }) => {
      const ok = deletePage(id);
      if (!ok) return notFound(id);
      return { content: [{ type: "text", text: `Deleted page ${id}` }] };
    }
  );

  return server;
}
