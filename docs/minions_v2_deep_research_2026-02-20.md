# Stripe Minions Deep Research: Architecture, Gaps, and Implementation Roadmap

Date: 2026-02-20
Scope: Comprehensive analysis of Stripe's Minions system (Parts 1 & 2), comparison to Gooseherd, gap analysis, and concrete implementation plan.
Methodology: Council of 5 agents — 2 web researchers (Stripe Part 1 + Part 2), 2 codex-investigators (codebase gaps + implementation), 1 prompt engineering researcher.

---

## 1. Executive Summary

Stripe's Minions system produces **1,300+ merged PRs per week** using a fork of Block Goose (same foundation as Gooseherd). Their key architectural innovation is the **Blueprint** — a state machine that interleaves deterministic nodes (git, lint, push) with agentic nodes (implement task, fix CI). This replaces the pure "agent loop" with a controlled pipeline.

Gooseherd already implements the core pattern (clone → agent → validate → push → PR) but lacks:
1. **CI feedback loops** — no awareness of whether CI passes after PR creation
2. **Structured prompt engineering** — one generic prompt template for all task types
3. **Multi-MCP extension support** — only one MCP server slot (CEMS)
4. **Pre-push quality gates** — no diff size limits, scope validation, or LLM-as-judge
5. **Filtered error re-prompting** — raw stderr dumped to agent on validation failure

Total estimated effort to close these gaps: **~14 hours of engineering work**, all additive (gated by config flags).

---

## 2. Stripe Minions: Complete Architecture (Parts 1 + 2)

### 2.1 The Blueprint Pattern

Stripe's core architectural primitive. NOT a pure agent loop, NOT a pure workflow — a hybrid state machine:

```
┌──────────────────────────────────────────────────────────────┐
│                    BLUEPRINT STATE MACHINE                    │
│                                                              │
│  ┌────────────┐   ┌─────────────┐   ┌────────────────────┐  │
│  │ Spin up    │──▸│ Pre-hydrate │──▸│  ☁ IMPLEMENT TASK  │  │
│  │ devbox     │   │ context     │   │  (agentic node)    │  │
│  │ (10s warm) │   │ (MCP tools) │   │                    │  │
│  └────────────┘   └─────────────┘   └────────┬───────────┘  │
│                                               │              │
│  ┌────────────────────────────────────────────▼───────────┐  │
│  │ Lint daemon (sub-second, cached heuristics)           │  │
│  │ Pre-push hooks auto-fix common issues                 │  │
│  │ Local lint on push (<5 seconds)                       │  │
│  └────────────────────────────────────────────┬──────────┘  │
│                                               │              │
│  ┌────────────────────────────────────────────▼───────────┐  │
│  │ Git push → CI (selective from 3M+ tests)              │  │
│  │ Autofixes applied where available                     │  │
│  └────────────────────────────────────────────┬──────────┘  │
│                                               │              │
│                                        CI pass? ─── yes ───▸ PR │
│                                               │              │
│                                              no              │
│                                               │              │
│  ┌────────────────────────────────────────────▼───────────┐  │
│  │  ☁ FIX CI FAILURES (agentic node)                     │  │
│  │  → push → CI round 2                                  │  │
│  └────────────────────────────────────────────┬──────────┘  │
│                                               │              │
│                                 CI pass? ─ yes ──▸ PR        │
│                                        no ──▸ Return to human│
│                                                              │
│  ☁ = agentic node (LLM)   ▭ = deterministic node (code)    │
└──────────────────────────────────────────────────────────────┘
```

Key properties:
- **Deterministic nodes** (rectangles): no LLM invocation, predictable, fast, token-free
- **Agentic nodes** (clouds): LLM loop with constrained tools, scoped system prompt, isolated context
- Per-node context engineering: each agentic sub-node gets different tools and system prompts
- Teams can build **custom blueprints** for specialized workflows (e.g., LLM-assisted migrations)

### 2.2 Agent Harness (Goose Fork)

- Forked Block's Goose in **late 2024**
- Stripped: interruptibility, confirmation prompts, human-triggered commands
- Added: blueprint orchestration, Stripe LLM infrastructure integration, unattended optimizations
- Same Goose agent we use — their modifications are primarily about removing human-supervision features (safe because devbox isolation = limited blast radius)

