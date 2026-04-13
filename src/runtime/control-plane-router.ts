import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunnerCompletionPayload, RunnerEventPayload } from "./control-plane-types.js";
import { ControlPlaneConflictError, type ControlPlaneStore } from "./control-plane-store.js";
import { authenticateRunnerRequest } from "./control-plane-auth.js";
import type { ArtifactStore } from "./artifact-store.js";
import { isRecord } from "../utils/type-guards.js";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let resolved = false;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      if (!resolved) {
        resolved = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });

    req.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    });
  });
}

type ControlPlaneAction = "payload" | "artifacts" | "cancellation" | "events" | "complete";

function parseRoute(pathname: string): { runId: string; action: ControlPlaneAction } | undefined {
  const match = /^\/internal\/runs\/([^/]+)\/(payload|artifacts|cancellation|events|complete)$/.exec(pathname);
  if (!match) return undefined;

  try {
    return { runId: decodeURIComponent(match[1] ?? ""), action: match[2] as ControlPlaneAction };
  } catch {
    return undefined;
  }
}

function validateRunnerEventPayload(value: unknown): value is RunnerEventPayload {
  if (!isRecord(value)) return false;
  if (typeof value.eventId !== "string" || value.eventId.trim() === "") return false;
  if (typeof value.eventType !== "string" || value.eventType.trim() === "") return false;
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) return false;
  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence)) return false;
  if (value.payload !== undefined && !isRecord(value.payload)) return false;
  return true;
}

function validateRunnerCompletionPayload(value: unknown): value is RunnerCompletionPayload {
  if (!isRecord(value)) return false;
  if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.trim() === "") return false;
  if (value.status !== "success" && value.status !== "failed") return false;
  if (value.artifactState !== "complete" && value.artifactState !== "partial" && value.artifactState !== "failed") return false;
  return true;
}

export async function routeControlPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  controlPlaneStore: ControlPlaneStore,
  artifactStore: ArtifactStore,
): Promise<boolean> {
  const route = parseRoute(pathname);
  if (!route) return false;

  const { runId, action } = route;
  const authed = await authenticateRunnerRequest(req, controlPlaneStore, runId);
  if (!authed) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  if (req.method === "GET" && action === "payload") {
    const payload = await controlPlaneStore.getPayload(runId);
    if (!payload) {
      sendJson(res, 404, { error: "Run payload not found" });
      return true;
    }
    sendJson(res, 200, payload);
    return true;
  }

  if (req.method === "GET" && action === "artifacts") {
    const payload = await controlPlaneStore.getPayload(runId);
    if (!payload) {
      sendJson(res, 404, { error: "Run payload not found" });
      return true;
    }
    sendJson(res, 200, await artifactStore.allocateTargets(runId));
    return true;
  }

  if (req.method === "GET" && action === "cancellation") {
    sendJson(res, 200, await controlPlaneStore.getCancellationState(runId));
    return true;
  }

  if (req.method === "POST" && (action === "events" || action === "complete")) {
    const rawBody = await readBody(req);
    if (rawBody === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }

    let parsedBody: unknown;
    try {
      parsedBody = rawBody === "" ? {} : JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    if (action === "events") {
      if (!validateRunnerEventPayload(parsedBody)) {
        sendJson(res, 422, { error: "Invalid runner event payload" });
        return true;
      }
      await controlPlaneStore.appendEvent(runId, parsedBody);
      sendJson(res, 202, { accepted: true });
      return true;
    }

    if (!validateRunnerCompletionPayload(parsedBody)) {
      sendJson(res, 422, { error: "Invalid runner completion payload" });
      return true;
    }

    let result;
    try {
      result = await controlPlaneStore.recordCompletion(runId, parsedBody);
    } catch (error) {
      if (error instanceof ControlPlaneConflictError) {
        sendJson(res, 409, { error: error.message });
        return true;
      }
      throw error;
    }
    sendJson(res, 202, { accepted: true, completionId: result.id });
    return true;
  }

  sendJson(res, 405, { error: "Method not allowed" });
  return true;
}
