#!/usr/bin/env npx tsx
/**
 * Browser-verify-only test harness.
 *
 * Runs JUST the Stagehand browser verification against an already-deployed URL.
 * No clone, no implement, no push — pure browser verify iteration.
 *
 * Usage:
 *   npx tsx scripts/browser-verify-only.ts [URL] [TASK]
 *
 * Environment:
 *   LIVE_BROWSER_VERIFY_MODEL         (default: openai/gpt-4.1-mini)
 *   LIVE_BROWSER_VERIFY_EXECUTION_MODEL (default: google/gemini-3.1-flash-lite-preview)
 *   LIVE_BROWSER_VERIFY_MAX_STEPS     (default: 15)
 *   LIVE_BROWSER_VERIFY_EXEC_TIMEOUT_MS (default: 300000)
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import path from "node:path";
import { mkdir, readFile, access, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { runStagehandVerification } from "../src/pipeline/quality-gates/stagehand-verify.js";
import { resolveStagehandProvider } from "../src/pipeline/quality-gates/browser-verify-routing.js";
import { appendLog } from "../src/pipeline/shell.js";

async function main() {
  const base = loadConfig();

  const url = process.argv[2] || "https://663.stg.epicpxls.com";
  const task = process.argv[3] || [
    'Verify that the visible heading text on /user/edit says exactly "I AM LIVE QA".',
    "This route is auth-gated; sign up or log in if needed.",
    "You MUST navigate to /user/edit to verify — do not claim success from the homepage or login page."
  ].join(" ");
  const changedFiles = (process.argv[4] || "app/views/users/edit.html.slim").split(",");

  const model = process.env.LIVE_BROWSER_VERIFY_MODEL || "openai/gpt-4.1-mini";
  const executionModel = process.env.LIVE_BROWSER_VERIFY_EXECUTION_MODEL || "google/gemini-3.1-flash-lite-preview";
  const maxSteps = Number(process.env.LIVE_BROWSER_VERIFY_MAX_STEPS || 15);
  const timeoutMs = Number(process.env.LIVE_BROWSER_VERIFY_EXEC_TIMEOUT_MS || 300000);

  const runId = randomUUID();
  const repoRoot = process.cwd();
  const workRoot = path.join(repoRoot, ".work-live");
  const runDir = path.join(workRoot, runId);
  const logFile = path.join(runDir, "run.log");
  await mkdir(runDir, { recursive: true });
  await appendLog(logFile, "");

  // Resolve provider
  const resolution = resolveStagehandProvider(model, executionModel, {
    ...base,
    browserVerifyModel: model,
    browserVerifyExecutionModel: executionModel
  });

  if (!resolution.ok || !resolution.apiKey) {
    console.error(`Provider resolution failed: ${resolution.reason}`);
    process.exit(1);
  }

  // Build signup profile
  const slug = "pxls";
  const token = `${Date.now().toString(36)}${runId.replace(/-/g, "").slice(0, 6)}`;
  const signupProfile = {
    fullName: "QA Browser Verify",
    preferredEmail: `qa+${slug}-${token}-a@epicpxls.com`,
    backupEmails: [
      `qa+${slug}-${token}-b@gmail.com`,
      `qa+${slug}-${token}-c@outlook.com`
    ],
    password: `Qa!${token}#2026`
  };

  console.log("Browser Verify Only");
  console.log("=".repeat(50));
  console.log(`URL:              ${url}`);
  console.log(`Task:             ${task.slice(0, 80)}...`);
  console.log(`Model:            ${model}`);
  console.log(`Execution model:  ${executionModel}`);
  console.log(`Max steps:        ${maxSteps}`);
  console.log(`Run dir:          ${runDir}`);
  console.log(`Signup email:     ${signupProfile.preferredEmail}`);
  console.log("=".repeat(50));
  console.log("");

  const startMs = Date.now();

  try {
    const result = await runStagehandVerification(
      url,
      task,
      changedFiles,
      runDir,
      resolution.apiKey,
      model,
      logFile,
      undefined, // no credentials
      undefined, // no changeSummary
      resolution.baseURL,
      executionModel,
      maxSteps,
      timeoutMs,
      { allowSignup: true, preferSignupWithoutCredentials: true },
      signupProfile
    );

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Elapsed: ${elapsed}s`);
    console.log(`Verdict: ${result.verifyResult?.passed ? "PASS" : "FAIL"} (${result.verifyResult?.confidence ?? "?"})`);
    console.log(`Reason:  ${result.verifyResult?.reasoning ?? "no verdict"}`);
    console.log(`Screenshot: ${result.screenshotPath ?? "none"}`);
    console.log(`Video: ${result.videoPath ?? "none"}`);
    console.log(`Actions: ${result.actionsPath ?? "none"}`);

    if (result.domFindings && result.domFindings.length > 0) {
      console.log(`\nAgent reasoning (${result.domFindings.length} steps):`);
      for (const f of result.domFindings.slice(-5)) {
        console.log(`  - ${f.slice(0, 150)}`);
      }
    }

    // Print last 20 lines of log for quick debugging
    console.log(`\n${"─".repeat(50)}`);
    console.log("Log tail:");
    const log = await readFile(logFile, "utf8");
    const logLines = log.split("\n").filter(Boolean);
    for (const line of logLines.slice(-20)) {
      console.log(`  ${line}`);
    }

    // List artifacts
    try {
      const screenshotsDir = path.join(runDir, "screenshots");
      await access(screenshotsDir);
      const files = await readdir(screenshotsDir);
      console.log(`\nScreenshots: ${files.join(", ")}`);
    } catch { /* no screenshots dir */ }

    process.exit(result.verifyResult?.passed ? 0 : 1);
  } catch (error) {
    const msg = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`\nFATAL: ${msg}`);
    const log = await readFile(logFile, "utf8").catch(() => "");
    if (log) {
      console.error("\nLog tail:");
      for (const line of log.split("\n").slice(-15)) {
        console.error(`  ${line}`);
      }
    }
    process.exit(2);
  }
}

main();
