import express, { NextFunction, Request, Response } from "express";
import path from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createPage,
  getPage,
  listPages,
  updatePage,
  deletePage,
  Stroke,
  PaperBackground,
} from "./store";
import { createPadMcpServer } from "./mcp";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const isProd = process.env.NODE_ENV === "production";

// Remote MCP access — bearer-token auth. Set MCP_AUTH_TOKEN explicitly (e.g.
// in docker-compose.yml) so it survives restarts; otherwise a fresh one is
// generated and logged once per boot.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || randomBytes(24).toString("hex");
if (!process.env.MCP_AUTH_TOKEN) {
  console.log("\n[mcp] MCP_AUTH_TOKEN not set — generated a token for this run:");
  console.log(`[mcp]   ${MCP_AUTH_TOKEN}`);
  console.log("[mcp] Set MCP_AUTH_TOKEN yourself to keep this stable across restarts.\n");
}

function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const [scheme, token] = (req.header("authorization") || "").split(" ");
  const expected = Buffer.from(MCP_AUTH_TOKEN);
  const provided = Buffer.from(token || "");
  const ok = scheme === "Bearer" && provided.length === expected.length && timingSafeEqual(provided, expected);
  if (!ok) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  next();
}

app.disable("x-powered-by");
app.set("etag", "strong"); // 304 revalidation instead of re-sending unchanged bodies

// A full page of strokes can be sizeable, but keep the ceiling modest so a
// runaway request can't exhaust a Pi's limited RAM.
app.use(express.json({ limit: "16mb" }));

// Serve the static front-end. In production, let the browser cache the JS/CSS/
// assets for a day (with etag revalidation) so a Pi isn't re-sending them on
// every visit; HTML is always revalidated so updates show up immediately.
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    etag: true,
    maxAge: isProd ? "1d" : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  })
);

// ---- API ----------------------------------------------------------------

// Save a new (finished or in-progress) page
app.post("/api/pages", (req: Request, res: Response) => {
  const { title, width, height, background, strokes, ocrText } = req.body as {
    title?: string;
    width?: number;
    height?: number;
    background?: PaperBackground;
    strokes?: Stroke[];
    ocrText?: string | null;
  };

  if (!width || !height || !Array.isArray(strokes)) {
    return res.status(400).json({ error: "width, height and strokes[] are required" });
  }

  const page = createPage({ title, width, height, background, strokes, ocrText });
  res.status(201).json({ id: page.id });
});

// List saved pages. Supports ?q= to filter by title or OCR text.
app.get("/api/pages", (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim().toLowerCase();
  let pages = listPages();
  if (q) {
    pages = pages.filter((p) => {
      if (p.title.toLowerCase().includes(q)) return true;
      const full = getPage(p.id);
      return !!full?.ocrText && full.ocrText.toLowerCase().includes(q);
    });
  }
  res.json(pages);
});

// Fetch one page's full stroke JSON
app.get("/api/pages/:id", (req: Request, res: Response) => {
  const page = getPage(req.params.id);
  if (!page) return res.status(404).json({ error: "not found" });
  res.json(page);
});

// Update an existing page (edit strokes, rename, change background, store OCR)
app.put("/api/pages/:id", (req: Request, res: Response) => {
  const { title, width, height, background, strokes, ocrText } = req.body as {
    title?: string;
    width?: number;
    height?: number;
    background?: PaperBackground;
    strokes?: Stroke[];
    ocrText?: string | null;
  };
  const updated = updatePage(req.params.id, {
    title,
    width,
    height,
    background,
    strokes,
    ocrText,
  });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json({ id: updated.id, updatedAt: updated.updatedAt });
});

// Delete a page
app.delete("/api/pages/:id", (req: Request, res: Response) => {
  const ok = deletePage(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.status(204).end();
});

// ---- Remote MCP server ----------------------------------------------------
// Stateless Streamable HTTP: each request gets a fresh server+transport pair,
// so there's no session store to manage — the right fit for a single-user
// personal deployment.

app.post("/mcp", requireMcpAuth, async (req: Request, res: Response) => {
  try {
    const mcpServer = createPadMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/mcp", requireMcpAuth, (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

app.delete("/mcp", requireMcpAuth, (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

// ---- Server-rendered "show the full page" view ---------------------------
// Dynamic, not a static site — the whole point is that every page's content
// differs, so there's nothing to pre-build.

app.get("/page/:id", (req: Request, res: Response) => {
  const page = getPage(req.params.id);
  if (!page) return res.status(404).send("Page not found");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(page.title)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <symbol id="i-eye" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></symbol>
      <symbol id="i-back" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></symbol>
      <symbol id="i-play" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></symbol>
      <symbol id="i-pause" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></symbol>
      <symbol id="i-restart" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></symbol>
      <symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></symbol>
      <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></symbol>
    </defs>
  </svg>

  <header class="viewer-header">
    <span class="brand-mark"><svg class="icon"><use href="#i-eye" /></svg></span>
    <h1>${escapeHtml(page.title)}</h1>
    <span class="spacer"></span>

    <div class="replay">
      <button id="playBtn" class="icon-only" title="Play / pause replay (Space)" aria-label="Play"><svg class="icon"><use href="#i-play" /></svg></button>
      <button id="restartBtn" class="icon-only" title="Restart replay" aria-label="Restart"><svg class="icon"><use href="#i-restart" /></svg></button>
      <input id="scrubber" type="range" min="0" max="1000" value="1000" title="Scrub replay" />
      <button id="speedBtn" class="icon-only wide" title="Playback speed">1×</button>
    </div>

    <button id="downloadBtn" class="icon-only" title="Download PNG" aria-label="Download PNG"><svg class="icon"><use href="#i-download" /></svg></button>
    <button id="shareBtn" class="icon-only" title="Copy share link" aria-label="Copy link"><svg class="icon"><use href="#i-link" /></svg></button>
    <a href="/" class="btn-link" title="Back to pad"><svg class="icon"><use href="#i-back" /></svg><span class="label">Back</span></a>
  </header>

  <main class="viewer-main">
    <div class="paper">
      <canvas id="viewCanvas"></canvas>
    </div>
  </main>
  <script>
    window.__PAGE_ID__ = ${JSON.stringify(page.id)};
  </script>
  <script src="/render.js"></script>
  <script src="/view.js"></script>
</body>
</html>`);
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

app.listen(PORT, () => {
  console.log(`Pad app running at http://localhost:${PORT}`);
});
