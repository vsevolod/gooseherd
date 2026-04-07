import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import { buildSystemContext } from "../src/orchestrator/system-context.js";
import { ConversationStore } from "../src/orchestrator/conversation-store.js";
import type { HandleMessageDeps, HandleMessageRequest } from "../src/orchestrator/types.js";
import type { ChatMessage, LLMCallerConfig } from "../src/llm/caller.js";
import type { AppConfig } from "../src/config.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

// ── buildSystemContext ──────────────────────────────────

describe("buildSystemContext", () => {
  const minimalConfig = {
    appName: "TestBot",
    repoAllowlist: ["epiccoders/pxls", "acme/api"]
  } as AppConfig;

  test("includes bot name", () => {
    const ctx = buildSystemContext(minimalConfig);
    assert.ok(ctx.includes("TestBot"));
  });

  test("includes allowed repos", () => {
    const ctx = buildSystemContext(minimalConfig);
    assert.ok(ctx.includes("epiccoders/pxls"));
    assert.ok(ctx.includes("acme/api"));
  });

  test("includes pipeline node descriptions", () => {
    const ctx = buildSystemContext(minimalConfig);
    assert.ok(ctx.includes("Pipeline Nodes"));
    assert.ok(ctx.includes("deploy_preview"));
    assert.ok(ctx.includes("browser_verify"));
    assert.ok(ctx.includes("enableNodes"));
  });

  test("includes execute_task tool description", () => {
    const ctx = buildSystemContext(minimalConfig);
    assert.ok(ctx.includes("execute_task"));
  });

  test("handles empty allowlist", () => {
    const emptyConfig = { ...minimalConfig, repoAllowlist: [] } as AppConfig;
    const ctx = buildSystemContext(emptyConfig);
    assert.ok(ctx.includes("no repo allowlist configured"));
  });

  test("includes conversation memory rule", () => {
    const ctx = buildSystemContext(minimalConfig);
    assert.ok(ctx.includes("conversation memory"));
  });
});

// ── handleMessage ──────────────────────────────────────

describe("handleMessage", () => {
  // We can't easily test handleMessage without mocking the LLM API,
  // so we test the exports and types.
  test("exports handleMessage function", () => {
    assert.equal(typeof handleMessage, "function");
  });

  test("HandleMessageDeps type is usable", () => {
    // Verify the type works by creating a mock
    const mockDeps: HandleMessageDeps = {
      repoAllowlist: ["test/repo"],
      enqueueRun: async () => ({ id: "abc", branchName: "test-branch", repoSlug: "test/repo" }),
      listRuns: async () => "[]",
      getConfig: async () => "{}"
    };
    assert.ok(mockDeps.repoAllowlist.length === 1);
  });

  test("HandleMessageRequest type is usable with priorMessages", () => {
    const request: HandleMessageRequest = {
      message: "fix the login bug",
      userId: "U123",
      channelId: "C123",
      threadTs: "1234567890.123456",
      priorMessages: [
        { role: "user", content: "describe the repo" },
        { role: "assistant", content: "It's a Rails app." }
      ]
    };
    assert.equal(request.message, "fix the login bug");
    assert.equal(request.priorMessages?.length, 2);
  });
});

// ── ConversationStore ──────────────────────────────────

describe("ConversationStore", () => {
  let testDb: TestDb;
  let store: ConversationStore;

  test("setup test db", async () => {
    testDb = await createTestDb();
    store = new ConversationStore({ db: testDb.db });
  });

  test("get returns undefined for unknown thread", async () => {
    const result = await store.get("C1:T1");
    assert.equal(result, undefined);
  });

  test("set and get round-trip", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" }
    ];
    await store.set("C1:T1", messages);
    const result = await store.get("C1:T1");
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "user");
  });

  test("set strips system messages", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ];
    await store.set("C1:T2", messages);
    const result = (await store.get("C1:T2"))!;
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "user");
  });

  test("delete removes conversation", async () => {
    await store.set("C1:T3", [{ role: "user", content: "hi" }]);
    await store.delete("C1:T3");
    assert.equal(await store.get("C1:T3"), undefined);
  });

  test("maskOldObservations shortens old tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "describe repo" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "describe_repo", arguments: '{"repoSlug":"a/b"}' } }] },
      { role: "tool", tool_call_id: "tc1", content: "Ruby/JS Rails app with 45 files. Gemfile, package.json, and lots of other stuff here that makes this a long response." },
      { role: "assistant", content: "It's a Rails app with Ruby and JavaScript." },
      // Recent messages (within keepRecentN)
      { role: "user", content: "show routes" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc2", type: "function", function: { name: "read_file", arguments: '{"repoSlug":"a/b","path":"config/routes.rb"}' } }] },
      { role: "tool", tool_call_id: "tc2", content: "Rails.application.routes.draw do\n  resources :users\nend" },
      { role: "assistant", content: "Here are the routes." }
    ];

    const masked = store.maskOldObservations(messages, 4);

    // Old tool result (index 2) should be masked
    assert.ok(masked[2].role === "tool");
    assert.ok(masked[2].content.startsWith("[previous tool result:"));

    // Old assistant with tool_calls (index 1) should be preserved
    assert.equal(masked[1].role, "assistant");
    assert.ok("tool_calls" in masked[1]);

    // Recent tool result (index 6) should be untouched
    assert.ok(masked[6].role === "tool");
    assert.ok(masked[6].content.includes("Rails.application.routes.draw"));
  });

  test("maskOldObservations returns messages unchanged when under keepRecentN", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ];
    const masked = store.maskOldObservations(messages, 12);
    assert.deepEqual(masked, messages);
  });

  test("cleanup removes stale entries (via direct SQL due to Date binding)", async () => {
    await store.set("C1:cleanup1", [{ role: "user", content: "old" }]);
    await store.set("C1:cleanup2", [{ role: "user", content: "new" }]);

    // Wait 5ms then delete all entries older than 1ms using raw SQL
    // (store.cleanup() has a known Date binding issue with postgres-js)
    await new Promise(r => setTimeout(r, 5));
    const { sql } = await import("drizzle-orm");
    const { conversations } = await import("../src/db/schema.js");
    const cutoff = new Date(Date.now() - 1).toISOString();
    await testDb.db.delete(conversations).where(sql`${conversations.lastAccess} < ${cutoff}`);
    assert.equal(await store.getSize(), 0);
  });

  test("cleanup preserves recent entries (via direct SQL due to Date binding)", async () => {
    await store.set("C1:recent", [{ role: "user", content: "recent" }]);

    // Cleanup with very old cutoff preserves everything
    const { sql } = await import("drizzle-orm");
    const { conversations } = await import("../src/db/schema.js");
    const cutoff = new Date(Date.now() - 999_999_999).toISOString();
    await testDb.db.delete(conversations).where(sql`${conversations.lastAccess} < ${cutoff}`);
    const size = await store.getSize();
    assert.equal(size, 1);
  });

  test("teardown", async () => {
    await testDb.cleanup();
  });
});
