import type { Database } from "../db/index.js";
import {
  nextFeatureDeliveryStateAfterAutoReview,
  nextFeatureDeliveryStateAfterEngineeringReview,
  nextFeatureDeliveryStateAfterProductReview,
  nextFeatureDeliveryStateAfterQaReview,
  nextFeatureDeliveryStateAfterReadyForMergeRecovery,
} from "./feature-delivery-policy.js";
import { WorkItemEventsStore } from "./events-store.js";
import { WorkItemService } from "./service.js";
import { WorkItemStore } from "./store.js";
import type { WorkItemRecord } from "./types.js";

export interface GitHubWorkItemWebhookPayload {
  eventType: "pull_request" | "pull_request_review" | "check_suite";
  action?: string;
  repo?: string;
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  prUrl?: string;
  baseBranch?: string;
  labels?: string[];
  reviewer?: string;
  state?: string;
  conclusion?: string;
  status?: string;
  pullRequestNumbers?: number[];
}

export interface DeliveryContextResolverResult {
  ownerTeamId: string;
  homeChannelId: string;
  homeThreadTs: string;
  createdByUserId: string;
  originChannelId?: string;
  originThreadTs?: string;
}

export interface GitHubWorkItemSyncOptions {
  adoptionLabels?: string[];
  resolveDeliveryContext: (input: {
    jiraIssueKey: string;
    repo?: string;
    prNumber?: number;
  }) => Promise<DeliveryContextResolverResult | undefined>;
}

export function parseJiraIssueKey(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match?.[1];
}

export class GitHubWorkItemSync {
  private readonly workItems: WorkItemStore;
  private readonly workItemService: WorkItemService;
  private readonly events: WorkItemEventsStore;
  private readonly adoptionLabels: string[];
  private readonly resolveDeliveryContext: GitHubWorkItemSyncOptions["resolveDeliveryContext"];

  constructor(db: Database, options: GitHubWorkItemSyncOptions) {
    this.workItems = new WorkItemStore(db);
    this.workItemService = new WorkItemService(db);
    this.events = new WorkItemEventsStore(db);
    this.adoptionLabels = (options.adoptionLabels ?? ["ai_flow"]).map((label) => label.trim().toLowerCase()).filter(Boolean);
    this.resolveDeliveryContext = options.resolveDeliveryContext;
  }

  async handleWebhookPayload(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    switch (payload.eventType) {
      case "pull_request":
        return this.handlePullRequest(payload);
      case "check_suite":
        return this.handleCheckSuite(payload);
      case "pull_request_review":
        return this.handlePullRequestReview(payload);
      default:
        return undefined;
    }
  }

  private async handlePullRequest(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    const prNumber = payload.prNumber;
    if (!prNumber || !this.hasAdoptionLabel(payload.labels)) {
      return undefined;
    }

    const existing = await this.workItems.findByGitHubPrNumber(prNumber);
    if (existing) {
      return existing;
    }

    const jiraIssueKey = parseJiraIssueKey(payload.prBody);
    if (!jiraIssueKey) {
      return undefined;
    }

    const context = await this.resolveDeliveryContext({
      jiraIssueKey,
      repo: payload.repo,
      prNumber,
    });
    if (!context) {
      return undefined;
    }

    const adopted = await this.workItemService.createDeliveryFromJira({
      title: payload.prTitle ?? jiraIssueKey,
      summary: payload.prBody,
      ownerTeamId: context.ownerTeamId,
      homeChannelId: context.homeChannelId,
      homeThreadTs: context.homeThreadTs,
      originChannelId: context.originChannelId,
      originThreadTs: context.originThreadTs,
      jiraIssueKey,
      createdByUserId: context.createdByUserId,
      githubPrNumber: prNumber,
      githubPrUrl: payload.prUrl,
      initialState: "auto_review",
      initialSubstate: "pr_adopted",
      flags: ["pr_opened"],
    });

    await this.events.append({
      workItemId: adopted.id,
      eventType: "github.pr_adopted",
      actorUserId: context.createdByUserId,
      payload: {
        repo: payload.repo,
        prNumber,
        jiraIssueKey,
        labels: payload.labels ?? [],
      },
    });

    return adopted;
  }

