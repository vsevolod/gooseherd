# Gooseherd Council Review — 2026-03-05

> 5-agent deep investigation: Codex Investigator, Architecture Strategist, Pattern Recognition, Performance Oracle, Security Sentinel. Each agent read 20-75 source files. Combined: 595K tokens consumed, 261 tool uses, ~20 minutes wall time.

---

## Executive Summary

Gooseherd is a **well-architected system** with clean module boundaries, consistent patterns, and thoughtful design. The pipeline engine, observer daemon, and orchestrator are solid foundations. However, the review uncovered **4 Critical security issues**, **significant performance bottlenecks** in the file-based store, **architectural gaps** blocking the roadmap, and **code duplication** across agent-invoking nodes that should be extracted.

### By the Numbers

| Agent | Critical | High/P0 | Medium/P1 | Low/P2 |
|-------|----------|---------|-----------|--------|
| Security Sentinel | 4 | 5 | 8 | 5 |
| Codex Investigator | -- | 4 | 28 | 27 |
| Performance Oracle | -- | 4 | 4 | 5 |
| Architecture Strategist | -- | 4 risks | 8 recommendations | -- |
| Pattern Recognition | -- | 2 high | 4 medium | 4 low |

### Cross-Agent Consensus (issues found by 3+ agents)

These issues were independently identified by multiple agents, making them the highest-confidence findings:

1. **Dashboard monolith** (3,817 lines) — Architecture, Pattern, Performance all flagged it
2. **RunStore reads entire JSON on every operation** — Performance, Codex both flagged it (O(n) reads)
3. **Non-atomic file writes** in store.ts and state-store.ts — Security, Performance, Codex all flagged it
4. **innerHTML XSS in dashboard** — Security, Codex both found it
5. **Agent command construction duplicated 4x** — Pattern, Codex both flagged it
6. **ConversationStore unbounded growth** — Performance, Codex, Architecture all flagged it
7. **No child process cleanup on abort** — Performance, Codex both flagged it
8. **Hardcoded NODE_HANDLERS registry** — Architecture, Pattern both flagged it

---

## I. Security (Must-Fix)

### CRITICAL

| ID | Issue | File | Fix |
|----|-------|------|-----|
| S-C1 | **Secrets in checkpoint files** — Context bag dumps all values to `checkpoint.json` including any stored API keys | `context-bag.ts` | Add `SENSITIVE_KEYS` filter in `toObject()`, set file permissions to 0600 |
| S-C2 | **Dashboard readBody has no size limit** — OOM DoS with single large POST | `dashboard-server.ts:50-56` | Add 1MB body limit (webhook-server already has this pattern) |
| S-C3 | **Docker socket + bind mount = container escape** — Agent can exfiltrate API keys passed to sandbox | `container-manager.ts:44-70` | Add `--security-opt=no-new-privileges`, drop capabilities, `--read-only` root, minimize passed keys |
| S-C4 | **Sandbox container runs as root** — No `USER` directive in either Dockerfile | `sandbox/Dockerfile`, `Dockerfile` | Add `USER gooseherd` to both |

### HIGH

| ID | Issue | File | Fix |
|----|-------|------|-----|
| S-H1 | **XSS via innerHTML** in observer panel — webhook payloads (repoSlug, source) injected without escaping | `dashboard-server.ts:3258-3310` | Use `textContent`/`escapeHtml()` for all dynamic values |
| S-H2 | **No security headers** — No CSP, X-Frame-Options, X-Content-Type-Options, HSTS | `dashboard-server.ts` | Add standard security headers to all responses |
| S-H3 | **Session cookie missing Secure flag** | `dashboard-server.ts:3403` | Add `Secure` when using HTTPS |
| S-H4 | **No CSRF protection** on POST routes — `/api/runs/:id/retry` triggers full pipeline | `dashboard-server.ts:3638-3741` | Add custom header requirement (`X-Requested-With`) |
| S-H5 | **Prompt injection via task descriptions** — User input flows unsanitized into LLM prompts | `hydrate-context.ts:37-100` | Add anti-injection system prompt rules, enforce `maxTaskChars` |

### MEDIUM (security)

| ID | Issue | Fix |
|----|-------|-----|
| S-M4 | Dashboard auth is optional — exposed on 0.0.0.0 without token = public access | Warn at startup when exposed without auth |
| S-M5 | `.html` artifacts served inline — stored XSS via agent-generated HTML | Serve with `Content-Disposition: attachment` |
| S-M6 | `review_app_url` not validated — SSRF via `.gooseherd.yml` | Validate against URL allowlist |
| S-M8 | Log sanitization only covers GitHub tokens — OpenRouter/Anthropic/Slack keys not redacted | Extend `sanitizeForLogs` to all secret patterns |

