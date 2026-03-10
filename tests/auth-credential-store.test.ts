import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AuthCredentialStore, type StoredCredentials } from "../src/pipeline/quality-gates/auth-credential-store.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

describe("AuthCredentialStore", () => {
  test("load returns empty store when DB is empty", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new AuthCredentialStore(testDb.db);
    await store.load();
    assert.equal(await store.getForDomain("example.com"), undefined);
  });

  test("save and retrieve credentials by domain", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new AuthCredentialStore(testDb.db);
    await store.load();

    const creds: StoredCredentials = {
      email: "qa@example.com",
      password: "secret123",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      loginSuccessful: true
    };

    await store.save("example.com", creds);
    const retrieved = await store.getForDomain("example.com");
    assert.ok(retrieved);
    assert.equal(retrieved.email, creds.email);
    assert.equal(retrieved.password, creds.password);
    assert.equal(retrieved.loginSuccessful, true);
  });

  test("flush + load round-trips data (DB is immediate)", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new AuthCredentialStore(testDb.db);
    await store.load();

    await store.save("example.com", {
      email: "qa@example.com",
      password: "secret123",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      loginSuccessful: true
    });
    await store.flush();

    // Load into a fresh store on same DB
    const store2 = new AuthCredentialStore(testDb.db);
    await store2.load();
    const retrieved = await store2.getForDomain("example.com");
    assert.ok(retrieved);
    assert.equal(retrieved.email, "qa@example.com");
    assert.equal(retrieved.loginSuccessful, true);
  });

  test("flush is no-op when store is not dirty", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new AuthCredentialStore(testDb.db);
    await store.load();
    // No save — flush should not throw
    await store.flush();
  });

  test("touch updates lastUsedAt", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new AuthCredentialStore(testDb.db);
    await store.load();

    const originalDate = "2026-01-01T00:00:00.000Z";
    await store.save("example.com", {
      email: "qa@example.com",
      password: "secret123",
      createdAt: originalDate,
      lastUsedAt: originalDate,
      loginSuccessful: true
    });

    // Touch and verify lastUsedAt changed
    await store.touch("example.com");
    const creds = await store.getForDomain("example.com");
    assert.ok(creds);
    assert.notEqual(creds.lastUsedAt, originalDate);
  });

  test("touch is no-op for unknown domain", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new AuthCredentialStore(testDb.db);
    await store.load();
    // Should not throw
    await store.touch("nonexistent.com");
    assert.equal(await store.getForDomain("nonexistent.com"), undefined);
  });

  test("multiple domains stored independently", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new AuthCredentialStore(testDb.db);
    await store.load();

    await store.save("a.com", {
      email: "qa@a.com",
      password: "p1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      loginSuccessful: true
    });
    await store.save("b.com", {
      email: "qa@b.com",
      password: "p2",
      createdAt: "2026-02-01T00:00:00.000Z",
      lastUsedAt: "2026-02-01T00:00:00.000Z",
      loginSuccessful: false
    });

    const a = await store.getForDomain("a.com");
    const b = await store.getForDomain("b.com");
    assert.equal(a?.email, "qa@a.com");
    assert.equal(b?.email, "qa@b.com");
    assert.equal(await store.getForDomain("c.com"), undefined);
  });
});
