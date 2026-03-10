/**
 * Load webhook adapter extensions from a directory.
 *
 * Convention: each file should export a `default` or named `adapter` that is a WebhookAdapter,
 * or a factory function `createAdapter(config)` that returns a WebhookAdapter.
 *
 * Files are discovered by scanning the directory for `.ts` and `.js` files (excluding `.d.ts`).
 * Invalid files are skipped with a warning — a bad extension never crashes the daemon.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { logInfo, logWarn } from "../../logger.js";
import { registerAdapter, type WebhookAdapter } from "./adapter-registry.js";

/** Check whether a value quacks like a WebhookAdapter. */
function isWebhookAdapter(value: unknown): value is WebhookAdapter {
  if (value == null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.source === "string" &&
    typeof obj.verifySignature === "function" &&
    typeof obj.parseEvent === "function"
  );
}

/**
 * Scan `dir` for adapter files, dynamically import them, and register valid adapters.
 *
 * Returns the list of successfully loaded adapters.
 * Returns an empty array when the directory is missing or empty.
 */
export async function loadExtensionAdapters(
  dir: string,
  config?: Record<string, unknown>
): Promise<WebhookAdapter[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist or isn't readable — perfectly fine
    return [];
  }

  const adapterFiles = entries.filter((f) => {
    if (f.endsWith(".d.ts")) return false;
    return f.endsWith(".ts") || f.endsWith(".js");
  });

  if (adapterFiles.length === 0) return [];

  const loaded: WebhookAdapter[] = [];

  for (const file of adapterFiles) {
    const filePath = path.resolve(dir, file);
    let mod: Record<string, unknown>;

    try {
      mod = (await import(filePath)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn("Observer: failed to import extension adapter", { file, error: msg });
      continue;
    }

    // Priority 1: named `adapter` export
    if (isWebhookAdapter(mod.adapter)) {
      registerAdapter(mod.adapter);
      loaded.push(mod.adapter);
      logInfo("Observer: loaded extension adapter", { file, source: mod.adapter.source });
      continue;
    }

    // Priority 2: `default` export
    if (isWebhookAdapter(mod.default)) {
      registerAdapter(mod.default);
      loaded.push(mod.default);
      logInfo("Observer: loaded extension adapter", { file, source: mod.default.source });
      continue;
    }

    // Priority 3: `createAdapter` factory
    if (typeof mod.createAdapter === "function") {
      try {
        const created = (mod.createAdapter as (cfg?: Record<string, unknown>) => unknown)(config);
        if (isWebhookAdapter(created)) {
          registerAdapter(created);
          loaded.push(created);
          logInfo("Observer: loaded extension adapter (factory)", { file, source: created.source });
          continue;
        }
        logWarn("Observer: createAdapter factory returned invalid adapter", { file });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn("Observer: createAdapter factory threw", { file, error: msg });
      }
      continue;
    }

    logWarn("Observer: extension file has no valid adapter export", { file });
  }

  return loaded;
}
