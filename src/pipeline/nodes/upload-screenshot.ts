import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import type { AgentAnalysis } from "./implement.js";
import { buildPrBody } from "./create-pr.js";
import { appendLog } from "../shell.js";
import { logInfo, logError } from "../../logger.js";

/**
 * Upload Screenshot node: uploads screenshots and video to the PR branch
 * and updates the PR body to include them. Runs after browser_verify.
 *
 * Uploads:
 * - The best screenshot (prefers step screenshots over blank final)
 * - Verification video (if recorded)
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
    // Upload screenshot
    const repoPath = `.gooseherd/screenshots/${run.id}.png`;
    const uploadResult = await deps.githubService.uploadFileToRepo({
      repoSlug: run.repoSlug,
      branch: run.branchName,
      filePath: repoPath,
      localPath: bestScreenshot,
      commitMessage: `chore: add verification media for ${run.id.slice(0, 8)}`
    });
    const screenshotUrl = uploadResult.url;

    await appendLog(logFile, `[upload_screenshot] screenshot uploaded: ${screenshotUrl}\n`);
    logInfo("upload_screenshot: uploaded", { url: screenshotUrl });

    // Upload verification video (if exists)
    let videoUrl: string | undefined;
    let videoEmbedUrl: string | undefined;
    let videoCommitSha: string | undefined;
    const videoPath = ctx.get<string>("videoPath");
    if (!videoPath) {
      await appendLog(logFile, "[upload_screenshot] no video path in context — CDP recording may not have started\n");
    }
    if (videoPath) {
      try {
        const videoStat = await stat(videoPath);
        if (videoStat.size > 0 && videoStat.size < 50_000_000) { // Skip if >50MB
          const videoRepoPath = `.gooseherd/videos/${run.id}.mp4`;
          const videoResult = await deps.githubService.uploadFileToRepo({
            repoSlug: run.repoSlug,
            branch: run.branchName,
            filePath: videoRepoPath,
            localPath: videoPath,
            commitMessage: `chore: add verification video for ${run.id.slice(0, 8)}`
          });
          videoEmbedUrl = videoResult.url;
          videoCommitSha = videoResult.commitSha;
          videoUrl = buildGitHubBlobUrl(run.repoSlug, videoRepoPath, videoCommitSha) ?? videoEmbedUrl;
          await appendLog(logFile, `[upload_screenshot] video uploaded: ${videoUrl} (${Math.round(videoStat.size / 1024)}KB)\n`);
          logInfo("upload_screenshot: video uploaded", { url: videoUrl, sizeKB: Math.round(videoStat.size / 1024) });
        }
      } catch (videoErr) {
        const msg = videoErr instanceof Error ? videoErr.message : "unknown";
        await appendLog(logFile, `[upload_screenshot] video upload failed (non-fatal): ${msg}\n`);
      }
    }

    // Update commitSha so downstream nodes (wait_ci) track the right commit
    ctx.set("commitSha", videoCommitSha ?? uploadResult.commitSha);

    // Rebuild PR body with media URLs and update the PR
    const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
    const resolvedBaseBranch = ctx.get<string>("resolvedBaseBranch") ?? run.baseBranch;
    const gateReport = ctx.get<Array<{ gate: string; verdict: string; reasons: string[] }>>("gateReport");
    const agentAnalysis = ctx.get<AgentAnalysis>("agentAnalysis");
    const commitSha = ctx.get<string>("commitSha");
    const changedFiles = ctx.get<string[]>("changedFiles");
    const changeSummary = ctx.get<string>("changeSummary");

    const updatedBody = buildPrBody(
      run, resolvedBaseBranch, config.appName, isFollowUp,
      gateReport, agentAnalysis, commitSha, changedFiles,
      screenshotUrl, videoUrl, videoEmbedUrl, changeSummary
    );

    await deps.githubService.updatePullRequestBody({
      repoSlug: run.repoSlug,
      prNumber,
      body: updatedBody
    });

    await appendLog(logFile, "[upload_screenshot] PR body updated with media\n");
    ctx.set("screenshotUrl", screenshotUrl);
    if (videoUrl) ctx.set("videoUrl", videoUrl);
    if (videoEmbedUrl) ctx.set("videoEmbedUrl", videoEmbedUrl);

    return {
      outcome: "success",
      outputs: {
        screenshotUrl,
        ...(videoUrl ? { videoUrl } : {}),
        ...(videoEmbedUrl ? { videoEmbedUrl } : {})
      }
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
  try {
    const s = await stat(screenshotPath);
    if (s.size > 5_000) return screenshotPath;
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

function buildGitHubBlobUrl(repoSlug: string, filePath: string, commitSha?: string): string | undefined {
  if (!repoSlug || !filePath) return undefined;
  const ref = commitSha?.trim();
  if (!ref) return undefined;
  return `https://github.com/${repoSlug}/blob/${ref}/${filePath}`;
}
