/**
 * Gooseherd CEMS Extension for pi-agent.
 *
 * Registers `memory_recall` and `memory_store` as first-class tools
 * that the coding agent can call during execution for on-demand access
 * to organizational memory (past solutions, patterns, gotchas).
 *
 * Requires CEMS_API_URL and CEMS_API_KEY environment variables.
 * Silently skips registration if not configured.
 *
 * Usage:
 *   pi -e /app/extensions/gooseherd-cems.ts -p @task.md
 */

const CEMS_API_URL = process.env.CEMS_API_URL?.trim();
const CEMS_API_KEY = process.env.CEMS_API_KEY?.trim();
const CEMS_TEAM_ID = process.env.CEMS_TEAM_ID?.trim();

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

interface CemsSearchResult {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  score?: number;
}

async function cemsRequest(
  endpoint: string,
  method: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const url = `${CEMS_API_URL}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (CEMS_API_KEY) {
    headers["Authorization"] = `Bearer ${CEMS_API_KEY}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`CEMS API ${method} ${endpoint} failed: ${String(response.status)} ${text}`);
  }

  return response.json();
}

const memoryRecall: ToolDefinition = {
  name: "memory_recall",
  description:
    "Search organizational memory for relevant past solutions, patterns, and gotchas. " +
    "Use this when you encounter a problem that the team may have solved before, " +
    "or when you need to understand established patterns in the codebase.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query describing what you're looking for (e.g., 'authentication pattern', 'deploy preview fix')",
      },
      category: {
        type: "string",
        description: "Optional category filter (e.g., 'debugging', 'patterns', 'error-fix')",
      },
      limit: {
        type: "number",
        description: "Max results to return (default: 5)",
      },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const query = String(args.query ?? "");
    const category = args.category ? String(args.category) : undefined;
    const limit = typeof args.limit === "number" ? args.limit : 5;

    const body: Record<string, unknown> = { query, limit };
    if (category) body.category = category;
    if (CEMS_TEAM_ID) body.team_id = CEMS_TEAM_ID;

    const results = (await cemsRequest("/api/memory/search", "POST", body)) as {
      memories?: CemsSearchResult[];
    };

    const memories = results.memories ?? [];
    if (memories.length === 0) {
      return "No relevant memories found.";
    }

    return memories
      .map((m, i) => {
        const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
        const cat = m.category ? ` (${m.category})` : "";
        return `### Memory ${String(i + 1)}${cat}${tags}\n${m.content}`;
      })
      .join("\n\n");
  },
};

const memoryStore: ToolDefinition = {
  name: "memory_store",
  description:
    "Save a discovery, pattern, or solution to organizational memory for future runs. " +
    "Use this when you find a non-obvious fix, discover an important pattern, " +
    "or learn something that would help future agents working on this codebase.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The memory content to store (be specific and actionable)",
      },
      category: {
        type: "string",
        description: "Category for the memory (e.g., 'debugging', 'patterns', 'error-fix', 'gotcha')",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags for searchability (e.g., ['rails', 'authentication', 'devise'])",
      },
    },
    required: ["content"],
  },
  execute: async (args) => {
    const content = String(args.content ?? "");
    const category = args.category ? String(args.category) : "general";
    const tags = Array.isArray(args.tags)
      ? args.tags.map((t) => String(t))
      : [];

    const body: Record<string, unknown> = { content, category, tags };
    if (CEMS_TEAM_ID) body.team_id = CEMS_TEAM_ID;

    await cemsRequest("/api/memory/add", "POST", body);

    return "Memory stored successfully.";
  },
};

// ── Extension registration ──

/**
 * Pi-agent extension entry point.
 * Returns an array of tool definitions to register.
 * Returns empty array if CEMS is not configured.
 */
export default function register(): ToolDefinition[] {
  if (!CEMS_API_URL) {
    return [];
  }
  return [memoryRecall, memoryStore];
}
