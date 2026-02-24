# Task Plan — Phase 9: Agent Intelligence + Infrastructure (Tasks 9, 17, 13, 18, 16, 15)

## Goal
Activate CI feedback loop for all users, fix infrastructure gaps, and improve agent intelligence for follow-up runs and memory.

## Implementation Order (per council recommendation)
```
9 → 17 → 13 → 18 → 16 → 15
```
Risk-free multipliers first, then context flywheel (18 feeds 16), then UX polish (15).
Task 7 (Slack channel adapter) and Task 10 (screenshots) deferred to next batch.

## Phases

### Phase 1: CI Feedback in Default Pipeline (Task 9) — `pending`
Add `wait_ci`/`fix_ci` loop to `default.yml` so every user gets CI feedback by default.

- File: `pipelines/default.yml` — insert `wait_ci` + `fix_ci` loop after `create_pr`, before `notify`
- Copy the block verbatim from `with-ci-feedback.yml` (lines 68-75)
- The node already returns success immediately when `CI_WAIT_ENABLED=false` (default), so this is safe

### Phase 2: CEMS x-team-id Header (Task 17) — `pending`
Add missing `x-team-id` header to both CEMS API calls.

- File: `src/config.ts` — add `CEMS_TEAM_ID` to env schema + `cemsTeamId?: string` to AppConfig
- File: `src/memory/cems-provider.ts` — add `teamId?: string` to `CemsProviderConfig`, include `x-team-id` header in both fetch calls
- File: `src/index.ts` — pass `teamId` when constructing CemsProvider

### Phase 3: Real Agent Default (Task 13) — `pending`
Detect `goose` binary on PATH at startup, warn if using dummy agent.

- File: `src/config.ts` — no change (template stays as-is)
- File: `src/index.ts` — after `loadConfig()`, check if agent command uses dummy-agent.sh + `goose` not on PATH → log warning
- Use `which goose` via child_process.execSync or import `execSync`
- Warning only, not blocking — still allow dummy for dev/test

### Phase 4: Inject Diff in Follow-Up Prompts (Task 18) — `pending`
Give the agent actual diff content (not just file names) on follow-up runs.

- File: `src/pipeline/nodes/hydrate-context.ts` — in the `parentContext` block (lines 81-95):
  - Run `git show HEAD --stat --unified=3` in repoDir
  - Truncate to ~3000 chars
  - Add "### Changes from previous run" section with the diff output
- Uses `runShellCapture` already imported

### Phase 5: Richer Memory Storage (Task 16) — `pending`
Store structured run data and positive feedback in memory.

- File: `src/hooks/run-lifecycle.ts`:
  - `onRunComplete`: include task type, diff stats, duration, outcome in the summary string
  - `onFeedback`: store positive feedback too (remove `rating !== "down"` guard), tag appropriately
- The `MemoryProvider` interface stays unchanged — we enrich the content string, not the API

### Phase 6: User-Friendly Error Messages (Task 15) — `pending`
Classify errors and show actionable messages in Slack.

- File: `src/run-manager.ts` — add `classifyError(message: string)` function:
  - Map known patterns: clone failed, lint failed, test failed, agent crashed, push rejected, timeout
  - Return `{ category, friendlyMessage, suggestion }`
- Use classifier in `postRunSummary` failure block to show user-friendly text + actionable suggestion
- Raw error stays in dashboard/logs for debugging

### Phase 7: Tests + Validation — `pending`
- Unit tests for error classifier, diff injection, memory enrichment
- Run full suite: `node --test --import tsx tests/*.test.ts`
- TypeScript compile check
- codex-investigator validation

## Files Modified

| File | Changes |
|------|---------|
| `pipelines/default.yml` | Add wait_ci + fix_ci loop (Task 9) |
| `src/config.ts` | Add CEMS_TEAM_ID (Task 17) |
| `src/memory/cems-provider.ts` | Add x-team-id header (Task 17) |
| `src/index.ts` | Pass teamId to CemsProvider (Task 17), agent detection warning (Task 13) |
| `src/pipeline/nodes/hydrate-context.ts` | Inject diff in follow-ups (Task 18) |
| `src/hooks/run-lifecycle.ts` | Richer memory + positive feedback (Task 16) |
| `src/run-manager.ts` | Error classifier + friendly messages (Task 15) |

## Error Log
| Error | Attempt | Resolution |
|-------|---------|------------|
| (none yet) | | |
