# Task Plan — Wire Dead Code + Quick Wins (Tasks 4, 5, 6, 8, 11, 12, 14)

## Goal
Activate dead code, wire stubs, and fix adoption blockers across HIGH and MEDIUM-HIGH tasks.

## Phases

### Phase 1: Quick Wins (Tasks 4, 12, 14) — `pending`
Three trivial changes with outsized impact.

**1a. Task 4: Per-Repo Pipeline Override**
- File: `src/pipeline/pipeline-engine.ts`
- Line 91: `execute()` — check context bag for `repoConfigPipeline` before using `pipelineFile` param
- Resolve to `pipelines/${hint}.yml` with validation (alphanumeric only, file must exist)
- Test: unit test that context bag pipeline override takes precedence

**1b. Task 12: DRY_RUN Default = false**
- File: `src/config.ts:236`
- Change: `parseBoolean(parsed.DRY_RUN, true)` → `parseBoolean(parsed.DRY_RUN, false)`

**1c. Task 14: Dashboard Public URL**
- File: `src/config.ts` — add `DASHBOARD_PUBLIC_URL` env var + `dashboardPublicUrl?: string` to AppConfig
- File: `src/run-manager.ts:605` — use `config.dashboardPublicUrl ?? http://...` for dashboard link
- Test: verify URL construction

### Phase 2: Observer Approval Buttons (Task 5) — `pending`
Wire the approve/reject Slack buttons that are currently no-ops.

- File: `src/slack-app.ts`
- Add `app.action("observer_approve")` handler:
  - Parse JSON value from button
  - Call `runManager.enqueueRun()` with extracted data
  - Post confirmation message in thread
  - Post ephemeral to approver
- Add `app.action("observer_reject")` handler:
  - Acknowledge rejection
  - Post ephemeral to rejector
- Remove TODO comment from daemon.ts:255-257

### Phase 3: Wire Smart Triage Pipeline Hint (Task 6) — `pending`
Connect the pipeline suggestion from smart triage all the way through to pipeline selection.

- File: `src/observer/daemon.ts` — set `event.pipelineHint = triageDecision.pipeline`
- File: `src/observer/run-composer.ts` — pass pipelineHint to NewRunInput
- File: `src/types.ts` — add `pipelineHint?: string` to NewRunInput
- File: `src/run-manager.ts` — pass pipelineHint from input to engine.execute()
- File: `src/pipeline/pipeline-engine.ts` — use run.pipelineHint to select pipeline YAML
- Validation: only allow known pipeline names (match against pipelines/ directory)

### Phase 4: Multi-MCP Extension Support (Task 8) — `pending`
Support multiple MCP extensions instead of just one.

- File: `src/config.ts`:
  - Add `MCP_EXTENSIONS` env var (comma-separated)
  - Add `mcpExtensions: string[]` to AppConfig
  - Merge `cemsMcpCommand` into extensions array for backwards compat
- File: `src/pipeline/shell.ts` — add helper `buildMcpFlags(extensions: string[]): string`
- File: `src/pipeline/nodes/implement.ts` — use helper
- File: `src/pipeline/nodes/fix-validation.ts` — use helper
- File: `src/pipeline/ci/fix-ci-node.ts` — use helper
- File: `src/pipeline/repo-config.ts` — support `mcp_extensions` in .gooseherd.yml

### Phase 5: "Awaiting Instructions" Idle State (Task 11) — `pending`
Enhance the post-run summary to clearly signal the bot is ready.

- File: `src/run-manager.ts` — enhance `postRunSummary()`
- Add visual "ready" indicator at the end of the summary

### Phase 6: Tests + Validation — `pending`
- Write unit tests for each change
- Run full test suite: `node --test --import tsx tests/*.test.ts`
- TypeScript compile check
- Launch codex-investigator for validation

## Files Modified (complete list)

| File | Changes |
|------|---------|
| `src/pipeline/pipeline-engine.ts` | Check ctx for pipeline override (Task 4) + use pipelineHint (Task 6) |
| `src/config.ts` | DRY_RUN default (Task 12), dashboard URL (Task 14), MCP extensions (Task 8) |
| `src/run-manager.ts` | Dashboard URL (Task 14), idle state (Task 11), pipeline hint passthrough (Task 6) |
| `src/slack-app.ts` | Observer approval handlers (Task 5) |
| `src/observer/daemon.ts` | Wire pipeline hint (Task 6), remove TODO (Task 5) |
| `src/observer/run-composer.ts` | Pass pipeline hint (Task 6) |
| `src/types.ts` | Add pipelineHint to NewRunInput (Task 6) |
| `src/pipeline/shell.ts` | MCP extension helper (Task 8) |
| `src/pipeline/nodes/implement.ts` | Use MCP helper (Task 8) |
| `src/pipeline/nodes/fix-validation.ts` | Use MCP helper (Task 8) |
| `src/pipeline/ci/fix-ci-node.ts` | Use MCP helper (Task 8) |
| `src/pipeline/repo-config.ts` | MCP extensions support (Task 8) |

## Error Log
| Error | Attempt | Resolution |
|-------|---------|------------|
| (none yet) | | |
