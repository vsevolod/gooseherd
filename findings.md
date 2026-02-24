# Findings — HIGH Priority Tasks Research

## Batch Analysis: Which Tasks to Tackle

### Task 4: Per-Repo Pipeline Override (TRIVIAL)
- **Current state**: `applyRepoConfig()` in repo-config.ts:150 sets `ctx.set("repoConfigPipeline", ...)` in the context bag
- **Problem**: `run-manager.ts:340` passes `this.config.pipelineFile` directly — never checks context bag
- **Fix location**: pipeline-engine.ts:91 — `execute()` receives `pipelineFile?` param, just needs to check context bag first
- **Verification**: clone.ts:104 calls `loadRepoConfig()` + `applyRepoConfig()` — CONFIRMED the value is set
- **Effort**: ONE line of code

### Task 5: Observer Approval Buttons (MODERATE)
- **Current state**: daemon.ts:255-257 has explicit TODO. Buttons render via `postApprovalRequest()` at line 303
- **Button value**: JSON blob with `eventId, ruleId, repoSlug, task, baseBranch, channelId, threadTs`
- **Missing**: No `app.action("observer_approve")` or `app.action("observer_reject")` handlers in slack-app.ts
- **Dependencies**: slack-app.ts needs access to runManager (already has it) + observer daemon (NOT currently passed)
- **Key decision**: Handlers don't need daemon reference — they just call `runManager.enqueueRun()` directly with the JSON payload data
- **Reject handler**: Post ephemeral confirmation, no further action needed
- **Effort**: ~30 lines in slack-app.ts

### Task 6: Wire Smart Triage Pipeline Hint (MODERATE)
- **Current state**: smart-triage.ts returns `ObserverDecision.pipeline` field (line 105). daemon.ts reads `triageDecision.task` and `triageDecision.priority` but IGNORES `triageDecision.pipeline`
- **TriggerEvent type**: Already has `pipelineHint?: string` field (confirmed in types.ts)
- **Missing chain**: daemon.ts → event.pipelineHint → run-composer.ts → NewRunInput → RunManager → PipelineEngine
- **Fix locations**:
  1. daemon.ts: Set `event.pipelineHint = triageDecision.pipeline` (alongside task/priority)
  2. run-composer.ts: Pass `pipelineHint` through to NewRunInput
  3. NewRunInput type: Add `pipelineHint?: string`
  4. RunManager: Pass hint to engine
  5. PipelineEngine: Use hint to select YAML file (with validation)
- **Effort**: ~20 lines across 4 files

### Task 8: Multi-MCP Extension Support (MODERATE-MECHANICAL)
- **Current state**: config.ts has `cemsMcpCommand?: string` (single string). Three files append ONE `--with-extension` flag:
  - implement.ts:47 — `if (config.cemsMcpCommand) cmd = ... --with-extension ...`
  - fix-validation.ts:59 — same pattern
  - fix-ci-node.ts:63 — same pattern
- **Fix**:
  1. config.ts: Add `mcpExtensions: string[]`, keep `cemsMcpCommand` for backwards compat, merge into array
  2. New helper: `appendMcpExtensions(cmd: string, extensions: string[]): string` in shell.ts
  3. Replace 3 call sites with helper
- **Per-repo**: repo-config.ts can add extensions to context bag, implement.ts reads from ctx
- **Effort**: ~40 lines across 5 files

### Task 11: "Awaiting Instructions" Idle State (TRIVIAL)
- **Current state**: run-manager.ts:393 `postRunSummary()` already posts a completion/failure summary
- **It already says**: `Reply in this thread to request changes...` (line 428)
- **What's actually missing**: A distinct visual "ready" state vs just text
- **Fix**: Enhance the existing summary footer — this is already 80% done
- **True effort**: Just add a clear visual separator/emoji indicator of "ready for instructions"
- **Effort**: ~5 lines

### Quick Wins (MEDIUM-HIGH but trivial effort)

**Task 12: DRY_RUN default = false**
- config.ts:236 — change `parseBoolean(parsed.DRY_RUN, true)` to `false`
- ONE line change. Massive adoption impact.

**Task 14: Dashboard Public URL**
- config.ts: Add `DASHBOARD_PUBLIC_URL` env var
- run-manager.ts:605 — change `http://${dashboardHost}:${dashboardPort}` to use public URL
- ~10 lines

## Prioritization Decision

**Batch 1 — Dead Code Activation** (Tasks 4, 5, 6):
All about making the observer system actually work. Per-repo pipeline + approval + pipeline hints form a cohesive feature.

**Batch 2 — Agent Polish** (Tasks 8, 11, 12, 14):
Independent improvements. Multi-MCP, idle state, DRY_RUN default, dashboard URL.

**Implementation order**: 4 → 12 → 14 → 11 → 5 → 6 → 8
(Quick wins first, then the three moderate tasks)
