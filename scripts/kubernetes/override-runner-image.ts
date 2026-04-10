import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RUNNER_IMAGE_PATTERN = /^(\s*image:\s*)(\S+)(\s*)$/m;

function usage(): never {
  throw new Error("Usage: node --import tsx scripts/kubernetes/override-runner-image.ts <manifest-path> <image>");
}

export function overrideManifestRunnerImage(manifest: string, image: string): string {
  if (!image || image.trim() === "") {
    throw new Error("runner image override must not be empty");
  }

  if (!RUNNER_IMAGE_PATTERN.test(manifest)) {
    throw new Error("runner image entry not found in manifest");
  }

  return manifest.replace(RUNNER_IMAGE_PATTERN, `$1${image}$3`);
}

async function main(): Promise<void> {
  const [manifestPath, image] = process.argv.slice(2);
  if (!manifestPath || !image) usage();

  const manifest = await readFile(manifestPath, "utf8");
  const updated = overrideManifestRunnerImage(manifest, image);
  await writeFile(manifestPath, updated, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
