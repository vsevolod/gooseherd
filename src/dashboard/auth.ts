import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
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
    <p>Enter your dashboard token to continue.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <label for="token">Token</label>
    <input type="password" id="token" name="token" autofocus required />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}
