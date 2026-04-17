import assert from "node:assert/strict";
import test from "node:test";
import { deriveRunRecordFromPayload, runPipelineRunner } from "../src/runner/pipeline-runner.js";
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
      prefetchContext: {
        meta: {
          fetchedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
          sources: ["jira"],
        },
        workItem: {
          id: "work-item-1",
          title: "Work item",
          workflow: "feature_delivery",
        },
        jira: {
          issue: {
            key: "HUB-1",
            description: "issue description",
          },
          comments: [],
        },
      },
      autoReviewSourceSubstate: "pr_adopted",
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

test("deriveRunRecordFromPayload preserves prefetched context and auto-review substate", () => {
  const run = deriveRunRecordFromPayload(samplePayload);

  assert.equal(run.prefetchContext?.workItem.id, "work-item-1");
  assert.equal(run.prefetchContext?.jira?.issue.key, "HUB-1");
  assert.equal(run.autoReviewSourceSubstate, "pr_adopted");
});

test("deriveRunRecordFromPayload reads top-level prefetched context from control-plane payload", () => {
  const run = deriveRunRecordFromPayload({
    ...samplePayload,
    payloadJson: {
      run: {
        ...samplePayload.payloadJson.run,
        prefetchContext: undefined,
        autoReviewSourceSubstate: undefined,
      },
      prefetch: {
        meta: {
          fetchedAt: new Date("2026-04-11T00:00:00.000Z").toISOString(),
          sources: ["github_pr"],
        },
        workItem: {
          id: "work-item-2",
          title: "Another work item",
          workflow: "feature_delivery",
        },
        github: {
          pr: {
            number: 99,
            url: "https://github.com/org/repo/pull/99",
            title: "Prefetched PR",
            body: "body",
            state: "open",
          },
          discussionComments: [],
          reviews: [],
          reviewComments: [],
          ci: {
            headSha: "deadbeef",
            conclusion: "success",
          },
        },
      },
      autoReviewSourceSubstate: "applying_review_feedback",
    },
  });

  assert.equal(run.prefetchContext?.workItem.id, "work-item-2");
  assert.equal(run.prefetchContext?.github?.pr.number, 99);
  assert.equal(run.autoReviewSourceSubstate, "applying_review_feedback");
});
