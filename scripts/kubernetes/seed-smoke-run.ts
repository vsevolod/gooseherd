import dotenv from "dotenv";
dotenv.config({ override: true });

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { closeDatabase, initDatabase } from "../../src/db/index.js";
import { RunStore } from "../../src/store.js";
import { ControlPlaneStore } from "../../src/runtime/control-plane-store.js";
import {
  buildRunJobSpec,
  buildRunTokenSecretManifest,
  defaultJobName,
  defaultSecretName,
} from "../../src/runtime/kubernetes/job-spec.js";
import { redactSecretToken, renderManifestYaml } from "../../src/runtime/kubernetes/manifest-yaml.js";

export interface SmokeMetadata {
  runId: string;
  jobName: string;
  secretName: string;
  namespace: string;
  image: string;
  internalBaseUrl: string;
  pipelineFile: string;
  manifestPath: string;
}

const DEFAULT_SCENARIO_NAME = "smoke";
const DEFAULT_PIPELINE_FILE = "pipelines/kubernetes-smoke.yml";

function usage(): never {
  throw new Error(
    "Usage: node --import tsx scripts/kubernetes/seed-smoke-run.ts <output-dir> <runner-image> <internal-base-url> [namespace] [pipeline-file] [scenario-name]",
  );
}

export function resolveSmokeScenario(
  pipelineFileArg?: string,
  scenarioNameArg?: string,
): { pipelineFile: string; scenarioName: string } {
  const scenarioName = scenarioNameArg && scenarioNameArg.trim() !== ""
    ? scenarioNameArg
    : DEFAULT_SCENARIO_NAME;

  if (pipelineFileArg && pipelineFileArg.trim() !== "") {
    return { pipelineFile: pipelineFileArg, scenarioName };
  }

  if (scenarioName === "cancel") {
    return {
      pipelineFile: "pipelines/kubernetes-cancel-smoke.yml",
      scenarioName,
    };
  }

  if (scenarioName === "failure") {
    return {
      pipelineFile: "pipelines/kubernetes-fail-smoke.yml",
      scenarioName,
    };
  }

  return {
    pipelineFile: DEFAULT_PIPELINE_FILE,
    scenarioName,
  };
}

async function main(): Promise<void> {
  const [outputDir, image, internalBaseUrl, namespaceArg, pipelineFileArg, scenarioNameArg] = process.argv.slice(2);
  if (!outputDir || !image || !internalBaseUrl) usage();

  const namespace = namespaceArg && namespaceArg.trim() !== "" ? namespaceArg : "default";
  const { pipelineFile, scenarioName } = resolveSmokeScenario(pipelineFileArg, scenarioNameArg);
  const db = await initDatabase(process.env.DATABASE_URL ?? "postgres://gooseherd:gooseherd@postgres:5432/gooseherd");
  const runStore = new RunStore(db);
  await runStore.init();
  const controlPlaneStore = new ControlPlaneStore(db);

  const runId = randomUUID();
  const run = await runStore.createRun(
    {
      repoSlug: `local/kubernetes-${scenarioName}`,
      task: `Validate ${scenarioName} kubernetes runner path`,
      baseBranch: "main",
      requestedBy: `kubernetes-${scenarioName}`,
      channelId: "local",
      threadTs: runId,
      runtime: "kubernetes",
    },
    "gooseherd",
  );

  await controlPlaneStore.createRunEnvelope({
    runId: run.id,
    payloadRef: `payload/${run.id}`,
    payloadJson: { run },
    runtime: "kubernetes",
  });
  const token = await controlPlaneStore.issueRunToken(run.id);

  const jobName = defaultJobName(run.id);
  const secretName = defaultSecretName(run.id);
  const secret = buildRunTokenSecretManifest({
    runId: run.id,
    namespace,
    secretName,
    runToken: token.token,
  });
  const job = buildRunJobSpec({
    runId: run.id,
    namespace,
    image,
    secretName,
    internalBaseUrl,
    pipelineFile,
    jobName,
  });

  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "job.yaml");
  const metadataPath = path.join(outputDir, "metadata.json");
  await writeFile(manifestPath, renderManifestYaml(redactSecretToken(secret), job), "utf8");

  const metadata: SmokeMetadata = {
    runId: run.id,
    jobName,
    secretName,
    namespace,
    image,
    internalBaseUrl,
    pipelineFile,
    manifestPath,
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
  process.stdout.write(`${metadataPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabase();
    });
}
