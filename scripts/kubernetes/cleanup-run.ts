import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

interface SmokeMetadata {
  jobName: string;
  namespace: string;
  secretName: string;
}

function usage(): never {
  throw new Error("Usage: node scripts/kubernetes/cleanup-run.ts <metadata-path>");
}

async function kubectlDelete(args: string[]): Promise<void> {
  await execFileAsync("kubectl", args, { cwd: process.cwd() });
}

async function main(): Promise<void> {
  const [metadataPath] = process.argv.slice(2);
  if (!metadataPath) usage();

  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as SmokeMetadata;

  await kubectlDelete([
    "delete",
    "job",
    metadata.jobName,
    "--namespace",
    metadata.namespace,
    "--ignore-not-found=true",
    "--wait=true",
  ]);

  await kubectlDelete([
    "delete",
    "pod",
    "--namespace",
    metadata.namespace,
    "--selector",
    `job-name=${metadata.jobName}`,
    "--ignore-not-found=true",
    "--wait=true",
  ]);

  await kubectlDelete([
    "delete",
    "secret",
    metadata.secretName,
    "--namespace",
    metadata.namespace,
    "--ignore-not-found=true",
    "--wait=true",
  ]);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
