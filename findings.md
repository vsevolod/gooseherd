# Findings

## Stagehand Migration (2026-02-28)

### Blast Radius
- Only 4 files reference browser tools: `browser-tools.ts`, `browser-verify-node.ts`, `browser-tools.test.ts`, `summarize-changes.test.ts`
- `summarize-changes.test.ts` only imports `buildToolUseInitialMessage` — will need to update or remove that import
- Pipeline engine/loader only imports `browserVerifyNode` — no changes needed
- `fix-browser.ts` only reads context bag values (verdictReason, domFindings) — no changes needed

### Stagehand Key Facts
- Package: `@browserbasehq/stagehand` (TypeScript library, NOT a CLI)
- Uses Playwright internally for LOCAL mode
- `localBrowserLaunchOptions.executablePath` maps to our `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
- `model` accepts `"provider/model"` string OR `{ modelName, apiKey, baseURL }` object
- Agent `execute()` returns `{ success, message, completed, actions[], usage }`
- Structured output via Zod: `output: z.object({...})` → `result.output`
- Variables: `%email%` syntax — values NOT sent to LLM (secure credential handling)
- Custom logger: `logger: (line) => void` — pipe to our logFile
- `recordVideo` via Playwright launch options — built into LOCAL mode

### OpenRouter Compatibility
- Stagehand uses Vercel AI SDK internally
- Can use `model: { modelName: "anthropic/claude-sonnet-4-6", baseURL: "https://openrouter.ai/api/v1", apiKey: key }` for OpenRouter
- Alternative: use direct Anthropic key (ANTHROPIC_API_KEY) — simpler, one less hop

### Docker Considerations
- Stagehand needs Playwright + Chromium — we already have both in sandbox
- Replace `agent-browser@latest` with `@browserbasehq/stagehand` in Dockerfile
- Keep all PLAYWRIGHT_* and chromium env vars — Stagehand uses them
- Remove AGENT_BROWSER_* env vars

### Errors / Issues
(none yet)

---

## Previous Research

## Research Log

## Collected Primary Sources (selected)

### Benchmarks and research
- WebArena official leaderboard (Google Sheet), accessed 2026-02-27: top entries include BrowserArena 72.9, OpenAI CUA 65.4, cua-saturn 58.1.
- VisualWebArena paper (arXiv 2401.13649): text-only GPT-4 baseline 16.4% success, visual+text 13.7%, visual-only 5.6%.
- BrowserArena paper (arXiv 2507.18075): reports 65.1% on WebArena and 40.1% on VisualWebArena.
- WebVoyager paper (arXiv 2401.13919): GPT-4 achieves 59.1%; with reflection modules up to 85.3%.
- Online-Mind2Web leaderboard (Princeton HAL): weekly scores with explicit normalized task scores and dates.
- Mind2Web repo leaderboard: cross-encoder grounding strongly improves multi-choice element/action accuracy over random/BM25.
- WebCanvas benchmark (OpenReview PDF): best tested model in their eval reaches 35.2% average success.
- Set-of-Mark prompting (OpenReview): ~23 point absolute gain on web navigation benchmark over text-only prompting.
- BrowserGym paper (arXiv 2412.05467): unified action spaces and benchmark ecosystem across web tasks.

### Tool architecture
- Stagehand docs and repo: act/extract/observe design, deterministic action path before LLM fallback, caching and locator recovery.
- Playwright MCP server repo: exposes accessibility snapshot + tool calls (click/fill/select/screenshot/evaluate).
- browser-use repo: combines vision and HTML extraction, outputs structured actions.
- OpenHands docs: browser integration currently via Browser Use provider (manual setup).
- Cursor docs (agent browser/background): browser extension for context; background agents can use Browser Use.
- OpenAI Codex docs/blog: cloud sandbox with terminal/test outputs; internet access controlled; no first-class browser-verification API documented.
- Devin docs/blog: product exposes interactive browser; public docs do not disclose low-level grounding architecture.

### Production AI testing vendors (approach signals)
- Momentic: positions CV/AI element targeting to avoid brittle CSS/XPath.
- Testim smart locators: multi-attribute + ML re-identification when DOM changes.
- mabl auto-heal: warns/fixes when selector updates needed.
- Reflect: semantic locator strategy using visible text and context hierarchy.
- Shortest: natural-language Playwright-first generation.

### Cost and deployment
- Anthropic Claude model pricing available in model-overview docs.
- Anthropic vision docs provide image token estimate formula: tokens ~ (width * height) / 750.
- Anthropic computer-use quickstart supports Docker workflow (Docker Desktop + make/docker setup).

---

## Deep Dive: Screenshot-Based Browser Automation for AI Agents

**Date**: 2026-02-28
**Scope**: Anthropic Computer Use, Stagehand, Browser-Use, Docker/headless setup, cost analysis

### Table of Contents

1. [Anthropic Computer Use -- Implementation Details](#anthropic-computer-use----implementation-details)
2. [Browserbase Stagehand -- Deep Dive](#browserbase-stagehand----deep-dive)
3. [Browser-Use (Python)](#browser-use-python)
4. [Docker/Headless Setup & Technical Details](#dockerheadless-setup--technical-details)
5. [Cost Analysis](#cost-analysis)
6. [Comparison Table](#comparison-table-1)
7. [Recommendation for Gooseherd](#recommendation-for-gooseherd)

---

### Anthropic Computer Use -- Implementation Details

#### Overview

Computer Use is a beta API feature that enables Claude to interact with desktop environments through screenshot capture + mouse/keyboard control. First released October 2024; rapid improvement from 14.9% on OSWorld (Sonnet 3.5) to 72.5% (Sonnet 4.6) in 16 months.

#### Tool Versions & Beta Headers

| Model | Tool Type | Beta Header |
|-------|-----------|-------------|
| Claude Opus 4.6, Sonnet 4.6, Opus 4.5 | `computer_20251124` | `computer-use-2025-11-24` |
| Sonnet 4.5, Haiku 4.5, Opus 4.1, Sonnet 4, Opus 4, Sonnet 3.7 | `computer_20250124` | `computer-use-2025-01-24` |

#### Exact API Format

**Tool definition** (sent in the `tools` array):
```json
{
  "type": "computer_20251124",
  "name": "computer",
  "display_width_px": 1024,
  "display_height_px": 768,
  "display_number": 1,
  "enable_zoom": true
}
```

**Claude requests actions** via `tool_use` content blocks in its response:
```json
{
  "type": "tool_use",
  "id": "toolu_abc123",
  "name": "computer",
  "input": { "action": "screenshot" }
}
```

```json
{
  "type": "tool_use",
  "id": "toolu_abc456",
  "name": "computer",
  "input": { "action": "left_click", "coordinate": [500, 300] }
}
```

**You return results** as `tool_result` in the next user message:
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_abc123",
      "content": [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "<base64-encoded-screenshot>"
          }
        }
      ]
    }
  ]
}
```

