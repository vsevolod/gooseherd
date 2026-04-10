import dotenv from "dotenv";
dotenv.config({ override: true });

import { readFile } from "node:fs/promises";
import { closeDatabase, initDatabase } from "../../src/db/index.js";
import { ControlPlaneStore } from "../../src/runtime/control-plane-store.js";
import { RuntimeReconciler } from "../../src/runtime/reconciler.js";
import type { TerminalFact } from "../../src/runtime/terminal-fact.js";
import { RunStore } from "../../src/store.js";
import type { SmokeMetadata } from "./seed-smoke-run.ts";

function usage(): never {
  throw new Error(
    "Usage: node --import tsx scripts/kubernetes/finalize-smoke-run.ts <metadata-path> <runtime-fact>",
  );
}

async function main(): Promise<void> {
  const [metadataPath, runtimeFactArg] = process.argv.slice(2);
  if (!metadataPath || !runtimeFactArg) usage();

  if (
    runtimeFactArg !== "succeeded" &&
    runtimeFactArg !== "failed" &&
    runtimeFactArg !== "missing" &&
    runtimeFactArg !== "running"
  ) {
    throw new Error(`Unsupported runtime fact: ${runtimeFactArg}`);
  }
  const runtimeFact = runtimeFactArg as TerminalFact;

  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as SmokeMetadata;
  const db = await initDatabase(process.env.DATABASE_URL ?? "postgres://gooseherd:gooseherd@postgres:5432/gooseherd");
  const controlPlaneStore = new ControlPlaneStore(db);
  const runStore = new RunStore(db);
  await runStore.init();

  const reconciler = new RuntimeReconciler(
    controlPlaneStore,
    {
      getTerminalFact: async () => runtimeFact,
    },
    runStore,
  );
  await reconciler.reconcileRun(metadata.runId);

  const run = await runStore.getRun(metadata.runId);
  if (!run) {
    throw new Error(`Run not found after reconciliation: ${metadata.runId}`);
  }
  process.stdout.write(`${JSON.stringify(run)}\n`);
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
