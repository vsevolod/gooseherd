import type {
  RunEnvelope,
  RunnerCompletionPayload,
  RunnerEventPayload,
} from "../runtime/control-plane-types.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const BASE_RETRY_DELAY_MS = 250;
const TERMINAL_STATUSES = new Set([401, 403, 404, 409, 422]);

interface RunnerControlPlaneClientConfig {
  baseUrl: string;
  runId: string;
  token: string;
  requestTimeoutMs?: number;
}

interface RetryOptions {
  maxAttempts?: number;
}

interface ArtifactTarget {
  class: string;
  path: string;
  uploadUrl: string;
}

interface ArtifactTargetsResponse {
  targets: Record<string, ArtifactTarget>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function isTerminalStatus(status: number): boolean {
  return TERMINAL_STATUSES.has(status);
}

async function parseJsonOrEmpty<T>(res: Response): Promise<T> {
  try {
    return await res.json() as T;
  } catch {
    return {} as T;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunEnvelope(value: unknown): value is RunEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value.runId !== "string" || value.runId.trim() === "") return false;
  if (typeof value.payloadRef !== "string" || value.payloadRef.trim() === "") return false;
  if (!isRecord(value.payloadJson)) return false;
  if (value.runtime !== "local" && value.runtime !== "docker" && value.runtime !== "kubernetes") return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) return false;
  return true;
}

function isCancellationResponse(value: unknown): value is { cancelRequested: boolean } {
  return isRecord(value) && typeof value.cancelRequested === "boolean";
}

function isArtifactTargetsResponse(value: unknown): value is ArtifactTargetsResponse {
  if (!isRecord(value) || !isRecord(value.targets)) return false;

  for (const target of Object.values(value.targets)) {
    if (!isRecord(target)) return false;
    if (typeof target.class !== "string" || target.class.trim() === "") return false;
    if (typeof target.path !== "string" || target.path.trim() === "") return false;
    if (typeof target.uploadUrl !== "string" || target.uploadUrl.trim() === "") return false;
  }

  return true;
}

async function parseValidatedSuccessBody<T>(
  res: Response,
  suffix: RequestSuffix,
  validator: (value: unknown) => value is T,
): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`invalid success body for ${suffix}`);
  }

  if (!validator(parsed)) {
    throw new Error(`invalid success body for ${suffix}`);
  }

  return parsed;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|timed out|timeout/i.test(error.message));
}

type RequestSuffix = "payload" | "artifacts" | "events" | "complete" | "cancellation";

export class RunnerControlPlaneClient {
  constructor(private readonly cfg: RunnerControlPlaneClientConfig) {}

  async getPayload(opts?: RetryOptions): Promise<RunEnvelope> {
    return this.request<RunEnvelope>("GET", "payload", undefined, opts?.maxAttempts, (res, suffix) =>
      parseValidatedSuccessBody(res, suffix, isRunEnvelope),
    );
  }

  async appendEvent(payload: RunnerEventPayload, opts?: RetryOptions): Promise<void> {
    await this.request("POST", "events", payload, opts?.maxAttempts);
  }

  async complete(payload: RunnerCompletionPayload, opts?: RetryOptions): Promise<void> {
    await this.request("POST", "complete", payload, opts?.maxAttempts);
  }

  async getCancellation(opts?: RetryOptions): Promise<{ cancelRequested: boolean }> {
    return this.request<{ cancelRequested: boolean }>("GET", "cancellation", undefined, opts?.maxAttempts, (res, suffix) =>
      parseValidatedSuccessBody(res, suffix, isCancellationResponse),
    );
  }

  async getArtifacts(opts?: RetryOptions): Promise<ArtifactTargetsResponse> {
    return this.request<ArtifactTargetsResponse>("GET", "artifacts", undefined, opts?.maxAttempts, (res, suffix) =>
      parseValidatedSuccessBody(res, suffix, isArtifactTargetsResponse),
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    suffix: RequestSuffix,
    body?: unknown,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    onSuccess?: (res: Response, suffix: RequestSuffix) => Promise<T>,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}/internal/runs/${this.cfg.runId}/${suffix}`;
    const attempts = Math.max(1, maxAttempts);
    const timeoutMs = Math.max(1, this.cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

      try {
        response = await fetch(url, {
          method,
          signal: abortController.signal,
          headers: {
            authorization: `Bearer ${this.cfg.token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        clearTimeout(timeoutHandle);
        if (attempt === attempts) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`retry budget exhausted for ${suffix}: ${message}`);
        }
        await sleep(BASE_RETRY_DELAY_MS * attempt);
        continue;
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (response.ok) {
        if (onSuccess) {
          return onSuccess(response, suffix);
        }
        return parseJsonOrEmpty<T>(response);
      }

      if (isTerminalStatus(response.status)) {
        throw new Error(`terminal status ${response.status} for ${suffix}`);
      }

      if (!isRetryableStatus(response.status) || attempt === attempts) {
        throw new Error(`retry budget exhausted for ${suffix}: status ${response.status}`);
      }

      await sleep(BASE_RETRY_DELAY_MS * attempt);
    }

    throw new Error(`retry budget exhausted for ${suffix}`);
  }
}