#### Available Actions

**All versions:** `screenshot`, `left_click` (at `[x, y]`), `type`, `key` (e.g., "ctrl+s"), `mouse_move`

**Enhanced (computer_20250124):** `scroll` (direction + amount), `left_click_drag`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_mouse_down`, `left_mouse_up`, `hold_key`, `wait`

**Enhanced (computer_20251124):** All of above plus `zoom` -- inspect screen region at full resolution (`region: [x1, y1, x2, y2]`)

#### Agent Loop (TypeScript pseudocode)

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function agentLoop(task: string, maxIterations = 10) {
  const messages = [{ role: "user", content: task }];
  const tools = [
    {
      type: "computer_20251124",
      name: "computer",
      display_width_px: 1024,
      display_height_px: 768,
    },
    { type: "bash_20250124", name: "bash" },
    { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.beta.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools,
      messages,
      betas: ["computer-use-2025-11-24"],
    });

    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await executeToolAction(block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result, // screenshot as base64 image, or text
        });
      }
    }

    if (toolResults.length === 0) break; // task complete
    messages.push({ role: "user", content: toolResults });
  }
}
```

#### Display Resolution Recommendations

- **General desktop**: 1024x768 or 1280x720
- **Web applications**: 1280x800 or 1366x768
- **Avoid** resolutions above 1920x1080

