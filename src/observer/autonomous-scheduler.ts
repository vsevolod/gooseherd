/**
 * Autonomous Scheduler — maintains a priority queue of deferred events
 * and re-evaluates them periodically, triggering runs when system capacity allows.
 *
 * Conservative by design: one trigger per evaluation cycle, respects all safety limits.
 */

import { logInfo, logWarn } from "../logger.js";
import type { TriggerEvent, TriggerRule, TriggerPriority } from "./types.js";

// ── Types ──

export interface DeferredEvent {
  event: TriggerEvent;
  rule: TriggerRule;
  deferredAt: string;       // ISO timestamp
  reason: string;           // Why it was deferred
  priority: number;         // 0-100, higher = more urgent
  retryCount: number;       // How many times we've re-evaluated
}

export interface SchedulerConfig {
  enabled: boolean;
  maxDeferredEvents: number;  // Max queue size (default 100)
  evaluateIntervalMs: number; // How often to re-evaluate (default 5 min)
  maxRetries: number;         // Max re-evaluations before dropping (default 10)
  maxAge: number;             // Max age in ms before dropping (default 24h)
}

export interface SchedulerHandle {
  stop(): void;
}

export interface SchedulerSlotChecker {
  /** Returns true if there's capacity for another run */
  hasCapacity(): Promise<boolean>;
  /** Returns current active run count */
  activeRunCount(): Promise<number>;
}

export interface SchedulerStats {
  queueSize: number;
  totalDeferred: number;
  totalTriggered: number;
  totalDropped: number;
}

// ── Priority scoring ──

const PRIORITY_MAP: Record<TriggerPriority, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25
};

/** Calculate initial priority score from event priority. */
function basePriority(priority: TriggerPriority): number {
  return PRIORITY_MAP[priority] ?? 50;
}

/**
 * Recalculate priority with age bonus: +1 point per 10 minutes deferred.
 * Capped at 100.
 */
export function computePriority(base: number, deferredAt: string, now: number): number {
  const ageMs = now - new Date(deferredAt).getTime();
  const ageBonus = Math.floor(ageMs / (10 * 60 * 1000)); // +1 per 10 min
  return Math.min(100, base + ageBonus);
}

// ── Evaluation logic (exported for direct testing) ──

/**
 * Run a single evaluation cycle on the queue.
 *
 * - Drops events that are too old or have exceeded max retries.
 * - If capacity is available, triggers the highest-priority event.
 * - Increments retryCount on remaining events.
 *
 * Returns the event that was triggered, or null if none.
 */
export async function evaluateQueue(
  queue: DeferredEvent[],
  config: SchedulerConfig,
  slotChecker: SchedulerSlotChecker,
  stats: SchedulerStats,
  now: number
): Promise<DeferredEvent | null> {
  // 1. Recalculate priorities with age bonus
  for (const entry of queue) {
    entry.priority = computePriority(
      basePriority(entry.event.priority),
      entry.deferredAt,
      now
    );
  }

  // 2. Drop expired and over-retried events (walk backwards for safe splicing)
  for (let i = queue.length - 1; i >= 0; i--) {
    const entry = queue[i]!;
    const ageMs = now - new Date(entry.deferredAt).getTime();

    if (ageMs > config.maxAge) {
      logInfo("Autonomous scheduler: dropping expired event", {
        eventId: entry.event.id,
        ageMinutes: Math.round(ageMs / 60_000)
      });
      queue.splice(i, 1);
      stats.totalDropped += 1;
      continue;
    }

    if (entry.retryCount >= config.maxRetries) {
      logInfo("Autonomous scheduler: dropping event (max retries)", {
        eventId: entry.event.id,
        retryCount: entry.retryCount
      });
      queue.splice(i, 1);
      stats.totalDropped += 1;
    }
  }

  // 3. Sort: highest priority first, then oldest first (stable tiebreak)
  queue.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(a.deferredAt).getTime() - new Date(b.deferredAt).getTime();
  });

  // 4. Check capacity
  if (!(await slotChecker.hasCapacity())) {
    logInfo("Autonomous scheduler: no capacity, skipping cycle", {
      activeRuns: await slotChecker.activeRunCount(),
      queueSize: queue.length
    });
    // Increment retry count for all remaining events
    for (const entry of queue) {
      entry.retryCount += 1;
    }
    return null;
  }

  // 5. Trigger the highest-priority event (first in sorted queue)
  if (queue.length === 0) return null;

  const triggered = queue.shift()!;
  stats.totalTriggered += 1;

  logInfo("Autonomous scheduler: triggering deferred event", {
    eventId: triggered.event.id,
    priority: triggered.priority,
    retryCount: triggered.retryCount,
    queueRemaining: queue.length
  });

  // Increment retry count for remaining events (they survived another cycle)
  for (const entry of queue) {
    entry.retryCount += 1;
  }

  return triggered;
}

// ── Main entry point ──

/**
 * Start the autonomous scheduler.
 *
 * Maintains a priority queue of deferred events.
 * Periodically re-evaluates the queue and triggers runs when capacity allows.
 */
export function startAutonomousScheduler(
  config: SchedulerConfig,
  slotChecker: SchedulerSlotChecker,
  onTrigger: (event: TriggerEvent, rule: TriggerRule) => void
): SchedulerHandle & {
  /** Add a deferred event to the queue */
  defer(event: TriggerEvent, rule: TriggerRule, reason: string): void;
  /** Get current queue state */
  getQueue(): DeferredEvent[];
  /** Get queue stats */
  getStats(): SchedulerStats;
} {
  const queue: DeferredEvent[] = [];
  const stats: SchedulerStats = {
    queueSize: 0,
    totalDeferred: 0,
    totalTriggered: 0,
    totalDropped: 0
  };

  function defer(event: TriggerEvent, rule: TriggerRule, reason: string): void {
    const priority = basePriority(event.priority);
    const entry: DeferredEvent = {
      event,
      rule,
      deferredAt: new Date().toISOString(),
      reason,
      priority,
      retryCount: 0
    };

    queue.push(entry);
    stats.totalDeferred += 1;

    // Sort by priority (highest first), then age (oldest first)
    queue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return new Date(a.deferredAt).getTime() - new Date(b.deferredAt).getTime();
    });

    // Trim if over maxDeferredEvents — drop lowest priority (last in sorted queue)
    while (queue.length > config.maxDeferredEvents) {
      const dropped = queue.pop()!;
      stats.totalDropped += 1;
      logWarn("Autonomous scheduler: queue full, dropping lowest priority event", {
        droppedEventId: dropped.event.id,
        droppedPriority: dropped.priority,
        maxDeferredEvents: config.maxDeferredEvents
      });
    }

    stats.queueSize = queue.length;

    logInfo("Autonomous scheduler: event deferred", {
      eventId: event.id,
      priority,
      reason,
      queueSize: queue.length
    });
  }

  async function runEvaluation(): Promise<void> {
    const triggered = await evaluateQueue(queue, config, slotChecker, stats, Date.now());
    stats.queueSize = queue.length;

    if (triggered) {
      onTrigger(triggered.event, triggered.rule);
    }
  }

  const interval = setInterval(runEvaluation, config.evaluateIntervalMs);
  interval.unref?.();

  return {
    stop() {
      clearInterval(interval);
    },
    defer,
    getQueue(): DeferredEvent[] {
      return [...queue];
    },
    getStats(): SchedulerStats {
      stats.queueSize = queue.length;
      return { ...stats };
    }
  };
}
