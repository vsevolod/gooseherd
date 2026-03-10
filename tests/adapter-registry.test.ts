/**
 * Tests for webhook adapter registry, adapter wrappers, and generic webhook route.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test, beforeEach } from "node:test";

// ── Adapter registry tests ──
// We re-import to get fresh state per describe block where needed

describe("adapter-registry", () => {
  // The registry uses module-level state, so we test idempotent operations

  test("registerAdapter and getAdapter work", async () => {
    const { registerAdapter, getAdapter } = await import("../src/observer/sources/adapter-registry.js");
    const dummy = {
      source: "test_dummy",
      verifySignature: () => true,
      parseEvent: () => null
    };
    registerAdapter(dummy);
    const retrieved = getAdapter("test_dummy");
    assert.ok(retrieved);
    assert.equal(retrieved.source, "test_dummy");
  });

  test("listAdapters returns registered sources", async () => {
    const { registerAdapter, listAdapters } = await import("../src/observer/sources/adapter-registry.js");
    registerAdapter({
      source: "test_list_a",
      verifySignature: () => true,
      parseEvent: () => null
    });
    registerAdapter({
      source: "test_list_b",
      verifySignature: () => true,
      parseEvent: () => null
    });
    const list = listAdapters();
    assert.ok(list.includes("test_list_a"));
    assert.ok(list.includes("test_list_b"));
  });

  test("getAdapter returns undefined for unknown source", async () => {
    const { getAdapter } = await import("../src/observer/sources/adapter-registry.js");
    const result = getAdapter("nonexistent_source_xyz");
    assert.equal(result, undefined);
  });
});

// ── GitHub adapter wrapper tests ──

describe("githubAdapter wrapper", () => {
  test("verifySignature delegates to verifyGitHubSignature", async () => {
    const { githubAdapter } = await import("../src/observer/sources/github-adapter-wrapper.js");

    const secret = "gh-test-secret";
    const body = '{"action":"completed"}';
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    const headers: Record<string, string> = {
      "x-hub-signature-256": sig,
      "x-github-event": "check_suite",
      "x-github-delivery": "abc-123"
    };

    assert.equal(githubAdapter.verifySignature(body, headers, secret), true);
  });

  test("verifySignature rejects invalid signature", async () => {
    const { githubAdapter } = await import("../src/observer/sources/github-adapter-wrapper.js");

    const headers: Record<string, string> = {
      "x-hub-signature-256": "sha256=invalid",
      "x-github-event": "check_suite"
    };

    assert.equal(githubAdapter.verifySignature('{"test":true}', headers, "secret"), false);
  });

  test("parseEvent delegates to parseGitHubWebhook", async () => {
    const { githubAdapter } = await import("../src/observer/sources/github-adapter-wrapper.js");

    const headers: Record<string, string> = {
      "x-github-event": "check_suite",
      "x-github-delivery": "delivery-001"
    };

    const payload = {
      action: "completed",
      check_suite: {
        conclusion: "failure",
        head_branch: "main",
        head_sha: "abc123",
        app: { name: "GitHub Actions" }
      },
      repository: { full_name: "owner/repo" }
    };

    const event = githubAdapter.parseEvent(headers, payload);
    assert.ok(event);
    assert.equal(event.source, "github_webhook");
    assert.ok(event.id.startsWith("gh-check-"));
    assert.equal(event.repoSlug, "owner/repo");
  });

  test("parseEvent returns null for non-actionable events", async () => {
    const { githubAdapter } = await import("../src/observer/sources/github-adapter-wrapper.js");

    const headers: Record<string, string> = {
      "x-github-event": "ping"
    };

    const event = githubAdapter.parseEvent(headers, {});
    assert.equal(event, null);
  });
});

// ── Sentry adapter wrapper tests ──

describe("createSentryAdapter wrapper", () => {
  test("verifySignature delegates to verifySentrySignature", async () => {
    const { createSentryAdapter } = await import("../src/observer/sources/sentry-adapter-wrapper.js");
    const adapter = createSentryAdapter("C_ALERT");

    const secret = "sentry-test-secret";
    const body = '{"action":"triggered"}';
    const sig = createHmac("sha256", secret).update(body).digest("hex");

    const headers: Record<string, string> = {
      "sentry-hook-signature": sig,
      "sentry-hook-resource": "issue",
      "sentry-hook-timestamp": new Date().toISOString()
    };

    assert.equal(adapter.verifySignature(body, headers, secret), true);
  });

  test("verifySignature rejects invalid signature", async () => {
    const { createSentryAdapter } = await import("../src/observer/sources/sentry-adapter-wrapper.js");
    const adapter = createSentryAdapter("C_ALERT");

    const headers: Record<string, string> = {
      "sentry-hook-signature": "badhex"
    };

    assert.equal(adapter.verifySignature('{"test":true}', headers, "secret"), false);
  });

  test("parseEvent delegates to parseSentryWebhook with alertChannelId", async () => {
    const { createSentryAdapter } = await import("../src/observer/sources/sentry-adapter-wrapper.js");
    const adapter = createSentryAdapter("C_MY_CHANNEL");

    const headers: Record<string, string> = {
      "sentry-hook-resource": "issue",
      "sentry-hook-timestamp": new Date().toISOString()
    };

    const payload = {
      action: "triggered",
      data: {
        issue: {
          id: "999",
          title: "Test Error",
          culprit: "app/index.ts",
          level: "error",
          shortId: "PROJ-XYZ",
          url: "https://sentry.io/issues/999/",
          project: { slug: "test-project" },
          metadata: { type: "Error", value: "test" }
        }
      }
    };

    const event = adapter.parseEvent(headers, payload);
    assert.ok(event);
    assert.equal(event.source, "sentry_alert");
    assert.equal(event.notificationTarget.channelId, "C_MY_CHANNEL");
    assert.ok(event.suggestedTask?.includes("Test Error"));
  });

  test("parseEvent returns null for non-actionable events", async () => {
    const { createSentryAdapter } = await import("../src/observer/sources/sentry-adapter-wrapper.js");
    const adapter = createSentryAdapter("C_ALERT");

    const headers: Record<string, string> = {
      "sentry-hook-resource": "event_alert"
    };

    const event = adapter.parseEvent(headers, { action: "triggered" });
    assert.equal(event, null);
  });

  test("adapter source is sentry_alert", async () => {
    const { createSentryAdapter } = await import("../src/observer/sources/sentry-adapter-wrapper.js");
    const adapter = createSentryAdapter("C_ALERT");
    assert.equal(adapter.source, "sentry_alert");
  });
});