### 2.3 Devbox Infrastructure

| Property | Detail |
|----------|--------|
| Platform | AWS EC2 instances |
| Startup | ~10 seconds from warm pool |
| Pre-warmed | Cloned repos, Bazel caches, type-checking caches, code generation services |
| Philosophy | "Cattle, not pets" — standardized, replaceable |
| Isolation | QA environment — no production data, no production services, no network egress |
| Permission model | Full permissions within devbox (safe due to isolation) |
| Parallel use | Engineers run ~6 devboxes simultaneously |

### 2.4 MCP Toolshed (~500 Tools)

- Centralized internal MCP server serving ALL agent types at Stripe (not just Minions)
- ~500 tools spanning internal systems and SaaS platforms
- Adding one tool instantly grants capabilities to "hundreds of different agents"
- Minions receive a **curated subset** by default — "agents perform best with a tastefully curated set of tools"
- Engineers can add "thematically grouped" additional tool sets per minion run
- Internal security control framework prevents destructive tool actions

Named tools: Sourcegraph (code search), internal docs platform, ticket details, build status, feature flags.

**Pre-hydration pattern**: Before the agent starts, MCP tools are run deterministically on "likely-looking links" in the task (Jira tickets, Slack threads, docs) to populate context.

### 2.5 Context Engineering (Prompts + Rules)

This is where Stripe diverges most from what we do today:

| Aspect | Stripe Approach | Gooseherd Today |
|--------|----------------|-----------------|
| Rule files | Cursor format, **subdirectory-scoped** (conditional on file paths) | Single `.goosehints` file, identical for all repos |
| Global rules | Used "very judiciously" — bloats context in large repos | All instructions are global |
| Rule sharing | Same rules serve Minions, Cursor, AND Claude Code | Only serves Goose |
| Task prompts | Per-blueprint-node system prompts, constrained tools | One generic prompt template |
| Context pre-loading | MCP tools pre-run on task links (tickets, docs) | CEMS memory search only |
| Rule format | Standardized on Cursor rules, synced to Claude Code format | Custom `.goosehints` format |

**Critical insight**: Stripe does NOT publish their prompt templates. Zero examples of actual system prompts, user prompts, or prompt engineering strategies are disclosed in either Part 1 or Part 2.

### 2.6 CI Feedback Loop

```
Agent completes coding
    │
    ▼
[DETERMINISTIC] Lint daemon precomputes applicable rules (cached, sub-second)
    │
    ▼
[DETERMINISTIC] Pre-push hooks auto-fix common lint issues
    │
    ▼
[DETERMINISTIC] Local lint on git push (<5 seconds)
    │
    ▼
[DETERMINISTIC] Git push → CI selectively runs from 3M+ test suite
    │
    ▼
CI autofixes applied where available
    │
    ▼
Failures without autofixes → ☁ agent fix attempt → push → CI round 2
    │
    ▼
HARD CAP: 2 CI rounds maximum (diminishing returns beyond that)
```

Rationale: "diminishing marginal returns if an LLM is running against indefinitely many rounds of a full CI loop." Costs: tokens + compute + time.

### 2.7 What Stripe Does NOT Disclose

- No specific LLM model names
- No prompt templates or system prompts
- No code examples, YAML, or blueprint configuration syntax
- No success rate or quality metrics beyond PR count
- No Playwright or browser-based testing mentioned
- No visual verification
- No error recovery logic details beyond 2-round CI retry
- No monitoring/observability details
- No multi-agent coordination (each minion = single agent, one blueprint per task)

---

## 3. Gooseherd Gap Analysis

### 3.1 Current Architecture

```
Slack @mention
    │
    ▼
Command Parser → RunManager.enqueueRun()
    │
    ▼
RunExecutor.execute():
    ├── [1] Clone repo
    ├── [2] Write .goosehints + task.md prompt
    ├── [3] Run Goose agent (AGENT_COMMAND_TEMPLATE)
    ├── [4] LINT_FIX_COMMAND (optional, round 0)
    ├── [5] VALIDATION_COMMAND loop (max MAX_VALIDATION_ROUNDS)
    │       └── On failure: re-run agent with raw error output
    ├── [6] git add -A && git commit
    ├── [7] git push origin <branch>
    └── [8] GitHub PR create
```

