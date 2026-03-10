/**
 * Observer state store — persists dedup keys, rate counters, and poll cursors to PostgreSQL.
 *
 * Decomposed from 1 JSON blob → 5 tables for proper relational storage.
 */

import { eq, and, sql } from "drizzle-orm";
import type { DedupEntry, ObserverStateSnapshot, RuleOutcomeStats } from "./types.js";
import type { Database } from "../db/index.js";
import {
  observerDedup,
  observerRateEvents,
  observerDailyCounters,
  observerPollCursors,
  observerRuleOutcomes,
} from "../db/schema.js";

export class ObserverStateStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async load(): Promise<void> {
    // Sweep expired dedup entries on startup
    await this.sweepDedup();
  }

  async flush(): Promise<void> {
    // No-op — writes are immediate to DB
  }

  // ── Dedup ──

  async hasDedup(key: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(observerDedup)
      .where(eq(observerDedup.key, key));
    const entry = rows[0];
    if (!entry) return false;
    if (entry.ttlMs === 0 || Date.now() - entry.seenAt > entry.ttlMs) {
      await this.db.delete(observerDedup).where(eq(observerDedup.key, key));
      return false;
    }
    return true;
  }

  async setDedup(key: string, ttlMs: number, runId?: string, ruleId?: string): Promise<void> {
    await this.db
      .insert(observerDedup)
      .values({ key, seenAt: Date.now(), ttlMs, runId, ruleId })
      .onConflictDoUpdate({
        target: observerDedup.key,
        set: { seenAt: Date.now(), ttlMs, runId, ruleId },
      });
  }

  async markDedupCompleted(runId: string, status: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(observerDedup)
      .where(eq(observerDedup.runId, runId));

    for (const entry of rows) {
      await this.db
        .update(observerDedup)
        .set({ completedAt: Date.now() })
        .where(eq(observerDedup.key, entry.key));

      if (entry.ruleId) {
        await this.recordRuleOutcome(entry.ruleId, status);
      }
    }
  }

  async getDedupEntry(key: string): Promise<DedupEntry | undefined> {
    const rows = await this.db
      .select()
      .from(observerDedup)
      .where(eq(observerDedup.key, key));
    const row = rows[0];
    if (!row) return undefined;
    return {
      seenAt: row.seenAt,
      ttlMs: row.ttlMs,
      runId: row.runId ?? undefined,
      ruleId: row.ruleId ?? undefined,
      completedAt: row.completedAt ?? undefined,
    };
  }

  async sweepDedup(): Promise<void> {
    const now = Date.now();
    await this.db
      .delete(observerDedup)
      .where(sql`${observerDedup.seenAt} + ${observerDedup.ttlMs} < ${now}`);
  }

  // ── Rate limiting ──

  async getRateLimitEvents(source: string): Promise<number[]> {
    const rows = await this.db
      .select({ timestampMs: observerRateEvents.timestampMs })
      .from(observerRateEvents)
      .where(eq(observerRateEvents.source, source));
    return rows.map((r) => r.timestampMs);
  }

  async addRateLimitEvent(source: string, timestamp: number): Promise<void> {
    await this.db.insert(observerRateEvents).values({
      source,
      timestampMs: timestamp,
    });
  }

  async pruneRateLimitEvents(source: string, windowMs: number): Promise<void> {
    const cutoff = Date.now() - windowMs;
    await this.db
      .delete(observerRateEvents)
      .where(
        and(
          eq(observerRateEvents.source, source),
          sql`${observerRateEvents.timestampMs} < ${cutoff}`
        )
      );
  }

  // ── Daily counters ──

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async getDailyCount(): Promise<number> {
    const today = this.todayStr();
    const rows = await this.db
      .select()
      .from(observerDailyCounters)
      .where(eq(observerDailyCounters.counterDay, today));
    return rows[0]?.dailyCount ?? 0;
  }

  async getDailyPerRepoCount(repoSlug: string): Promise<number> {
    const today = this.todayStr();
    const rows = await this.db
      .select()
      .from(observerDailyCounters)
      .where(eq(observerDailyCounters.counterDay, today));
    const perRepo = rows[0]?.perRepo ?? {};
    return perRepo[repoSlug] ?? 0;
  }

  async incrementDailyCount(repoSlug: string): Promise<void> {
    const today = this.todayStr();

    // Upsert the daily counter row atomically
    // Explicit ::text casts needed — PG can't infer param types inside jsonb_build_object()
    await this.db.execute(sql`
      INSERT INTO observer_daily_counters (counter_day, daily_count, per_repo)
      VALUES (${today}, 1, jsonb_build_object(${repoSlug}::text, 1))
      ON CONFLICT (counter_day) DO UPDATE SET
        daily_count = observer_daily_counters.daily_count + 1,
        per_repo = observer_daily_counters.per_repo || jsonb_build_object(
          ${repoSlug}::text,
          COALESCE((observer_daily_counters.per_repo ->> ${repoSlug}::text)::int, 0) + 1
        )
    `);
  }

  // ── Rule outcome tracking ──

  private async recordRuleOutcome(ruleId: string, status: string): Promise<void> {
    const isSuccess = status === "completed";
    await this.db
      .insert(observerRuleOutcomes)
      .values({
        ruleId,
        success: isSuccess ? 1 : 0,
        failure: isSuccess ? 0 : 1,
        lastOutcome: status,
        lastAt: new Date(),
      })
      .onConflictDoUpdate({
        target: observerRuleOutcomes.ruleId,
        set: {
          success: isSuccess
            ? sql`${observerRuleOutcomes.success} + 1`
            : observerRuleOutcomes.success,
          failure: isSuccess
            ? observerRuleOutcomes.failure
            : sql`${observerRuleOutcomes.failure} + 1`,
          lastOutcome: status,
          lastAt: new Date(),
        },
      });
  }

  async getOutcomeStats(ruleId: string): Promise<RuleOutcomeStats | undefined> {
    const rows = await this.db
      .select()
      .from(observerRuleOutcomes)
      .where(eq(observerRuleOutcomes.ruleId, ruleId));
    const row = rows[0];
    if (!row) return undefined;
    return {
      success: row.success,
      failure: row.failure,
      lastOutcome: row.lastOutcome,
      lastAt: row.lastAt?.toISOString() ?? "",
    };
  }

  async getAllOutcomeStats(): Promise<Record<string, RuleOutcomeStats>> {
    const rows = await this.db.select().from(observerRuleOutcomes);
    const result: Record<string, RuleOutcomeStats> = {};
    for (const row of rows) {
      result[row.ruleId] = {
        success: row.success,
        failure: row.failure,
        lastOutcome: row.lastOutcome,
        lastAt: row.lastAt?.toISOString() ?? "",
      };
    }
    return result;
  }

  async getRuleIdForRun(runId: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ ruleId: observerDedup.ruleId })
      .from(observerDedup)
      .where(eq(observerDedup.runId, runId));
    return rows[0]?.ruleId ?? undefined;
  }

  async getSnapshot(): Promise<ObserverStateSnapshot> {
    const today = this.todayStr();

    const [dedupRows, activeDedupRows, dailyRows, ruleRows, rateRows] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)::int` }).from(observerDedup),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(observerDedup)
        .where(sql`${observerDedup.completedAt} IS NULL`),
      this.db.select().from(observerDailyCounters).where(eq(observerDailyCounters.counterDay, today)),
      this.db.select().from(observerRuleOutcomes),
      this.db
        .select({
          source: observerRateEvents.source,
          count: sql<number>`count(*)::int`,
        })
        .from(observerRateEvents)
        .groupBy(observerRateEvents.source),
    ]);

    const dailyRow = dailyRows[0];
    const ruleOutcomes: Record<string, RuleOutcomeStats> = {};
    for (const row of ruleRows) {
      ruleOutcomes[row.ruleId] = {
        success: row.success,
        failure: row.failure,
        lastOutcome: row.lastOutcome,
        lastAt: row.lastAt?.toISOString() ?? "",
      };
    }

    const rateLimitSources: Record<string, number> = {};
    for (const row of rateRows) {
      rateLimitSources[row.source] = row.count;
    }

    return {
      dedupCount: dedupRows[0]?.count ?? 0,
      activeDedups: activeDedupRows[0]?.count ?? 0,
      dailyCount: dailyRow?.dailyCount ?? 0,
      dailyPerRepo: dailyRow?.perRepo ?? {},
      counterDay: today,
      ruleOutcomes,
      rateLimitSources,
    };
  }

  // ── Poll cursors (Sentry + GitHub) ──

  async getSentryLastPoll(project: string): Promise<string | undefined> {
    return this.getCursor("sentry", project);
  }

  async setSentryLastPoll(project: string, timestamp: string): Promise<void> {
    await this.setCursor("sentry", project, timestamp);
  }

  async getGithubLastRunId(repoSlug: string): Promise<number | undefined> {
    const value = await this.getCursor("github", repoSlug);
    return value ? Number(value) : undefined;
  }

  async setGithubLastRunId(repoSlug: string, runId: number): Promise<void> {
    await this.setCursor("github", repoSlug, String(runId));
  }

  private async getCursor(sourceType: string, sourceKey: string): Promise<string | undefined> {
    const rows = await this.db
      .select()
      .from(observerPollCursors)
      .where(
        and(
          eq(observerPollCursors.sourceType, sourceType),
          eq(observerPollCursors.sourceKey, sourceKey)
        )
      );
    return rows[0]?.cursorValue;
  }

  private async setCursor(sourceType: string, sourceKey: string, cursorValue: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO observer_poll_cursors (source_type, source_key, cursor_value)
      VALUES (${sourceType}, ${sourceKey}, ${cursorValue})
      ON CONFLICT (source_type, source_key) DO UPDATE SET
        cursor_value = ${cursorValue}
    `);
  }
}
