import type { WebClient } from "@slack/web-api";
import type { AppConfig } from "../config.js";
import type { RunManager } from "../run-manager.js";
import type { PipelineEngine } from "../pipeline/pipeline-engine.js";
import type { RunStore } from "../store.js";
import type { NodeEvent } from "../pipeline/types.js";
import { classifyFailureWithRetryability } from "./failure-classifier.js";
import { logInfo, logError, logWarn } from "../logger.js";

interface WatchedRun {
  runId: string;
  startedAt: number;
  lastNodeEventAt: number;
  currentNodeId: string | null;
  currentNodeAction: string | null;
  retryCount: number;
  channelId: string;
  threadTs: string;
}

export class RunSupervisor {
  private readonly watchedRuns = new Map<string, WatchedRun>();
  /** Tracks retry chain: originalRunId → latest retried runId */
  private readonly retryChain = new Map<string, string>();
  private watchdogTimer: NodeJS.Timeout | undefined;
  private dailyRetryCount = 0;
  private dailyResetTimer: NodeJS.Timeout | undefined;
  /** Cooldown: originalRunId → last retry timestamp */
  private readonly lastRetryAt = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly runManager: RunManager,
    private readonly pipelineEngine: PipelineEngine,
    private readonly store: RunStore,
    private readonly slackClient?: WebClient
  ) {}

  start(): void {
    this.pipelineEngine.onNodeEvent((event) => { this.handleNodeEvent(event); });
    this.runManager.onRunTerminal((runId, status) => { this.handleRunTerminal(runId, status); });

    this.watchdogTimer = setInterval(() => {
      this.watchdogSweep();
    }, this.config.supervisorWatchdogIntervalSeconds * 1000);
    this.watchdogTimer.unref?.();

    // Reset daily counter at midnight
    this.scheduleDailyReset();

    logInfo("RunSupervisor started", {
      watchdogIntervalS: this.config.supervisorWatchdogIntervalSeconds,
      runTimeoutS: this.config.supervisorRunTimeoutSeconds,
      nodeStaleS: this.config.supervisorNodeStaleSeconds,
      maxRetries: this.config.supervisorMaxAutoRetries,
      maxPerDay: this.config.supervisorMaxRetriesPerDay
    });
  }

  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    if (this.dailyResetTimer) {
      clearTimeout(this.dailyResetTimer);
      this.dailyResetTimer = undefined;
    }
    this.watchedRuns.clear();
  }

  /** Exposed for testing. */
  getWatchedRun(runId: string): WatchedRun | undefined {
    return this.watchedRuns.get(runId);
  }

  /** Exposed for testing. */
  getDailyRetryCount(): number {
    return this.dailyRetryCount;
  }

  private handleNodeEvent(event: NodeEvent): void {
    const now = Date.now();

    if (event.type === "start") {
      let watched = this.watchedRuns.get(event.runId);
      if (!watched) {
        // First event for this run — look up Slack thread info
        this.store.getRun(event.runId).then((run) => {
          if (!run) return;
          const retryCount = this.resolveRetryCount(event.runId);
          const entry: WatchedRun = {
            runId: event.runId,
            startedAt: now,
            lastNodeEventAt: now,
            currentNodeId: event.nodeId,
            currentNodeAction: event.action,
            retryCount,
            channelId: run.channelId,
            threadTs: run.threadTs
          };
          this.watchedRuns.set(event.runId, entry);
        }).catch(() => { /* best-effort */ });
        return;
      }
      watched.lastNodeEventAt = now;
      watched.currentNodeId = event.nodeId;
      watched.currentNodeAction = event.action;
    }

    if (event.type === "end") {
      const watched = this.watchedRuns.get(event.runId);
      if (watched) {
        watched.lastNodeEventAt = now;
      }
    }
  }

  private handleRunTerminal(runId: string, status: string): void {
    const watched = this.watchedRuns.get(runId);
    this.watchedRuns.delete(runId);

    if (status !== "failed") return;

    this.store.getRun(runId).then(async (run) => {
      if (!run?.error) return;

      const classified = classifyFailureWithRetryability(run.error);
      const retryCount = watched?.retryCount ?? this.resolveRetryCount(runId);
      const originalRunId = this.findOriginalRunId(runId);

      if (!classified.retryable) {
        logInfo("Supervisor: permanent failure, not retrying", {
          runId, category: classified.category
        });
        await this.postSlackReply(
          run.channelId, run.threadTs,
          `Permanent failure (*${classified.category}*): ${classified.friendly}. Not retrying.`
        );
        return;
      }

      // Check retry cap
      if (retryCount >= this.config.supervisorMaxAutoRetries) {
        logWarn("Supervisor: retry cap reached", { runId, retryCount });
        await this.postSlackReply(
          run.channelId, run.threadTs,
          `Giving up after ${String(retryCount)} auto-retry attempt(s). Needs human attention.\n_${classified.friendly}_`
        );
        return;
      }

      // Check daily cap
      if (this.dailyRetryCount >= this.config.supervisorMaxRetriesPerDay) {
        logWarn("Supervisor: daily retry cap reached", { dailyCount: this.dailyRetryCount });
        await this.postSlackReply(
          run.channelId, run.threadTs,
          `Daily auto-retry budget exhausted (${String(this.dailyRetryCount)}/${String(this.config.supervisorMaxRetriesPerDay)}). Not retrying.`
        );
        return;
      }

      // Check cooldown
      const lastRetry = this.lastRetryAt.get(originalRunId);
      if (lastRetry && (Date.now() - lastRetry) < this.config.supervisorRetryCooldownSeconds * 1000) {
        logWarn("Supervisor: cooldown active, skipping retry", { runId, originalRunId });
        return;
      }

      // Auto-retry
      const attempt = retryCount + 1;
      const maxRetries = this.config.supervisorMaxAutoRetries;
      logInfo("Supervisor: auto-retrying", { runId, attempt, maxRetries, category: classified.category });

      await this.postSlackReply(
        run.channelId, run.threadTs,
        `Auto-retrying: ${classified.friendly} (attempt ${String(attempt)}/${String(maxRetries)})`
      );

      const newRun = await this.runManager.retryRun(runId, "supervisor");
      if (newRun) {
        this.retryChain.set(newRun.id, originalRunId);
        this.lastRetryAt.set(originalRunId, Date.now());
        this.dailyRetryCount++;

        // Pre-seed the WatchedRun so the watchdog starts tracking immediately
        this.watchedRuns.set(newRun.id, {
          runId: newRun.id,
          startedAt: Date.now(),
          lastNodeEventAt: Date.now(),
          currentNodeId: null,
          currentNodeAction: null,
          retryCount: attempt,
          channelId: newRun.channelId,
          threadTs: newRun.threadTs
        });
      }
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : "unknown";
      logError("Supervisor: error handling terminal run", { runId, error: msg });
    });
  }

  private watchdogSweep(): void {
    const now = Date.now();

    for (const [runId, watched] of this.watchedRuns) {
      const elapsedMs = now - watched.startedAt;
      const staleMs = now - watched.lastNodeEventAt;

      // Run timeout
      if (elapsedMs > this.config.supervisorRunTimeoutSeconds * 1000) {
        const hours = (this.config.supervisorRunTimeoutSeconds / 3600).toFixed(1);
        logWarn("Supervisor: run timed out", { runId, elapsedMs });

        this.store.updateRun(runId, {
          status: "failed",
          phase: "failed",
          finishedAt: new Date().toISOString(),
          error: `Pipeline timed out (exceeded ${hours}h limit)`
        }).then(() => {
          // The RunManager's processRun will fire terminal callbacks via its own path,
          // but that won't fire for externally-failed runs. Fire it ourselves.
          this.handleRunTerminal(runId, "failed");
        }).catch((err) => {
          const msg = err instanceof Error ? err.message : "unknown";
          logError("Supervisor: failed to force-fail timed out run", { runId, error: msg });
        });

        this.postSlackReply(
          watched.channelId, watched.threadTs,
          `Run timed out after ${hours}h. Force-failing.`
        ).catch(() => { /* best-effort */ });

        continue;
      }

      // Node stale alert (warn only, don't kill)
      if (staleMs > this.config.supervisorNodeStaleSeconds * 1000 && watched.currentNodeId) {
        const staleMinutes = Math.floor(staleMs / 60_000);
        const thresholdMinutes = Math.floor(this.config.supervisorNodeStaleSeconds / 60);
        logWarn("Supervisor: node stale", {
          runId, nodeId: watched.currentNodeId, staleMinutes
        });

        // Only alert once per stale threshold crossing (avoid spam)
        // We use the lastNodeEventAt as a proxy — if it hasn't changed, we already alerted
        const alertKey = `${runId}:${watched.currentNodeId}:${String(Math.floor(staleMs / (this.config.supervisorNodeStaleSeconds * 1000)))}`;
        if (!this.staleAlerted.has(alertKey)) {
          this.staleAlerted.add(alertKey);
          this.postSlackReply(
            watched.channelId, watched.threadTs,
            `Node \`${watched.currentNodeId}\` has been running for ${String(staleMinutes)}m (threshold: ${String(thresholdMinutes)}m). Monitoring...`
          ).catch(() => { /* best-effort */ });
        }
      }
    }
  }

  /** Tracks which stale alerts have been sent to avoid spam. */
  private readonly staleAlerted = new Set<string>();

  private resolveRetryCount(runId: string): number {
    // Walk the chain to find how many retries deep we are
    for (const [childId, originalId] of this.retryChain) {
      if (childId === runId) {
        // This run is a retry — count retries for the original
        let count = 0;
        for (const [, origId] of this.retryChain) {
          if (origId === originalId) count++;
        }
        return count;
      }
    }
    return 0;
  }

  private findOriginalRunId(runId: string): string {
    return this.retryChain.get(runId) ?? runId;
  }

  private async postSlackReply(channelId: string, threadTs: string, text: string): Promise<void> {
    // Don't post to non-Slack channels (e.g. "local") or when Slack is not configured
    if (!this.slackClient || !/^[CGD][A-Z0-9]+$/.test(channelId)) return;

    try {
      await this.slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `[Supervisor] ${text}`,
        ...(this.config.slackCommandName ? { username: this.config.slackCommandName } : {})
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logError("Supervisor: failed to post Slack reply", { channelId, error: msg });
    }
  }

  private scheduleDailyReset(): void {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    this.dailyResetTimer = setTimeout(() => {
      this.dailyRetryCount = 0;
      this.lastRetryAt.clear();
      this.staleAlerted.clear();
      this.scheduleDailyReset();
    }, msUntilMidnight);
    this.dailyResetTimer.unref?.();
  }
}
