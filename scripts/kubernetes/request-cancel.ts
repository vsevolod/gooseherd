import dotenv from "dotenv";
dotenv.config({ override: true });

import { readFile } from "node:fs/promises";
import { closeDatabase, initDatabase } from "../../src/db/index.js";
import { RunStore } from "../../src/store.js";
import type { SmokeMetadata } from "./seed-smoke-run.ts";

function usage(): never {
  throw new Error("Usage: node --import tsx scripts/kubernetes/request-cancel.ts <metadata-path>");
}

async function main(): Promise<void> {
  const [metadataPath] = process.argv.slice(2);
  if (!metadataPath) usage();

  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as SmokeMetadata;
  const db = await initDatabase(process.env.DATABASE_URL ?? "postgres://gooseherd:gooseherd@postgres:5432/gooseherd");
  const runStore = new RunStore(db);
  await runStore.init();

  const run = await runStore.updateRun(metadata.runId, {
    status: "cancel_requested",
    phase: "cancel_requested",
  });

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