---

## II. Performance (High Impact)

### Critical Bottlenecks

| ID | Issue | Impact | Fix |
|----|-------|--------|-----|
| P-1 | **RunStore reads/writes entire JSON on every op** — Every heartbeat (every 20s per run) reads+parses+writes full `runs.json` | Linear degradation with run count; at 1000 runs, ~500KB per I/O cycle | Cache state in memory, read from disk only on startup |
| P-2 | **Dashboard log parsing reads entire file into memory** — `parseRunLog()` loads multi-MB logs, splits into 100K+ line arrays | 50-100MB memory spikes per dashboard view | LRU cache for parsed events, stream-parse for incremental mode |
| P-3 | **`readLogTail()` reads entire file to return 40 lines** — Allocates 10MB+ for large logs | Memory spikes, blocks event loop | Read from file end with bounded buffer |
| P-4 | **No child process cleanup on pipeline abort** — `spawn()` children become orphans when supervisor times out a run | Zombie processes accumulate | Track `Set<ChildProcess>` per run, expose `abort(runId)` |

### Optimization Opportunities

| ID | Issue | Fix |
|----|-------|-----|
| P-5 | ConversationStore has no cleanup timer or max entries | Add periodic eviction (2h TTL) + 500-entry cap |
| P-6 | Workspace cleaner calls `store.getRun()` per directory (N full file reads) | Read state once, use in-memory Map for all lookups |
| P-7 | `appendLog` opens/closes file handle per write (hundreds/sec during agent runs) | Use persistent `createWriteStream` per run |
| P-8 | Dashboard HTML string regenerated on every `GET /` request | Cache after generation, invalidate on reload |
| P-9 | GitHub API calls lack rate-limit awareness | Parse `X-RateLimit-*` headers, implement adaptive backoff |
| P-10 | `runs.json` never shrinks — append-only | Archive runs older than N days |

---

## III. Architecture (Roadmap Blockers)

### Roadmap Gap Analysis

