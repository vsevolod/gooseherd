import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RUN_TOKEN_PATTERN = /^(\s*RUN_TOKEN:\s*)"[^"\n]*"(\s*)$/m;

function usage(): never {
  throw new Error("Usage: node --import tsx scripts/kubernetes/override-secret-token.ts <manifest-path> <run-token>");
}

export function overrideManifestRunToken(manifest: string, runToken: string): string {
  if (!runToken || runToken.trim() === "") {
    throw new Error("RUN_TOKEN override must not be empty");
  }

  if (!RUN_TOKEN_PATTERN.test(manifest)) {
    throw new Error("RUN_TOKEN entry not found in manifest");
  }

  return manifest.replace(RUN_TOKEN_PATTERN, `$1${JSON.stringify(runToken)}$2`);
}

async function main(): Promise<void> {
  const [manifestPath, runToken] = process.argv.slice(2);
  if (!manifestPath || !runToken) usage();

  const manifest = await readFile(manifestPath, "utf8");
  const updated = overrideManifestRunToken(manifest, runToken);
  await writeFile(manifestPath, updated, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
