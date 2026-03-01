#!/usr/bin/env npx tsx
/**
 * Diagnostic test for CDP screencast recording.
 * Tests frame capture + ffmpeg encoding using the CdpScreencast class.
 *
 * Usage:
 *   npx tsx scripts/test-cdp-screencast.ts [url] [--headed]
 *
 * Options:
 *   --headed   Run with visible browser window (default: headless)
 *
 * When OPENAI_API_KEY is set, runs Stagehand agent interactions to exercise
 * page navigation. Otherwise falls back to static page load + wait.
 */

import path from "node:path";
import { mkdir, stat, readdir } from "node:fs/promises";
import { Stagehand } from "@browserbasehq/stagehand";
import { CdpScreencast } from "../src/pipeline/quality-gates/cdp-screencast.js";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const url = args.find(a => !a.startsWith("--")) || "https://example.com";

async function main() {
  const runDir = path.resolve(".work", `test-screencast-${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  console.log(`URL:      ${url}`);
  console.log(`RunDir:   ${runDir}`);
  console.log(`Headed:   ${headed}`);
  console.log(`Agent:    ${process.env.OPENAI_API_KEY ? "yes (OPENAI_API_KEY set)" : "no (static mode)"}`);

  const stagehand = new Stagehand({
    env: "LOCAL",
    experimental: true,
    ...(process.env.OPENAI_API_KEY ? { model: { modelName: "openai/gpt-4.1-mini", apiKey: process.env.OPENAI_API_KEY! } } : {}),
    localBrowserLaunchOptions: {
      headless: !headed,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
    },
    verbose: 0
  });

  await stagehand.init();
  console.log("Stagehand initialized");

  const pages = stagehand.context.pages();
  const page = pages[0];

  // Use public API to get CDP session
  const cdpSession = (page as any).getSessionForFrame?.((page as any).mainFrameId?.());
  console.log("CDP session:", {
    exists: !!cdpSession,
    hasSend: typeof cdpSession?.send,
    hasOn: typeof cdpSession?.on,
  });

  if (!cdpSession) {
    console.error("No CDP session available!");
    await stagehand.close();
    return;
  }

  const screencast = new CdpScreencast(cdpSession, runDir);

  // Start BEFORE navigation — in headed mode, skip size constraints, gap-fill, and reduce frame rate to avoid flicker
  await screencast.start(headed ? { maxWidth: 0, maxHeight: 0, gapFill: false, everyNthFrame: 3 } : undefined);
  console.log("Screencast started");

  // Navigate
  console.log(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: "networkidle", timeoutMs: 30_000 });
  console.log(`Navigation done (frames so far: ${screencast.frames})`);

  if (process.env.OPENAI_API_KEY) {
    // Agent mode: use Stagehand agent to interact with the page
    console.log("\n--- Agent interactions ---");
    const agentModel = {
      modelName: "openai/gpt-4.1-mini",
      apiKey: process.env.OPENAI_API_KEY!,
    };
    const agent = stagehand.agent({ model: agentModel });

    const instruction = [
      `You are on ${url}.`,
      "Click the Sign Up link.",
      "Fill in the sign up form with: email 'test-bot@example.com', password 'SuperSecret123!'.",
      "Do NOT submit the form, just fill it in.",
      "Then go back to the homepage.",
      "Click on a different link and describe what you see.",
    ].join(" ");

    console.log(`Agent instruction: ${instruction}`);
    console.log(`Frames before agent: ${screencast.frames}`);

    const result = await agent.execute({
      instruction,
      maxSteps: 10,
    });

    console.log(`Agent done. Result: ${JSON.stringify(result.output ?? result).slice(0, 200)}`);
    console.log(`Frames after agent: ${screencast.frames}`);

    // Let gap-fill capture a few more frames after agent finishes
    console.log("Waiting 3s for gap-fill frames...");
    await new Promise(r => setTimeout(r, 3000));
  } else {
    // Static mode: just wait for frames
    console.log("Waiting 5s for frames...");
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log(`Total frames captured: ${screencast.frames}`);

  // Stop and drain writes
  await screencast.stop();
  console.log("Screencast stopped, writes drained");

  // Check frame files
  const framesDir = path.join(runDir, "screencast-frames");
  try {
    const files = await readdir(framesDir);
    console.log(`Frame files on disk: ${files.length}`);
    if (files.length > 0) {
      const sorted = files.sort();
      console.log(`  First: ${sorted[0]}`);
      console.log(`  Last:  ${sorted[sorted.length - 1]}`);
    }
  } catch {
    console.log("Frame files: (directory not found)");
  }

  // Encode
  const mp4Path = path.join(runDir, "verification.mp4");
  const videoPath = await screencast.encode(mp4Path);
  if (videoPath) {
    const s = await stat(videoPath);
    console.log(`Video: ${videoPath} (${(s.size / 1024).toFixed(1)} KB)`);
  } else {
    console.log("Video: encoding failed or no frames");
  }

  // Cleanup frames
  await screencast.cleanup();
  console.log("Frames cleaned up");

  await stagehand.close();
  console.log("\nDone! Check the video at:", videoPath ?? "(no video)");
}

main().catch(console.error);
