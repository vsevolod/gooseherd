import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import type { AgentAnalysis } from "./implement.js";

/**
 * Create PR node: create or update pull request via GitHub API.
 */
export async function createPrNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const run = deps.run;
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const resolvedBaseBranch = ctx.get<string>("resolvedBaseBranch") ?? run.baseBranch;
  const dryRun = config.dryRun;

  if (dryRun || !deps.githubService) {
    return { outcome: "success" };
  }

  const titleText = run.title ?? ctx.get<string>("generatedTitle") ?? run.task.slice(0, 80);
  const prTitle = `${config.appSlug}: ${titleText}`;
  const gateReport = ctx.get<Array<{ gate: string; verdict: string; reasons: string[] }>>("gateReport");
  const agentAnalysis = ctx.get<AgentAnalysis>("agentAnalysis");
  const commitSha = ctx.get<string>("commitSha");
  const changedFiles = ctx.get<string[]>("changedFiles");

  // Screenshot URL is not available at PR creation time — it gets added
  // later by upload_screenshot node after browser_verify captures it.
  const prBody = buildPrBody(
    run, resolvedBaseBranch, config.appName, isFollowUp,
    gateReport, agentAnalysis, commitSha, changedFiles
  );

  const prResult = isFollowUp
    ? await deps.githubService.findOrCreatePullRequest({
        repoSlug: run.repoSlug,
        title: prTitle,
        body: prBody,
        head: run.branchName,
        base: resolvedBaseBranch
      })
    : await deps.githubService.createPullRequest({
        repoSlug: run.repoSlug,
        title: prTitle,
        body: prBody,
        head: run.branchName,
        base: resolvedBaseBranch
      });

  ctx.set("prUrl", prResult.url);
  ctx.set("prNumber", prResult.number);

  return {
    outcome: "success",
    outputs: { prUrl: prResult.url, prNumber: prResult.number }
  };
}

export function buildPrBody(
  run: { id: string; task: string; requestedBy: string; parentRunId?: string; feedbackNote?: string; chainIndex?: number },
  resolvedBaseBranch: string,
  appName: string,
  isFollowUp: boolean,
  gateReport?: Array<{ gate: string; verdict: string; reasons: string[] }>,
  agentAnalysis?: AgentAnalysis,
  commitSha?: string,
  changedFiles?: string[],
  screenshotUrl?: string
): string {
  const lines: string[] = [];

  // ── Task description ──
  lines.push("## Task", "", formatTaskDescription(run.task), "");

  // ── Follow-up context ──
  if (isFollowUp && run.parentRunId) {
    lines.push(
      "## Follow-up",
      "",
      `> ${run.feedbackNote ?? "retry"}`,
      "",
      `- **Previous run:** \`${run.parentRunId.slice(0, 8)}\``,
      `- **Chain depth:** ${String(run.chainIndex ?? 1)}`,
      ""
    );
  }

  // ── What changed ──
  lines.push("## What changed", "");

  if (agentAnalysis) {
    lines.push(
      `**${String(agentAnalysis.diffStats.filesCount)}** files changed — ` +
      `**+${String(agentAnalysis.diffStats.added)}** / **-${String(agentAnalysis.diffStats.removed)}** lines`,
      ""
    );
  }

  const filesToShow = changedFiles ?? agentAnalysis?.filesChanged ?? [];
  if (filesToShow.length > 0 && filesToShow.length <= 30) {
    lines.push("| File |", "|------|");
    for (const file of filesToShow) {
      lines.push(`| \`${file}\` |`);
    }
    lines.push("");
  } else if (filesToShow.length > 30) {
    lines.push(`<details><summary>${String(filesToShow.length)} files changed (click to expand)</summary>`, "");
    for (const file of filesToShow) {
      lines.push(`- \`${file}\``);
    }
    lines.push("", "</details>", "");
  }

  if (agentAnalysis?.signals && agentAnalysis.signals.length > 0) {
    const meaningful = agentAnalysis.signals.filter(s => !/timeout/i.test(s));
    if (meaningful.length > 0) {
      lines.push("**Signals detected:**", "");
      for (const signal of meaningful) {
        lines.push(`- ${signal}`);
      }
      lines.push("");
    }
  }

  // ── Quality gates (always show all, not just warnings) ──
  if (gateReport && gateReport.length > 0) {
    lines.push("## Verification", "");
    for (const entry of gateReport) {
      const icon = entry.verdict === "pass" ? "\u2705" : entry.verdict === "soft_fail" ? "\u26A0\uFE0F" : "\u274C";
      lines.push(`${icon} **${formatGateName(entry.gate)}** — ${entry.verdict}`);
      if (entry.reasons.length > 0) {
        for (const reason of entry.reasons) {
          lines.push(`  - ${reason}`);
        }
      }
    }
    lines.push("");
  }

  // ── Visual Evidence ──
  if (screenshotUrl) {
    lines.push("## Visual Evidence", "");
    lines.push(`![Screenshot](${screenshotUrl})`, "");
  }

  // ── Run metadata ──
  lines.push("## Details", "");
  lines.push(
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Base branch** | \`${resolvedBaseBranch}\` |`,
    `| **Requested by** | ${run.requestedBy} |`,
    `| **Run ID** | \`${run.id.slice(0, 8)}\` |`
  );
  if (commitSha) {
    lines.push(`| **Commit** | \`${commitSha.slice(0, 12)}\` |`);
  }
  if (agentAnalysis) {
    lines.push(`| **Verdict** | ${agentAnalysis.verdict} |`);
  }
  lines.push("");

  // ── Footer ──
  lines.push(
    "---",
    `*Automated by [${appName}](https://goose-herd.com)*`
  );

  return lines.join("\n");
}

/**
 * Format task description for PR body.
 * Detects numbered requirements (e.g. "1. Do X 2. Do Y") and formats them as a list.
 */
function formatTaskDescription(task: string): string {
  // Find the position of "1." — requires at least 2 numbered items to trigger formatting
  const firstItemMatch = /(?:^|\s)1\.\s/.exec(task);
  if (!firstItemMatch) return task;

  // Check there's at least a "2." following
  const afterFirst = task.slice(firstItemMatch.index);
  if (!/\s2\.\s/.test(afterFirst)) return task;

  // Extract preamble (everything before "1.")
  const preamble = task.slice(0, firstItemMatch.index).replace(/\s+$/, "");

  // Extract all numbered items using a global regex
  const itemRegex = /(\d+)\.\s+((?:(?!\s\d+\.\s).)*)/g;
  const items: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(afterFirst)) !== null) {
    const text = match[2]!.replace(/\.\s*$/, "").trim();
    items.push(`${match[1]}. ${text}`);
  }

  if (items.length < 2) return task;

  const lines = preamble ? [preamble, "", ...items] : items;
  return lines.join("\n");
}

/** Format gate machine names for display: security_scan → Security Scan */
function formatGateName(gate: string): string {
  return gate.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
