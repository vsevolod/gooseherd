/**
 * Autonomous Scheduler tests — priority queue, evaluation cycle, capacity gating.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  startAutonomousScheduler,
  evaluateQueue,
  computePriority,
  type DeferredEvent,
  type SchedulerConfig,
  type SchedulerSlotChecker,
  type SchedulerStats
} from "../src/observer/autonomous-scheduler.js";

import type { TriggerEvent, TriggerRule } from "../src/observer/types.js";

// ── Helpers ──

function makeEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: "sentry_alert",
    timestamp: new Date().toISOString(),
    repoSlug: "org/repo",
    suggestedTask: "Fix something",
    priority: "medium",
    rawPayload: {},
    notificationTarget: { type: "dashboard_only" },
    ...overrides
  };
}

function makeRule(overrides?: Partial<TriggerRule>): TriggerRule {
  return {
    id: "test-rule",
    source: "sentry_alert",
    conditions: [],
    requiresApproval: false,
    cooldownMinutes: 60,
    maxRunsPerHour: 5,
    ...overrides
  };
}

function makeConfig(overrides?: Partial<SchedulerConfig>): SchedulerConfig {
  return {
    enabled: true,
    maxDeferredEvents: 100,
    evaluateIntervalMs: 50,  // Short for tests
    maxRetries: 10,
    maxAge: 24 * 60 * 60 * 1000,
    ...overrides
  };
}

function makeSlotChecker(hasCapacity = true, activeRuns = 0): SchedulerSlotChecker {
  return {
    hasCapacity: () => hasCapacity,
    activeRunCount: () => activeRuns
  };
}

function freshStats(): SchedulerStats {
  return { queueSize: 0, totalDeferred: 0, totalTriggered: 0, totalDropped: 0 };
}

function makeDeferredEvent(overrides?: Partial<DeferredEvent>): DeferredEvent {
  return {
    event: makeEvent(),
    rule: makeRule(),
    deferredAt: new Date().toISOString(),
    reason: "test deferral",
    priority: 50,
    retryCount: 0,
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════
// computePriority
// ═══════════════════════════════════════════════════════

describe("computePriority", () => {
  test("returns base priority when just deferred", () => {
    const now = Date.now();
    const deferredAt = new Date(now).toISOString();
    assert.equal(computePriority(50, deferredAt, now), 50);
  });

  test("adds +1 per 10 minutes of age", () => {
    const now = Date.now();
    const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();
    assert.equal(computePriority(50, thirtyMinAgo, now), 53);
  });

  test("caps at 100", () => {
    const now = Date.now();
    const longAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // 24h ago
    assert.equal(computePriority(90, longAgo, now), 100);
  });
});

// ═══════════════════════════════════════════════════════
// evaluateQueue (direct unit tests)
// ═══════════════════════════════════════════════════════

describe("evaluateQueue", () => {
  test("returns null when queue is empty", () => {
    const queue: DeferredEvent[] = [];
    const result = evaluateQueue(queue, makeConfig(), makeSlotChecker(), freshStats(), Date.now());
    assert.equal(result, null);
  });

  test("triggers highest priority event when capacity available", () => {
    const high = makeDeferredEvent({
      event: makeEvent({ id: "high", priority: "high" }),
      priority: 75
    });
    const low = makeDeferredEvent({
      event: makeEvent({ id: "low", priority: "low" }),
      priority: 25
    });
    const queue = [low, high];
    const stats = freshStats();

    const result = evaluateQueue(queue, makeConfig(), makeSlotChecker(true), stats, Date.now());

    assert.ok(result);
    assert.equal(result.event.id, "high");
    assert.equal(stats.totalTriggered, 1);
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.event.id, "low");
  });

  test("returns null when no capacity", () => {
    const entry = makeDeferredEvent();
    const queue = [entry];
    const stats = freshStats();

    const result = evaluateQueue(queue, makeConfig(), makeSlotChecker(false), stats, Date.now());

    assert.equal(result, null);
    assert.equal(queue.length, 1);
    assert.equal(stats.totalTriggered, 0);
  });

  test("increments retryCount when no capacity", () => {
    const entry = makeDeferredEvent({ retryCount: 3 });
    const queue = [entry];

    evaluateQueue(queue, makeConfig(), makeSlotChecker(false), freshStats(), Date.now());

    assert.equal(queue[0]!.retryCount, 4);
  });

  test("only triggers one event per cycle", () => {
    const queue = [
      makeDeferredEvent({ event: makeEvent({ id: "a", priority: "critical" }), priority: 100 }),
      makeDeferredEvent({ event: makeEvent({ id: "b", priority: "high" }), priority: 75 }),
      makeDeferredEvent({ event: makeEvent({ id: "c", priority: "medium" }), priority: 50 })
    ];
    const stats = freshStats();

    evaluateQueue(queue, makeConfig(), makeSlotChecker(true), stats, Date.now());

    assert.equal(stats.totalTriggered, 1);
    assert.equal(queue.length, 2);
  });

  test("drops events older than maxAge", () => {
    const now = Date.now();
    const oldEvent = makeDeferredEvent({
      deferredAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() // 25h ago
    });
    const freshEvent = makeDeferredEvent({
      deferredAt: new Date(now).toISOString()
    });
    const queue = [oldEvent, freshEvent];
    const stats = freshStats();

    evaluateQueue(queue, makeConfig({ maxAge: 24 * 60 * 60 * 1000 }), makeSlotChecker(false), stats, now);

    assert.equal(stats.totalDropped, 1);
    assert.equal(queue.length, 1);
  });

  test("drops events exceeding maxRetries", () => {
    const overRetried = makeDeferredEvent({ retryCount: 10 });
    const fresh = makeDeferredEvent({ retryCount: 0 });
    const queue = [overRetried, fresh];
    const stats = freshStats();

    evaluateQueue(queue, makeConfig({ maxRetries: 10 }), makeSlotChecker(false), stats, Date.now());

    assert.equal(stats.totalDropped, 1);
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.retryCount, 1); // The surviving one gets incremented
  });

  test("sorts by priority then by age for tiebreaks", () => {
    const now = Date.now();
    const olderMedium = makeDeferredEvent({
      event: makeEvent({ id: "older-med", priority: "medium" }),
      deferredAt: new Date(now - 60 * 60 * 1000).toISOString(), // 1h ago
      priority: 50
    });
    const newerMedium = makeDeferredEvent({
      event: makeEvent({ id: "newer-med", priority: "medium" }),
      deferredAt: new Date(now).toISOString(),
      priority: 50
    });
    const queue = [newerMedium, olderMedium];
    const stats = freshStats();

    const result = evaluateQueue(queue, makeConfig(), makeSlotChecker(true), stats, now);

    // Older medium gets age bonus so it should be triggered first
    // (base 50 + 6 age bonus = 56 vs base 50 + 0 = 50)
    assert.ok(result);
    assert.equal(result.event.id, "older-med");
  });

  test("priority increases with age (urgency bonus)", () => {
    const now = Date.now();
    const entry = makeDeferredEvent({
      event: makeEvent({ priority: "low" }),
      deferredAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      priority: 25
    });
    const queue = [entry];

    evaluateQueue(queue, makeConfig(), makeSlotChecker(false), freshStats(), now);

    // base 25 + (120min / 10) = 25 + 12 = 37
    assert.equal(queue[0]!.priority, 37);
  });
});

// ═══════════════════════════════════════════════════════
// startAutonomousScheduler (integration)
// ═══════════════════════════════════════════════════════

describe("startAutonomousScheduler", () => {
  test("defer() adds event to queue", () => {
    const scheduler = startAutonomousScheduler(
      makeConfig(),
      makeSlotChecker(false),
      () => {}
    );

    scheduler.defer(makeEvent(), makeRule(), "test reason");

    const queue = scheduler.getQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.reason, "test reason");

    scheduler.stop();
  });

  test("queue is sorted by priority (highest first)", () => {
    const scheduler = startAutonomousScheduler(
      makeConfig(),
      makeSlotChecker(false),
      () => {}
    );

    scheduler.defer(makeEvent({ id: "low", priority: "low" }), makeRule(), "low");
    scheduler.defer(makeEvent({ id: "critical", priority: "critical" }), makeRule(), "critical");
    scheduler.defer(makeEvent({ id: "medium", priority: "medium" }), makeRule(), "medium");

    const queue = scheduler.getQueue();
    assert.equal(queue[0]!.event.id, "critical");
    assert.equal(queue[1]!.event.id, "medium");
    assert.equal(queue[2]!.event.id, "low");

    scheduler.stop();
  });

  test("queue trims when over max size", () => {
    const scheduler = startAutonomousScheduler(
      makeConfig({ maxDeferredEvents: 2 }),
      makeSlotChecker(false),
      () => {}
    );

    scheduler.defer(makeEvent({ id: "high", priority: "high" }), makeRule(), "high");
    scheduler.defer(makeEvent({ id: "critical", priority: "critical" }), makeRule(), "critical");
    scheduler.defer(makeEvent({ id: "low", priority: "low" }), makeRule(), "low");

    const queue = scheduler.getQueue();
    assert.equal(queue.length, 2);
    // Lowest priority (low) should be dropped
    const ids = queue.map(e => e.event.id);
    assert.ok(!ids.includes("low"), "Lowest priority event should be dropped");

    const stats = scheduler.getStats();
    assert.equal(stats.totalDropped, 1);

    scheduler.stop();
  });

  test("getStats() tracks counts correctly", () => {
    const scheduler = startAutonomousScheduler(
      makeConfig(),
      makeSlotChecker(false),
      () => {}
    );

    scheduler.defer(makeEvent(), makeRule(), "reason1");
    scheduler.defer(makeEvent(), makeRule(), "reason2");

    const stats = scheduler.getStats();
    assert.equal(stats.totalDeferred, 2);
    assert.equal(stats.queueSize, 2);
    assert.equal(stats.totalTriggered, 0);
    assert.equal(stats.totalDropped, 0);

    scheduler.stop();
  });

  test("getQueue() returns a copy (not the internal array)", () => {
    const scheduler = startAutonomousScheduler(
      makeConfig(),
      makeSlotChecker(false),
      () => {}
    );

    scheduler.defer(makeEvent(), makeRule(), "reason");
    const queue = scheduler.getQueue();
    queue.pop(); // Mutate the copy

    assert.equal(scheduler.getQueue().length, 1, "Internal queue should not be affected");

    scheduler.stop();
  });

  test("stop() clears the interval", () => {
    const scheduler = startAutonomousScheduler(
      makeConfig({ evaluateIntervalMs: 10 }),
      makeSlotChecker(false),
      () => {}
    );

    // Just verify stop doesn't throw and we can call it
    scheduler.stop();

    // Defer after stop should still work (queue is in-memory)
    // but no evaluation will happen
    scheduler.defer(makeEvent(), makeRule(), "after stop");
    assert.equal(scheduler.getQueue().length, 1);
  });

  test("triggers event via onTrigger callback on evaluation", async () => {
    let triggeredEventId: string | undefined;

    const scheduler = startAutonomousScheduler(
      makeConfig({ evaluateIntervalMs: 30 }),
      makeSlotChecker(true),
      (event) => { triggeredEventId = event.id; }
    );

    const event = makeEvent({ id: "trigger-me" });
    scheduler.defer(event, makeRule(), "should trigger");

    // Wait for at least one evaluation cycle
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(triggeredEventId, "trigger-me");
    assert.equal(scheduler.getQueue().length, 0);
    assert.equal(scheduler.getStats().totalTriggered, 1);

    scheduler.stop();
  });

  test("does not trigger when hasCapacity() returns false", async () => {
    let triggered = false;

    const scheduler = startAutonomousScheduler(
      makeConfig({ evaluateIntervalMs: 30 }),
      makeSlotChecker(false, 50),
      () => { triggered = true; }
    );

    scheduler.defer(makeEvent(), makeRule(), "should not trigger");

    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(triggered, false);
    assert.equal(scheduler.getQueue().length, 1);

    scheduler.stop();
  });
});