The API constrains images to max 1568px on longest edge and ~1.15 megapixels. Higher-res screenshots get downscaled, causing coordinate mismatch unless you handle scaling yourself. Best practice: resize screenshots to the target resolution BEFORE sending, then scale coordinates back up when executing actions.

#### Docker Setup (Official Reference)

Official image: `ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest`

Based on Ubuntu 22.04 with:
- **Xvfb** (X virtual framebuffer) -- the display server
- **Mutter** (window manager) + **Tint2** (panel)
- **x11vnc** (optional VNC for debugging)
- **Firefox, LibreOffice, gedit** (desktop apps)
- **xdotool, scrot, imagemagick** (screen tools)

```bash
docker run \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e WIDTH=1024 -e HEIGHT=768 \
  -p 5900:5900 -p 8501:8501 -p 6080:6080 -p 8080:8080 \
  -it ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest
```

Key architectural detail: **the agent loop runs INSIDE the container** being controlled. Claude sees screenshots of the virtual desktop rendered by Xvfb. VNC is only for human debugging.

#### Can It Work Headless (No VNC)?

**Yes.** Xvfb is the core mechanism -- renders a virtual framebuffer in memory. Screenshots are captured from this framebuffer (via `scrot` or similar). No physical display or VNC is needed for the Claude API integration.

However, Computer Use is designed for **full desktop environments** -- it needs a window manager, X11 display server, and real GUI applications. It is NOT designed for headless-Chrome-only scenarios.

