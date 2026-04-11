import type { Database } from "../db/index.js";
import { WorkItemEventsStore } from "./events-store.js";
import { nextDiscoveryStateAfterPmConfirmation, evaluateDiscoveryReviewRound } from "./product-discovery-policy.js";
import { ReviewRequestStore } from "./review-request-store.js";
import { WorkItemStore } from "./store.js";
import type {
  CreateWorkItemInput,
  ReviewRequestRecord,
  WorkItemRecord,
} from "./types.js";

export class WorkItemService {
  private readonly workItems: WorkItemStore;
  private readonly reviewRequests: ReviewRequestStore;
  private readonly events: WorkItemEventsStore;

  constructor(db: Database) {
    this.workItems = new WorkItemStore(db);
    this.reviewRequests = new ReviewRequestStore(db);
    this.events = new WorkItemEventsStore(db);
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | undefined> {
    return this.workItems.getWorkItem(id);
  }

  async createDiscoveryWorkItem(input: Omit<CreateWorkItemInput, "workflow" | "state">): Promise<WorkItemRecord> {
    const workItem = await this.workItems.createWorkItem({
      ...input,
      workflow: "product_discovery",
      state: "backlog",
    });
    await this.events.append({
      workItemId: workItem.id,
      eventType: "work_item.created",
      actorUserId: workItem.createdByUserId,
      payload: { workflow: workItem.workflow, state: workItem.state },
    });
    return workItem;
  }

  async startDiscovery(workItemId: string): Promise<WorkItemRecord> {
    const updated = await this.workItems.updateState(workItemId, {
      state: "in_progress",
      substate: "collecting_context",
    });
    await this.events.append({
      workItemId,
      eventType: "work_item.state_changed",
      actorUserId: updated.createdByUserId,
      payload: { state: updated.state, substate: updated.substate },
    });
    return updated;
  }

  async requestReview(input: {
    workItemId: string;
    requestedByUserId: string;
    requests: Array<{
      type: ReviewRequestRecord["type"];
      targetType: ReviewRequestRecord["targetType"];
      targetRef: Record<string, unknown>;
      title: string;
      requestMessage?: string;
      focusPoints?: string[];
    }>;
  }): Promise<ReviewRequestRecord[]> {
    const workItem = await this.requireWorkItem(input.workItemId);
    const currentRequests = await this.reviewRequests.listReviewRequestsForWorkItem(workItem.id);
    const nextReviewRound = Math.max(0, ...currentRequests.map((request) => request.reviewRound)) + 1;

    const created: ReviewRequestRecord[] = [];
    for (const request of input.requests) {
      created.push(await this.reviewRequests.createReviewRequest({
        workItemId: input.workItemId,
        reviewRound: nextReviewRound,
        type: request.type,
        targetType: request.targetType,
        targetRef: request.targetRef,
        status: "pending",
        title: request.title,
        requestMessage: request.requestMessage,
        focusPoints: request.focusPoints,
        requestedByUserId: input.requestedByUserId,
      }));
    }

    const updated = await this.workItems.updateState(input.workItemId, {
      state: "waiting_for_review",
      substate: "waiting_review_responses",
    });

    await this.events.append({
      workItemId: input.workItemId,
      eventType: "review_request.created",
      actorUserId: input.requestedByUserId,
      payload: { reviewRound: nextReviewRound, reviewRequestIds: created.map((request) => request.id) },
    });
    await this.events.append({
      workItemId: input.workItemId,
      eventType: "work_item.state_changed",
      actorUserId: input.requestedByUserId,
      payload: { state: updated.state, substate: updated.substate },
    });

    return created;
  }

  async recordReviewOutcome(input: {
    reviewRequestId: string;
    outcome: NonNullable<ReviewRequestRecord["outcome"]>;
    authorUserId?: string;
    comment?: string;
  }): Promise<WorkItemRecord> {
    const completed = await this.reviewRequests.completeReviewRequest(input.reviewRequestId, {
      outcome: input.outcome,
    });

    if (input.comment) {
      await this.reviewRequests.addComment({
        reviewRequestId: input.reviewRequestId,
        authorUserId: input.authorUserId,
        source: "dashboard",
        body: input.comment,
      });
    }

    const workItem = await this.requireWorkItem(completed.workItemId);
    const currentRound = await this.reviewRequests.listReviewRequestsForWorkItem(completed.workItemId, completed.reviewRound);
    const roundResult = evaluateDiscoveryReviewRound(workItem, currentRound);

    for (const requestId of roundResult.supersedePendingRequestIds) {
      await this.reviewRequests.setStatus(requestId, "superseded");
    }

    const updated = await this.workItems.updateState(workItem.id, {
      state: roundResult.nextState,
      substate: roundResult.nextState === "waiting_for_pm_confirmation" ? "awaiting_pm_decision" : "applying_review_feedback",
      flagsToAdd: roundResult.nextState === "waiting_for_pm_confirmation" ? ["all_required_reviews_received"] : [],
    });

    await this.events.append({
      workItemId: workItem.id,
      eventType: "review_request.completed",
      actorUserId: input.authorUserId,
      payload: { reviewRequestId: input.reviewRequestId, outcome: input.outcome },
    });
    await this.events.append({
      workItemId: workItem.id,
      eventType: "work_item.state_changed",
      actorUserId: input.authorUserId,
      payload: { state: updated.state, substate: updated.substate },
    });

    return updated;
  }

  async confirmDiscovery(input: { workItemId: string; approved: boolean; actorUserId?: string }): Promise<WorkItemRecord> {
    const nextState = nextDiscoveryStateAfterPmConfirmation(input.approved);
    const updated = await this.workItems.updateState(input.workItemId, {
      state: nextState,
      substate: nextState === "done" ? undefined : "applying_review_feedback",
      flagsToAdd: input.approved ? ["pm_approved"] : [],
    });

    await this.events.append({
      workItemId: input.workItemId,
      eventType: "work_item.state_changed",
      actorUserId: input.actorUserId,
      payload: { state: updated.state, approved: input.approved },
    });

    return updated;
  }

  async createDeliveryFromDiscovery(input: {
    discoveryWorkItemId: string;
    jiraIssueKey: string;
    createdByUserId: string;
  }): Promise<WorkItemRecord> {
    const discovery = await this.requireWorkItem(input.discoveryWorkItemId);
    if (discovery.workflow !== "product_discovery") {
      throw new Error(`Expected product_discovery source, got ${discovery.workflow}`);
    }
    if (discovery.state !== "done") {
      throw new Error(`Discovery work item must be done before creating delivery, got ${discovery.state}`);
    }

    const delivery = await this.workItems.createWorkItem({
      workflow: "feature_delivery",
      state: "backlog",
      title: discovery.title,
      summary: discovery.summary,
      ownerTeamId: discovery.ownerTeamId,
      homeChannelId: discovery.homeChannelId,
      homeThreadTs: discovery.homeThreadTs,
      originChannelId: discovery.originChannelId,
      originThreadTs: discovery.originThreadTs,
      jiraIssueKey: input.jiraIssueKey,
      sourceWorkItemId: discovery.id,
      createdByUserId: input.createdByUserId,
      flags: [],
    });

    await this.workItems.addFlags(discovery.id, ["delivery_work_item_created"]);
    await this.events.append({
      workItemId: discovery.id,
      eventType: "work_item.flags_updated",
      actorUserId: input.createdByUserId,
      payload: { flagsAdded: ["delivery_work_item_created"], deliveryWorkItemId: delivery.id },
    });
    await this.events.append({
      workItemId: delivery.id,
      eventType: "work_item.created",
      actorUserId: input.createdByUserId,
      payload: { workflow: delivery.workflow, sourceWorkItemId: discovery.id, jiraIssueKey: input.jiraIssueKey },
    });

    return delivery;
  }

  private async requireWorkItem(id: string): Promise<WorkItemRecord> {
    const workItem = await this.workItems.getWorkItem(id);
    if (!workItem) throw new Error(`WorkItem not found: ${id}`);
    return workItem;
  }
}
