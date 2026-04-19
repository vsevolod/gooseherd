import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("dashboard server lazy-loads eval scenario loader", async () => {
  const source = await readFile(path.join(repoRoot, "src/dashboard-server.ts"), "utf8");

  assert.ok(
    !source.includes('import { loadScenariosFromDir } from "./eval/scenario-loader.js";'),
    "Expected dashboard-server to avoid top-level runtime import of eval scenario loader",
  );
  assert.ok(
    source.includes('await import("./eval/scenario-loader.js")'),
    "Expected dashboard-server to lazy-load eval scenario loader inside the eval route",
  );
});
