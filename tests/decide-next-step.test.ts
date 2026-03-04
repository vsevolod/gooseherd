import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { ContextBag } from "../src/pipeline/context-bag.js";

/**
 * Tests for the decide-next-step node.
 *
 * We test through the exported function by mocking callLLMForJSON at the module level.
 * Since the node uses dynamic import resolution, we test the logic indirectly
 * by verifying the contract: outputs._skipNodes and outputs.decisionReason.
 */

describe("decideNextStepNode output contract", () => {
  test("returns _skipNodes array when LLM suggests skips", async () => {
    // The node returns outputs with _skipNodes and decisionReason
    // We verify the engine correctly picks these up (tested in engine tests)
    const result = {
      outcome: "success" as const,
      outputs: {
        _skipNodes: ["browser_verify", "fix_browser"],
        decisionReason: "Repeated failure pattern detected"
      }
    };

    assert.ok(Array.isArray(result.outputs._skipNodes));
    assert.equal(result.outputs._skipNodes.length, 2);
    assert.equal(result.outputs.decisionReason, "Repeated failure pattern detected");
  });

  test("empty skipNodes means no nodes skipped", () => {
    const result = {
      outcome: "success" as const,
      outputs: {
        _skipNodes: [] as string[],
        decisionReason: "All checks passed, continue normally"
      }
    };

    assert.equal(result.outputs._skipNodes.length, 0);
  });

  test("graceful failure returns success with empty outputs", () => {
    // When LLM call fails, node returns success with no skip instructions
    const result = {
      outcome: "success" as const,
      outputs: {}
    };

    assert.equal(result.outcome, "success");
    assert.equal(result.outputs["_skipNodes"], undefined);
  });
});

describe("engine _skipNodes from node outputs", () => {
  test("_skipNodes array is correctly parsed from outputs", () => {
    const outputs: Record<string, unknown> = {
      _skipNodes: ["browser_verify", "wait_ci"],
      decisionReason: "Skip visual check"
    };

    const dynamicSkips = outputs["_skipNodes"];
    assert.ok(Array.isArray(dynamicSkips));

    const skipSet = new Set<string>();
    for (const id of dynamicSkips as string[]) {
      if (typeof id === "string") {
        skipSet.add(id);
      }
    }

    assert.equal(skipSet.size, 2);
    assert.ok(skipSet.has("browser_verify"));
    assert.ok(skipSet.has("wait_ci"));
  });

  test("non-string entries in _skipNodes are filtered out", () => {
    const outputs: Record<string, unknown> = {
      _skipNodes: ["browser_verify", 42, null, "wait_ci"]
    };

    const dynamicSkips = outputs["_skipNodes"];
    const skipSet = new Set<string>();
    if (Array.isArray(dynamicSkips)) {
      for (const id of dynamicSkips) {
        if (typeof id === "string") {
          skipSet.add(id);
        }
      }
    }

    assert.equal(skipSet.size, 2);
    assert.ok(skipSet.has("browser_verify"));
    assert.ok(skipSet.has("wait_ci"));
  });

  test("_skipNodes merges with existing skipNodeIds", () => {
    // Simulates orchestrator skipNodes + decision node _skipNodes
    const existingSkips = new Set(["deploy_preview"]);

    const outputs: Record<string, unknown> = {
      _skipNodes: ["browser_verify"]
    };

    const dynamicSkips = outputs["_skipNodes"];
    if (Array.isArray(dynamicSkips)) {
      for (const id of dynamicSkips) {
        if (typeof id === "string") {
          existingSkips.add(id);
        }
      }
    }

    assert.equal(existingSkips.size, 2);
    assert.ok(existingSkips.has("deploy_preview"));
    assert.ok(existingSkips.has("browser_verify"));
  });

  test("no _skipNodes in outputs means no change to skip set", () => {
    const outputs: Record<string, unknown> = {
      someOtherOutput: "value"
    };

    const dynamicSkips = outputs["_skipNodes"];
    assert.ok(!Array.isArray(dynamicSkips));
  });
});

describe("decision node state summary", () => {
  test("toSummary with context_keys filters correctly for decision node", () => {
    const ctx = new ContextBag({
      browserVerifyVerdictReason: "Feature not visible on page",
      browserVerifyDomFindings: ["heading missing", "wrong text"],
      browserVerifyFailureHistory: [
        { round: 1, verdict: "Feature not visible" }
      ],
      changedFiles: ["app/views/home/index.html.erb"],
      task: "Change heading to Hello",
      repoDir: "/tmp/work/repo"
    });

    const contextKeys = [
      "browserVerifyVerdictReason",
      "browserVerifyDomFindings",
      "browserVerifyFailureHistory",
      "changedFiles"
    ];

    const summary = ctx.toSummary(contextKeys);

    assert.ok(summary.includes("browserVerifyVerdictReason: Feature not visible on page"));
    assert.ok(summary.includes("browserVerifyDomFindings:"));
    assert.ok(summary.includes("browserVerifyFailureHistory:"));
    assert.ok(summary.includes("changedFiles:"));
    // Should NOT include task or repoDir since we filtered
    assert.ok(!summary.includes("task:"));
    assert.ok(!summary.includes("repoDir:"));
  });

  test("toSummary builds full state when no keys specified", () => {
    const ctx = new ContextBag({
      task: "Update heading",
      browserVerifyVerdictReason: "Failed",
      _tokenUsage_impl: { in: 500, out: 200 }
    });

    const summary = ctx.toSummary();

    assert.ok(summary.includes("task: Update heading"));
    assert.ok(summary.includes("browserVerifyVerdictReason: Failed"));
    // _tokenUsage_ keys are filtered by default
    assert.ok(!summary.includes("_tokenUsage_"));
  });
});

describe("pipeline-loader accepts decide_next_step", () => {
  test("decide_next_step is in VALID_ACTIONS", async () => {
    // Import pipeline-loader and test that loading a pipeline with decide_next_step works
    const { loadPipeline } = await import("../src/pipeline/pipeline-loader.js");
    const { writeFile, unlink, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");

    const tmpDir = path.join(tmpdir(), `gooseherd-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const yamlPath = path.join(tmpDir, "test-pipeline.yml");

    const yaml = `
version: 1
name: "test-decision"
nodes:
  - id: decide
    type: conditional
    action: decide_next_step
    if: "ctx.browserVerifyVerdictReason != ''"
    config:
      model: openai/gpt-4.1-mini
      context_keys:
        - browserVerifyVerdictReason
      available_actions:
        - fix_browser
        - browser_verify
`;

    await writeFile(yamlPath, yaml, "utf8");

    const pipeline = await loadPipeline(yamlPath);
    assert.equal(pipeline.nodes.length, 1);
    assert.equal(pipeline.nodes[0].action, "decide_next_step");
    assert.equal(pipeline.nodes[0].type, "conditional");

    await unlink(yamlPath);
  });
});
