/**
 * Run Node — generic shell command executor configured via YAML.
 *
 * Reads the command from nodeConfig.config.command and executes it.
 * Supports optional cwd, timeout, and output capture via config keys.
 */

import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, renderTemplate, appendLog, mapToContainerPath } from "../shell.js";

export async function runNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const logFile = deps.logFile;
  const run = deps.run;

  const command = nodeConfig.config?.command as string | undefined;
  if (!command || !command.trim()) {
    return { outcome: "failure", error: "run node requires config.command" };
  }

  const repoDir = ctx.get<string>("repoDir") ?? "";
  const promptFile = ctx.get<string>("promptFile") ?? "";

  await deps.onPhase("running");

  const templateVars: Record<string, string> = {
    repo_dir: repoDir ? mapToContainerPath(repoDir) : "",
    run_id: run.id,
    repo_slug: run.repoSlug,
    parent_run_id: run.parentRunId ?? ""
  };

  if (promptFile) {
    templateVars.prompt_file = mapToContainerPath(promptFile);
    templateVars.task_file = mapToContainerPath(promptFile);
  }

  const renderedCommand = renderTemplate(command, templateVars);

  // Resolve cwd: use config.cwd (rendered through template) if set, else repoDir, else "."
  let cwd: string;
  const configCwd = nodeConfig.config?.cwd as string | undefined;
  if (configCwd) {
    cwd = renderTemplate(configCwd, templateVars);
  } else if (repoDir) {
    cwd = repoDir;
  } else {
    cwd = path.resolve(".");
  }

  const timeoutSeconds = nodeConfig.config?.timeout_seconds as number | undefined;
  const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : undefined;
  const outputKey = nodeConfig.config?.output_key as string | undefined;

  await appendLog(logFile, `\n[pipeline] run (${nodeConfig.id}): executing command\n`);

  const result = await runShellCapture(renderedCommand, { cwd, logFile, timeoutMs });

  if (result.code === 0) {
    await appendLog(logFile, `\n[pipeline] run (${nodeConfig.id}): success\n`);

    const outputs: Record<string, unknown> | undefined =
      outputKey ? { [outputKey]: result.stdout.trim() } : undefined;

    return { outcome: "success", outputs };
  }

  const rawOutput = result.stderr || result.stdout;
  await appendLog(logFile, `\n[pipeline] run (${nodeConfig.id}): failed\n`);

  return {
    outcome: "failure",
    error: `Command failed with exit code ${String(result.code)}`,
    rawOutput
  };
}
