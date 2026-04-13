import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const INTERNAL_BASE_URL_PATTERN =
  /(-\s+name:\s+GOOSEHERD_INTERNAL_BASE_URL\s*\n\s+value:\s*)"[^"\n]*"(\s*)/m;

function usage(): never {
  throw new Error(
    "Usage: node --import tsx scripts/kubernetes/override-internal-base-url.ts <manifest-path> <base-url>",
  );
}

export function overrideManifestInternalBaseUrl(manifest: string, baseUrl: string): string {
  if (!baseUrl || baseUrl.trim() === "") {
    throw new Error("GOOSEHERD_INTERNAL_BASE_URL override must not be empty");
  }

  if (!INTERNAL_BASE_URL_PATTERN.test(manifest)) {
    throw new Error("GOOSEHERD_INTERNAL_BASE_URL entry not found in manifest");
  }

  return manifest.replace(INTERNAL_BASE_URL_PATTERN, `$1${JSON.stringify(baseUrl)}$2`);
}

async function main(): Promise<void> {
  const [manifestPath, baseUrl] = process.argv.slice(2);
  if (!manifestPath || !baseUrl) usage();

  const manifest = await readFile(manifestPath, "utf8");
  const updated = overrideManifestInternalBaseUrl(manifest, baseUrl);
  await writeFile(manifestPath, updated, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
