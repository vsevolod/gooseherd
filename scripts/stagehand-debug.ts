#!/usr/bin/env npx tsx
/**
 * Quick debug script to test Stagehand agent interaction via OpenRouter.
 *
 * Tests the theory: using "openai/" prefix for OpenRouter model names
 * fixes the "Invalid JSON response" error on tool_use calls.
 *
 * Usage:
 *   npx tsx scripts/stagehand-debug.ts [url]
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

const url = process.argv[2] || "https://643.stg.epicpxls.com/signup";
const model = process.env.BROWSER_VERIFY_MODEL || "anthropic/claude-sonnet-4-6";

// Prefer direct Anthropic key for anthropic/* models
const isAnthropicModel = model.startsWith("anthropic/");
const apiKey = (isAnthropicModel && process.env.ANTHROPIC_API_KEY)
  ? process.env.ANTHROPIC_API_KEY
  : process.env.OPENROUTER_API_KEY;
const baseURL = (isAnthropicModel && process.env.ANTHROPIC_API_KEY)
  ? undefined
  : "https://openrouter.ai/api/v1";

if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY (preferred) or OPENROUTER_API_KEY");
  process.exit(1);
}

async function main() {
  console.log(`URL:   ${url}`);
  console.log(`Model: ${model}`);
  console.log(`API:   ${baseURL ?? "direct Anthropic"}`);
  console.log("");

  const modelConfig: { modelName: string; apiKey: string; baseURL?: string } = {
    modelName: model,
    apiKey,
    ...(baseURL ? { baseURL } : {})
  };

  const stagehand = new Stagehand({
    env: "LOCAL",
    experimental: true,
    model: modelConfig,
    localBrowserLaunchOptions: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
    },
    verbose: 2
  });

  try {
    await stagehand.init();
    console.log("Stagehand initialized");

    const page = stagehand.context.pages()[0];
    await page.goto(url, { waitUntil: "networkidle" });
    console.log(`Navigated to ${url}`);

    const agent = stagehand.agent({
      model: modelConfig,
      systemPrompt: "You are a QA engineer testing a web application."
    });

    console.log("Executing agent (interactive task — will fill a form)...\n");

    const result = await agent.execute({
      instruction: `Look at the signup form on this page. Fill in the email field with "debug-test@test.gooseherd.dev" and the password field with "TestPass123!". Do NOT submit the form. After filling the fields, report whether you successfully filled them.`,
      maxSteps: 8,
      output: z.object({
        filled: z.boolean().describe("Whether form fields were filled successfully"),
        details: z.string().describe("What fields were filled")
      }),
      signal: AbortSignal.timeout(60_000)
    });

    console.log("\n=== Result ===");
    console.log(`Success: ${result.success}`);
    console.log(`Completed: ${result.completed}`);
    console.log(`Actions: ${result.actions.length}`);
    console.log(`Message: ${result.message}`);
    if (result.output) {
      console.log(`Output: ${JSON.stringify(result.output)}`);
    }

    for (const action of result.actions) {
      console.log(`  Action: ${action.type || "unknown"} — ${action.reasoning || ""}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${msg}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  } finally {
    await stagehand.close().catch(() => {});
    console.log("\nStagehand closed");
  }
}

main();
