/**
 * Skill node — LLM-interpreted English instruction node.
 *
 * Two modes:
 * - "agent" (default): builds a prompt file from the instruction + context,
 *   runs via buildAgentCommand() in the sandbox with timeout/token tracking.
 * - "llm": calls callLLMForJSON() for analysis/decision tasks,
 *   stores parsed output in the context bag.
 */

import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShellCapture } from "../shell.js";
import { buildAgentCommand } from "../agent-command.js";
import { callLLMForJSON, type LLMCallerConfig } from "../../llm/caller.js";

export async function skillNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const nc = nodeConfig.config as Record<string, unknown> | undefined;
  const instruction = nc?.["instruction"] as string | undefined;

  if (!instruction || instruction.trim() === "") {
    return {
      outcome: "failure",
      error: "skill node requires config.instruction"
    };
  }

  const mode = (nc?.["mode"] as string) ?? "agent";

  if (mode === "llm") {
    return runLlmMode(nodeConfig, instruction, nc, ctx, deps);
  }

  return runAgentMode(nodeConfig, instruction, nc, ctx, deps);
}

// ── Agent mode ──

async function runAgentMode(
  nodeConfig: NodeConfig,
  instruction: string,
  nc: Record<string, unknown> | undefined,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const run = deps.run;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");

  await deps.onPhase("agent");

  // Build prompt content
  const contextKeys = nc?.["context_keys"] as string[] | undefined;
  const contextSummary = contextKeys?.length
    ? ctx.toSummary(contextKeys)
    : "";

  const sections: string[] = [instruction];
  if (contextSummary) {
    sections.push("\n## Context\n");
    sections.push(contextSummary);
  }

  // If an existing promptFile is in the context, prepend its content
  const existingPromptFile = ctx.get<string>("promptFile");
  let promptContent: string;
  if (existingPromptFile) {
    try {
      const original = await readFile(existingPromptFile, "utf8");
      promptContent = `${sections.join("\n")}\n\n---\n\n${original}`;
    } catch {
      promptContent = sections.join("\n");
    }
  } else {
    promptContent = sections.join("\n");
  }

  // Write skill prompt file
  const promptFile = path.join(
    deps.workRoot,
    run.id,
    `skill-${nodeConfig.id}.md`
  );
  await writeFile(promptFile, promptContent, "utf8");

  const timeoutSeconds = (nc?.["timeout_seconds"] as number) ?? config.agentTimeoutSeconds;

  await appendLog(
    logFile,
    `[skill:${nodeConfig.id}] agent mode; timeout ${String(timeoutSeconds)}s\n`
  );

  const agentCommand = buildAgentCommand(
    config,
    run,
    repoDir,
    promptFile,
    false
  );

  const result = await runShellCapture(agentCommand, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: timeoutSeconds * 1000,
    login: true
  });

  await appendLog(
    logFile,
    `[skill:${nodeConfig.id}] agent exited with code ${String(result.code)}\n`
  );

  if (result.code !== 0) {
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const timeoutDetected = /\[timeout[^\]]*\]|timed out|timeout:/i.test(combinedOutput);

    return {
      outcome: "failure",
      error: timeoutDetected
        ? `Skill agent timed out after ${String(timeoutSeconds)}s`
        : `Skill agent exited with code ${String(result.code)}`,
      rawOutput: (result.stdout + result.stderr).slice(-2000)
    };
  }

  return { outcome: "success" };
}

// ── LLM mode ──

async function runLlmMode(
  nodeConfig: NodeConfig,
  instruction: string,
  nc: Record<string, unknown> | undefined,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;

  if (!config.openrouterApiKey) {
    await appendLog(
      logFile,
      `[skill:${nodeConfig.id}] llm mode skipped (no OPENROUTER_API_KEY)\n`
    );
    return { outcome: "skipped" };
  }

  const contextKeys = nc?.["context_keys"] as string[] | undefined;
  const contextSummary = contextKeys?.length
    ? ctx.toSummary(contextKeys)
    : "";

  const userMessage = contextSummary
    ? `${instruction}\n\n## Context\n${contextSummary}`
    : instruction;

  const llmConfig: LLMCallerConfig = {
    apiKey: config.openrouterApiKey,
    defaultModel: config.defaultLlmModel,
    defaultTimeoutMs: 15_000,
    providerPreferences: config.openrouterProviderPreferences
  };

  const model = nc?.["model"] as string | undefined;

  try {
    const { parsed, raw } = await callLLMForJSON<Record<string, unknown>>(
      llmConfig,
      {
        system: "You are a pipeline analysis step. Respond with JSON.",
        userMessage,
        model,
        maxTokens: 1024
      }
    );

    const outputKey = (nc?.["output_key"] as string) ?? `skill_${nodeConfig.id}_output`;
    ctx.set(outputKey, parsed);

    ctx.set(`_tokenUsage_${nodeConfig.id}`, {
      input: raw.inputTokens,
      output: raw.outputTokens,
      model: raw.model
    });

    await appendLog(
      logFile,
      `[skill:${nodeConfig.id}] llm mode success; stored output in '${outputKey}'\n`
    );

    return {
      outcome: "success",
      outputs: { [outputKey]: parsed }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    await appendLog(
      logFile,
      `[skill:${nodeConfig.id}] llm mode failed: ${msg}\n`
    );
    return {
      outcome: "failure",
      error: `Skill LLM call failed: ${msg}`
    };
  }
}
