import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";

// Server-side handwriting/diagram extraction that replaces a cloud OCR service
// (Textract) with Claude's native vision. It spawns the local Claude Code CLI
// (`claude -p`) — which reads the rendered page image directly and returns
// structured JSON — so there's no separate API key or SDK dependency: it reuses
// whatever auth the CLI already has. The whole page is transcribed at once
// (text + an optional Mermaid diagram), unlike Note Mode's line-by-line OCR.

export interface ExtractResult {
  text: string;
  mermaid: string | null;
}

// `claude` on PATH by default; override for a pinned path or a wrapper.
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
// Empty → let the CLI pick its default model. Set e.g. CLAUDE_EXTRACT_MODEL to
// a cheaper model to trade some handwriting accuracy for cost.
const EXTRACT_MODEL = process.env.CLAUDE_EXTRACT_MODEL || "";
const EXTRACT_TIMEOUT_MS = Number(process.env.CLAUDE_EXTRACT_TIMEOUT_MS || 120000);

function buildPrompt(imagePath: string): string {
  // The image path is a temp file we control (mkdtemp), not user input, and it's
  // passed inside the stdin prompt — never as a shell argument — so there's no
  // command-injection surface here.
  return [
    `Read the image file at ${imagePath}.`,
    "It is a single page of handwritten notes and/or sketches captured from a pen tablet (dark ink on white paper).",
    "Transcribe the page.",
    "Respond with ONLY a single JSON object and nothing else — no prose, no markdown fences. Use exactly these keys:",
    '{"text": <string>, "mermaid": <string|null>}',
    '- "text": the handwriting transcribed as plain text, preserving line breaks as \\n. Use an empty string if there is no writing.',
    '- "mermaid": Mermaid diagram source (e.g. a flowchart) ONLY if the page clearly depicts a diagram — boxes/arrows/flow. Otherwise null. Do not invent a diagram for plain prose.',
  ].join("\n");
}

// Run the CLI, feeding the prompt on stdin so the (multi-line) prompt never has
// to be shell-quoted. On Windows `claude` is a .cmd shim, which Node can only
// launch through a shell, so enable shell there; every other arg is a
// space-free flag token, so there's nothing for the shell to mis-split.
function runClaude(args: string[], cwd: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`claude extraction timed out after ${EXTRACT_TIMEOUT_MS}ms`));
    }, EXTRACT_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(`claude CLI not found (looked for "${CLAUDE_BIN}"). Set CLAUDE_BIN to its path.`));
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.trim() || stdout.trim() || "(no output)"}`));
      }
    });

    child.stdin.on("error", () => {
      /* ignore EPIPE if the child exits before we finish writing */
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Pull the assistant's final text out of the CLI's `--output-format json` output.
// Depending on CLI version this is either a single result object or a JSON array
// of streamed events ending in one with type "result"; handle both.
function resultText(stdout: string): string {
  let env: unknown;
  try {
    env = JSON.parse(stdout);
  } catch {
    throw new Error(`claude output was not valid JSON: ${stdout.slice(0, 300)}`);
  }
  const obj: any = Array.isArray(env)
    ? env.find((e) => e && (e as any).type === "result") ?? env[env.length - 1]
    : env;
  if (!obj) throw new Error("claude output had no result object");
  if (obj.is_error) {
    throw new Error(`claude reported an error: ${obj.result || obj.subtype || "unknown"}`);
  }
  return typeof obj.result === "string" ? obj.result : "";
}

// The model was asked for a bare JSON object, but be tolerant of it wrapping the
// answer in a ```json fence or adding stray prose around it.
function parseInner(raw: string): ExtractResult {
  let text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  const candidates = [text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      return {
        text: typeof obj.text === "string" ? obj.text : "",
        mermaid: typeof obj.mermaid === "string" && obj.mermaid.trim() ? obj.mermaid : null,
      };
    } catch {
      /* try the next candidate */
    }
  }

  // Couldn't recover JSON — fall back to treating the whole reply as the text.
  return { text: raw.trim(), mermaid: null };
}

export async function extractPageImage(png: Buffer): Promise<ExtractResult> {
  // Write the image as a single temp file (not a subdir) and run the CLI with a
  // neutral, long-lived cwd (tmpdir). On Windows a process locks its cwd for its
  // lifetime, so pointing cwd at a dir we then delete races into EBUSY on rmdir;
  // keeping the cwd stable and cleaning up just the one file avoids that.
  const imagePath = path.join(tmpdir(), `pad-extract-${randomUUID()}.png`);
  try {
    writeFileSync(imagePath, png);
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Read",
    ];
    if (EXTRACT_MODEL) args.push("--model", EXTRACT_MODEL);

    const stdout = await runClaude(args, tmpdir(), buildPrompt(imagePath));
    return parseInner(resultText(stdout));
  } finally {
    // Best-effort — a cleanup failure must never mask a successful extraction.
    try {
      unlinkSync(imagePath);
    } catch {
      /* leave the temp file for the OS to reap */
    }
  }
}