### 3.2 Gap-by-Gap Comparison

#### Gap 1: CI Integration (CRITICAL)

| Aspect | Stripe | Gooseherd |
|--------|--------|-----------|
| CI awareness | Full: polls check suites, parses failures | **Zero**: fire-and-forget after PR |
| CI retry | 2 rounds with agent fix attempts | None |
| CI autofixes | Automated where available | None |
| Feedback loop | Failed checks → agent → push → CI again | N/A |
| CI check creation | Likely creates check runs for status | No check-run API usage |

**Impact**: Without CI feedback, we produce PRs that may not compile or pass tests in the CI environment. This is the single biggest gap.

#### Gap 2: Prompt Engineering (HIGH)

| Aspect | Stripe | Gooseherd |
|--------|--------|-----------|
| Task classification | Per-blueprint-node prompts | One generic template for all tasks |
| Rule files | Cursor format, subdirectory-scoped | Single global `.goosehints` |
| Context pre-loading | MCP pre-hydration of task links | CEMS memory search only |
| System prompt control | Per-node modification | No system prompt control |
| Few-shot examples | Not disclosed but likely | None |
| Constraint specification | Per-node tool constraints | Generic "keep changes minimal" |

**Current prompt** (`buildPromptSections` in `executor.ts:498-548`):
```
Run ID: <uuid>
Repository: owner/repo
Base branch: main

Task:
<raw user text>

Expected output:
- Implement the requested changes.
- Keep changes minimal and deterministic.
- Preserve existing style and architecture.
- If tests are configured, satisfy them before finishing.
```

This is too generic. A bug fix, a feature, and a refactor all get the same 4-bullet instruction.

#### Gap 3: Tool Ecosystem (MEDIUM-HIGH)

| Aspect | Stripe | Gooseherd |
|--------|--------|-----------|
| MCP extension slots | Curated subsets per task | **1 slot** (CEMS only) |
| Total tools | ~500 via Toolshed | 1 (CEMS memory) |
| Dynamic selection | Per-task tool groups | Static per deployment |
| Browser tools | Not mentioned | Not available |
| Code search | Sourcegraph via MCP | None |

**Current implementation** (`executor.ts:491-496`):
```typescript
private appendMcpExtension(cmd: string): string {
  if (this.config.cemsMcpCommand) {
    return `${cmd} --with-extension ${shellEscape(this.config.cemsMcpCommand)}`;
  }
  return cmd;
}
```

Exactly 1 extension. Adding Sentry, browser tools, or a database MCP requires code changes.

#### Gap 4: Quality Gates (MEDIUM)

| Aspect | Stripe | Gooseherd |
|--------|--------|-----------|
| Diff size limits | Not disclosed | **None** |
| Scope validation | Blueprint-level constraints | **None** |
| LLM-as-judge | Not disclosed (Spotify does this) | **None** |
| Security scanning | Internal security framework | **None** |
| Code review | 100% human-reviewed | PRs created, no pre-review |

