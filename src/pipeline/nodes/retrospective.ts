/**
 * Retrospective node — runs after notify to analyze the run and extract learnings.
 *
 * Uses an LLM to review the run log + outcome, producing a structured
 * retrospective (summary, quality, learnings, recommendations).
 * If CEMS (organizational memory) is enabled, stores discoveries there.
 *
 * Non-critical: returns "skipped" on any error to avoid failing the pipeline.
 */

import { readFile } from "node:fs/promises";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog } from "../shell.js";
import { callLLMForJSON, type LLMCallerConfig } from "../../llm/caller.js";

export interface RetrospectiveOutput {
  summary: string;
  outcome_quality: "excellent" | "good" | "mediocre" | "poor";
  learnings: string[];
  failure_category?: string | null;
  recommendations: string[];
  cost_assessment: "reasonable" | "expensive" | "wasteful";
}

export async function retrospectiveNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const run = deps.run;
  const logFile = deps.logFile;

  // Skip if no LLM API key
  if (!config.openrouterApiKey) {
    await appendLog(logFile, "[retrospective] skipped (no OPENROUTER_API_KEY)\n");
    return { outcome: "skipped" };
  }

  await deps.onPhase("retrospective");

  // Read run log (last 3000 chars to stay within token budget)
  let runLog = "";
  try {
    const fullLog = await readFile(logFile, "utf8");
    runLog = fullLog.length > 3000 ? fullLog.slice(-3000) : fullLog;
  } catch {
    runLog = "(log not available)";
  }

  // Build context about the run
  const durationSeconds =
    run.finishedAt && run.createdAt
      ? Math.round(
          (new Date(run.finishedAt).getTime() -
            new Date(run.createdAt).getTime()) /
            1000
        )
      : undefined;

  const runContext = [
    `Run ID: ${run.id}`,
    `Status: ${run.status}`,
    `Repo: ${run.repoSlug}`,
    `Task: ${run.task}`,
    `Duration: ${durationSeconds !== undefined ? `${String(durationSeconds)}s` : "unknown"}`,
    `Changed files: ${String(run.changedFiles?.length ?? 0)}`,
    `Cost: $${run.tokenUsage?.costUsd?.toFixed(4) ?? "unknown"}`,
    `Title: ${run.title ?? "none"}`
  ].join("\n");

  const systemPrompt = `You are a retrospective analyst for an AI coding agent. Analyze the run log and outcome to extract learnings.

Respond with JSON:
{
  "summary": "one paragraph summary",
  "outcome_quality": "excellent" | "good" | "mediocre" | "poor",
  "learnings": ["key takeaway 1", "key takeaway 2"],
  "failure_category": "timeout" | "validation" | "agent_error" | "scope_creep" | "infra" | null,
  "recommendations": ["suggestion 1"],
  "cost_assessment": "reasonable" | "expensive" | "wasteful"
}`;

  const userMessage = `## Run Context\n${runContext}\n\n## Run Log (last 3000 chars)\n${runLog}`;

  const nc = nodeConfig.config as Record<string, unknown> | undefined;
  const model = (nc?.["model"] as string) ?? config.defaultLlmModel;

  const llmConfig: LLMCallerConfig = {
    apiKey: config.openrouterApiKey,
    defaultModel: config.defaultLlmModel,
    defaultTimeoutMs: 15_000,
    providerPreferences: config.openrouterProviderPreferences
  };

  try {
    const { parsed } = await callLLMForJSON<RetrospectiveOutput>(llmConfig, {
      system: systemPrompt,
      userMessage,
      model,
      maxTokens: 512
    });

    // Store in context bag
    ctx.set("retrospective", parsed);

    await appendLog(
      logFile,
      `[retrospective] quality=${parsed.outcome_quality}; learnings=${String(parsed.learnings.length)}\n`
    );

    // Store in CEMS if available
    const memoryProvider = deps.hooks?.memoryProvider;
    if (memoryProvider) {
      try {
        const content = [
          `Run retrospective for ${run.repoSlug}: ${parsed.summary}`,
          "",
          "Learnings:",
          ...parsed.learnings.map(l => `- ${l}`)
        ].join("\n");

        const tags = [run.repoSlug, run.status, parsed.outcome_quality];

        await memoryProvider.storeMemory(
          content,
          tags,
          `project:${run.repoSlug}`
        );
        await appendLog(logFile, "[retrospective] stored in CEMS\n");
      } catch (cemsErr) {
        const msg = cemsErr instanceof Error ? cemsErr.message : "unknown";
        await appendLog(logFile, `[retrospective] CEMS store failed: ${msg}\n`);
      }
    }

    return {
      outcome: "success",
      outputs: { retrospective: parsed }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    await appendLog(logFile, `[retrospective] failed: ${msg}\n`);
    // Retrospective is non-critical — don't fail the run
    return { outcome: "skipped" };
  }
}
