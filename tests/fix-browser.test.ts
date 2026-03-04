import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildBrowserFixPrompt } from "../src/pipeline/nodes/fix-browser.js";

describe("buildBrowserFixPrompt", () => {
  const baseArgs = {
    task: "Change the heading to 'Hello World'",
    verdictReason: "[low] Heading still shows old text",
    domFindings: ["Found h1 with text 'Old Heading'"],
    changedFiles: ["app/views/home/index.html.erb"],
    reviewAppUrl: "https://123.stg.epicpxls.com"
  };

  test("includes basic fields", () => {
    const result = buildBrowserFixPrompt(
      baseArgs.task, baseArgs.verdictReason, baseArgs.domFindings,
      baseArgs.changedFiles, baseArgs.reviewAppUrl
    );
    assert.ok(result.includes("Change the heading to 'Hello World'"));
    assert.ok(result.includes("[low] Heading still shows old text"));
    assert.ok(result.includes("app/views/home/index.html.erb"));
    assert.ok(result.includes("123.stg.epicpxls.com"));
    assert.ok(result.includes("Found h1 with text 'Old Heading'"));
  });

  test("includes agent actions when provided", () => {
    const actions = [
      { type: "navigate", reasoning: "Going to homepage", pageUrl: "https://example.com/" },
      { type: "click", reasoning: "Clicking the menu", pageUrl: "https://example.com/menu" }
    ];
    const result = buildBrowserFixPrompt(
      baseArgs.task, baseArgs.verdictReason, baseArgs.domFindings,
      baseArgs.changedFiles, baseArgs.reviewAppUrl,
      actions
    );
    assert.ok(result.includes("Browser Agent Actions"));
    assert.ok(result.includes("Going to homepage"));
    assert.ok(result.includes("Clicking the menu"));
    assert.ok(result.includes("https://example.com/menu"));
  });

  test("includes console errors when provided", () => {
    const errors = [
      { level: "error", text: "Uncaught TypeError: Cannot read property 'map' of undefined" },
      { level: "warning", text: "Deprecation warning: use fetch instead of XMLHttpRequest" }
    ];
    const result = buildBrowserFixPrompt(
      baseArgs.task, baseArgs.verdictReason, baseArgs.domFindings,
      baseArgs.changedFiles, baseArgs.reviewAppUrl,
      undefined, errors
    );
    assert.ok(result.includes("Console Errors"));
    assert.ok(result.includes("Uncaught TypeError"));
    assert.ok(result.includes("[warning]"));
  });

  test("handles missing console text without crashing", () => {
    const errors = [
      { level: "error", text: "" },
      { level: "warning", text: "(no console text)" }
    ];
    const result = buildBrowserFixPrompt(
      baseArgs.task, baseArgs.verdictReason, baseArgs.domFindings,
      baseArgs.changedFiles, baseArgs.reviewAppUrl,
      undefined, errors
    );
    assert.ok(result.includes("Console Errors"));
    assert.ok(result.includes("[error]"));
    assert.ok(result.includes("(no console text)"));
  });

  test("includes last visited URL when provided", () => {
    const result = buildBrowserFixPrompt(
      baseArgs.task, baseArgs.verdictReason, baseArgs.domFindings,
      baseArgs.changedFiles, baseArgs.reviewAppUrl,
      undefined, undefined, "https://123.stg.epicpxls.com/user/edit"
    );
    assert.ok(result.includes("Last Visited URL"));
    assert.ok(result.includes("https://123.stg.epicpxls.com/user/edit"));
  });

  test("includes failure history when provided", () => {
    const history = [
      { round: 1, verdict: "Heading still not visible" },
      { round: 2, verdict: "CSS class wrong" }
    ];
    const result = buildBrowserFixPrompt(
      baseArgs.task, baseArgs.verdictReason, baseArgs.domFindings,
      baseArgs.changedFiles, baseArgs.reviewAppUrl,
      undefined, undefined, undefined, history
    );
    assert.ok(result.includes("Previous Fix Attempts"));
    assert.ok(result.includes("Round 1: Heading still not visible"));
    assert.ok(result.includes("Round 2: CSS class wrong"));
    assert.ok(result.includes("Do NOT repeat the same approach"));
  });

  test("omits optional sections when not provided", () => {
    const result = buildBrowserFixPrompt(
      baseArgs.task, baseArgs.verdictReason, [],
      [], baseArgs.reviewAppUrl
    );
    assert.ok(!result.includes("Browser Agent Actions"));
    assert.ok(!result.includes("Console Errors"));
    assert.ok(!result.includes("Last Visited URL"));
    assert.ok(!result.includes("Previous Fix Attempts"));
    assert.ok(!result.includes("DOM Inspection Results"));
    assert.ok(!result.includes("Files Changed"));
  });
});