**Current gates** before push:
1. `git diff --quiet HEAD` — ensures non-empty diff (that's it)
2. `VALIDATION_COMMAND` — optional, if configured

An agent could rewrite 100 files for a one-line fix and the system would happily push it.

#### Gap 5: Error Re-Prompting (MEDIUM)

| Aspect | Stripe | Gooseherd |
|--------|--------|-----------|
| Error handling | Per-node context engineering | Raw stderr dump |
| Error parsing | Not disclosed | **None** |
| Fix guidance | Blueprint-level fix prompts | "Fix the following errors" |
| Attempt context | Not disclosed | No history of previous attempts |

**Current fix prompt** (`executor.ts:368-376`):
```
Validation failed (retry 1/2).
Fix the following errors. Only change what is necessary — do not refactor unrelated code.
```<raw last 2000 chars of stderr>```
```

No parsing. No categorization. No deduplication. No strategy guidance.

---

## 4. State of the Art: What Others Do

### 4.1 Spotify's Honk Agent (Two-Layer Verification)

| Layer | Type | Purpose |
|-------|------|---------|
| **Inner loop** | Deterministic verifiers | Build/test/format correctness |
| **Outer loop** | LLM-as-judge | Scope/intent compliance — vetoes ~25% of sessions |

Verifiers activate based on repo contents (e.g., `pom.xml` triggers Maven verifier). Output is regex-filtered to preserve context window. The agent doesn't know what verification does — it just calls an abstracted MCP tool.

### 4.2 Aider's Prompt Engineering Findings

- **Line numbers are poison** — GPT performs poorly with line-number-based formats
- **High-level diffs beat surgical edits** — whole-function replacement over line-by-line edits
- **Unified diff format defeats lazy coding** — 61% vs 20% benchmark score
- **JSON/function-call formats fail** for code editing — escaping corrupts code
- **"Emotional prompting" backfires** — "$2000 tip" prompts actively hurt performance

### 4.3 Claude Code Architecture

Multi-part, conditionally assembled system prompt with:
- 5 agent types (general-purpose, explore, plan, guide, statusline)
- 18 built-in tools with carefully crafted descriptions
- ~40 system reminders injected dynamically based on state
- **Agent Creation Architect** — generates new agent specs as JSON

### 4.4 Cursor Agent Patterns

Key patterns directly applicable to Gooseherd:
- **Read-before-edit rule**: must read file contents before editing
- **Lint retry cap**: "Do not loop more than 3 times on the same file's errors"
- **Reapply pattern**: if edit wasn't applied correctly, try once with a smarter model
- **Custom rules**: auto-attach when matching files open (same as Stripe's subdirectory scoping)

### 4.5 Anthropic's Context Engineering Principles

1. **System prompts at the "right altitude"** — between brittle hardcoding and vague generalities
2. **Tool descriptions are first-class prompt engineering** — small refinements yield dramatic improvements
3. **Tools should be self-contained, non-overlapping, purpose-specific**
4. **Compaction strategies**: tool result clearing (lightest), summarization, multi-agent isolation
5. **Just-in-time context** — load data dynamically via tools rather than pre-loading
6. **Multi-agent isolation** — subagents return condensed summaries (~1-2K tokens) to orchestrator

### 4.6 Browser/Visual Verification

Practical reality check from the research:
- Cost: A single thread with 91 Playwright MCP invocations cost **$103**
- Context tax: 5-10 MCP servers eat 15-20% of context window before any commands
- Accessibility tree is more reliable than screenshot analysis
- **Recommendation**: Browser verification as optional sub-agent, NOT in every run's tool set

---

## 5. What We Should Build (Prioritized Implementation Plan)

### Priority 1: Filtered Error Re-Prompting (2.5 hours)

**What**: Parse validation errors into structured categories (lint, type, test, build) with file/line/rule extraction. Inject structured error context instead of raw stderr.

**Why first**: Highest impact-per-hour. Every validation retry today dumps 2000 chars of raw output. Structured errors let the agent fix faster, reducing retry rounds.

**Files to create**: `src/error-parser.ts` — parsers for ESLint, RuboCop, TypeScript, Jest/RSpec, and generic `file:line: error` patterns. Deduplicates, groups by category, caps at 15 errors per group.

**Files to modify**: `src/executor.ts` — replace the raw error dump (lines 364-377) with parsed + formatted output. Add strategy guidance:
```
Found 7 specific errors. Fix them in priority order:

### LINT errors (4)
- src/foo.ts:10: Unexpected var, use let or const [no-var]
- src/foo.ts:25: Missing return type [explicit-function-return-type]
...

### TEST errors (3)
- Test failed in src/foo.test.ts:42
...

## Strategy
1. Fix errors file-by-file, starting with the most impactful.
2. If a file has multiple lint errors, fix them all in one pass.
```

### Priority 2: Multi-MCP Extension Support (1.5 hours)

**What**: Replace single `CEMS_MCP_COMMAND` slot with array-based `MCP_EXTENSIONS` config. Each entry becomes a `--with-extension` flag.

**Why**: Unblocks browser tools, Sentry MCP, GitHub MCP, and any future tool servers. Backward compatible (CEMS_MCP_COMMAND auto-included).

**Files to modify**:
- `src/config.ts`: Add `MCP_EXTENSIONS` env var (semicolon-delimited), add `mcpExtensions: string[]` to AppConfig, add `parseMcpExtensions()` function
- `src/executor.ts`: Rename `appendMcpExtension` → `appendMcpExtensions`, iterate over array

**Config example**:
```bash
MCP_EXTENSIONS=npx @sentry/mcp-server --token=$SENTRY_TOKEN;npx @anthropic/mcp-browser
```

### Priority 3: Task-Type-Specific Prompt Templates (2 hours)

**What**: Classify tasks by keyword patterns (bugfix, feature, refactor, chore) and route to specific prompt templates with tailored instructions and constraints.

**Why**: A bug fix and a feature request need fundamentally different agent guidance. "Write a test that reproduces the bug FIRST" vs "Follow existing patterns" vs "ZERO behavior changes — refactoring only."

**Files to create**: `src/task-classifier.ts` — keyword-based classifier + template definitions:

| Task Type | Key Instructions |
|-----------|-----------------|
| **bugfix** | Identify root cause first. Write reproducing test. Minimal fix. No refactoring. |
| **feature** | Follow existing patterns. Add tests. Update docs. |
| **refactor** | Zero behavior changes. All existing tests must pass. |
| **chore** | Strictly scoped. No features, no refactoring. |
| **unknown** | Current generic instructions (fallback). |

**Files to modify**: `src/executor.ts` — use `classifyTask(run.task)` in `buildPromptSections()` to select template.

### Priority 4: Diff Size Quality Gates (1 hour)

**What**: Before committing, check total diff lines and changed file count against configurable limits. Reject if agent over-scoped.

**Why**: Prevents catastrophic agent behavior (reformatting entire codebase, touching 50 files for a one-line fix). Zero external dependencies.

**Files to modify**:
- `src/config.ts`: Add `MAX_DIFF_LINES` and `MAX_CHANGED_FILES` (default 0 = disabled)
- `src/executor.ts`: Insert after empty-diff check, before `git add -A`:
  ```
  git diff --numstat HEAD → count total added+removed lines
  git diff --name-only HEAD → count files
  Throw if exceeds limits
  ```

### Priority 5: CI Feedback Loop (4 hours)

**What**: After PR creation, poll GitHub check suites. If checks fail, fetch failure details, re-run agent with CI error context, push fix, poll again. Max 2 rounds (matching Stripe's policy).

**Why**: The single biggest gap. Without CI feedback, we produce PRs blind to whether they pass the target repo's CI pipeline.

**Files to modify**:
- `src/github.ts`: Add `pollCheckSuiteStatus()` method using `octokit.checks.listForRef()`
- `src/config.ts`: Add `CI_FEEDBACK_ENABLED`, `CI_POLL_INTERVAL_SECONDS` (30), `CI_MAX_WAIT_SECONDS` (600), `MAX_CI_FIX_ROUNDS` (2)
- `src/executor.ts`: Insert CI loop after push/PR section — poll → if failure → write CI fix prompt → re-run agent → push → poll again
- `src/types.ts`: Add `"ci-polling"` to RunStatus/RunPhase

**CI fix prompt structure**:
```
CI checks failed after push. Fix ONLY the CI failures.

## Failed Checks
- **test-suite**: failure
  Build output: ...
  https://github.com/.../actions/runs/123

## Instructions
1. Read the failing check output carefully
2. Make minimal fixes to pass CI
3. Do NOT change code unrelated to the failures
```

**Requires**: `checks:read` permission on GitHub token.

### Priority 6: LLM-as-Judge Scope Validation (3 hours)

**What**: Before pushing, pass the diff + original task to a separate lightweight LLM evaluation. Returns PASS/FAIL with reason.

**Why**: Spotify's Honk Agent found LLM-as-judge catches ~25% of off-scope changes (agents refactoring unrelated code, disabling flaky tests, etc.).

**Files to modify**:
- `src/config.ts`: Add `SCOPE_JUDGE_ENABLED` and `SCOPE_JUDGE_COMMAND_TEMPLATE`
- `src/executor.ts`: Insert after diff-size gate — write judge prompt with task + truncated diff, invoke lightweight agent, parse PASS/FAIL verdict

**Judge prompt**:
```
You are a scope validator. Does this diff match the task?

## Task
<original task>

## Diff
<truncated to 8000 chars>

Reply with EXACTLY one line:
- PASS: if changes are well-scoped
- FAIL: <reason> if changes go beyond scope
```

---

## 6. Architectural Comparison: Stripe vs Gooseherd vs Target

| Dimension | Stripe Minions | Gooseherd Today | Gooseherd Target |
|-----------|---------------|-----------------|------------------|
| **Orchestration** | Blueprint state machine | Linear pipeline | Blueprint-inspired pipeline with optional gates |
| **Agent runtime** | Goose fork (stripped interactive features) | Goose (configurable via template) | Same, with multi-MCP support |
| **Environment** | AWS EC2 devboxes, warm pool, QA isolation | Docker container or local | Same (adequate for our scale) |
| **Prompt engineering** | Subdirectory-scoped Cursor rules, per-node system prompts | Single `.goosehints` + generic task prompt | Task-type templates + structured constraints |
| **Context pre-loading** | MCP pre-hydration of task links | CEMS memory search | CEMS + optional pre-fetch MCP tools |
| **Tool ecosystem** | Toolshed (~500 tools), curated subsets | 1 MCP extension (CEMS) | Multi-MCP array, dynamic selection |
| **Local validation** | Lint daemon (sub-second), pre-push hooks | LINT_FIX_COMMAND + VALIDATION_COMMAND | Same + structured error parsing |
| **CI integration** | Full: poll → retry (max 2 rounds) | **None** | Poll GitHub checks, 2 CI fix rounds |
| **Quality gates** | Internal security framework, human review | Empty-diff check only | Diff size limits, LLM-as-judge, scope validation |
| **Error handling** | Per-node context engineering | Raw stderr dump | Structured error parser + strategy guidance |
| **Entry points** | Slack, CLI, Web, docs platform, ticket UI, feature flags | Slack, CLI, Dashboard | Same (adequate) |
| **Concurrency** | Multiple devboxes per engineer | `RUNNER_CONCURRENCY` queue | Same (adequate) |
| **Metrics** | 1,300+ PRs/week | Run status tracking | Same + CI pass rate tracking |

---

## 7. What Stripe Has That We Don't Need (Yet)

1. **Subdirectory-scoped rules**: Valuable for massive monorepos. Gooseherd operates on individual repos — global `.goosehints` is adequate until repos get very large.

2. **Centralized Toolshed**: Stripe has hundreds of agents. We have one (Gooseherd). A central MCP registry makes sense at scale; for now, `MCP_EXTENSIONS` config is sufficient.

3. **Devbox warm pools**: Stripe processes thousands of runs/day. Our clone step takes ~10-30s — acceptable for our volume.

4. **Custom blueprint DSL**: Stripe's teams build custom blueprints for specialized workflows. Our linear pipeline with config flags covers our use cases. Blueprint abstraction makes sense after we have 3+ distinct workflow types.

5. **Pre-push lint daemon**: Sub-second cached lint results require infrastructure investment. Our `LINT_FIX_COMMAND` before validation achieves the same goal, just slower.

---

## 8. What Stripe Doesn't Do That We Should Consider

1. **LLM-as-judge for scope validation**: Spotify does this (catches 25% of off-scope changes). Stripe doesn't disclose whether they do, but their Blueprint per-node scoping may achieve a similar effect.

2. **Browser/visual verification**: Neither Stripe nor our system does this. For frontend-heavy tasks, a Playwright sub-agent could verify visual output. Cost concern: $103 per 91 browser interactions.

3. **Observer system (auto-trigger from alerts)**: Our `observer_system_research_2026-02-20.md` designs this. Stripe doesn't disclose auto-triggering from monitoring — their entry points are all human-initiated (Slack, CLI, ticket buttons).

4. **Cross-run learning via CEMS**: Our memory integration (CEMS) enables agents to learn from previous runs. Stripe doesn't disclose an equivalent.

---

## 9. Implementation Roadmap

### Phase 1: Quick Wins (Day 1, ~5 hours)

| Change | Effort | Impact |
|--------|--------|--------|
| Filtered error re-prompting (`src/error-parser.ts`) | 2.5h | High — better agent fix accuracy |
| Multi-MCP extension support | 1.5h | High — unblocks all future MCP tools |
| Diff size quality gates | 1h | Medium — prevents catastrophic over-scoping |

### Phase 2: Prompt Quality (Day 2, ~2 hours)

| Change | Effort | Impact |
|--------|--------|--------|
| Task-type-specific prompt templates | 2h | Medium — better-tailored agent guidance |

### Phase 3: CI Integration (Day 3-4, ~4 hours)

| Change | Effort | Impact |
|--------|--------|--------|
| CI check polling + retry loop | 4h | Critical — closes the biggest gap |

### Phase 4: Advanced Quality (Day 5, ~3 hours)

| Change | Effort | Impact |
|--------|--------|--------|
| LLM-as-judge scope validation | 3h | Medium — catches 25% of off-scope changes |

### All changes are:
- **Additive** — gated by config flags defaulting to disabled
- **Backward compatible** — zero risk to existing deployments
- **Incrementally deployable** — each phase ships independently

---

## 10. Key Architectural Principles (Distilled from All Sources)

1. **What is good for human developers is good for agents** (Stripe) — investments in DX (linting, CI, tooling) naturally benefit agents

2. **Determinism where predictable, LLM judgment where not** (Stripe Blueprints) — don't make everything agentic; git ops, lint, push are deterministic

3. **Contained LLM scope compounds reliability** (Stripe) — smaller boxes per task reduce error surface

4. **Shift feedback left** (Stripe + Spotify) — catch issues locally before CI

5. **Cap retries at diminishing returns** (Stripe: 2 CI rounds, Cursor: 3 lint retries) — don't burn tokens on infinite loops

6. **Agents perform best with a tastefully curated set of tools** (Stripe) — less is more for MCP tools

7. **Tool descriptions are first-class prompt engineering** (Anthropic) — small refinements yield dramatic improvements

8. **LLM-as-judge for scope compliance** (Spotify) — catches 25% of off-scope changes cheaply

9. **Filtered, structured error output** (Spotify + Aider) — raw stderr wastes context; parse and categorize

10. **Build for humans first, agents inherit** (Stripe) — don't build separate agent-only infrastructure

---

## 11. Source References

### Stripe Blog Posts
- [Minions Part 1: Stripe's one-shot, end-to-end coding agents](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) (2026-02-09)
- [Minions Part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2) (2026-02-19)

### Agent Systems
- [Block Goose](https://github.com/block/goose) — our shared foundation with Stripe
- [Goose HOWTOAI.md](https://github.com/block/goose/blob/main/HOWTOAI.md) — Goose prompt patterns
- [Aider Edit Formats](https://aider.chat/docs/more/edit-formats.html) — diff format research
- [Aider Unified Diffs](https://aider.chat/docs/unified-diffs.html) — why udiff beats search/replace

### Research & Best Practices
- [Anthropic: Building Effective Agents](https://anthropic.com/engineering/building-effective-agents) — workflow vs agent patterns (cited by Stripe)
- [Anthropic: Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — context window management
- [Anthropic: Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — tool description engineering
- [Spotify Honk Agent: Feedback Loops](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) — two-layer verification pattern
- [Addy Osmani: Self-Improving Agents](https://addyosmani.com/blog/self-improving-agents/) — Ralph Wiggum loop pattern
- [Cursor Rules documentation](https://cursor.com/docs/context/rules) — Stripe's chosen rule format

### System Prompts (Reference)
- [Claude Code System Prompts (Piebald-AI)](https://github.com/Piebald-AI/claude-code-system-prompts) — 101+ versions tracked
- [Cursor Agent Prompt (March 2025)](https://gist.github.com/sshh12/25ad2e40529b269a88b80e7cf1c38084) — leaked system prompt
- [Aider udiff prompt](https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/aider/2025-07-06_prompt_udiff-mode.md) — edit format prompt

### MCP Ecosystem
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Sentry MCP Server](https://github.com/getsentry/sentry-mcp)
- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [PagerDuty MCP Server](https://github.com/PagerDuty/pagerduty-mcp-server)
