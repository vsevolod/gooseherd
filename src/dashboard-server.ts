import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, access as fsAccess } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { RunStore } from "./store.js";
import type { RunManager } from "./run-manager.js";
import type { RunFeedback, RunRecord } from "./types.js";
import { parseRunLog, getEventStats } from "./log-parser.js";
import type { ObserverEventRecord, ObserverStateSnapshot, TriggerRule } from "./observer/types.js";
import type { ChatMessage } from "./llm/caller.js";

/** Lean interface — dashboard only reads observer state, never mutates it. */
export interface DashboardObserver {
  getStateSnapshot(): ObserverStateSnapshot;
  getRecentEvents(limit?: number): ObserverEventRecord[];
  getRules(): TriggerRule[];
}

/** Optional source for in-memory orchestrator thread messages. */
export interface DashboardConversationSource {
  get(threadKey: string): ChatMessage[] | undefined;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, text: string, contentType = "text/plain"): void {
  res.statusCode = status;
  res.setHeader("content-type", `${contentType}; charset=utf-8`);
  res.end(text);
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 100;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return 100;
  }
  return Math.min(parsed, 500);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readLogTail(logPath: string, lineCount: number): Promise<string> {
  const content = await readFile(logPath, "utf8");
  const lines = content.split("\n");
  return lines.slice(-Math.max(1, lineCount)).join("\n");
}

/** Read log from a byte offset. Returns new content and the new offset. */
async function readLogFromOffset(logPath: string, offset: number): Promise<{ content: string; newOffset: number }> {
  const { open } = await import("node:fs/promises");
  const { stat } = await import("node:fs/promises");
  const fileStats = await stat(logPath);
  const fileSize = fileStats.size;

  if (offset >= fileSize) {
    return { content: "", newOffset: fileSize };
  }

  const fh = await open(logPath, "r");
  try {
    const readSize = fileSize - offset;
    const buffer = Buffer.alloc(readSize);
    await fh.read(buffer, 0, readSize, offset);
    return { content: buffer.toString("utf8"), newOffset: fileSize };
  } finally {
    await fh.close();
  }
}

interface ConversationPreviewMessage {
  role: "user" | "assistant";
  content: string;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function chatMessageToText(message: ChatMessage): string | null {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "image_url") return "[image]";
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return null;
  }

  if (message.role === "assistant") {
    return typeof message.content === "string" ? message.content : null;
  }

  return null;
}

function buildConversationPreview(messages: ChatMessage[]): ConversationPreviewMessage[] {
  const preview: ConversationPreviewMessage[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = chatMessageToText(message)?.trim();
    if (!text) continue;
    preview.push({
      role: message.role,
      content: truncateText(text, 2000)
    });
  }

  return preview;
}

// ── Authentication helpers ──

/** Hash a token for session cookies (SHA-256, hex). */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Parse cookies from request header. */
function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers["cookie"] ?? "";
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
    }
  }
  return cookies;
}

/** Timing-safe token comparison. */
function safeTokenCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Check if a request is authenticated.
 * Returns true if auth passes, false if the response has been handled (401/redirect).
 */
export function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  dashboardToken: string | undefined,
  pathname: string
): boolean {
  // No token configured → no auth required (backward compat for localhost dev)
  if (!dashboardToken) return true;

  // Health check always passes
  if (pathname === "/healthz") return true;

  // Login routes always pass
  if (pathname === "/login") return true;

  // Check Bearer token for API routes
  if (pathname.startsWith("/api/")) {
    const authHeader = req.headers["authorization"] ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (safeTokenCompare(token, dashboardToken)) return true;
    }

    // Also accept session cookie for API routes (dashboard JS calls)
    const cookies = parseCookies(req);
    const sessionHash = cookies["gooseherd-session"];
    if (sessionHash && safeTokenCompare(sessionHash, hashToken(dashboardToken))) {
      return true;
    }

    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }

  // HTML pages: check session cookie
  const cookies = parseCookies(req);
  const sessionHash = cookies["gooseherd-session"];
  if (sessionHash && safeTokenCompare(sessionHash, hashToken(dashboardToken))) {
    return true;
  }

  // Redirect to login page
  res.statusCode = 302;
  res.setHeader("location", "/login");
  res.end();
  return false;
}

/** Render the login page. */
function loginPageHtml(config: AppConfig, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${config.appName} — Login</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: "Space Grotesk", system-ui, sans-serif;
      background: #060a14;
      color: #e2e8f0;
    }
    .login-card {
      background: #0f172a;
      border: 1px solid #22314f;
      border-radius: 16px;
      padding: 40px 36px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 14px 36px rgba(1,6,18,0.55);
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { color: #94a3b8; font-size: 13px; margin: 0 0 24px; }
    .error { color: #ef4444; font-size: 13px; margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      border: 1px solid #22314f;
      border-radius: 8px;
      background: #0a1325;
      color: #e2e8f0;
      outline: none;
    }
    input[type="password"]:focus { border-color: #60a5fa; }
    button {
      margin-top: 16px;
      width: 100%;
      padding: 10px;
      border: none;
      border-radius: 8px;
      background: #2563eb;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <form class="login-card" method="POST" action="/login">
    <h1>${config.appName}</h1>
    <p>Enter your dashboard token to continue.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <label for="token">Token</label>
    <input type="password" id="token" name="token" autofocus required />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

async function captureCommand(command: string, cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout });
    });
    child.on("error", () => {
      resolve({ code: 1, stdout: "" });
    });
  });
}

async function getChangedFiles(config: AppConfig, run: RunRecord): Promise<string[]> {
  if (run.changedFiles && run.changedFiles.length > 0) {
    return run.changedFiles;
  }

  // Only fall back to git if the run actually committed (has a commitSha)
  if (!run.commitSha) {
    return [];
  }

  const repoDir = path.resolve(config.workRoot, run.id, "repo");
  const result = await captureCommand("git show --name-only --pretty='' HEAD", repoDir);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("---"));
}

interface FileChangeDetail {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
  additions: number;
  deletions: number;
}

async function getChangedFilesDetailed(config: AppConfig, run: RunRecord): Promise<FileChangeDetail[]> {
  // Only show file changes if the run actually produced a commit
  if (!run.commitSha) {
    return [];
  }

  const repoDir = path.resolve(config.workRoot, run.id, "repo");

  // Get line counts: additions\tdeletions\tpath
  const numstat = await captureCommand("git diff --numstat HEAD~1 HEAD 2>/dev/null", repoDir);
  // Get status: A/M/D\tpath
  const nameStatus = await captureCommand("git diff --name-status HEAD~1 HEAD 2>/dev/null", repoDir);

  if (numstat.code !== 0 || nameStatus.code !== 0) {
    // Fallback to simple file list
    const files = await getChangedFiles(config, run);
    return files.map((f) => ({ path: f, status: "?" as const, additions: 0, deletions: 0 }));
  }

  // Parse name-status into a lookup map
  const statusMap = new Map<string, string>();
  for (const line of nameStatus.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length >= 2) {
      const status = parts[0].charAt(0);
      const filePath = parts[parts.length - 1];
      statusMap.set(filePath, status);
    }
  }

  // Parse numstat for line counts
  const results: FileChangeDetail[] = [];
  for (const line of numstat.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length >= 3) {
      const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
      const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
      const filePath = parts[2];
      const rawStatus = statusMap.get(filePath) ?? "M";
      const status = (["A", "M", "D", "R"].includes(rawStatus) ? rawStatus : "?") as FileChangeDetail["status"];
      results.push({ path: filePath, status, additions, deletions });
    }
  }

  return results;
}

