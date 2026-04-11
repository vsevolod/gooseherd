import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestDb } from "./helpers/test-db.js";
import { teams, users } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { GitHubWorkItemSync, parseJiraIssueKey } from "../src/work-items/github-sync.js";

async function createGitHubSyncFixture() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values({
    id: pmUserId,
    slackUserId: "U_PM",
    githubLogin: "pm-user",
    displayName: "PM",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "growth",
    slackChannelId: "C_GROWTH",
  });

  const resolveDeliveryContext = async () => ({
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.500",
    createdByUserId: pmUserId,
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    ownerTeamId,
    pmUserId,
    service: new WorkItemService(testDb.db),
    sync: new GitHubWorkItemSync(testDb.db, { resolveDeliveryContext }),
  };
}

test("parseJiraIssueKey extracts issue key from PR body", () => {
  assert.equal(parseJiraIssueKey("Implements feature.\n\nJira: HBL-404"), "HBL-404");
  assert.equal(parseJiraIssueKey("no issue here"), undefined);
});

test("github sync adopts labeled PR into delivery work item", async (t) => {
  const { cleanup, sync } = await createGitHubSyncFixture();
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 77,
    prTitle: "Automate work item handling",
    prBody: "Implements workflow support\n\nRefs HBL-404",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/77",
    labels: ["ai_flow"],
    baseBranch: "main",
  });

  assert.ok(adopted);
  assert.equal(adopted?.workflow, "feature_delivery");
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.jiraIssueKey, "HBL-404");
  assert.equal(adopted?.githubPrNumber, 77);
  assert.ok(adopted?.flags.includes("pr_opened"));
});

test("github sync advances auto review item to engineering review after green CI", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Adopt CI success",
    summary: "Waiting for CI",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.600",
    jiraIssueKey: "HBL-405",
    createdByUserId: pmUserId,
    githubPrNumber: 88,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/88",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "self_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    pullRequestNumbers: [88],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "engineering_review");
  assert.ok(updated?.flags.includes("ci_green"));
});

test("github sync routes engineering review outcomes back into delivery flow", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const changesRequestedItem = await service.createDeliveryFromJira({
    title: "Review webhook handling",
    summary: "PR awaits review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.700",
    jiraIssueKey: "HBL-406",
    createdByUserId: pmUserId,
    githubPrNumber: 99,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/99",
    initialState: "engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const sentBack = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 99,
    state: "changes_requested",
    reviewer: "reviewer-a",
  });

  assert.equal(sentBack?.id, changesRequestedItem.id);
  assert.equal(sentBack?.state, "auto_review");

  const approvedItem = await service.createDeliveryFromJira({
    title: "Approved review webhook handling",
    summary: "PR awaits approval",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.701",
    jiraIssueKey: "HBL-407",
    createdByUserId: pmUserId,
    githubPrNumber: 100,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/100",
    initialState: "engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const approved = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 100,
    state: "approved",
    reviewer: "reviewer-a",
  });

  assert.equal(approved?.id, approvedItem.id);
  assert.equal(approved?.state, "qa_preparation");
});
