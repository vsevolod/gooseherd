/**
 * GitHub webhook adapter wrapper — bridges the existing GitHub webhook adapter
 * into the generic WebhookAdapter interface.
 */

import type { WebhookAdapter } from "./adapter-registry.js";
import { verifyGitHubSignature, parseGitHubWebhook, type GitHubWebhookHeaders } from "./github-webhook-adapter.js";

export const githubAdapter: WebhookAdapter = {
  source: "github_webhook",
  verifySignature(body, headers, secret) {
    return verifyGitHubSignature(body, headers["x-hub-signature-256"], secret);
  },
  parseEvent(headers, payload) {
    const ghHeaders: GitHubWebhookHeaders = {
      "x-github-event": headers["x-github-event"],
      "x-hub-signature-256": headers["x-hub-signature-256"],
      "x-github-delivery": headers["x-github-delivery"]
    };
    return parseGitHubWebhook(ghHeaders, payload as Record<string, unknown>);
  }
};