  private async handleCheckSuite(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    const workItem = await this.findWorkItemByPullRequestNumbers(payload.pullRequestNumbers);
    if (!workItem) {
      return undefined;
    }

    const conclusion = payload.conclusion?.toLowerCase();
    if (conclusion === "success") {
      const nextState = workItem.state === "auto_review"
        ? nextFeatureDeliveryStateAfterAutoReview({
          ciGreen: true,
          selfReviewDone: workItem.flags.includes("self_review_done"),
          hasActiveAutoFixes: false,
        })
        : workItem.state;

      const updated = await this.workItems.updateState(workItem.id, {
        state: nextState,
        substate: nextState === "engineering_review" ? "waiting_engineering_review" : "waiting_ci",
        flagsToAdd: ["ci_green"],
      });

      await this.events.append({
        workItemId: updated.id,
        eventType: "github.ci_updated",
        payload: { conclusion, state: updated.state, prNumbers: payload.pullRequestNumbers ?? [] },
      });

      return updated;
    }

    if (conclusion === "failure" || conclusion === "timed_out") {
      const nextState = workItem.state === "ready_for_merge"
        ? nextFeatureDeliveryStateAfterReadyForMergeRecovery("ci_failed_after_rebase")
        : "auto_review";
      const updated = await this.workItems.updateState(workItem.id, {
        state: nextState,
        substate: workItem.state === "ready_for_merge" ? "revalidating_after_rebase" : "waiting_ci",
        flagsToRemove: ["ci_green"],
      });

      await this.events.append({
        workItemId: updated.id,
        eventType: "github.ci_updated",
        payload: { conclusion, state: updated.state, prNumbers: payload.pullRequestNumbers ?? [] },
      });

      return updated;
    }

    return undefined;
  }

  private async handlePullRequestReview(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    if (payload.action !== "submitted" || !payload.prNumber) {
      return undefined;
    }

    const workItem = await this.workItems.findByGitHubPrNumber(payload.prNumber);
    if (!workItem) {
      return undefined;
    }

    const reviewState = payload.state?.toLowerCase();
    if (reviewState !== "approved" && reviewState !== "changes_requested") {
      return undefined;
    }

    const currentState = workItem.state;
    if (!["engineering_review", "product_review", "qa_review"].includes(currentState)) {
      return undefined;
    }

    let nextState: WorkItemRecord["state"];
    let substate: string | undefined;
    let flagsToAdd: string[] = [];

    if (currentState === "engineering_review") {
      nextState = nextFeatureDeliveryStateAfterEngineeringReview(reviewState);
      substate = nextState === "qa_preparation" ? "preparing_review_app" : "applying_review_feedback";
      if (reviewState === "approved") flagsToAdd = ["engineering_review_done"];
    } else if (currentState === "product_review") {
      nextState = nextFeatureDeliveryStateAfterProductReview(reviewState);
      substate = nextState === "qa_review" ? "waiting_qa_review" : "applying_review_feedback";
      if (reviewState === "approved") flagsToAdd = ["product_review_done"];
    } else {
      nextState = nextFeatureDeliveryStateAfterQaReview(reviewState);
      substate = nextState === "ready_for_merge" ? "waiting_merge" : "applying_review_feedback";
      if (reviewState === "approved") flagsToAdd = ["qa_review_done"];
    }

    const updated = await this.workItems.updateState(workItem.id, {
      state: nextState,
      substate,
      flagsToAdd,
    });

    await this.events.append({
      workItemId: updated.id,
      eventType: "github.review_submitted",
      payload: {
        prNumber: payload.prNumber,
        reviewer: payload.reviewer,
        reviewState,
        state: updated.state,
      },
    });

    return updated;
  }

  private hasAdoptionLabel(labels: string[] | undefined): boolean {
    const normalized = (labels ?? []).map((label) => label.trim().toLowerCase());
    return normalized.some((label) => this.adoptionLabels.includes(label));
  }

  private async findWorkItemByPullRequestNumbers(prNumbers: number[] | undefined): Promise<WorkItemRecord | undefined> {
    for (const prNumber of prNumbers ?? []) {
      const workItem = await this.workItems.findByGitHubPrNumber(prNumber);
      if (workItem) {
        return workItem;
      }
    }
    return undefined;
  }
}
