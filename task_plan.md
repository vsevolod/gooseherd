# Task Plan — Phase 10: Quality Depth + Adoption (Tasks 7, 26, 19, 20, 22, 10)

## Goal
Deepen pipeline quality (plan-before-code, local tests, threshold safety) and remove adoption friction (Slack manifest, channel observer, visual feedback).

## Implementation Order
```
7 → 26 → 19 → 20 → 22 → 10
```
- Task 7: Wiring job (30 lines) — activates complete Slack channel observer input source
- Task 26: YAML artifact (no code) — removes biggest installation friction
- Task 19: Plan node — LLM planning step before agent codes
- Task 20: Local test node — fail fast before push
- Task 22: Observer thresholds — prevent noise triggers
- Task 10: Screenshots — most user-visible feature (deferred to end due to dependency on Playwright)

---

## Phase 1: Wire Slack Channel Adapter (Task 7) — `complete`

**Files to change:**
- `src/slack-app.ts` — add `app.message()` listener

**What to do:**
1. Read `src/observer/sources/slack-channel-adapter.ts` to understand `parseSlackAlert` API
2. Read `src/slack-app.ts` to find where to add the listener
3. Add `app.message()` handler in `registerSlackHandlers` that:
   - Filters: only channels in observer watch config, ignore bot's own messages
   - Calls `parseSlackAlert(message)` to extract trigger events
   - Routes matched events through `observerDaemon.processEvent()`
4. Pass `observerDaemon` reference through to the handler (may need to add to function params)

**Acceptance:** Alert-bot messages in watched channels produce trigger events in observer log.

---

## Phase 2: Slack App Manifest (Task 26) — `complete`

**Files to create:**
- `slack-app-manifest.yml` in repo root

**What to do:**
1. Read `src/slack-app.ts` to catalog all required scopes, events, interactive components
2. Create manifest YAML with:
   - Bot scopes: `chat:write`, `commands`, `app_mentions:read`, `channels:history`, `channels:read`
   - Event subscriptions: `message.channels`, `app_mention`
   - Interactive components: approve/reject buttons
   - Socket Mode enabled
3. Test by importing into Slack API portal

**Acceptance:** New user can import manifest → copy 3 tokens → gooseherd starts.

---

## Phase 3: Plan Task Node (Task 19) — `complete`

**Files to create:**
- `src/pipeline/nodes/plan-task.ts`

**Files to change:**
- `src/pipeline/pipeline-engine.ts` — register `plan_task` in NODE_HANDLERS
- `pipelines/full.yml` — add `plan_task` before `implement`
- `src/config.ts` — add `PLAN_TASK_ENABLED` flag (optional, default false)

**What to do:**
1. Read `src/observer/smart-triage.ts` for LLM call pattern (`callLLMForJSON`)
2. Read `src/pipeline/nodes/implement.ts` for how prompt is built
3. Create `plan-task.ts` node that:
   - Reads task from context bag
   - Calls LLM to break task into implementation steps
   - Writes structured plan to context bag (`ctx.set("implementationPlan", plan)`)
4. Modify `hydrateContextNode` to include plan in prompt file if present
5. Add to `full.yml` pipeline, optionally to default pipeline behind feature flag

**Acceptance:** When enabled, agent receives a structured plan in its prompt.

---

## Phase 4: Local Test Node (Task 20) — `complete`

**Files to create:**
- `src/pipeline/nodes/local-test.ts`

**Files to change:**
- `src/pipeline/pipeline-engine.ts` — register `local_test` in NODE_HANDLERS
- `src/config.ts` — add `LOCAL_TEST_COMMAND` env var
- `pipelines/default.yml` — add `local_test` after `validate`, before `commit`

**What to do:**
1. Read `src/pipeline/nodes/validate.ts` for the pattern to copy
2. Create `local-test.ts` that runs `config.localTestCommand` via `runShellCapture`
3. Return `skipped` if command is empty, `failure` if exit code != 0
4. Wire into default pipeline with `if: "config.localTestCommand != ''"`
5. Add `on_failure` loop to `fix_validation` for auto-fix

**Acceptance:** Pipeline runs project tests locally before committing.

---

## Phase 5: Observer Threshold Configuration (Task 22) — `complete`

**Files to change:**
- `src/observer/types.ts` — add threshold fields to `TriggerRule`
- `src/observer/trigger-rules.ts` — parse new threshold fields
- `src/observer/safety.ts` — add `checkThresholds()` safety check

**What to do:**
1. Read `src/observer/types.ts` for `TriggerRule` interface
2. Read `src/observer/trigger-rules.ts` for parsing pattern
3. Read `src/observer/safety.ts` for existing safety check pattern
4. Add `minOccurrences?`, `minAgeMinutes?`, `minUserCount?` to `TriggerRule`
5. Parse them in `loadTriggerRules`
6. Add `checkThresholds(event, rule)` to `runSafetyChecks`

**Acceptance:** Trigger rules with threshold config correctly gate low-signal events.

---

## Phase 6: Screenshot/Visual Preview (Task 10) — `complete`

**Files to change:**
- `src/pipeline/quality-gates/browser-verify-node.ts` — add screenshot capture after smoke test
- `src/config.ts` — add `SCREENSHOT_ENABLED`, `PREVIEW_URL_TEMPLATE` env vars

**What to do:**
1. Read `src/pipeline/quality-gates/browser-verify-node.ts` for current flow
2. Add Playwright screenshot step (conditionally, when `SCREENSHOT_ENABLED=true`)
3. Save screenshot to run directory
4. Post screenshot to Slack thread via `files.uploadV2`
5. Keep lightweight — opt-in only, skip if no preview URL

**Acceptance:** After PR, screenshot of preview URL appears in Slack thread.

---

## Phase 7: Tests + Validation — `complete`

- Write unit tests for new functionality
- Run full test suite (346+ tests)
- TypeScript clean
- Codex-investigator validation
- Update progress.md

---

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| (none yet) | | |
