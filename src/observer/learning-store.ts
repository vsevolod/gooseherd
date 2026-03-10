/**
 * Learning Store — tracks per-run outcomes in PostgreSQL and provides
 * aggregated statistics via SQL queries.
 */

import { eq, desc, sql, and } from "drizzle-orm";
import { logInfo } from "../logger.js";
import type { Database } from "../db/index.js";
import { learningOutcomes } from "../db/schema.js";

export interface RunOutcomeRecord {
  runId: string;
  ruleId?: string;
  source: string;
  repoSlug: string;
  status: string;
  errorCategory?: string;
  durationMs: number;
  costUsd: number;
  changedFiles: number;
  pipelineId?: string;
  timestamp: string;
}

export interface RepoLearnings {
  repoSlug: string;
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  avgCostUsd: number;
  commonFailureModes: string[];
  lastRunAt: string;
}

export interface RepoSummary {
  repoSlug: string;
  totalRuns: number;
  successRate: number;
  avgCostUsd: number;
  lastRunAt: string;
}

export interface SourceStats {
  source: string;
  totalRuns: number;
  successRate: number;
}

export interface SystemStats {
  totalRuns: number;
  successRate: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

export interface RuleLearnings {
  ruleId: string;
  totalRuns: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  avgCostUsd: number;
  commonFailureModes: string[];
  lastRunAt: string;
  recentOutcomes: string[];
}

export class LearningStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async load(): Promise<void> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(learningOutcomes);
    logInfo("LearningStore: loaded outcomes", { count: rows[0]?.count ?? 0 });
  }

  async flush(): Promise<void> {
    // No-op — writes are immediate
  }

  async recordOutcome(record: RunOutcomeRecord): Promise<void> {
    await this.db.insert(learningOutcomes).values({
      runId: record.runId,
      ruleId: record.ruleId,
      source: record.source,
      repoSlug: record.repoSlug,
      status: record.status,
      errorCategory: record.errorCategory,
      durationMs: record.durationMs,
      costUsd: String(record.costUsd),
      changedFiles: record.changedFiles,
      pipelineId: record.pipelineId,
      timestamp: new Date(record.timestamp),
    });
  }

  async enrichOutcome(runId: string, patch: Partial<RunOutcomeRecord>): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (patch.ruleId !== undefined) updates.ruleId = patch.ruleId;
    if (patch.errorCategory !== undefined) updates.errorCategory = patch.errorCategory;
    if (patch.status !== undefined) updates.status = patch.status;
    if (Object.keys(updates).length > 0) {
      await this.db
        .update(learningOutcomes)
        .set(updates)
        .where(eq(learningOutcomes.runId, runId));
    }
  }

  async getRepoLearnings(repoSlug: string): Promise<RepoLearnings | undefined> {
    const stats = await this.db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) filter (where status = 'completed')::int`,
        avgDurationMs: sql<number>`coalesce(avg(duration_ms)::int, 0)`,
        avgCostUsd: sql<number>`coalesce(avg(cost_usd::float), 0)`,
        lastRunAt: sql<string>`max(timestamp)::text`,
      })
      .from(learningOutcomes)
      .where(eq(learningOutcomes.repoSlug, repoSlug));

    const row = stats[0];
    if (!row || row.totalRuns === 0) return undefined;

    const successRate = Math.round((row.successCount / row.totalRuns) * 100);

    // Get common failure modes
    const failures = await this.db
      .select({
        errorCategory: learningOutcomes.errorCategory,
        count: sql<number>`count(*)::int`,
      })
      .from(learningOutcomes)
      .where(
        and(
          eq(learningOutcomes.repoSlug, repoSlug),
          sql`status != 'completed' AND error_category IS NOT NULL`
        )
      )
      .groupBy(learningOutcomes.errorCategory)
      .orderBy(sql`count(*) desc`)
      .limit(3);

    const commonFailureModes = failures.map(
      (f) => `${f.errorCategory} (${String(f.count)})`
    );

    return {
      repoSlug,
      totalRuns: row.totalRuns,
      successRate,
      avgDurationMs: row.avgDurationMs,
      avgCostUsd: row.avgCostUsd,
      commonFailureModes,
      lastRunAt: row.lastRunAt,
    };
  }

  async getSourceStats(source: string): Promise<SourceStats | undefined> {
    const stats = await this.db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) filter (where status = 'completed')::int`,
      })
      .from(learningOutcomes)
      .where(eq(learningOutcomes.source, source));

    const row = stats[0];
    if (!row || row.totalRuns === 0) return undefined;

    return {
      source,
      totalRuns: row.totalRuns,
      successRate: Math.round((row.successCount / row.totalRuns) * 100),
    };
  }

  async getAllRepoSummaries(): Promise<RepoSummary[]> {
    const rows = await this.db
      .select({
        repoSlug: learningOutcomes.repoSlug,
        totalRuns: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) filter (where status = 'completed')::int`,
        totalCostUsd: sql<number>`coalesce(sum(cost_usd::float), 0)`,
        lastRunAt: sql<string>`max(timestamp)::text`,
      })
      .from(learningOutcomes)
      .groupBy(learningOutcomes.repoSlug)
      .orderBy(sql`max(timestamp) desc`);

    return rows.map((r) => ({
      repoSlug: r.repoSlug,
      totalRuns: r.totalRuns,
      successRate: Math.round((r.successCount / r.totalRuns) * 100),
      avgCostUsd: r.totalCostUsd / r.totalRuns,
      lastRunAt: r.lastRunAt,
    }));
  }

  async getSystemStats(): Promise<SystemStats> {
    const stats = await this.db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) filter (where status = 'completed')::int`,
        totalCostUsd: sql<number>`coalesce(sum(cost_usd::float), 0)`,
        avgDurationMs: sql<number>`coalesce(avg(duration_ms)::int, 0)`,
      })
      .from(learningOutcomes);

    const row = stats[0];
    if (!row || row.totalRuns === 0) {
      return { totalRuns: 0, successRate: 0, totalCostUsd: 0, avgDurationMs: 0 };
    }

    return {
      totalRuns: row.totalRuns,
      successRate: Math.round((row.successCount / row.totalRuns) * 100),
      totalCostUsd: Math.round(row.totalCostUsd * 100) / 100,
      avgDurationMs: row.avgDurationMs,
    };
  }

  async getRuleLearnings(ruleId: string): Promise<RuleLearnings | undefined> {
    const stats = await this.db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) filter (where status = 'completed')::int`,
        avgDurationMs: sql<number>`coalesce(avg(duration_ms)::int, 0)`,
        avgCostUsd: sql<number>`coalesce(avg(cost_usd::float), 0)`,
        lastRunAt: sql<string>`max(timestamp)::text`,
      })
      .from(learningOutcomes)
      .where(eq(learningOutcomes.ruleId, ruleId));

    const row = stats[0];
    if (!row || row.totalRuns === 0) return undefined;

    const failureCount = row.totalRuns - row.successCount;
    const successRate = Math.round((row.successCount / row.totalRuns) * 100);

    // Common failure modes
    const failures = await this.db
      .select({
        errorCategory: learningOutcomes.errorCategory,
        count: sql<number>`count(*)::int`,
      })
      .from(learningOutcomes)
      .where(
        and(
          eq(learningOutcomes.ruleId, ruleId),
          sql`status != 'completed' AND error_category IS NOT NULL`
        )
      )
      .groupBy(learningOutcomes.errorCategory)
      .orderBy(sql`count(*) desc`)
      .limit(3);

    const commonFailureModes = failures.map(
      (f) => `${f.errorCategory} (${String(f.count)})`
    );

    // Recent outcomes (last 5)
    const recent = await this.db
      .select({ status: learningOutcomes.status })
      .from(learningOutcomes)
      .where(eq(learningOutcomes.ruleId, ruleId))
      .orderBy(desc(learningOutcomes.timestamp))
      .limit(5);

    return {
      ruleId,
      totalRuns: row.totalRuns,
      successCount: row.successCount,
      failureCount,
      successRate,
      avgDurationMs: row.avgDurationMs,
      avgCostUsd: row.avgCostUsd,
      commonFailureModes,
      lastRunAt: row.lastRunAt,
      recentOutcomes: recent.map((r) => r.status),
    };
  }

  async getAllRuleLearnings(): Promise<RuleLearnings[]> {
    const ruleIds = await this.db
      .select({ ruleId: learningOutcomes.ruleId })
      .from(learningOutcomes)
      .where(sql`rule_id IS NOT NULL`)
      .groupBy(learningOutcomes.ruleId);

    const results: RuleLearnings[] = [];
    for (const row of ruleIds) {
      if (row.ruleId) {
        const learnings = await this.getRuleLearnings(row.ruleId);
        if (learnings) results.push(learnings);
      }
    }
    return results;
  }

  async getTriageSummary(ruleId: string): Promise<string> {
    const learnings = await this.getRuleLearnings(ruleId);
    if (!learnings) return "";

    const parts = [
      `Rule "${ruleId}": ${String(learnings.totalRuns)} runs, ${String(learnings.successRate)}% success rate.`,
      `Avg cost: $${learnings.avgCostUsd.toFixed(2)}.`,
      `Avg duration: ${String(Math.round(learnings.avgDurationMs / 1000))}s.`,
    ];

    if (learnings.commonFailureModes.length > 0) {
      parts.push(`Common failures: ${learnings.commonFailureModes.join(", ")}.`);
    }

    if (learnings.recentOutcomes.length > 0) {
      parts.push(`Last ${String(learnings.recentOutcomes.length)}: ${learnings.recentOutcomes.join(", ")}.`);
    }

    return parts.join(" ");
  }

  async getRecentOutcomes(limit = 50): Promise<RunOutcomeRecord[]> {
    const rows = await this.db
      .select()
      .from(learningOutcomes)
      .orderBy(desc(learningOutcomes.timestamp))
      .limit(limit);

    return rows.map((r) => ({
      runId: r.runId,
      ruleId: r.ruleId ?? undefined,
      source: r.source,
      repoSlug: r.repoSlug,
      status: r.status,
      errorCategory: r.errorCategory ?? undefined,
      durationMs: r.durationMs,
      costUsd: Number(r.costUsd),
      changedFiles: r.changedFiles,
      pipelineId: r.pipelineId ?? undefined,
      timestamp: r.timestamp.toISOString(),
    }));
  }
}