| Phase | Status | Blocker |
|-------|--------|---------|
| Phase 1: Request Classification | **MOSTLY COMPLETE** | Observer events bypass orchestrator — go straight to `runManager.enqueueRun()` |
| Phase 2: Dynamic Pipeline Selection | **NOT STARTED** | Only 1 pipeline file exists; no preset variety for LLM to choose from |
| Phase 3: Decision Node | **PARTIAL** | `decide_next_step` exists but is narrowly scoped to browser_verify recovery; engine is strictly linear (can't jump/insert nodes) |
| Phase 4: Sub-Agent Delegation | **NOT STARTED** | No infrastructure for spawning scoped sub-agents |
| Phase 5: Multi-Agent Review | **NOT STARTED** | No consensus engine |

### Top 8 Architecture Recommendations

| Priority | Recommendation | Unblocks |
|----------|---------------|----------|
| 1 | **Extract Node Handler Registry** — Replace hardcoded `NODE_HANDLERS` with plugin-style registration. Derive `VALID_ACTIONS` from registry keys. | Phase 3+4, eliminates dual-maintenance |
| 2 | **Route Observer Events Through Orchestrator** — Observer should call `orchestrator.handleTriggerEvent()` instead of `runManager.enqueueRun()` directly | Phase 1 completion, unified intelligence path |
| 3 | **Add Pipeline Branching Primitives** — `goto` (change loop index) + sub-pipeline invocation (recursive `executePipeline`) | Phase 3+4, non-linear execution |
| 4 | **Split Dashboard Monolith** — `api-routes.ts` + `html-renderer.ts` + `auth.ts` + `server.ts` | Maintainability, security fixes easier |
| 5 | **Create Pipeline Presets** — `docs-only.yml`, `ui-change.yml`, `complex.yml`, `hotfix.yml` | Phase 2, no engine changes needed |
| 6 | **Extract Error Classification** — Move `classifyError` from `run-manager.ts` to shared module | Eliminates backwards dependency from supervisor |
| 7 | **Persist ConversationStore** — JSON file persistence in `{dataDir}/conversations/` | Conversation survives redeploy |
| 8 | **Remove Browser-Verify Semantics from Engine** — Move `isNonCodeFixFailure` check into the node handler | Engine purity, proper abstraction layers |

### Key Architectural Risks

1. **Single-process monolith** — Observer, supervisor, pipeline engine, dashboard, Slack app all in one Node.js process. Crash in any subsystem kills everything.
2. **Pipeline engine is strictly linear** — `for` loop with `i++`. No jumping, inserting, forking, or parallel branches. Hard ceiling for Phase 3+4.
3. **Two parallel intelligence paths** — Observer's `smart-triage.ts` and orchestrator both do LLM classification independently. Will diverge over time.
4. **Conversation memory is volatile** — In-memory `Map` with no persistence. Every deploy resets all conversations.

---

## IV. Code Quality (Patterns & Anti-Patterns)

### Code Duplication (Extract These)

| Duplication | Locations | Recommended Extraction |
|------------|-----------|----------------------|
| **Agent command construction** — template selection, variable binding, MCP flags | `implement.ts`, `fix-validation.ts`, `fix-browser.ts`, `fix-ci-node.ts` | `buildAgentCommand(config, run, repoDir, promptFile, isFollowUp)` in `shell.ts` |
| **Commit-push-capture sequence** — git add, commit, rev-parse, push, show changed files | `commit.ts`, `fix-browser.ts`, `fix-ci-node.ts` | `commitPushAndCapture(repoDir, commitMsg, logFile)` in a git utility module |
| **sleep() function** | `wait-ci-node.ts`, `deploy-preview.ts`, `fix-browser.ts` | Export from `shell.ts` |
| **LLMCallerConfig construction** | 8 different files | `deps.buildLLMConfig(model, timeoutMs)` factory |
| **callLLM / callLLMVision near-identical** | `llm/caller.ts` | Extract shared `callAPI()` helper |

### Anti-Patterns Found

| Anti-Pattern | Where | Fix |
|-------------|-------|-----|
| **Dual context bag writes** — Nodes write via both `ctx.set()` AND `return { outputs }` | `commit.ts`, `clone.ts`, `create-pr.ts`, `fix-browser.ts`, 6+ handlers | Standardize on `outputs` only, remove redundant `ctx.set()` |
| **Silent error swallowing** — `catch {}` with no logging | `pipeline-engine.ts:115`, `fix-browser.ts:53,68`, `stagehand-verify.ts:342-358` | Add debug-level logging at minimum |
| **Hardcoded model names** — Bypass `config.defaultLlmModel` | `generate-title.ts:36`, `summarize-changes.ts:72` | Use `config.defaultLlmModel` |
| **Hardcoded OpenRouter URL** — 3 locations in `caller.ts` | `llm/caller.ts:72,142,371` | Extract to config field |
| **Global mutable state** — `_containerManager` module-level var in `shell.ts` | `shell.ts:9-10` | Pass through NodeDeps (or accept as startup wiring tradeoff) |

### Type Safety

- **9 `any` usages** — All at SDK interop boundaries (Slack, Stagehand). Justified.
- **289 `as` assertions** — Mostly `ContextBag.get<T>()` casts. Recommendation: add a typed schema for the ~30 well-known context keys.
- **Expression evaluator** — Numeric comparisons are lexicographic (string-based). `ctx.roundNumber > 10` with value 9 incorrectly returns true. Add numeric coercion.

### What's Done Well

- **100% consistent handler interface** — All 26 handlers follow `(NodeConfig, ContextBag, NodeDeps) -> NodeResult`
- **Clean module boundaries** — No circular dependencies, proper barrel exports
- **Consistent kebab-case file naming** — All 80 files
- **Fail-open quality gates** — Smart default for automation systems
- **Atomic checkpoint writes** — temp-file + rename pattern in `context-bag.ts`
- **DI via NodeDeps** — Clean, testable, mockable
- **GitHubService factory** — Returns `undefined` when no auth configured

---

## V. Module-Specific Findings (Codex Investigator)

### Pipeline Nodes — Actionable Fixes

| File | Issue | Priority |
|------|-------|----------|
| `implement.ts` | Mass deletion threshold (8 files) is hardcoded magic number | P0 |
| `clone.ts` | Git token read bypasses config via `process.env["GITHUB_TOKEN"]` | P1 |
| `deploy-preview.ts` | URL polling has no jitter — concurrent runs hit same intervals | P1 |
| `fix-browser.ts` | 30-second redeploy fallback timeout should be configurable | P1 |
| `hydrate-context.ts` | `find . -type f` on large monorepos is extremely slow — use `git ls-files` | P1 |
| `create-pr.ts` | PR body can exceed GitHub's 65536-char limit — add truncation | P1 |
| `commit.ts` | `git add -A` stages before security scan runs | P2 |
| `push.ts` | No retry on transient network failures | P2 |
| `notify.ts` | Webhook POST has no `AbortSignal.timeout()` | P2 |
| `plan-task.ts` | Max 8 implementation steps is hardcoded | P2 |

### Observer — Actionable Fixes

| File | Issue | Priority |
|------|-------|----------|
| `sentry-poller.ts` | No fetch timeout (hangs on Sentry outage) — github-poller has this correctly | P0 |
| `daemon.ts` | No back-pressure when pending queue hits 1000 — silently drops events | P1 |
| `state-store.ts` | `flush()` is not atomic — use temp+rename | P1 |
| `state-store.ts` | `sweepDedup()` only runs on `load()` — stale entries accumulate | P1 |
| `smart-triage.ts` | No fallback model on timeout | P1 |
| `github-webhook-adapter.ts` | `notificationTarget` missing `channelId` | P2 |

### Sandbox — Actionable Fixes

| File | Issue | Priority |
|------|-------|----------|
| `container-manager.ts` | No disk space limit on containers | P0 |
| `container-manager.ts` | `exec()` stdout/stderr accumulates unbounded in memory | P1 |
| `container-manager.ts` | No image pull before `createContainer` — confusing "No such image" error | P1 |
| `container-manager.ts` | Container name not sanitized for Docker naming rules | P1 |

### LLM Caller — Actionable Fixes

| File | Issue | Priority |
|------|-------|----------|
| `caller.ts` | No retry on 429/502/503 — single rate-limit response fails everything | P1 |
| `caller.ts` | `callLLM`/`callLLMVision` near-identical — extract shared helper | P1 |
| `caller.ts` | Tool result compaction hardcoded to 6-message window | P2 |

### Supervisor — Actionable Fixes

| File | Issue | Priority |
|------|-------|----------|
| `run-supervisor.ts` | Auto-retry creates new run with no `retriedFromRunId` link | P1 |
| `failure-classifier.ts` | Classification is string-matching on error messages (fragile) | P1 |
| `run-supervisor.ts` | No exponential backoff on retries — fixed 5-minute cooldown | P2 |

---

## VI. Recommended Execution Order

### Sprint 1: Security Hardening (immediate)
1. Dashboard body size limit (S-C2) — 10 lines
2. Fix innerHTML XSS (S-H1) — add `escapeHtml()`, update all `innerHTML` usages
3. Add security headers (S-H2) — 10 lines in request handler
4. Add Secure flag to session cookie (S-H3) — 1 line
5. Extend `sanitizeForLogs` for all secret patterns (S-M8) — 15 lines
6. Filter sensitive keys from checkpoint serialization (S-C1) — 20 lines
7. Add `USER gooseherd` to Dockerfiles (S-C4) — 4 lines

### Sprint 2: Performance & Stability
1. Cache RunStore state in memory (P-1) — biggest single performance win
2. Make RunStore writes atomic with temp+rename (P-1 + codex)
3. Track child processes per run + abort mechanism (P-4)
4. Add Sentry poller timeout (codex P0)
5. LLM caller retry on 429/502/503 (codex P1)
6. ConversationStore cleanup timer + max entries (P-5)

### Sprint 3: Code Quality
1. Extract `buildAgentCommand()` utility — eliminates 4x duplication
2. Extract `commitPushAndCapture()` — eliminates 3x duplication
3. Standardize on `outputs` for context bag writes — remove redundant `ctx.set()`
4. Use `config.defaultLlmModel` in generate-title and summarize-changes
5. Export shared `sleep()` from shell.ts

### Sprint 4: Architecture Evolution
1. Extract Node Handler Registry (unblocks Phase 3+4)
2. Create pipeline presets (unblocks Phase 2)
3. Split dashboard monolith into 4 files
4. Route observer events through orchestrator
5. Persist ConversationStore to disk

### Sprint 5: Roadmap Advancement
1. Add `goto`/jump capability to pipeline engine
2. Add sub-pipeline invocation (recursive `executePipeline`)
3. Expand `decide_next_step` beyond browser_verify recovery
4. LLM-powered pipeline selection in orchestrator

---

## VII. What's Working Great (Don't Touch)

- **Pipeline engine core** — YAML loading, node walking, checkpoint/resume, expression evaluator
- **Context bag design** — Typed K/V store with atomic checkpoint is exactly right
- **Observer safety pipeline** — 7-layer safety (dedup, rate limit, budget, cooldown, allowlist, threshold, smart triage)
- **Orchestrator Phase 1** — Clean tool-use loop with conversation memory and observation masking
- **AsyncLocalStorage sandbox routing** — Concurrency-safe, elegant design
- **Quality gate fail-open defaults** — Right tradeoff for automation
- **466 tests across 21 suites** — Strong test coverage
- **Clean DI via NodeDeps** — Testable, mockable, no framework
- **Per-repo `.gooseherd.yml` config** — Security-aware (reads from base branch)
