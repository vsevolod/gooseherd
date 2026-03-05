import dotenv from "dotenv";
dotenv.config({ override: true });

import path from "node:path";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { loadConfig, resolveGitHubAuthMode, type AppConfig } from "../src/config.js";
import { RunStore } from "../src/store.js";
import { GitHubService } from "../src/github.js";
import { PipelineEngine } from "../src/pipeline/index.js";
import { RunManager } from "../src/run-manager.js";
import type { RunRecord } from "../src/types.js";
import { ContainerManager } from "../src/sandbox/container-manager.js";
import { setSandboxManager } from "../src/pipeline/shell.js";

function stubWebClient() {
  return {
    chat: {
      postMessage: async () => ({ ok: true, ts: "0000000000.000001" }),
      update: async () => ({ ok: true })
    }
  } as any;
}

async function waitForRunCompletion(store: RunStore, runId: string, timeoutMs: number): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run) {
      const phase = run.phase ?? run.status;
      if (phase !== lastPhase) {
        const elapsed = run.startedAt ? `${Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)}s` : "?";
        console.log(`[${run.id.slice(0, 8)}] ${lastPhase || "start"} -> ${phase} (${elapsed})`);
        lastPhase = phase;
      }
      if (run.status === "completed" || run.status === "failed") return run;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Run ${runId} did not complete in ${Math.round(timeoutMs / 1000)}s`);
}

async function main() {
  const base = loadConfig();
  const authMode = resolveGitHubAuthMode(base);
  if (authMode === "none") {
    throw new Error("No GitHub auth configured");
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const repoRoot = process.cwd();
  const workRoot = path.join(repoRoot, ".work-live");
  const dataDir = path.join(repoRoot, ".data-live");
  await mkdir(workRoot, { recursive: true });

  const config: AppConfig = {
    ...base,
    workRoot,
    dataDir,
    dryRun: false,
    validationCommand: "",
    lintFixCommand: "",
    localTestCommand: "",
    ciWaitEnabled: false,
    browserVerifyEnabled: true,
    screenshotEnabled: true,
    browserVerifyModel: process.env.LIVE_BROWSER_VERIFY_MODEL || base.browserVerifyModel || "openai/gpt-4.1-mini",
    browserVerifyExecutionModel: process.env.LIVE_BROWSER_VERIFY_EXECUTION_MODEL || "google/gemini-3.1-flash-lite-preview",
    browserVerifyExecTimeoutMs: Number(process.env.LIVE_BROWSER_VERIFY_EXEC_TIMEOUT_MS || 300000),
    browserVerifyMaxSteps: Number(process.env.LIVE_BROWSER_VERIFY_MAX_STEPS || base.browserVerifyMaxSteps || 15),
    agentTimeoutSeconds: Math.max(base.agentTimeoutSeconds, 480),
    // This one-off run uses a dedicated work root; sandbox host path must match it.
    sandboxHostWorkPath: workRoot
  };

  const decideModelOverride = process.env.LIVE_DECIDE_MODEL?.trim();
  const decideFallbackOverride = process.env.LIVE_DECIDE_FALLBACK_MODEL?.trim();
  if (decideModelOverride || decideFallbackOverride) {
    const basePipelinePath = path.resolve(repoRoot, config.pipelineFile);
    const basePipeline = await readFile(basePipelinePath, "utf8");
    const patchedPipeline = patchDecideRecoveryModels(basePipeline, decideModelOverride, decideFallbackOverride);
    const overridePipelinePath = path.join(workRoot, `pipeline-override-${Date.now()}.yml`);
    await writeFile(overridePipelinePath, patchedPipeline, "utf8");
    config.pipelineFile = overridePipelinePath;
  }

  console.log("Live run config:");
  console.log("- repo: epiccoders/pxls");
  console.log(`- browser verify model: ${config.browserVerifyModel}`);
  console.log(`- browser verify execution model: ${config.browserVerifyExecutionModel ?? "(same)"}`);
  console.log(`- browser verify timeout ms: ${config.browserVerifyExecTimeoutMs}`);
  console.log(`- pipeline file: ${config.pipelineFile}`);
  console.log(`- dryRun: ${String(config.dryRun)}`);

  const store = new RunStore(dataDir);
  await store.init();
  const github = GitHubService.create(config);

  let containerManager: ContainerManager | undefined;
  if (config.sandboxEnabled) {
    if (!config.sandboxHostWorkPath) {
      throw new Error("SANDBOX_HOST_WORK_PATH is required when SANDBOX_ENABLED=true");
    }
    containerManager = new ContainerManager();
    const dockerOk = await containerManager.ping();
    if (!dockerOk) {
      throw new Error("Docker daemon not reachable");
    }
    await containerManager.cleanupOrphans();
    setSandboxManager(containerManager, config.workRoot);
    console.log(`- sandbox image: ${config.sandboxImage}`);
  }

  const engine = new PipelineEngine(config, github, undefined, containerManager);
  const runManager = new RunManager(config, store, engine, stubWebClient());

  const threadTs = `live-auth-${Date.now()}.000000`;
  const task = process.env.LIVE_TASK || [
    'Update the visible user edit page heading text to exactly "I AM LIVE QA" on epiccoders/pxls.',
    "Target the UI text shown on /user/edit (not the browser tab <title>).",
    "Keep the diff minimal and do not touch unrelated files.",
    "Verification requirement: this route is auth-gated; browser verification should sign up or log in if needed and then validate /user/edit."
  ].join(" ");

  const run = await runManager.enqueueRun({
    repoSlug: "epiccoders/pxls",
    task,
    baseBranch: config.defaultBaseBranch,
    requestedBy: "live-auth-e2e",
    channelId: "local",
    threadTs,
    enableNodes: ["deploy_preview", "browser_verify", "summarize_changes", "upload_screenshot", "decide_recovery"]
  });

  console.log(`Queued run: ${run.id}`);
  console.log(`Branch: ${run.branchName}`);

  const done = await waitForRunCompletion(store, run.id, 1_800_000);

  console.log("\n=== Final Run ===");
  console.log(`status: ${done.status}`);
  console.log(`phase: ${done.phase}`);
  console.log(`pr: ${done.prUrl ?? "none"}`);
  console.log(`commit: ${done.commitSha ?? "none"}`);
  console.log(`changed files: ${(done.changedFiles ?? []).join(", ") || "none"}`);
  if (done.error) console.log(`error: ${done.error}`);

  const runDir = path.join(workRoot, run.id);
  const logsPath = done.logsPath || path.join(runDir, "run.log");
  try {
    const logs = await readFile(logsPath, "utf8");
    const tail = logs.split("\n").slice(-120).join("\n");
    console.log("\n=== Log Tail (120 lines) ===");
    console.log(tail);
  } catch (e) {
    console.log(`Unable to read logs: ${String(e)}`);
  }

  try {
    const screenshotsDir = path.join(runDir, "screenshots");
    await access(screenshotsDir);
    const screenshots = await readdir(screenshotsDir);
    console.log(`\nScreenshots: ${screenshots.join(", ") || "none"}`);
  } catch {
    console.log("\nScreenshots: none");
  }

  try {
    const videoPath = path.join(runDir, "verification.mp4");
    await access(videoPath);
    console.log("Video: verification.mp4 exists");
  } catch {
    console.log("Video: none");
  }

  process.exit(done.status === "completed" ? 0 : 1);
}

function patchDecideRecoveryModels(
  source: string,
  decideModelOverride?: string,
  decideFallbackOverride?: string
): string {
  const lines = source.split("\n");
  let inDecide = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*-\s+id:\s+decide_recovery\b/.test(line)) {
      inDecide = true;
      continue;
    }

    if (inDecide && /^\s*-\s+id:\s+/.test(line)) {
      inDecide = false;
      continue;
    }

    if (!inDecide) continue;

    if (decideModelOverride && /^\s*model:\s*/.test(line)) {
      lines[i] = line.replace(/^\s*model:\s*.*/, `      model: ${decideModelOverride}`);
      continue;
    }

    if (decideFallbackOverride && /^\s*fallback_model:\s*/.test(line)) {
      lines[i] = line.replace(/^\s*fallback_model:\s*.*/, `      fallback_model: ${decideFallbackOverride}`);
    }
  }

  return lines.join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
