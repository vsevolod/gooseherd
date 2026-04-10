import type { RunRecord } from "../types.js";

interface StartupRecoveryStore {
  recoverInProgressRuns(reason: string): Promise<RunRecord[]>;
  getInProgressRuns(): Promise<RunRecord[]>;
}

interface StartupRecoveryRunManager {
  requeueExistingRun(runId: string): void;
}

interface StartupRecoveryReconciler {
  reconcileRun(runId: string): Promise<void>;
}

export async function recoverRunsAfterRestart(
  store: StartupRecoveryStore,
  runManager: StartupRecoveryRunManager,
  runtimeReconciler: StartupRecoveryReconciler,
  reason: string,
): Promise<{
  recoveredRuns: RunRecord[];
  kubernetesRuns: RunRecord[];
  requeuedCount: number;
  skippedLocalCount: number;
}> {
  const recoveredRuns = await store.recoverInProgressRuns(reason);
  let requeuedCount = 0;
  let skippedLocalCount = 0;

  for (const run of recoveredRuns) {
    if (run.channelId === "local") {
      skippedLocalCount += 1;
      continue;
    }

    runManager.requeueExistingRun(run.id);
    requeuedCount += 1;
  }

  const kubernetesRuns = (await store.getInProgressRuns())
    .filter((run) => run.runtime === "kubernetes");
  await Promise.all(kubernetesRuns.map(async (run) => runtimeReconciler.reconcileRun(run.id)));

  return {
    recoveredRuns,
    kubernetesRuns,
    requeuedCount,
    skippedLocalCount,
  };
}
