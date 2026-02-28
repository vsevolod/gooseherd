# Browser Verification: Research Synthesis & Recommendation

**Date**: 2026-02-28
**Input**: 4 parallel research agents investigating 10+ tools, 8 academic benchmarks, 6 production QA vendors

---

## TL;DR

**Switch from "JSON plan" to "tool_use agentic loop."** Keep DOM-first. Use Stagehand as the execution layer.

The current approach (accessibility tree + DOM queries + screenshot verdict) is architecturally correct — it independently arrived at the same pattern as Stagehand, Browser-Use, and Playwright MCP. The problem is HOW we drive the LLM: we ask it to output a JSON plan of 8 actions, execute them all blindly, then re-snapshot. This is what breaks.

The fix is **tool_use**: the LLM calls one tool at a time, gets results after each call, and decides what to do next. This is what Claude Code, Cursor, and every MCP-based tool does. It's why they work and ours doesn't.

---

## Key Findings (Cross-Agent Consensus)

### 1. DOM-first beats screenshot-only for web verification

Every benchmark confirms this:
- VisualWebArena: text-only GPT-4 = **16.4%**, visual-only GPT-4V = **5.6%**
- Set-of-Marks: +23 absolute points over text-only baseline
- Stagehand, Browser-Use, Playwright MCP all use accessibility tree as primary signal

**Our a11y tree approach is correct.** Screenshots are supplementary for visual verdict, not primary for navigation/verification.

### 2. Tool_use > JSON plan (the actual problem)

| Pattern | How it works | Feedback |
|---------|-------------|----------|
| **JSON plan** (current) | LLM outputs 8 actions at once, we execute blindly | None until next round |
| **Tool_use** (proposed) | LLM calls one tool, gets result, calls next | After EVERY action |

Our CSS selector failures (`h2` matching 3 elements) happen because the LLM can't see that its first attempt failed. With tool_use, it would see the error immediately and try `.features-title h2` on the next call.

### 3. Computer Use is overkill and expensive

| Metric | Current (DOM) | Computer Use |
|--------|--------------|-------------|
| Cost per verification | $0.03-0.08 | $0.09-0.32 |
| Latency | 15-30s | 30-90s |
| Docker image | ~500MB | ~2GB (needs Xvfb) |
| Best for | Web verification | Desktop automation |

Computer Use sends a screenshot with EVERY action, and conversation history grows with all previous screenshots. A 15-step verification costs ~$0.32 vs ~$0.08 for DOM-first.

### 4. Stagehand is the best execution layer

| Feature | agent-browser CLI | Stagehand | Playwright MCP |
|---------|------------------|-----------|---------------|
| Language | CLI subprocess | TypeScript native | MCP protocol |
| Element targeting | @refs + CSS selectors | Natural language + a11y tree | @refs (same as ours) |
| Auth handling | Manual LLM-planned | `act("log in with...")` | Manual |
| Structured output | JSON parse | Zod schema validation | None |
| Agent loop | We build it | Built-in `agent.execute()` | We build it |
| Docker | Works | Works | Works |
| Strict mode | Fails on multi-match | Handles internally | Same issue |

Stagehand solves the strict mode problem by having the LLM describe WHAT to interact with ("click the Curated collections heading") and resolving it internally via a11y tree + XPath. No CSS selectors exposed to the LLM.

---

## Recommended Architecture

### Phase 1: Tool_use agentic loop (HIGH IMPACT, keep agent-browser)

Replace the JSON-plan system with proper tool_use. The LLM gets tools like `browser_navigate`, `browser_click`, `browser_evaluate`, `browser_snapshot`. It calls them one at a time and gets results back.

**Files to modify:**
- `src/llm/caller.ts` — add `callLLMWithTools()` function
- `src/pipeline/quality-gates/browser-verify-node.ts` — replace `runAgentBrowserVerification()` with tool_use loop
- New: `src/pipeline/quality-gates/browser-tools.ts` — tool definitions
- New: `src/pipeline/quality-gates/agent-browser-executor.ts` — wraps agent-browser CLI as tool executor

**What changes for the LLM:**
```
BEFORE: "Output a JSON plan with 8 actions"
AFTER:  "You have browser tools. Call them to verify the feature. When done, respond with your verdict."
```

### Phase 2: Stagehand integration (MEDIUM IMPACT, replaces agent-browser)

Replace agent-browser CLI with Stagehand as a TypeScript library:

```typescript
const stagehand = new Stagehand({
  env: "LOCAL",
  llmClient: new CustomOpenAIClient({
    modelName: "anthropic/claude-sonnet-4-6",
    client: new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey }),
  }),
  localBrowserLaunchOptions: { headless: true, executablePath: "/usr/bin/chromium" },
});

const agent = stagehand.agent({ mode: "hybrid" });
const result = await agent.execute({
  instruction: `Verify: ${task}. Files changed: ${changedFiles.join(", ")}`,
  maxSteps: 15,
  output: z.object({
    passed: z.boolean(),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
  }),
});
```

This replaces our entire observe-act loop, agent-browser CLI, JSON plan system, and vision verdict with a single `agent.execute()` call that returns a Zod-validated result.

### Phase 3 (Future): CUA mode for visual-heavy pages

Add optional Anthropic Computer Use via Stagehand's CUA mode for pages where DOM provides no information (canvas, WebGL, complex CSS animations):

```typescript
const agent = stagehand.agent({ mode: "cua", model: "anthropic/claude-sonnet-4-6" });
```

Requires a direct `ANTHROPIC_API_KEY` (not OpenRouter). Only use for repos that opt in.

---

## What NOT to Do

1. **Don't switch to screenshot-primary.** It's 2-10x more expensive, slower, and less accurate for web verification.
2. **Don't use Browser-Use.** It's Python-only and overkill for our targeted verification task.
3. **Don't use Playwright MCP server.** It adds protocol complexity without adding agent intelligence — we'd still need to build the agent loop ourselves.
4. **Don't use Anthropic Computer Use directly.** Use it through Stagehand which abstracts the provider.
5. **Don't build a custom screenshot loop.** Stagehand already solved this — use their agent framework.

---

## Decision Matrix

| Approach | Cost | Effort | Impact | Recommendation |
|----------|------|--------|--------|---------------|
| Tool_use loop (Phase 1) | $0 | 2-3 days | HIGH | **Do first** |
| Stagehand integration (Phase 2) | $0 | 3-5 days | HIGH | **Do second** |
| CUA mode (Phase 3) | ANTHROPIC_API_KEY | 1-2 days | LOW | **Future, opt-in** |
| Computer Use (direct) | ANTHROPIC_API_KEY + Xvfb | 5+ days | LOW | **Skip** |
| Browser-Use | Python sidecar | 5+ days | MEDIUM | **Skip** |

---

## Sources

### Benchmarks
- WebArena (ICLR 2024): arxiv.org/abs/2307.13854
- VisualWebArena (2024): arxiv.org/abs/2401.13649
- WebVoyager (ACL 2024): aclanthology.org/2024.acl-long.371
- Set-of-Mark prompting: arxiv.org/abs/2401.01614
- Anthropic Claude System Card: anthropic.com

### Tools
- Stagehand: github.com/browserbase/stagehand, docs.stagehand.dev
- Playwright MCP: github.com/microsoft/playwright-mcp
- Browser-Use: github.com/browser-use/browser-use
- Anthropic Computer Use: platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- agent-browser: github.com/vercel-labs/agent-browser

### Production QA
- Momentic (CV/AI auto-heal), Testim (Smart Locators), mabl (adaptive healing), Reflect (semantic locators)
