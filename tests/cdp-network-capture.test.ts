/**
 * Tests for CdpNetworkCapture — CDP-based network request capture.
 * TDD: tests written BEFORE implementation.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { CdpNetworkCapture } from "../src/pipeline/quality-gates/cdp-network-capture.js";

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
    emitRequest(requestId: string, url: string, method = "GET", timestamp = Date.now() / 1000) {
      const handler = handlers.get("Network.requestWillBeSent");
      if (!handler) throw new Error("No handler for Network.requestWillBeSent");
      handler({ requestId, request: { url, method, headers: {} }, timestamp, type: "Document" });
    },
    emitResponse(requestId: string, status: number, mimeType = "text/html", timestamp = Date.now() / 1000) {
      const handler = handlers.get("Network.responseReceived");
      if (!handler) throw new Error("No handler for Network.responseReceived");
      handler({ requestId, response: { url: "", status, statusText: status === 200 ? "OK" : "Error", headers: {}, mimeType }, timestamp, type: "Document" });
    },
    emitFinished(requestId: string, encodedDataLength: number, timestamp = Date.now() / 1000) {
      const handler = handlers.get("Network.loadingFinished");
      if (!handler) throw new Error("No handler for Network.loadingFinished");
      handler({ requestId, encodedDataLength, timestamp });
    },
    emitFailed(requestId: string, errorText: string, timestamp = Date.now() / 1000) {
      const handler = handlers.get("Network.loadingFailed");
      if (!handler) throw new Error("No handler for Network.loadingFailed");
      handler({ requestId, errorText, canceled: false, timestamp });
    }
  };
}

describe("CdpNetworkCapture", () => {
  const tmpDir = path.resolve(".work", `test-network-${Date.now()}`);

  test("setup temp dir", async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  test("start() enables Network domain and registers handlers", async () => {
    const { session, sentMethods, handlers } = createMockSession();
    const capture = new CdpNetworkCapture(session, tmpDir);

    await capture.start();

    assert.ok(sentMethods.includes("Network.enable"), "should send Network.enable");
    assert.ok(handlers.has("Network.requestWillBeSent"));
    assert.ok(handlers.has("Network.responseReceived"));
    assert.ok(handlers.has("Network.loadingFinished"));
    assert.ok(handlers.has("Network.loadingFailed"));

    await capture.stop();
  });

  test("pairs request + response + finished by requestId", async () => {
    const { session, emitRequest, emitResponse, emitFinished } = createMockSession();
    const dir = path.join(tmpDir, "pair");
    await mkdir(dir, { recursive: true });
    const capture = new CdpNetworkCapture(session, dir);
    await capture.start();

    const t0 = 1000;
    emitRequest("req1", "https://example.com/api/data", "GET", t0);
    emitResponse("req1", 200, "application/json", t0 + 0.5);
    emitFinished("req1", 1024, t0 + 0.8);

    await capture.stop();
    const outPath = await capture.save();
    assert.ok(outPath);

    const data = JSON.parse(await readFile(outPath!, "utf-8"));
    assert.equal(data.length, 1);

    const entry = data[0];
    assert.equal(entry.url, "https://example.com/api/data");
    assert.equal(entry.method, "GET");
    assert.equal(entry.status, 200);
    assert.equal(entry.mimeType, "application/json");
    assert.equal(entry.encodedDataLength, 1024);
    // Duration should be ~800ms (0.8s difference)
    assert.ok(entry.durationMs >= 0, "should have non-negative duration");
  });

  test("handles failed requests", async () => {
    const { session, emitRequest, emitFailed } = createMockSession();
    const dir = path.join(tmpDir, "failed");
    await mkdir(dir, { recursive: true });
    const capture = new CdpNetworkCapture(session, dir);
    await capture.start();

    const t0 = 1000;
    emitRequest("req1", "https://example.com/broken", "POST", t0);
    emitFailed("req1", "net::ERR_CONNECTION_REFUSED", t0 + 0.2);

    await capture.stop();
    const outPath = await capture.save();
    const data = JSON.parse(await readFile(outPath!, "utf-8"));

    assert.equal(data.length, 1);
    assert.equal(data[0].error, "net::ERR_CONNECTION_REFUSED");
    assert.equal(data[0].status, undefined);
  });

  test("captures multiple requests", async () => {
    const { session, emitRequest, emitResponse, emitFinished } = createMockSession();
    const dir = path.join(tmpDir, "multi");
    await mkdir(dir, { recursive: true });
    const capture = new CdpNetworkCapture(session, dir);
    await capture.start();

    const t0 = 1000;
    emitRequest("r1", "https://example.com/page", "GET", t0);
    emitRequest("r2", "https://example.com/style.css", "GET", t0 + 0.1);
    emitRequest("r3", "https://example.com/app.js", "GET", t0 + 0.2);

    emitResponse("r1", 200, "text/html", t0 + 0.3);
    emitResponse("r2", 200, "text/css", t0 + 0.4);
    emitResponse("r3", 200, "application/javascript", t0 + 0.5);

    emitFinished("r1", 5000, t0 + 0.6);
    emitFinished("r2", 2000, t0 + 0.7);
    emitFinished("r3", 8000, t0 + 0.8);

    assert.equal(capture.count, 3);

    await capture.stop();
    const outPath = await capture.save();
    const data = JSON.parse(await readFile(outPath!, "utf-8"));
    assert.equal(data.length, 3);
  });

  test("calculates duration correctly", async () => {
    const { session, emitRequest, emitResponse, emitFinished } = createMockSession();
    const dir = path.join(tmpDir, "duration");
    await mkdir(dir, { recursive: true });
    const capture = new CdpNetworkCapture(session, dir);
    await capture.start();

    // 500ms request
    emitRequest("r1", "https://example.com/slow", "GET", 100.0);
    emitResponse("r1", 200, "text/html", 100.3);
    emitFinished("r1", 1024, 100.5);

    await capture.stop();
    const outPath = await capture.save();
    const data = JSON.parse(await readFile(outPath!, "utf-8"));

    // Duration from requestWillBeSent to loadingFinished: 0.5s = 500ms
    assert.equal(data[0].durationMs, 500);
  });

  test("stop is idempotent", async () => {
    const { session } = createMockSession();
    const capture = new CdpNetworkCapture(session, tmpDir);
    await capture.start();

    await capture.stop();
    await capture.stop(); // should not throw
  });

  test("save returns undefined when no requests captured", async () => {
    const { session } = createMockSession();
    const dir = path.join(tmpDir, "none");
    await mkdir(dir, { recursive: true });
    const capture = new CdpNetworkCapture(session, dir);
    await capture.start();
    await capture.stop();

    const outPath = await capture.save();
    assert.equal(outPath, undefined);
  });

  test("handles redirect chains", async () => {
    const { session, handlers, emitResponse, emitFinished } = createMockSession();
    const dir = path.join(tmpDir, "redirect");
    await mkdir(dir, { recursive: true });
    const capture = new CdpNetworkCapture(session, dir);
    await capture.start();

    const t0 = 1000;
    // First request: http://example.com → 301 redirect
    const requestHandler = handlers.get("Network.requestWillBeSent")!;
    requestHandler({
      requestId: "r1",
      request: { url: "http://example.com/", method: "GET", headers: {} },
      timestamp: t0,
      type: "Document"
    });

    // Redirect fires requestWillBeSent again with same requestId + redirectResponse
    requestHandler({
      requestId: "r1",
      request: { url: "https://example.com/", method: "GET", headers: {} },
      timestamp: t0 + 0.1,
      type: "Document",
      redirectResponse: { status: 301, statusText: "Moved Permanently", mimeType: "text/html" }
    });

    // Final response for the redirected request
    emitResponse("r1", 200, "text/html", t0 + 0.5);
    emitFinished("r1", 2048, t0 + 0.8);

    assert.equal(capture.count, 2, "should count both the redirect hop and the final request");

    await capture.stop();
    const outPath = await capture.save();
    const data = JSON.parse(await readFile(outPath!, "utf-8"));

    assert.equal(data.length, 2);
    // First entry: the redirect hop
    assert.equal(data[0].url, "http://example.com/");
    assert.equal(data[0].status, 301);
    // Second entry: the final request
    assert.equal(data[1].url, "https://example.com/");
    assert.equal(data[1].status, 200);
    assert.equal(data[1].encodedDataLength, 2048);
  });

  test("handles request without response (pending at stop)", async () => {
    const { session, emitRequest } = createMockSession();
    const dir = path.join(tmpDir, "pending");
    await mkdir(dir, { recursive: true });
    const capture = new CdpNetworkCapture(session, dir);
    await capture.start();

    emitRequest("r1", "https://example.com/pending", "GET", 1000);
    // No response or finish — request was still in-flight when we stopped

    await capture.stop();
    const outPath = await capture.save();
    const data = JSON.parse(await readFile(outPath!, "utf-8"));

    assert.equal(data.length, 1);
    assert.equal(data[0].url, "https://example.com/pending");
    assert.equal(data[0].status, undefined, "pending request should have no status");
  });

  test("cleanup temp dir", async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
});
