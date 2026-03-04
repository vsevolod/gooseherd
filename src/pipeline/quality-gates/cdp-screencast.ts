/**
 * CDP Screencast — records browser session as JPEG frames via Chrome DevTools Protocol,
 * then encodes to mp4 with ffmpeg.
 *
 * Uses Stagehand's CDPSessionLike (via page.getSessionForFrame) for CDP access.
 * Frames are written to disk to avoid memory pressure during long sessions.
 *
 * All errors are non-fatal — video is a bonus, never blocks verification.
 */

import { writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  off(event: string, handler: (params: Record<string, unknown>) => void): void;
}

export class CdpScreencast {
  private session: CdpSession;
  private framesDir: string;
  private frameCount = 0;
  private stopped = false;
  private frameHandler: ((params: Record<string, unknown>) => void) | undefined;
  private pendingWrites = new Set<Promise<void>>();
  private lastFrameTime = 0;
  private gapFillTimer: ReturnType<typeof setInterval> | undefined;
  private gapFillInFlight = false;

  constructor(session: CdpSession, runDir: string) {
    this.session = session;
    this.framesDir = path.join(runDir, "screencast-frames");
  }

  /** Start capturing screencast frames. Call BEFORE page.goto() to capture initial load.
   *  Set gapFill: false to disable periodic screenshot capture (useful in headed mode to avoid flicker). */
  async start(opts?: { quality?: number; maxWidth?: number; maxHeight?: number; gapFill?: boolean; everyNthFrame?: number }): Promise<void> {
    await mkdir(this.framesDir, { recursive: true });

    this.frameHandler = (params: Record<string, unknown>) => {
      const sessionId = params.sessionId as number;
      const data = params.data as string;

      // ACK immediately to prevent Chrome from throttling frame delivery
      this.session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});

      this.lastFrameTime = Date.now();

      // Write frame to disk asynchronously, track promise for drain on stop
      this.writeFrame(data);
    };

    this.session.on("Page.screencastFrame", this.frameHandler);

    const screencastParams: Record<string, unknown> = {
      format: "jpeg",
      quality: opts?.quality ?? 60,
      everyNthFrame: opts?.everyNthFrame ?? 1
    };
    const mw = opts?.maxWidth ?? 1280;
    const mh = opts?.maxHeight ?? 800;
    if (mw > 0) screencastParams.maxWidth = mw;
    if (mh > 0) screencastParams.maxHeight = mh;
    await this.session.send("Page.startScreencast", screencastParams);

    this.lastFrameTime = Date.now();

    if (opts?.gapFill === false) return;

    // Gap-fill: capture a screenshot when CDP hasn't sent a frame in 400ms.
    // CDP screencastFrame is compositor-driven — no pixel changes = no frames.
    // This fills idle gaps (e.g. while LLM thinks) with fresh screenshots.
    this.gapFillTimer = setInterval(() => {
      if (this.stopped || this.gapFillInFlight) return;
      if (Date.now() - this.lastFrameTime < 400) return;

      this.gapFillInFlight = true;
      this.session.send("Page.captureScreenshot", { format: "jpeg", quality: 60 })
        .then((result) => {
          if (this.stopped) return;
          const data = (result as { data: string }).data;
          if (data) {
            this.lastFrameTime = Date.now();
            this.writeFrame(data);
          }
        })
        .catch(() => {})
        .finally(() => { this.gapFillInFlight = false; });
    }, 500);
  }

  /** Write a base64-encoded JPEG frame to disk. Shared by screencast events and gap-fill. */
  private writeFrame(data: string): void {
    this.frameCount++;
    const framePath = path.join(this.framesDir, `frame-${String(this.frameCount).padStart(6, "0")}.jpg`);
    const writeTask = writeFile(framePath, Buffer.from(data, "base64")).catch(() => {});
    this.pendingWrites.add(writeTask);
    writeTask.finally(() => this.pendingWrites.delete(writeTask));
  }

  /** Stop capturing and drain pending writes. Idempotent — safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Stop gap-fill timer first to prevent new captures during teardown
    if (this.gapFillTimer) {
      clearInterval(this.gapFillTimer);
      this.gapFillTimer = undefined;
    }

    try {
      await this.session.send("Page.stopScreencast");
    } catch {
      // CDP connection may already be closed — that's fine
    }

    if (this.frameHandler) {
      this.session.off("Page.screencastFrame", this.frameHandler);
      this.frameHandler = undefined;
    }

    // Drain any in-flight writeFile operations before encode() runs
    if (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
  }

  /** Encode captured frames to mp4. Returns output path or undefined on failure. */
  async encode(outputPath: string): Promise<string | undefined> {
    if (this.frameCount === 0) return undefined;

    const inputPattern = path.join(this.framesDir, "frame-%06d.jpg");

    return new Promise<string | undefined>((resolve) => {
      execFile("ffmpeg", [
        "-y",
        "-start_number", "1",
        "-framerate", "2",
        "-i", inputPattern,
        // libx264 requires even width+height; pad odd dimensions with 1px black border
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", "28",
        "-preset", "fast",
        "-movflags", "+faststart",
        outputPath
      ], { timeout: 30_000 }, (error) => {
        if (!error) return resolve(outputPath);
        // ffmpeg can exit non-zero on harmless warnings (deprecated pixel format,
        // metadata issues) while still producing a valid output file. Check if the
        // file exists and has content before declaring failure.
        stat(outputPath)
          .then(s => resolve(s.size > 0 ? outputPath : undefined))
          .catch(() => resolve(undefined));
      });
    });
  }

  /** Clean up temporary frame files. */
  async cleanup(): Promise<void> {
    await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
  }

  get frames(): number {
    return this.frameCount;
  }
}
