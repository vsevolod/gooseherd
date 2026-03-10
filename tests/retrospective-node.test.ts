/**
 * Tests for the retrospective pipeline node.
 */

import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { retrospectiveNode } from "../src/pipeline/nodes/retrospective.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";
import { RunLifecycleHooks } from "../src/hooks/run-lifecycle.js";
import type { MemoryProvider } from "../src/memory/provider.js";

// ── Helpers ──

function makeNodeConfig(
  id = "retro_1",
  config?: Record<string, unknown>
): NodeConfig {
  return { id, type: "deterministic", action: "retrospective", config };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `test-${Date.now()}`,
    status: "completed",
    phase: "completed",
    repoSlug: "org/repo",
    task: "Add a widget feature",
    baseBranch: "main",
    branchName: "gooseherd/test",
    requestedBy: "U_TEST",
    channelId: "C_TEST",
    threadTs: "0000.0000",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date().toISOString(),
    changedFiles: ["src/widget.ts", "tests/widget.test.ts"],
    tokenUsage: {
      qualityGateInputTokens: 500,
      qualityGateOutputTokens: 100,
      costUsd: 0.0042
    },
    title: "Add widget feature",
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

const MOCK_RETRO_RESPONSE = {
  summary: "The run completed successfully, implementing a widget feature with two file changes.",
  outcome_quality: "good",
  learnings: ["Test coverage was included alongside implementation", "Task stayed focused on a single feature"],
  failure_category: null,
  recommendations: ["Consider adding integration tests for widget rendering"],
  cost_assessment: "reasonable"
};

function makeMockFetchResponse() {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(MOCK_RETRO_RESPONSE) } }],
      model: "anthropic/claude-sonnet-4-6",
      usage: { prompt_tokens: 200, completion_tokens: 80 }
    }),
    { status: 200 }
  );
}

// ═══════════════════════════════════════════════════════
// Skip conditions
// ═══════════════════════════════════════════════════════

describe("retrospectiveNode — skip conditions", () => {
  test("skips when no OPENROUTER_API_KEY", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-skip-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag();
    const deps = makeDeps({
      configOverrides: { openrouterApiKey: undefined },
      logFile
    });

    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);

    assert.equal(result.outcome, "skipped");

    const log = await readFile(logFile, "utf8");
    assert.ok(log.includes("skipped (no OPENROUTER_API_KEY)"));

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════
// LLM call success
// ═══════════════════════════════════════════════════════

describe("retrospectiveNode — success", () => {
  test("calls LLM with run context and log, stores output in context bag", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-ok-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "[clone] done\n[implement] done\n", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () =>
      makeMockFetchResponse()
    );

    const ctx = new ContextBag();
    const run = makeRun();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key-123",
        defaultLlmModel: "anthropic/claude-sonnet-4-6"
      },
      run,
      logFile
    });

    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);

    assert.equal(result.outcome, "success");

    // Verify output stored in context bag
    const stored = ctx.get<typeof MOCK_RETRO_RESPONSE>("retrospective");
    assert.ok(stored);
    assert.equal(stored.outcome_quality, "good");
    assert.equal(stored.learnings.length, 2);
    assert.equal(stored.cost_assessment, "reasonable");

    // Verify output in result.outputs
    assert.ok(result.outputs);
    assert.deepEqual(result.outputs["retrospective"], stored);

    // Verify LLM was called with run context
    assert.equal(mockFetch.mock.callCount(), 1);
    const fetchBody = JSON.parse(
      mockFetch.mock.calls[0].arguments[1].body as string
    ) as { messages: Array<{ content: string }> };
    const userMsg = fetchBody.messages[1].content;
    assert.ok(userMsg.includes(run.id));
    assert.ok(userMsg.includes(run.repoSlug));
    assert.ok(userMsg.includes(run.task));

    // Verify log was appended
    const log = await readFile(logFile, "utf8");
    assert.ok(log.includes("[retrospective] quality=good; learnings=2"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("truncates log to last 3000 chars", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-trunc-"));
    const logFile = path.join(tmpDir, "test.log");
    // Write a log larger than 3000 chars
    const longLog = "x".repeat(5000);
    await writeFile(logFile, longLog, "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      // Verify the user message only contains the last 3000 chars
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ content: string }>;
      };
      const userMsg = body.messages[1].content;
      // The run log portion should be 3000 x's, not 5000
      const logSection = userMsg.split("## Run Log (last 3000 chars)\n")[1];
      assert.ok(logSection);
      assert.equal(logSection.length, 3000);

      return makeMockFetchResponse();
    });

    const ctx = new ContextBag();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      logFile
    });

    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("uses custom model from node config", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-model-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "log content\n", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string };
      assert.equal(body.model, "openai/gpt-4o-mini");
      return makeMockFetchResponse();
    });

    const ctx = new ContextBag();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "anthropic/claude-sonnet-4-6"
      },
      logFile
    });

    const result = await retrospectiveNode(
      makeNodeConfig("retro_custom", { model: "openai/gpt-4o-mini" }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "success");

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════

describe("retrospectiveNode — error handling", () => {
  test("returns skipped (not failure) on LLM error", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-err-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const ctx = new ContextBag();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      logFile
    });

    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);

    // Non-critical node: should skip, not fail
    assert.equal(result.outcome, "skipped");

    const log = await readFile(logFile, "utf8");
    assert.ok(log.includes("[retrospective] failed:"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("handles missing log file gracefully", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-nolog-"));
    const logFile = path.join(tmpDir, "nonexistent.log");
    // Don't create the log file — it shouldn't exist
    // But we need a writable log file for appendLog, so use /dev/null for the deps
    // and a non-existent path as the log to read
    const writeLogFile = path.join(tmpDir, "write.log");
    await writeFile(writeLogFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      // Verify the user message contains the fallback text
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ content: string }>;
      };
      const userMsg = body.messages[1].content;
      assert.ok(userMsg.includes("(log not available)"));
      return makeMockFetchResponse();
    });

    // Use the nonexistent log file path — the node should catch the read error
    // but we need appendLog to work, so we'll test with a file that exists for writing
    // The node reads deps.logFile for both reading the log and appending — use the writable one
    // and override the read by testing with a fresh node that has a non-existent path
    // Actually, the node uses deps.logFile for both reading and writing.
    // Since readFile will fail on a nonexistent path, the node catches it and uses fallback.
    // But appendLog will also fail... Let's use /dev/null for the log file and verify via context bag.

    const ctx = new ContextBag();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      logFile: logFile // nonexistent — readFile will fail, appendLog will also fail but silently
    });

    // appendLog writes to the same logFile. Since it doesn't exist, the write will create it.
    // Actually writeFile with flag "a" creates the file if it doesn't exist. So this is fine.
    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");

    // Verify fallback text was sent to LLM
    assert.equal(mockFetch.mock.callCount(), 1);

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════
// CEMS integration
// ═══════════════════════════════════════════════════════

