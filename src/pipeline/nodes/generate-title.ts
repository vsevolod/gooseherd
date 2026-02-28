import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { summarizeTitle, type LLMCallerConfig } from "../../llm/caller.js";
import { appendLog } from "../shell.js";
import { logInfo } from "../../logger.js";

/**
 * Generate Title node: uses LLM to create a short dashboard title from the task.
 * Runs early in the pipeline (after clone, before implement).
 * Non-fatal — falls back to raw task text if LLM call fails.
 */
export async function generateTitleNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const run = deps.run;
  const logFile = deps.logFile;

  // Skip if no LLM API key or task is already short
  if (!config.openrouterApiKey) {
    await appendLog(logFile, "\n[generate_title] skipped (no OpenRouter API key)\n");
    return { outcome: "skipped" };
  }

  if (run.task.length <= 60) {
    // Short tasks don't need summarization — they're already good titles
    ctx.set("generatedTitle", run.task);
    return { outcome: "success", outputs: { generatedTitle: run.task } };
  }

  try {
    const llmConfig: LLMCallerConfig = {
      apiKey: config.openrouterApiKey,
      defaultModel: "anthropic/claude-sonnet-4-6",
      defaultTimeoutMs: 10_000
    };

    const result = await summarizeTitle(llmConfig, run.task);
    await appendLog(logFile, `[generate_title] "${result.title}" (${String(result.inputTokens + result.outputTokens)} tokens)\n`);
    logInfo("generate_title", { title: result.title });

    ctx.set("generatedTitle", result.title);

    // Store on the run record so it persists
    run.title = result.title;

    return {
      outcome: "success",
      outputs: {
        generatedTitle: result.title,
        _tokenUsage_generateTitle: {
          input: result.inputTokens,
          output: result.outputTokens
        }
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await appendLog(logFile, `[generate_title] failed (non-fatal): ${message}\n`);
    // Non-fatal — title is nice-to-have
    return { outcome: "soft_fail", error: message };
  }
}
