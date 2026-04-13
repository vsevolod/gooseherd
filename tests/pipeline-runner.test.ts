import assert from "node:assert/strict";
import test from "node:test";
import { runPipelineRunner } from "../src/runner/pipeline-runner.js";
import type { RunEnvelope, RunnerCompletionPayload, RunnerEventPayload } from "../src/runtime/control-plane-types.js";

const samplePayload: RunEnvelope = {
  runId: "run-pipeline-runner-1",
  payloadRef: "payload/run-pipeline-runner-1",
  payloadJson: {
    run: {
      id: "run-pipeline-runner-1",
      runtime: "kubernetes",
      repoSlug: "org/repo",
      task: "pipeline runner test",
      baseBranch: "main",
      branchName: "goose/test",
      requestedBy: "runner",
      channelId: "runner",
      threadTs: "runner",
      createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
    },
  },
  runtime: "kubernetes",
  createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
};

test("pipeline runner ignores transient cancellation polling failures during a successful run", async () => {
  const events: RunnerEventPayload[] = [];
  const completions: RunnerCompletionPayload[] = [];
  let cancellationChecks = 0;

  await runPipelineRunner(
    {
      getPayload: async () => samplePayload,
      appendEvent: async (event: RunnerEventPayload) => {
        events.push(event);
      },
      complete: async (payload: RunnerCompletionPayload) => {
        completions.push(payload);
      },
      getCancellation: async () => {
        cancellationChecks += 1;
        if (cancellationChecks === 1) {
          throw new Error("temporary upstream failure");
        }
        return { cancelRequested: false };
      },
    } as never,
    async () => ({
      branchName: "goose/test",
      logsPath: "/tmp/run.log",
      commitSha: "abc123",
      changedFiles: ["src/index.ts"],
    }),
  );

  assert.equal(cancellationChecks >= 1, true);
  assert.equal(events.some((event) => event.eventType === "run.started"), true);
  assert.equal(events.some((event) => event.eventType === "run.warning"), false);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, "success");
  assert.equal(completions[0]?.artifactState, "complete");
});
