/**
 * Stagehand-based browser verification adapter.
 *
 * Replaces the old agent-browser CLI + callLLMWithTools agentic loop with
 * Stagehand's built-in agent API. The agent navigates, interacts, handles
 * auth, and returns a structured verdict via Zod schema.
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { Stagehand, AISdkClient } from "@browserbasehq/stagehand";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { extractJSON, type LLMCallerConfig } from "../../llm/caller.js";
import { verifyFeatureVisually, type VisualVerifyResult } from "./browser-verify.js";
import { appendLog } from "../shell.js";
import { CdpScreencast } from "./cdp-screencast.js";

// ── Verdict Schema ──

const VerdictSchema = z.object({
  passed: z.boolean().describe("Whether the feature/change was implemented correctly"),
  confidence: z.enum(["high", "medium", "low"]).describe("Confidence in the verdict"),
  reasoning: z.string().describe("1-2 sentence explanation of the evidence found")
});

// ── System Prompt ──

const STAGEHAND_SYSTEM_PROMPT = `You are a QA engineer verifying a deployed web application after a code change.

## Goal
Determine whether the requested feature/change was implemented correctly on the live preview.

## How to work
1. Study the page to understand what's visible.
2. Navigate to the feature, interact with elements, and gather evidence.
3. Use JavaScript evaluation for precise DOM queries: element text, counts, visibility, computed styles.
4. Take screenshots to capture visual evidence.

## Authentication
If the page shows a login/signup form instead of the expected feature:
1. Look for "Sign in" or "Log in" links.
2. Use provided test credentials, or try: admin@admin.com / password
3. After login, navigate to the target page.

## Evidence
- Trust DOM evaluation results over visual impressions for text/element assertions.
- Be specific about what evidence you found.
- PASSED = evidence confirms the change was made correctly.
- FAILED = evidence shows the change is missing, broken, or incorrect.`;

// ── OpenRouter Client Factory ──

/**
 * Creates an AISdkClient compatible with OpenRouter (or any OpenAI-compatible endpoint).
 *
 * Stagehand's built-in provider routing doesn't work with OpenRouter because:
 * - `anthropic/*` → @ai-sdk/anthropic → sends Anthropic-format, but OpenRouter returns OpenAI-format
 * - `openai/*` → @ai-sdk/openai → uses /responses endpoint, but OpenRouter only supports /chat/completions
 *
 * This factory uses @ai-sdk/openai-compatible which sends standard /chat/completions requests.
 * The returned client also has the getLanguageModel() method patched in, since Stagehand's
 * public AISdkClient (external_clients/aisdk.js) lacks it but the agent handler requires it.
 */
function createOpenRouterClient(modelName: string, apiKey: string, baseURL: string): AISdkClient {
  const provider = createOpenAICompatible({
    name: "openrouter",
    baseURL,
    apiKey,
    supportsStructuredOutputs: true
  });
  const client = new AISdkClient({ model: provider(modelName) });
  // Patch: public AISdkClient lacks getLanguageModel() which the agent handler needs
  if (!("getLanguageModel" in client)) {
    (client as any).getLanguageModel = function () { return this.model; };
  }
  return client;
}

// ── Instruction Builder ──

export function buildInstruction(
  task: string,
  changedFiles: string[],
  credentials?: { email: string; password: string },
  changeSummary?: string
): string {
  const fileList = changedFiles.length > 0
    ? changedFiles.map(f => `  - ${f}`).join("\n")
    : "  (none available)";

  let instruction = `Verify that this task was implemented correctly on the live page.\n\nTask: ${task}\n\nFiles changed:\n${fileList}`;

  if (changeSummary) {
    instruction += `\n\nChange summary (what the developer actually did):\n${changeSummary}`;
  }

  if (credentials) {
    instruction += `\n\nTest account credentials: email="${credentials.email}", password="${credentials.password}". Use these to log in if you encounter a login form.`;
  }

  instruction += `\n\nNavigate to the relevant page, interact with elements to test the feature, and determine whether the task was implemented correctly. Provide your verdict.`;

  return instruction;
}

// ── Main Verification Function ──

export interface StagehandVerifyResult {
  screenshotPath?: string;
  videoPath?: string;
  verifyResult?: VisualVerifyResult;
  planTokens?: { input: number; output: number };
  domFindings?: string[];
}

