# Browser Verification Research: Screenshot-Based Approaches for AI-Driven Web Verification

**Date**: 2026-02-28
**Context**: Gooseherd currently uses `agent-browser` (Vercel CLI) with text-based accessibility snapshots + LLM action planning. This is brittle (strict mode violations, stale @refs, no visual context). We are evaluating screenshot-based alternatives.

---

## Table of Contents

1. [Current System Problems](#current-system-problems)
2. [Anthropic Computer Use API](#1-anthropic-computer-use-api)
3. [Stagehand (Browserbase)](#2-stagehand-browserbase)
4. [Playwright MCP Server](#3-playwright-mcp-server)
5. [Browser Use](#4-browser-use)
6. [OpenHands / BrowserGym](#5-openhands--browsergym)
7. [DIY: Playwright + Vision Model](#6-diy-playwright--vision-model)
8. [Comparison Table](#comparison-table)
9. [Recommendation](#recommendation)
10. [Integration Examples](#integration-examples)

---

## Current System Problems

Our `browser-verify-node.ts` observe-act loop suffers from:

1. **Strict mode violations**: `get_text 'h2'` fails when multiple h2 elements exist. The LLM must generate perfectly specific CSS selectors.
2. **Stale @ref identifiers**: After `navigate`, all `@e5`-style refs become invalid. We track this but it consumes rounds.
3. **No visual grounding**: The accessibility tree is text-only. The LLM cannot verify colors, layout, spacing, images, or visual regressions.
4. **Auth overhead**: Login flows consume 2-3 of our 5 max rounds, leaving minimal budget for actual verification.
5. **agent-browser CLI overhead**: Each command spawns a subprocess (~200ms), and the snapshot + action cycle adds ~30s per round.

---

## 1. Anthropic Computer Use API

### Architecture: Screenshot-based with pixel coordinates

The Computer Use API is a special tool type in Anthropic's Messages API. Claude sees screenshots and returns actions with pixel coordinates -- no DOM, no selectors, no @refs.

### How It Works

1. You define a `computer` tool with screen dimensions
2. Claude receives a screenshot and returns tool_use blocks with actions (click at x,y; type text; press key)
3. You execute the action via Playwright, take a new screenshot, return it as tool_result
4. Loop until Claude returns text (not tool_use)

### API Format

```typescript
// Tool definition
const tools = [{
  type: "computer_20250124",  // versioned tool type
  name: "computer",
  display_width_px: 1280,
  display_height_px: 800,
  // Optional: display_number for multi-monitor
}];

// Claude returns actions like:
{
  type: "tool_use",
  id: "toolu_xxx",
  name: "computer",
  input: {
    action: "left_click",  // or: screenshot, type, key, scroll, mouse_move, etc.
    coordinate: [640, 400]  // pixel coordinates
  }
}

// You return screenshot as tool_result:
{
  type: "tool_result",
  tool_use_id: "toolu_xxx",
  content: [{
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "..." }
  }]
}
```

### Available Actions

- `screenshot` - Request current screen state
- `left_click`, `right_click`, `middle_click`, `double_click` - Click at coordinates
- `mouse_move` - Move cursor to coordinates
- `type` - Type text string
- `key` - Press key combination (e.g., "Return", "ctrl+a")
- `scroll` - Scroll up/down/left/right at coordinates
- Newer versions (`computer_20251124`) add `zoom`, drag operations

### Supported Models

- `claude-sonnet-4-20250514` (and later sonnet versions)
- `claude-opus-4-20250514` (and later)
- `claude-sonnet-4-5-20250929`
- `claude-opus-4-5-20251101`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5-20251001`

### Docker/Headless Compatibility

**No VNC or X11 required.** The Anthropic reference implementation uses Xvfb + VNC for a full desktop, but this is NOT required. For browser-only use cases, you implement the tool executor with headless Playwright:

```typescript
async function executeComputerAction(action: any, page: Page): Promise<string> {
  switch (action.action) {
    case "screenshot":
      const buf = await page.screenshot();
      return buf.toString("base64");
    case "left_click":
      await page.mouse.click(action.coordinate[0], action.coordinate[1]);
      return (await page.screenshot()).toString("base64");
    case "type":
      await page.keyboard.type(action.text);
      return (await page.screenshot()).toString("base64");
    case "key":
      await page.keyboard.press(action.key);
      return (await page.screenshot()).toString("base64");
    case "scroll":
      const delta = action.direction === "down" ? 300 : -300;
      await page.mouse.wheel(0, delta);
      return (await page.screenshot()).toString("base64");
  }
}
```

### OpenRouter Compatibility

**Uncertain.** OpenRouter supports Claude models, but the `computer_use` tool type requires specific beta headers (`betas: ["computer-use-2025-01-24"]`) that may not be forwarded correctly through OpenRouter. The Anthropic direct API is the safe path. Since we already have `OPENROUTER_API_KEY`, we would need a separate `ANTHROPIC_API_KEY` environment variable.

### Cost/Latency

- Each screenshot is ~100-200K tokens (image input)
- Each action cycle: ~3-5 seconds (screenshot capture + API call + action execution)
- A 10-step verification: ~30-50 seconds, ~$0.05-0.15
- More expensive than text-only approaches, but more reliable

### Ratings

| Criterion | Score |
|-----------|-------|
| Reliability (diverse pages) | 5/5 |
| Docker/headless support | 5/5 |
| TypeScript integration | 4/5 |
| LLM flexibility | 2/5 (Anthropic API only) |
| Maturity | 4/5 |
| Element targeting robustness | 5/5 (pixel coords, no selectors) |

---

## 2. Stagehand (Browserbase)

### Architecture: Hybrid (DOM + Vision + CUA)

Stagehand v3 (`@browserbasehq/stagehand@3.1.0`) is a TypeScript library built on Playwright with three agent modes:

- **DOM mode** (default): Uses accessibility tree + LLM to identify elements by semantic description, generates Playwright locators internally
- **Hybrid mode**: Combines coordinate-based vision tools (click at x,y) with DOM tools (act, extract)
- **CUA mode**: Delegates to provider-native Computer Use Agents (Anthropic, OpenAI, Google, Microsoft)

### Key APIs

```typescript
import { Stagehand } from "@browserbasehq/stagehand";

const stagehand = new Stagehand({
  env: "LOCAL",  // or "BROWSERBASE" for cloud
  model: "claude-sonnet-4-6",  // or any supported model
  localBrowserLaunchOptions: {
    headless: true,
    executablePath: "/usr/bin/chromium",
    chromiumSandbox: false,
    args: ["--no-sandbox"],
  },
});
await stagehand.init();

// High-level APIs
await stagehand.act("click the Sign Up button");
const data = await stagehand.extract("get the page title", z.object({ title: z.string() }));
const actions = await stagehand.observe("find all navigation links");

// Agent API (autonomous multi-step)
const agent = stagehand.agent({ mode: "dom" });  // or "hybrid" or "cua"
const result = await agent.execute({
  instruction: "Log in with test@example.com / TestPass123, navigate to /dashboard, verify the welcome message shows 'Hello Test User'",
  maxSteps: 20,
});
console.log(result.success, result.message);
```

### CUA Models Supported (from actual type definitions)

```
"openai/computer-use-preview"
"openai/computer-use-preview-2025-03-11"
"anthropic/claude-3-7-sonnet-latest"
"anthropic/claude-opus-4-5-20251101"
"anthropic/claude-opus-4-6"
"anthropic/claude-sonnet-4-6"
"anthropic/claude-haiku-4-5-20251001"
"anthropic/claude-sonnet-4-20250514"
"anthropic/claude-sonnet-4-5-20250929"
"google/gemini-2.5-computer-use-preview-10-2025"
"google/gemini-3-flash-preview"
"google/gemini-3-pro-preview"
"microsoft/fara-7b"
```

### How It Handles Strict Mode

Stagehand's `act()` internally uses `observe()` to find the right element via accessibility tree analysis, then constructs a Playwright locator. It is significantly more robust than our current raw-selector approach because:

1. The LLM describes WHAT to interact with semantically ("click the Sign Up button")
2. Stagehand's internal code resolves this to a specific DOM element using accessibility tree + XPath
3. Multiple matching elements are disambiguated by the LLM seeing the full tree context

However, in **CUA mode**, it bypasses DOM entirely and uses pixel coordinates from screenshots, which avoids strict mode entirely.

### OpenRouter / Custom API Compatibility

Stagehand supports `CustomOpenAIClient` which accepts any OpenAI-compatible endpoint:

```typescript
import { Stagehand, CustomOpenAIClient } from "@browserbasehq/stagehand";
import OpenAI from "openai";

const openrouterClient = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const stagehand = new Stagehand({
  env: "LOCAL",
  llmClient: new CustomOpenAIClient({
    modelName: "anthropic/claude-sonnet-4-6",
    client: openrouterClient,
  }),
  localBrowserLaunchOptions: { headless: true },
});
```

**Important caveat**: CUA mode requires direct provider APIs (Anthropic SDK for Anthropic CUA, OpenAI SDK for OpenAI CUA). The `CustomOpenAIClient` works for DOM/hybrid mode but NOT for CUA mode.

### Docker/Headless

Works perfectly. Stagehand uses Playwright internally, and `env: "LOCAL"` with headless launch options runs in Docker without issues. It uses `chrome-launcher` to find/launch Chrome.

### License

MIT (open source)

### Ratings

| Criterion | Score |
|-----------|-------|
| Reliability (diverse pages) | 4/5 |
| Docker/headless support | 5/5 |
| TypeScript integration | 5/5 (native) |
| LLM flexibility | 4/5 (OpenAI-compatible for DOM/hybrid; direct API for CUA) |
| Maturity | 4/5 |
| Element targeting robustness | 4/5 (DOM mode improves, CUA mode eliminates) |

---

## 3. Playwright MCP Server

### Architecture: DOM-first with optional Vision

`@playwright/mcp@0.0.68` by Microsoft exposes Playwright as an MCP server. Default mode uses accessibility snapshots (like our current approach). Vision mode (`--caps=vision`) adds coordinate-based screenshot tools.

### Capabilities

- **core** (default): `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot` (accessibility tree), `browser_take_screenshot`
- **vision**: `browser_screen_move_mouse`, `browser_screen_click`, `browser_screen_type`, `browser_screen_drag` (all coordinate-based)
- **pdf**: PDF generation
- **devtools**: Console, network monitoring
- **testing**: Test assertion tools

### How It Works

It's an MCP server, meaning it communicates via the Model Context Protocol (stdio or SSE transport). An LLM client sends tool calls, the server executes them against a Playwright browser, and returns results.

```typescript
import { createConnection } from "@playwright/mcp";

const server = await createConnection({
  browser: {
    browserName: "chromium",
    launchOptions: { headless: true, executablePath: "/usr/bin/chromium" },
    contextOptions: { viewport: { width: 1280, height: 800 } },
  },
  capabilities: ["core", "vision"],
});
```

### Integration Approach

To use this programmatically (not as an MCP server for Claude Desktop), you would:

1. Create the MCP connection
2. Use `@modelcontextprotocol/sdk` client to send tool calls
3. Wire your own LLM to generate tool calls based on the tool schemas

This is MORE overhead than using Playwright directly. The MCP layer adds protocol complexity without adding intelligence -- it's designed for external MCP clients, not for embedding in your own agent loop.

### Relevance to Our Use Case

**Low.** The Playwright MCP server's default mode (accessibility snapshots) is essentially what we already have with `agent-browser`. The vision mode adds coordinate tools but still requires you to build the agent loop yourself. We'd get more value from using Playwright directly or from Stagehand which already has the agent loop built in.

### Ratings

| Criterion | Score |
|-----------|-------|
| Reliability (diverse pages) | 3/5 |
| Docker/headless support | 5/5 |
| TypeScript integration | 3/5 (MCP protocol adds overhead) |
| LLM flexibility | 5/5 (model-agnostic) |
| Maturity | 3/5 (v0.0.68, API still evolving) |
| Element targeting robustness | 3/5 (same DOM issues in core mode; vision mode helps) |

---

## 4. Browser Use

### Architecture: Python-first agent framework

`browser-use` (github.com/browser-use/browser-use) is a Python library for browser automation. It uses a hybrid approach (DOM + vision) with its own agent loop.

```python
from browser_use import Agent, Browser
from langchain_openai import ChatOpenAI

agent = Agent(
    task="Verify the signup button is visible on the homepage",
    llm=ChatOpenAI(model="gpt-4o"),
    browser=Browser(),
)
result = await agent.run()
```

### Key Characteristics

- **Python-only**: No TypeScript/Node.js version. Would require a Python sidecar process.
- **LLM providers**: Uses LangChain, so supports any LangChain-compatible provider (OpenAI, Anthropic, etc.)
- **Headless Docker**: Yes, with Playwright under the hood
- **License**: MIT
- **Element targeting**: Uses a "Set of Marks" (SoM) approach -- overlays numbered labels on interactive elements in screenshots, so the LLM clicks by label number rather than pixel coordinates
- **Active development**: Popular (50k+ GitHub stars), but Python-centric

### Integration for Gooseherd

Would require spawning a Python subprocess or running a Python microservice. Given our TypeScript codebase, this adds significant operational complexity:

```typescript
// Would need something like:
const result = await runShellCapture(
  `python3 -c "import asyncio; from browser_use import Agent; ..."`,
  { cwd: runDir, logFile }
);
```

This is fragile, adds a Python dependency to our Docker image, and loses type safety.

### Ratings

| Criterion | Score |
|-----------|-------|
| Reliability (diverse pages) | 4/5 |
| Docker/headless support | 4/5 |
| TypeScript integration | 1/5 (Python-only) |
| LLM flexibility | 5/5 (LangChain) |
| Maturity | 3/5 (popular but still evolving) |
| Element targeting robustness | 4/5 (SoM approach avoids selectors) |

---

## 5. OpenHands / BrowserGym

### Architecture: Research-oriented Python platform

**OpenHands** (formerly OpenDevin) is a full AI coding agent platform with browser capabilities. **BrowserGym** (by ServiceNow) is a research benchmark framework for web agents.

### OpenHands Browser

- Runs inside a Docker sandbox with a full desktop (Xvfb)
- Uses multiple approaches: Playwright for structured interaction, can delegate to CUA
- Python-based, not designed to be extracted as a standalone library
- More suited for full coding agent workflows, not isolated verification

### BrowserGym

- Research benchmark (like WebArena, Mind2Web)
- Provides standardized "Gym" environment for training/evaluating web agents
- Python/Playwright, explicitly warns "not intended as a consumer product"
- Useful for evaluation, not for production integration

### Relevance to Our Use Case

**Very low.** Both are Python-heavy, research-oriented, and designed for broader agent platforms, not embeddable verification tools.

### Ratings

| Criterion | Score |
|-----------|-------|
| Reliability (diverse pages) | 3/5 |
| Docker/headless support | 4/5 |
| TypeScript integration | 1/5 (Python-only) |
| LLM flexibility | 4/5 |
| Maturity | 2/5 (research, not production) |
| Element targeting robustness | 3/5 |

---

## 6. DIY: Playwright + Vision Model

### Architecture: Custom screenshot loop with any vision-capable LLM

The simplest approach: use Playwright directly to take screenshots, send them to any vision model via OpenRouter, get back instructions (in a structured JSON format we define), execute them via Playwright.

### How It Works

```typescript
// 1. Take screenshot
const screenshot = await page.screenshot();
const base64 = screenshot.toString("base64");

// 2. Ask LLM what to do (structured JSON response)
const response = await callLLMVision(llmConfig, {
  system: VERIFY_AGENT_SYSTEM,
  userContent: [
    { type: "text", text: `Task: ${task}\nWhat do you see? What action should I take?` },
    { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }
  ],
  maxTokens: 512,
  jsonMode: true,
});

// 3. Parse action
const action = extractJSON<VerifyAction>(response.content);
// action = { type: "click", x: 640, y: 400, reason: "click Sign Up button" }
// OR: { type: "verdict", passed: true, reasoning: "..." }

// 4. Execute
if (action.type === "click") {
  await page.mouse.click(action.x, action.y);
} else if (action.type === "type") {
  await page.keyboard.type(action.text);
}
// Take new screenshot, loop
```

### Advantages

- **Zero new dependencies**: We already have Playwright and the LLM caller
- **Any LLM via OpenRouter**: Claude, GPT-4o, Gemini -- all support vision
- **Full control**: We define the action schema, the loop, the termination conditions
- **Cheapest to implement**: Modify `browser-verify-node.ts` to use screenshots instead of snapshots

### Disadvantages

- **We own the agent loop**: No battle-tested agent framework handling edge cases
- **Coordinate accuracy varies by model**: Some models struggle with precise pixel targeting
- **No DOM fallback**: Pure screenshot means we lose the ability to do `get_text`/`get_count` assertions

### Ratings

| Criterion | Score |
|-----------|-------|
| Reliability (diverse pages) | 3/5 |
| Docker/headless support | 5/5 |
| TypeScript integration | 5/5 (native) |
| LLM flexibility | 5/5 (any vision model) |
| Maturity | 2/5 (custom code) |
| Element targeting robustness | 3/5 (depends on model precision) |

---

## Comparison Table

| Approach | Reliability | Docker | TypeScript | LLM Flex | Maturity | Targeting | Best For |
|----------|-----------|--------|-----------|---------|---------|-----------|---------|
| Anthropic Computer Use | 5 | 5 | 4 | 2 | 4 | 5 | Maximum reliability, budget allows Anthropic API |
| Stagehand | 4 | 5 | 5 | 4 | 4 | 4 | TypeScript-native, multi-provider, production use |
| Playwright MCP | 3 | 5 | 3 | 5 | 3 | 3 | Already using MCP protocol |
| Browser Use | 4 | 4 | 1 | 5 | 3 | 4 | Python-native projects |
| OpenHands/BrowserGym | 3 | 4 | 1 | 4 | 2 | 3 | Research/evaluation |
| DIY Playwright+Vision | 3 | 5 | 5 | 5 | 2 | 3 | Minimal dependencies, fast iteration |

---

## Recommendation

### Primary: Stagehand with Agent API

**For our specific use case**, Stagehand is the best fit:

1. **TypeScript-native**: Direct npm dependency, full type safety, no Python sidecar
2. **Three modes**: Start with DOM mode (improved version of what we have), upgrade to hybrid or CUA as needed
3. **Agent API**: Built-in multi-step agent loop with `agent.execute()` -- replaces our hand-rolled observe-act loop
4. **OpenRouter compatibility**: `CustomOpenAIClient` works with OpenRouter for DOM/hybrid mode
5. **Local Playwright**: `env: "LOCAL"` with `headless: true` works in our Docker sandbox
6. **Structured output**: `extract()` with Zod schemas for the verification verdict

### Integration Strategy

**Phase 1: Drop-in replacement for browser-verify-node.ts**

Replace the `agent-browser` CLI calls with Stagehand's agent API:

```typescript
const stagehand = new Stagehand({
  env: "LOCAL",
  llmClient: new CustomOpenAIClient({
    modelName: config.browserVerifyModel,
    client: new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: config.openrouterApiKey,
    }),
  }),
  localBrowserLaunchOptions: {
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    chromiumSandbox: false,
    args: ["--no-sandbox", "--disable-gpu"],
  },
  experimental: true,  // needed for variables
});
await stagehand.init();

const page = stagehand.context.pages()[0];
await page.goto(reviewAppUrl, { waitUntil: "networkidle", timeout: 30_000 });

// Single agent call replaces our entire observe-act loop
const agent = stagehand.agent({ mode: "hybrid" });
const result = await agent.execute({
  instruction: buildVerificationInstruction(task, changedFiles),
  maxSteps: 15,
  variables: credentials ? {
    email: { value: credentials.email, description: "Test account email" },
    password: { value: credentials.password, description: "Test account password" },
  } : undefined,
  output: z.object({
    passed: z.boolean(),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
  }),
});

// result.output = { passed: true, confidence: "high", reasoning: "..." }
await stagehand.close();
```

**Phase 2: CUA mode for maximum reliability**

If we add a direct Anthropic API key, we can use CUA mode which delegates to Anthropic's Computer Use:

```typescript
const agent = stagehand.agent({
  mode: "cua",
  model: "anthropic/claude-sonnet-4-6",
});
```

This gives us the pixel-coordinate accuracy of Anthropic Computer Use with the ergonomics of Stagehand's agent framework.

### Secondary: DIY Fallback

If Stagehand proves too heavy or has compatibility issues in our Docker sandbox, the DIY approach (Playwright screenshots + our existing `callLLMVision`) is the fallback. We already have 90% of the code; we just need to:

1. Replace the snapshot-based planning with screenshot-based planning
2. Add coordinate-based click/type actions to `buildAgentBrowserCommand()`
3. Keep our existing LLM caller with OpenRouter

### Not Recommended

- **Playwright MCP**: Adds protocol complexity without adding intelligence. We're better off using Playwright directly.
- **Browser Use**: Python-only, would require significant operational changes.
- **OpenHands/BrowserGym**: Research tools, not production verification.
- **Anthropic Computer Use (direct)**: Good approach but locks us to Anthropic API. Better to use it through Stagehand which abstracts the provider.

---

## Integration Examples

### Example 1: Stagehand Agent Verification (Recommended)

```typescript
import { Stagehand, CustomOpenAIClient } from "@browserbasehq/stagehand";
import OpenAI from "openai";
import { z } from "zod";

const VerifyResult = z.object({
  passed: z.boolean().describe("Whether the deployed change looks correct"),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string().describe("1-2 sentence explanation"),
});

export async function verifyWithStagehand(
  url: string,
  task: string,
  changedFiles: string[],
  apiKey: string,
  model: string,
  credentials?: { email: string; password: string }
): Promise<z.infer<typeof VerifyResult>> {
  const stagehand = new Stagehand({
    env: "LOCAL",
    llmClient: new CustomOpenAIClient({
      modelName: model,
      client: new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
      }),
    }),
    localBrowserLaunchOptions: {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      chromiumSandbox: false,
      args: ["--no-sandbox", "--disable-gpu"],
    },
    disablePino: true,
    experimental: true,
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    const instruction = [
      `TASK: ${task}`,
      `FILES CHANGED: ${changedFiles.join(", ")}`,
      "",
      credentials
        ? `If you see a login page, log in with email "${credentials.email}" and password "${credentials.password}".`
        : "If you see a login page, try admin@admin.com / password.",
      "",
      "Navigate to the relevant page, interact with the feature if needed,",
      "and determine whether the change was correctly implemented.",
      "When done, call the done tool with your verdict.",
    ].join("\n");

    const agent = stagehand.agent({ mode: "hybrid" });
    const result = await agent.execute({
      instruction,
      maxSteps: 15,
      output: VerifyResult,
      variables: credentials ? {
        email: { value: credentials.email, description: "Login email" },
        password: { value: credentials.password, description: "Login password" },
      } : undefined,
    });

    return result.output as z.infer<typeof VerifyResult> ?? {
      passed: result.success,
      confidence: "medium" as const,
      reasoning: result.message,
    };
  } finally {
    await stagehand.close().catch(() => {});
  }
}
```

### Example 2: Anthropic Computer Use via Stagehand CUA Mode

```typescript
const stagehand = new Stagehand({
  env: "LOCAL",
  model: {
    modelName: "claude-sonnet-4-6",
    apiKey: process.env.ANTHROPIC_API_KEY, // Direct Anthropic key required for CUA
  },
  localBrowserLaunchOptions: {
    headless: true,
    executablePath: "/usr/bin/chromium",
    chromiumSandbox: false,
  },
});
await stagehand.init();

const agent = stagehand.agent({ mode: "cua" });
const result = await agent.execute({
  instruction: `Open ${url} and verify: ${task}`,
  maxSteps: 20,
});
```

### Example 3: DIY Screenshot Loop (Fallback)

```typescript
// Minimal modification to existing browser-verify-node.ts
// Replace snapshot-based planning with screenshot-based planning

async function screenshotVerifyLoop(
  page: PlaywrightPage,
  task: string,
  changedFiles: string[],
  llmConfig: LLMCallerConfig,
  model: string,
  maxRounds: number = 10,
): Promise<VisualVerifyResult> {
  const SYSTEM = `You are a QA engineer verifying a deployed web page.
You will see screenshots of the page. Respond with JSON:
{"action": "click", "x": 640, "y": 400, "reason": "click button"}
{"action": "type", "text": "hello", "reason": "fill input"}
{"action": "scroll", "direction": "down", "reason": "see more"}
{"action": "navigate", "url": "/path", "reason": "go to page"}
{"action": "verdict", "passed": true, "confidence": "high", "reasoning": "looks correct"}

When you can determine if the change was implemented correctly, return a verdict action.`;

  for (let round = 0; round < maxRounds; round++) {
    const screenshot = await page.screenshot();
    const base64 = screenshot.toString("base64");

    const response = await callLLMVision(llmConfig, {
      system: SYSTEM,
      userContent: [
        { type: "text", text: `Task: ${task}\nFiles: ${changedFiles.join(", ")}\nRound ${round + 1}/${maxRounds}. What do you see?` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
      ],
      model,
      maxTokens: 256,
      jsonMode: true,
    });

    const action = extractJSON<any>(response.content);
    if (!action) continue;

    if (action.action === "verdict") {
      return {
        passed: action.passed,
        reasoning: action.reasoning,
        confidence: action.confidence ?? "medium",
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      };
    }

    // Execute action
    if (action.action === "click") {
      await page.mouse.click(action.x, action.y);
    } else if (action.action === "type") {
      await page.keyboard.type(action.text);
    } else if (action.action === "scroll") {
      await page.mouse.wheel(0, action.direction === "down" ? 500 : -500);
    } else if (action.action === "navigate") {
      await page.goto(new URL(action.url, page.url()).toString());
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    await new Promise(r => setTimeout(r, 1000)); // Wait for page to settle
  }

  return { passed: false, reasoning: "Max rounds exceeded", confidence: "low", inputTokens: 0, outputTokens: 0 };
}
```

---

## Dockerfile Changes Required

For Stagehand integration, add to `sandbox/Dockerfile`:

```dockerfile
# Stagehand requires chrome-launcher to find Chromium
# It also bundles its own Playwright usage, but respects PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
RUN npm install -g @browserbasehq/stagehand@latest
```

For the DIY approach, no Dockerfile changes needed -- we already have Playwright and Chromium.

---

## Open Questions

1. **Stagehand in Docker**: Does `chrome-launcher` correctly find `/usr/bin/chromium` when `executablePath` is provided? Needs testing.
2. **OpenRouter + CUA**: Can OpenRouter forward `computer_use` tool types? Needs testing. If not, we need a direct Anthropic API key for CUA mode.
3. **Token cost comparison**: Stagehand's agent loop may use more tokens than our current approach (screenshots are expensive). Need to measure.
4. **Stagehand stability**: v3.1.0 is relatively new. The `@browserbasehq/stagehand` package depends on `@anthropic-ai/sdk@0.39.0` which is quite old vs current `0.78.0`. Potential version conflicts.
5. **Video recording**: Stagehand does not have built-in video recording. We'd need to keep our ffmpeg-based approach or use Playwright's video recording API directly.
