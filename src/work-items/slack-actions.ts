import type { WebClient } from "@slack/web-api";
import type { Block, KnownBlock } from "@slack/types";
import type { AppConfig } from "../config.js";
import type { ReviewRequestRecord, WorkItemRecord } from "./types.js";

export interface WorkItemSlackActionPayload {
  reviewRequestId: string;
  workItemId: string;
  homeChannelId: string;
  homeThreadTs: string;
  requestTitle: string;
  detailUrl?: string;
}

export interface BuildWorkItemReviewBlocksInput {
  appName: string;
  workItemTitle: string;
  workItemDisplayId: string;
  requestTitle: string;
  requestMessage?: string;
  focusPoints?: string[];
  detailUrl?: string;
  actionValue: string;
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  return url?.trim().replace(/\/+$/, "") || undefined;
}

export function buildWorkItemDetailUrl(baseUrl: string | undefined, workItemId: string): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  return `${normalized}/#work-item/${encodeURIComponent(workItemId)}`;
}

export function buildWorkItemSlackActionValue(payload: WorkItemSlackActionPayload): string {
  return JSON.stringify(payload);
}

export function parseWorkItemSlackActionValue(value: string | undefined): WorkItemSlackActionPayload | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Partial<WorkItemSlackActionPayload>;
    if (!parsed.reviewRequestId || !parsed.workItemId || !parsed.homeChannelId || !parsed.homeThreadTs || !parsed.requestTitle) {
      return undefined;
    }
    return {
      reviewRequestId: parsed.reviewRequestId,
      workItemId: parsed.workItemId,
      homeChannelId: parsed.homeChannelId,
      homeThreadTs: parsed.homeThreadTs,
      requestTitle: parsed.requestTitle,
      detailUrl: parsed.detailUrl,
    };
  } catch {
    return undefined;
  }
}

export function buildWorkItemReviewBlocks(input: BuildWorkItemReviewBlocksInput): Array<KnownBlock | Block> {
  const secondaryLines = [
    input.requestMessage?.trim() || "",
    ...(input.focusPoints?.length
      ? [`*Focus points*\n${input.focusPoints.map((point) => `• ${point}`).join("\n")}`]
      : []),
    input.detailUrl ? `<${input.detailUrl}|Open work item>` : "",
  ].filter(Boolean);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${input.appName} review request*\n*${input.workItemDisplayId}* — ${input.workItemTitle}\n*Request:* ${input.requestTitle}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: secondaryLines.join("\n\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "work_item_review_approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: true },
          value: input.actionValue,
        },
        {
          type: "button",
          action_id: "work_item_review_changes",
          text: { type: "plain_text", text: "Request changes", emoji: true },
          value: input.actionValue,
        },
      ],
    },
  ];
}

export async function postWorkItemReviewNotifications(
  client: WebClient,
  config: AppConfig,
  workItem: WorkItemRecord,
  reviewRequests: ReviewRequestRecord[],
): Promise<void> {
  const detailUrl = buildWorkItemDetailUrl(config.dashboardPublicUrl, workItem.id);
  const usernameOpt = config.slackCommandName ? { username: config.slackCommandName } : {};

  for (const reviewRequest of reviewRequests) {
    const actionValue = buildWorkItemSlackActionValue({
      reviewRequestId: reviewRequest.id,
      workItemId: workItem.id,
      homeChannelId: workItem.homeChannelId,
      homeThreadTs: workItem.homeThreadTs,
      requestTitle: reviewRequest.title,
      detailUrl,
    });

    await client.chat.postMessage({
      channel: workItem.homeChannelId,
      thread_ts: workItem.homeThreadTs,
      text: `Review requested for ${workItem.jiraIssueKey ?? workItem.id}: ${reviewRequest.title}`,
      blocks: buildWorkItemReviewBlocks({
        appName: config.appName,
        workItemTitle: workItem.title,
        workItemDisplayId: workItem.jiraIssueKey ?? workItem.id.slice(0, 8),
        requestTitle: reviewRequest.title,
        requestMessage: reviewRequest.requestMessage,
        focusPoints: reviewRequest.focusPoints,
        detailUrl,
        actionValue,
      }),
      ...usernameOpt,
    });
  }
}
