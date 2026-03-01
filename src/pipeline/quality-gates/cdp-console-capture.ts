/**
 * CDP Console Capture — records browser console logs via Chrome DevTools Protocol.
 *
 * Uses the same CdpSession interface as CdpScreencast for consistency.
 * Console logs are collected in memory and saved to JSON on demand.
 *
 * All errors are non-fatal — console capture is a bonus, never blocks verification.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  off(event: string, handler: (params: Record<string, unknown>) => void): void;
}

interface ConsoleEntry {
  level: string;
  message: string;
  timestamp: number;
  stackTrace?: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }>;
}

export class CdpConsoleCapture {
  private session: CdpSession;
  private runDir: string;
  private entries: ConsoleEntry[] = [];
  private stopped = false;
  private handler: ((params: Record<string, unknown>) => void) | undefined;

  constructor(session: CdpSession, runDir: string) {
    this.session = session;
    this.runDir = runDir;
  }

  async start(): Promise<void> {
    this.handler = (params: Record<string, unknown>) => {
      if (this.stopped) return;

      const type = params.type as string;
      const args = params.args as Array<{ type: string; value?: unknown; description?: string }>;
      const timestamp = params.timestamp as number;

      const message = args
        .map((arg) => {
          if (arg.value !== undefined) return String(arg.value);
          if (arg.description) return arg.description;
          return arg.type;
        })
        .join(" ");

      const entry: ConsoleEntry = { level: type, message, timestamp };

      const stackTrace = params.stackTrace as { callFrames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }> } | undefined;
      if (stackTrace?.callFrames) {
        entry.stackTrace = stackTrace.callFrames;
      }

      this.entries.push(entry);
    };

    this.session.on("Runtime.consoleAPICalled", this.handler);
    await this.session.send("Runtime.enable");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    try {
      await this.session.send("Runtime.disable");
    } catch {
      // CDP connection may already be closed
    }

    if (this.handler) {
      this.session.off("Runtime.consoleAPICalled", this.handler);
      this.handler = undefined;
    }
  }

  /** Save captured logs to console-logs.json. Returns path or undefined if no logs. */
  async save(): Promise<string | undefined> {
    if (this.entries.length === 0) return undefined;

    const outPath = path.join(this.runDir, "console-logs.json");
    await writeFile(outPath, JSON.stringify(this.entries, null, 2));
    return outPath;
  }

  get count(): number {
    return this.entries.length;
  }
}
