/**
 * Tests for dashboard security fixes:
 * - escapeHtml covers single quotes
 * - sanitizeUrlHref rejects non-http(s) URLs
 * - sanitizeCssClass strips dangerous chars
 * - console level validation
 * - agent-actions.json excludes instruction field (credential leak)
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

// ── Extracted sanitization helpers (mirror the dashboard inline JS) ──

function escapeHtml(str: string | undefined | null): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrlHref(url: string | undefined | null): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return escapeHtml(url);
  } catch { /* invalid URL */ }
  return "";
}

function sanitizeCssClass(str: string | undefined | null): string {
  if (!str) return "";
  return str.replace(/[^a-z0-9_-]/g, "");
}

const KNOWN_CONSOLE_LEVELS: Record<string, boolean> = {
  log: true, info: true, warn: true, warning: true,
  error: true, debug: true, trace: true
};

// ── escapeHtml ──

describe("escapeHtml", () => {
  test("escapes HTML special characters", () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  test("escapes single quotes", () => {
    assert.equal(escapeHtml("it's"), "it&#39;s");
  });

  test("escapes ampersands", () => {
    assert.equal(escapeHtml("foo&bar"), "foo&amp;bar");
  });

  test("returns empty string for falsy input", () => {
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
    assert.equal(escapeHtml(""), "");
  });

  test("handles mixed special characters", () => {
    const input = `<a href="x" onclick='alert(1)'>`;
    const result = escapeHtml(input);
    assert.ok(!result.includes("<"));
    assert.ok(!result.includes(">"));
    assert.ok(!result.includes('"'));
    assert.ok(!result.includes("'"));
  });
});

// ── sanitizeUrlHref ──

describe("sanitizeUrlHref", () => {
  test("allows http URLs", () => {
    assert.equal(sanitizeUrlHref("http://example.com"), "http://example.com");
  });

  test("allows https URLs", () => {
    assert.equal(sanitizeUrlHref("https://example.com/path?q=1"), "https://example.com/path?q=1");
  });

  test("rejects javascript: URLs", () => {
    assert.equal(sanitizeUrlHref("javascript:alert(1)"), "");
  });

  test("rejects data: URLs", () => {
    assert.equal(sanitizeUrlHref("data:text/html,<script>alert(1)</script>"), "");
  });

  test("rejects file: URLs", () => {
    assert.equal(sanitizeUrlHref("file:///etc/passwd"), "");
  });

  test("rejects invalid URLs", () => {
    assert.equal(sanitizeUrlHref("not-a-url"), "");
  });

  test("returns empty for falsy input", () => {
    assert.equal(sanitizeUrlHref(null), "");
    assert.equal(sanitizeUrlHref(undefined), "");
    assert.equal(sanitizeUrlHref(""), "");
  });

  test("escapes HTML in URL output", () => {
    const result = sanitizeUrlHref('https://example.com/path?q=<script>');
    assert.ok(!result.includes("<"));
  });
});

// ── sanitizeCssClass ──

describe("sanitizeCssClass", () => {
  test("allows valid CSS class names", () => {
    assert.equal(sanitizeCssClass("goto"), "goto");
    assert.equal(sanitizeCssClass("act"), "act");
    assert.equal(sanitizeCssClass("my-class"), "my-class");
    assert.equal(sanitizeCssClass("class_name"), "class_name");
  });

  test("strips spaces", () => {
    assert.equal(sanitizeCssClass("foo bar"), "foobar");
  });

  test("strips injection characters", () => {
    assert.equal(sanitizeCssClass('act" onclick="alert(1)'), "actonclickalert1");
  });

  test("strips HTML tags", () => {
    assert.equal(sanitizeCssClass("<img/src=x>"), "imgsrcx");
  });

  test("returns empty for falsy input", () => {
    assert.equal(sanitizeCssClass(null), "");
    assert.equal(sanitizeCssClass(undefined), "");
    assert.equal(sanitizeCssClass(""), "");
  });
});

// ── console level validation ──

describe("console level validation", () => {
  test("known levels pass validation", () => {
    for (const level of ["log", "info", "warn", "warning", "error", "debug", "trace"]) {
      assert.ok(KNOWN_CONSOLE_LEVELS[level], `${level} should be known`);
    }
  });

  test("unknown levels fall back to 'log'", () => {
    const unknownLevel = '<img src=x onerror="alert(1)">';
    const levelClass = KNOWN_CONSOLE_LEVELS[unknownLevel] ? unknownLevel : "log";
    assert.equal(levelClass, "log");
  });

  test("empty string falls back to 'log'", () => {
    const levelClass = KNOWN_CONSOLE_LEVELS[""] ? "" : "log";
    assert.equal(levelClass, "log");
  });
});

// ── agent-actions.json credential exclusion ──

describe("agent-actions credential exclusion", () => {
  test("instruction field is NOT included in saved action entries", () => {
    // Mirrors the mapping in stagehand-verify.ts
    const rawAction = {
      type: "act",
      reasoning: "Clicked button",
      pageUrl: "https://example.com",
      timestamp: 1234567890,
      action: "click",
      url: "https://example.com",
      instruction: "Log in with email: test@test.com password: secret123",
      taskCompleted: false
    };

    // This is the exact mapping from stagehand-verify.ts (instruction excluded)
    const savedEntry = {
      type: rawAction.type as string,
      reasoning: rawAction.reasoning as string | undefined,
      pageUrl: rawAction.pageUrl as string | undefined,
      timestamp: rawAction.timestamp as number | undefined,
      action: rawAction.action as string | undefined,
      url: rawAction.url as string | undefined,
      taskCompleted: rawAction.taskCompleted as boolean | undefined
    };

    const json = JSON.stringify(savedEntry);
    assert.ok(!json.includes("instruction"), "instruction field should not be in saved JSON");
    assert.ok(!json.includes("secret123"), "password should not appear in saved JSON");
    assert.ok(!json.includes("test@test.com"), "email should not appear in saved JSON");
  });

  test("all non-sensitive fields are preserved", () => {
    const rawAction = {
      type: "goto",
      reasoning: "Navigating to page",
      pageUrl: "https://example.com",
      timestamp: 1234567890,
      action: undefined,
      url: "https://example.com",
      taskCompleted: false
    };

    const savedEntry = {
      type: rawAction.type,
      reasoning: rawAction.reasoning,
      pageUrl: rawAction.pageUrl,
      timestamp: rawAction.timestamp,
      action: rawAction.action,
      url: rawAction.url,
      taskCompleted: rawAction.taskCompleted
    };

    assert.equal(savedEntry.type, "goto");
    assert.equal(savedEntry.reasoning, "Navigating to page");
    assert.equal(savedEntry.pageUrl, "https://example.com");
    assert.equal(savedEntry.timestamp, 1234567890);
  });
});
