import assert from "node:assert/strict";
import test from "node:test";
import { recoverRunsAfterRestart } from "../src/runtime/startup-recovery.js";
import type { RunRecord } from "../src/types.js";

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run-1",
    runtime: "local",
    status: "running",
    phase: "agent",
    repoSlug: "org/repo",
    task: "recover test",
    baseBranch: "main",
    branchName: "goose/recover-test",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: "1",
    createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

test("startup recovery requeues local runs and reconciles kubernetes runs instead of requeueing them", async () => {
  const recoveredLocal = makeRun({ id: "run-local-1", runtime: "local", channelId: "C1" });
  const recoveredLocalTrigger = makeRun({ id: "run-local-2", runtime: "local", channelId: "local" });
  const inProgressKubernetes = makeRun({ id: "run-k8s-1", runtime: "kubernetes" });
  const requeued: string[] = [];
  const reconciled: string[] = [];

  const result = await recoverRunsAfterRestart(
    {
      recoverInProgressRuns: async () => [recoveredLocal, recoveredLocalTrigger],
      getInProgressRuns: async () => [inProgressKubernetes],
    },
    {
      requeueExistingRun: (runId: string) => {
        requeued.push(runId);
      },
    },
    {
      reconcileRun: async (runId: string) => {
        reconciled.push(runId);
      },
    },
    "Recovered after process restart. Auto-requeued.",
  );

  assert.deepEqual(requeued, ["run-local-1"]);
  assert.deepEqual(reconciled, ["run-k8s-1"]);
  assert.deepEqual(result, {
    recoveredRuns: [recoveredLocal, recoveredLocalTrigger],
    kubernetesRuns: [inProgressKubernetes],
    requeuedCount: 1,
    skippedLocalCount: 1,
  });
});