**Two options for headless Docker:**
1. **Xvfb + full desktop** (Anthropic's approach): Heavy (~2GB image), supports any GUI app
2. **Xvfb + Chrome only** (lighter): Install Xvfb + Chromium, skip window manager. Lighter (~500MB).

---

### Browserbase Stagehand -- Deep Dive

#### Overview

Stagehand is a TypeScript browser automation framework that adds AI-powered primitives on top of Playwright (now moving to raw CDP). Three core methods: `act()`, `extract()`, `observe()`.

#### Architecture: Accessibility Tree, Not Screenshots

Stagehand's key innovation is using the **Chrome Accessibility Tree** instead of raw screenshots or HTML:

- Semantic representation of the page, filtered to interactive and meaningful elements
- **80-90% smaller** than raw DOM
- Remains stable even when visual layouts change
- Directly translates to lower token usage and faster LLM processing

Example of what the LLM receives:
```
Accessibility Tree:
[2-2] RootWebArea: Example Domain
  [2-3] scrollable, html
    [2-16] div
      [2-17] heading: Example Domain
      [2-19] paragraph
      [2-22] link: Learn more
```

This is essentially the same approach gooseherd uses today with `agent-browser snapshot -ic`.

#### Core Primitives

**`act(instruction)`** -- Execute a browser action via natural language:
```typescript
await stagehand.act("click on the comments link for the top story");
```
Internally: gets accessibility tree, sends to LLM with instruction, LLM identifies target element, Stagehand executes Playwright action.

**`extract(instruction, schema)`** -- Extract structured data with Zod validation:
```typescript
const { author, title } = await stagehand.extract(
  "extract the author and title of the PR",
  z.object({
    author: z.string().describe("The username of the PR author"),
    title: z.string().describe("The title of the PR"),
  }),
);
```

**`observe(instruction)`** -- Plan actions without executing them. Returns what the AI intends to do, enabling caching and human review.

**`agent.execute(task)`** -- Higher-level orchestration for multi-step tasks:
```typescript
const agent = stagehand.agent();
await agent.execute("Get to the latest PR");
```

#### Local Mode

Stagehand runs fully locally without Browserbase cloud:
```bash
export STAGEHAND_ENV=LOCAL
export CHROME_PATH=/usr/bin/chromium  # optional
```

Docker setup:
```dockerfile
FROM node:20
RUN apt-get update && apt-get install -y \
  chromium libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium
ENV STAGEHAND_ENV=LOCAL
```

#### LLM Routing

Different models excel at different tasks:
- **Claude**: best for high-level reasoning/dynamic decisions
- **GPT-4o / GPT-4o mini**: best for executing specific browser actions
- **Gemini**: best for `observe()` (structured extraction from accessibility tree)

#### Key Characteristics

- TypeScript-native (good for gooseherd integration)
- Playwright-based (we already use Playwright in sandbox)
- Accessibility tree approach matches current agent-browser snapshot approach
- Mix deterministic Playwright + AI-powered methods
- Self-healing: remembers previous actions, adapts when website changes
- Action caching: `observe()` results can be cached for deterministic re-execution

---

### Browser-Use (Python)

#### Overview

Open-source Python library that wraps Playwright in an LLM-driven control loop. Created by Magnus Muller and Gregor Zunic.

#### Architecture

Three layers:
1. **LLM Integration Layer** -- OpenAI, Anthropic, Google, or local models via Ollama
2. **Browser Control Engine** -- Playwright with WebSocket communication
3. **Visual Understanding System** -- hybrid DOM + vision approach

#### Element Indexing System

DOM parser traverses the page, identifies interactive elements, assigns unique integer indices. Their solution to LLM hallucination of element references:
```
browser-use state    # Shows clickable elements with indices
browser-use click 5  # Click element by index
```

Key innovation: `paint_order_filtering` (default: True) removes elements hidden behind others, reducing context noise.

#### Vision Mode

Controlled by `use_vision` parameter:
- `"auto"` (default): includes screenshot tool, uses vision only when requested
- `True`: always includes screenshots with each step
- `False`: DOM-only mode, no screenshots

Additional: `vision_detail_level`: 'low', 'high', or 'auto'

#### Agent Loop

`Observe -> Decide -> Act -> Evaluate -> Repeat`

- `max_actions_per_step`: 3, `max_failures`: 3
- `llm_timeout`: 90s, `step_timeout`: 120s
- Supports structured output via Pydantic v2 schemas

#### Key Characteristics

- Python-only (would require subprocess or Python sidecar in gooseherd)
- Recommended model `ChatBrowserUse` is a specialized fine-tune
- More agent-oriented (full autonomous task execution) vs. Stagehand's primitive-oriented approach
- DOM-first with optional vision fallback

---

### Docker/Headless Setup & Technical Details

#### Xvfb Explained

Xvfb (X virtual framebuffer) is a display server implementing X11 that performs all graphical operations in **virtual memory without any screen output**. From the client app's perspective, indistinguishable from a real X display.

```bash
Xvfb :99 -screen 0 1024x768x24 &
export DISPLAY=:99
chromium --no-sandbox http://example.com &
scrot screenshot.png  # captures the virtual framebuffer
```

#### Do You Need Xvfb With Modern Headless Chrome?

**No, for basic automation.** Modern Chrome's `--headless` flag runs without any display server. Xvfb is NOT needed for Playwright page.screenshot(), agent-browser screenshots, or CI/CD screenshot automation.

**Yes, if you need:** WebGL rendering, running GUI applications alongside the browser, or Anthropic Computer Use (full desktop control).

#### Minimal Docker for Screenshot Verification

Our current setup is already close to minimal:
```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
RUN npm install -g playwright
```

Adding Anthropic Computer Use would require ~500MB+ more: `xvfb xdotool scrot imagemagick mutter`.

#### Latency Characteristics

| Operation | Typical Latency |
|-----------|----------------|
| Screenshot capture (Playwright) | 100-500ms |
| Send screenshot to Claude API | 200-500ms (network) |
| Claude analyzes screenshot + returns action | 1-5s (model inference) |
| Execute action (click/type) | 50-200ms |
| **Total per step** | **~2-6 seconds** |

- **Current gooseherd approach**: 3-5 LLM calls = 15-30 seconds total
- **Computer Use approach**: 5-15 steps = 30-90+ seconds total

---

### Cost Analysis

#### Image Token Formula (Anthropic)

```
tokens = (width_px * height_px) / 750
```

If image exceeds 1568px longest edge or ~1.15 megapixels, it is resized first.

| Screenshot Resolution | Tokens | Cost (Sonnet 4.6 @ $3/MTok input) |
|-----------------------|--------|------------------------------------|
| 1024x768 (XGA) | ~1,049 | ~$0.00315 |
| 1280x720 (HD) | ~1,229 | ~$0.00369 |
| 1280x800 (WXGA) | ~1,365 | ~$0.00410 |
| 1092x1092 (max 1:1) | ~1,590 | ~$0.00477 |

#### Computer Use System Overhead

- System prompt overhead: **466-499 tokens** per request
- Computer tool definition: **735 tokens** per tool per request
- Total fixed overhead per API call: **~1,200 tokens** ($0.0036/call on Sonnet 4.6)

#### Cost Per Verification: Current Approach vs. Computer Use

**Current gooseherd approach (accessibility tree + DOM queries + 1 screenshot):**

| Phase | Input Tokens | Output Tokens | Cost |
|-------|-------------|---------------|------|
| Plan (a11y tree ~2-4K + system) | ~5,000 | ~500 | ~$0.0225 |
| Action execution (no LLM) | 0 | 0 | $0 |
| Vision verdict (screenshot ~1K + prompt) | ~2,000 | ~100 | ~$0.0075 |
| Additional rounds (0-3) | ~5,000 each | ~500 each | ~$0.0225 each |
| **Total (1-round)** | **~7,000** | **~600** | **~$0.030** |
| **Total (3-round with auth)** | **~17,000** | **~1,600** | **~$0.075** |

**Anthropic Computer Use (every action needs screenshot):**

| Phase | Input Tokens | Output Tokens | Cost |
|-------|-------------|---------------|------|
| Per step (average, incl. growing history) | **~3,500** | **~200** | **~$0.014** |
| **5-step task** | **~25,000** | **~1,000** | **~$0.090** |
| **10-step task** | **~55,000** | **~2,000** | **~$0.195** |
| **15-step task (with auth)** | **~90,000** | **~3,000** | **~$0.315** |

Note: Conversation history grows with each step because ALL previous screenshots remain in context. Prompt caching (90% savings on cached input) helps if the conversation prefix is stable.

#### Cost Comparison Summary

| Approach | Tokens/Verification | Cost/Verification | Relative Cost |
|----------|--------------------|--------------------|---------------|
| Current (text snapshot + 1 screenshot) | ~7-17K | $0.03-0.08 | **1x (baseline)** |
| Computer Use (5 steps) | ~25K | ~$0.09 | **~2-3x** |
| Computer Use (10 steps) | ~55K | ~$0.20 | **~5-6x** |
| Computer Use (15 steps + auth) | ~90K | ~$0.32 | **~8-10x** |
| Stagehand (DOM-first, similar) | ~8-20K | $0.03-0.08 | **~1x** |

---

### Comparison Table

| Feature | Anthropic Computer Use | Stagehand | Browser-Use | Current Gooseherd |
|---------|----------------------|-----------|-------------|-------------------|
| **Language** | Python (ref impl) | TypeScript | Python | TypeScript |
| **Page Understanding** | Screenshots only | Accessibility tree | DOM + optional vision | A11y tree + DOM queries |
| **Action Targeting** | Pixel coordinates | A11y tree refs | DOM element indices | @refs + CSS selectors |
| **Docker Requirements** | Xvfb + desktop (~2GB) | Chromium only (~500MB) | Chromium only (~500MB) | Chromium only (current) |
| **Tokens Per Step** | ~3,500 (screenshot) | ~500-2,000 (text) | ~1,000-3,000 (hybrid) | ~2,000-5,000 (text) |
| **Latency Per Step** | 2-6s | <1s (DOM) / 2-3s (LLM) | 1-3s | 2-5s |
| **Auth Handling** | Visual (sees form) | AI-guided via act() | Agent auto-handles | LLM-planned multi-round |
| **Accuracy** | High (but slow) | High (semantic) | 89.1% (WebVoyager) | Good (DOM+vision) |
| **Local/Self-Hosted** | Yes (Docker) | Yes (LOCAL env) | Yes (Playwright) | Yes (Docker sandbox) |
| **Cost/Verification** | $0.09-0.32 | $0.03-0.08 | $0.03-0.10 | $0.03-0.08 |
| **Maturity** | Beta | Production | Production | Custom |
| **Non-Browser** | Yes (full desktop) | No | No | No |

#### Pros and Cons

**Anthropic Computer Use:**
- PRO: Can interact with ANY desktop application, not just browsers
- PRO: Handles visual-only UIs (canvas, WebGL, complex CSS)
- PRO: No need for DOM parsing -- works on anything with pixels
- PRO: Official Anthropic product with rapid improvements
- CON: 2-10x more expensive per verification
- CON: 2-5x slower than DOM-based approaches
- CON: Requires Xvfb + heavier Docker image
- CON: Pixel coordinate targeting less reliable than DOM selectors
- CON: Still in beta -- API may change
- CON: Conversation history grows with screenshots (cost explosion)

**Stagehand:**
- PRO: TypeScript-native (direct integration, no subprocess)
- PRO: Same accessibility tree approach gooseherd already uses
- PRO: Low token usage (80-90% reduction vs raw DOM)
- PRO: Works locally with just Chromium
- PRO: Self-healing + action caching
- PRO: Mix deterministic Playwright + AI-powered methods
- CON: Tied to Browserbase ecosystem (though local mode works)
- CON: Newer framework -- API still evolving (moved from Playwright to CDP)
- CON: No vision/screenshot fallback for visual-only elements

**Browser-Use:**
- PRO: Most complete agent framework (full autonomous task execution)
- PRO: Best hybrid (DOM + vision) approach
- PRO: Strong error recovery
- PRO: Highest benchmark accuracy (89.1% WebVoyager)
- CON: Python-only -- subprocess or sidecar needed
- CON: Heavier dependency (full Python environment)
- CON: Best model (`ChatBrowserUse`) is a proprietary fine-tune
- CON: Agent-oriented (overkill for targeted verification)

---

### Recommendation for Gooseherd

#### What Gooseherd Needs

Gooseherd's browser verification does a **targeted, bounded task**: open a preview URL, navigate to a specific feature area, take evidence (screenshot + DOM assertions), and render a pass/fail verdict. This is fundamentally different from open-ended web automation.

#### Assessment

The current approach -- `agent-browser snapshot -ic` (accessibility tree) + LLM-planned actions + DOM assertions + single screenshot verdict -- is **already architecturally aligned with best practices** of all three frameworks studied:

1. **Accessibility tree for page understanding**: Same approach as Stagehand (their key innovation). 80-90% fewer tokens than raw DOM.
2. **DOM assertions for precise verification**: `get_count`, `get_text`, `is_visible` are more reliable than vision for small elements.
3. **Single screenshot for visual verdict**: One screenshot at the end, not per-step (saves 5-10x on tokens vs Computer Use).
4. **Multi-round observe-act loop**: Same pattern as Browser-Use's agent loop (5 rounds max, re-snapshot after navigate).

#### What Would Each Alternative Buy Us?

**Anthropic Computer Use:** Marginal benefit for gooseherd. We are not verifying desktop apps or WebGL content. Would add 2-10x cost and 2-5x latency for the same web verification task. Would require significant Docker image changes (Xvfb, window manager, ~1.5GB more). Only worthwhile for native desktop app verification.

**Stagehand:** Most natural fit as a **library replacement** for agent-browser. TypeScript-native means direct import, no subprocess overhead. `act()`/`extract()`/`observe()` could simplify `browser-verify-node.ts`. Action caching via `observe()` could speed up repeated verifications. **But**: gooseherd already has the same core capability via agent-browser -- benefit would be cleaner code, not fundamentally different capability.

**Browser-Use:** Overkill for targeted verification. Python dependency is significant integration cost. Not recommended unless gooseherd needs full autonomous web task execution.

#### Recommended Path Forward

**Short-term (keep current approach):** The current agent-browser + LLM plan/verdict system is sound. Same architectural patterns as best frameworks. No framework switch needed.

**Medium-term (consider Stagehand):** If agent-browser becomes a maintenance burden or we need better self-healing/caching:
```typescript
// Current: subprocess calls to agent-browser CLI
const snapshotResult = await runShellCapture(ab("snapshot -ic"), ...);
const clickResult = await runShellCapture(ab("click @e5"), ...);

// With Stagehand: direct TypeScript API
const stagehand = new Stagehand({ env: "LOCAL" });
await stagehand.init();
const page = stagehand.context.pages()[0];
await page.goto(reviewAppUrl);
await stagehand.act("click the sign-in button");
const data = await stagehand.extract("extract the page title", z.object({ title: z.string() }));
```

Benefits: eliminate CLI subprocess overhead, Zod-validated extraction, action caching, same accessibility-tree approach under the hood.

**Long-term (Computer Use as optional mode):** Add as a separate `computer_use_verify` node for repos needing visual-only verification (design-heavy apps, canvas rendering). Not a replacement for current `browser_verify`.

#### Key Takeaways

1. **DOM-first is the right approach for web verification.** Vision/screenshots are supplementary, not primary. Industry consensus: Browser-Use, Stagehand, and OpenAI's ChatGPT Agent all use DOM-first.

2. **The current gooseherd approach is not behind the curve.** It independently arrived at the same architecture as Stagehand and Browser-Use.

3. **Computer Use is for desktop automation, not web verification.** Using it for web verification is 5-10x more expensive and slower than necessary.

4. **Stagehand is the most viable integration target** for replacing agent-browser CLI with a TypeScript library, but it is a lateral move in capability, not a step change.

---

### Sources

- [Anthropic Computer Use Tool Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Anthropic Vision / Image Token Pricing](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Anthropic Quickstarts -- Computer Use Demo](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo)
- [Anthropic API Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Stagehand GitHub](https://github.com/browserbase/stagehand)
- [Stagehand Docs](https://docs.stagehand.dev)
- [Stagehand Architecture Breakdown](https://memo.d.foundation/breakdown/stagehand)
- [Why Stagehand Is Moving Beyond Playwright](https://www.browserbase.com/blog/stagehand-playwright-evolution-browser-automation)
- [Stagehand MCP Local Mode](https://github.com/weijiafu14/stagehand-mcp-local)
- [Browser-Use GitHub](https://github.com/browser-use/browser-use)
- [Browser-Use AGENTS.md](https://github.com/browser-use/browser-use/blob/main/AGENTS.md)
- [Browser Use vs Computer Use vs Operator](https://www.helicone.ai/blog/browser-use-vs-computer-use-vs-operator)
- [Stagehand vs Browser-Use vs Playwright 2026](https://www.nxcode.io/resources/news/stagehand-vs-browser-use-vs-playwright-ai-browser-automation-2026)
- [Speed Matters: Browser Use Execution](https://browser-use.com/posts/speed-matters)
- [Anthropic Computer Use vs OpenAI CUA](https://workos.com/blog/anthropics-computer-use-versus-openais-computer-using-agent-cua)


## Benchmarks (Primary Sources)

- WebArena (ICLR 2024): GPT-4 with prompting on benchmark tasks reported 14.41% success; human baseline reported 78.24%.
  - Source: https://arxiv.org/abs/2307.13854
- VisualWebArena (2024): best existing web agents drop in visual setting; abstract reports best model 16.4% in VWA vs 6.1% text counterpart on same benchmark variant; human baseline 78.24%.
  - Source: https://arxiv.org/abs/2401.13649
- WebVoyager (2024): GPT-4V + iterative prompting reports 59.1% success rate on real-world websites.
  - Source: https://aclanthology.org/2024.acl-long.371/
- SoM / Set-of-Mark prompting (2024): paper reports +23% absolute over GPT-4V baseline and SOTA on Mind2Web + AITW at publication time.
  - Source: https://arxiv.org/abs/2401.01614
- Mind2Web (NeurIPS 2023): benchmark + method decomposition for operation prediction + element grounding; foundational result for text-trajectory supervision.
  - Source: https://arxiv.org/abs/2306.06070
- AgentBench (2023): broad multi-environment benchmark; web browsing one of many environments and generally low absolute success for frontier models at the time.
  - Source: https://arxiv.org/abs/2308.03688

## Computer-use API Scores

- OpenAI computer-use-preview benchmark figures in docs: OSWorld 38.1, WebArena 58.1, WebVoyager 87.
  - Source: https://platform.openai.com/docs/guides/tools-computer-use
- Anthropic Claude Opus 4.6 System Card reports (use-tool benchmark table):
  - WebArena: Sonnet 4.6 = 57.6%; Sonnet 4.5 = 27.6%
  - OSWorld: Sonnet 4.6 = 24.2%; Sonnet 4.5 = 22.0%
  - OSWorld-verified: Sonnet 4.6 = 31.8%; Sonnet 4.5 = 27.6%
  - Source: https://www-cdn.anthropic.com/c788cbc0a3da9135112f97cdf6dcd06f2c16cee2.pdf
- Google Project Mariner: Google reports 83.5% on WebVoyager benchmark and 40-task internal “Mariner benchmark” in early access.
  - Source: https://blog.google/technology/google-labs/project-mariner/

## Tool Architecture Findings

- Stagehand (Browserbase): wraps Playwright and adds model-mediated primitives (`act`, `extract`, `observe`) with natural-language execution and accessibility-first extraction; explicit recommendation to use deterministic Playwright methods for known interactions and reserve NL actions for unknowns.
  - Source: https://docs.stagehand.dev/best-practices/building-with-natural-language
- Playwright MCP Server (Microsoft): exposes browser operations through structured MCP tools (navigate, click, fill, tabs, snapshot, network, console, screenshot, evaluate) for LLM agents.
  - Source: https://github.com/microsoft/playwright-mcp
- browser-use framework: promotes “vision + HTML extraction,” persistent browser context, DOM history processing, planner + multi-step action loop; has cloud/browser APIs and open-source self-hosted mode.
  - Source: https://github.com/browser-use/browser-use
- OpenHands browser use: docs show Playwright integration and remote browser providers, indicating browser actions are done through Playwright-backed provider layer.
  - Source: https://docs.openhands.dev/sdk/guides/agent-browser-use
- SWE-agent: core docs are software-engineering focused (repo/shell/edit/test); web browsing is possible via dedicated tool bundles but not default architecture for UI verification.
  - Source: https://swe-agent.com/latest/usage/tools/
- Cline / Cursor:
  - Cline docs and ecosystem depend heavily on MCP tool integrations for browser control.
    - Source: https://docs.cline.bot/mcp-servers/mcp-server-recommendations
  - Cursor added browser control mode and background agent browser support in product updates.
    - Source: https://cursor.com/changelog
- Aider: first-class loop is code edit + run tests/lint/commands in terminal; no native browser-verification architecture.
  - Source: https://aider.chat/docs/usage/watch.html

## AI Testing Vendor Patterns

- Momentic: explicit “auto-heal” with human-in-the-loop approval, adaptive text matching, parent/neighbor fallback, and confidence gating for selector recovery.
  - Source: https://momentic.ai/docs/auto-heal
- mabl: “Adaptive auto-healing” and “Find alternatives” mechanisms to recover from changed UI attributes.
  - Source: https://help.mabl.com/hc/en-us/articles/19078583792404-How-auto-heal-works
- Testim: uses Smart Locators and stability mechanisms in recorded/managed tests.
  - Source: https://help.testim.io/docs/testim-automate
- QA Wolf / Reflect / Checkly: emphasize Playwright-based execution, reliability engineering, and workflows (test ownership or synthetic checks). Public materials are stronger on process/workflow than transparent benchmark-style accuracy reporting.
  - Sources:
    - https://qawolf.com/
    - https://reflect.run/
    - https://www.checklyhq.com/docs/

## Meta Finding

- Public, reproducible “accuracy” metrics are abundant in academic benchmarks and sparse in commercial QA tool marketing pages. For most production tools, architecture and reliability patterns are documented, but objective pass/fail accuracy on standardized benchmark suites is rarely published.
