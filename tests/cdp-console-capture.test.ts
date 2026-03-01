/**
 * Tests for CdpConsoleCapture — CDP-based console log capture.
 * TDD: tests written BEFORE implementation.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { CdpConsoleCapture } from "../src/pipeline/quality-gates/cdp-console-capture.js";

/** Minimal mock of the CdpSession interface used by CDP capture classes. */
function createMockSession() {
  const handlers = new Map<string, (params: Record<string, unknown>) => void>();
  const sentMethods: string[] = [];

  return {
    session: {
      send(method: string, _params?: Record<string, unknown>): Promise<unknown> {
        sentMethods.push(method);
        return Promise.resolve({});
      },
      on(event: string, handler: (params: Record<string, unknown>) => void): void {
        handlers.set(event, handler);
      },
      off(event: string, _handler: (params: Record<string, unknown>) => void): void {
        handlers.delete(event);
      }
    },
    handlers,
    sentMethods,
    /** Simulate a Runtime.consoleAPICalled event */
    emitConsole(type: string, args: Array<{ type: string; value?: unknown; description?: string }>, extra?: Record<string, unknown>) {
      const handler = handlers.get("Runtime.consoleAPICalled");
      if (!handler) throw new Error("No handler registered for Runtime.consoleAPICalled");
      handler({
        type,
        args,
        timestamp: Date.now() / 1000,
        ...extra
      });
    }
  };
}

describe("CdpConsoleCapture", () => {
  const tmpDir = path.resolve(".work", `test-console-${Date.now()}`);

  // Cleanup after all tests
  test("setup temp dir", async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  test("start() enables Runtime domain and registers handler", async () => {
    const { session, sentMethods, handlers } = createMockSession();
    const capture = new CdpConsoleCapture(session, tmpDir);

    await capture.start();

    assert.ok(sentMethods.includes("Runtime.enable"), "should send Runtime.enable");
    assert.ok(handlers.has("Runtime.consoleAPICalled"), "should register consoleAPICalled handler");

    await capture.stop();
  });

  test("captures log entries with correct types", async () => {
    const { session, emitConsole } = createMockSession();
    const dir = path.join(tmpDir, "types");
    await mkdir(dir, { recursive: true });
    const capture = new CdpConsoleCapture(session, dir);
    await capture.start();

    emitConsole("log", [{ type: "string", value: "hello" }]);
    emitConsole("warning", [{ type: "string", value: "careful" }]);
    emitConsole("error", [{ type: "string", value: "oops" }]);
    emitConsole("info", [{ type: "string", value: "fyi" }]);

    assert.equal(capture.count, 4, "should capture 4 entries");

    await capture.stop();
    const outPath = await capture.save();
    assert.ok(outPath, "save should return a path");

    const data = JSON.parse(await readFile(outPath!, "utf-8"));
    assert.equal(data.length, 4);
    assert.equal(data[0].level, "log");
    assert.equal(data[1].level, "warning");
    assert.equal(data[2].level, "error");
    assert.equal(data[3].level, "info");
  });

  test("serializes args correctly", async () => {
    const { session, emitConsole } = createMockSession();
    const dir = path.join(tmpDir, "args");
    await mkdir(dir, { recursive: true });
    const capture = new CdpConsoleCapture(session, dir);
    await capture.start();

    emitConsole("log", [
      { type: "string", value: "count:" },
      { type: "number", value: 42 },
      { type: "boolean", value: true },
      { type: "object", description: "Object { key: \"val\" }" },
      { type: "undefined" }
    ]);

    await capture.stop();
    const outPath = await capture.save();
    const data = JSON.parse(await readFile(outPath!, "utf-8"));

    assert.equal(data[0].message, "count: 42 true Object { key: \"val\" } undefined");
  });

  test("includes stack trace when present", async () => {
    const { session, emitConsole } = createMockSession();
    const dir = path.join(tmpDir, "stack");
    await mkdir(dir, { recursive: true });
    const capture = new CdpConsoleCapture(session, dir);
    await capture.start();

    emitConsole("error", [{ type: "string", value: "fail" }], {
      stackTrace: {
        callFrames: [
          { functionName: "onClick", url: "https://example.com/app.js", lineNumber: 42, columnNumber: 10 }
        ]
      }
    });

    await capture.stop();
    const outPath = await capture.save();
    const data = JSON.parse(await readFile(outPath!, "utf-8"));

    assert.ok(data[0].stackTrace, "should include stackTrace");
    assert.equal(data[0].stackTrace[0].functionName, "onClick");
    assert.equal(data[0].stackTrace[0].lineNumber, 42);
  });

  test("stop is idempotent", async () => {
    const { session } = createMockSession();
    const capture = new CdpConsoleCapture(session, tmpDir);
    await capture.start();

    await capture.stop();
    await capture.stop(); // should not throw
  });

  test("save returns undefined when no logs captured", async () => {
    const { session } = createMockSession();
    const dir = path.join(tmpDir, "empty");
    await mkdir(dir, { recursive: true });
    const capture = new CdpConsoleCapture(session, dir);
    await capture.start();
    await capture.stop();

    const outPath = await capture.save();
    assert.equal(outPath, undefined, "should return undefined when no logs");
  });

  test("does not capture after stop", async () => {
    const { session, emitConsole } = createMockSession();
    const capture = new CdpConsoleCapture(session, tmpDir);
    await capture.start();

    emitConsole("log", [{ type: "string", value: "before" }]);
    await capture.stop();

    // Handler was unregistered, but just in case:
    assert.equal(capture.count, 1);
  });

  test("cleanup temp dir", async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
});
