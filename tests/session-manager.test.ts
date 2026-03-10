/**
 * Session Manager tests — creation, planning, step execution, run completion,
 * failure evaluation, safety limits, pause/resume, and query methods.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SessionManager,
  type PlanGoalFn,
  type EvaluateProgressFn,
  type PlanOutput,
  type EvaluateOutput,
  type SessionRecord,
} from "../src/sessions/session-manager.js";
import type { RunEnqueuer } from "../src/observer/run-enqueuer.js";
import type { RunRecord, NewRunInput } from "../src/types.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

// ── Test helpers ──

function makeMockRunEnqueuer(): RunEnqueuer & { enqueuedRuns: NewRunInput[]; terminalCallbacks: Array<(runId: string, status: string) => void> } {
  const enqueuedRuns: NewRunInput[] = [];
  const terminalCallbacks: Array<(runId: string, status: string) => void> = [];
  let runCounter = 0;

  return {
    enqueuedRuns,
    terminalCallbacks,
    async enqueueRun(input: NewRunInput): Promise<RunRecord> {
      enqueuedRuns.push(input);
      runCounter++;
      return {
        id: `run-${String(runCounter)}`,
        status: "queued",
        repoSlug: input.repoSlug,
        task: input.task,
        baseBranch: input.baseBranch,
        branchName: `branch-${String(runCounter)}`,
        requestedBy: input.requestedBy,
        channelId: input.channelId,
        threadTs: input.threadTs,
        createdAt: new Date().toISOString(),
      };
    },
    onRunTerminal(cb: (runId: string, status: string) => void): void {
      terminalCallbacks.push(cb);
    },
  };
}

function makeMockPlanGoal(output?: Partial<PlanOutput>): PlanGoalFn {
  return async (_goal, _repo, _branch) => ({
    steps: [
      { description: "Set up project structure", task: "Create the directory layout and config files" },
      { description: "Implement core logic", task: "Write the main business logic module" },
      { description: "Add tests", task: "Write unit tests for the core logic" },
    ],
    reasoning: "Standard implementation approach",
    ...output,
  });
}

function makeMockEvaluateProgress(output?: Partial<EvaluateOutput>): EvaluateProgressFn {
  return async (_session) => ({
    next_action: "continue" as const,
    step_result: "Step completed successfully",
    updated_context: {},
    reason: "Proceeding to next step",
    ...output,
  });
}

interface TestContext {
  manager: SessionManager;
  testDb: TestDb;
  enqueuer: ReturnType<typeof makeMockRunEnqueuer>;
}

async function setup(opts?: {
  planGoal?: PlanGoalFn;
  evaluateProgress?: EvaluateProgressFn;
}): Promise<TestContext> {
  const testDb = await createTestDb();
  const enqueuer = makeMockRunEnqueuer();
  const manager = new SessionManager(
    testDb.db,
    enqueuer,
    opts?.planGoal ?? makeMockPlanGoal(),
    opts?.evaluateProgress ?? makeMockEvaluateProgress()
  );
  await manager.load();

  return { manager, testDb, enqueuer };
}

const SESSION_OPTS = {
  goal: "Build a user authentication system",
  repoSlug: "org/repo",
  baseBranch: "main",
  requestedBy: "U12345",
  channelId: "C12345",
  threadTs: "1234567890.123456",
};

// ── Tests ──

describe("SessionManager", { concurrency: 1 }, () => {

  test("createSession stores and returns a session record", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);

    assert.ok(session.id);
    assert.equal(session.goal, SESSION_OPTS.goal);
    assert.equal(session.repoSlug, SESSION_OPTS.repoSlug);
    assert.equal(session.baseBranch, SESSION_OPTS.baseBranch);
    assert.equal(session.status, "planning");
    assert.equal(session.plan.length, 0);
    assert.equal(session.maxRuns, 10);
    assert.equal(session.completedRuns, 0);
    assert.equal(session.requestedBy, SESSION_OPTS.requestedBy);
    assert.equal(session.channelId, SESSION_OPTS.channelId);
    assert.equal(session.threadTs, SESSION_OPTS.threadTs);
    assert.ok(session.createdAt);
    assert.ok(session.updatedAt);
  });

  test("createSession uses default maxRuns of 10", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    assert.equal(session.maxRuns, 10);
  });

  test("createSession accepts custom maxRuns", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession({ ...SESSION_OPTS, maxRuns: 5 });
    assert.equal(session.maxRuns, 5);
  });

  test("planSession calls planner and creates plan steps", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    const planned = await manager.planSession(session.id);

    assert.equal(planned.status, "running");
    assert.equal(planned.plan.length, 3);
    assert.equal(planned.plan[0]!.description, "Set up project structure");
    assert.equal(planned.plan[0]!.status, "pending");
    assert.equal(planned.plan[1]!.description, "Implement core logic");
    assert.equal(planned.plan[2]!.description, "Add tests");
    assert.ok(planned.context["planReasoning"]);
    assert.ok(Array.isArray(planned.context["stepTasks"]));
  });

  test("planSession throws for unknown session", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await assert.rejects(
      () => manager.planSession("00000000-0000-0000-0000-000000000000"),
      (err: Error) => {
        assert.match(err.message, /Session not found/);
        return true;
      }
    );
  });

  test("planSession throws when no planner configured", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const enqueuer = makeMockRunEnqueuer();
    const manager = new SessionManager(testDb.db, enqueuer);
    await manager.load();

    const session = await manager.createSession(SESSION_OPTS);

    await assert.rejects(
      () => manager.planSession(session.id),
      (err: Error) => {
        assert.match(err.message, /No planner configured/);
        return true;
      }
    );
  });

  test("executeNextStep creates a pipeline run and marks step running", async (t) => {
    const { manager, testDb, enqueuer } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    const updated = await manager.executeNextStep(session.id);

    assert.equal(updated.status, "waiting");
    assert.equal(updated.completedRuns, 1);
    assert.equal(updated.plan[0]!.status, "running");
    assert.equal(updated.plan[0]!.runId, "run-1");
    assert.ok(updated.plan[0]!.startedAt);

    // Verify the enqueued run has the right task
    assert.equal(enqueuer.enqueuedRuns.length, 1);
    assert.equal(enqueuer.enqueuedRuns[0]!.task, "Create the directory layout and config files");
    assert.equal(enqueuer.enqueuedRuns[0]!.repoSlug, SESSION_OPTS.repoSlug);
  });

  test("executeNextStep throws for unknown session", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await assert.rejects(
      () => manager.executeNextStep("00000000-0000-0000-0000-000000000000"),
      (err: Error) => {
        assert.match(err.message, /Session not found/);
        return true;
      }
    );
  });

  test("onRunCompleted marks step completed and auto-advances", async (t) => {
    const { manager, testDb, enqueuer } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    // Simulate run completion
    await manager.onRunCompleted("run-1", "completed");

    const updated = (await manager.getSession(session.id))!;
    assert.equal(updated.plan[0]!.status, "completed");
    assert.equal(updated.plan[0]!.result, "completed");
    assert.ok(updated.plan[0]!.completedAt);

    // Should have auto-advanced to step 2
    assert.equal(updated.plan[1]!.status, "running");
    assert.equal(updated.plan[1]!.runId, "run-2");
    assert.equal(updated.completedRuns, 2);

    // Verify second run was enqueued with correct task
    assert.equal(enqueuer.enqueuedRuns.length, 2);
    assert.equal(enqueuer.enqueuedRuns[1]!.task, "Write the main business logic module");
  });

  test("onRunCompleted ignores runs not belonging to any session", async (t) => {
    const { manager, testDb, enqueuer } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    // Should not throw
    await manager.onRunCompleted("unknown-run-id", "completed");
    assert.equal(enqueuer.enqueuedRuns.length, 0);
  });

  test("onRunCompleted with failure evaluates whether to continue", async (t) => {
    const evaluateCalls: SessionRecord[] = [];
    const { manager, testDb } = await setup({
      evaluateProgress: async (session) => {
        evaluateCalls.push({ ...session });
        return {
          next_action: "continue" as const,
          step_result: "Failed but recoverable",
          updated_context: { retryHint: "try different approach" },
          reason: "Non-critical failure",
        };
      },
    });
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    await manager.onRunCompleted("run-1", "failed");

    assert.equal(evaluateCalls.length, 1);
    const updated = (await manager.getSession(session.id))!;
    assert.equal(updated.plan[0]!.status, "failed");
    assert.equal(updated.context["retryHint"], "try different approach");
    // Should have advanced to next step
    assert.equal(updated.plan[1]!.status, "running");
  });

  test("onRunCompleted with failure and eval=fail aborts session", async (t) => {
    const { manager, testDb } = await setup({
      evaluateProgress: async () => ({
        next_action: "fail" as const,
        step_result: "Critical failure",
        updated_context: {},
        reason: "Cannot recover from this error",
      }),
    });
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    await manager.onRunCompleted("run-1", "failed");

    const updated = (await manager.getSession(session.id))!;
    assert.equal(updated.status, "failed");
    assert.equal(updated.error, "Cannot recover from this error");
  });

  test("onRunCompleted with failure and eval=done completes session", async (t) => {
    const { manager, testDb } = await setup({
      evaluateProgress: async () => ({
        next_action: "done" as const,
        step_result: "Goal actually already achieved",
        updated_context: {},
        reason: "Previous steps already accomplished the goal",
      }),
    });
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    await manager.onRunCompleted("run-1", "failed");

    const updated = (await manager.getSession(session.id))!;
    assert.equal(updated.status, "completed");
    assert.ok(updated.completedAt);
  });

  test("session respects maxRuns limit", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession({ ...SESSION_OPTS, maxRuns: 1 });
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    // completedRuns is now 1, which equals maxRuns
    // Simulate completion and auto-advance
    await manager.onRunCompleted("run-1", "completed");

    const updated = (await manager.getSession(session.id))!;
    // executeNextStep should have hit the limit
    assert.equal(updated.status, "failed");
    assert.ok(updated.error?.includes("Max runs limit"));
  });

  test("session with all steps completed sets status to completed", async (t) => {
    const { manager, testDb } = await setup({
      planGoal: async () => ({
        steps: [
          { description: "Only step", task: "Do the thing" },
        ],
        reasoning: "Simple task",
      }),
    });
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    // Complete the only step
    await manager.onRunCompleted("run-1", "completed");

    const updated = (await manager.getSession(session.id))!;
    assert.equal(updated.status, "completed");
    assert.ok(updated.completedAt);
  });

  test("pauseSession and resumeSession work correctly", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);

    // Pause
    const paused = await manager.pauseSession(session.id);
    assert.equal(paused, true);
    assert.equal((await manager.getSession(session.id))!.status, "paused");

    // Resume — should execute next step
    const resumed = await manager.resumeSession(session.id);
    assert.ok(resumed);
    assert.equal(resumed!.status, "waiting");
    assert.equal(resumed!.plan[0]!.status, "running");
  });

  test("pauseSession returns false for completed session", async (t) => {
    const { manager, testDb } = await setup({
      planGoal: async () => ({
        steps: [{ description: "Only step", task: "Do it" }],
        reasoning: "Simple",
      }),
    });
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);
    await manager.onRunCompleted("run-1", "completed");

    const paused = await manager.pauseSession(session.id);
    assert.equal(paused, false);
  });

  test("pauseSession returns false for failed session", async (t) => {
    const { manager, testDb } = await setup({
      evaluateProgress: async () => ({
        next_action: "fail" as const,
        step_result: "Dead",
        updated_context: {},
        reason: "Unrecoverable",
      }),
    });
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);
    await manager.onRunCompleted("run-1", "failed");

    const paused = await manager.pauseSession(session.id);
    assert.equal(paused, false);
  });

  test("resumeSession returns undefined for non-paused session", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);

    const result = await manager.resumeSession(session.id);
    assert.equal(result, undefined);
  });

  test("getActiveSessions filters correctly", async (t) => {
    const { manager, testDb } = await setup({
      planGoal: async () => ({
        steps: [{ description: "Step", task: "Do" }],
        reasoning: "Ok",
      }),
      evaluateProgress: async () => ({
        next_action: "fail" as const,
        step_result: "Dead",
        updated_context: {},
        reason: "Unrecoverable",
      }),
    });
    t.after(async () => { await testDb.cleanup(); });

    // Session 1: planning
    const s1 = await manager.createSession({ ...SESSION_OPTS, goal: "Goal 1" });
    // Session 2: running (planned)
    const s2 = await manager.createSession({ ...SESSION_OPTS, goal: "Goal 2" });
    await manager.planSession(s2.id);
    // Session 3: waiting (step executing)
    const s3 = await manager.createSession({ ...SESSION_OPTS, goal: "Goal 3" });
    await manager.planSession(s3.id);
    await manager.executeNextStep(s3.id);
    // Session 4: failed
    const s4 = await manager.createSession({ ...SESSION_OPTS, goal: "Goal 4" });
    await manager.planSession(s4.id);
    await manager.executeNextStep(s4.id);
    await manager.onRunCompleted("run-2", "failed");

    const active = await manager.getActiveSessions();
    const activeIds = active.map(s => s.id);

    assert.ok(activeIds.includes(s1.id), "planning session should be active");
    assert.ok(activeIds.includes(s2.id), "running session should be active");
    assert.ok(activeIds.includes(s3.id), "waiting session should be active");
    assert.ok(!activeIds.includes(s4.id), "failed session should NOT be active");
  });

  test("listSessions returns all sessions", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await manager.createSession({ ...SESSION_OPTS, goal: "Goal A" });
    await manager.createSession({ ...SESSION_OPTS, goal: "Goal B" });
    await manager.createSession({ ...SESSION_OPTS, goal: "Goal C" });

    const all = await manager.listSessions();
    assert.equal(all.length, 3);

    const goals = all.map(s => s.goal);
    assert.ok(goals.includes("Goal A"));
    assert.ok(goals.includes("Goal B"));
    assert.ok(goals.includes("Goal C"));
  });

  test("listSessions returns a copy (not internal array)", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    await manager.createSession(SESSION_OPTS);
    const list = await manager.listSessions();
    list.pop();

    // Internal list should be unaffected
    assert.equal((await manager.listSessions()).length, 1);
  });

  test("getSession returns undefined for unknown id", async (t) => {
    const { manager, testDb } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const result = await manager.getSession("00000000-0000-0000-0000-000000000000");
    assert.equal(result, undefined);
  });

  test("flush + load round-trips session data (DB is immediate)", async (t) => {
    const { manager, testDb, enqueuer } = await setup();
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    // Create a fresh manager pointed at the same database
    const manager2 = new SessionManager(testDb.db, enqueuer, makeMockPlanGoal());
    await manager2.load();

    const loaded = await manager2.getSession(session.id);
    assert.ok(loaded);
    assert.equal(loaded!.goal, SESSION_OPTS.goal);
    assert.equal(loaded!.plan.length, 3);
    assert.equal(loaded!.plan[0]!.status, "running");
    assert.equal(loaded!.completedRuns, 1);
  });

  test("load handles empty DB gracefully", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const enqueuer = makeMockRunEnqueuer();
    const manager = new SessionManager(testDb.db, enqueuer);
    await manager.load();

    assert.equal((await manager.listSessions()).length, 0);
  });

  test("onRunCompleted continues without evaluator on failure", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const enqueuer = makeMockRunEnqueuer();
    const manager = new SessionManager(testDb.db, enqueuer, makeMockPlanGoal());
    await manager.load();

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    // No evaluator configured — should still advance on failure
    await manager.onRunCompleted("run-1", "failed");

    const updated = (await manager.getSession(session.id))!;
    assert.equal(updated.plan[0]!.status, "failed");
    // Should have advanced to step 2
    assert.equal(updated.plan[1]!.status, "running");
  });

  test("onRunCompleted handles evaluator throwing gracefully", async (t) => {
    const { manager, testDb } = await setup({
      evaluateProgress: async () => {
        throw new Error("LLM API down");
      },
    });
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    await manager.executeNextStep(session.id);

    // Should not throw, and should still advance
    await manager.onRunCompleted("run-1", "failed");

    const updated = (await manager.getSession(session.id))!;
    assert.equal(updated.plan[0]!.status, "failed");
    assert.equal(updated.plan[1]!.status, "running");
  });

  test("executeNextStep with no pending steps completes the session", async (t) => {
    const { manager, testDb } = await setup({
      planGoal: async () => ({
        steps: [],
        reasoning: "Nothing to do",
      }),
    });
    t.after(async () => { await testDb.cleanup(); });

    const session = await manager.createSession(SESSION_OPTS);
    await manager.planSession(session.id);
    const result = await manager.executeNextStep(session.id);

    assert.equal(result.status, "completed");
    assert.ok(result.completedAt);
  });
});
