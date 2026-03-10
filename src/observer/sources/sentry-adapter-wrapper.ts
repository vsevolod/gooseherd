/**
 * Sentry webhook adapter wrapper — bridges the existing Sentry webhook adapter
 * into the generic WebhookAdapter interface.
 *
 * Uses a factory function because Sentry needs an alertChannelId at construction time.
 */

import type { WebhookAdapter } from "./adapter-registry.js";
import { verifySentrySignature, parseSentryWebhook, type SentryWebhookHeaders } from "./sentry-webhook-adapter.js";

export function createSentryAdapter(alertChannelId: string): WebhookAdapter {
  return {
    source: "sentry_alert",
    verifySignature(body, headers, secret) {
      return verifySentrySignature(body, headers["sentry-hook-signature"], secret);
    },
    parseEvent(headers, payload) {
      const sentryHeaders: SentryWebhookHeaders = {
        "sentry-hook-resource": headers["sentry-hook-resource"],
        "sentry-hook-timestamp": headers["sentry-hook-timestamp"],
        "sentry-hook-signature": headers["sentry-hook-signature"]
      };
      return parseSentryWebhook(sentryHeaders, payload as Record<string, unknown>, alertChannelId);
    }
  };
}