function dashboardHtml(config: AppConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${config.appName} Runs</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
    rel="stylesheet"
  />
  <link
    href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,500,0,0"
    rel="stylesheet"
  />
  <style>
    :root {
      --font-ui: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      --font-mono: "IBM Plex Mono", "SF Mono", "JetBrains Mono", monospace;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
      --running: #38bdf8;
      --ring: #60a5fa;
      --radius: 12px;
    }
    html[data-theme="dark"] {
      --bg: #060a14;
      --bg-gradient: radial-gradient(circle at top right, #18233f, #060a14 58%);
      --panel: #0f172a;
      --panel-2: #111d34;
      --panel-3: #0a1325;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
      --running: #38bdf8;
      --border: #22314f;
      --border-strong: #2f4672;
      --shadow: 0 14px 36px rgba(1, 6, 18, 0.55);
      --button-bg: #0b1220;
      --button-bg-hover: #111b2d;
      --button-danger-bg: #301218;
      --button-danger-hover: #421821;
      --badge-bg: #121e37;
      --badge-text: #bfdbfe;
    }
    html[data-theme="light"] {
      --bg: #f7fafc;
      --bg-gradient: radial-gradient(circle at top right, #dbe7f7, #f7fafc 60%);
      --panel: #ffffff;
      --panel-2: #f4f8ff;
      --panel-3: #f8fbff;
      --text: #0f172a;
      --muted: #475569;
      --border: #c8d5ea;
      --border-strong: #9db7dc;
      --shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
      --button-bg: #f8fbff;
      --button-bg-hover: #eef5ff;
      --button-danger-bg: #fee2e2;
      --button-danger-hover: #fecaca;
      --badge-bg: #e7f0ff;
      --badge-text: #1d4ed8;
    }
    * { box-sizing: border-box; }
    /* Thin scrollbars — Moltis style */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.12);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
    * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.12) transparent; }
    body {
      margin: 0;
      font-family: var(--font-ui);
      background: var(--bg-gradient);
      color: var(--text);
      overflow: hidden;
    }
    .app {
      height: 100vh;
      display: grid;
      grid-template-columns: 340px 1fr;
      grid-template-rows: 64px 1fr;
      grid-template-areas:
        "top top"
        "sidebar main";
      gap: 0;
    }
    .topbar {
      grid-area: top;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 90%, transparent);
      backdrop-filter: blur(10px);
      box-shadow: var(--shadow);
      z-index: 10;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 14px color-mix(in srgb, var(--ok) 45%, transparent);
      flex-shrink: 0;
    }
    .brand h1 {
      font-size: 16px;
      margin: 0;
      line-height: 1.1;
      letter-spacing: 0.2px;
    }
    .brand p {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.2;
    }
    .top-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .top-meta {
      color: var(--muted);
      font-size: 13px;
      margin-right: 2px;
      white-space: nowrap;
    }
    .material-symbols-rounded {
      font-variation-settings:
        "FILL" 0,
        "wght" 500,
        "GRAD" 0,
        "opsz" 24;
      font-size: 18px;
      line-height: 1;
    }
    .theme-switch {
      display: flex;
      border: 1px solid var(--border);
      background: var(--panel-3);
      border-radius: 999px;
      padding: 2px;
      gap: 2px;
    }
    .theme-btn {
      border: 0;
      background: transparent;
      color: var(--muted);
      border-radius: 999px;
      width: 34px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .theme-btn.active {
      color: var(--text);
      background: var(--panel-2);
      border: 1px solid var(--border);
    }
    .top-btn {
      border: 1px solid var(--border);
      background: var(--button-bg);
      color: var(--text);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
      font-family: var(--font-ui);
    }
    .top-btn:hover {
      background: var(--button-bg-hover);
    }
    .top-btn .material-symbols-rounded {
      font-size: 17px;
    }
    .top-btn.danger {
      background: var(--button-danger-bg);
      border-color: color-mix(in srgb, var(--err) 25%, var(--border));
      color: color-mix(in srgb, var(--err) 75%, var(--text));
      min-width: 42px;
      justify-content: center;
    }
    .top-btn.danger:hover {
      background: var(--button-danger-hover);
    }
    .sidebar {
      grid-area: sidebar;
      border-right: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      padding: 14px;
      overflow-y: auto;
    }
    .main {
      grid-area: main;
      padding: 16px;
      overflow-y: auto;
    }
    .stack {
      display: grid;
      gap: 12px;
      min-width: 0;
      width: 100%;
      max-width: none;
    }
    .stack-top {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    .sidebar-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 10px;
      gap: 8px;
    }
    .sidebar-title {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      font-weight: 700;
      color: var(--muted);
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .run-item {
      width: 100%;
      border: 1px solid var(--border);
      background: var(--panel-3);
      color: var(--text);
      border-radius: 10px;
      padding: 10px;
      margin-bottom: 10px;
      text-align: left;
      cursor: pointer;
      transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
    }
    .run-item:hover {
      transform: translateY(-1px);
      border-color: var(--border-strong);
    }
    .run-item.active {
      border-color: var(--ring);
      background: var(--panel-2);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 20%, transparent);
    }
    .run-item-top {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: flex-start;
    }
    .run-item-task {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      flex: 1;
      min-width: 0;
    }
    .run-item-meta {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
      line-height: 1.35;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
    }
    .run-item-meta .sep {
      margin: 0 5px;
      opacity: 0.5;
    }
    .status-pill {
      font-size: 11px;
      font-weight: 700;
      border-radius: 999px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      background: var(--badge-bg);
      color: var(--badge-text);
      text-transform: lowercase;
      letter-spacing: 0.02em;
      line-height: 1.2;
    }
    .status-pill.completed {
      background: color-mix(in srgb, var(--ok) 20%, transparent);
      border-color: color-mix(in srgb, var(--ok) 42%, var(--border));
      color: color-mix(in srgb, var(--ok) 80%, var(--text));
    }
    .status-pill.failed {
      background: color-mix(in srgb, var(--err) 18%, transparent);
      border-color: color-mix(in srgb, var(--err) 40%, var(--border));
      color: color-mix(in srgb, var(--err) 82%, var(--text));
    }
    .status-pill.running,
    .status-pill.validating,
    .status-pill.pushing,
    .status-pill.queued {
      background: color-mix(in srgb, var(--running) 18%, transparent);
      border-color: color-mix(in srgb, var(--running) 40%, var(--border));
      color: color-mix(in srgb, var(--running) 80%, var(--text));
    }
    .status-pill.running::before,
    .status-pill.validating::before,
    .status-pill.pushing::before,
    .status-pill.queued::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      margin-right: 4px;
      vertical-align: middle;
      animation: pulse-dot 1.4s ease-in-out infinite;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.7); }
    }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 700;
      color: var(--running);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .live-badge::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--running);
      animation: pulse-dot 1.4s ease-in-out infinite;
    }
    .phase-progress {
      display: flex;
      gap: 3px;
      margin-top: 8px;
      align-items: center;
    }
    .phase-step {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: var(--border);
      transition: background 300ms ease;
    }
    .phase-step.done { background: var(--ok); }
    .phase-step.active { background: var(--running); animation: pulse-bar 1.4s ease-in-out infinite; }
    .phase-step.warn { background: #f59e0b; }
    .phase-step.fail { background: var(--err); }
    @keyframes pulse-bar {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .card {
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border-radius: var(--radius);
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .summary-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .summary-actions .action-btn {
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding-inline: 9px;
    }
    .summary-actions .action-btn .material-symbols-rounded {
      font-size: 16px;
    }
    .card-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .card-subtitle {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }
    /* Session viewer tabs */
    .session-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      margin: 10px -12px 0;
      padding: 0 12px;
    }
    .session-tab {
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      font-family: var(--font-ui);
      color: var(--muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color 120ms, border-color 120ms;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .session-tab:hover { color: var(--text); }
    .session-tab.active {
      color: var(--text);
      border-bottom-color: var(--ring);
    }
    .tab-count {
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      background: var(--panel-3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1px 5px;
      min-width: 16px;
      text-align: center;
    }
    .session-tab.active .tab-count { color: var(--text); }
    .session-panel {
      display: none;
      padding-top: 12px;
    }
    .session-panel.active { display: block; }
    .session-empty {
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      padding: 24px 12px;
    }
    .console-filter-btn {
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--panel-3);
      color: var(--muted);
      cursor: pointer;
      font-family: var(--font-ui);
      font-weight: 600;
      margin-right: 4px;
      transition: background 80ms, color 80ms;
    }
    .console-filter-btn:hover { background: var(--panel-2); color: var(--text); }
    .console-filter-btn.active { background: var(--panel-2); color: var(--text); border-color: var(--ring); }
    .console-entry {
      padding: 4px 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      display: flex;
      gap: 8px;
      align-items: flex-start;
      line-height: 1.4;
    }
    .console-entry:last-child { border-bottom: none; }
    .console-entry .level {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      min-width: 44px;
      flex-shrink: 0;
      padding-top: 1px;
    }
    .console-entry.error { color: #e53e3e; }
    .console-entry.warning { color: #d69e2e; }
    .console-entry.info { color: #3182ce; }
    .console-entry.log { color: var(--text); }
    .actions-table {
      width: 100%;
      border-collapse: collapse;
    }
    .actions-table th {
      text-align: left;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      border-bottom: 2px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--panel);
    }
    .actions-table td {
      padding: 6px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      vertical-align: top;
    }
    .actions-table tr:last-child td { border-bottom: none; }
    .action-type-pill {
      font-size: 10px;
      font-weight: 700;
      border-radius: 4px;
      padding: 2px 6px;
      background: var(--badge-bg);
      color: var(--badge-text);
      text-transform: lowercase;
      white-space: nowrap;
    }
    .action-type-pill.act { background: color-mix(in srgb, #3b82f6 18%, transparent); color: #60a5fa; }
    .action-type-pill.goto { background: color-mix(in srgb, #8b5cf6 18%, transparent); color: #a78bfa; }
    .action-type-pill.done { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
    .action-type-pill.screenshot { background: color-mix(in srgb, #ec4899 18%, transparent); color: #f472b6; }
    .action-type-pill.extract { background: color-mix(in srgb, #f59e0b 18%, transparent); color: #fbbf24; }
    .network-table {
      width: 100%;
      border-collapse: collapse;
    }
    .network-table th {
      text-align: left;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      border-bottom: 2px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--panel);
    }
    .network-table td {
      padding: 5px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      white-space: nowrap;
    }
    .network-table tr:last-child td { border-bottom: none; }
    .network-table .status-ok { color: var(--ok); }
    .network-table .status-err { color: var(--err); }
    .network-table .status-slow { color: var(--warn); }
    .network-table .url-cell {
      max-width: 340px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mono {
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.45;
      background: color-mix(in srgb, var(--panel-3) 86%, transparent);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      max-height: 440px;
      overflow: auto;
      font-family: var(--font-mono);
    }
    .file-list {
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      margin: 0;
      color: var(--text);
      font-family: var(--font-mono);
    }
    .action-btn {
      padding: 7px 10px;
      border: 1px solid var(--border);
      background: var(--button-bg);
      color: var(--text);
      border-radius: 7px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .action-btn:hover {
      background: var(--button-bg-hover);
    }
    .action-btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .feedback-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px 20px;
      display: none;
      align-items: center;
      gap: 14px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      z-index: 20;
    }
    .feedback-toast.visible { display: flex; }
    .feedback-toast .fb-text {
      font-size: 14px;
      color: var(--text);
      white-space: nowrap;
    }
    .feedback-toast .fb-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 24px;
      padding: 2px;
      opacity: 0.7;
      transition: opacity 0.15s, transform 0.15s;
    }
    .feedback-toast .fb-btn:hover {
      opacity: 1;
      transform: scale(1.2);
    }
    .feedback-toast .fb-btn.selected {
      opacity: 1;
      transform: scale(1.15);
    }
    .feedback-toast .fb-done {
      font-size: 13px;
      color: var(--muted);
    }
    textarea {
      width: 100%;
      min-height: 70px;
      margin-top: 8px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-3) 86%, transparent);
      color: var(--text);
      padding: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    a { color: color-mix(in srgb, var(--running) 85%, var(--text)); }
    .summary-empty {
      color: var(--muted);
      font-size: 13px;
    }
    .summary-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px dashed var(--border);
    }
    .summary-title {
      font-size: 15px;
      font-weight: 700;
      line-height: 1.4;
      word-break: break-word;
      flex: 1;
      min-width: 0;
    }
    .summary-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--panel-3);
      white-space: nowrap;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta-chip .material-symbols-rounded {
      font-size: 14px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .meta-chip-text {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .summary-timing {
      font-size: 11px;
      color: var(--muted);
      margin-top: 8px;
      line-height: 1.4;
    }
    .summary-timing .sep {
      margin: 0 4px;
      opacity: 0.5;
    }
    .summary-error {
      margin-top: 10px;
      border: 1px solid color-mix(in srgb, var(--err) 45%, var(--border));
      background: color-mix(in srgb, var(--err) 12%, var(--panel));
      border-radius: 8px;
      padding: 8px;
      font-size: 12px;
      line-height: 1.4;
    }
    .file-item {
      padding: 2px 0;
      border-bottom: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    }
    .file-item:last-child {
      border-bottom: 0;
    }
    .file-row {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 8px;
      align-items: start;
      padding: 6px 0;
      border-bottom: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    }
    .file-row:last-child {
      border-bottom: 0;
    }
    .file-icon {
      color: var(--muted);
      font-size: 15px;
      transform: translateY(1px);
    }
    .file-name {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text);
      line-height: 1.35;
      word-break: break-word;
    }
    .file-path {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      word-break: break-word;
    }
    .chat-history {
      max-height: 300px;
      overflow-y: auto;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .chat-msg {
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
    }
    .chat-msg.human {
      background: color-mix(in srgb, var(--acc) 12%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--acc) 30%, var(--border));
      align-self: flex-end;
      max-width: 85%;
    }
    .chat-msg.agent {
      background: var(--panel-3);
      border: 1px solid var(--border);
      align-self: flex-start;
      max-width: 85%;
    }
    .chat-msg .chat-sender {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
      opacity: 0.6;
    }
    .chat-msg .chat-time {
      font-size: 10px;
      opacity: 0.5;
      margin-top: 4px;
    }
    .chat-input-area {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .chat-input-area textarea {
      flex: 1;
      font-family: inherit;
      font-size: 12px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      resize: vertical;
      min-height: 36px;
    }
    .chat-send {
      flex-shrink: 0;
    }
    /* ── Activity stream ────────────────────────── */
    .log-viewer {
      max-height: 500px;
      overflow-y: auto;
      scroll-behavior: smooth;
      background: var(--panel-3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--muted);
      margin: 0;
    }
    .act-truncated, .log-truncated {
      text-align: center;
      padding: 6px 10px;
      background: color-mix(in srgb, var(--warn) 8%, var(--panel-3));
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .act-show-all-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 11px;
      cursor: pointer;
      margin-right: 8px;
    }
    .act-show-all-btn:hover { opacity: 0.85; }
    .activity-stream {
      max-height: 600px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      scroll-behavior: smooth;
    }
    .act-event {
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.5;
      position: relative;
    }
    .act-thinking {
      background: color-mix(in srgb, var(--warn) 10%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--warn) 22%, var(--border));
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text);
    }
    .act-thinking::before {
      content: 'Agent';
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: color-mix(in srgb, var(--warn) 85%, var(--text));
      margin-right: 8px;
    }
    .act-thinking .md-heading {
      font-size: 12px;
      font-weight: 700;
      margin: 6px 0 2px;
      color: var(--text);
    }
    .act-thinking .md-list {
      margin: 2px 0 2px 16px;
      padding: 0;
      list-style: disc;
    }
    .act-thinking .md-list li {
      margin: 1px 0;
    }
    .act-thinking .md-inline-code {
      background: color-mix(in srgb, var(--panel) 60%, transparent);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .act-thinking .md-code-block {
      background: color-mix(in srgb, var(--panel) 60%, transparent);
      padding: 6px 8px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 11px;
      margin: 4px 0;
      overflow-x: auto;
    }
    .act-thinking .md-line {
      display: block;
      vertical-align: middle;
    }
    .act-tool {
      background: var(--panel-3);
      border: 1px solid var(--border);
    }
    .act-tool-header {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .act-tool-header:hover { opacity: 0.85; }
    .act-tool-icon {
      font-size: 16px;
      color: var(--running);
      flex-shrink: 0;
    }
    .act-tool-name {
      font-weight: 700;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text);
    }
    .act-tool-desc {
      color: var(--muted);
      font-size: 11px;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .act-tool-chevron {
      font-size: 18px;
      color: var(--muted);
      transition: transform 180ms ease;
      flex-shrink: 0;
    }
    .act-tool.open .act-tool-chevron { transform: rotate(90deg); }
    .act-tool-body {
      display: none;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    }
    .act-tool.open .act-tool-body { display: block; }
    .act-tool-params {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      margin-bottom: 6px;
    }
    .act-tool-params .pk { color: var(--muted); font-weight: 600; }
    .act-tool-params .pv { word-break: break-all; }
    .act-tool-output {
      white-space: pre-wrap;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      max-height: 200px;
      overflow-y: auto;
      background: color-mix(in srgb, var(--panel) 60%, transparent);
      border-radius: 6px;
      padding: 6px 8px;
    }
    .act-tool-result {
      margin-top: 6px;
      border-left: 3px solid var(--accent);
      padding: 6px 8px;
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border-radius: 0 6px 6px 0;
    }
    .act-result-label {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--accent);
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .act-result-text {
      white-space: pre-wrap;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--fg);
      margin: 0;
      max-height: 150px;
      overflow-y: auto;
    }
    .act-phase {
      background: color-mix(in srgb, var(--running) 10%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--running) 20%, var(--border));
      font-weight: 600;
      letter-spacing: 0.02em;
      font-size: 11px;
      color: color-mix(in srgb, var(--running) 80%, var(--text));
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .act-phase .material-symbols-rounded { font-size: 16px; }
    .act-session {
      background: color-mix(in srgb, var(--ok) 8%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--ok) 20%, var(--border));
      color: color-mix(in srgb, var(--ok) 80%, var(--text));
      font-size: 11px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .act-session .material-symbols-rounded { font-size: 16px; }
    .act-info {
      color: var(--muted);
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 4px 10px;
    }
    .act-pipeline {
      background: color-mix(in srgb, var(--running) 6%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--running) 15%, var(--border));
      font-size: 11px;
      font-family: var(--font-mono);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .act-pipeline .material-symbols-rounded { font-size: 14px; color: var(--running); flex-shrink: 0; }
    .act-pipeline.pl-success { border-color: color-mix(in srgb, var(--ok) 25%, var(--border)); }
    .act-pipeline.pl-success .material-symbols-rounded { color: var(--ok); }
    .act-pipeline.pl-error { border-color: color-mix(in srgb, var(--fail) 25%, var(--border)); }
    .act-pipeline.pl-error .material-symbols-rounded { color: var(--fail); }
    .act-pipeline.pl-warn { border-color: color-mix(in srgb, var(--warn) 25%, var(--border)); }
    .act-pipeline.pl-warn .material-symbols-rounded { color: var(--warn); }
    .act-badge {
      position: absolute;
      top: 6px;
      right: 8px;
      font-size: 10px;
      font-weight: 700;
      color: var(--muted);
      background: color-mix(in srgb, var(--panel) 80%, transparent);
      border-radius: 4px;
      padding: 1px 5px;
      font-family: var(--font-mono);
    }
    .act-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .act-footer label {
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
    }
    .act-footer input[type="checkbox"] {
      accent-color: var(--running);
    }
    .act-stats {
      display: flex;
      gap: 10px;
    }
    .act-stat { font-family: var(--font-mono); }
    /* ── Enhanced file list ─────────────────────── */
    .file-badge {
      display: inline-block;
      width: 18px;
      text-align: center;
      font-size: 10px;
      font-weight: 700;
      border-radius: 4px;
      padding: 1px 0;
      font-family: var(--font-mono);
      flex-shrink: 0;
    }
    .file-badge.A {
      background: color-mix(in srgb, var(--ok) 20%, transparent);
      color: color-mix(in srgb, var(--ok) 80%, var(--text));
      border: 1px solid color-mix(in srgb, var(--ok) 35%, var(--border));
    }
    .file-badge.M {
      background: color-mix(in srgb, var(--warn) 18%, transparent);
      color: color-mix(in srgb, var(--warn) 80%, var(--text));
      border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border));
    }
    .file-badge.D {
      background: color-mix(in srgb, var(--err) 18%, transparent);
      color: color-mix(in srgb, var(--err) 80%, var(--text));
      border: 1px solid color-mix(in srgb, var(--err) 35%, var(--border));
    }
    .file-badge.R {
      background: color-mix(in srgb, var(--running) 18%, transparent);
      color: color-mix(in srgb, var(--running) 80%, var(--text));
      border: 1px solid color-mix(in srgb, var(--running) 35%, var(--border));
    }
    .file-stat {
      font-family: var(--font-mono);
      font-size: 11px;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .file-stat-add { color: color-mix(in srgb, var(--ok) 80%, var(--text)); }
    .file-stat-del { color: color-mix(in srgb, var(--err) 80%, var(--text)); }
    .file-row-enhanced {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 0;
      border-bottom: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    }
    .file-row-enhanced:last-child { border-bottom: 0; }
    .file-row-enhanced .file-info {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    @media (max-width: 1160px) {
      .app {
        grid-template-columns: 1fr;
        grid-template-rows: 64px 240px 1fr;
        grid-template-areas:
          "top"
          "sidebar"
          "main";
      }
      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }
    }
    @media (max-width: 700px) {
      .topbar {
        padding: 8px 10px;
      }
      .brand p {
        display: none;
      }
      .theme-btn {
        padding: 5px 8px;
      }
      .top-btn {
        padding: 6px 8px;
      }
      .main {
        padding: 10px;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <div>
          <h1>${config.appName} Dashboard</h1>
          <p>Run inspector and operator feedback</p>
        </div>
      </div>
      <div class="top-controls">
        <div class="top-meta" id="top-meta">0 runs</div>
        <button class="top-btn" id="settings-btn">
          <span class="material-symbols-rounded">settings</span>
          <span>Settings</span>
        </button>
        <a class="top-btn" id="report-btn" href="https://github.com/new" target="_blank" rel="noreferrer noopener">
          <span class="material-symbols-rounded">link</span>
          <span>Report issue</span>
        </a>
        <div class="theme-switch" id="theme-switch">
          <button class="theme-btn" data-theme-val="light" title="Light mode">
            <span class="material-symbols-rounded">light_mode</span>
          </button>
          <button class="theme-btn" data-theme-val="system" title="System mode">
            <span class="material-symbols-rounded">desktop_windows</span>
          </button>
          <button class="theme-btn" data-theme-val="dark" title="Dark mode">
            <span class="material-symbols-rounded">dark_mode</span>
          </button>
        </div>
        <button class="top-btn danger" id="logout-btn" title="Logout">
          <span class="material-symbols-rounded">power_settings_new</span>
        </button>
      </div>
    </header>
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="sidebar-title">Runs</div>
        <div class="meta" id="meta">Loading...</div>
      </div>
      <div id="runs"></div>
    </aside>
    <main class="main">
      <div class="stack">
        <div class="stack-top">
          <div class="card">
            <div class="toolbar">
              <div>
                <div class="card-title">Run summary</div>
                <div class="card-subtitle" id="summary-subtitle">Select a run from the left panel.</div>
              </div>
              <div class="summary-actions">
                <a class="action-btn" id="open-branch" href="#" target="_blank" rel="noreferrer noopener">
                  <span class="material-symbols-rounded">account_tree</span>
                  <span>Branch</span>
                </a>
                <a class="action-btn" id="open-pr" href="#" target="_blank" rel="noreferrer noopener">
                  <span class="material-symbols-rounded">open_in_new</span>
                  <span>PR</span>
                </a>
                <a class="action-btn" id="open-commit" href="#" target="_blank" rel="noreferrer noopener">
                  <span class="material-symbols-rounded">commit</span>
                  <span>Commit</span>
                </a>
                <button class="action-btn" id="retry-run" disabled>
                  <span class="material-symbols-rounded">refresh</span>
                  <span>Retry</span>
                </button>
              </div>
            </div>
            <div id="summary" class="summary-empty">No run selected.</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title" style="margin-bottom: 8px;">Changed files</div>
          <div class="file-list" id="files">-</div>
        </div>
        <div class="card" id="media-card" style="display: none;">
          <div class="card-title" style="margin-bottom: 0;">Browser session</div>
          <div class="session-tabs" id="session-tabs">
            <button class="session-tab active" data-tab="replay">Replay</button>
            <button class="session-tab" data-tab="actions">Actions <span id="tab-actions-count" class="tab-count"></span></button>
            <button class="session-tab" data-tab="console">Console <span id="tab-console-count" class="tab-count"></span></button>
            <button class="session-tab" data-tab="network">Network <span id="tab-network-count" class="tab-count"></span></button>
          </div>
          <div class="session-panel active" id="panel-replay">
            <div id="media-video" style="display: none; margin-bottom: 12px;">
              <video id="media-video-player" controls style="width: 100%; border-radius: 6px; border: 1px solid var(--border); background: #000;">
                Your browser does not support the video tag.
              </video>
            </div>
            <div id="media-screenshots" style="display: none;">
              <div style="font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;">Screenshots</div>
              <div id="media-screenshots-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px;"></div>
            </div>
            <div id="panel-replay-empty" class="session-empty">No video or screenshots available.</div>
          </div>
          <div class="session-panel" id="panel-actions">
            <div id="media-actions-table" style="font-size: 12px; overflow-x: auto;"></div>
            <div id="panel-actions-empty" class="session-empty">No agent actions recorded.</div>
          </div>
          <div class="session-panel" id="panel-console">
            <div id="media-console-filters" style="display: none; margin-bottom: 8px;">
              <button class="console-filter-btn active" data-level="all">All</button>
              <button class="console-filter-btn" data-level="error">Errors</button>
              <button class="console-filter-btn" data-level="warning">Warnings</button>
            </div>
            <div id="media-console-entries" style="max-height: 400px; overflow-y: auto; font-family: var(--font-mono); font-size: 11px;"></div>
            <div id="panel-console-empty" class="session-empty">No console logs captured.</div>
          </div>
          <div class="session-panel" id="panel-network">
            <div id="media-network-table" style="max-height: 400px; overflow-y: auto; font-size: 12px; overflow-x: auto;"></div>
            <div id="panel-network-empty" class="session-empty">No network requests captured.</div>
          </div>
        </div>
        <div class="card" id="pipeline-timeline-card" style="display: none;">
          <div class="card-title" style="margin-bottom: 8px;">Pipeline timeline</div>
          <div id="pipeline-timeline" class="mono" style="max-height: 200px; font-size: 11px;"></div>
        </div>
        <div class="card">
          <div class="toolbar">
            <div class="card-title">Agent activity</div>
            <div class="act-stats" id="act-stats"></div>
          </div>
          <div class="act-truncated" id="act-truncated" style="display: none;">
            <button class="act-show-all-btn" id="act-show-all">Show all events</button>
            <span class="meta" id="act-truncated-count"></span>
          </div>
          <div class="activity-stream" id="activity-stream">
            <div class="act-info">Select a run to see agent activity.</div>
          </div>
          <div class="act-footer">
            <label>
              <input type="checkbox" id="auto-scroll" checked />
              Auto-scroll
            </label>
            <span id="act-count" class="meta"></span>
          </div>
        </div>
        <div class="card" id="log-viewer-card" style="display: none;">
          <div class="toolbar">
            <div class="card-title">Run log</div>
            <div id="log-stats" class="meta"></div>
          </div>
          <div class="log-truncated" id="log-truncated" style="display: none;">
            <span class="meta" id="log-truncated-msg">Log truncated — showing last 200 KB</span>
          </div>
          <pre class="log-viewer" id="log-viewer"></pre>
          <div class="act-footer">
            <label>
              <input type="checkbox" id="log-auto-scroll" checked />
              Auto-scroll
            </label>
            <span id="log-size" class="meta"></span>
          </div>
        </div>
        <div class="card" id="observer-card" style="display: none;">
          <div class="toolbar">
            <div>
              <div class="card-title">Observer</div>
              <div class="card-subtitle" id="observer-subtitle">Watching for triggers</div>
            </div>
            <div class="summary-actions">
              <span class="meta" id="observer-budget"></span>
            </div>
          </div>
          <div id="observer-content">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
              <div id="observer-rules-panel" style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-3);">
                <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Rules</div>
                <div id="observer-rules" class="meta">Loading...</div>
              </div>
              <div id="observer-stats-panel" style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-3);">
                <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Budget</div>
                <div id="observer-stats" class="meta">Loading...</div>
              </div>
            </div>
            <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Recent events</div>
            <div id="observer-events" class="activity-stream" style="max-height: 300px;">
              <div class="act-info">No events yet.</div>
            </div>
          </div>
        </div>
        <div class="card" id="chat-card" style="display: none;">
          <div class="card-title" style="margin-bottom: 8px;">Thread history & follow-up</div>
          <div class="chat-history" id="chat-history"></div>
          <div class="chat-input-area">
            <textarea id="chat-input" placeholder="Type follow-up instructions for the agent..." rows="2"></textarea>
            <button class="action-btn chat-send" id="chat-send" disabled>
              <span class="material-symbols-rounded">send</span>
              <span>Send</span>
            </button>
          </div>
          <div class="meta" id="chat-status"></div>
        </div>
      </div>
    </main>
  </div>

  <div class="feedback-toast" id="feedback-toast">
    <span class="fb-text">What did you think of this agent run?</span>
    <button class="fb-btn" id="feedback-down" title="Bad">👎</button>
    <button class="fb-btn" id="feedback-up" title="Good">👍</button>
  </div>

  <script>
    const state = {
      runs: [],
      selectedId: null,
      interval: null,
      themePreference: 'system',
    };

    var logStreamState = { runId: null, offset: 0 };

    // ── Lazy loading constants ──
    var MAX_VISIBLE_EVENTS = 150;
    var MAX_LOG_CHARS = 200000; // ~200 KB
    var activityShowAll = false;
    var lastRenderedEventCount = -1;

    const el = {
      meta: document.getElementById('meta'),
      topMeta: document.getElementById('top-meta'),
      runs: document.getElementById('runs'),
      summary: document.getElementById('summary'),
      summarySubtitle: document.getElementById('summary-subtitle'),
      retryRun: document.getElementById('retry-run'),
      openBranch: document.getElementById('open-branch'),
      openPr: document.getElementById('open-pr'),
      openCommit: document.getElementById('open-commit'),
      files: document.getElementById('files'),
      mediaCard: document.getElementById('media-card'),
      sessionTabs: document.getElementById('session-tabs'),
      mediaVideo: document.getElementById('media-video'),
      mediaVideoPlayer: document.getElementById('media-video-player'),
      mediaScreenshots: document.getElementById('media-screenshots'),
      mediaScreenshotsGrid: document.getElementById('media-screenshots-grid'),
      panelReplayEmpty: document.getElementById('panel-replay-empty'),
      panelActionsEmpty: document.getElementById('panel-actions-empty'),
      mediaActionsTable: document.getElementById('media-actions-table'),
      tabActionsCount: document.getElementById('tab-actions-count'),
      panelConsoleEmpty: document.getElementById('panel-console-empty'),
      mediaConsoleFilters: document.getElementById('media-console-filters'),
      mediaConsoleEntries: document.getElementById('media-console-entries'),
      tabConsoleCount: document.getElementById('tab-console-count'),
      panelNetworkEmpty: document.getElementById('panel-network-empty'),
      mediaNetworkTable: document.getElementById('media-network-table'),
      tabNetworkCount: document.getElementById('tab-network-count'),
      pipelineTimelineCard: document.getElementById('pipeline-timeline-card'),
      pipelineTimeline: document.getElementById('pipeline-timeline'),
      activityStream: document.getElementById('activity-stream'),
      actStats: document.getElementById('act-stats'),
      actCount: document.getElementById('act-count'),
      actTruncated: document.getElementById('act-truncated'),
      actTruncatedCount: document.getElementById('act-truncated-count'),
      actShowAll: document.getElementById('act-show-all'),
      autoScroll: document.getElementById('auto-scroll'),
      logViewerCard: document.getElementById('log-viewer-card'),
      logViewer: document.getElementById('log-viewer'),
      logAutoScroll: document.getElementById('log-auto-scroll'),
      logSize: document.getElementById('log-size'),
      logStats: document.getElementById('log-stats'),
      logTruncated: document.getElementById('log-truncated'),
      logTruncatedMsg: document.getElementById('log-truncated-msg'),
      feedbackToast: document.getElementById('feedback-toast'),
      feedbackUp: document.getElementById('feedback-up'),
      feedbackDown: document.getElementById('feedback-down'),
      chatCard: document.getElementById('chat-card'),
      chatHistory: document.getElementById('chat-history'),
      chatInput: document.getElementById('chat-input'),
      chatSend: document.getElementById('chat-send'),
      chatStatus: document.getElementById('chat-status'),
      themeSwitch: document.getElementById('theme-switch'),
      settingsBtn: document.getElementById('settings-btn'),
      reportBtn: document.getElementById('report-btn'),
      logoutBtn: document.getElementById('logout-btn'),
    };

    // Session tab switching
    el.sessionTabs.addEventListener('click', function(e) {
      var btn = e.target.closest('.session-tab');
      if (!btn) return;
      var tabName = btn.getAttribute('data-tab');
      el.sessionTabs.querySelectorAll('.session-tab').forEach(function(t) { t.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.session-panel').forEach(function(p) { p.classList.remove('active'); });
      var panel = document.getElementById('panel-' + tabName);
      if (panel) panel.classList.add('active');
    });

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Request failed');
      }
      return response.json();
    }

    function shortId(id) {
      return id.slice(0, 8);
    }

    function branchRefForUrl(value) {
      return encodeURIComponent(value).replace(/%2F/g, '/');
    }

    function extractCommitSha(value) {
      if (!value) {
        return null;
      }
      const matches = String(value).match(/[0-9a-f]{7,40}/gi);
      if (!matches || matches.length === 0) {
        return null;
      }
      return matches[matches.length - 1];
    }

    function setLinkState(node, href) {
      if (!node) return;
      if (href) {
        node.href = href;
        node.style.pointerEvents = 'auto';
        node.style.opacity = '1';
        node.removeAttribute('aria-disabled');
      } else {
        node.href = '#';
        node.style.pointerEvents = 'none';
        node.style.opacity = '0.45';
        node.setAttribute('aria-disabled', 'true');
      }
    }

    function setReportIssueLink(run) {
      const fallback = 'https://github.com/new';
      if (!run || !run.repoSlug) {
        setLinkState(el.reportBtn, fallback);
        return;
      }
      setLinkState(el.reportBtn, 'https://github.com/' + run.repoSlug + '/issues/new');
    }

    function normalizeThemePreference(value) {
      if (value === 'light' || value === 'dark' || value === 'system') {
        return value;
      }
      return 'system';
    }

    function resolveTheme(preference) {
      if (preference === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      return preference;
    }

    function applyTheme(preference) {
      const normalized = normalizeThemePreference(preference);
      const resolved = resolveTheme(normalized);
      state.themePreference = normalized;
      document.documentElement.setAttribute('data-theme', resolved);

      if (el.themeSwitch) {
        const buttons = el.themeSwitch.querySelectorAll('[data-theme-val]');
        for (const button of buttons) {
          const value = button.getAttribute('data-theme-val');
          button.classList.toggle('active', value === normalized);
        }
      }
    }

    function initTheme() {
      const stored = normalizeThemePreference(localStorage.getItem('gooseherd.theme'));
      applyTheme(stored);

      if (el.themeSwitch) {
        const buttons = el.themeSwitch.querySelectorAll('[data-theme-val]');
        for (const button of buttons) {
          button.addEventListener('click', () => {
            const value = normalizeThemePreference(button.getAttribute('data-theme-val'));
            localStorage.setItem('gooseherd.theme', value);
            applyTheme(value);
          });
        }
      }

      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', () => {
        if (state.themePreference === 'system') {
          applyTheme('system');
        }
      });
    }

    function statusClass(status) {
      return 'status-pill ' + status;
    }

    function formatDate(value) {
      if (!value) {
        return '—';
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return date.toLocaleString();
    }

    function truncateCommit(sha) {
      return sha ? sha.slice(0, 12) : '—';
    }

    function timeAgo(dateString) {
      if (!dateString) return '—';
      var date = new Date(dateString);
      if (Number.isNaN(date.getTime())) return dateString;
      var now = Date.now();
      var diff = now - date.getTime();
      if (diff < 0) return 'just now';
      var seconds = Math.floor(diff / 1000);
      if (seconds < 60) return 'just now';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      var days = Math.floor(hours / 24);
      if (days < 7) return days + 'd ago';
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[date.getMonth()] + ' ' + date.getDate();
    }

    function fullTimestamp(dateString) {
      if (!dateString) return '';
      var date = new Date(dateString);
      if (Number.isNaN(date.getTime())) return dateString;
      return date.toLocaleString();
    }

    function truncateTask(task, maxLen) {
      if (!task || !task.trim()) return '(no description)';
      if (task.length <= maxLen) return task;
      return task.slice(0, maxLen).trimEnd() + '\u2026';
    }

    function renderSummary(run) {
      if (!run) {
        el.summary.className = 'summary-empty';
        el.summary.textContent = 'No run selected.';
        el.screenshotCard.style.display = 'none';
        el.summarySubtitle.textContent = 'Select a run from the left panel.';
        setLinkState(el.openBranch, null);
        setLinkState(el.openPr, null);
        setLinkState(el.openCommit, null);
        setReportIssueLink(null);
        return;
      }

      el.summary.className = '';
      el.summary.innerHTML = '';
      el.summarySubtitle.textContent = run.repoSlug;
      setReportIssueLink(run);

      var repoUrl = 'https://github.com/' + run.repoSlug;
      var branchUrl = repoUrl + '/tree/' + branchRefForUrl(run.branchName);
      var commitSha = extractCommitSha(run.commitSha);
      var commitUrl = commitSha ? (repoUrl + '/commit/' + commitSha) : null;

      setLinkState(el.openBranch, branchUrl);
      setLinkState(el.openPr, run.prUrl || null);
      setLinkState(el.openCommit, commitUrl);

      // Header: task title + status pill
      var head = document.createElement('div');
      head.className = 'summary-head';

      var titleNode = document.createElement('div');
      titleNode.className = 'summary-title';
      titleNode.textContent = run.title || truncateTask(run.task, 120);
      titleNode.title = run.task || '';

      var statusNode = document.createElement('span');
      statusNode.className = statusClass(run.status);
      statusNode.textContent = run.status;

      head.appendChild(titleNode);
      head.appendChild(statusNode);
      el.summary.appendChild(head);

      // Meta chips: branch, base, commit
      var metaRow = document.createElement('div');
      metaRow.className = 'summary-meta-row';

      function addChip(icon, text, tooltip) {
        var chip = document.createElement('span');
        chip.className = 'meta-chip';
        if (tooltip) chip.title = tooltip;
        var iconEl = document.createElement('span');
        iconEl.className = 'material-symbols-rounded';
        iconEl.textContent = icon;
        var textEl = document.createElement('span');
        textEl.className = 'meta-chip-text';
        textEl.textContent = text;
        chip.appendChild(iconEl);
        chip.appendChild(textEl);
        metaRow.appendChild(chip);
      }

      addChip('account_tree', run.branchName, run.branchName);
      addChip('merge_type', run.baseBranch, 'Base: ' + run.baseBranch);
      if (commitSha) {
        addChip('commit', truncateCommit(commitSha), commitSha);
      }

      el.summary.appendChild(metaRow);

      // Timing row
      var timing = document.createElement('div');
      timing.className = 'summary-timing';
      var timingParts = [];
      if (run.createdAt) {
        var tCreated = document.createElement('span');
        tCreated.title = fullTimestamp(run.createdAt);
        tCreated.textContent = 'Created ' + timeAgo(run.createdAt);
        timing.appendChild(tCreated);
        timingParts.push(true);
      }
      if (run.startedAt) {
        if (timingParts.length > 0) {
          var sep1 = document.createElement('span');
          sep1.className = 'sep';
          sep1.textContent = '\u00b7';
          timing.appendChild(sep1);
        }
        var tStarted = document.createElement('span');
        tStarted.title = fullTimestamp(run.startedAt);
        tStarted.textContent = 'Started ' + timeAgo(run.startedAt);
        timing.appendChild(tStarted);
        timingParts.push(true);
      }
      if (run.finishedAt) {
        if (timingParts.length > 0) {
          var sep2 = document.createElement('span');
          sep2.className = 'sep';
          sep2.textContent = '\u00b7';
          timing.appendChild(sep2);
        }
        var tFinished = document.createElement('span');
        tFinished.title = fullTimestamp(run.finishedAt);
        tFinished.textContent = 'Finished ' + timeAgo(run.finishedAt);
        timing.appendChild(tFinished);
      }
      el.summary.appendChild(timing);

      // Token usage row
      if (run.tokenUsage) {
        var tokenRow = document.createElement('div');
        tokenRow.className = 'summary-meta-row';
        var gateTokens = (run.tokenUsage.qualityGateInputTokens || 0) + (run.tokenUsage.qualityGateOutputTokens || 0);
        if (gateTokens > 0) {
          addChip('token', 'Gates: ' + gateTokens.toLocaleString() + ' tokens', 'Input: ' + (run.tokenUsage.qualityGateInputTokens || 0).toLocaleString() + ', Output: ' + (run.tokenUsage.qualityGateOutputTokens || 0).toLocaleString());
        }
        var agentIn = run.tokenUsage.agentInputTokens || 0;
        var agentOut = run.tokenUsage.agentOutputTokens || 0;
        if (agentIn + agentOut > 0) {
          addChip('smart_toy', 'Agent: ' + (agentIn + agentOut).toLocaleString() + ' tokens', 'Input: ' + agentIn.toLocaleString() + ', Output: ' + agentOut.toLocaleString());
        }
        el.summary.appendChild(tokenRow);
      }

      // Feedback
      if (run.feedback) {
        var fbRow = document.createElement('div');
        fbRow.className = 'summary-timing';
        fbRow.style.marginTop = '6px';
        var fbSpan = document.createElement('span');
        fbSpan.title = fullTimestamp(run.feedback.at);
        fbSpan.textContent = 'Feedback: ' + run.feedback.rating + (run.feedback.note ? ' \u2014 ' + run.feedback.note : '') + ' \u00b7 ' + timeAgo(run.feedback.at);
        fbRow.appendChild(fbSpan);
        el.summary.appendChild(fbRow);
      }

      if (run.error) {
        var error = document.createElement('div');
        error.className = 'summary-error';
        error.textContent = run.error;
        el.summary.appendChild(error);
      }
    }

    var consoleFilter = 'all';

    async function loadMedia(runId) {
      if (!runId) {
        el.mediaCard.style.display = 'none';
        return;
      }
      try {
        var data = await fetchJson('/api/runs/' + encodeURIComponent(runId) + '/media');
        var hasContent = false;
        var baseUrl = '/api/runs/' + encodeURIComponent(runId) + '/artifacts/';

        // ── Replay tab: Video + Screenshots ──
        var hasReplay = false;
        if (data.video) {
          var newSrc = baseUrl + data.video.path;
          if (el.mediaVideoPlayer.src !== newSrc && !el.mediaVideoPlayer.src.endsWith(newSrc)) {
            el.mediaVideoPlayer.src = newSrc;
          }
          el.mediaVideo.style.display = '';
          hasReplay = true;
        } else {
          el.mediaVideo.style.display = 'none';
          el.mediaVideoPlayer.src = '';
        }

        el.mediaScreenshotsGrid.innerHTML = '';
        if (data.screenshots && data.screenshots.length > 0) {
          for (var i = 0; i < data.screenshots.length; i++) {
            var ss = data.screenshots[i];
            var link = document.createElement('a');
            link.href = baseUrl + ss.path;
            link.target = '_blank';
            link.rel = 'noreferrer noopener';
            link.title = ss.name + ' (' + Math.round(ss.size / 1024) + ' KB)';
            var img = document.createElement('img');
            img.src = baseUrl + ss.path;
            img.alt = ss.name;
            img.style.cssText = 'width: 100%; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in;';
            link.appendChild(img);
            el.mediaScreenshotsGrid.appendChild(link);
          }
          el.mediaScreenshots.style.display = '';
          hasReplay = true;
        } else {
          el.mediaScreenshots.style.display = 'none';
        }
        el.panelReplayEmpty.style.display = hasReplay ? 'none' : '';
        if (hasReplay) hasContent = true;

        // ── Actions tab ──
        if (data.agentActions && data.agentActions.length > 0) {
          el.tabActionsCount.textContent = data.agentActions.length;
          var actHtml = '<table class="actions-table"><thead><tr>';
          actHtml += '<th style="width: 40px;">#</th>';
          actHtml += '<th style="width: 80px;">Type</th>';
          actHtml += '<th>Detail</th>';
          actHtml += '<th style="width: 60px;">Page</th>';
          actHtml += '</tr></thead><tbody>';
          for (var ai = 0; ai < data.agentActions.length; ai++) {
            var act = data.agentActions[ai];
            var typeClass = sanitizeCssClass((act.type || '').toLowerCase());
            var detail = act.reasoning || act.action || act.url || '';
            if (detail.length > 200) detail = detail.slice(0, 200) + '…';
            var pageLink = '';
            if (act.pageUrl) {
              var safeHref = sanitizeUrlHref(act.pageUrl);
              if (safeHref) { pageLink = '<a href="' + safeHref + '" target="_blank" rel="noreferrer" style="color: var(--ring); text-decoration: none;" title="' + escapeHtml(act.pageUrl) + '">↗</a>'; }
            }
            actHtml += '<tr>';
            actHtml += '<td style="color: var(--muted);">' + (ai + 1) + '</td>';
            actHtml += '<td><span class="action-type-pill ' + typeClass + '">' + escapeHtml(act.type || '?') + '</span></td>';
            actHtml += '<td style="white-space: pre-wrap; word-break: break-word; max-width: 500px;">' + escapeHtml(detail) + '</td>';
            actHtml += '<td style="text-align: center;">' + pageLink + '</td>';
            actHtml += '</tr>';
          }
          actHtml += '</tbody></table>';
          el.mediaActionsTable.innerHTML = actHtml;
          el.panelActionsEmpty.style.display = 'none';
          hasContent = true;
        } else {
          el.tabActionsCount.textContent = '';
          el.mediaActionsTable.innerHTML = '';
          el.panelActionsEmpty.style.display = '';
        }

        // ── Console tab ──
        if (data.consoleLogs && data.consoleLogs.length > 0) {
          el.tabConsoleCount.textContent = data.consoleLogs.length;
          el.mediaConsoleEntries.innerHTML = '';

          function renderConsoleLogs() {
            el.mediaConsoleEntries.innerHTML = '';
            for (var ci = 0; ci < data.consoleLogs.length; ci++) {
              var entry = data.consoleLogs[ci];
              if (consoleFilter !== 'all' && entry.level !== consoleFilter) continue;
              var line = document.createElement('div');
              var levelClass = KNOWN_CONSOLE_LEVELS[entry.level] ? entry.level : 'log';
              line.className = 'console-entry ' + levelClass;
              var levelSpan = document.createElement('span');
              levelSpan.className = 'level';
              levelSpan.textContent = entry.level || 'log';
              line.appendChild(levelSpan);
              var msgSpan = document.createElement('span');
              msgSpan.textContent = entry.message;
              line.appendChild(msgSpan);
              el.mediaConsoleEntries.appendChild(line);
            }
          }

          renderConsoleLogs();

          var filterBtns = document.querySelectorAll('.console-filter-btn');
          for (var fi = 0; fi < filterBtns.length; fi++) {
            filterBtns[fi].onclick = function(e) {
              consoleFilter = e.target.getAttribute('data-level');
              filterBtns.forEach(function(b) { b.classList.remove('active'); });
              e.target.classList.add('active');
              renderConsoleLogs();
            };
          }

          el.mediaConsoleFilters.style.display = '';
          el.panelConsoleEmpty.style.display = 'none';
          hasContent = true;
        } else {
          el.tabConsoleCount.textContent = '';
          el.mediaConsoleEntries.innerHTML = '';
          el.mediaConsoleFilters.style.display = 'none';
          el.panelConsoleEmpty.style.display = '';
        }

        // ── Network tab ──
        if (data.networkLog && data.networkLog.length > 0) {
          el.tabNetworkCount.textContent = data.networkLog.length;
          var netHtml = '<table class="network-table"><thead><tr>';
          netHtml += '<th>URL</th>';
          netHtml += '<th>Method</th>';
          netHtml += '<th>Status</th>';
          netHtml += '<th>Duration</th>';
          netHtml += '<th>Size</th>';
          netHtml += '</tr></thead><tbody>';
          for (var ni = 0; ni < data.networkLog.length; ni++) {
            var req = data.networkLog[ni];
            var statusClass = '';
            if (req.error || req.status >= 400) statusClass = 'status-err';
            else if (req.durationMs > 2000) statusClass = 'status-slow';
            else if (req.status >= 200 && req.status < 300) statusClass = 'status-ok';
            var shortUrl = req.url;
            try { shortUrl = new URL(req.url).pathname; } catch {}
            netHtml += '<tr class="' + statusClass + '">';
            netHtml += '<td class="url-cell" title="' + escapeHtml(req.url || '') + '">' + escapeHtml(shortUrl) + '</td>';
            netHtml += '<td>' + escapeHtml(req.method || '') + '</td>';
            netHtml += '<td>' + (req.error ? escapeHtml(req.error) : escapeHtml(String(req.status || '\u2014'))) + '</td>';
            netHtml += '<td>' + (req.durationMs !== undefined ? req.durationMs + 'ms' : '\u2014') + '</td>';
            netHtml += '<td>' + (req.encodedDataLength !== undefined ? Math.round(req.encodedDataLength / 1024) + ' KB' : '\u2014') + '</td>';
            netHtml += '</tr>';
          }
          netHtml += '</tbody></table>';
          el.mediaNetworkTable.innerHTML = netHtml;
          el.panelNetworkEmpty.style.display = 'none';
          hasContent = true;
        } else {
          el.tabNetworkCount.textContent = '';
          el.mediaNetworkTable.innerHTML = '';
          el.panelNetworkEmpty.style.display = '';
        }

        el.mediaCard.style.display = hasContent ? '' : 'none';
      } catch {
        el.mediaCard.style.display = 'none';
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function sanitizeUrlHref(url) {
      if (!url) return '';
      try {
        var parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return escapeHtml(url);
      } catch {}
      return '';
    }

    function sanitizeCssClass(str) {
      if (!str) return '';
      return str.replace(/[^a-z0-9_-]/g, '');
    }

    var KNOWN_CONSOLE_LEVELS = { log: true, info: true, warn: true, warning: true, error: true, debug: true, trace: true };

    function renderFiles(files, detailed) {
      if ((!files || files.length === 0) && (!detailed || detailed.length === 0)) {
        el.files.textContent = '(none)';
        return;
      }
      el.files.innerHTML = '';

      const items = detailed && detailed.length > 0 ? detailed : (files || []).map(function(f) { return { path: f, status: '?', additions: 0, deletions: 0 }; });

      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'file-row-enhanced';

        const badge = document.createElement('span');
        badge.className = 'file-badge ' + item.status;
        badge.textContent = item.status;
        row.appendChild(badge);

        const info = document.createElement('span');
        info.className = 'file-info';
        info.textContent = item.path;
        info.title = item.path;
        row.appendChild(info);

        if (item.additions > 0 || item.deletions > 0) {
          const stat = document.createElement('span');
          stat.className = 'file-stat';
          const parts = [];
          if (item.additions > 0) parts.push('<span class="file-stat-add">+' + item.additions + '</span>');
          if (item.deletions > 0) parts.push('<span class="file-stat-del">-' + item.deletions + '</span>');
          stat.innerHTML = parts.join(' ');
          row.appendChild(stat);
        }

        el.files.appendChild(row);
      }
    }

    function renderRuns() {
      el.runs.innerHTML = '';
      for (var i = 0; i < state.runs.length; i++) {
        var run = state.runs[i];
        var button = document.createElement('button');
        button.className = 'run-item' + (state.selectedId === run.id ? ' active' : '');
        button.onclick = (function(runId) {
          return function() {
            state.selectedId = runId;
            activityShowAll = false;
            lastRenderedEventCount = -1;
            renderRuns();
            refreshSelected().catch(console.error);
          };
        })(run.id);

        var top = document.createElement('div');
        top.className = 'run-item-top';

        var taskNode = document.createElement('div');
        taskNode.className = 'run-item-task';
        taskNode.textContent = run.title || truncateTask(run.task, 80);
        taskNode.title = run.task || '';

        var statusNode = document.createElement('span');
        statusNode.className = statusClass(run.status);
        statusNode.textContent = run.status;

        top.appendChild(taskNode);
        top.appendChild(statusNode);

        var meta = document.createElement('div');
        meta.className = 'run-item-meta';

        var repoText = document.createElement('span');
        repoText.textContent = run.repoSlug + ' @ ' + run.baseBranch;
        meta.appendChild(repoText);

        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '\u00b7';
        meta.appendChild(sep);

        var timeNode = document.createElement('span');
        timeNode.textContent = timeAgo(run.createdAt);
        timeNode.title = fullTimestamp(run.createdAt);
        meta.appendChild(timeNode);

        button.appendChild(top);
        button.appendChild(meta);
        el.runs.appendChild(button);
      }
    }

    /**
     * Minimal markdown → HTML for agent thinking blocks.
     * Handles: headers, bold, inline code, code blocks, lists.
     * No external dependencies.
     */
    /**
     * Minimal markdown to HTML for agent thinking blocks.
     * Uses RegExp constructors to avoid regex-in-template-literal TS parse issues.
     */
    var mdPatterns = {
      amp: new RegExp('&', 'g'),
      lt: new RegExp('<', 'g'),
      gt: new RegExp('>', 'g'),
      fence: new RegExp('\x60\x60\x60([\\\\s\\\\S]*?)\x60\x60\x60', 'g'),
      header: new RegExp('^(#{1,4})\\\\s+(.+)$'),
      ul: new RegExp('^\\\\s*[-*]\\\\s+(.+)$'),
      ol: new RegExp('^\\\\s*\\\\d+\\\\.\\\\s+(.+)$'),
      bold: new RegExp('\\\\*\\\\*(.+?)\\\\*\\\\*', 'g'),
      code: new RegExp('\x60([^\x60]+)\x60', 'g'),
    };

    function miniMarkdown(text) {
      var escaped = text
        .replace(mdPatterns.amp, '&amp;')
        .replace(mdPatterns.lt, '&lt;')
        .replace(mdPatterns.gt, '&gt;');

      escaped = escaped.replace(mdPatterns.fence, function(_, code) {
        return '<pre class="md-code-block">' + code.trim() + '</pre>';
      });

      var lines = escaped.split('\\n');
      var result = [];
      var inList = false;

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];

        var headerMatch = line.match(mdPatterns.header);
        if (headerMatch) {
          if (inList) { result.push('</ul>'); inList = false; }
          var level = Math.min(headerMatch[1].length + 2, 6);
          result.push('<h' + level + ' class="md-heading">' + inlineFormat(headerMatch[2]) + '</h' + level + '>');
          continue;
        }

        var listMatch = line.match(mdPatterns.ul);
        if (listMatch) {
          if (!inList) { result.push('<ul class="md-list">'); inList = true; }
          result.push('<li>' + inlineFormat(listMatch[1]) + '</li>');
          continue;
        }

        var numMatch = line.match(mdPatterns.ol);
        if (numMatch) {
          if (!inList) { result.push('<ul class="md-list">'); inList = true; }
          result.push('<li>' + inlineFormat(numMatch[1]) + '</li>');
          continue;
        }

        if (inList) { result.push('</ul>'); inList = false; }

        if (!line.trim()) {
          result.push('<br>');
          continue;
        }

        result.push('<span class="md-line">' + inlineFormat(line) + '</span>');
      }

      if (inList) result.push('</ul>');
      return result.join('');
    }

    function inlineFormat(text) {
      text = text.replace(mdPatterns.bold, '<strong>$1</strong>');
      text = text.replace(mdPatterns.code, '<code class="md-inline-code">$1</code>');
      return text;
    }

    function toolIcon(toolName) {
      var icons = {
        text_editor: 'edit_note',
        shell: 'terminal',
        analyze: 'folder_open',
        todo_write: 'checklist',
        read_file: 'description',
        write_file: 'save',
        list_directory: 'folder',
        search: 'search',
      };
      return icons[toolName] || 'build';
    }

    function renderPipelineTimeline(events, isActive) {
      if (!events || events.length === 0) {
        el.pipelineTimelineCard.style.display = 'none';
        return;
      }
      el.pipelineTimelineCard.style.display = '';

      // Build progress bar from node events
      var nodeStates = {};
      var nodeOrder = [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.type === 'node_start' && ev.nodeId) {
          if (!nodeStates[ev.nodeId]) nodeOrder.push(ev.nodeId);
          nodeStates[ev.nodeId] = 'active';
        } else if (ev.type === 'node_end' && ev.nodeId) {
          if (!nodeStates[ev.nodeId]) nodeOrder.push(ev.nodeId);
          if (ev.outcome === 'success' || ev.outcome === 'skipped') {
            nodeStates[ev.nodeId] = 'done';
          } else if (ev.outcome === 'soft_fail') {
            nodeStates[ev.nodeId] = 'warn';
          } else {
            nodeStates[ev.nodeId] = 'fail';
          }
        }
      }

      // Render progress bar
      var progressBar = document.createElement('div');
      progressBar.className = 'phase-progress';
      for (var pi = 0; pi < nodeOrder.length; pi++) {
        var step = document.createElement('div');
        step.className = 'phase-step ' + (nodeStates[nodeOrder[pi]] || '');
        step.title = nodeOrder[pi];
        progressBar.appendChild(step);
      }

      // Render text log
      var lines = [];
      for (var j = 0; j < events.length; j++) {
        var evt = events[j];
        var ts = evt.timestamp ? evt.timestamp.split('T')[1].split('.')[0] : '';
        if (evt.type === 'node_start') {
          lines.push(ts + '  \u25B6 ' + (evt.nodeId || ''));
        } else if (evt.type === 'node_end') {
          var dur = evt.durationMs ? ' (' + (evt.durationMs / 1000).toFixed(1) + 's)' : '';
          var icon = evt.outcome === 'success' ? '\u2705' : evt.outcome === 'skipped' ? '\u23ED' : evt.outcome === 'soft_fail' ? '\u26A0\uFE0F' : '\u274C';
          lines.push(ts + '  ' + icon + ' ' + (evt.nodeId || '') + dur + (evt.error ? ' \u2014 ' + evt.error.slice(0, 80) : ''));
        } else if (evt.type === 'phase_change') {
          lines.push(ts + '  \u{1F504} phase \u2192 ' + (evt.phase || ''));
        } else if (evt.type === 'artifact' && evt.artifact) {
          var artifact = String(evt.artifact);
          if (artifact.indexOf('loop_start:') === 0) {
            var startParts = artifact.split(':');
            lines.push(ts + '  \u{1F501} retry loop start ' + (startParts[1] || '') + ' via ' + (startParts[2] || '') + ' (max ' + (startParts[3] || '?') + ')');
          } else if (artifact.indexOf('loop_fix_failed:') === 0) {
            var fixParts = artifact.split(':');
            lines.push(ts + '  \u26A0\uFE0F fix attempt failed ' + (fixParts[1] || '') + ' #' + (fixParts[2] || '?') + ' (' + (fixParts[3] || 'failure') + ')');
          } else if (artifact.indexOf('loop_retry_failed:') === 0) {
            var retryParts = artifact.split(':');
            lines.push(ts + '  \u26A0\uFE0F retry check failed ' + (retryParts[1] || '') + ' #' + (retryParts[2] || '?') + ' (' + (retryParts[3] || 'failure') + ')');
          } else if (artifact.indexOf('loop_success:') === 0) {
            var successParts = artifact.split(':');
            lines.push(ts + '  \u2705 retry loop resolved ' + (successParts[1] || '') + ' on attempt #' + (successParts[2] || '?'));
          } else if (artifact.indexOf('loop_exhausted:') === 0) {
            var exhaustedParts = artifact.split(':');
            lines.push(ts + '  \u274C retry loop exhausted ' + (exhaustedParts[1] || '') + ' after ' + (exhaustedParts[2] || '?') + ' rounds');
          }
        } else if (evt.type === 'error') {
          lines.push(ts + '  \u274C ' + (evt.error || ''));
        }
      }

      el.pipelineTimeline.innerHTML = '';
      el.pipelineTimeline.appendChild(progressBar);
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin: 8px 0 0; white-space: pre-wrap; font-size: 11px;';
      pre.textContent = lines.join('\\n');
      el.pipelineTimeline.appendChild(pre);
    }

    function renderActivityStream(events, stats, isActive, serverTotalCount) {
      if (!events || events.length === 0) {
        el.activityStream.innerHTML = '<div class="act-info">No activity events parsed.</div>';
        el.actStats.innerHTML = isActive ? '<span class="live-badge">Live</span>' : '';
        el.actCount.textContent = '';
        el.actTruncated.style.display = 'none';
        lastRenderedEventCount = -1;
        return;
      }

      var totalCount = serverTotalCount != null ? serverTotalCount : events.length;

      // Skip re-render if event count unchanged (no new events since last poll)
      if (totalCount === lastRenderedEventCount) {
        return;
      }
      lastRenderedEventCount = totalCount;

      // Server already sliced via ?limit=N, so events here is the visible window
      var visibleEvents = events;
      var hiddenCount = totalCount - visibleEvents.length;

      // Show/hide truncation banner
      if (hiddenCount > 0) {
        el.actTruncated.style.display = '';
        el.actTruncatedCount.textContent = hiddenCount + ' earlier events hidden';
      } else {
        el.actTruncated.style.display = 'none';
      }

      // Snapshot which expandable sections are open (by index) before rebuilding
      var openIndices = {};
      var oldNodes = el.activityStream.querySelectorAll('.act-event');
      for (var oi = 0; oi < oldNodes.length; oi++) {
        if (oldNodes[oi].classList.contains('open')) {
          openIndices[oi] = true;
        }
      }

      // Snapshot scroll position to detect if user scrolled away from bottom
      var stream = el.activityStream;
      var wasNearBottom = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) < 60;

      el.activityStream.innerHTML = '';

      for (var idx = 0; idx < visibleEvents.length; idx++) {
        var ev = visibleEvents[idx];
        var node = document.createElement('div');
        node.className = 'act-event';

        if (ev.type === 'agent_thinking') {
          node.classList.add('act-thinking');
          node.innerHTML = miniMarkdown(ev.content);
        } else if (ev.type === 'tool_call') {
          node.classList.add('act-tool');

          var header = document.createElement('div');
          header.className = 'act-tool-header';

          var icon = document.createElement('span');
          icon.className = 'material-symbols-rounded act-tool-icon';
          icon.textContent = toolIcon(ev.tool);

          var name = document.createElement('span');
          name.className = 'act-tool-name';
          name.textContent = ev.tool || 'tool';

          var desc = document.createElement('span');
          desc.className = 'act-tool-desc';
          var descText = '';
          if (ev.params && ev.params.path) descText = ev.params.path;
          else if (ev.params && ev.params.command) descText = ev.params.command;
          else if (ev.params && ev.params.query) descText = '"' + ev.params.query + '"';
          desc.textContent = descText;

          var chevron = document.createElement('span');
          chevron.className = 'material-symbols-rounded act-tool-chevron';
          chevron.textContent = 'chevron_right';

          header.appendChild(icon);
          header.appendChild(name);
          header.appendChild(desc);
          header.appendChild(chevron);

          var body = document.createElement('div');
          body.className = 'act-tool-body';

          if (ev.params && Object.keys(ev.params).length > 0) {
            var params = document.createElement('div');
            params.className = 'act-tool-params';
            var keys = Object.keys(ev.params);
            for (var ki = 0; ki < keys.length; ki++) {
              var pk = document.createElement('span');
              pk.className = 'pk';
              pk.textContent = keys[ki];
              var pv = document.createElement('span');
              pv.className = 'pv';
              pv.textContent = ev.params[keys[ki]];
              params.appendChild(pk);
              params.appendChild(pv);
            }
            body.appendChild(params);
          }

          var contentLines = ev.content.split('\\n');
          var firstLine = contentLines[0] || '';
          var rest = contentLines.slice(1).join('\\n').trim();
          if (rest) {
            var output = document.createElement('div');
            output.className = 'act-tool-output';
            output.textContent = rest;
            body.appendChild(output);
          }

          // Show memory tool results (extracted from Annotated blocks)
          if (ev.result) {
            var resultDiv = document.createElement('div');
            resultDiv.className = 'act-tool-result';
            var resultLabel = document.createElement('span');
            resultLabel.className = 'act-result-label';
            resultLabel.textContent = 'result';
            resultDiv.appendChild(resultLabel);
            var resultText = document.createElement('pre');
            resultText.className = 'act-result-text';
            resultText.textContent = ev.result;
            resultDiv.appendChild(resultText);
            body.appendChild(resultDiv);
          }

          header.onclick = function(targetNode) {
            return function() {
              targetNode.classList.toggle('open');
            };
          }(node);

          node.appendChild(header);
          node.appendChild(body);
        } else if (ev.type === 'phase_marker') {
          node.classList.add('act-phase');
          var phaseIcon = document.createElement('span');
          phaseIcon.className = 'material-symbols-rounded';
          phaseIcon.textContent = ev.phase === 'cloning' ? 'download' : ev.phase === 'agent' ? 'smart_toy' : ev.phase === 'committing' ? 'save' : ev.phase === 'pushing' ? 'cloud_upload' : 'flag';
          node.appendChild(phaseIcon);
          // Show clean phase labels instead of raw pipeline commands
          var phaseLabels = {
            cloning: 'Cloning repository',
            agent: 'Agent started',
            committing: 'Committing changes',
            pushing: 'Pushing to remote',
          };
          var phaseLabel = phaseLabels[ev.phase] || ev.phase || 'phase';
          var phaseText = document.createTextNode(phaseLabel);
          node.appendChild(phaseText);
          if (ev.progressPercent > 0) {
            var phaseBadge = document.createElement('span');
            phaseBadge.className = 'act-badge';
            phaseBadge.textContent = ev.progressPercent + '%';
            node.appendChild(phaseBadge);
          }
        } else if (ev.type === 'session_start') {
          node.classList.add('act-session');
          var sessIcon = document.createElement('span');
          sessIcon.className = 'material-symbols-rounded';
          sessIcon.textContent = 'play_circle';
          node.appendChild(sessIcon);
          var sessText = document.createTextNode(ev.content);
          node.appendChild(sessText);
        } else if (ev.type === 'shell_cmd') {
          node.classList.add('act-tool');
          var shHeader = document.createElement('div');
          shHeader.className = 'act-tool-header';
          var shIcon = document.createElement('span');
          shIcon.className = 'material-symbols-rounded act-tool-icon';
          shIcon.textContent = 'terminal';
          var shName = document.createElement('span');
          shName.className = 'act-tool-name';
          shName.textContent = 'shell';
          var shDesc = document.createElement('span');
          shDesc.className = 'act-tool-desc';
          shDesc.textContent = ev.command || '';
          var shChevron = document.createElement('span');
          shChevron.className = 'material-symbols-rounded act-tool-chevron';
          shChevron.textContent = 'chevron_right';
          shHeader.appendChild(shIcon);
          shHeader.appendChild(shName);
          shHeader.appendChild(shDesc);
          shHeader.appendChild(shChevron);
          var shBody = document.createElement('div');
          shBody.className = 'act-tool-body';
          var shOutput = document.createElement('div');
          shOutput.className = 'act-tool-output';
          shOutput.textContent = ev.content;
          shBody.appendChild(shOutput);
          shHeader.onclick = function(targetNode) {
            return function() { targetNode.classList.toggle('open'); };
          }(node);
          node.appendChild(shHeader);
          node.appendChild(shBody);
        } else if (ev.type === 'pipeline_message') {
          node.classList.add('act-pipeline');
          if (ev.phase) node.classList.add('pl-' + ev.phase);
          var plIcon = document.createElement('span');
          plIcon.className = 'material-symbols-rounded';
          plIcon.textContent = ev.phase === 'success' ? 'check_circle' : ev.phase === 'error' ? 'error' : ev.phase === 'warn' ? 'warning' : 'settings';
          node.appendChild(plIcon);
          var plText = document.createTextNode(ev.content);
          node.appendChild(plText);
        } else {
          node.classList.add('act-info');
          node.textContent = ev.content;
        }

        // Restore open state from before re-render
        if (openIndices[idx]) {
          node.classList.add('open');
        }

        el.activityStream.appendChild(node);
      }

      if (stats) {
        el.actStats.innerHTML = '';
        if (isActive) {
          var liveBadge = document.createElement('span');
          liveBadge.className = 'live-badge';
          liveBadge.textContent = 'Live';
          el.actStats.appendChild(liveBadge);
        }
        var statItems = [
          { label: 'tools', value: stats.toolCalls },
          { label: 'thinking', value: stats.thinkingBlocks },
          { label: 'cmds', value: stats.shellCommands },
        ];
        for (var si = 0; si < statItems.length; si++) {
          var s = document.createElement('span');
          s.className = 'act-stat meta';
          s.textContent = statItems[si].value + ' ' + statItems[si].label;
          el.actStats.appendChild(s);
        }
      }

      el.actCount.textContent = (hiddenCount > 0 ? visibleEvents.length + ' of ' : '') + totalCount + ' events';

      if (el.autoScroll.checked && wasNearBottom) {
        el.activityStream.scrollTop = el.activityStream.scrollHeight;
      }
    }

    async function loadRuns() {
      const data = await fetchJson('/api/runs?limit=200');
      state.runs = data.runs || [];
      el.meta.textContent = state.runs.length + ' runs';
      if (el.topMeta) {
        el.topMeta.textContent = state.runs.length + ' runs';
      }
      if (state.selectedId && !state.runs.some((run) => run.id === state.selectedId)) {
        state.selectedId = null;
      }
      if (!state.selectedId && state.runs.length > 0) {
        state.selectedId = state.runs[0].id;
      }
      renderRuns();
    }

    function canRetry(run) {
      return run.status === 'failed' || run.status === 'completed';
    }

    async function refreshSelected() {
      if (!state.selectedId) {
        el.retryRun.disabled = true;
        renderSummary(null);
        renderActivityStream(null, null, false);
        renderPipelineTimeline(null, false);
        el.logViewerCard.style.display = 'none';
        el.logViewer.textContent = '';
        logStreamState.runId = null;
        logStreamState.offset = 0;
        el.feedbackToast.classList.remove('visible');
        return;
      }
      const [runData, changesData, eventsData, pipelineEventsData] = await Promise.all([
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId)),
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/changes'),
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/events' + (activityShowAll ? '' : '?limit=' + MAX_VISIBLE_EVENTS)).catch(function() { return { events: [], stats: null, totalCount: 0 }; }),
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/pipeline-events').catch(function() { return { events: [] }; }),
      ]);

      const run = runData.run;
      el.retryRun.disabled = !canRetry(run);
      renderSummary(run);

      const files = (changesData.files || []).slice();
      const detailed = (changesData.detailed || []).slice();
      renderFiles(files, detailed);

      var isActive = run && (run.status !== 'completed' && run.status !== 'failed');
      renderActivityStream(eventsData.events || [], eventsData.stats || null, isActive, eventsData.totalCount || 0);
      renderPipelineTimeline(pipelineEventsData.events || [], isActive);

      // Load media (screenshots + video) if available
      loadMedia(state.selectedId);

      // Show feedback toast for completed/failed runs without existing feedback
      var showToast = run && (run.status === 'completed' || run.status === 'failed') && !run.feedback;
      el.feedbackToast.classList.toggle('visible', showToast);
      el.feedbackUp.classList.toggle('selected', run.feedback && run.feedback.rating === 'up');
      el.feedbackDown.classList.toggle('selected', run.feedback && run.feedback.rating === 'down');

      await loadChatHistory();

      // Log streaming for active runs
      if (isActive) {
        el.logViewerCard.style.display = '';
        await pollLogStream();
      } else if (run) {
        // Show final log for completed/failed runs too
        el.logViewerCard.style.display = '';
        await pollLogStream();
      } else {
        el.logViewerCard.style.display = 'none';
        el.logViewer.textContent = '';
      }
    }

    // ── Log streaming ──

    function stripAnsi(str) {
      return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    }

    async function pollLogStream() {
      if (!state.selectedId) return;

      // Reset offset when switching runs
      if (logStreamState.runId !== state.selectedId) {
        logStreamState.runId = state.selectedId;
        logStreamState.offset = 0;
        el.logViewer.textContent = '';
        el.logTruncated.style.display = 'none';
      }

      try {
        var data = await fetchJson(
          '/api/runs/' + encodeURIComponent(state.selectedId) + '/log?offset=' + logStreamState.offset
        );

        if (data.content && data.content.length > 0) {
          var cleaned = stripAnsi(data.content);
          el.logViewer.textContent += cleaned;
          logStreamState.offset = data.offset;

          // Front-truncate if log exceeds MAX_LOG_CHARS
          var currentText = el.logViewer.textContent;
          if (currentText.length > MAX_LOG_CHARS) {
            var trimmed = currentText.slice(-MAX_LOG_CHARS);
            // Trim to next newline to avoid partial lines
            var nlIdx = trimmed.indexOf('\\n');
            if (nlIdx > 0 && nlIdx < 200) {
              trimmed = trimmed.slice(nlIdx + 1);
            }
            el.logViewer.textContent = trimmed;
            var truncKb = (logStreamState.offset / 1024).toFixed(0);
            el.logTruncatedMsg.textContent = 'Log truncated \\u2014 showing last ' + (MAX_LOG_CHARS / 1024).toFixed(0) + ' KB of ' + truncKb + ' KB';
            el.logTruncated.style.display = '';
          }

          // Auto-scroll
          if (el.logAutoScroll.checked) {
            el.logViewer.scrollTop = el.logViewer.scrollHeight;
          }
        }

        // Update size indicator
        var kb = (logStreamState.offset / 1024).toFixed(1);
        el.logSize.textContent = kb + ' KB';
      } catch (err) {
        // Silently ignore — log might not exist yet
      }
    }

    async function saveFeedback(rating) {
      if (!state.selectedId) {
        return;
      }
      el.feedbackUp.classList.toggle('selected', rating === 'up');
      el.feedbackDown.classList.toggle('selected', rating === 'down');
      await fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      await refreshSelected();
    }

    async function retrySelected() {
      if (!state.selectedId) {
        return;
      }
      el.retryRun.disabled = true;
      try {
        await fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/retry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ by: 'dashboard' }),
        });
        await refreshAll();
      } finally {
        await refreshSelected();
      }
    }

    el.feedbackUp.onclick = () => saveFeedback('up').catch(console.error);
    el.feedbackDown.onclick = () => saveFeedback('down').catch(console.error);
    el.retryRun.onclick = () => retrySelected().catch(console.error);
    el.actShowAll.onclick = function() {
      activityShowAll = true;
      lastRenderedEventCount = -1; // force re-render
      refreshSelected().catch(console.error);
    };
    el.settingsBtn.onclick = () => alert('Settings panel is not implemented yet.');
    el.logoutBtn.onclick = () => {
      document.cookie = 'gooseherd-session=; Max-Age=0; Path=/; SameSite=Strict';
      window.location.href = '/login';
    };

    // Chat / follow-up logic
    async function loadChatHistory() {
      if (!state.selectedId) {
        el.chatCard.style.display = 'none';
        return;
      }
      el.chatCard.style.display = '';
      var threadMsgCount = 0;
      try {
        var [chainData, conversationData] = await Promise.all([
          fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/chain'),
          fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/conversation').catch(function() { return { messages: [] }; }),
        ]);
        var chain = chainData.chain || [];
        var threadMessages = conversationData.messages || [];
        threadMsgCount = threadMessages.length;
        el.chatHistory.innerHTML = '';
        chain.forEach(function(run) {
          // Show the original task or follow-up instruction
          var isFollowUp = !!run.feedbackNote;
          var msgDiv = document.createElement('div');
          msgDiv.className = 'chat-msg human';
          var sender = document.createElement('div');
          sender.className = 'chat-sender';
          sender.textContent = isFollowUp ? 'Follow-up' : 'Original task';
          msgDiv.appendChild(sender);
          var content = document.createElement('div');
          content.textContent = run.feedbackNote || run.task;
          msgDiv.appendChild(content);
          var time = document.createElement('div');
          time.className = 'chat-time';
          var requester = run.requestedBy ? String(run.requestedBy) : 'unknown';
          time.textContent = formatDate(run.createdAt) + ' — by ' + requester + ' — ' + run.status;
          if (run.status === 'completed') time.textContent += ' ✅';
          if (run.status === 'failed') time.textContent += ' ❌';
          msgDiv.appendChild(time);
          el.chatHistory.appendChild(msgDiv);
          // Show agent result as a response bubble
          if (run.status === 'completed' || run.status === 'failed') {
            var agentDiv = document.createElement('div');
            agentDiv.className = 'chat-msg agent';
            var aSender = document.createElement('div');
            aSender.className = 'chat-sender';
            aSender.textContent = 'Agent';
            agentDiv.appendChild(aSender);
            var aContent = document.createElement('div');
            if (run.status === 'completed') {
              aContent.textContent = 'Completed. ' + (run.changedFiles ? run.changedFiles.length + ' files changed.' : '') + (run.prUrl ? ' PR: ' + run.prUrl : '');
            } else {
              aContent.textContent = 'Failed: ' + (run.error || 'unknown error');
            }
            agentDiv.appendChild(aContent);
            el.chatHistory.appendChild(agentDiv);
          } else if (run.status === 'running' || run.status === 'queued') {
            var workingDiv = document.createElement('div');
            workingDiv.className = 'chat-msg agent';
            workingDiv.innerHTML = '<div class="chat-sender">Agent</div><div>Working...</div>';
            el.chatHistory.appendChild(workingDiv);
          }
        });

        if (threadMessages.length > 0) {
          var sectionLabel = document.createElement('div');
          sectionLabel.className = 'chat-time';
          sectionLabel.style.margin = '8px 0 2px';
          sectionLabel.textContent = 'Thread Q/A (orchestrator memory)';
          el.chatHistory.appendChild(sectionLabel);

          threadMessages.forEach(function(msg) {
            var bubble = document.createElement('div');
            bubble.className = msg.role === 'user' ? 'chat-msg human' : 'chat-msg agent';

            var bubbleSender = document.createElement('div');
            bubbleSender.className = 'chat-sender';
            bubbleSender.textContent = msg.role === 'user' ? 'Thread user' : 'Assistant';
            bubble.appendChild(bubbleSender);

            var bubbleText = document.createElement('div');
            bubbleText.textContent = msg.content;
            bubble.appendChild(bubbleText);

            el.chatHistory.appendChild(bubble);
          });
        }

        el.chatHistory.scrollTop = el.chatHistory.scrollHeight;
      } catch(e) {
        console.error('Failed to load chain', e);
      }
      // Enable/disable send based on run status
      var selectedRun = state.runs.find(function(r) { return r.id === state.selectedId; });
      var canContinue = selectedRun && (selectedRun.status === 'completed' || selectedRun.status === 'failed');
      el.chatSend.disabled = !canContinue;
      var baseStatus = canContinue ? 'Ready for follow-up instructions.' : (selectedRun ? 'Waiting for run to finish...' : '');
      if (threadMsgCount > 0) {
        baseStatus += ' ' + threadMsgCount + ' thread messages visible.';
      }
      el.chatStatus.textContent = baseStatus;
    }

    async function sendFollowUp() {
      var note = el.chatInput.value.trim();
      if (!note || !state.selectedId) return;
      el.chatSend.disabled = true;
      el.chatStatus.textContent = 'Sending...';
      try {
        await fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedbackNote: note, by: 'dashboard' }),
        });
        el.chatInput.value = '';
        await refreshAll();
        await loadChatHistory();
      } catch(e) {
        el.chatStatus.textContent = 'Error: ' + (e.message || 'failed to send');
      }
    }

    el.chatSend.onclick = () => sendFollowUp().catch(console.error);
    el.chatInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendFollowUp().catch(console.error);
      }
    });

    // ── Observer panel ──

    var observerEl = {
      card: document.getElementById('observer-card'),
      subtitle: document.getElementById('observer-subtitle'),
      budget: document.getElementById('observer-budget'),
      rules: document.getElementById('observer-rules'),
      stats: document.getElementById('observer-stats'),
      events: document.getElementById('observer-events'),
    };

    function outcomeIcon(outcome) {
      if (outcome === 'triggered') return '\\u2705';
      if (outcome === 'denied') return '\\u26d4';
      if (outcome === 'no_match') return '\\u2796';
      if (outcome === 'approval_required') return '\\u23f3';
      return '\\u2753';
    }

    function renderObserverRules(rules, ruleOutcomes) {
      if (!rules || rules.length === 0) {
        observerEl.rules.textContent = 'No rules loaded.';
        return;
      }
      observerEl.rules.innerHTML = '';
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        var stats = (ruleOutcomes || {})[r.id];
        var row = document.createElement('div');
        row.style.cssText = 'padding: 4px 0; border-bottom: 1px dashed color-mix(in srgb, var(--border) 60%, transparent); font-size: 12px;';
        var approvalBadge = r.requiresApproval ? ' <span style="color: var(--warn); font-size: 10px;">[approval]</span>' : '';
        var statsLabel = stats ? ' <span style="font-size: 10px; color: var(--muted);">\\u2705' + stats.success + ' \\u274c' + stats.failure + '</span>' : '';
        row.innerHTML = '<span style="font-weight: 600; font-family: var(--font-mono);">' + r.id + '</span>' + approvalBadge + statsLabel +
          '<br><span style="color: var(--muted); font-size: 11px;">' + r.source + (r.repoSlug ? ' \\u00b7 ' + r.repoSlug : '') +
          ' \\u00b7 ' + r.conditions.length + ' condition' + (r.conditions.length !== 1 ? 's' : '') + '</span>';
        observerEl.rules.appendChild(row);
      }
    }

    function renderObserverStats(stateData) {
      if (!stateData || !stateData.enabled) {
        observerEl.stats.textContent = 'Observer not enabled.';
        return;
      }
      var lines = [];
      lines.push('Daily runs: <strong>' + stateData.dailyCount + '</strong> (' + stateData.counterDay + ')');

      var repoEntries = Object.entries(stateData.dailyPerRepo || {});
      if (repoEntries.length > 0) {
        for (var ri = 0; ri < repoEntries.length; ri++) {
          lines.push('\\u00a0\\u00a0' + repoEntries[ri][0] + ': ' + repoEntries[ri][1]);
        }
      }

      lines.push('Active dedup keys: ' + stateData.activeDedups + ' / ' + stateData.dedupCount + ' total');

      var rlEntries = Object.entries(stateData.rateLimitSources || {});
      if (rlEntries.length > 0) {
        lines.push('Rate limit events:');
        for (var si = 0; si < rlEntries.length; si++) {
          lines.push('\\u00a0\\u00a0' + rlEntries[si][0] + ': ' + rlEntries[si][1] + '/hr');
        }
      }

      observerEl.stats.innerHTML = lines.join('<br>');
    }

    function renderObserverEvents(events) {
      if (!events || events.length === 0) {
        observerEl.events.innerHTML = '<div class="act-info">No events processed yet.</div>';
        return;
      }
      observerEl.events.innerHTML = '';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var node = document.createElement('div');
        node.className = 'act-event act-info';
        node.style.cssText = 'padding: 6px 10px; font-size: 12px; line-height: 1.5; border-bottom: 1px dashed color-mix(in srgb, var(--border) 60%, transparent);';
        var icon = outcomeIcon(ev.outcome);
        var ruleLabel = ev.matchedRuleId ? ' \\u00b7 rule: <span style="font-family: var(--font-mono);">' + ev.matchedRuleId + '</span>' : '';
        var runLabel = ev.runId ? ' \\u00b7 <span style="font-family: var(--font-mono);">' + ev.runId.slice(0, 8) + '</span>' : '';
        node.innerHTML = icon + ' <strong>' + ev.source + '</strong>' +
          (ev.repoSlug ? ' \\u00b7 ' + ev.repoSlug : '') +
          ruleLabel + runLabel +
          '<br><span style="color: var(--muted); font-size: 11px;">' + ev.reason + ' \\u00b7 ' + timeAgo(ev.processedAt) + '</span>';
        observerEl.events.appendChild(node);
      }
    }

    async function refreshObserver() {
      try {
        var [stateData, eventsData, rulesData] = await Promise.all([
          fetchJson('/api/observer/state'),
          fetchJson('/api/observer/events?limit=50'),
          fetchJson('/api/observer/rules'),
        ]);

        if (!stateData.enabled) {
          observerEl.card.style.display = 'none';
          return;
        }

        observerEl.card.style.display = '';
        observerEl.subtitle.textContent = 'Day: ' + stateData.counterDay + ' \\u00b7 ' + (rulesData.rules || []).length + ' rules loaded';
        observerEl.budget.textContent = stateData.dailyCount + ' runs today';

        renderObserverRules(rulesData.rules || [], stateData.ruleOutcomes || {});
        renderObserverStats(stateData);
        renderObserverEvents(eventsData.events || []);
      } catch (e) {
        // Observer not available — hide panel
        observerEl.card.style.display = 'none';
      }
    }

    async function refreshAll() {
      await loadRuns();
      await refreshSelected();
      await refreshObserver();
    }

    initTheme();
    refreshAll().catch(console.error);
    state.interval = setInterval(() => {
      refreshAll().catch(console.error);
    }, 5000);
  </script>
