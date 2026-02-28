import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import type { AgentAnalysis } from "./implement.js";
import { buildPrBody } from "./create-pr.js";
import { appendLog } from "../shell.js";
import { logInfo, logError } from "../../logger.js";

/**
 * Upload Screenshot node: uploads screenshots to the PR branch
 * and updates the PR body to include them. Runs after browser_verify.
 *
 * Uploads:
 * - The best screenshot (prefers step screenshots over blank final)
 *
 * Skips gracefully if no screenshot or no PR exists.
 */
export async function uploadScreenshotNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const logFile = deps.logFile;
  const screenshotPath = ctx.get<string>("screenshotPath");
  const prNumber = ctx.get<number>("prNumber");

  if (!screenshotPath || !prNumber || !deps.githubService) {
    await appendLog(logFile, "\n[upload_screenshot] skipped (no screenshot, PR, or GitHub service)\n");
    return { outcome: "skipped" };
  }

  const run = deps.run;
  const config = deps.config;

  // Resolve the best screenshot before proceeding
  const bestScreenshot = screenshotPath ? await pickBestScreenshot(screenshotPath, run.id) : undefined;

  if (!bestScreenshot) {
    await appendLog(logFile, `\n[upload_screenshot] skipped (no valid screenshot found)\n`);
    return { outcome: "skipped" };
  }

  try {
    const repoPath = `.gooseherd/screenshots/${run.id}.png`;
    const uploadResult = await deps.githubService.uploadFileToRepo({
      repoSlug: run.repoSlug,
      branch: run.branchName,
      filePath: repoPath,
      localPath: bestScreenshot,
      commitMessage: `chore: add screenshot for ${run.id.slice(0, 8)}`
    });
    const screenshotUrl = uploadResult.url;

    await appendLog(logFile, `[upload_screenshot] screenshot uploaded: ${screenshotUrl}\n`);
    logInfo("upload_screenshot: uploaded", { url: screenshotUrl });

    // Update commitSha so downstream nodes (wait_ci) track the right commit
    ctx.set("commitSha", uploadResult.commitSha);

    // Rebuild PR body with screenshot URL and update the PR
    const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
    const resolvedBaseBranch = ctx.get<string>("resolvedBaseBranch") ?? run.baseBranch;
    const gateReport = ctx.get<Array<{ gate: string; verdict: string; reasons: string[] }>>("gateReport");
    const agentAnalysis = ctx.get<AgentAnalysis>("agentAnalysis");
    const commitSha = ctx.get<string>("commitSha");
    const changedFiles = ctx.get<string[]>("changedFiles");

    const updatedBody = buildPrBody(
      run, resolvedBaseBranch, config.appName, isFollowUp,
      gateReport, agentAnalysis, commitSha, changedFiles, screenshotUrl
    );

    await deps.githubService.updatePullRequestBody({
      repoSlug: run.repoSlug,
      prNumber,
      body: updatedBody
    });

    await appendLog(logFile, "[upload_screenshot] PR body updated with media\n");
    ctx.set("screenshotUrl", screenshotUrl);

    return {
      outcome: "success",
      outputs: { screenshotUrl }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logError("upload_screenshot: failed", { error: message });
    await appendLog(logFile, `[upload_screenshot] failed: ${message}\n`);
    // Non-fatal — media is nice-to-have
    return { outcome: "soft_fail", error: message };
  }
}

/**
 * Pick the best screenshot to upload. Prefers non-empty step screenshots
 * over the final screenshot (which may be blank if verification failed).
 */
async function pickBestScreenshot(screenshotPath: string | undefined, _runId: string): Promise<string | undefined> {
  if (!screenshotPath) return undefined;

  // Check if the designated screenshot exists
  let fileExists = false;
  let fileSize = 0;
  try {
    const s = await stat(screenshotPath);
    fileExists = true;
    fileSize = s.size;
    if (fileSize > 5_000) return screenshotPath;
  } catch {
    // File doesn't exist at all — nothing to upload
    return undefined;
  }

  // File exists but is tiny (likely blank) — scan for better alternatives
  const screenshotsDir = path.dirname(screenshotPath);
  try {
    const files = await readdir(screenshotsDir);
    const pngFiles = files
      .filter(f => f.endsWith(".png") && f !== "final.png")
      .sort()
      .reverse(); // Latest step first

    for (const file of pngFiles) {
      const filePath = path.join(screenshotsDir, file);
      const s = await stat(filePath);
      if (s.size > 5_000) return filePath;
    }
  } catch {
    // Directory scan failed — use original
  }

  // Fall back to original even if small
  return screenshotPath;
}
