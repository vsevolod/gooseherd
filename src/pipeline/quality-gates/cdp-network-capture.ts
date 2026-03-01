/**
 * CDP Network Capture — records browser network requests via Chrome DevTools Protocol.
 *
 * Uses the same CdpSession interface as CdpScreencast for consistency.
 * Requests are paired by requestId across requestWillBeSent / responseReceived / loadingFinished events.
 * Redirect chains are handled: each hop is finalized before the next begins.
 *
 * All errors are non-fatal — network capture is a bonus, never blocks verification.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  off(event: string, handler: (params: Record<string, unknown>) => void): void;
}

interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  encodedDataLength?: number;
  durationMs?: number;
  error?: string;
  resourceType?: string;
}

interface TrackedRequest {
  url: string;
  method: string;
  startTime: number;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  encodedDataLength?: number;
  endTime?: number;
  error?: string;
}

export class CdpNetworkCapture {
  private session: CdpSession;
  private runDir: string;
  private requests = new Map<string, TrackedRequest>();
  private completed: TrackedRequest[] = [];
  private stopped = false;
  private requestHandler: ((params: Record<string, unknown>) => void) | undefined;
  private responseHandler: ((params: Record<string, unknown>) => void) | undefined;
  private finishedHandler: ((params: Record<string, unknown>) => void) | undefined;
  private failedHandler: ((params: Record<string, unknown>) => void) | undefined;

  constructor(session: CdpSession, runDir: string) {
    this.session = session;
    this.runDir = runDir;
  }

  async start(): Promise<void> {
    this.requestHandler = (params: Record<string, unknown>) => {
      if (this.stopped) return;
      const requestId = params.requestId as string;
      const request = params.request as { url: string; method: string };
      const timestamp = params.timestamp as number;
      const type = params.type as string | undefined;

      // Handle redirect: CDP fires requestWillBeSent again with same requestId + redirectResponse
      const redirectResponse = params.redirectResponse as { status: number; statusText: string; mimeType: string } | undefined;
      if (redirectResponse) {
        const prev = this.requests.get(requestId);
        if (prev) {
          prev.status = redirectResponse.status;
          prev.statusText = redirectResponse.statusText;
          prev.mimeType = redirectResponse.mimeType;
          prev.endTime = timestamp;
          this.completed.push(prev);
        }
      }

      this.requests.set(requestId, {
        url: request.url,
        method: request.method,
        startTime: timestamp,
        resourceType: type
      });
    };

    this.responseHandler = (params: Record<string, unknown>) => {
      if (this.stopped) return;
      const requestId = params.requestId as string;
      const response = params.response as { status: number; statusText: string; mimeType: string };
      const entry = this.requests.get(requestId);
      if (entry) {
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.mimeType = response.mimeType;
      }
    };

    this.finishedHandler = (params: Record<string, unknown>) => {
      if (this.stopped) return;
      const requestId = params.requestId as string;
      const encodedDataLength = params.encodedDataLength as number;
      const timestamp = params.timestamp as number;
      const entry = this.requests.get(requestId);
      if (entry) {
        entry.encodedDataLength = encodedDataLength;
        entry.endTime = timestamp;
      }
    };

    this.failedHandler = (params: Record<string, unknown>) => {
      if (this.stopped) return;
      const requestId = params.requestId as string;
      const errorText = params.errorText as string;
      const timestamp = params.timestamp as number;
      const entry = this.requests.get(requestId);
      if (entry) {
        entry.error = errorText;
        entry.endTime = timestamp;
      }
    };

    this.session.on("Network.requestWillBeSent", this.requestHandler);
    this.session.on("Network.responseReceived", this.responseHandler);
    this.session.on("Network.loadingFinished", this.finishedHandler);
    this.session.on("Network.loadingFailed", this.failedHandler);

    await this.session.send("Network.enable");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    try {
      await this.session.send("Network.disable");
    } catch {
      // CDP connection may already be closed
    }

    if (this.requestHandler) {
      this.session.off("Network.requestWillBeSent", this.requestHandler);
      this.requestHandler = undefined;
    }
    if (this.responseHandler) {
      this.session.off("Network.responseReceived", this.responseHandler);
      this.responseHandler = undefined;
    }
    if (this.finishedHandler) {
      this.session.off("Network.loadingFinished", this.finishedHandler);
      this.finishedHandler = undefined;
    }
    if (this.failedHandler) {
      this.session.off("Network.loadingFailed", this.failedHandler);
      this.failedHandler = undefined;
    }
  }

  private toEntry(req: TrackedRequest): NetworkEntry {
    const entry: NetworkEntry = {
      url: req.url,
      method: req.method,
      resourceType: req.resourceType
    };
    if (req.status !== undefined) entry.status = req.status;
    if (req.statusText) entry.statusText = req.statusText;
    if (req.mimeType) entry.mimeType = req.mimeType;
    if (req.encodedDataLength !== undefined) entry.encodedDataLength = req.encodedDataLength;
    if (req.error) entry.error = req.error;
    if (req.endTime !== undefined) {
      entry.durationMs = Math.round((req.endTime - req.startTime) * 1000);
    }
    return entry;
  }

  /** Save captured network log to network-log.json. Returns path or undefined if no requests. */
  async save(): Promise<string | undefined> {
    if (this.requests.size === 0 && this.completed.length === 0) return undefined;

    const entries: NetworkEntry[] = [
      ...this.completed.map((r) => this.toEntry(r)),
      ...[...this.requests.values()].map((r) => this.toEntry(r))
    ];

    const outPath = path.join(this.runDir, "network-log.json");
    await writeFile(outPath, JSON.stringify(entries, null, 2));
    return outPath;
  }

  get count(): number {
    return this.requests.size + this.completed.length;
  }
}
