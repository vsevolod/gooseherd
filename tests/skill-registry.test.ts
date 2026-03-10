/**
 * Tests for the skill registry and run_skill pipeline node.
 */

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkills, getSkill, listSkills, clearSkills } from "../src/pipeline/skill-registry.js";
import { runSkillNode } from "../src/pipeline/nodes/run-skill.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";

// ── Helpers ──

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `test-${Date.now()}`,
    status: "running",
    phase: "agent",
    repoSlug: "org/repo",
    task: "Test task",
    baseBranch: "main",
    branchName: "gooseherd/test",
    requestedBy: "U_TEST",
    channelId: "C_TEST",
    threadTs: "0000.0000",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<NodeDeps> = {}): NodeDeps {
  return {
    config: {
      agentTimeoutSeconds: 60,
    } as AppConfig,
    run: makeRun(),
    logFile: "/dev/null",
    workRoot: "/tmp",
    onPhase: async () => {},
    ...overrides,
  };
}

function makeNodeConfig(config?: Record<string, unknown>): NodeConfig {
  return { id: "test_run_skill", type: "deterministic", action: "run_skill", config };
}

// ═══════════════════════════════════════════════════════
// Skill Registry
// ═══════════════════════════════════════════════════════

describe("loadSkills", () => {
  beforeEach(() => {
    clearSkills();
  });

  test("loads YAML files from directory", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skills-load-"));

    await writeFile(
      path.join(tmpDir, "lint.yml"),
      "name: lint\ndescription: Run linting\ncommand: npm run lint\ntimeout_seconds: 60\n",
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "format.yml"),
      "name: format\ndescription: Format code\ninstruction: Format all files\n",
      "utf8"
    );

    await loadSkills(tmpDir);

    const all = listSkills();
    assert.equal(all.length, 2);

    const lint = getSkill("lint");
    assert.ok(lint);
    assert.equal(lint.name, "lint");
    assert.equal(lint.description, "Run linting");
    assert.equal(lint.command, "npm run lint");
    assert.equal(lint.timeout_seconds, 60);

    const format = getSkill("format");
    assert.ok(format);
    assert.equal(format.name, "format");
    assert.equal(format.instruction, "Format all files");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("handles missing directory gracefully", async () => {
    const nonexistentDir = path.join(os.tmpdir(), `skills-missing-${Date.now()}`);

    // Should not throw
    await loadSkills(nonexistentDir);

    const all = listSkills();
    assert.equal(all.length, 0);
  });

  test("skips files without name field", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skills-noname-"));

    await writeFile(
      path.join(tmpDir, "valid.yml"),
      "name: valid\ndescription: Valid skill\ncommand: echo ok\n",
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "invalid.yml"),
      "description: Missing name field\ncommand: echo oops\n",
      "utf8"
    );

    await loadSkills(tmpDir);

    const all = listSkills();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, "valid");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("handles .yaml extension", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skills-yaml-"));

    await writeFile(
      path.join(tmpDir, "test.yaml"),
      "name: yaml-skill\ndescription: YAML extension\ncommand: echo yaml\n",
      "utf8"
    );

    await loadSkills(tmpDir);

    const skill = getSkill("yaml-skill");
    assert.ok(skill);
    assert.equal(skill.command, "echo yaml");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("ignores non-YAML files", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skills-nonyml-"));

    await writeFile(
      path.join(tmpDir, "readme.md"),
      "# Not a skill",
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "skill.yml"),
      "name: real\ndescription: Real skill\ncommand: echo real\n",
      "utf8"
    );

    await loadSkills(tmpDir);

    const all = listSkills();
    assert.equal(all.length, 1);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("getSkill", () => {
  beforeEach(() => {
    clearSkills();
  });

  test("returns undefined for unknown skill", () => {
    const result = getSkill("nonexistent");
    assert.equal(result, undefined);
  });
});

// ═══════════════════════════════════════════════════════
// Run-Skill Node
// ═══════════════════════════════════════════════════════

describe("runSkillNode", () => {
  beforeEach(() => {
    clearSkills();
  });

  test("returns failure when skill name is missing", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps();
    const result = await runSkillNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("requires config.skill"));
  });

  test("returns failure when skill name is empty string", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps();
    const result = await runSkillNode(makeNodeConfig({ skill: "  " }), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("requires config.skill"));
  });

  test("returns failure when skill is not found", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps();
    const result = await runSkillNode(makeNodeConfig({ skill: "unknown-skill" }), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("not found in registry"));
  });

  test("delegates to run node for command-based skill", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-cmd-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    // Load a command-based skill
    const skillsDir = path.join(tmpDir, "skills");
    await mkdir(skillsDir);
    await writeFile(
      path.join(skillsDir, "echo-skill.yml"),
      "name: echo-test\ndescription: Echo test\ncommand: echo hello\ntimeout_seconds: 10\n",
      "utf8"
    );
    await loadSkills(skillsDir);

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({ logFile });
    const result = await runSkillNode(makeNodeConfig({ skill: "echo-test" }), ctx, deps);

    assert.equal(result.outcome, "success");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns failure for skill with neither command nor instruction", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "skill-empty-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const skillsDir = path.join(tmpDir, "skills");
    await mkdir(skillsDir);
    await writeFile(
      path.join(skillsDir, "empty.yml"),
      "name: empty-skill\ndescription: No command or instruction\n",
      "utf8"
    );
    await loadSkills(skillsDir);

    const ctx = new ContextBag();
    const deps = makeDeps({ logFile });
    const result = await runSkillNode(makeNodeConfig({ skill: "empty-skill" }), ctx, deps);

    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("neither command nor instruction"));

    await rm(tmpDir, { recursive: true, force: true });
  });
});
