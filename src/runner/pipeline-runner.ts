import { randomUUID } from "node:crypto";
import type { ExecutionResult, RunRecord } from "../types.js";
import type {
  RunEnvelope,
  RunnerEventPayload,
} from "../runtime/control-plane-types.js";
import { RunnerControlPlaneClient } from "./control-plane-client.js";

export type RunnerPipelineExecutor = (
  run: RunRecord,
  payload: RunEnvelope,
  emit: RunnerEventEmitter,
  abortSignal: AbortSignal,
) => Promise<ExecutionResult>;

export type RunnerEventEmitter = (
  eventType: RunnerEventPayload["eventType"],
  eventPayload?: Record<string, unknown>,
) => Promise<void>;

const DEFAULT_CANCELLATION_POLL_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  return filtered.length > 0 ? filtered : undefined;
}

function readInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function deriveRunRecordFromPayload(payload: RunEnvelope): RunRecord {
  const maybeRootRun = isRecord(payload.payloadJson.run) ? payload.payloadJson.run : undefined;
  const source = maybeRootRun ?? payload.payloadJson;
  const runIdShort = payload.runId.slice(0, 8);

  return {
    id: readString(source, "id") ?? payload.runId,
    runtime: payload.runtime,
    status: "running",
    phase: "queued",
    repoSlug: readString(source, "repoSlug") ?? "unknown/unknown",
    task: readString(source, "task") ?? "",
    baseBranch: readString(source, "baseBranch") ?? "main",
    branchName: readString(source, "branchName") ?? `goose/${runIdShort}`,
    requestedBy: readString(source, "requestedBy") ?? "runner",
    channelId: readString(source, "channelId") ?? "runner",
    threadTs: readString(source, "threadTs") ?? payload.runId,
    createdAt: readString(source, "createdAt") ?? payload.createdAt,
    startedAt: readString(source, "startedAt"),
    finishedAt: readString(source, "finishedAt"),
    parentRunId: readString(source, "parentRunId"),
    rootRunId: readString(source, "rootRunId"),
    chainIndex: readInteger(source, "chainIndex"),
    parentBranchName: readString(source, "parentBranchName"),
    feedbackNote: readString(source, "feedbackNote"),
    pipelineHint: readString(source, "pipelineHint"),
    skipNodes: readStringArray(source, "skipNodes"),
    enableNodes: readStringArray(source, "enableNodes"),
    teamId: readString(source, "teamId"),
  };
}

function readCancellationPollMs(): number {
  const raw = process.env.RUNNER_CANCELLATION_POLL_MS;
  if (!raw) return DEFAULT_CANCELLATION_POLL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CANCELLATION_POLL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPipelineRunner(
  client: RunnerControlPlaneClient,
  executePipeline: RunnerPipelineExecutor,
): Promise<void> {
  const payload = await client.getPayload();
  const run = deriveRunRecordFromPayload(payload);
  let sequence = 0;

  const emit: RunnerEventEmitter = async (eventType, eventPayload) => {
    sequence += 1;
    await client.appendEvent({
      eventId: randomUUID(),
      eventType,
      timestamp: new Date().toISOString(),
      sequence,
      payload: eventPayload,
    });
  };

  await emit("run.started", {
    runId: run.id,
    runtime: payload.runtime,
    payloadRef: payload.payloadRef,
  });

  const abortController = new AbortController();
  const cancellationPollMs = readCancellationPollMs();
  let stopPolling = false;
  let cancellationObserved = false;

  const pollingPromise = (async () => {
    while (!stopPolling && !abortController.signal.aborted) {
      const cancellation = await client.getCancellation();
      if (cancellation.cancelRequested) {
        cancellationObserved = true;
        await emit("run.cancellation_observed", { runId: run.id });
        abortController.abort();
        return;
      }
      await sleep(cancellationPollMs);
    }
  })();

  try {
    const result = await executePipeline(run, payload, emit, abortController.signal);
    stopPolling = true;
    await pollingPromise;
    await emit("run.completion_attempted", { status: "success" });
    await client.complete({
      idempotencyKey: randomUUID(),
      status: "success",
      artifactState: "complete",
      commitSha: result.commitSha,
      changedFiles: result.changedFiles,
      prUrl: result.prUrl,
      tokenUsage: result.tokenUsage,
      title: result.title,
    });
  } catch (error) {
    stopPolling = true;
    await pollingPromise.catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    await emit("run.warning", { reason });
    await emit("run.completion_attempted", {
      status: "failed",
      reason,
      ...(cancellationObserved ? { cancellationObserved: true } : {}),
    });
    await client.complete({
      idempotencyKey: randomUUID(),
      status: "failed",
      artifactState: "failed",
      reason,
    });
    throw error;
  }
}
