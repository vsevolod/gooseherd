import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, runShellCapture, shellEscape, renderTemplate, appendLog, buildMcpFlags, mapToContainerPath } from "../shell.js";

/**
 * Fix Browser node: "fat" agent node that fixes browser verification failures.
 *
 * Like fix_ci, this node commits+pushes internally and then waits for the
 * preview deployment to update before browser_verify re-runs.
 *
 * Called by the pipeline engine's on_failure loop when browser_verify fails.
 */
export async function fixBrowserNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const run = deps.run;
  const attempt = ctx.get<number>("loopAttempt") ?? 1;

  await deps.onPhase("ci_fixing");
  await appendLog(logFile, `\n[browser:fix] starting browser fix attempt ${String(attempt)}\n`);

  // Read browser verify failure context
  const verdictReason = ctx.get<string>("browserVerifyVerdictReason") ?? "Browser verification failed";
  const domFindings = ctx.get<string[]>("browserVerifyDomFindings") ?? [];
  const reviewAppUrl = ctx.get<string>("reviewAppUrl") ?? "";
  const task = run.task;
  const changedFiles = ctx.get<string[]>("changedFiles") ?? [];

  // Build fix prompt
  const fixPrompt = buildBrowserFixPrompt(task, verdictReason, domFindings, changedFiles, reviewAppUrl);

  // Write fix prompt to disk for the agent
  const runDir = ctx.getRequired<string>("runDir");
  const fixPromptFile = path.join(runDir, `browser-fix-round-${String(attempt)}.md`);
  await writeFile(fixPromptFile, fixPrompt, "utf8");

  // Run the coding agent
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const template = isFollowUp && config.agentFollowUpTemplate
    ? config.agentFollowUpTemplate
    : config.agentCommandTemplate;

  const agentCommand = renderTemplate(template, {
    repo_dir: mapToContainerPath(repoDir),
    prompt_file: mapToContainerPath(fixPromptFile),
    task_file: mapToContainerPath(fixPromptFile),
    run_id: run.id,
    repo_slug: run.repoSlug,
    parent_run_id: run.parentRunId ?? ""
  });

  let cmd = agentCommand;
  const mcpFlags = buildMcpFlags(config.mcpExtensions);
  if (mcpFlags) {
    cmd = `${cmd} ${mcpFlags}`;
  }

  await runShell(cmd, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000
  });

  // Check if agent made any changes
  const diffCheck = await runShellCapture("git status --porcelain", { cwd: repoDir, logFile });
  if (diffCheck.code === 0 && diffCheck.stdout.trim() === "") {
    await appendLog(logFile, "\n[browser:fix] agent made no changes — nothing to commit\n");
    return { outcome: "failure", error: "Fix agent made no changes" };
  }

  // Commit the fix
  await runShell("git add -A", { cwd: repoDir, logFile });

  const commitMsg = `${config.appSlug}: fix browser verification (attempt ${String(attempt)})`;
  await runShell(`git commit -m ${shellEscape(commitMsg)}`, { cwd: repoDir, logFile });

  // Capture new commit SHA
  const shaResult = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  const newSha = shaResult.stdout.trim().split("\n").pop()?.trim() ?? "";

  // Push the fix
  await runShell(`git push origin ${shellEscape(run.branchName)}`, {
    cwd: repoDir,
    logFile
  });

  // Update commitSha so downstream nodes see the new commit
  ctx.set("commitSha", newSha);

  // Update changed files
  const filesResult = await runShellCapture("git show --name-only --pretty='' HEAD", { cwd: repoDir, logFile });
  if (filesResult.code === 0) {
    const newChangedFiles = filesResult.stdout
      .split("\n")
      .map(f => f.trim())
      .filter(f => f.length > 0 && !f.startsWith("---"));
    ctx.set("changedFiles", newChangedFiles);
  }

  await appendLog(logFile, `\n[browser:fix] pushed fix commit ${newSha.slice(0, 8)}\n`);

  // Wait for the preview deployment to update
  if (reviewAppUrl) {
    await appendLog(logFile, `\n[browser:fix] waiting for preview to redeploy: ${reviewAppUrl}\n`);
    await waitForPreviewRedeploy(reviewAppUrl, 180_000, logFile);
  }

  return {
    outcome: "success",
    outputs: { commitSha: newSha }
  };
}

function buildBrowserFixPrompt(
  task: string,
  verdictReason: string,
  domFindings: string[],
  changedFiles: string[],
  reviewAppUrl: string
): string {
  const parts: string[] = [
    "# Browser Verification Fix Required\n",
    `## Original Task\n${task}\n`,
    `## What Went Wrong\nThe browser verification check FAILED after deployment. The QA system inspected the live preview at ${reviewAppUrl} and found problems.\n`,
    `### Verdict\n${verdictReason}\n`
  ];

  if (domFindings.length > 0) {
    parts.push(`### DOM Inspection Results\n${domFindings.map(f => `- ${f}`).join("\n")}\n`);
  }

  if (changedFiles.length > 0) {
    parts.push(`### Files Changed\n${changedFiles.map(f => `- ${f}`).join("\n")}\n`);
  }

  parts.push(
    "## Instructions",
    "Fix the code so that the visual verification passes. Focus on:",
    "1. Ensuring the requested changes are actually visible in the rendered page",
    "2. Fix any CSS/HTML issues that prevent elements from appearing correctly",
    "3. Make sure template syntax is correct (e.g. Slim indentation, ERB tags)",
    "4. Do NOT change unrelated code — only fix the specific issues identified above",
    "",
    "Note: If the browser verification failure mentions a login page, authentication redirect,",
    "or \"page appears blank\" — this may be an authentication issue, not a code bug. The browser",
    "verification system handles auth separately. Focus only on fixing the actual UI implementation",
    "matching the original task requirements.",
    ""
  );

  return parts.join("\n");
}

/**
 * Wait for the preview URL to go through a rebuild cycle (502/503)
 * and come back up, indicating the new deployment is live.
 */
async function waitForPreviewRedeploy(
  url: string,
  timeoutMs: number,
  logFile: string
): Promise<void> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let sawDowntime = false;
  let intervalMs = 5_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
        redirect: "follow"
      });
      const status = response.status;
      await response.body?.cancel();

      if (status === 502 || status === 503) {
        sawDowntime = true;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed % 15 < 6) {
          await appendLog(logFile, `[browser:fix] preview rebuilding (HTTP ${String(status)}, ${String(elapsed)}s)\n`);
        }
      } else if (sawDowntime && status >= 200 && status < 400) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        await appendLog(logFile, `[browser:fix] preview back up after ${String(elapsed)}s\n`);
        return;
      } else if (!sawDowntime && (Date.now() - startTime) > 30_000) {
        // No downtime detected after 30s — rebuild may be instant or we missed the window
        await sleep(10_000);
        await appendLog(logFile, "[browser:fix] no downtime detected, assuming deployment is live\n");
        return;
      }
    } catch {
      sawDowntime = true;
    }

    await sleep(intervalMs);
    intervalMs = Math.min(Math.floor(intervalMs * 1.5), 15_000);
  }

  await appendLog(logFile, `[browser:fix] redeploy wait timed out after ${String(Math.floor(timeoutMs / 1000))}s\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
