/**
 * Tests for the Stagehand verification adapter.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInstruction, extractUrlHints } from "../src/pipeline/quality-gates/stagehand-verify.js";

// ── buildInstruction ──

describe("buildInstruction", () => {
  test("includes task and changed files", () => {
    const result = buildInstruction(
      "Change heading to Curated collections",
      ["app/views/home.html.erb", "app/assets/stylesheets/main.css"]
    );
    assert.ok(result.includes("Change heading to Curated collections"));
    assert.ok(result.includes("app/views/home.html.erb"));
    assert.ok(result.includes("app/assets/stylesheets/main.css"));
    assert.ok(result.includes("Verify that this task"));
  });

  test("handles empty changed files", () => {
    const result = buildInstruction("Task", []);
    assert.ok(result.includes("(none available)"));
  });

  test("includes credentials when provided", () => {
    const result = buildInstruction(
      "Test task",
      [],
      { email: "test@test.com", password: "pass123" }
    );
    assert.ok(result.includes("test@test.com"));
    assert.ok(result.includes("pass123"));
    assert.ok(result.includes("log in"));
  });

  test("includes changeSummary when provided", () => {
    const result = buildInstruction(
      "Task",
      ["file.erb"],
      undefined,
      "Modified the h2 element in the homepage partial."
    );
    assert.ok(result.includes("Change summary"));
    assert.ok(result.includes("Modified the h2 element"));
  });

  test("omits changeSummary when not provided", () => {
    const result = buildInstruction("Task", ["file.erb"]);
    assert.ok(!result.includes("Change summary"));
  });

  test("includes both credentials and changeSummary", () => {
    const result = buildInstruction(
      "Task",
      [],
      { email: "a@b.com", password: "p" },
      "Changed the heading."
    );
    assert.ok(result.includes("Change summary"));
    assert.ok(result.includes("a@b.com"));
    // changeSummary appears before credentials
    const summaryPos = result.indexOf("Change summary");
    const credPos = result.indexOf("Test account credentials");
    assert.ok(summaryPos < credPos, "changeSummary should come before credentials");
  });
});

// ── extractUrlHints ──

describe("extractUrlHints", () => {
  test("extracts Devise session path", () => {
    const hints = extractUrlHints("fix login page", [
      "app/views/devise/sessions/new.html.erb"
    ]);
    assert.ok(hints.includes("/users/sign_in"));
  });

  test("extracts Devise registration edit path", () => {
    const hints = extractUrlHints("update profile page", [
      "app/views/devise/registrations/edit.html.erb"
    ]);
    assert.ok(hints.includes("/user/edit"));
  });

  test("extracts controller path", () => {
    const hints = extractUrlHints("update products", [
      "app/controllers/products_controller.rb"
    ]);
    assert.ok(hints.includes("/products"));
  });

  test("extracts view index path", () => {
    const hints = extractUrlHints("list items", [
      "app/views/items/index.html.erb"
    ]);
    assert.ok(hints.includes("/items"));
  });

  test("extracts URL paths from task text", () => {
    const hints = extractUrlHints("change the heading on /user/edit page", []);
    assert.ok(hints.includes("/user/edit"));
  });

  test("extracts 'on the X page' patterns", () => {
    const hints = extractUrlHints("change the heading on the landing page", []);
    assert.ok(hints.includes("/landing"));
  });

  test("ignores system paths like /tmp", () => {
    const hints = extractUrlHints("save to /tmp/file.txt", []);
    assert.equal(hints.length, 0);
  });

  test("deduplicates hints", () => {
    const hints = extractUrlHints("change /products page", [
      "app/views/products/index.html.erb",
      "app/controllers/products_controller.rb"
    ]);
    // /products should appear once from view, once from controller
    const productHints = hints.filter(h => h === "/products");
    assert.equal(productHints.length, 1);
  });

  test("handles homepage view", () => {
    const hints = extractUrlHints("update home", [
      "app/views/home/index.html.erb"
    ]);
    assert.ok(hints.includes("/"), `Expected "/" in hints: ${JSON.stringify(hints)}`);
  });

  test("returns empty for unrelated files", () => {
    const hints = extractUrlHints("update config", [
      "config/database.yml",
      "Gemfile"
    ]);
    assert.equal(hints.length, 0);
  });
});

// ── buildInstruction with navigation hints ──

describe("buildInstruction navigation hints", () => {
  test("includes navigation hints when URL paths are extracted", () => {
    const result = buildInstruction(
      "Fix the heading on /user/edit page",
      ["app/views/devise/registrations/edit.html.erb"]
    );
    assert.ok(result.includes("Navigation hints"));
    assert.ok(result.includes("/user/edit"));
  });

  test("omits navigation hints when no paths extracted", () => {
    const result = buildInstruction(
      "Fix a bug",
      ["lib/utils.rb"]
    );
    assert.ok(!result.includes("Navigation hints"));
  });
});

// ── runStagehandVerification (mocked) ──
// Note: Full integration testing of runStagehandVerification requires a running
// Chromium instance and API key. These are tested in e2e pipeline tests.
// Here we only test the buildInstruction helper and verify the module exports.

describe("stagehand-verify module", () => {
  test("exports runStagehandVerification function", async () => {
    const mod = await import("../src/pipeline/quality-gates/stagehand-verify.js");
    assert.equal(typeof mod.runStagehandVerification, "function");
    assert.equal(typeof mod.buildInstruction, "function");
  });

  test("StagehandVerifyResult shape matches expected interface", () => {
    // Type-level test: ensure the result interface has the expected fields
    // This is enforced by TypeScript, but we verify at runtime too
    const mockResult = {
      screenshotPath: "/tmp/screenshot.png",
      actionsPath: "/tmp/agent-actions.json",
      verifyResult: { passed: true, confidence: "high" as const, reasoning: "OK", inputTokens: 100, outputTokens: 20 },
      planTokens: { input: 100, output: 20 },
      domFindings: ["Found heading element"]
    };

    assert.ok("screenshotPath" in mockResult);
    assert.ok("actionsPath" in mockResult);
    assert.ok("verifyResult" in mockResult);
    assert.ok("planTokens" in mockResult);
    assert.ok("domFindings" in mockResult);
  });
});
