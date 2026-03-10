/**
 * Webhook adapter interface and registry.
 *
 * Adapters convert external webhook payloads into TriggerEvents.
 * Built-in adapters (GitHub, Sentry) and custom adapters (in extensions/)
 * all implement the same interface.
 */

import type { TriggerEvent } from "../types.js";

export interface WebhookAdapter {
  /** Source identifier (matches TriggerSource string) */
  source: string;
  /** Verify the webhook signature. Return true if valid, false to reject. */
  verifySignature(body: string, headers: Record<string, string>, secret: string): boolean;
  /** Parse the webhook payload into a TriggerEvent. Return null if not actionable. */
  parseEvent(headers: Record<string, string>, payload: unknown): TriggerEvent | null;
}

const adapters = new Map<string, WebhookAdapter>();

/** Register a webhook adapter. */
export function registerAdapter(adapter: WebhookAdapter): void {
  adapters.set(adapter.source, adapter);
}

/** Get a registered adapter by source name. */
export function getAdapter(source: string): WebhookAdapter | undefined {
  return adapters.get(source);
}

/** List all registered adapter source names. */
export function listAdapters(): string[] {
  return Array.from(adapters.keys());
}
