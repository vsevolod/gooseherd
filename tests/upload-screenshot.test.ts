import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { uploadScreenshotNode } from "../src/pipeline/nodes/upload-screenshot.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";

function makeNodeConfig(): NodeConfig {
  return { id: "upload_screenshot", type: "deterministic", action: "upload_screenshot" };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `run-${Date.now()}`,
    status: "running",
    phase: "pushing",
    repoSlug: "org/repo",
    task: "Test task",
    baseBranch: "main",
    branchName: "gooseherd/test-branch",
    requestedBy: "U_TEST",
    channelId: "C_TEST",
    threadTs: "0000.0000",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeDeps(overrides: Partial<NodeDeps> & { configOverrides?: Partial<AppConfig> } = {}): NodeDeps {
  const { configOverrides, ...depsOverrides } = overrides;
  return {
    config: {
      appName: "Gooseherd",
      appSlug: "gooseherd",
      ...configOverrides
    } as AppConfig,
    run: makeRun(),
    logFile: "/dev/null",
    workRoot: "/tmp",
    onPhase: async () => {},
    ...depsOverrides
  };
}

describe("uploadScreenshotNode", () => {
  test("skips when no screenshot path in context", async () => {
    const ctx = new ContextBag({});
    ctx.set("prNumber", 42);
    const deps = makeDeps({ githubService: {} as any });
    const result = await uploadScreenshotNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when no PR number in context", async () => {
    const ctx = new ContextBag({});
    ctx.set("screenshotPath", "/tmp/screenshot.png");
    const deps = makeDeps({ githubService: {} as any });
    const result = await uploadScreenshotNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when no GitHub service available", async () => {
    const ctx = new ContextBag({});
    ctx.set("screenshotPath", "/tmp/screenshot.png");
    ctx.set("prNumber", 42);
    const deps = makeDeps();
    const result = await uploadScreenshotNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when screenshot file does not exist", async () => {
    const ctx = new ContextBag({});
    ctx.set("screenshotPath", "/tmp/nonexistent-screenshot-12345.png");
    ctx.set("prNumber", 42);
    const deps = makeDeps({ githubService: {} as any });
    const result = await uploadScreenshotNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("uploads screenshot and updates PR body on success", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "screenshot-test-"));
    const screenshotFile = path.join(tmpDir, "screenshot.png");
    // Write a tiny valid PNG (1x1 pixel)
    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    await writeFile(screenshotFile, pngData);

    let uploadedParams: any = null;
    let updatedPrBody: any = null;

    const mockGithub = {
      uploadFileToRepo: async (params: any) => {
        uploadedParams = params;
        return {
          url: `https://github.com/org/repo/raw/gooseherd/test-branch/.gooseherd/screenshots/run-123.png`,
          commitSha: "abc123def456"
        };
      },
      updatePullRequestBody: async (params: any) => {
        updatedPrBody = params;
      }
    };

    const run = makeRun({ id: "run-123" });
    const ctx = new ContextBag({});
    ctx.set("screenshotPath", screenshotFile);
    ctx.set("prNumber", 42);
    const deps = makeDeps({ githubService: mockGithub as any, run });

    const result = await uploadScreenshotNode(makeNodeConfig(), ctx, deps);

    assert.equal(result.outcome, "success");
    assert.ok(uploadedParams, "Should have called uploadFileToRepo");
    assert.equal(uploadedParams.repoSlug, "org/repo");
    assert.equal(uploadedParams.branch, "gooseherd/test-branch");
    assert.ok(uploadedParams.filePath.includes("run-123.png"));
    assert.equal(uploadedParams.localPath, screenshotFile);

    assert.ok(updatedPrBody, "Should have called updatePullRequestBody");
    assert.equal(updatedPrBody.prNumber, 42);
    assert.ok(updatedPrBody.body.includes("## Visual Evidence"));
    assert.ok(updatedPrBody.body.includes("![Screenshot]"));

    // Verify screenshot URL is stored in context
    assert.ok(ctx.get("screenshotUrl")?.includes("github.com"));

    await rm(tmpDir, { recursive: true });
  });

  test("returns soft_fail on upload error", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "screenshot-test-"));
    const screenshotFile = path.join(tmpDir, "screenshot.png");
    await writeFile(screenshotFile, Buffer.from("fake-png"));

    const mockGithub = {
      uploadFileToRepo: async () => {
        throw new Error("API rate limit exceeded");
      }
    };

    const ctx = new ContextBag({});
    ctx.set("screenshotPath", screenshotFile);
    ctx.set("prNumber", 42);
    const deps = makeDeps({ githubService: mockGithub as any });

    const result = await uploadScreenshotNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "soft_fail");
    assert.ok(result.error?.includes("rate limit"));

    await rm(tmpDir, { recursive: true });
  });
});
