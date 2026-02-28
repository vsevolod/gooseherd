#!/usr/bin/env npx tsx
/**
 * Diagnostic test for CDP screencast recording.
 * Tests frame capture + ffmpeg encoding using the CdpScreencast class.
 *
 * Usage: npx tsx scripts/test-cdp-screencast.ts [url]
 */

import path from "node:path";
import { mkdir, stat, readdir } from "node:fs/promises";
import { Stagehand } from "@browserbasehq/stagehand";
import { CdpScreencast } from "../src/pipeline/quality-gates/cdp-screencast.js";

const url = process.argv[2] || "https://example.com";

async function main() {
  const runDir = path.resolve(".work", `test-screencast-${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  console.log(`URL:    ${url}`);
  console.log(`RunDir: ${runDir}`);

  const stagehand = new Stagehand({
    env: "LOCAL",
    experimental: true,
    localBrowserLaunchOptions: {
      headless: true,
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

  // Start BEFORE navigation
  await screencast.start();
  console.log("Screencast started");

  // Navigate
  console.log(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: "networkidle", timeoutMs: 30_000 });
  console.log("Navigation done");

  // Wait for more frames
  console.log("Waiting 5s for frames...");
  await new Promise(r => setTimeout(r, 5000));
  console.log(`Frames captured: ${screencast.frames}`);

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
