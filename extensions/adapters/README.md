# Extension Adapters

Drop webhook adapter files here. Each file should export a `WebhookAdapter`:

```typescript
import type { WebhookAdapter } from "../../src/observer/sources/adapter-registry.js";

export const adapter: WebhookAdapter = {
  source: "my_service",
  verifySignature(body, headers, secret) {
    // Verify HMAC or other signature
    return true;
  },
  parseEvent(headers, payload) {
    // Parse into TriggerEvent or return null
    return null;
  }
};
```

Configure the webhook secret in OBSERVER_WEBHOOK_SECRETS:
```
OBSERVER_WEBHOOK_SECRETS=my_service:your-secret-here
```
