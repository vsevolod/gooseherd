import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { teams, users, workItems, reviewRequests, workItemEvents } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { RunStore } from "../src/store.js";

async function createServiceFixture() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const reviewerUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values([
    { id: pmUserId, slackUserId: "U_PM", displayName: "PM" },
    { id: reviewerUserId, slackUserId: "U_ENG", displayName: "Engineer" },
  ]);
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "growth",
    slackChannelId: "C_GROWTH",
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    service: new WorkItemService(testDb.db),
    pmUserId,
    reviewerUserId,
    ownerTeamId,
  };
}

test("service creates discovery item, manages review round, and creates delivery item", async (t) => {
  const { db, cleanup, service, pmUserId, reviewerUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const discovery = await service.createDiscoveryWorkItem({
    title: "Automate work items",
    summary: "Initial discovery summary",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.200",
    createdByUserId: pmUserId,
  });

  assert.equal(discovery.workflow, "product_discovery");
  assert.equal(discovery.state, "backlog");

  const started = await service.startDiscovery(discovery.id);
  assert.equal(started.state, "in_progress");
  assert.equal(started.substate, "collecting_context");

  const [reviewA, reviewB] = await service.requestReview({
    workItemId: discovery.id,
    requestedByUserId: pmUserId,
    requests: [
      {
        type: "review",
        targetType: "user",
        targetRef: { userId: reviewerUserId },
        title: "Check architecture",
        requestMessage: "Need eyes on round logic",
        focusPoints: ["review rounds"],
      },
      {
        type: "review",
        targetType: "team",
        targetRef: { teamId: ownerTeamId },
        title: "Check ownership",
        requestMessage: "Need team-level feedback",
        focusPoints: ["owner team"],
      },
    ],
  });

  const waiting = await service.getWorkItem(discovery.id);
  assert.equal(waiting?.state, "waiting_for_review");
  assert.equal(waiting?.substate, "waiting_review_responses");
  assert.equal(reviewA.reviewRound, 1);
  assert.equal(reviewB.reviewRound, 1);

  await service.recordReviewOutcome({
    reviewRequestId: reviewA.id,
    outcome: "changes_requested",
    authorUserId: reviewerUserId,
    comment: "Please tighten the transition model.",
  });

  const backInProgress = await service.getWorkItem(discovery.id);
  assert.equal(backInProgress?.state, "in_progress");

  const supersededRound = await db.select().from(reviewRequests).where(eq(reviewRequests.id, reviewB.id));
  assert.equal(supersededRound[0]?.status, "superseded");

  const [reviewC] = await service.requestReview({
    workItemId: discovery.id,
    requestedByUserId: pmUserId,
    requests: [
      {
        type: "review",
        targetType: "user",
        targetRef: { userId: reviewerUserId },
        title: "Check revised draft",
        requestMessage: "Second pass",
        focusPoints: ["state naming"],
      },
    ],
  });

  assert.equal(reviewC.reviewRound, 2);

  await service.recordReviewOutcome({
    reviewRequestId: reviewC.id,
    outcome: "approved",
    authorUserId: reviewerUserId,
    comment: "Looks good now.",
  });

  const waitingForPm = await service.getWorkItem(discovery.id);
  assert.equal(waitingForPm?.state, "waiting_for_pm_confirmation");

  const completedDiscovery = await service.confirmDiscovery({
    workItemId: discovery.id,
    approved: true,
  });
  assert.equal(completedDiscovery.state, "done");

  const delivery = await service.createDeliveryFromDiscovery({
    discoveryWorkItemId: discovery.id,
    jiraIssueKey: "HBL-101",
    createdByUserId: pmUserId,
  });

  assert.equal(delivery.workflow, "feature_delivery");
  assert.equal(delivery.state, "backlog");
  assert.equal(delivery.jiraIssueKey, "HBL-101");
  assert.equal(delivery.sourceWorkItemId, discovery.id);

  const storedDiscovery = await db.select().from(workItems).where(eq(workItems.id, discovery.id));
  assert.ok((storedDiscovery[0]?.flags ?? []).includes("delivery_work_item_created"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, discovery.id));
  assert.ok(events.length >= 4, "expected discovery lifecycle events to be recorded");
});

test("service creates delivery item directly from jira trigger", async (t) => {
  const { service, cleanup, pmUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Automate CI recovery",
    summary: "Created from Jira webhook",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.300",
    jiraIssueKey: "HBL-202",
    createdByUserId: pmUserId,
  });

  assert.equal(delivery.workflow, "feature_delivery");
  assert.equal(delivery.state, "backlog");
  assert.equal(delivery.jiraIssueKey, "HBL-202");
});

test("service can attach an existing run to a work item", async (t) => {
  const { db, service, cleanup, pmUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const workItem = await service.createDeliveryFromJira({
    title: "Adopt run chain",
    summary: "Attach ad-hoc run",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.400",
    jiraIssueKey: "HBL-303",
    createdByUserId: pmUserId,
  });

  const runStore = new RunStore(db);
  const run = await runStore.createRun(
    {
      runtime: "local",
      repoSlug: "hubstaff/gooseherd",
      task: "Fix specs",
      baseBranch: "main",
      requestedBy: "U_PM",
      channelId: "C_GROWTH",
      threadTs: "1740000000.400",
    },
    "gooseherd"
  );

  await service.attachRunToWorkItem({
    workItemId: workItem.id,
    runId: run.id,
    actorUserId: pmUserId,
  });

  const storedRun = await runStore.getRun(run.id);
  assert.equal(storedRun?.workItemId, workItem.id);
});
