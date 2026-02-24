/**
 * Local Test Node — run project tests locally before committing.
 *
 * Executes the configured LOCAL_TEST_COMMAND in the repo directory.
 * Skips if no command is configured.
 * Returns failure with structured output for fix_validation loops.
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, appendLog } from "../shell.js";

export async function localTestNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");

  if (!config.localTestCommand.trim()) {
    return { outcome: "skipped" };
  }

  await appendLog(logFile, "\n[pipeline] local_test: running project tests\n");

  const result = await runShellCapture(config.localTestCommand, {
    cwd: repoDir,
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000
  });

  if (result.code === 0) {
    await appendLog(logFile, "\n[pipeline] local_test: passed\n");
    return { outcome: "success" };
  }

  const rawOutput = (result.stderr || result.stdout);
  await appendLog(logFile, "\n[pipeline] local_test: failed\n");

  return {
    outcome: "failure",
    error: `Tests failed with exit code ${String(result.code)}`,
    rawOutput
  };
}
