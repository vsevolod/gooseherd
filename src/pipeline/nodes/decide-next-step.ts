/**
 * Decision node — mid-pipeline intelligence.
 *
 * Examines the current pipeline state (via ContextBag) and decides which
 * subsequent nodes to skip or whether to modify the recovery approach.
 *
 * Uses callLLMForJSON() with structured output — same pattern as smart-triage.ts.
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { callLLMForJSON, type LLMCallerConfig } from "../../llm/caller.js";
import { appendLog } from "../shell.js";
import { logInfo } from "../../logger.js";

const DECISION_SYSTEM_PROMPT = `You are a pipeline orchestrator deciding what to do next.
Given the current pipeline state and available actions, decide which nodes to skip and whether to modify the recovery approach.

Respond ONLY with a JSON object:
{
  "skipNodes": ["node_ids_to_skip"],
  "reason": "one-line explanation of your decision"
}

## Decision guidelines:
- If browser verification failed due to auth issues (login redirect, access denied), DO NOT skip browser_verify — the auth handling should retry.
- If browser verification failed due to the feature genuinely not being visible, and fix_browser has already been tried, consider whether another fix attempt would help.
- If the failure pattern is repeating (same verdict across rounds), suggest skipping browser_verify to avoid wasting resources.
- If the issue is clearly a CSS/layout problem, recommend retrying fix_browser.
- Default to empty skipNodes (let everything run).`;

interface DecisionOutput {
  skipNodes: string[];
  reason: string;
}

export async function decideNextStepNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const logFile = deps.logFile;
  const nc = nodeConfig.config as Record<string, unknown> | undefined;

  // Resolve model from node config or default
  const model = (nc?.["model"] as string) ?? "openai/gpt-4.1-mini";

  // Build state summary from context
  const contextKeys = Array.isArray(nc?.["context_keys"])
    ? nc["context_keys"] as string[]
    : undefined;
  const stateSummary = ctx.toSummary(contextKeys);

  // Build available actions list
  const availableActions = Array.isArray(nc?.["available_actions"])
    ? (nc["available_actions"] as string[]).join(", ")
    : "fix_browser, browser_verify, implement";

  const userMessage = [
    "## Current pipeline state",
    stateSummary,
    "",
    `## Available actions: ${availableActions}`,
    "",
    "Decide which nodes (if any) to skip based on the current state."
  ].join("\n");

  // Resolve API key
  const apiKey = deps.config.openrouterApiKey
    ?? deps.config.openaiApiKey
    ?? deps.config.anthropicApiKey;

  if (!apiKey) {
    await appendLog(logFile, "[decide] no API key available, skipping decision\n");
    return { outcome: "success", outputs: {} };
  }

  const llmConfig: LLMCallerConfig = { apiKey, defaultModel: model, defaultTimeoutMs: 15_000, providerPreferences: deps.config.openrouterProviderPreferences };

  try {
    const { parsed } = await callLLMForJSON<DecisionOutput>(llmConfig, {
      system: DECISION_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 256,
      timeoutMs: 15_000,
      model
    });

    const skipNodes = Array.isArray(parsed.skipNodes)
      ? parsed.skipNodes.filter(s => typeof s === "string")
      : [];
    const reason = typeof parsed.reason === "string" ? parsed.reason : "No reason provided";

    await appendLog(logFile, `[decide] decision: skip=[${skipNodes.join(",")}] reason="${reason}"\n`);
    logInfo("Decision node", { skipNodes, reason });

    return {
      outcome: "success",
      outputs: {
        _skipNodes: skipNodes,
        decisionReason: reason
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    await appendLog(logFile, `[decide] LLM call failed: ${msg}, continuing without skipping\n`);
    return { outcome: "success", outputs: {} };
  }
}
