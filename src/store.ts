import fs from "fs";
import path from "path";
import crypto from "crypto";

// This is a minimal file-based store so the app runs with zero external
// dependencies. Swap this module for a MySQL/TypeORM repository later —
// the shape of PageRecord is exactly what you'd put in a `pages` table:
//   id, title, width, height, background, stroke_json, ocr_text, created_at, updated_at

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number; // 0..1, derived from the pen's pressure levels
  tiltX: number;    // degrees, -90..90
  tiltY: number;    // degrees, -90..90
  t: number;         // ms timestamp, relative to stroke start
}

export type ToolKind =
  | "pen"
  | "highlighter"
  | "line"
  | "rect"
  | "ellipse"
  | "arrow";

export interface Stroke {
  id: string;
  tool: ToolKind;   // how the stroke is rendered (defaults to "pen" for old data)
  color: string;
  baseWidth: number;
  points: StrokePoint[]; // freehand path, or [start, end] for shape tools
}

export type PaperBackground = "blank" | "ruled" | "grid" | "dotted";

export interface PageRecord {
  id: string;
  title: string;
  width: number;   // canvas/page width in px, as captured on the client
  height: number;  // canvas/page height in px
  background: PaperBackground;
  strokes: Stroke[];
  ocrText: string | null;
  createdAt: string;
  updatedAt: string;
}

const DATA_DIR = path.join(__dirname, "..", "data", "pages");

// Cache the page-list metadata in memory so we don't re-read and parse every
// page file on each listing. Invalidated whenever a page is written/removed.
type PageMeta = Pick<PageRecord, "id" | "title" | "background" | "createdAt" | "updatedAt">;
let listCache: PageMeta[] | null = null;
function invalidateListCache(): void {
  listCache = null;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Page ids are always crypto.randomUUID() output. Rejecting anything else here
// (rather than just interpolating it into a path) closes off path traversal —
// e.g. an id of "../../../etc/passwd" — for every caller, REST and MCP alike.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function filePath(id: string): string | null {
  if (!UUID_RE.test(id)) return null;
  return path.join(DATA_DIR, `${id}.json`);
}

// Fill in fields that older saved pages may not have, so the rest of the app
// can assume the current shape.
function normalize(record: any): PageRecord {
  return {
    id: record.id,
    title: record.title ?? "Untitled",
    width: record.width,
    height: record.height,
    background: record.background ?? "blank",
    strokes: (record.strokes ?? []).map((s: any) => ({
      id: s.id,
      tool: s.tool ?? "pen",
      color: s.color,
      baseWidth: s.baseWidth,
      points: s.points ?? [],
    })),
    ocrText: record.ocrText ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? record.createdAt,
  };
}

export function createPage(input: {
  title?: string;
  width: number;
  height: number;
  background?: PaperBackground;
  strokes: Stroke[];
  ocrText?: string | null;
}): PageRecord {
  ensureDataDir();
  const now = new Date().toISOString();
  const record: PageRecord = {
    id: crypto.randomUUID(),
    title: input.title?.trim() || `Page ${now}`,
    width: input.width,
    height: input.height,
    background: input.background ?? "blank",
    strokes: input.strokes,
    ocrText: input.ocrText ?? null,
    createdAt: now,
    updatedAt: now,
  };
  // record.id is a freshly generated crypto.randomUUID(), always valid.
  fs.writeFileSync(filePath(record.id) as string, JSON.stringify(record, null, 2));
  invalidateListCache();
  return record;
}

export function updatePage(
  id: string,
  patch: {
    title?: string;
    width?: number;
    height?: number;
    background?: PaperBackground;
    strokes?: Stroke[];
    ocrText?: string | null;
  }
): PageRecord | null {
  const existing = getPage(id);
  if (!existing) return null;
  const updated: PageRecord = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title.trim() || existing.title } : {}),
    ...(patch.width !== undefined ? { width: patch.width } : {}),
    ...(patch.height !== undefined ? { height: patch.height } : {}),
    ...(patch.background !== undefined ? { background: patch.background } : {}),
    ...(patch.strokes !== undefined ? { strokes: patch.strokes } : {}),
    ...(patch.ocrText !== undefined ? { ocrText: patch.ocrText } : {}),
    updatedAt: new Date().toISOString(),
  };
  // id was already validated by the getPage() call above, so filePath(id) here
  // is guaranteed non-null.
  fs.writeFileSync(filePath(id) as string, JSON.stringify(updated, null, 2));
  invalidateListCache();
  return updated;
}

export function deletePage(id: string): boolean {
  ensureDataDir();
  const fp = filePath(id);
  if (!fp || !fs.existsSync(fp)) return false;
  fs.unlinkSync(fp);
  invalidateListCache();
  return true;
}

export function getPage(id: string): PageRecord | null {
  ensureDataDir();
  const fp = filePath(id);
  if (!fp || !fs.existsSync(fp)) return null;
  return normalize(JSON.parse(fs.readFileSync(fp, "utf-8")));
}

export function listPages(): PageMeta[] {
  if (listCache) return listCache;
  ensureDataDir();
  listCache = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => normalize(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8"))))
    .map((r) => ({
      id: r.id,
      title: r.title,
      background: r.background,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return listCache;
}
