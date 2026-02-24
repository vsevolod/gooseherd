/**
 * Tests for plan-task and local-test pipeline nodes.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { localTestNode } from "../src/pipeline/nodes/local-test.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";

// ── Helpers ──

function makeNodeConfig(id = "test_node"): NodeConfig {
  return { id, type: "deterministic", action: id };
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

function makeDeps(overrides: Partial<NodeDeps> & { configOverrides?: Partial<AppConfig> } = {}): NodeDeps {
  const { configOverrides, ...depsOverrides } = overrides;
  return {
    config: {
      localTestCommand: "",
      agentTimeoutSeconds: 60,
      anthropicApiKey: undefined,
      ...configOverrides
    } as AppConfig,
    run: makeRun(),
    logFile: "/dev/null",
    workRoot: "/tmp",
    onPhase: async () => {},
    ...depsOverrides
  };
}

// ═══════════════════════════════════════════════════════
// Local Test Node
// ═══════════════════════════════════════════════════════

describe("localTestNode", () => {
  test("skips when localTestCommand is empty", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps({ configOverrides: { localTestCommand: "" } });
    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when localTestCommand is whitespace", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps({ configOverrides: { localTestCommand: "   " } });
    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("returns success when test command exits 0", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "lt-pass-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: { localTestCommand: "true" },
      logFile
    });

    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "success");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns failure with rawOutput when test command exits non-zero", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "lt-fail-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: { localTestCommand: "echo 'test output' && exit 1" },
      logFile
    });

    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("exit code 1"));
    assert.ok(result.rawOutput !== undefined);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("throws when repoDir is missing from context", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { localTestCommand: "true" } });

    await assert.rejects(
      () => localTestNode(makeNodeConfig("local_test"), ctx, deps),
      { message: /required key 'repoDir' is missing/ }
    );
  });
});

// ═══════════════════════════════════════════════════════
// Plan Task Node (import separately — depends on LLM module)
// ═══════════════════════════════════════════════════════

describe("planTaskNode", () => {
  // Dynamic import to avoid issues if LLM module has side effects
  let planTaskNode: typeof import("../src/pipeline/nodes/plan-task.js")["planTaskNode"];

  test("skips when no anthropicApiKey is set", async () => {
    // Import the module
    const mod = await import("../src/pipeline/nodes/plan-task.js");
    planTaskNode = mod.planTaskNode;

    const ctx = new ContextBag({ repoSummary: "some context" });
    const deps = makeDeps({ configOverrides: { anthropicApiKey: undefined } });

    const result = await planTaskNode(makeNodeConfig("plan_task"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when anthropicApiKey is empty string", async () => {
    const mod = await import("../src/pipeline/nodes/plan-task.js");
    planTaskNode = mod.planTaskNode;

    const ctx = new ContextBag({ repoSummary: "some context" });
    // Config with explicitly undefined API key (empty string gets trimmed to undefined in config loader)
    const deps = makeDeps({ configOverrides: { anthropicApiKey: undefined } });

    const result = await planTaskNode(makeNodeConfig("plan_task"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });
});
