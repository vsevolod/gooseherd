# Findings — Phase 9 Tasks Research

## Task 9: CI Feedback in Default Pipeline
- **Current**: `default.yml` has 9 nodes, no CI. `with-ci-feedback.yml` has 13 nodes including `wait_ci`/`fix_ci`
- **Key safety**: `wait-ci-node.ts:32-34` returns `success` immediately if `ciWaitEnabled === false` (default)
- **Fix**: Copy the `wait_ci` block from `with-ci-feedback.yml` lines 68-75 into `default.yml` after `create_pr`
- **Risk**: Zero — the node no-ops when CI is disabled

## Task 17: CEMS x-team-id
- **Current**: `cems-provider.ts` sends only `Content-Type` + `Authorization` headers
- **Missing**: `x-team-id` header in both `searchMemories` (line 47-50) and `storeMemory` (line 100-103)
- **Config gap**: No `CEMS_TEAM_ID` in env schema or AppConfig
- **CemsProviderConfig**: only `{ apiUrl, apiKey }` — needs `teamId?: string`
- **index.ts:30**: constructs CemsProvider with `{ apiUrl, apiKey }` — needs `teamId`

## Task 13: Real Agent Default
- **Default**: `"bash scripts/dummy-agent.sh {{repo_dir}} {{prompt_file}} {{run_id}}"` (config.ts:257-258)
- **dummy-agent.sh**: copies prompt to repo, appends timestamp, adds a README block — no coding
- **No goose detection**: no `which goose`, no PATH check, no startup probe anywhere
- **index.ts:17**: `loadConfig()` called but no post-load validation of agent template
- **Approach**: Log a prominent warning at startup, don't block (dev/test still needs dummy)

## Task 18: Diff in Follow-Up Prompts
- **Current**: hydrate-context.ts:81-95 — follow-up prompt has file names only, no diff content
- **After clone**: repo has parent branch checked out with parent's commits — `git show HEAD` gives the diff
- **`runShellCapture` already imported** in hydrate-context.ts
- **Approach**: Run `git show HEAD --stat` + `git diff HEAD~1..HEAD --unified=3` truncated to ~3000 chars
- **Key**: Only on follow-up runs (`isFollowUp === true`)

## Task 16: Richer Memory
- **`onRunComplete`**: stores one-liner: "Completed task on X: task. Changed files: list"
- **Missing fields**: task type, diff stats, duration, outcome, error category
- **`onFeedback`**: guards on `rating !== "down" || !note?.trim()` — positive feedback silently dropped
- **`ExecutionResult` type** has: `changedFiles`, `prUrl`, `branchName`, `commitSha`, `agentAnalysis`
- **`agentAnalysis`** has: `filesChanged`, `linesAdded`, `linesRemoved`, `diffSummary`
- **MemoryProvider interface**: `storeMemory(content, tags, sourceRef)` — content is just a string, so we enrich the string

## Task 15: Friendly Error Messages
- **Current failure path**: raw `Error.message` → `store.updateRun({ error: message })` → Slack post
- **`postRunSummary`**: shows first 200 chars of `run.error` in Slack quote block
- **No categories**: just the raw string from pipeline engine or node errors
- **Common errors to classify**:
  - "Failed to clone" → Check GitHub token/repo access
  - "Validation failed after N" → Run tests locally first
  - "Agent exited with code" → Agent crashed, check logs
  - "Command failed with exit code" → Shell command failed
  - "exceeded Ns, terminating" → Timed out
  - "no meaningful changes" → Agent didn't produce changes
- **`formatRunCardBlocks`**: already has one special case for "Recovered after process restart"
