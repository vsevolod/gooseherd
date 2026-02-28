#!/usr/bin/env npx tsx
/**
 * Standalone browser verify test — runs the Stagehand agent directly
 * against a preview URL without the full pipeline.
 *
 * Usage:
 *   npx tsx scripts/test-browser-verify.ts <preview-url> ["<task>"] [changed-files] [email:password]
 *
 * Examples:
 *   # Smart test — Stagehand agent drives the browser autonomously
 *   npx tsx scripts/test-browser-verify.ts https://643.stg.epicpxls.com
 *
 *   # Custom task + files
 *   npx tsx scripts/test-browser-verify.ts https://643.stg.epicpxls.com \
 *     "Change the heading from 'Featured categories' to 'Curated collections'" \
 *     "app/views/items/index.html.slim"
 *
 *   # With explicit credentials
 *   npx tsx scripts/test-browser-verify.ts https://643.stg.epicpxls.com \
 *     "Verify heading change" "app/views/items/index.html.slim" "user@test.com:password"
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { runStagehandVerification } from "../src/pipeline/quality-gates/stagehand-verify.js";

// ── Config ──
const url = process.argv[2];
const task = process.argv[3] || "Change the 'Featured categories' heading on the homepage to 'Curated collections'";

if (!url) {
  console.error("Usage: npx tsx scripts/test-browser-verify.ts <url> [task] [changed-files] [email:password]");
  process.exit(1);
}

const model = process.env.BROWSER_VERIFY_MODEL || "anthropic/claude-sonnet-4-6";
const executionModel = process.env.BROWSER_VERIFY_EXECUTION_MODEL || undefined;

// Prefer direct provider keys over OpenRouter
const isAnthropicModel = model.startsWith("anthropic/");
const isOpenAIModel = model.startsWith("openai/") || model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4");
const isGoogleModel = model.startsWith("google/") || model.startsWith("gemini-");

let apiKey: string | undefined;
let baseURL: string | undefined;

if (isAnthropicModel && process.env.ANTHROPIC_API_KEY) {
  apiKey = process.env.ANTHROPIC_API_KEY;
  baseURL = undefined; // native Anthropic
} else if (isOpenAIModel && process.env.OPENAI_API_KEY) {
  apiKey = process.env.OPENAI_API_KEY;
  baseURL = undefined; // native OpenAI via Stagehand
} else if (isGoogleModel && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
  apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY!;
  baseURL = undefined; // native Google
} else {
  apiKey = process.env.OPENROUTER_API_KEY;
  baseURL = "https://openrouter.ai/api/v1";
}

if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY");
  process.exit(1);
}
const changedFiles = process.argv[4]
  ? process.argv[4].split(",")
  : ["app/views/items/index.html.slim"];
const credentials = process.argv[5]
  ? { email: process.argv[5].split(":")[0]!, password: process.argv[5].split(":")[1]! }
  : undefined;

// ── Run ──
async function main() {
  const runDir = path.resolve(".work", `test-verify-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  const logFile = path.join(runDir, "verify.log");

  console.log("=== Stagehand Browser Verify Test ===");
  console.log(`URL:    ${url}`);
  console.log(`Task:   ${task}`);
  console.log(`Files:  ${changedFiles.join(", ")}`);
  console.log(`Model:  ${model}`);
  console.log(`Exec:   ${executionModel ?? "(same as model)"}`);
  console.log(`API:    ${baseURL ?? "direct Anthropic"}`);
  console.log(`Creds:  ${credentials ? credentials.email : "(none)"}`);
  console.log(`RunDir: ${runDir}`);
  console.log("");

  const startTime = Date.now();

  try {
    const result = await runStagehandVerification(
      url,
      task,
      changedFiles,
      runDir,
      apiKey,
      model,
      logFile,
      credentials,
      undefined,  // changeSummary
      baseURL,
      executionModel
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n=== Results ===");
    console.log(`Duration: ${elapsed}s`);

    if (result.screenshotPath) {
      console.log(`Screenshot: ${result.screenshotPath}`);
    }
    if (result.videoPath) {
      console.log(`Video:      ${result.videoPath}`);
    }

    if (result.verifyResult) {
      const v = result.verifyResult;
      console.log(`Verdict: ${v.passed ? "PASS" : "FAIL"} (${v.confidence})`);
      console.log(`Reasoning: ${v.reasoning}`);
    } else {
      console.log("Verdict: (no verdict available)");
    }

    if (result.planTokens) {
      console.log(`Tokens: ${result.planTokens.input} input, ${result.planTokens.output} output`);
    }

    if (result.domFindings && result.domFindings.length > 0) {
      console.log(`\nDOM Findings (${result.domFindings.length}):`);
      for (const finding of result.domFindings) {
        console.log(`  - ${finding}`);
      }
    }

    console.log(`\nLog: ${logFile}`);
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\nFailed after ${elapsed}s: ${msg}`);
    console.error(`Log: ${logFile}`);
    process.exit(1);
  }
}

main();