</body>
</html>`;
}

export function startDashboardServer(
  config: AppConfig,
  store: RunStore,
  runManager?: Pick<RunManager, "retryRun" | "continueRun" | "getRunChain" | "saveFeedbackFromSlackAction">,
  observer?: DashboardObserver,
  conversationSource?: DashboardConversationSource
): void {
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${config.dashboardHost}:${String(config.dashboardPort)}`);
      const pathname = requestUrl.pathname;

      // Auth check — must come before route dispatch
      if (!checkAuth(req, res, config.dashboardToken, pathname)) return;

      if (req.method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Login page (GET)
      if (req.method === "GET" && pathname === "/login") {
        if (!config.dashboardToken) {
          res.statusCode = 302;
          res.setHeader("location", "/");
          res.end();
          return;
        }
        sendText(res, 200, loginPageHtml(config), "text/html");
        return;
      }

      // Login handler (POST)
      if (req.method === "POST" && pathname === "/login") {
        if (!config.dashboardToken) {
          res.statusCode = 302;
          res.setHeader("location", "/");
          res.end();
          return;
        }
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const token = params.get("token") ?? "";
        if (safeTokenCompare(token, config.dashboardToken)) {
          const sessionValue = hashToken(config.dashboardToken);
          res.statusCode = 302;
          res.setHeader("set-cookie", `gooseherd-session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/`);
          res.setHeader("location", "/");
          res.end();
          return;
        }
        sendText(res, 200, loginPageHtml(config, "Invalid token"), "text/html");
        return;
      }

      if (req.method === "GET" && pathname === "/") {
        sendText(res, 200, dashboardHtml(config), "text/html");
        return;
      }

      if (req.method === "GET" && pathname === "/api/runs") {
        const limit = parseLimit(requestUrl.searchParams.get("limit"));
        const teamId = requestUrl.searchParams.get("team") ?? undefined;
        const runs = await store.listRuns({ limit, teamId });
        sendJson(res, 200, { runs });
        return;
      }

      const parts = pathname.split("/").filter(Boolean);
      if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
        const id = decodeURIComponent(parts[2]);
        const run = await store.findRunByIdentifier(id);
        if (!run) {
          sendJson(res, 404, { error: `Run not found: ${id}` });
          return;
        }

        if (parts.length === 3 && req.method === "GET") {
          sendJson(res, 200, { run });
          return;
        }

        if (parts.length === 4 && parts[3] === "log" && req.method === "GET") {
          const logsPath = run.logsPath ?? path.resolve(config.workRoot, run.id, "run.log");
          const offsetParam = requestUrl.searchParams.get("offset");

          if (offsetParam !== null) {
            // Incremental mode: return content from byte offset
            const byteOffset = Math.max(0, Number.parseInt(offsetParam, 10) || 0);
            try {
              const result = await readLogFromOffset(logsPath, byteOffset);
              sendJson(res, 200, { runId: run.id, content: result.content, offset: result.newOffset });
            } catch {
              sendJson(res, 200, { runId: run.id, content: "", offset: byteOffset });
            }
          } else {
            // Legacy mode: return last N lines
            const lineCount = parseLimit(requestUrl.searchParams.get("lines"));
            try {
              const log = await readLogTail(logsPath, lineCount);
              sendJson(res, 200, { runId: run.id, lines: lineCount, log });
            } catch {
              sendJson(res, 200, { runId: run.id, lines: lineCount, log: "" });
            }
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "changes" && req.method === "GET") {
          const files = await getChangedFiles(config, run);
          const detailed = await getChangedFilesDetailed(config, run);
          sendJson(res, 200, { runId: run.id, files, detailed });
          return;
        }

        if (parts.length === 4 && parts[3] === "events" && req.method === "GET") {
          const logsPath = run.logsPath ?? path.resolve(config.workRoot, run.id, "run.log");
          const limitParam = requestUrl.searchParams.get("limit");
          try {
            const rawLog = await readFile(logsPath, "utf8");
            const allEvents = parseRunLog(rawLog);
            const stats = getEventStats(allEvents);
            const totalCount = allEvents.length;
            let events = allEvents;
            if (limitParam !== null) {
              const limit = Math.max(1, Number.parseInt(limitParam, 10) || 500);
              if (totalCount > limit) {
                events = allEvents.slice(-limit);
              }
            }
            sendJson(res, 200, { runId: run.id, events, stats, totalCount });
          } catch {
            sendJson(res, 200, { runId: run.id, events: [], stats: { totalEvents: 0, toolCalls: 0, thinkingBlocks: 0, shellCommands: 0, tools: {} }, totalCount: 0 });
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "pipeline-events" && req.method === "GET") {
          const eventsPath = path.resolve(config.workRoot, run.id, "events.jsonl");
          try {
            const raw = await readFile(eventsPath, "utf8");
            const events = raw.trim().split("\n").filter(Boolean).map(line => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);
            sendJson(res, 200, { runId: run.id, events });
          } catch {
            sendJson(res, 200, { runId: run.id, events: [] });
          }
          return;
        }

        // GET /api/runs/:id/artifacts/... — serve run artifacts (screenshots, videos, etc.)
        // Supports subdirectory paths like screenshots/final.png
        if (parts.length >= 5 && parts[3] === "artifacts" && req.method === "GET") {
          const filename = parts.slice(4).join("/");

          // Path traversal protection
          if (filename.includes("\\") || filename.includes("..") || filename.startsWith(".") || filename.startsWith("/")) {
            sendJson(res, 400, { error: "Invalid filename" });
            return;
          }

          // Allowlist of safe extensions
          const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".json", ".txt", ".log", ".zip", ".html", ".mp4", ".webm"]);
          const ext = path.extname(filename).toLowerCase();
          if (!ALLOWED_EXTENSIONS.has(ext)) {
            sendJson(res, 400, { error: `File type not allowed: ${ext}` });
            return;
          }

          const filePath = path.resolve(config.workRoot, run.id, filename);

          // Verify the resolved path stays within the run directory
          const runDir = path.resolve(config.workRoot, run.id);
          if (!filePath.startsWith(runDir + path.sep) && filePath !== runDir) {
            sendJson(res, 400, { error: "Invalid filename" });
            return;
          }

          try {
            await fsAccess(filePath);
          } catch {
            sendJson(res, 404, { error: `Artifact not found: ${filename}` });
            return;
          }

          const CONTENT_TYPES: Record<string, string> = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".json": "application/json",
            ".txt": "text/plain",
            ".log": "text/plain",
            ".zip": "application/zip",
            ".html": "text/html",
            ".mp4": "video/mp4",
            ".webm": "video/webm"
          };

          const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
          const fileData = await readFile(filePath);
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": String(fileData.length),
            "Cache-Control": "public, max-age=3600"
          });
          res.end(fileData);
          return;
        }

        // GET /api/runs/:id/media — list available screenshots and video for a run
        if (parts.length === 4 && parts[3] === "media" && req.method === "GET") {
          const { readdir, stat } = await import("node:fs/promises");
          const runDir = path.resolve(config.workRoot, run.id);
          const screenshots: Array<{ name: string; path: string; size: number }> = [];
          let video: { name: string; path: string; size: number } | undefined;

          // Scan screenshots directory
          try {
            const screenshotsDir = path.join(runDir, "screenshots");
            const files = await readdir(screenshotsDir);
            for (const file of files) {
              if (!file.endsWith(".png") && !file.endsWith(".jpg")) continue;
              const s = await stat(path.join(screenshotsDir, file));
              if (s.size > 1_000) {
                screenshots.push({
                  name: file,
                  path: `screenshots/${file}`,
                  size: s.size
                });
              }
            }
            screenshots.sort((a, b) => a.name.localeCompare(b.name));
          } catch {
            // No screenshots dir
          }

          // Scan for video files (.mp4 preferred, .webm fallback)
          try {
            const rootFiles = await readdir(runDir);
            const videoFile = rootFiles.find(f => f.endsWith(".mp4")) ?? rootFiles.find(f => f.endsWith(".webm"));
            if (videoFile) {
              const s = await stat(path.join(runDir, videoFile));
              if (s.size > 1_000) {
                video = { name: videoFile, path: videoFile, size: s.size };
              }
            }
          } catch {
            // Scan failed
          }

          // Scan for console-logs.json, network-log.json, agent-actions.json
          let consoleLogs: unknown[] | undefined;
          let networkLog: unknown[] | undefined;
          let agentActions: unknown[] | undefined;
          try {
            const consoleFile = path.join(runDir, "console-logs.json");
            const consoleData = await (await import("node:fs/promises")).readFile(consoleFile, "utf-8");
            consoleLogs = JSON.parse(consoleData);
          } catch {
            // No console logs
          }
          try {
            const networkFile = path.join(runDir, "network-log.json");
            const networkData = await (await import("node:fs/promises")).readFile(networkFile, "utf-8");
            networkLog = JSON.parse(networkData);
          } catch {
            // No network log
          }
          try {
            const actionsFile = path.join(runDir, "agent-actions.json");
            const actionsData = await (await import("node:fs/promises")).readFile(actionsFile, "utf-8");
            agentActions = JSON.parse(actionsData);
          } catch {
            // No agent actions
          }

          sendJson(res, 200, { runId: run.id, screenshots, video, consoleLogs, networkLog, agentActions });
          return;
        }

        if (parts.length === 4 && parts[3] === "feedback" && req.method === "POST") {
          const raw = await readBody(req);
          let parsed: { rating?: string; note?: string; by?: string } = {};
          try {
            parsed = JSON.parse(raw) as { rating?: string; note?: string; by?: string };
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }

          if (parsed.rating !== "up" && parsed.rating !== "down") {
            sendJson(res, 400, { error: "rating must be one of: up, down" });
            return;
          }

          const note = parsed.note?.trim().slice(0, 1000) || undefined;
          const by = parsed.by?.trim().slice(0, 120) || "dashboard";

          // Route through RunManager so lifecycle hooks store corrections for negative feedback
          if (runManager?.saveFeedbackFromSlackAction) {
            const updated = await runManager.saveFeedbackFromSlackAction({
              runId: run.id,
              rating: parsed.rating,
              userId: by,
              note
            });
            sendJson(res, 200, { ok: true, run: updated ?? run });
          } else {
            const feedback: RunFeedback = {
              rating: parsed.rating,
              note,
              by,
              at: new Date().toISOString()
            };
            const updated = await store.saveFeedback(run.id, feedback);
            sendJson(res, 200, { ok: true, run: updated });
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "retry" && req.method === "POST") {
          if (!runManager) {
            sendJson(res, 501, { error: "Retry is unavailable: run manager not attached." });
            return;
          }
          if (run.status !== "completed" && run.status !== "failed") {
            sendJson(res, 400, { error: "Can only retry completed or failed runs" });
            return;
          }

          const raw = await readBody(req);
          let parsed: { by?: string } = {};
          try {
            parsed = raw ? (JSON.parse(raw) as { by?: string }) : {};
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }

          const requestedBy = parsed.by?.trim().slice(0, 120) || "dashboard";
          const retried = await runManager.retryRun(run.id, requestedBy);
          if (!retried) {
            sendJson(res, 404, { error: `Run not found: ${run.id}` });
            return;
          }

          sendJson(res, 200, { ok: true, run: retried });
          return;
        }

        if (parts.length === 4 && parts[3] === "continue" && req.method === "POST") {
          if (!runManager?.continueRun) {
            sendJson(res, 501, { error: "Continue is unavailable: run manager not attached." });
            return;
          }
          if (run.status !== "completed" && run.status !== "failed") {
            sendJson(res, 400, { error: "Can only continue completed or failed runs" });
            return;
          }

          const raw = await readBody(req);
          let parsed: { feedbackNote?: string; by?: string } = {};
          try {
            parsed = raw ? (JSON.parse(raw) as { feedbackNote?: string; by?: string }) : {};
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }

          if (!parsed.feedbackNote?.trim()) {
            sendJson(res, 400, { error: "feedbackNote is required" });
            return;
          }

          const requestedBy = parsed.by?.trim().slice(0, 120) || "dashboard";
          const continued = await runManager.continueRun(run.id, parsed.feedbackNote.trim(), requestedBy);
          if (!continued) {
            sendJson(res, 404, { error: `Run not found: ${run.id}` });
            return;
          }

          sendJson(res, 200, { ok: true, run: continued });
          return;
        }

        if (parts.length === 4 && parts[3] === "chain" && req.method === "GET") {
          const chain = runManager?.getRunChain
            ? await runManager.getRunChain(run.channelId, run.threadTs)
            : [run];
          sendJson(res, 200, { chain });
          return;
        }

        if (parts.length === 4 && parts[3] === "conversation" && req.method === "GET") {
          const threadKey = `${run.channelId}:${run.threadTs}`;
          const messages = conversationSource?.get(threadKey) ?? [];
          sendJson(res, 200, {
            threadKey,
            available: Boolean(conversationSource),
            messages: buildConversationPreview(messages)
          });
          return;
        }
      }

      // ── Observer API routes ──

      if (req.method === "GET" && pathname === "/api/observer/state") {
        if (!observer) {
          sendJson(res, 200, { enabled: false });
          return;
        }
        sendJson(res, 200, { enabled: true, ...observer.getStateSnapshot() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/observer/events") {
        if (!observer) {
          sendJson(res, 200, { events: [] });
          return;
        }
        const limit = parseLimit(requestUrl.searchParams.get("limit"));
        sendJson(res, 200, { events: observer.getRecentEvents(limit) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/observer/rules") {
        if (!observer) {
          sendJson(res, 200, { rules: [] });
          return;
        }
        const rules = observer.getRules().map(r => ({
          id: r.id,
          source: r.source,
          conditions: r.conditions,
          pipeline: r.pipeline,
          requiresApproval: r.requiresApproval,
          cooldownMinutes: r.cooldownMinutes,
          maxRunsPerHour: r.maxRunsPerHour,
          repoSlug: r.repoSlug,
          skipTriage: r.skipTriage
        }));
        sendJson(res, 200, { rules });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown dashboard error";
      logError("Dashboard request failed", { error: message });
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    logInfo("Dashboard server started", {
      url: `http://${config.dashboardHost}:${String(config.dashboardPort)}`
    });
  });
}
