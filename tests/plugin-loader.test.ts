/**
 * Tests for the plugin loader system.
 */

import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadPlugins, getPluginDir } from "../src/plugins/plugin-loader.js";

// Track temp dirs for cleanup
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-plugin-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── Missing / empty directory ──

describe("loadPlugins: missing directory", () => {
  test("returns empty result when directory does not exist", async () => {
    const result = await loadPlugins("/tmp/does-not-exist-gooseherd-plugins-xyz");
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.nodeHandlers, {});
    assert.equal(result.adapterCount, 0);
  });

  test("returns empty result for empty directory", async () => {
    const dir = await makeTempDir();
    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, []);
  });
});

// ── Valid plugin with node handlers ──

describe("loadPlugins: valid plugin with node handlers", () => {
  test("loads a valid plugin file and extracts node handlers", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "my-plugin.ts"),
      `
const plugin = {
  name: "test-plugin",
  version: "1.0.0",
  nodeHandlers: {
    custom_action: async () => ({ outcome: "success" })
  }
};
export default plugin;
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, ["test-plugin"]);
    assert.deepEqual(result.failed, []);
    assert.equal(typeof result.nodeHandlers["custom_action"], "function");
    assert.equal(result.adapterCount, 0);
  });
});

// ── Valid plugin with webhook adapters ──

describe("loadPlugins: valid plugin with webhook adapters", () => {
  test("loads a valid plugin file with webhook adapters", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "adapter-plugin.ts"),
      `
const plugin = {
  name: "adapter-plugin",
  version: "2.0.0",
  webhookAdapters: [
    {
      source: "custom_webhook",
      verifySignature: () => true,
      parseEvent: () => null
    }
  ]
};
export default plugin;
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, ["adapter-plugin"]);
    assert.equal(result.adapterCount, 1);
  });
});

// ── Validation failures ──

describe("loadPlugins: validation failures", () => {
  test("rejects plugin with missing name", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "no-name.ts"),
      `
const plugin = {
  version: "1.0.0"
};
export default plugin;
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, ["no-name.ts"]);
  });

  test("rejects plugin with missing version", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "no-version.ts"),
      `
const plugin = {
  name: "bad-plugin"
};
export default plugin;
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, ["no-version.ts"]);
  });

  test("rejects plugin that is not an object", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "string-plugin.ts"),
      `
export default "not a plugin";
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, ["string-plugin.ts"]);
  });
});

// ── Import errors ──

describe("loadPlugins: import errors", () => {
  test("reports failed files on import error", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "crash-plugin.ts"),
      `
throw new Error("Plugin crashes on import");
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, ["crash-plugin.ts"]);
  });
});

// ── Node handler collision ──

describe("loadPlugins: node handler collision", () => {
  test("skips duplicate action names across plugins", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "alpha-plugin.ts"),
      `
const plugin = {
  name: "alpha",
  version: "1.0.0",
  nodeHandlers: {
    shared_action: async () => ({ outcome: "success", outputs: { from: "alpha" } })
  }
};
export default plugin;
`
    );
    await writeFile(
      path.join(dir, "beta-plugin.ts"),
      `
const plugin = {
  name: "beta",
  version: "1.0.0",
  nodeHandlers: {
    shared_action: async () => ({ outcome: "success", outputs: { from: "beta" } })
  }
};
export default plugin;
`
    );

    const result = await loadPlugins(dir);
    // Both plugins load, but the second handler for shared_action is skipped
    assert.equal(result.loaded.length, 2);
    assert.equal(typeof result.nodeHandlers["shared_action"], "function");
    // Only one handler registered (the first one wins)
    const handlerResult = await result.nodeHandlers["shared_action"](
      { id: "test", type: "deterministic", action: "shared_action" },
      {} as never,
      {} as never
    );
    assert.equal(
      (handlerResult.outputs as Record<string, string>).from,
      "alpha"
    );
  });
});

// ── File filtering ──

describe("loadPlugins: file filtering", () => {
  test("ignores non-TS/JS files, hidden files, .d.ts files, .test.ts files", async () => {
    const dir = await makeTempDir();

    // Files that should be ignored
    await writeFile(path.join(dir, "README.md"), "# Ignored");
    await writeFile(path.join(dir, ".hidden-plugin.ts"), `export default { name: "hidden", version: "1.0.0" };`);
    await writeFile(path.join(dir, "types.d.ts"), `export interface Foo {}`);
    await writeFile(path.join(dir, "my-plugin.test.ts"), `export default { name: "test-file", version: "1.0.0" };`);
    await writeFile(path.join(dir, "data.json"), `{}`);
    await writeFile(path.join(dir, ".gitkeep"), "");

    // One valid plugin so we can verify filtering works
    await writeFile(
      path.join(dir, "valid-plugin.ts"),
      `
const plugin = {
  name: "valid-only",
  version: "1.0.0"
};
export default plugin;
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, ["valid-only"]);
    assert.deepEqual(result.failed, []);
  });

  test("loads .js files", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "js-plugin.js"),
      `
const plugin = {
  name: "js-plugin",
  version: "1.0.0",
  nodeHandlers: {
    js_action: async () => ({ outcome: "success" })
  }
};
export default plugin;
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, ["js-plugin"]);
    assert.equal(typeof result.nodeHandlers["js_action"], "function");
  });
});

// ── Non-directory path ──

describe("loadPlugins: non-directory path", () => {
  test("returns empty result when path is a file, not a directory", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "not-a-dir.txt");
    await writeFile(filePath, "just a file");

    const result = await loadPlugins(filePath);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, []);
  });
});

// ── getPluginDir ──

describe("getPluginDir", () => {
  test("returns resolved path to extensions/plugins", () => {
    const dir = getPluginDir();
    assert.ok(path.isAbsolute(dir));
    assert.ok(dir.endsWith(path.join("extensions", "plugins")));
  });
});

// ── Multiple contributions ──

describe("loadPlugins: mixed contributions", () => {
  test("loads plugin with both node handlers and webhook adapters", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "full-plugin.ts"),
      `
const plugin = {
  name: "full-plugin",
  version: "3.0.0",
  nodeHandlers: {
    action_a: async () => ({ outcome: "success" }),
    action_b: async () => ({ outcome: "skipped" })
  },
  webhookAdapters: [
    {
      source: "webhook_x",
      verifySignature: () => true,
      parseEvent: () => null
    },
    {
      source: "webhook_y",
      verifySignature: () => false,
      parseEvent: () => null
    }
  ]
};
export default plugin;
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, ["full-plugin"]);
    assert.equal(Object.keys(result.nodeHandlers).length, 2);
    assert.equal(result.adapterCount, 2);
  });
});

// ── Named export fallback ──

describe("loadPlugins: named export fallback", () => {
  test("loads plugin from named exports when no default export", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "named-plugin.ts"),
      `
export const name = "named-export-plugin";
export const version = "1.0.0";
export const nodeHandlers = {
  named_action: async () => ({ outcome: "success" })
};
`
    );

    const result = await loadPlugins(dir);
    assert.deepEqual(result.loaded, ["named-export-plugin"]);
    assert.equal(typeof result.nodeHandlers["named_action"], "function");
  });
});
