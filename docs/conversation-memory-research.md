# Conversation Memory Architecture — Research Findings

## The Problem

Each `handleMessage()` call is **stateless**: the LLM receives `[system, user]` — two messages total. Thread history is reconstructed from Slack's `conversations.replies` API as flat text (300 chars per message, max 20 messages). The LLM's own tool calls, tool results, and reasoning from prior turns are **completely discarded** after each response.

By message 5, the LLM has no memory of:
- What files it read (tool results from prior turns)
- What repos it searched (tool calls from prior turns)
- Its own reasoning about pipeline choices
- Any structured knowledge it acquired

The result: **progressive amnesia** — the bot forgets which repo it's discussing.

---

## Research Summary: 5 Approaches Evaluated

### 1. Full Message History Persistence (Recommended)

**What it is**: Store the complete `ChatMessage[]` array (including tool_use/tool_result) from each `callLLMWithTools` invocation. On the next message, reload it and append the new user message.

**How everyone does it**:
- **Anthropic Messages API**: Stateless by design — you maintain the full message array client-side and send it on every call. Tool cycles use `tool_use` → `tool_result` content blocks linked by ID.
- **Vercel AI SDK**: `messages.push(...response.messages)` pattern — accumulate the full conversation including tool calls/results.
- **LangGraph**: `add_messages` reducer + Checkpointer — persists the entire `StateGraph` (including `AIMessage` with `tool_calls` and `ToolMessage` results) to SQLite/Postgres/memory after every step.

**Key insight**: This is literally how every production system works. The orchestrator's single-shot pattern is an outlier.

**What we'd store** (keyed by `channelId:threadTs`):
```
{ role: "user", content: "fix the login bug in epiccoders/pxls" }
{ role: "assistant", content: [tool_call: describe_repo("epiccoders/pxls")] }
{ role: "tool", content: "Languages: Ruby 60%, JS 30%..." }
{ role: "assistant", content: "I'll queue a run to fix the login bug..." }
{ role: "user", content: "also fix the signup validation" }
...
```

**Storage**: In-memory `Map<string, ChatMessage[]>` with optional JSON file persistence. No database needed — threads are ephemeral (hours/days, not months).

### 2. Server-Side Compaction (Best for Token Management)

**What it is**: Anthropic's native API feature (`compact-2026-01-12` beta). When input tokens exceed a threshold, the API generates a summary and returns a `compaction` content block. All content before the compaction block is automatically ignored on subsequent requests.

**How it works**:
```typescript
context_management: {
  edits: [{
    type: "compact_20260112",
    trigger: { type: "input_tokens", value: 50000 }
  }]
}
```

**Relevance**: Perfect complement to full history persistence. Once the thread conversation grows beyond the token budget, compaction kicks in automatically. No custom summarization code needed.

**Limitation**: Currently Anthropic-specific. Our `callLLMWithTools` uses OpenRouter, which may not support this parameter. But we could implement our own compaction.

### 3. Observation Masking (JetBrains NeurIPS 2025)

**What it is**: Instead of LLM summarization, simply **hide tool result content** from older turns while preserving action and reasoning history in full. Replace old tool results with a placeholder like `[tool result: describe_repo → see earlier in thread]`.

**Research finding** (JetBrains, NeurIPS 2025): Simple observation masking halves cost while matching (and sometimes exceeding) the solve rate of LLM summarization. LLM summaries can mask failure signals, causing agents to persist in unproductive loops.

**For us**: After 5+ tool calls, replace old tool result content with short summaries:
```
{ role: "tool", content: "[describe_repo: Ruby/JS repo, 45 files, Rails app]" }  // was 2000 chars
```

Keep the `tool_use` blocks intact so the LLM knows WHAT it did, just not the full raw output.

### 4. Progressive Summarization / Rolling Summary

**What it is**: Generate a running summary of the conversation after each exchange, inject it as context instead of raw history.

**Pattern**:
1. After each `handleMessage()`, summarize the conversation so far
2. Store the summary keyed by `channelId:threadTs`
3. On next message, inject `## Conversation Summary\n{summary}` instead of raw thread text
4. Re-summarize including the new exchange

**Trade-offs**:
- (+) Bounded token usage regardless of conversation length
- (-) Extra LLM call per message (~$0.01-0.03 per summary)
- (-) Information loss with each summarization step
- (-) Slower response time (must summarize before replying)

**Verdict**: Worse than full history + observation masking. The JetBrains research explicitly found that LLM summarization doesn't outperform simpler observation masking, and it costs more.

### 5. Structured Context Extraction

