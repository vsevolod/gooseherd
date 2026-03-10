import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { PipelineStore } from "../src/pipeline/pipeline-store.js";
import { PipelineLoadError } from "../src/pipeline/pipeline-loader.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const VALID_YAML = `
version: 1
name: Test Pipeline
description: A test pipeline
nodes:
  - id: step1
    type: deterministic
    action: run
    config:
      command: "echo hello"
`;

const VALID_YAML_2 = `
version: 1
name: Updated Pipeline
description: An updated pipeline
nodes:
  - id: step1
    type: deterministic
    action: run
    config:
      command: "echo hello"
  - id: step2
    type: deterministic
    action: run
    config:
      command: "echo world"
`;

const INVALID_YAML = `
version: 1
name: Bad Pipeline
nodes: []
`;

const MALFORMED_YAML = `
  : [broken
`;

interface TestContext {
  store: PipelineStore;
  pipelinesDir: string;
  testDb: TestDb;
}

async function setup(prefix = "gooseherd-ps-test-"): Promise<TestContext> {
  const testDb = await createTestDb();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const pipelinesDir = path.join(tmpDir, "pipelines");
  await mkdir(pipelinesDir, { recursive: true });

  // Write a sample built-in pipeline
  await writeFile(path.join(pipelinesDir, "default.yml"), VALID_YAML);

  const store = new PipelineStore(testDb.db);
  return { store, pipelinesDir, testDb };
}

describe("PipelineStore", () => {
  test("init() loads built-in pipelines from disk", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    const all = store.list();

    assert.equal(all.length, 1);
    assert.equal(all[0]?.id, "default");
    assert.equal(all[0]?.name, "Test Pipeline");
    assert.equal(all[0]?.isBuiltIn, true);
    assert.equal(all[0]?.nodeCount, 1);
    assert.equal(all[0]?.description, "A test pipeline");
  });

  test("init() handles missing pipelines directory gracefully", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new PipelineStore(testDb.db);
    await store.init(path.join(os.tmpdir(), `nonexistent-${Date.now()}`));

    assert.equal(store.list().length, 0);
  });

  test("list() returns all pipelines", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    // Write a second built-in
    await writeFile(path.join(pipelinesDir, "hotfix.yml"), VALID_YAML.replace("Test Pipeline", "Hotfix Pipeline"));
    await store.init(pipelinesDir);

    const all = store.list();
    assert.equal(all.length, 2);
    const ids = all.map((p) => p.id).sort();
    assert.deepEqual(ids, ["default", "hotfix"]);
  });

  test("get() returns a specific pipeline", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    const result = store.get("default");

    assert.ok(result);
    assert.equal(result.id, "default");
    assert.equal(result.name, "Test Pipeline");
  });

  test("get() returns undefined for unknown ID", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    const result = store.get("nonexistent");

    assert.equal(result, undefined);
  });

  test("save() creates a new pipeline with valid YAML", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    const saved = await store.save("my-custom", VALID_YAML);

    assert.equal(saved.id, "my-custom");
    assert.equal(saved.name, "Test Pipeline");
    assert.equal(saved.isBuiltIn, false);
    assert.equal(saved.nodeCount, 1);
    assert.ok(saved.createdAt);
    assert.ok(saved.updatedAt);

    // Verify it shows in list
    const all = store.list();
    assert.equal(all.length, 2);
  });

  test("save() rejects invalid YAML (throws PipelineLoadError)", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);

    await assert.rejects(
      () => store.save("bad-pipeline", INVALID_YAML),
      (err: Error) => {
        assert.ok(err instanceof PipelineLoadError);
        return true;
      }
    );
  });

  test("save() rejects overwriting built-in pipeline", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);

    await assert.rejects(
      () => store.save("default", VALID_YAML),
      (err: Error) => {
        assert.ok(err instanceof PipelineLoadError);
        assert.match(err.message, /built-in/);
        return true;
      }
    );
  });

  test("save() updates existing user-created pipeline", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    const created = await store.save("my-custom", VALID_YAML);
    const updated = await store.save("my-custom", VALID_YAML_2);

    assert.equal(updated.id, "my-custom");
    assert.equal(updated.name, "Updated Pipeline");
    assert.equal(updated.nodeCount, 2);
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(updated.updatedAt >= created.updatedAt, "updatedAt should be >= createdAt");

    // Total count should not increase
    assert.equal(store.list().length, 2);
  });

  test("delete() removes user-created pipeline", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    await store.save("my-custom", VALID_YAML);
    assert.equal(store.list().length, 2);

    const deleted = await store.delete("my-custom");
    assert.equal(deleted, true);
    assert.equal(store.list().length, 1);
    assert.equal(store.get("my-custom"), undefined);
  });

  test("delete() returns false for built-in pipeline", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    const deleted = await store.delete("default");
    assert.equal(deleted, false);
    assert.ok(store.get("default"));
  });

  test("delete() returns false for non-existent pipeline", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    const deleted = await store.delete("nonexistent");
    assert.equal(deleted, false);
  });

  test("validate() returns PipelineConfig for valid YAML", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    const config = store.validate(VALID_YAML);

    assert.equal(config.name, "Test Pipeline");
    assert.equal(config.version, 1);
    assert.equal(config.nodes.length, 1);
  });

  test("validate() throws for invalid YAML", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);

    assert.throws(
      () => store.validate(INVALID_YAML),
      (err: Error) => {
        assert.ok(err instanceof PipelineLoadError);
        return true;
      }
    );
  });

  test("validate() throws for malformed YAML", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);

    assert.throws(
      () => store.validate(MALFORMED_YAML),
      (err: Error) => {
        assert.ok(err instanceof PipelineLoadError);
        return true;
      }
    );
  });

  test("pipeline IDs are derived from filenames", async (t) => {
    const testDb = await createTestDb();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-ps-ids-"));
    const pipelinesDir = path.join(tmpDir, "pipelines");
    await mkdir(pipelinesDir, { recursive: true });
    t.after(async () => {
      await testDb.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    await writeFile(path.join(pipelinesDir, "ui-change.yml"), VALID_YAML.replace("Test Pipeline", "UI Change"));
    await writeFile(path.join(pipelinesDir, "docs-only.yml"), VALID_YAML.replace("Test Pipeline", "Docs Only"));

    const store = new PipelineStore(testDb.db);
    await store.init(pipelinesDir);

    const ids = store.list().map((p) => p.id).sort();
    assert.deepEqual(ids, ["docs-only", "ui-change"]);
  });

  test("persists state to DB (write then re-init reads same data)", async (t) => {
    const { store, pipelinesDir, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await store.init(pipelinesDir);
    await store.save("custom-flow", VALID_YAML_2);

    // Create a new store instance pointing to the same database
    const store2 = new PipelineStore(testDb.db);
    await store2.init(pipelinesDir);

    const custom = store2.get("custom-flow");
    assert.ok(custom);
    assert.equal(custom.name, "Updated Pipeline");
    assert.equal(custom.isBuiltIn, false);
    assert.equal(custom.nodeCount, 2);

    // Built-in should also be present
    assert.ok(store2.get("default"));
    assert.equal(store2.list().length, 2);
  });
});
