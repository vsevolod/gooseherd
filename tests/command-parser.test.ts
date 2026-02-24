import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../src/command-parser.js";

// ── Help ─────────────────────────────────────────────

test("empty input returns help", () => {
  assert.equal(parseCommand("").type, "help");
});

test("'help' returns help", () => {
  assert.equal(parseCommand("help").type, "help");
});

test("mention prefix is stripped", () => {
  assert.equal(parseCommand("<@U123ABC> help").type, "help");
});

// ── Status / Tail ────────────────────────────────────

test("'status' returns status without runId", () => {
  const cmd = parseCommand("status");
  assert.equal(cmd.type, "status");
  if (cmd.type === "status") assert.equal(cmd.runId, undefined);
});

test("'status abc123' returns status with runId", () => {
  const cmd = parseCommand("status abc123");
  assert.equal(cmd.type, "status");
  if (cmd.type === "status") assert.equal(cmd.runId, "abc123");
});

test("'tail' returns tail without runId", () => {
  const cmd = parseCommand("tail");
  assert.equal(cmd.type, "tail");
  if (cmd.type === "tail") assert.equal(cmd.runId, undefined);
});

test("'tail abc123' returns tail with runId", () => {
  const cmd = parseCommand("tail abc123");
  assert.equal(cmd.type, "tail");
  if (cmd.type === "tail") assert.equal(cmd.runId, "abc123");
});

// ── Explicit "run" format with pipe ──────────────────

test("'run owner/repo | task' parses correctly", () => {
  const cmd = parseCommand("run epiccoders/pxls | Fix the bug");
  assert.equal(cmd.type, "run");
  if (cmd.type === "run") {
    assert.equal(cmd.payload.repoSlug, "epiccoders/pxls");
    assert.equal(cmd.payload.task, "Fix the bug");
    assert.equal(cmd.payload.baseBranch, undefined);
  }
});

test("'run owner/repo@branch | task' parses base branch", () => {
  const cmd = parseCommand("run epiccoders/pxls@master | Fix the bug");
  assert.equal(cmd.type, "run");
  if (cmd.type === "run") {
    assert.equal(cmd.payload.repoSlug, "epiccoders/pxls");
    assert.equal(cmd.payload.task, "Fix the bug");
    assert.equal(cmd.payload.baseBranch, "master");
  }
});

test("'run' with mention prefix works", () => {
  const cmd = parseCommand("<@U0BOT> run epiccoders/pxls | Fix the bug");
  assert.equal(cmd.type, "run");
  if (cmd.type === "run") {
    assert.equal(cmd.payload.repoSlug, "epiccoders/pxls");
    assert.equal(cmd.payload.task, "Fix the bug");
  }
});

test("'run' without pipe returns invalid", () => {
  const cmd = parseCommand("run epiccoders/pxls Fix the bug");
  // With the new parser, "run" prefix + no pipe falls through to natural format
  assert.equal(cmd.type, "run");
  if (cmd.type === "run") {
    assert.equal(cmd.payload.repoSlug, "epiccoders/pxls");
    assert.equal(cmd.payload.task, "Fix the bug");
  }
});

test("'run' with empty task after pipe returns invalid", () => {
  const cmd = parseCommand("run epiccoders/pxls |");
  assert.equal(cmd.type, "invalid");
});

// ── Natural format (no "run" prefix, no pipe) ────────

test("natural format: 'owner/repo task text' works", () => {
  const cmd = parseCommand("epiccoders/pxls Add a subtle hover animation to the CTA buttons");
  assert.equal(cmd.type, "run");
  if (cmd.type === "run") {
    assert.equal(cmd.payload.repoSlug, "epiccoders/pxls");
    assert.equal(cmd.payload.task, "Add a subtle hover animation to the CTA buttons");
    assert.equal(cmd.payload.baseBranch, undefined);
  }
});

test("natural format with mention prefix works", () => {
  const cmd = parseCommand("<@U0BOT> epiccoders/pxls Fix broken footer link");
  assert.equal(cmd.type, "run");
  if (cmd.type === "run") {
    assert.equal(cmd.payload.repoSlug, "epiccoders/pxls");
    assert.equal(cmd.payload.task, "Fix broken footer link");
  }
});

test("natural format with @branch works", () => {
  const cmd = parseCommand("epiccoders/pxls@develop Fix the login page");
  assert.equal(cmd.type, "run");
  if (cmd.type === "run") {
    assert.equal(cmd.payload.repoSlug, "epiccoders/pxls");
    assert.equal(cmd.payload.task, "Fix the login page");
    assert.equal(cmd.payload.baseBranch, "develop");
  }
});

test("natural format: repo slug alone without task returns invalid", () => {
  // "epiccoders/pxls" has no space after it so LEADING_REPO_REGEX won't match
  const cmd = parseCommand("epiccoders/pxls");
  assert.equal(cmd.type, "invalid");
});

// ── Natural format with pipe also works ──────────────

test("natural format with pipe: 'owner/repo | task' works", () => {
  const cmd = parseCommand("epiccoders/pxls | Add hover animation");
  assert.equal(cmd.type, "run");
  if (cmd.type === "run") {
    assert.equal(cmd.payload.repoSlug, "epiccoders/pxls");
    assert.equal(cmd.payload.task, "Add hover animation");
  }
});

// ── Invalid / unrecognized ───────────────────────────

test("random text returns invalid", () => {
  const cmd = parseCommand("hello world");
  assert.equal(cmd.type, "invalid");
});

test("empty after mention returns help", () => {
  const cmd = parseCommand("<@U0BOT>");
  assert.equal(cmd.type, "help");
});
