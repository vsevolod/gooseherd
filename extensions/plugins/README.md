# Gooseherd Plugins

Drop `.ts` or `.js` files in this directory. Each must default-export a `GooseherdPlugin`.

## Example Plugin

```typescript
import type { GooseherdPlugin } from "../../src/plugins/plugin-types.js";

const plugin: GooseherdPlugin = {
  name: "example-plugin",
  version: "1.0.0",
  nodeHandlers: {
    my_action: async (nodeConfig, ctx, deps) => {
      // Custom node logic
      return { outcome: "success" };
    }
  }
};

export default plugin;
```

## Plugin Interface

- `name` (string, required): Unique plugin identifier
- `version` (string, required): SemVer version
- `nodeHandlers` (object, optional): Map of action name to NodeHandler function
- `webhookAdapters` (array, optional): Array of WebhookAdapter objects
