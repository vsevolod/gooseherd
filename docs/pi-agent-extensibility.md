# Pi-Agent Extensibility Guide

How Gooseherd extends pi-agent without modifying its source code. Ten expansion paths, from simplest to most powerful.

## 1. Extensions (`-e` flag)

Custom tools, hooks, and commands registered at startup.

**How it works:** Pi-agent loads the TypeScript file, calls its default export, and registers the returned tool definitions.

**Gooseherd usage:**
```bash
# .env
PI_AGENT_EXTENSIONS=/app/extensions/gooseherd-cems.ts

# Template (pi_extensions is auto-populated from PI_AGENT_EXTENSIONS)
AGENT_COMMAND_TEMPLATE=cd {{repo_dir}} && pi -p @{{prompt_file}} --no-session --mode json {{pi_extensions}}
```

**Writing an extension:**
```typescript
// extensions/my-extension.ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export default function register(): ToolDefinition[] {
  return [{
    name: "my_tool",
    description: "Does something useful",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (args) => {
      return `Result for ${String(args.query)}`;
    }
  }];
}
```

**Gooseherd integration:** `PI_AGENT_EXTENSIONS` env var (comma-separated) is parsed into `config.piAgentExtensions` and rendered via `{{pi_extensions}}` in the command template. See `extensions/gooseherd-cems.ts` for a real example.

## 2. MCP via pi-mcp-adapter

Connect any MCP (Model Context Protocol) server as pi-agent tools.

**How it works:** `pi install npm:pi-mcp-adapter` installs the adapter, then `--with-extension` flags connect MCP servers.

**Gooseherd usage:**
```bash
# .env
CEMS_MCP_COMMAND=npx -y @anthropic/mcp-server-cems
MCP_EXTENSIONS=npx -y @anthropic/mcp-server-filesystem

# Template (mcp_flags is auto-populated from MCP_EXTENSIONS + CEMS_MCP_COMMAND)
AGENT_COMMAND_TEMPLATE=cd {{repo_dir}} && pi -p @{{prompt_file}} --no-session --mode json {{mcp_flags}}
```

**Gooseherd integration:** `config.mcpExtensions` is populated from `CEMS_MCP_COMMAND` + `MCP_EXTENSIONS` and rendered via `{{mcp_flags}}` in the command template. Each extension becomes `--with-extension 'command'`.

## 3. AGENTS.md / CLAUDE.md

Auto-discovered project context files injected into the system prompt.

**How it works:** Pi-agent scans the working directory for `AGENTS.md` or `CLAUDE.md` at startup. If found, their contents are injected into the system prompt before the first user message.

**Gooseherd usage:** The `hydrate_context` node dynamically writes `AGENTS.md` into the cloned repo directory before the agent runs. This file contains:
- Task context (run ID, repo, task type)
- Organizational memory (CEMS memories from `onPromptEnrich` hooks)
- Project conventions (tech stack, directory structure)
- Coding rules (minimal changes, preserve style)

No pi-agent CLI flags needed — auto-discovery handles it.

## 4. SYSTEM.md / APPEND_SYSTEM.md

Override or extend the system prompt via files.

**How it works:**
- `SYSTEM.md` in the working directory completely replaces the default system prompt
- `APPEND_SYSTEM.md` appends to the default system prompt

**Gooseherd usage:** Not currently used. Prefer `AGENTS.md` (path 3) since it adds context without replacing pi-agent's built-in capabilities. Could be useful for project-specific tool restrictions.

## 5. `--system-prompt` / `--append-system-prompt`

CLI flags for one-shot system prompt injection.

**How it works:**
```bash
pi --system-prompt "You are a Ruby expert" -p @task.md
pi --append-system-prompt "Always write tests" -p @task.md
```

**Gooseherd usage:** Could be added to `AGENT_COMMAND_TEMPLATE` for global behavioral overrides. However, `AGENTS.md` (path 3) is preferred since it's more maintainable and visible to the agent.

## 6. SDK Embedding

Use `createAgentSession()` for in-process control.

**How it works:** Pi-agent exposes an SDK for embedding the agent directly in a Node.js process:
```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

const session = await createAgentSession({
  model: "anthropic/claude-sonnet-4-6",
  tools: ["read", "write", "edit", "bash"],
  systemPrompt: "Custom system prompt",
});

const result = await session.run("Implement dark mode");
```

**Gooseherd usage:** Not currently used — Gooseherd spawns pi-agent as a subprocess for isolation. SDK embedding would be useful for tighter integration (e.g., intercepting tool calls, custom routing).

## 7. RPC Mode

Bidirectional subprocess communication via `--mode rpc`.

**How it works:** Pi-agent runs as a subprocess and communicates via JSON-RPC over stdin/stdout:
```bash
pi --mode rpc --no-session
```

The parent process can send messages and receive events in real-time.

**Gooseherd usage:** Not currently used — `--mode json` (JSONL streaming) provides sufficient observability for the dashboard. RPC mode would enable interactive control (pausing, injecting context mid-run).

## 8. Session Persistence

`SessionManager` for cross-run continuity.

**How it works:** Pi-agent can persist conversation history across runs using session files:
```bash
pi --session my-project -p @task.md  # First run
pi --session my-project -p @fix.md   # Continues with context
```

**Gooseherd usage:** Currently disabled (`--no-session`). Could be enabled for follow-up runs by mapping `run.parentRunId` to a session name, giving the agent full context of what it did previously.

## 9. Event Hooks

25+ lifecycle events with interception capability.

**How it works:** Extensions can register hooks that fire on events like `tool:before`, `tool:after`, `message:before`, `turn:start`, `turn:end`, etc.

```typescript
export default function register() {
  return {
    hooks: {
      "tool:before": async (event) => {
        if (event.tool === "bash" && event.args.command.includes("rm -rf")) {
          return { abort: true, reason: "Destructive command blocked" };
        }
      }
    }
  };
}
```

**Gooseherd usage:** Could be used for safety guardrails (blocking destructive commands), cost tracking (intercepting API calls), or progress reporting (streaming tool calls to the dashboard).

## 10. Custom CLI Flags

Extensions can register their own CLI flags.

**How it works:** Extensions declare flags in their registration:
```typescript
export default function register() {
  return {
    flags: {
      "--cems-team": { type: "string", description: "CEMS team ID" }
    },
    tools: [/* ... */]
  };
}
```

**Gooseherd usage:** Not currently used. Could replace environment variables with explicit flags for better discoverability.

---

## Current Gooseherd Integration

| Path | Status | Mechanism |
|------|--------|-----------|
| Extensions (`-e`) | Active | `PI_AGENT_EXTENSIONS` → `{{pi_extensions}}` |
| MCP adapter | Wired | `MCP_EXTENSIONS` → `{{mcp_flags}}` |
| AGENTS.md | Active | Written by `hydrate_context` node |
| SYSTEM.md | Available | Not used |
| CLI prompt flags | Available | Via template customization |
| SDK embedding | Available | Not used (subprocess model) |
| RPC mode | Available | Not used (`--mode json` sufficient) |
| Session persistence | Available | Disabled (`--no-session`) |
| Event hooks | Available | Not used |
| Custom flags | Available | Not used |

## Adding a New Extension

1. Create `extensions/my-extension.ts` following the pattern in `gooseherd-cems.ts`
2. Add the path to `PI_AGENT_EXTENSIONS` (comma-separated if multiple)
3. Update `Dockerfile` if the extension has dependencies
4. The `{{pi_extensions}}` template variable auto-includes it in the agent command