describe("retrospectiveNode — CEMS integration", () => {
  test("stores retrospective in CEMS when memory provider is available", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-cems-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "some log content\n", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () =>
      makeMockFetchResponse()
    );

    // Create a mock memory provider
    const storedMemories: Array<{
      content: string;
      tags: string[];
      sourceRef?: string;
    }> = [];
    const mockMemory: MemoryProvider = {
      name: "mock-cems",
      searchMemories: async () => "",
      storeMemory: async (content, tags, sourceRef) => {
        storedMemories.push({ content, tags, sourceRef });
        return true;
      }
    };

    const hooks = new RunLifecycleHooks(mockMemory);

    const ctx = new ContextBag();
    const run = makeRun();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      run,
      logFile,
      hooks
    });

    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");

    // Verify memory was stored
    assert.equal(storedMemories.length, 1);
    assert.ok(storedMemories[0].content.includes("Run retrospective for org/repo"));
    assert.ok(storedMemories[0].content.includes("Learnings:"));
    assert.ok(storedMemories[0].tags.includes("org/repo"));
    assert.ok(storedMemories[0].tags.includes("completed"));
    assert.ok(storedMemories[0].tags.includes("good"));
    assert.equal(storedMemories[0].sourceRef, "project:org/repo");

    // Verify log mentions CEMS
    const log = await readFile(logFile, "utf8");
    assert.ok(log.includes("[retrospective] stored in CEMS"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("does not fail when CEMS store throws", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-cems-err-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () =>
      makeMockFetchResponse()
    );

    const mockMemory: MemoryProvider = {
      name: "failing-cems",
      searchMemories: async () => "",
      storeMemory: async () => {
        throw new Error("CEMS connection refused");
      }
    };

    const hooks = new RunLifecycleHooks(mockMemory);

    const ctx = new ContextBag();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      logFile,
      hooks
    });

    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);

    // Should still succeed — CEMS failure is non-fatal
    assert.equal(result.outcome, "success");

    // Verify the error was logged
    const log = await readFile(logFile, "utf8");
    assert.ok(log.includes("[retrospective] CEMS store failed: CEMS connection refused"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("skips CEMS when no hooks provided", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-no-hooks-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () =>
      makeMockFetchResponse()
    );

    const ctx = new ContextBag();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      logFile
      // No hooks
    });

    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");

    // Should not mention CEMS in log
    const log = await readFile(logFile, "utf8");
    assert.ok(!log.includes("CEMS"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("skips CEMS when hooks have no memory provider", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "retro-no-mem-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () =>
      makeMockFetchResponse()
    );

    // Hooks without a memory provider
    const hooks = new RunLifecycleHooks(undefined);

    const ctx = new ContextBag();
    const deps = makeDeps({
      configOverrides: {
        openrouterApiKey: "test-key",
        defaultLlmModel: "test-model"
      },
      logFile,
      hooks
    });

    const result = await retrospectiveNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");

    // Should not mention CEMS in log
    const log = await readFile(logFile, "utf8");
    assert.ok(!log.includes("CEMS"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