**What it is**: Instead of freeform summarization, extract structured facts from the conversation:
```json
{
  "repo": "epiccoders/pxls",
  "task": "fix login timeout + add rate limiting",
  "filesRead": ["config/routes.rb", "app/controllers/sessions_controller.rb"],
  "runsQueued": ["abc12345", "def56789"],
  "decisions": ["using default pipeline", "skipped browser_verify"]
}
```

**For us**: Already partially implemented — `existingRunRepo` and `existingRunId` in `HandleMessageRequest`. The problem is we extract too little.

**Verdict**: Good complement to full history, not a replacement. Use structured extraction for the "always-available" context (current repo, current task) and full history for deep reasoning continuity.

---

## Council Verdict: Recommended Architecture

### Primary: Full Message History + Observation Masking

**The fix is simple and well-understood by every framework:**

1. **Store the conversation** — After each `handleMessage()`, persist the full `ChatMessage[]` from `callLLMWithTools` (already returned as `result.messages` but currently ignored).

2. **Reload on next message** — Instead of building a fresh `[{ role: "user", content: assembledString }]`, load the prior conversation and append the new user message.

3. **Mask old observations** — When the conversation exceeds a token threshold (~50K tokens), replace old tool result content with short summaries (keep tool_use blocks intact).

4. **Extract thread context differently** — Stop using Slack's `conversations.replies` as the primary context source. The persisted conversation IS the context. Only use Slack's API for the latest unprocessed message.

### Implementation Shape

```
Message arrives
│
├─ Load conversation from store (Map<threadKey, ChatMessage[]>)
│
├─ If conversation exists:
│   ├─ Apply observation masking if > threshold
│   ├─ Append new user message
│   └─ Call LLM with full history (initialMessages = storedMessages)
│
├─ If no conversation:
│   ├─ Build fresh [{ role: "user", content: message }]
│   └─ Call LLM with fresh context
│
├─ Store result.messages back to conversation store
└─ Post response to Slack
```

### What Changes in Code

| File | Change |
|------|--------|
| `src/orchestrator/conversation-store.ts` | **NEW** — `Map<string, ChatMessage[]>` with get/set/mask operations |
| `src/orchestrator/orchestrator.ts` | Load prior messages, pass as `initialMessages` instead of fresh array |
| `src/llm/caller.ts` | Already supports `initialMessages: ChatMessage[]` — no change needed |
| `src/slack-app.ts` | Pass `threadKey` to orchestrator, stop using `gatherThreadContext()` for LLM context |
| `src/orchestrator/types.ts` | Add `threadKey` to request, add `messages` to result for storage |

### Storage Considerations

- **In-memory `Map`** is fine for now — threads are ephemeral, process restarts are rare
- Thread conversations rarely exceed 20 exchanges (~50-100K tokens max)
- Optional: persist to `runManager.store` (SQLite) for crash recovery
- Cleanup: delete conversations for threads older than 24h

### Token Budget

- Average tool result: 500-2000 tokens
- Average exchange (user + assistant + tools): 3000-5000 tokens
- 10-exchange thread: ~40K tokens — well within 200K context window
- Observation masking kicks in at ~50K, reducing old results to ~100 tokens each
- No summarization LLM call needed until 100K+ tokens (rare for Slack threads)

---

## What NOT To Do

1. **Don't adopt LangGraph/Vercel AI SDK** — We'd be adding a massive dependency to solve a simple storage problem. Our `callLLMWithTools` already handles the agentic loop correctly.

2. **Don't do per-message summarization** — Extra latency, extra cost, and JetBrains research shows it doesn't help vs observation masking.

3. **Don't use Claude Agent SDK** — It wraps Claude Code's CLI process, requires Claude Code installed, and is designed for coding agents, not Slack bots. Overkill.

4. **Don't build a knowledge graph** (Zep/Mem0 pattern) — Thread conversations are short-lived. We don't need temporal reasoning or cross-thread entity extraction.

---

## Sources

- [Anthropic Messages API - Tool Use](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use)
- [Anthropic Compaction API](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Vercel AI SDK — Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [LangGraph Persistence/Checkpointing](https://github.com/langchain-ai/langgraph/blob/main/docs/docs/concepts/persistence.md)
- [LangGraph Cross-Thread Memory](https://langchain-ai.github.io/langgraph/how-tos/cross-thread-persistence-functional/)
- [The Complexity Trap: Observation Masking vs LLM Summarization](https://arxiv.org/abs/2508.21433) (JetBrains, NeurIPS 2025)
- [Mem0 Chat History Summarization Guide](https://mem0.ai/blog/llm-chat-history-summarization-guide-2025)