export async function runStagehandVerification(
  url: string,
  task: string,
  changedFiles: string[],
  runDir: string,
  apiKey: string,
  model: string,
  logFile: string,
  credentials?: { email: string; password: string },
  changeSummary?: string,
  baseURL?: string,
  executionModel?: string
): Promise<StagehandVerifyResult> {
  const screenshotsDir = path.join(runDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  // Resolve chromium path from env (sandbox or local)
  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || process.env.PUPPETEER_EXECUTABLE_PATH
    || undefined;

  const execModelLabel = executionModel ?? "(same)";
  const providerLabel = baseURL ?? "native";
  await appendLog(logFile, `[gate:browser_verify] stagehand: initializing (model=${model}, executionModel=${execModelLabel}, chromium=${chromiumPath ?? "bundled"}, baseURL=${providerLabel})\n`);

  // When using OpenRouter (baseURL set), create a custom LLM client via @ai-sdk/openai-compatible.
  const llmClient = baseURL ? createOpenRouterClient(model, apiKey, baseURL) : undefined;

  const modelConfig: { modelName: string; apiKey: string; baseURL?: string } = {
    modelName: model,
    apiKey,
    ...(baseURL ? { baseURL } : {})
  };

  const stagehand = new Stagehand({
    env: "LOCAL",
    experimental: true,
    model: modelConfig,
    ...(llmClient ? { llmClient } : {}),
    localBrowserLaunchOptions: {
      headless: true,
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
    },
    logger: (logLine) => {
      appendLog(logFile, `[stagehand:${logLine.category ?? "info"}] ${logLine.message}\n`).catch(() => {});
    },
    verbose: 1
  });

  let screencast: CdpScreencast | undefined;

  try {
    await stagehand.init();
    await appendLog(logFile, "[gate:browser_verify] stagehand: initialized\n");

    // When using OpenRouter, Stagehand's built-in resolveLlmClient() creates standard AI SDK
    // provider clients (e.g. @ai-sdk/anthropic) which don't work with OpenRouter. Override it
    // to route ALL model resolution through our @ai-sdk/openai-compatible factory.
    if (baseURL) {
      const originalResolve = (stagehand as any).resolveLlmClient.bind(stagehand);
      (stagehand as any).resolveLlmClient = (modelOverride?: string | { modelName: string }) => {
        if (!modelOverride) return (stagehand as any).llmClient;
        const overrideModelName = typeof modelOverride === "string"
          ? modelOverride
          : modelOverride.modelName;
        // If same model as primary, return the existing client
        if (overrideModelName === model) return (stagehand as any).llmClient;
        // Create a new OpenRouter-compatible client for the override model
        return createOpenRouterClient(overrideModelName, apiKey, baseURL);
      };
    }

    // Get the page — Stagehand creates one on init
    const pages = stagehand.context.pages();
    if (pages.length === 0) {
      throw new Error("Stagehand initialized but no pages available");
    }
    const page = pages[0];

    // Start CDP screencast BEFORE navigation to capture initial page load
    try {
      // Use public API: getSessionForFrame(mainFrameId()) returns a CDPSessionLike with send/on/off
      const cdpSession = (page as any).getSessionForFrame?.((page as any).mainFrameId?.());
      if (cdpSession?.send && cdpSession?.on) {
        screencast = new CdpScreencast(cdpSession, runDir);
        await screencast.start();
        await appendLog(logFile, "[gate:browser_verify] screencast: recording started\n");
      }
    } catch {
      await appendLog(logFile, "[gate:browser_verify] screencast: failed to start (non-fatal)\n");
      screencast = undefined;
    }

    // Navigate to the URL
    await page.goto(url, { waitUntil: "networkidle", timeoutMs: 30_000 });
    await appendLog(logFile, `[gate:browser_verify] stagehand: navigated to ${url}\n`);

    // Take initial screenshot (Stagehand runs Chromium locally — use host paths, NOT container paths)
    const initialScreenshot = path.join(screenshotsDir, "step-0-initial.png");
    await page.screenshot({ path: initialScreenshot, fullPage: true });

    // Build instruction and create agent
    const instruction = buildInstruction(task, changedFiles, credentials, changeSummary);

    // Build agent options:
    // - When using OpenRouter: don't pass model (use injected llmClient), but DO pass executionModel
    //   as a string — our patched resolveLlmClient will handle it via createOpenRouterClient
    // - When using native API: pass modelConfig directly, executionModel as string
    const agentOpts: Record<string, unknown> = {
      systemPrompt: STAGEHAND_SYSTEM_PROMPT
    };
    if (!llmClient) {
      agentOpts.model = modelConfig;
    }
    if (executionModel) {
      agentOpts.executionModel = llmClient ? executionModel : {
        modelName: executionModel,
        apiKey,
        ...(baseURL ? { baseURL } : {})
      };
    }
    const agent = stagehand.agent(agentOpts);

    await appendLog(logFile, "[gate:browser_verify] stagehand: executing agent (maxSteps=15)\n");

    // Execute with timeout via AbortSignal (120s total)
    const result = await agent.execute({
      instruction,
      maxSteps: 15,
      output: VerdictSchema,
      signal: AbortSignal.timeout(120_000)
    });

    await appendLog(logFile, `[gate:browser_verify] stagehand: agent done — success=${String(result.success)}, completed=${String(result.completed)}, actions=${String(result.actions.length)}\n`);

    // Take final screenshot
    const finalScreenshot = path.join(screenshotsDir, "final.png");
    await page.screenshot({ path: finalScreenshot });

    // Collect DOM findings from actions
    const domFindings: string[] = [];
    for (const action of result.actions) {
      if (action.reasoning) {
        domFindings.push(action.reasoning);
      }
    }

    // Token usage
    const planTokens = result.usage
      ? { input: result.usage.input_tokens, output: result.usage.output_tokens }
      : undefined;

    // Extract verdict — try structured output first, fall back to message parsing, then vision
    let verifyResult: VisualVerifyResult | undefined;

    if (result.output) {
      // Validate with Zod rather than blind cast
      const parsed = VerdictSchema.safeParse(result.output);
      if (parsed.success) {
        verifyResult = {
          passed: parsed.data.passed,
          confidence: parsed.data.confidence,
          reasoning: parsed.data.reasoning,
          inputTokens: planTokens?.input ?? 0,
          outputTokens: planTokens?.output ?? 0
        };
        await appendLog(logFile, `[gate:browser_verify] verdict: ${verifyResult.passed ? "PASS" : "FAIL"} (${verifyResult.confidence}) — ${verifyResult.reasoning}\n`);
      } else {
        await appendLog(logFile, `[gate:browser_verify] structured output failed validation: ${parsed.error.message.slice(0, 200)}\n`);
      }
    }

    // Fallback: try to extract verdict JSON from agent's message text
    if (!verifyResult && result.message) {
      const extracted = extractJSON<{ passed: boolean; confidence: string; reasoning: string }>(result.message);
      if (extracted && typeof extracted.passed === "boolean") {
        const confidence = (["high", "medium", "low"].includes(extracted.confidence)
          ? extracted.confidence
          : "medium") as "high" | "medium" | "low";
        verifyResult = {
          passed: extracted.passed,
          reasoning: extracted.reasoning || "No reasoning provided",
          confidence,
          inputTokens: planTokens?.input ?? 0,
          outputTokens: planTokens?.output ?? 0
        };
        await appendLog(logFile, `[gate:browser_verify] verdict (from message text): ${verifyResult.passed ? "PASS" : "FAIL"} (${verifyResult.confidence})\n`);
      } else {
        await appendLog(logFile, `[gate:browser_verify] no structured output, agent message: ${result.message.slice(0, 300)}\n`);
      }
    }

    // Last fallback: vision verdict on the screenshot
    if (!verifyResult) {
      await appendLog(logFile, "[gate:browser_verify] falling back to vision verdict\n");
      const visionConfig: LLMCallerConfig = { apiKey, defaultModel: model, defaultTimeoutMs: 30_000 };
      try {
        verifyResult = await verifyFeatureVisually(
          visionConfig,
          finalScreenshot,
          task,
          changedFiles,
          model,
          domFindings.length > 0 ? domFindings : undefined
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        await appendLog(logFile, `[gate:browser_verify] vision verdict failed: ${msg}\n`);
      }
    }

    // Stop screencast and encode to mp4 BEFORE closing Stagehand (close kills CDP connection)
    let videoPath: string | undefined;
    if (screencast) {
      try {
        await screencast.stop();
        const mp4Path = path.join(runDir, "verification.mp4");
        videoPath = await screencast.encode(mp4Path);
        await appendLog(logFile, `[gate:browser_verify] screencast: ${videoPath ? `encoded ${screencast.frames} frames → ${videoPath}` : "encode failed or no frames"}\n`);
      } catch {
        await appendLog(logFile, "[gate:browser_verify] screencast: encode failed (non-fatal)\n");
      }
    }

    return {
      screenshotPath: finalScreenshot,
      videoPath,
      verifyResult,
      planTokens,
      domFindings: domFindings.length > 0 ? domFindings : undefined
    };
  } finally {
    // Stop screencast safety net (idempotent via stopped flag)
    await screencast?.stop().catch(() => {});
    await stagehand.close().catch(() => {});
    await appendLog(logFile, "[gate:browser_verify] stagehand: closed\n");
    // Clean up temporary frame files
    await screencast?.cleanup().catch(() => {});
  }
}
