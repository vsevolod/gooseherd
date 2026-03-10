import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import { verifyPassword } from "../db/setup-store.js";
import { escapeHtml } from "./html.js";

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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

export function safeTokenCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export interface AuthOptions {
  /** DASHBOARD_TOKEN env var (takes priority). */
  dashboardToken?: string;
  /** Wizard password hash from DB. */
  passwordHash?: string;
  /** Whether setup wizard is complete. */
  setupComplete: boolean;
}

/**
 * Check if a request is authenticated.
 * Returns true if auth passes, false if the response has been handled (401/redirect).
 */
export function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AuthOptions,
  pathname: string
): boolean {
  // Health check always passes
  if (pathname === "/healthz") return true;

  // Login routes always pass
  if (pathname === "/login") return true;

  // ── Setup wizard auth logic ──
  if (!opts.setupComplete) {
    // Wizard page and status are always accessible during setup
    if (pathname === "/setup" || pathname === "/api/setup/status") return true;
    // Password endpoint always accessible (first step, before any auth exists)
    if (pathname === "/api/setup/password") return true;

    // Other setup routes require session cookie after password is set
    if (pathname.startsWith("/api/setup/")) {
      if (opts.passwordHash) {
        const cookies = parseCookies(req);
        const sessionHash = cookies["gooseherd-session"];
        if (sessionHash && safeTokenCompare(sessionHash, hashToken(opts.passwordHash))) return true;
      }
      sendJson(res, 401, { error: "Unauthorized" });
      return false;
    }

    // Non-setup routes during incomplete setup: redirect to /setup
    if (pathname.startsWith("/api/")) {
      sendJson(res, 503, { error: "Setup not complete" });
      return false;
    }
    res.statusCode = 302;
    res.setHeader("location", "/setup");
    res.end();
    return false;
  }

  // ── Normal auth (setup complete) ──

  const effectiveToken = opts.dashboardToken;

  // Parse session cookie once (used by both token and password auth)
  const cookies = parseCookies(req);
  const sessionHash = cookies["gooseherd-session"];

  // Check env-var token (Bearer header for API routes, session cookie for all)
  if (effectiveToken) {
    if (pathname.startsWith("/api/")) {
      const authHeader = req.headers["authorization"] ?? "";
      if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        if (safeTokenCompare(token, effectiveToken)) return true;
      }
    }
    if (sessionHash && safeTokenCompare(sessionHash, hashToken(effectiveToken))) return true;
  }

  // Check wizard password hash session cookie (works alongside env token)
  if (opts.passwordHash && sessionHash) {
    if (safeTokenCompare(sessionHash, hashToken(opts.passwordHash))) return true;
  }

  // No auth configured at all — allow access (backward compat for localhost dev)
  if (!effectiveToken && !opts.passwordHash) return true;

  // Not authenticated — redirect or 401
  if (pathname.startsWith("/api/")) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }

  res.statusCode = 302;
  res.setHeader("location", "/login");
  res.end();
  return false;
}

/**
 * Handle POST /login — supports both env-var token and wizard password.
 * Returns the session cookie value on success, or undefined on failure.
 */
export async function handleLogin(
  submittedValue: string,
  opts: AuthOptions
): Promise<string | undefined> {
  // Check env-var token first
  if (opts.dashboardToken && safeTokenCompare(submittedValue, opts.dashboardToken)) {
    return hashToken(opts.dashboardToken);
  }
  // Check wizard password (async scrypt)
  if (opts.passwordHash && await verifyPassword(submittedValue, opts.passwordHash)) {
    return hashToken(opts.passwordHash);
  }
  return undefined;
}

/** Render the login page. */
export function loginPageHtml(config: AppConfig, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.appName)} — Login</title>
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
    <h1>${escapeHtml(config.appName)}</h1>
    <p>Enter your password to continue.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <label for="token">Password</label>
    <input type="password" id="token" name="token" autofocus required />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}
