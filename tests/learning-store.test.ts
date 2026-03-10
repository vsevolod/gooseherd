/**
 * Learning Store tests — outcome recording, aggregation, persistence, triage summary.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { LearningStore, type RunOutcomeRecord } from "../src/observer/learning-store.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

function makeOutcome(overrides?: Partial<RunOutcomeRecord>): RunOutcomeRecord {
  return {
    runId: randomUUID(),
    ruleId: "test-rule",
    source: "observer",
    repoSlug: "org/repo",
    status: "completed",
    durationMs: 60_000,
    costUsd: 0.10,
    changedFiles: 3,
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

async function makeStore(): Promise<{ store: LearningStore; testDb: TestDb }> {
  const testDb = await createTestDb();
  const store = new LearningStore(testDb.db);
  await store.load();
  return { store, testDb };
}

describe("LearningStore", { concurrency: 1 }, () => {

  test("load() handles empty DB gracefully", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    const outcomes = await store.getRecentOutcomes();
    assert.equal(outcomes.length, 0);
  });

  test("recordOutcome() stores an outcome", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome());
    const outcomes = await store.getRecentOutcomes();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.ruleId, "test-rule");
  });

  test("getRuleLearnings() returns aggregated stats", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ status: "completed", durationMs: 30_000, costUsd: 0.05 }));
    await store.recordOutcome(makeOutcome({ status: "completed", durationMs: 90_000, costUsd: 0.15 }));
    await store.recordOutcome(makeOutcome({ status: "failed", durationMs: 60_000, costUsd: 0.10, errorCategory: "timeout" }));

    const learnings = await store.getRuleLearnings("test-rule");
    assert.ok(learnings);
    assert.equal(learnings.totalRuns, 3);
    assert.equal(learnings.successCount, 2);
    assert.equal(learnings.failureCount, 1);
    assert.equal(learnings.avgDurationMs, 60_000);
    assert.ok(Math.abs(learnings.avgCostUsd - 0.10) < 0.001);
  });

  test("getRuleLearnings() returns undefined for unknown rule", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    const learnings = await store.getRuleLearnings("nonexistent-rule");
    assert.equal(learnings, undefined);
  });

  test("success rate calculation is correct", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ status: "completed" }));
    await store.recordOutcome(makeOutcome({ status: "completed" }));
    await store.recordOutcome(makeOutcome({ status: "completed" }));
    await store.recordOutcome(makeOutcome({ status: "failed", errorCategory: "timeout" }));

    const learnings = await store.getRuleLearnings("test-rule");
    assert.ok(learnings);
    assert.equal(learnings.successRate, 75);
  });

  test("common failure modes are correctly identified", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ status: "failed", errorCategory: "timeout" }));
    await store.recordOutcome(makeOutcome({ status: "failed", errorCategory: "timeout" }));
    await store.recordOutcome(makeOutcome({ status: "failed", errorCategory: "timeout" }));
    await store.recordOutcome(makeOutcome({ status: "failed", errorCategory: "validation" }));
    await store.recordOutcome(makeOutcome({ status: "failed", errorCategory: "validation" }));
    await store.recordOutcome(makeOutcome({ status: "failed", errorCategory: "agent_error" }));

    const learnings = await store.getRuleLearnings("test-rule");
    assert.ok(learnings);
    assert.equal(learnings.commonFailureModes.length, 3);
    assert.equal(learnings.commonFailureModes[0], "timeout (3)");
    assert.equal(learnings.commonFailureModes[1], "validation (2)");
    assert.equal(learnings.commonFailureModes[2], "agent_error (1)");
  });

  test("getTriageSummary() returns formatted string", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ status: "completed", durationMs: 30_000, costUsd: 0.05 }));
    await store.recordOutcome(makeOutcome({ status: "failed", durationMs: 60_000, costUsd: 0.10, errorCategory: "timeout" }));

    const summary = await store.getTriageSummary("test-rule");
    assert.ok(summary.includes('Rule "test-rule"'));
    assert.ok(summary.includes("2 runs"));
    assert.ok(summary.includes("50% success rate"));
    assert.ok(summary.includes("timeout"));
    assert.ok(summary.includes("Avg cost"));
  });

  test("getTriageSummary() returns empty string for unknown rule", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    const summary = await store.getTriageSummary("nonexistent");
    assert.equal(summary, "");
  });

  test("flush() + load() round-trips data (DB is immediate)", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordOutcome(makeOutcome({ runId: "run-persist-1", status: "completed" }));
    await store.recordOutcome(makeOutcome({ runId: "run-persist-2", status: "failed", errorCategory: "timeout" }));
    await store.flush();

    // Reload into a fresh store on same DB
    const store2 = new LearningStore(testDb.db);
    await store2.load();

    const outcomes = await store2.getRecentOutcomes();
    assert.equal(outcomes.length, 2);
    // Newest first
    assert.equal(outcomes[0]!.runId, "run-persist-2");
    assert.equal(outcomes[1]!.runId, "run-persist-1");

    const learnings = await store2.getRuleLearnings("test-rule");
    assert.ok(learnings);
    assert.equal(learnings.totalRuns, 2);
    assert.equal(learnings.successCount, 1);
    assert.equal(learnings.failureCount, 1);
  });

  test("flush() is a no-op when not dirty", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    // Flushing without recording anything should not fail
    await store.flush();
  });

  test("getRecentOutcomes() returns newest first", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    const t1 = "2025-01-01T00:00:00Z";
    const t2 = "2025-01-02T00:00:00Z";
    const t3 = "2025-01-03T00:00:00Z";
    await store.recordOutcome(makeOutcome({ runId: "run-1", timestamp: t1 }));
    await store.recordOutcome(makeOutcome({ runId: "run-2", timestamp: t2 }));
    await store.recordOutcome(makeOutcome({ runId: "run-3", timestamp: t3 }));

    const outcomes = await store.getRecentOutcomes(2);
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0]!.runId, "run-3");
    assert.equal(outcomes[1]!.runId, "run-2");
  });

  test("getAllRuleLearnings() aggregates across rules", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordOutcome(makeOutcome({ ruleId: "rule-a", status: "completed" }));
    await store.recordOutcome(makeOutcome({ ruleId: "rule-a", status: "failed", errorCategory: "timeout" }));
    await store.recordOutcome(makeOutcome({ ruleId: "rule-b", status: "completed" }));
    await store.recordOutcome(makeOutcome({ ruleId: "rule-b", status: "completed" }));
    await store.recordOutcome(makeOutcome({ ruleId: "rule-b", status: "completed" }));

    const all = await store.getAllRuleLearnings();
    assert.equal(all.length, 2);

    const ruleA = all.find(l => l.ruleId === "rule-a");
    const ruleB = all.find(l => l.ruleId === "rule-b");
    assert.ok(ruleA);
    assert.ok(ruleB);
    assert.equal(ruleA.totalRuns, 2);
    assert.equal(ruleA.successRate, 50);
    assert.equal(ruleB.totalRuns, 3);
    assert.equal(ruleB.successRate, 100);
  });

  test("enrichOutcome() patches existing record", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ runId: "enrich-1", ruleId: undefined, source: "dashboard" }));
    await store.enrichOutcome("enrich-1", { ruleId: "rule-abc" });
    const outcomes = await store.getRecentOutcomes();
    assert.equal(outcomes[0]!.ruleId, "rule-abc");
    assert.equal(outcomes[0]!.source, "dashboard");
  });

  test("enrichOutcome() is a no-op for unknown runId", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ runId: "exists" }));
    await store.enrichOutcome("nonexistent", { ruleId: "rule-xyz" });
    const outcomes = await store.getRecentOutcomes();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.runId, "exists");
  });

  test("getRepoLearnings() aggregates by repo slug", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ repoSlug: "org/alpha", status: "completed", costUsd: 0.10 }));
    await store.recordOutcome(makeOutcome({ repoSlug: "org/alpha", status: "failed", costUsd: 0.20, errorCategory: "timeout" }));
    await store.recordOutcome(makeOutcome({ repoSlug: "org/beta", status: "completed" }));

    const alpha = await store.getRepoLearnings("org/alpha");
    assert.ok(alpha);
    assert.equal(alpha.totalRuns, 2);
    assert.equal(alpha.successRate, 50);
    assert.ok(Math.abs(alpha.avgCostUsd - 0.15) < 0.001);
    assert.equal(alpha.commonFailureModes.length, 1);

    assert.equal(await store.getRepoLearnings("org/nonexistent"), undefined);
  });

  test("getSourceStats() aggregates by source", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ source: "dashboard", status: "completed" }));
    await store.recordOutcome(makeOutcome({ source: "dashboard", status: "failed" }));
    await store.recordOutcome(makeOutcome({ source: "slack", status: "completed" }));

    const dash = await store.getSourceStats("dashboard");
    assert.ok(dash);
    assert.equal(dash.totalRuns, 2);
    assert.equal(dash.successRate, 50);

    assert.equal(await store.getSourceStats("api"), undefined);
  });

  test("getAllRepoSummaries() returns sorted by lastRunAt", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    await store.recordOutcome(makeOutcome({ repoSlug: "org/old", timestamp: "2025-01-01T00:00:00Z" }));
    await store.recordOutcome(makeOutcome({ repoSlug: "org/new", timestamp: "2025-06-01T00:00:00Z" }));

    const summaries = await store.getAllRepoSummaries();
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0]!.repoSlug, "org/new");
    assert.equal(summaries[1]!.repoSlug, "org/old");
  });

  test("getSystemStats() returns aggregate stats", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });
    const empty = await store.getSystemStats();
    assert.equal(empty.totalRuns, 0);
    assert.equal(empty.successRate, 0);

    await store.recordOutcome(makeOutcome({ status: "completed", costUsd: 0.50, durationMs: 10_000 }));
    await store.recordOutcome(makeOutcome({ status: "failed", costUsd: 0.30, durationMs: 20_000 }));

    const stats = await store.getSystemStats();
    assert.equal(stats.totalRuns, 2);
    assert.equal(stats.successRate, 50);
    assert.equal(stats.totalCostUsd, 0.80);
    assert.equal(stats.avgDurationMs, 15_000);
  });

  test("recentOutcomes in learnings shows last 5 statuses", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    const statuses = ["completed", "failed", "completed", "completed", "failed", "completed", "failed"];
    for (let i = 0; i < statuses.length; i++) {
      await store.recordOutcome(makeOutcome({
        status: statuses[i]!,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        errorCategory: statuses[i] === "failed" ? "unknown" : undefined
      }));
    }

    const learnings = await store.getRuleLearnings("test-rule");
    assert.ok(learnings);
    assert.equal(learnings.recentOutcomes.length, 5);
    // Last 5 outcomes (newest first): "failed", "completed", "failed", "completed", "completed"
    assert.deepEqual(learnings.recentOutcomes, ["failed", "completed", "failed", "completed", "completed"]);
  });
});
