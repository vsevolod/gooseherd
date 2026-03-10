/**
 * Tests for the generic "run" pipeline node.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { runNode } from "../src/pipeline/nodes/run.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";

// ── Helpers ──

function makeNodeConfig(config?: Record<string, unknown>): NodeConfig {
  return { id: "run_step", type: "deterministic", action: "run", config };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `test-${Date.now()}`,
    status: "running",
    phase: "agent",
    repoSlug: "org/repo",
    task: "Test task",
    baseBranch: "main",
    branchName: "gooseherd/test",
    requestedBy: "U_TEST",
    channelId: "C_TEST",
    threadTs: "0000.0000",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeDeps(overrides: Partial<NodeDeps> = {}): NodeDeps {
  return {
    config: {} as AppConfig,
    run: makeRun(),
    logFile: "/dev/null",
    workRoot: "/tmp",
    onPhase: async () => {},
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════
// Run Node
// ═══════════════════════════════════════════════════════

describe("runNode", () => {
  test("returns failure when config.command is missing", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps();
    const result = await runNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.equal(result.error, "run node requires config.command");
  });

  test("returns failure when config.command is empty string", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps();
    const result = await runNode(makeNodeConfig({ command: "  " }), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.equal(result.error, "run node requires config.command");
  });

  test("returns success when command exits 0", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "run-pass-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({ logFile });

    const result = await runNode(makeNodeConfig({ command: "true" }), ctx, deps);
    assert.equal(result.outcome, "success");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns failure with rawOutput when command exits non-zero", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "run-fail-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({ logFile });

    const result = await runNode(
      makeNodeConfig({ command: "echo 'some error' >&2 && exit 1" }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("exit code 1"));
    assert.ok(result.rawOutput !== undefined);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("stores stdout in output_key when configured", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "run-out-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({ logFile });

    const result = await runNode(
      makeNodeConfig({ command: "echo hello-world", output_key: "my_output" }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.my_output, "hello-world");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("does not set outputs when output_key is not configured", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "run-noout-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({ logFile });

    const result = await runNode(
      makeNodeConfig({ command: "echo hello" }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "success");
    assert.equal(result.outputs, undefined);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("uses custom cwd when configured", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "run-cwd-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps({ logFile });

    const result = await runNode(
      makeNodeConfig({ command: "pwd", cwd: tmpDir, output_key: "dir" }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "success");
    // pwd output should match the custom cwd (resolve symlinks for macOS /var → /private/var)
    const realTmpDir = await realpath(tmpDir);
    assert.equal(result.outputs?.dir, realTmpDir);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("renders template variables in command", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "run-tpl-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const runRecord = makeRun({ id: "run-42", repoSlug: "acme/widget" });
    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({ logFile, run: runRecord });

    const result = await runNode(
      makeNodeConfig({ command: "echo {{run_id}} {{repo_slug}}", output_key: "rendered" }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "success");
    // renderTemplate shell-escapes values, so they appear quoted
    assert.ok(result.outputs?.rendered === "run-42 acme/widget");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("works without repoDir in context", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "run-norepo-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag();
    const deps = makeDeps({ logFile });

    const result = await runNode(makeNodeConfig({ command: "true" }), ctx, deps);
    assert.equal(result.outcome, "success");

    await rm(tmpDir, { recursive: true, force: true });
  });
});
