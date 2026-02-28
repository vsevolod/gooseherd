/**
 * CDP Screencast — records browser session as JPEG frames via Chrome DevTools Protocol,
 * then encodes to mp4 with ffmpeg.
 *
 * Uses Stagehand's CDPSessionLike (via page.getSessionForFrame) for CDP access.
 * Frames are written to disk to avoid memory pressure during long sessions.
 *
 * All errors are non-fatal — video is a bonus, never blocks verification.
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
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

  constructor(session: CdpSession, runDir: string) {
    this.session = session;
    this.framesDir = path.join(runDir, "screencast-frames");
  }

  /** Start capturing screencast frames. Call BEFORE page.goto() to capture initial load. */
  async start(opts?: { quality?: number; maxWidth?: number; maxHeight?: number }): Promise<void> {
    await mkdir(this.framesDir, { recursive: true });

    this.frameHandler = (params: Record<string, unknown>) => {
      const sessionId = params.sessionId as number;
      const data = params.data as string;

      // ACK immediately to prevent Chrome from throttling frame delivery
      this.session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});

      // Write frame to disk asynchronously, track promise for drain on stop
      this.frameCount++;
      const framePath = path.join(this.framesDir, `frame-${String(this.frameCount).padStart(6, "0")}.jpg`);
      const writeTask = writeFile(framePath, Buffer.from(data, "base64")).catch(() => {});
      this.pendingWrites.add(writeTask);
      writeTask.finally(() => this.pendingWrites.delete(writeTask));
    };

    this.session.on("Page.screencastFrame", this.frameHandler);

    await this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: opts?.quality ?? 60,
      maxWidth: opts?.maxWidth ?? 1280,
      maxHeight: opts?.maxHeight ?? 800,
      everyNthFrame: 1
    });
  }

  /** Stop capturing and drain pending writes. Idempotent — safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

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
        "-framerate", "4",
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
        resolve(error ? undefined : outputPath);
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
