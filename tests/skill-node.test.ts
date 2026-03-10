/**
 * Tests for the skill pipeline node (agent + llm modes).
 */

import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { skillNode } from "../src/pipeline/nodes/skill.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";

// ── Helpers ──

function makeNodeConfig(
  id = "skill_1",
  config?: Record<string, unknown>
): NodeConfig {
  return { id, type: "agentic", action: "skill", config };
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

function makeDeps(
  overrides: Partial<NodeDeps> & { configOverrides?: Partial<AppConfig> } = {}
): NodeDeps {
  const { configOverrides, ...depsOverrides } = overrides;
  return {
    config: {
      agentTimeoutSeconds: 60,
      agentCommandTemplate: "echo agent {{prompt_file}}",
      workRoot: "/tmp",
      openrouterApiKey: undefined,
      defaultLlmModel: "anthropic/claude-sonnet-4-6",
      openrouterProviderPreferences: undefined,
      mcpExtensions: [],
      piAgentExtensions: [],
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
// Missing instruction
// ═══════════════════════════════════════════════════════

describe("skillNode", () => {
  test("returns failure when config.instruction is missing", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps();
    const result = await skillNode(makeNodeConfig("skill_1", {}), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("requires config.instruction"));
  });

  test("returns failure when config.instruction is empty string", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps();
    const result = await skillNode(
      makeNodeConfig("skill_1", { instruction: "   " }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("requires config.instruction"));
  });

  test("returns failure when config is undefined", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps();
    const result = await skillNode(makeNodeConfig("skill_1"), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("requires config.instruction"));
  });
});

// ═══════════════════════════════════════════════════════
// Agent mode
// ═══════════════════════════════════════════════════════

describe("skillNode — agent mode", () => {
  test("writes prompt file and runs agent command", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-agent-"));
    const runId = `run-${Date.now()}`;
    const runDir = path.join(tmpDir, runId);
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    // Create run directory
    const { mkdir } = await import("node:fs/promises");
    await mkdir(runDir, { recursive: true });

    const ctx = new ContextBag({ repoDir: tmpDir });
    const run = makeRun({ id: runId });
    const deps = makeDeps({
      configOverrides: {
        agentCommandTemplate: "echo skill-agent-ran",
        workRoot: tmpDir
      },
      run,
      logFile,
      workRoot: tmpDir
    });

    const result = await skillNode(
      makeNodeConfig("my_skill", {
        instruction: "Refactor the widget module"
      }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "success");

    // Verify prompt file was written
    const promptPath = path.join(tmpDir, runId, "skill-my_skill.md");
    const content = await readFile(promptPath, "utf8");
    assert.ok(content.includes("Refactor the widget module"));

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("includes context keys in prompt file", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-ctx-"));
    const runId = `run-${Date.now()}`;
    const runDir = path.join(tmpDir, runId);
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const { mkdir } = await import("node:fs/promises");
    await mkdir(runDir, { recursive: true });

    const ctx = new ContextBag({
      repoDir: tmpDir,
      task: "Build feature X",
      repoSummary: "A Rails app"
    });
    const run = makeRun({ id: runId });
    const deps = makeDeps({
      configOverrides: {
        agentCommandTemplate: "echo ok",
        workRoot: tmpDir
      },
      run,
      logFile,
      workRoot: tmpDir
    });

    const result = await skillNode(
      makeNodeConfig("ctx_skill", {
        instruction: "Implement the feature",
        context_keys: ["task", "repoSummary"]
      }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "success");

    const promptPath = path.join(tmpDir, runId, "skill-ctx_skill.md");
    const content = await readFile(promptPath, "utf8");
    assert.ok(content.includes("Implement the feature"));
    assert.ok(content.includes("Build feature X"));
    assert.ok(content.includes("A Rails app"));

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns failure when agent exits non-zero", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-fail-"));
    const runId = `run-${Date.now()}`;
    const runDir = path.join(tmpDir, runId);
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const { mkdir } = await import("node:fs/promises");
    await mkdir(runDir, { recursive: true });

    const ctx = new ContextBag({ repoDir: tmpDir });
    const run = makeRun({ id: runId });
    const deps = makeDeps({
      configOverrides: {
        agentCommandTemplate: "exit 1",
        workRoot: tmpDir
      },
      run,
      logFile,
      workRoot: tmpDir
    });

    const result = await skillNode(
      makeNodeConfig("fail_skill", {
        instruction: "Do something"
      }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("exited with code 1"));

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("respects custom timeout_seconds", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-timeout-"));
    const runId = `run-${Date.now()}`;
    const runDir = path.join(tmpDir, runId);
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const { mkdir } = await import("node:fs/promises");
    await mkdir(runDir, { recursive: true });

    const ctx = new ContextBag({ repoDir: tmpDir });
    const run = makeRun({ id: runId });
    const deps = makeDeps({
      configOverrides: {
        agentCommandTemplate: "echo ok",
        agentTimeoutSeconds: 600,
        workRoot: tmpDir
      },
      run,
      logFile,
      workRoot: tmpDir
    });

    const result = await skillNode(
      makeNodeConfig("timeout_skill", {
        instruction: "Quick task",
        timeout_seconds: 30
      }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "success");

    // Verify the log mentions the custom timeout
    const log = await readFile(logFile, "utf8");
    assert.ok(log.includes("timeout 30s"));

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════
// LLM mode
// ═══════════════════════════════════════════════════════

describe("skillNode — llm mode", () => {
  test("skips when no API key configured", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-llm-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: { openrouterApiKey: undefined },
      logFile
    });

    const result = await skillNode(
      makeNodeConfig("llm_skill", {
        instruction: "Analyze this",
        mode: "llm"
      }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "skipped");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("stores output in context bag under output_key", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-llm-ok-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    // Mock fetch to simulate OpenRouter response
    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"risk": "low", "reason": "tests pass"}' } }],
          model: "anthropic/claude-sonnet-4-6",
          usage: { prompt_tokens: 100, completion_tokens: 25 }
        }),
        { status: 200 }
      );
    });

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key-123",
        defaultLlmModel: "anthropic/claude-sonnet-4-6"
      },
      logFile
    });

    const result = await skillNode(
      makeNodeConfig("analyze_risk", {
        instruction: "Assess the risk level",
        mode: "llm",
        output_key: "risk_assessment"
      }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "success");

    // Verify output stored in context bag
    const stored = ctx.get<Record<string, unknown>>("risk_assessment");
    assert.ok(stored);
    assert.equal(stored["risk"], "low");
    assert.equal(stored["reason"], "tests pass");

    // Verify output also in result outputs
    assert.ok(result.outputs);
    assert.deepEqual(result.outputs["risk_assessment"], stored);

    // Verify token usage tracked
    const tokenUsage = ctx.get<Record<string, unknown>>("_tokenUsage_analyze_risk");
    assert.ok(tokenUsage);
    assert.equal(tokenUsage["input"], 100);
    assert.equal(tokenUsage["output"], 25);

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("uses default output_key when not specified", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-llm-def-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"result": "ok"}' } }],
          model: "test-model",
          usage: { prompt_tokens: 50, completion_tokens: 10 }
        }),
        { status: 200 }
      );
    });

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      logFile
    });

    const result = await skillNode(
      makeNodeConfig("check_42", {
        instruction: "Check something",
        mode: "llm"
      }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "success");

    // Default key is skill_{nodeId}_output
    const stored = ctx.get<Record<string, unknown>>("skill_check_42_output");
    assert.ok(stored);
    assert.equal(stored["result"], "ok");

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns failure when LLM call fails", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-llm-err-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      logFile
    });

    const result = await skillNode(
      makeNodeConfig("fail_llm", {
        instruction: "This will fail",
        mode: "llm"
      }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("Skill LLM call failed"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
