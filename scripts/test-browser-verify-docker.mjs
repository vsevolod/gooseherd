#!/usr/bin/env node
/**
 * Minimal test that runs the PRODUCTION browser verify function inside Docker.
 * This calls the exact same runStagehandVerification() used in the pipeline.
 *
 * Usage (inside Docker):
 *   OPENAI_API_KEY=... node scripts/test-browser-verify-docker.mjs https://644.stg.epicpxls.com
 */

import path from "node:path";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { runStagehandVerification } from "../dist/pipeline/quality-gates/stagehand-verify.js";

const url = process.argv[2] || "https://644.stg.epicpxls.com";

async function main() {
  const runDir = path.resolve("/app/.work", `test-verify-${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  const logFile = path.join(runDir, "browser-verify.log");
  await writeFile(logFile, "");

  console.log(`URL:    ${url}`);
  console.log(`RunDir: ${runDir}`);

  // Resolve API key — prefer OPENAI_API_KEY for gpt-4.1-mini, fallback to OPENROUTER
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const apiKey = openaiKey || openrouterKey;
  const model = openaiKey ? "openai/gpt-4.1-mini" : "openai/gpt-4.1-mini";
  const baseURL = openaiKey ? undefined : "https://openrouter.ai/api/v1";

  if (!apiKey) {
    console.error("No API key! Set OPENAI_API_KEY or OPENROUTER_API_KEY");
    process.exit(1);
  }
  console.log(`Model:  ${model}`);
  console.log(`API:    ${openaiKey ? "OpenAI direct" : "OpenRouter"}`);

  const task = "Navigate the site, click Sign Up, fill in the form with test@example.com / TestPass123!, then go back to the homepage.";
  const changedFiles = [];
  const credentials = { email: "test@example.com", password: "TestPass123!" };

  console.log("\nStarting Stagehand verification...\n");

  const result = await runStagehandVerification(
    url,
    task,
    changedFiles,
    runDir,
    apiKey,
    model,
    logFile,
    credentials,
    undefined, // changeSummary
    baseURL
  );

  console.log("\n=== Results ===");
  console.log(`Verdict:    ${result.verifyResult?.passed ? "PASS" : "FAIL"}`);
  console.log(`Confidence: ${result.verifyResult?.confidence}`);
  console.log(`Reasoning:  ${result.verifyResult?.reasoning}`);
  console.log(`Screenshot: ${result.screenshotPath ?? "(none)"}`);
  console.log(`Video:      ${result.videoPath ?? "(none)"}`);

  if (result.videoPath) {
    const s = await stat(result.videoPath);
    console.log(`Video size: ${(s.size / 1024).toFixed(1)} KB`);
  }

  console.log(`\nFull log: ${logFile}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
