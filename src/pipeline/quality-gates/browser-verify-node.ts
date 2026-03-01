/**
 * Browser Verify node — interactive verification via Stagehand agent.
 *
 * Flow:
 * 1. Curl smoke test (fast, always runs)
 * 2. Pa11y accessibility (if available)
 * 3. Stagehand agent verification:
 *    a. Launch headless browser, navigate to preview URL
 *    b. Agent autonomously navigates, interacts, handles auth
 *    c. Structured verdict via Zod schema: {passed, confidence, reasoning}
 *    d. Screenshots captured before/after verification
 * 4. Aggregate results and return artifacts
 *
 * Graceful degradation: if Stagehand fails to init (missing chromium, etc.),
 * falls back to Playwright screenshot + LLM vision check (no interactivity).
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, appendLog, shellEscape, mapToContainerPath, isInSandbox } from "../shell.js";
import { appendGateReport } from "./gate-report.js";
import { logInfo } from "../../logger.js";
import {
  parsePa11yOutput,
  buildSmokeCheck,
  aggregateChecks,
  resolveReviewAppUrl,
  verifyFeatureVisually,
  type VisualVerifyResult,
  type BrowserCheck
} from "./browser-verify.js";
import type { LLMCallerConfig } from "../../llm/caller.js";
import { runStagehandVerification } from "./stagehand-verify.js";

export async function browserVerifyNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;

  // Check if enabled (deployment config, node config, or per-repo config)
  const repoEnabled = ctx.get<boolean>("repoBrowserVerifyEnabled");
  if (!config.browserVerifyEnabled && nodeConfig.enabled !== true && repoEnabled !== true) {
    await appendLog(logFile, "\n[gate:browser_verify] skipped (disabled)\n");
    return { outcome: "skipped" };
  }

  // Resolve review app URL
  let reviewAppUrl = ctx.get<string>("reviewAppUrl");

  if (!reviewAppUrl && config.reviewAppUrlPattern) {
    reviewAppUrl = resolveReviewAppUrl(config.reviewAppUrlPattern, {
      prNumber: ctx.get<string>("prNumber") ?? String(ctx.get<number>("prNumber") ?? ""),
      branchName: ctx.get<string>("branchName"),
      repoSlug: ctx.get<string>("repoSlug")
    });
  }

  // Also check node config for URL override
  const nc = nodeConfig.config as Record<string, unknown> | undefined;
  if (nc?.["review_app_url"]) {
    reviewAppUrl = nc["review_app_url"] as string;
  }

  // Check for test credentials in node config
  if (nc?.["test_email"] && nc?.["test_password"]) {
    const configCreds = { email: nc["test_email"] as string, password: nc["test_password"] as string };
    if (!ctx.get("browserVerifyCredentials")) {
      ctx.set("browserVerifyCredentials", configCreds);
    }
  }

  if (!reviewAppUrl) {
    await appendLog(logFile, "\n[gate:browser_verify] skipped (no review app URL)\n");
    appendGateReport(ctx, "browser_verify", "skipped", ["No review app URL available"]);
    return { outcome: "skipped" };
  }

  // Validate URL scheme to prevent SSRF
  if (!reviewAppUrl.startsWith("https://") && !reviewAppUrl.startsWith("http://")) {
    await appendLog(logFile, "\n[gate:browser_verify] skipped (invalid URL scheme)\n");
    appendGateReport(ctx, "browser_verify", "skipped", ["Invalid URL scheme (must be http/https)"]);
    return { outcome: "skipped" };
  }

  await appendLog(logFile, `\n[gate:browser_verify] checking: ${reviewAppUrl}\n`);

  // 1. Smoke test via curl
  const escapedUrl = shellEscape(reviewAppUrl);
  const curlResult = await runShellCapture(
    `curl -s -o /dev/null -w "%{http_code}" --max-time 30 ${escapedUrl}`,
    { cwd: deps.workRoot, logFile }
  );

  const statusCode = curlResult.code === 0 ? Number.parseInt(curlResult.stdout.trim(), 10) : 0;
  const smokeCheck = buildSmokeCheck(statusCode || 0, []);

  await appendLog(logFile, `[gate:browser_verify] smoke test: HTTP ${String(statusCode)}\n`);

  // 2. Accessibility test via pa11y (if available)
  const pa11yAvailable = await checkPa11yAvailable(deps.workRoot, logFile);
  let accessibilityChecked = false;
  const checks: BrowserCheck[] = [smokeCheck];

  if (pa11yAvailable && smokeCheck.passed) {
    const pa11yResult = await runShellCapture(
      `npx pa11y${isInSandbox() ? " --config /etc/pa11y.json" : ""} --reporter json --timeout 30000 ${escapedUrl}`,
      { cwd: deps.workRoot, logFile }
    );

    const accessCheck = parsePa11yOutput(pa11yResult.stdout);
    checks.push(accessCheck);
    accessibilityChecked = true;

    await appendLog(logFile, `[gate:browser_verify] accessibility: ${accessCheck.passed ? "pass" : "fail"} — ${accessCheck.details.split("\n")[0]}\n`);
  } else if (!pa11yAvailable) {
    await appendLog(logFile, "[gate:browser_verify] pa11y not available, skipping accessibility check\n");
  }

  // 3. Interactive verification via Stagehand agent
  const runDir = path.resolve(deps.workRoot, deps.run.id);
  await mkdir(runDir, { recursive: true });

  let screenshotPath: string | undefined;
  let verifyResult: VisualVerifyResult | undefined;
  let verifyCheck: BrowserCheck | undefined;
  let planTokenUsage: { input: number; output: number } | undefined;
  let domFindings: string[] | undefined;

  // Resolve API key for Stagehand: prefer direct provider keys over OpenRouter
  const isAnthropicModel = config.browserVerifyModel.startsWith("anthropic/");
  const isOpenAIModel = config.browserVerifyModel.startsWith("openai/")
    || config.browserVerifyModel.startsWith("gpt-")
    || config.browserVerifyModel.startsWith("o1")
    || config.browserVerifyModel.startsWith("o3")
    || config.browserVerifyModel.startsWith("o4");
  let stagehandApiKey: string | undefined;
  let stagehandBaseURL: string | undefined;
  if (isAnthropicModel && config.anthropicApiKey) {
    stagehandApiKey = config.anthropicApiKey;
    stagehandBaseURL = undefined;
  } else if (isOpenAIModel && config.openaiApiKey) {
    stagehandApiKey = config.openaiApiKey;
    stagehandBaseURL = undefined;
  } else {
    stagehandApiKey = config.openrouterApiKey;
    stagehandBaseURL = stagehandApiKey ? "https://openrouter.ai/api/v1" : undefined;
  }

  if (smokeCheck.passed && stagehandApiKey) {
    // Get credentials (persisted across fix_browser retries)
    const savedCreds = ctx.get<{ email: string; password: string }>("browserVerifyCredentials");

    try {
      const result = await runStagehandVerification(
        reviewAppUrl,
        deps.run.task,
        ctx.get<string[]>("changedFiles") ?? [],
        runDir,
        stagehandApiKey,
        config.browserVerifyModel,
        logFile,
        savedCreds ?? undefined,
        ctx.get<string>("changeSummary"),
        stagehandBaseURL,
        config.browserVerifyExecutionModel
      );
      screenshotPath = result.screenshotPath;
      verifyResult = result.verifyResult;
      planTokenUsage = result.planTokens;
      domFindings = result.domFindings;

      if (result.videoPath) {
        ctx.set("videoPath", result.videoPath);
        logInfo("browser_verify: video recorded", { path: result.videoPath });
      }
      if (result.consolePath) {
        ctx.set("consolePath", result.consolePath);
      }
      if (result.networkPath) {
        ctx.set("networkPath", result.networkPath);
      }
      if (result.actionsPath) {
        ctx.set("actionsPath", result.actionsPath);
      }
    } catch (error) {
      // Stagehand failed — fall back to screenshot + vision
      const msg = error instanceof Error ? error.message : "Unknown error";
      await appendLog(logFile, `[gate:browser_verify] stagehand failed, falling back to screenshot: ${msg}\n`);

      screenshotPath = await captureScreenshotFallback(reviewAppUrl, runDir, logFile);
      if (screenshotPath && stagehandApiKey) {
        const llmConfig: LLMCallerConfig = {
          apiKey: config.openrouterApiKey ?? stagehandApiKey,
          defaultModel: config.browserVerifyModel,
          defaultTimeoutMs: 30_000
        };
        try {
          verifyResult = await verifyFeatureVisually(
            llmConfig,
            screenshotPath,
            deps.run.task,
            ctx.get<string[]>("changedFiles") ?? [],
            config.browserVerifyModel
          );
        } catch (visionError) {
          const visionMsg = visionError instanceof Error ? visionError.message : "Unknown error";
          await appendLog(logFile, `[gate:browser_verify] vision fallback also failed: ${visionMsg}\n`);
        }
      }
    }

    if (verifyResult) {
      verifyCheck = {
        name: "feature_verification",
        passed: verifyResult.passed,
        details: `[${verifyResult.confidence}] ${verifyResult.reasoning}`
      };
      checks.push(verifyCheck);
      await appendLog(logFile, `[gate:browser_verify] LLM verdict: ${verifyResult.passed ? "PASS" : "FAIL"} (${verifyResult.confidence}) — ${verifyResult.reasoning}\n`);
    } else if (screenshotPath) {
      // Verification was attempted but failed — don't silently pass
      verifyCheck = {
        name: "feature_verification",
        passed: false,
        details: "Feature verification inconclusive — verification failed or no verdict available"
      };
      checks.push(verifyCheck);
      await appendLog(logFile, "[gate:browser_verify] feature verification inconclusive (no verdict)\n");
    }
  } else if (!stagehandApiKey) {
    await appendLog(logFile, "[gate:browser_verify] no API key (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY), skipping LLM verification\n");
    if (smokeCheck.passed && config.screenshotEnabled) {
      screenshotPath = await captureScreenshotFallback(reviewAppUrl, runDir, logFile);
    }
  }

  // Store screenshot path in context for upload_screenshot node
  if (screenshotPath) {
    ctx.set("screenshotPath", screenshotPath);
    logInfo("browser_verify: screenshot captured", { path: screenshotPath });
  }

  // Aggregate results
  const result = aggregateChecks(checks);
  const reasons = result.errors;

  // Token usage from LLM verification
  const tokenUsage: Record<string, { input: number; output: number }> = {};
  if (planTokenUsage) {
    tokenUsage._tokenUsage_browserVerifyPlan = planTokenUsage;
  }
  if (verifyResult) {
    tokenUsage._tokenUsage_browserVerifyVision = {
      input: verifyResult.inputTokens,
      output: verifyResult.outputTokens
    };
  }

  if (!result.overallPass) {
    const verdictReason = verifyResult
      ? `[${verifyResult.confidence}] ${verifyResult.reasoning}`
      : reasons.join("; ");

    appendGateReport(ctx, "browser_verify", "failure", reasons);
    return {
      outcome: "failure",
      error: `Browser verification failed:\n${reasons.join("\n")}`,
      outputs: {
        browserVerifyResult: result,
        browserVerifyVerdictReason: verdictReason,
        browserVerifyDomFindings: domFindings ?? [],
        accessibilityChecked,
        screenshotPath,
        ...tokenUsage
      }
    };
  }

  appendGateReport(ctx, "browser_verify", "pass", reasons);
  return {
    outcome: "success",
    outputs: { browserVerifyResult: result, accessibilityChecked, screenshotPath, ...tokenUsage }
  };
}

// ── Fallback: Playwright screenshot (no Stagehand) ──

async function captureScreenshotFallback(
  url: string,
  runDir: string,
  logFile: string
): Promise<string | undefined> {
  const screenshotsDir = path.join(runDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const screenshotFile = path.join(screenshotsDir, "final.png");
  const scriptScreenshotPath = mapToContainerPath(screenshotFile);

  const script = [
    "const { chromium } = require('playwright');",
    "(async () => {",
    "  const opts = { args: ['--no-sandbox', '--disable-gpu'] };",
    "  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) opts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;",
    "  const browser = await chromium.launch(opts);",
    "  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });",
    `  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });`,
    `  await page.screenshot({ path: ${JSON.stringify(scriptScreenshotPath)}, fullPage: true });`,
    "  await browser.close();",
    "})();"
  ].join("\n");

  const result = await runShellCapture(
    `node -e ${shellEscape(script)}`,
    { cwd: runDir, logFile, timeoutMs: 60_000 }
  );

  if (result.code === 0) {
    return screenshotFile;
  }

  await appendLog(logFile, `[gate:browser_verify] screenshot fallback failed: ${result.stderr.slice(0, 200)}\n`);
  return undefined;
}

// ── Availability checks ──

async function checkPa11yAvailable(cwd: string, logFile: string): Promise<boolean> {
  const result = await runShellCapture("which pa11y 2>/dev/null || npx --no-install pa11y --version 2>/dev/null", { cwd, logFile });
  return result.code === 0;
}
