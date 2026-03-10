/**
 * Tests for extension adapter auto-discovery and loading.
 */

import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadExtensionAdapters } from "../src/observer/sources/load-extension-adapters.js";

// Track temp dirs for cleanup
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-ext-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── Missing / empty directory ──

describe("loadExtensionAdapters: missing directory", () => {
  test("returns empty array for non-existent directory", async () => {
    const result = await loadExtensionAdapters("/tmp/does-not-exist-gooseherd-xyz");
    assert.deepEqual(result, []);
  });

  test("returns empty array for empty directory", async () => {
    const dir = await makeTempDir();
    const result = await loadExtensionAdapters(dir);
    assert.deepEqual(result, []);
  });
});

// ── Named `adapter` export ──

describe("loadExtensionAdapters: named adapter export", () => {
  test("loads file with named adapter export", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "my-adapter.ts"),
      `
export const adapter = {
  source: "test_named",
  verifySignature: () => true,
  parseEvent: () => null
};
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "test_named");
  });
});

// ── Default export ──

describe("loadExtensionAdapters: default export", () => {
  test("loads file with default export", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "default-adapter.ts"),
      `
const adapter = {
  source: "test_default",
  verifySignature: () => true,
  parseEvent: () => null
};
export default adapter;
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "test_default");
  });
});

// ── Factory function ──

describe("loadExtensionAdapters: createAdapter factory", () => {
  test("loads file with createAdapter factory", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "factory-adapter.ts"),
      `
export function createAdapter(config) {
  return {
    source: "test_factory",
    verifySignature: () => true,
    parseEvent: () => null
  };
}
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "test_factory");
  });

  test("passes config to createAdapter factory", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "config-adapter.ts"),
      `
export function createAdapter(config) {
  return {
    source: config?.name ?? "fallback",
    verifySignature: () => true,
    parseEvent: () => null
  };
}
`
    );

    const result = await loadExtensionAdapters(dir, { name: "custom_source" });
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "custom_source");
  });
});

// ── Invalid files ──

describe("loadExtensionAdapters: invalid files", () => {
  test("skips file with no adapter export", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "no-adapter.ts"),
      `
export const hello = "world";
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.deepEqual(result, []);
  });

  test("skips file with invalid adapter (missing source)", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "bad-adapter.ts"),
      `
export const adapter = {
  verifySignature: () => true,
  parseEvent: () => null
};
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.deepEqual(result, []);
  });

  test("skips file with invalid adapter (missing methods)", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "incomplete-adapter.ts"),
      `
export const adapter = {
  source: "incomplete",
  verifySignature: () => true
};
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.deepEqual(result, []);
  });

  test("skips file that throws on import", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "crash-adapter.ts"),
      `
throw new Error("I crash on import");
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.deepEqual(result, []);
  });
});

// ── File filtering ──

describe("loadExtensionAdapters: file filtering", () => {
  test("skips .d.ts files", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "types.d.ts"),
      `
export const adapter = {
  source: "should_not_load",
  verifySignature: () => true,
  parseEvent: () => null
};
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.deepEqual(result, []);
  });

  test("skips non-ts/js files", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "README.md"), "# Hello");
    await writeFile(path.join(dir, ".gitkeep"), "");

    const result = await loadExtensionAdapters(dir);
    assert.deepEqual(result, []);
  });

  test("loads .js files", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "js-adapter.js"),
      `
export const adapter = {
  source: "test_js",
  verifySignature: () => true,
  parseEvent: () => null
};
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "test_js");
  });
});

// ── Multiple adapters ──

describe("loadExtensionAdapters: multiple files", () => {
  test("loads multiple valid adapters from one directory", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "alpha.ts"),
      `
export const adapter = {
  source: "alpha",
  verifySignature: () => true,
  parseEvent: () => null
};
`
    );
    await writeFile(
      path.join(dir, "beta.ts"),
      `
export const adapter = {
  source: "beta",
  verifySignature: () => true,
  parseEvent: () => null
};
`
    );
    await writeFile(path.join(dir, "README.md"), "ignored");

    const result = await loadExtensionAdapters(dir);
    assert.equal(result.length, 2);
    const sources = result.map(a => a.source).sort();
    assert.deepEqual(sources, ["alpha", "beta"]);
  });
});

// ── Export priority ──

describe("loadExtensionAdapters: export priority", () => {
  test("named adapter takes priority over default export", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "dual-export.ts"),
      `
export const adapter = {
  source: "named_wins",
  verifySignature: () => true,
  parseEvent: () => null
};
export default {
  source: "default_loses",
  verifySignature: () => true,
  parseEvent: () => null
};
`
    );

    const result = await loadExtensionAdapters(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "named_wins");
  });
});
