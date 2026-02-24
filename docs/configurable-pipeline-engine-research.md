# Configurable Pipeline Engine for Gooseherd

**Date**: 2026-02-21
**Status**: Research / Design Proposal
**Scope**: Complete architecture for replacing the hardcoded executor with a configurable pipeline engine that mixes deterministic and agentic nodes, inspired by Stripe's Blueprint pattern, GitHub Actions workflow syntax, Temporal's durable execution model, and Airflow/Prefect DAG patterns.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Pipeline Node Types](#2-pipeline-node-types)
3. [Pipeline Configuration Format](#3-pipeline-configuration-format)
4. [Default Pipeline](#4-default-pipeline)
5. [Full Pipeline](#5-full-pipeline)
6. [Pipeline Engine Architecture](#6-pipeline-engine-architecture)
7. [Real-World Pipeline Examples](#7-real-world-pipeline-examples)
8. [Migration Path from Current Executor](#8-migration-path-from-current-executor)
9. [Research Sources](#9-research-sources)

---

## 1. Design Philosophy

### Core Principles (Distilled from Research)

**Stripe's Insight**: "The model does not run the system. The system runs the model." Blueprints are state machines that interleave deterministic code nodes with agentic nodes. The unglamorous parts of the architecture -- the deterministic nodes, the two-round CI cap, the mandatory reviewer -- do more work than the model.

**Temporal's Insight**: Workflows should survive crashes, resume from checkpoints, and wait indefinitely for external events (CI, webhooks, human approval) without polling loops or manual state management.

**GitHub Actions' Insight**: YAML-based workflow definitions with `needs` (dependency chains), `if` (conditional execution), and `outputs` (inter-job data passing) provide a configuration language developers already know.

**Airflow/Prefect's Insight**: DAGs with explicit task dependencies, trigger rules (`all_success`, `one_failure`), and XCom-style data passing between tasks provide the right abstraction for pipeline orchestration.

### Design Decisions

1. **State machine with linear-by-default flow, optional branching** -- not a full DAG. Most runs are linear; conditional branches handle the 20% of cases that diverge. This matches Stripe's approach (blueprints are sequential with conditional CI retry loops).

2. **YAML configuration** -- familiar to anyone who has written GitHub Actions. Code-based configuration (Inngest/Prefect style) is more powerful but creates a higher barrier for non-developer users and makes validation harder.

3. **Each node is a typed, self-contained unit** with declared inputs, outputs, retry policy, timeout, and error handling. Inspired by Temporal's activity/workflow separation.

4. **Deterministic by default, agentic by exception** -- agentic nodes are expensive (tokens, time, unpredictability). Every operation that CAN be deterministic SHOULD be deterministic. The LLM only runs where human-like judgment is required.

5. **Inter-node data passing via a shared context bag** -- a typed key-value store that nodes read from and write to. Inspired by GitHub Actions' `needs.*.outputs` and Airflow's XCom, but simpler.

---

## 2. Pipeline Node Types

### 2.1 Node Type Taxonomy

Every node falls into one of four categories:

| Category | Token Cost | Predictability | Duration | Examples |
|----------|-----------|---------------|----------|----------|
| **Deterministic** | Zero | 100% predictable | Seconds | clone, lint, commit, push |
| **Agentic** | High | Unpredictable | Minutes | implement task, fix CI errors |
| **Conditional** | Zero | Deterministic (evaluates expression) | Instant | gate checks, quality thresholds |
| **Async/Waiting** | Zero | Deterministic (waits for event) | Minutes-hours | wait for CI, wait for review app |

### 2.2 Complete Node Catalog

---

#### NODE: `clone`

**Purpose**: Clone the target repository and prepare the working directory.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `run.repoSlug`, `run.baseBranch`, `config.githubToken` |
| Outputs | `ctx.repoDir` (absolute path to cloned repo), `ctx.resolvedBaseBranch` (actual base branch after fallback detection) |
| Configuration | `depth` (shallow clone depth, default: 0 = full), `submodules` (boolean, default: false) |
| Error handling | Fatal -- if clone fails, the pipeline aborts |
| Retry | 1 retry with 5s backoff (transient network errors) |
| Timeout | 120s |

**Behavior**: Clones the repository, detects the default branch if the requested base branch doesn't exist (mirrors current `executor.ts:252-286` fallback logic), checks out the base branch, creates the working branch (or checks out the parent branch for follow-ups), and sets git author config.

---

#### NODE: `hydrate_context`

**Purpose**: Pre-fetch external context before the agent starts -- ticket details, documentation, related files, org memories. This is the equivalent of Stripe's "deterministic pre-hydration" where MCP tools run before the agent loop.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `run.task`, `run.repoSlug`, `ctx.repoDir` |
| Outputs | `ctx.hydratedSections` (array of markdown strings to inject into the prompt), `ctx.relatedFiles` (list of file paths the task likely touches) |
| Configuration | `sources` (array of hydration strategies -- see below) |
| Error handling | Non-fatal -- each source fails independently; failures produce warnings but don't abort |
| Retry | Per-source: 1 retry |
| Timeout | 30s total across all sources |

**Hydration sources** (configured per pipeline):

```yaml
sources:
  - type: memory          # CEMS/memory provider search
    query_from: task      # field to use as search query
  - type: repo_rules      # scan for .cursorrules, .goosehints, AGENTS.md
    scan_dirs: [".cursor/rules", ".github"]
  - type: ticket_links    # extract URLs from task text, fetch via MCP
    mcp_tool: fetch_url
  - type: file_finder     # find files likely related to the task
    strategy: grep_task_keywords
```

---

#### NODE: `plan_task`

**Purpose**: Optional planner agent that decomposes a complex task into sub-steps, identifies target files, and produces a structured plan. Inspired by the Plan-and-Execute pattern where a capable model creates a strategy that cheaper models execute.

| Property | Value |
|----------|-------|
| Category | Agentic |
| Inputs | `run.task`, `ctx.hydratedSections`, `ctx.repoDir` |
| Outputs | `ctx.plan` (structured plan: list of steps with target files), `ctx.estimatedScope` (small/medium/large) |
| Configuration | `enabled` (default: false), `model` (can use a different/cheaper model than the main agent), `max_tokens` (budget for planning), `system_prompt` (override), `tools` (subset of tools available to the planner -- typically read-only: grep, read, glob) |
| Error handling | Non-fatal if `required: false`; if planning fails, the main agent gets the raw task |
| Retry | 0 (planning is exploratory; retrying with same context rarely helps) |
| Timeout | 120s |

---

#### NODE: `implement`

**Purpose**: The main coding agent. Receives the enriched prompt and implements the task. This is the primary agentic node -- equivalent to Stripe's "Implement task" cloud node.

| Property | Value |
|----------|-------|
| Category | Agentic |
| Inputs | `run` (full run record), `ctx.repoDir`, `ctx.hydratedSections`, `ctx.plan` (if planner ran) |
| Outputs | (file changes in the repo working directory) |
| Configuration | `command_template` (the agent invocation command -- e.g., `goose run ...`), `follow_up_template` (alternative command for follow-up runs), `system_prompt` (injected into agent prompt), `tools` (list of MCP extensions to attach), `task_type_prompts` (map of task type -> specialized instructions), `tool_subsets` (per-task-type tool filtering) |
| Error handling | Fatal by default; if the agent crashes, the pipeline aborts. Configurable: `on_failure: skip` allows proceeding to validation anyway (useful for partial-fix scenarios) |
| Retry | 0 (the agent run is expensive; retrying blindly wastes tokens. The validation loop handles iterative fixes) |
| Timeout | `agent_timeout_seconds` (default: 1200s = 20 minutes) |

**Task-type prompt routing** (configured in pipeline YAML):

```yaml
task_type_prompts:
  bugfix:
    prepend: |
      PRIORITY: Identify the root cause FIRST. Write a reproducing test.
      Make the MINIMAL fix. Do NOT refactor unrelated code.
  feature:
    prepend: |
      Follow existing patterns in the codebase. Add tests for new behavior.
      Update documentation if public APIs change.
  refactor:
    prepend: |
      ZERO behavior changes allowed. All existing tests MUST continue to pass.
      Focus on code clarity, not cleverness.
  chore:
    prepend: |
      Strictly scoped to the requested change. No features, no refactoring.
```

---

#### NODE: `lint_fix`

**Purpose**: Auto-fix lint errors deterministically. This runs with zero LLM involvement -- purely `eslint --fix`, `rubocop -A`, `black .`, etc. Equivalent to Stripe's "Run configured linters" deterministic node.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `ctx.repoDir` |
| Outputs | `ctx.lintFixApplied` (boolean -- whether any files were modified) |
| Configuration | `command` (the lint fix command), `enabled` (default: true if command is set) |
| Error handling | Non-fatal -- lint fix failure (exit code != 0) logs a warning but doesn't abort. The validation step will catch remaining issues. |
| Retry | 0 |
| Timeout | 60s |

---

#### NODE: `run_tests`

**Purpose**: Run a targeted subset of tests -- only the spec files related to changed files. This is NOT the full validation suite; it is a fast, scoped test run to catch obvious breakage early (shift feedback left).

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `ctx.repoDir`, `ctx.changedFiles` (from `git diff --name-only`) |
| Outputs | `ctx.testResult` (`{ passed: boolean, output: string, failedTests: string[] }`) |
| Configuration | `command_template` (e.g., `rspec {{changed_spec_files}}` or `jest --findRelatedTests {{changed_files}}`), `spec_pattern` (how to derive spec files from source files -- e.g., `s/\.ts$/.test.ts/`), `enabled` (default: false -- requires explicit configuration) |
| Error handling | Non-fatal by default (test failures feed into the validation loop). Configurable: `on_failure: abort` for strict mode |
| Retry | 0 |
| Timeout | 300s |

---

#### NODE: `validate`

**Purpose**: Run the full validation command. This is the existing `VALIDATION_COMMAND` behavior -- a user-defined command that must exit 0 for the pipeline to proceed.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `ctx.repoDir` |
| Outputs | `ctx.validationResult` (`{ passed: boolean, output: string, exitCode: number }`) |
| Configuration | `command` (the validation command), `error_parser` (structured error extraction strategy -- see below) |
| Error handling | Feeds into the validation retry loop (see `fix_validation` node) |
| Retry | 0 (retries are handled by the `fix_validation` -> `validate` loop) |
| Timeout | 300s |

**Error parser strategies**:

```yaml
error_parser:
  type: auto       # auto-detect from output patterns
  # OR explicit:
  type: structured
  parsers:
    - format: eslint     # ESLint JSON or stylish format
    - format: typescript  # tsc errors (file.ts(line,col): error TSxxxx)
    - format: rspec       # RSpec failure format
    - format: jest        # Jest failure format
    - format: rubocop     # RuboCop offense format
    - format: pytest      # pytest short test summary
    - format: generic     # file:line: error pattern
  max_errors_per_category: 15
  max_total_chars: 3000
```

---

#### NODE: `fix_validation`

**Purpose**: Re-run the agent with structured error context from the failed validation. This is the "fix loop" node -- it receives parsed errors and asks the agent to fix them.

| Property | Value |
|----------|-------|
| Category | Agentic |
| Inputs | `ctx.validationResult`, `ctx.repoDir`, error parser output |
| Outputs | (file changes in repo) |
| Configuration | `command_template` (typically same as `implement`, but with a fix-focused prompt), `system_prompt` (override for fix-mode: "Fix ONLY the listed errors. Do NOT refactor unrelated code."), `tools` (can be a reduced tool set -- no need for grep/search during fix mode) |
| Error handling | If this node fails, the pipeline checks whether max retries are exhausted |
| Retry | 0 (the validate->fix loop handles iteration) |
| Timeout | `agent_timeout_seconds` |

**The fix prompt template** (much more structured than current raw stderr dump):

```
Validation failed (round {{round}}/{{max_rounds}}).

## Errors by Category

### LINT errors ({{lint_count}})
{{#each lint_errors}}
- {{file}}:{{line}}: {{message}} [{{rule}}]
{{/each}}

### TEST failures ({{test_count}})
{{#each test_errors}}
- {{file}}:{{line}}: {{message}}
{{/each}}

### TYPE errors ({{type_count}})
{{#each type_errors}}
- {{file}}:{{line}}: {{message}} [{{code}}]
{{/each}}

## Strategy
1. Fix errors file-by-file, starting with the most impactful category.
2. Type errors often cascade -- fix the root cause, not every symptom.
3. If a test failure is unrelated to your changes, note it but do not modify the test.
4. Do NOT change code unrelated to these errors.
```

---

#### NODE: `diff_quality_gate`

**Purpose**: Check the diff against configurable quality thresholds before committing. Catches agent over-scoping (reformatting entire codebase, touching 50 files for a one-line fix).

| Property | Value |
|----------|-------|
| Category | Conditional |
| Inputs | `ctx.repoDir` |
| Outputs | `ctx.diffStats` (`{ addedLines: number, removedLines: number, changedFiles: string[], totalDiffLines: number }`) |
| Configuration | `max_diff_lines` (default: 0 = disabled), `max_changed_files` (default: 0 = disabled), `max_file_size_change_lines` (per-file limit, default: 0 = disabled) |
| Error handling | Fatal -- if the diff exceeds limits, the pipeline aborts with a descriptive error |
| Retry | 0 |
| Timeout | 10s |

---

#### NODE: `scope_judge`

**Purpose**: LLM-as-judge that evaluates whether the diff matches the original task scope. Inspired by Spotify's Honk Agent outer loop, which catches ~25% of off-scope changes.

| Property | Value |
|----------|-------|
| Category | Agentic (lightweight -- single LLM call, not a loop) |
| Inputs | `run.task`, `ctx.diffStats`, truncated diff content |
| Outputs | `ctx.scopeVerdict` (`{ passed: boolean, reason: string }`) |
| Configuration | `enabled` (default: false), `model` (can use a cheaper model), `command_template` (how to invoke the judge), `max_diff_chars` (truncation limit for judge input, default: 8000), `on_failure` (`abort` or `warn` -- default: `warn`) |
| Error handling | Configurable -- `abort` rejects the run, `warn` logs the concern but proceeds |
| Retry | 1 (transient LLM failures) |
| Timeout | 60s |

**Judge prompt** (fixed, not user-configurable):

```
You are a scope validator for an automated coding agent.
Evaluate whether the code changes match the requested task.

## Task
{{task}}

## Changed Files
{{changed_files_list}}

## Diff (truncated to {{max_chars}} chars)
{{diff_content}}

Reply with EXACTLY one line:
- PASS: if changes are appropriately scoped to the task
- FAIL: <reason> if changes go beyond the task scope (e.g., unnecessary refactoring, unrelated file modifications, style changes to untouched code)
```

---

#### NODE: `commit`

**Purpose**: Stage all changes, create a commit with a descriptive message, and capture the commit SHA and changed file list.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `ctx.repoDir`, `run.task`, `config.appName` |
| Outputs | `ctx.commitSha`, `ctx.changedFiles` (list of file paths changed in the commit) |
| Configuration | `message_template` (default: `{{app_slug}}: {{task_summary}}`), `max_task_summary_chars` (default: 72) |
| Error handling | Fatal if no changes exist (empty diff = agent produced nothing) |
| Retry | 0 |
| Timeout | 30s |

---

#### NODE: `push`

**Purpose**: Push the branch to the remote repository.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `ctx.repoDir`, `run.branchName`, `ctx.isFollowUp` |
| Outputs | (branch pushed to origin) |
| Configuration | `force_with_lease` (boolean -- automatically true for follow-up runs) |
| Error handling | Fatal -- push failure aborts the pipeline |
| Retry | 1 retry with 5s backoff (transient network errors) |
| Timeout | 60s |

---

#### NODE: `wait_for_ci`

**Purpose**: Wait for GitHub Actions (or other CI) to complete after push. Uses GitHub check suites API to poll for completion, or optionally waits for a webhook callback.

| Property | Value |
|----------|-------|
| Category | Async/Waiting |
| Inputs | `run.repoSlug`, `ctx.commitSha`, `config.githubToken` |
| Outputs | `ctx.ciResult` (`{ status: 'success' \| 'failure' \| 'timeout', checkRuns: Array<{ name, conclusion, detailsUrl }>, failedChecks: Array<{ name, output }> }`) |
| Configuration | `mode` (`poll` or `webhook`), `poll_interval_seconds` (default: 30), `max_wait_seconds` (default: 600 = 10 minutes), `ignore_checks` (array of check names to skip, e.g., `["codecov/project"]`), `required_checks` (if set, only wait for these specific checks) |
| Error handling | Timeout produces `ctx.ciResult.status = 'timeout'`; downstream nodes decide what to do |
| Retry | 0 (polling itself handles transience) |
| Timeout | `max_wait_seconds` |

**Poll mode**: Uses `octokit.checks.listForRef()` to check status every `poll_interval_seconds`. Returns when all checks complete or timeout is reached.

**Webhook mode** (future): Registers a webhook handler that listens for `check_suite.completed` events. The pipeline engine suspends the run and resumes when the webhook fires. This is the Temporal Signal pattern -- the workflow pauses and waits indefinitely (up to max_wait) for an external event.

---

#### NODE: `parse_ci_results`

**Purpose**: Parse CI failure output into structured, actionable error context for the agent fix loop.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `ctx.ciResult` |
| Outputs | `ctx.ciErrors` (structured error list similar to validation error parser output) |
| Configuration | `fetch_logs` (boolean -- whether to fetch full build logs from GitHub Actions API, default: true), `max_log_chars` (truncation limit, default: 5000) |
| Error handling | Non-fatal -- if log fetching fails, raw check names and conclusions are still available |
| Retry | 1 (transient API failures) |
| Timeout | 30s |

---

#### NODE: `fix_ci`

**Purpose**: Re-run the agent with CI failure context. Same pattern as `fix_validation` but with CI-specific errors.

| Property | Value |
|----------|-------|
| Category | Agentic |
| Inputs | `ctx.ciErrors`, `ctx.repoDir` |
| Outputs | (file changes in repo) |
| Configuration | Same as `fix_validation` but with CI-focused system prompt |
| Error handling | If max CI fix rounds exceeded, pipeline proceeds to `create_pr` with a warning comment |
| Retry | 0 (the ci loop handles iteration) |
| Timeout | `agent_timeout_seconds` |

**CI fix prompt template**:

```
CI checks failed after push. Fix ONLY the CI failures.

## Failed Checks
{{#each failed_checks}}
### {{name}} ({{conclusion}})
{{#if output}}
```
{{output}}
```
{{/if}}
{{#if details_url}}
Full logs: {{details_url}}
{{/if}}
{{/each}}

## Instructions
1. Read the failing check output carefully.
2. Make MINIMAL fixes to pass CI.
3. Do NOT change code unrelated to the failures.
4. If a failure is caused by a flaky test (not related to your changes), note it but do not modify the test.
```

---

#### NODE: `deploy_review_app`

**Purpose**: Trigger deployment of a review/preview app for the branch. Waits for the deployment to complete and captures the review app URL.

| Property | Value |
|----------|-------|
| Category | Async/Waiting |
| Inputs | `run.repoSlug`, `run.branchName`, `ctx.commitSha` |
| Outputs | `ctx.reviewAppUrl` (the deployed preview URL) |
| Configuration | `trigger_command` (shell command to trigger deployment -- e.g., `vercel --confirm` or a GitHub deployment API call), `mode` (`poll` or `webhook`), `poll_url_template` (URL to check deployment status), `max_wait_seconds` (default: 300), `url_extraction_pattern` (regex to extract the preview URL from deployment output) |
| Error handling | Non-fatal by default (`on_failure: skip`). If deployment fails, browser verification is skipped |
| Retry | 1 |
| Timeout | `max_wait_seconds` |

---

#### NODE: `browser_verify`

**Purpose**: Run Playwright against the review app URL to visually verify the changes. This is a specialized agentic node -- the agent navigates the app and checks that the expected behavior is present.

| Property | Value |
|----------|-------|
| Category | Agentic |
| Inputs | `ctx.reviewAppUrl`, `run.task`, `ctx.changedFiles` |
| Outputs | `ctx.browserResult` (`{ passed: boolean, screenshots: string[], issues: string[] }`) |
| Configuration | `enabled` (default: false), `command_template` (Playwright agent invocation), `system_prompt` (browser-specific instructions), `tools` (Playwright MCP tools only -- heavily curated), `max_interactions` (cap on browser actions to control cost, default: 30), `on_failure` (`abort`, `warn`, `comment` -- default: `comment`) |
| Error handling | Non-fatal by default. Failures add a comment to the PR but don't block it |
| Retry | 0 (browser tests are expensive) |
| Timeout | 300s |

**Cost note**: Research shows a single browser verification thread with 91 Playwright MCP invocations cost $103. The `max_interactions` cap and conditional execution (only for view-layer changes) are essential cost controls.

---

#### NODE: `create_pr`

**Purpose**: Create or update the GitHub Pull Request.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `run`, `ctx.resolvedBaseBranch`, `ctx.commitSha`, `ctx.changedFiles`, `ctx.ciResult` (optional), `ctx.scopeVerdict` (optional), `ctx.browserResult` (optional) |
| Outputs | `ctx.prUrl`, `ctx.prNumber` |
| Configuration | `title_template` (default: `{{app_slug}}: {{task_summary}}`), `body_template` (markdown template for PR body), `labels` (array of labels to add), `reviewers` (array of GitHub usernames to request review from), `draft` (boolean, default: false) |
| Error handling | Fatal -- if PR creation fails, pipeline aborts |
| Retry | 1 |
| Timeout | 30s |

**PR body template** (enriched with pipeline metadata):

```markdown
## Task
{{task}}

## Details
- **Base branch:** `{{base_branch}}`
- **Requested by:** {{requested_by}}
- **Run:** `{{run_id_short}}`
- **Pipeline:** `{{pipeline_name}}`

{{#if scope_verdict}}
## Scope Check
{{scope_verdict.passed ? "PASS" : "WARN: " + scope_verdict.reason}}
{{/if}}

{{#if ci_result}}
## CI Status
{{ci_result.status}}
{{/if}}

{{#if browser_result}}
## Browser Verification
{{browser_result.passed ? "PASS" : "Issues found"}}
{{/if}}

---
*Automated by [{{app_name}}](https://goose-herd.com)*
```

---

#### NODE: `notify`

**Purpose**: Post-run notification -- update Slack thread, send webhook, or trigger any configured notification.

| Property | Value |
|----------|-------|
| Category | Deterministic |
| Inputs | `run`, `ctx.prUrl`, `ctx.ciResult`, pipeline execution summary |
| Outputs | (none -- side effect only) |
| Configuration | `channels` (array of notification destinations -- `slack_thread`, `slack_channel`, `webhook_url`), `on` (when to notify -- `success`, `failure`, `always` -- default: `always`) |
| Error handling | Non-fatal -- notification failures are logged but don't affect pipeline status |
| Retry | 1 |
| Timeout | 10s |

---

### 2.3 Node Summary Table

| Node | Category | Token Cost | Duration | Required? |
|------|----------|-----------|----------|-----------|
| `clone` | Deterministic | 0 | 10-30s | Yes |
| `hydrate_context` | Deterministic | 0 | 5-30s | No |
| `plan_task` | Agentic | Medium | 30-120s | No |
| `implement` | Agentic | High | 2-20min | Yes |
| `lint_fix` | Deterministic | 0 | 5-60s | No |
| `run_tests` | Deterministic | 0 | 10-300s | No |
| `validate` | Deterministic | 0 | 10-300s | No |
| `fix_validation` | Agentic | High | 2-20min | No |
| `diff_quality_gate` | Conditional | 0 | <1s | No |
| `scope_judge` | Agentic (light) | Low | 10-60s | No |
| `commit` | Deterministic | 0 | <5s | Yes |
| `push` | Deterministic | 0 | 5-30s | Yes |
| `wait_for_ci` | Async | 0 | 1-10min | No |
| `parse_ci_results` | Deterministic | 0 | 5-30s | No |
| `fix_ci` | Agentic | High | 2-20min | No |
| `deploy_review_app` | Async | 0 | 1-5min | No |
| `browser_verify` | Agentic | Very High | 1-5min | No |
| `create_pr` | Deterministic | 0 | 5-10s | Yes* |
| `notify` | Deterministic | 0 | <5s | No |

*Required unless `dry_run: true`.

---

## 3. Pipeline Configuration Format

### 3.1 Overall Structure

The YAML format borrows from GitHub Actions (steps with `if`/`needs`), Temporal (retry policies, timeouts), and adds Gooseherd-specific concepts (agentic nodes, tool subsets, context bag).

```yaml
# pipeline.yaml
apiVersion: gooseherd/v1
kind: Pipeline
metadata:
  name: default
  description: Standard pipeline for most repositories

# Global defaults applied to all nodes unless overridden
defaults:
  timeout: 300s
  retry:
    max_attempts: 0
    backoff: 5s
  on_failure: abort    # abort | skip | warn

# Variables that nodes can reference via {{var_name}}
vars:
  app_slug: "{{config.app_name | slugify}}"
  max_ci_rounds: 2
  max_validation_rounds: 2

# The pipeline steps, executed in order
steps:
  - id: clone
    node: clone
    config:
      depth: 0

  - id: hydrate
    node: hydrate_context
    config:
      sources:
        - type: memory
          query_from: task
        - type: repo_rules
    on_failure: skip

  - id: implement
    node: implement
    config:
      command_template: "{{config.agent_command_template}}"
      tools:
        - "{{config.mcp_extensions}}"
      task_type_prompts:
        bugfix:
          prepend: "Identify root cause first. Write a reproducing test."
        feature:
          prepend: "Follow existing patterns. Add tests."

  - id: lint_fix
    node: lint_fix
    if: "config.lint_fix_command != ''"
    config:
      command: "{{config.lint_fix_command}}"
    on_failure: skip

  # Validation loop: validate -> fix -> validate (up to max_validation_rounds)
  - id: validate
    node: validate
    if: "config.validation_command != ''"
    config:
      command: "{{config.validation_command}}"
      error_parser:
        type: auto

  - id: fix_validation
    node: fix_validation
    if: "steps.validate.outputs.passed == false"
    loop:
      max_iterations: "{{vars.max_validation_rounds}}"
      sequence:
        - node: fix_validation
          config:
            command_template: "{{config.agent_command_template}}"
        - node: lint_fix
          if: "config.lint_fix_command != ''"
          config:
            command: "{{config.lint_fix_command}}"
          on_failure: skip
        - node: validate
          config:
            command: "{{config.validation_command}}"
      until: "steps.validate.outputs.passed == true"
      on_exhausted: abort

  - id: quality_gate
    node: diff_quality_gate
    config:
      max_diff_lines: "{{config.max_diff_lines}}"
      max_changed_files: "{{config.max_changed_files}}"

  - id: commit
    node: commit

  - id: push
    node: push
    if: "config.dry_run == false"

  - id: create_pr
    node: create_pr
    if: "config.dry_run == false"

  - id: notify
    node: notify
    on_failure: skip
    if: always()
```

### 3.2 Conditional Execution

Borrowing directly from GitHub Actions' `if` expression syntax:

```yaml
# Simple boolean from config
if: "config.dry_run == false"

# Check previous step output
if: "steps.validate.outputs.passed == false"

# Check if a config value is set
if: "config.lint_fix_command != ''"

# Status functions (like GitHub Actions)
if: always()            # run regardless of previous step results
if: success()           # only if all previous steps succeeded (default)
if: failure()           # only if a previous step failed

# Compound conditions
if: "steps.push.status == 'success' && config.ci_feedback_enabled == true"

# Check for file type changes (for conditional browser verification)
if: "ctx.changedFiles | any_match('**/*.{tsx,jsx,vue,svelte,html,css}')"
```

### 3.3 Retry Loops

Two patterns for retries:

**Simple retry** (same node, same inputs):

```yaml
- id: push
  node: push
  retry:
    max_attempts: 2
    backoff: 5s
    retry_on: [exit_code_nonzero, timeout]
```

**Fix-and-retry loop** (multi-node cycle with different inputs each iteration):

```yaml
- id: validation_loop
  loop:
    max_iterations: 2
    sequence:
      - node: fix_validation
      - node: lint_fix
        on_failure: skip
      - node: validate
    until: "validate.outputs.passed == true"
    on_exhausted: abort     # abort | skip | warn
```

**CI fix loop** (same pattern, different nodes):

```yaml
- id: ci_loop
  if: "steps.wait_for_ci.outputs.status == 'failure'"
  loop:
    max_iterations: 2
    sequence:
      - node: parse_ci_results
      - node: fix_ci
      - node: lint_fix
        on_failure: skip
      - node: commit
        config:
          message_template: "{{app_slug}}: fix CI (round {{loop.iteration}})"
      - node: push
      - node: wait_for_ci
    until: "wait_for_ci.outputs.status == 'success'"
    on_exhausted: warn    # proceed to PR creation with a warning
```

### 3.4 Data Passing Between Nodes

Every node reads from and writes to a shared **context bag** (`ctx`). This is a typed key-value store.

```typescript
interface PipelineContext {
  // Set by engine
  run: RunRecord;
  config: AppConfig;
  pipeline: PipelineConfig;

  // Set by nodes (each node type declares its outputs)
  repoDir?: string;
  resolvedBaseBranch?: string;
  hydratedSections?: string[];
  relatedFiles?: string[];
  plan?: TaskPlan;
  estimatedScope?: 'small' | 'medium' | 'large';
  lintFixApplied?: boolean;
  testResult?: TestResult;
  validationResult?: ValidationResult;
  diffStats?: DiffStats;
  scopeVerdict?: ScopeVerdict;
  commitSha?: string;
  changedFiles?: string[];
  isFollowUp?: boolean;
  ciResult?: CIResult;
  ciErrors?: StructuredErrors;
  reviewAppUrl?: string;
  browserResult?: BrowserResult;
  prUrl?: string;
  prNumber?: number;
}
```

Nodes reference context values in YAML using `ctx.*` prefix:

```yaml
- id: browser_verify
  node: browser_verify
  if: "ctx.reviewAppUrl != null"
  config:
    url: "{{ctx.reviewAppUrl}}"
```

### 3.5 Per-Node Tool Subsets for Agentic Nodes

Each agentic node can declare which MCP extensions it needs:

```yaml
- id: implement
  node: implement
  config:
    tools:
      - "npx @anthropic/cems-mcp"           # Memory
      - "npx @github/mcp-server"             # GitHub context
      - "npx @sentry/mcp-server"             # Error tracking

- id: fix_ci
  node: fix_ci
  config:
    tools:
      - "npx @anthropic/cems-mcp"           # Memory only -- no need for sentry during CI fix

- id: browser_verify
  node: browser_verify
  config:
    tools:
      - "npx @anthropic/mcp-browser"        # Browser tools only
```

### 3.6 Per-Node System Prompts

```yaml
- id: implement
  node: implement
  config:
    system_prompt: |
      You are an expert software engineer implementing a task.
      Follow existing patterns. Write tests. Keep changes minimal.

- id: fix_ci
  node: fix_ci
  config:
    system_prompt: |
      You are fixing CI failures. Make ONLY the changes needed to pass CI.
      Do NOT refactor, do NOT add features, do NOT touch unrelated code.
```

### 3.7 Failure Handlers

Borrowing from GitHub Actions' `failure()` pattern and Temporal's compensation pattern:

```yaml
- id: implement
  node: implement
  on_failure: abort     # default: pipeline stops

- id: lint_fix
  node: lint_fix
  on_failure: skip      # lint fix failure is not critical

- id: scope_judge
  node: scope_judge
  on_failure: warn      # log warning, continue execution

# Global failure handler (runs when pipeline aborts)
on_pipeline_failure:
  - node: notify
    config:
      channels:
        - type: slack_thread
      template: "Pipeline failed at step {{failed_step.id}}: {{failed_step.error}}"
```

---

## 4. Default Pipeline

This is the pipeline that ships with Gooseherd out of the box. It requires zero configuration beyond what exists today (`AGENT_COMMAND_TEMPLATE`, `VALIDATION_COMMAND`, etc.) and produces the same behavior as the current `executor.ts` -- but structured as a pipeline.

```yaml
apiVersion: gooseherd/v1
kind: Pipeline
metadata:
  name: default
  description: >
    Standard pipeline: clone, implement, validate, commit, push, PR.
    Matches the current Gooseherd executor behavior.

defaults:
  timeout: 300s
  on_failure: abort

steps:
  # ---- SETUP ----
  - id: clone
    node: clone
    retry:
      max_attempts: 1
      backoff: 5s

  - id: hydrate
    node: hydrate_context
    on_failure: skip
    config:
      sources:
        - type: memory
          query_from: task

  # ---- IMPLEMENT ----
  - id: implement
    node: implement
    timeout: "{{config.agent_timeout_seconds}}s"
    config:
      command_template: "{{config.agent_command_template}}"
      follow_up_template: "{{config.agent_follow_up_template}}"
      tools: "{{config.mcp_extensions}}"

  # ---- VALIDATE ----
  - id: lint_fix_pre
    node: lint_fix
    if: "config.lint_fix_command != ''"
    on_failure: skip
    config:
      command: "{{config.lint_fix_command}}"

  - id: validate
    node: validate
    if: "config.validation_command != ''"
    config:
      command: "{{config.validation_command}}"
      error_parser:
        type: auto

  - id: validation_loop
    if: "steps.validate.outputs.passed == false"
    loop:
      max_iterations: "{{config.max_validation_rounds}}"
      sequence:
        - id: fix_val
          node: fix_validation
          timeout: "{{config.agent_timeout_seconds}}s"
          config:
            command_template: "{{config.agent_command_template}}"
            tools: "{{config.mcp_extensions}}"
        - id: lint_fix_post
          node: lint_fix
          if: "config.lint_fix_command != ''"
          on_failure: skip
          config:
            command: "{{config.lint_fix_command}}"
        - id: revalidate
          node: validate
          config:
            command: "{{config.validation_command}}"
            error_parser:
              type: auto
      until: "revalidate.outputs.passed == true"
      on_exhausted: abort

  # ---- COMMIT & PUSH ----
  - id: commit
    node: commit

  - id: push
    node: push
    if: "config.dry_run == false"
    retry:
      max_attempts: 1
      backoff: 5s

  # ---- PR ----
  - id: create_pr
    node: create_pr
    if: "config.dry_run == false"

on_pipeline_failure:
  - node: notify
    config:
      channels:
        - type: slack_thread
```

---

## 5. Full Pipeline

This pipeline uses every available node -- the gold standard for teams that want maximum quality assurance.

```yaml
apiVersion: gooseherd/v1
kind: Pipeline
metadata:
  name: full
  description: >
    Full pipeline with planning, quality gates, CI feedback,
    review app deployment, and browser verification.

defaults:
  timeout: 300s
  on_failure: abort

vars:
  max_validation_rounds: 2
  max_ci_rounds: 2

steps:
  # ==== PHASE 1: SETUP ====
  - id: clone
    node: clone
    retry:
      max_attempts: 1
      backoff: 5s

  - id: hydrate
    node: hydrate_context
    on_failure: skip
    config:
      sources:
        - type: memory
          query_from: task
        - type: repo_rules
          scan_dirs: [".cursor/rules", ".github", ".goosehints"]
        - type: ticket_links
          mcp_tool: fetch_url
        - type: file_finder
          strategy: grep_task_keywords

  # ==== PHASE 2: PLAN (optional) ====
  - id: plan
    node: plan_task
    on_failure: skip
    timeout: 120s
    config:
      tools:
        - read_only_filesystem
      system_prompt: |
        Analyze the task and produce a step-by-step plan.
        Identify target files, expected changes, and potential risks.
        Do NOT make any changes -- planning only.

  # ==== PHASE 3: IMPLEMENT ====
  - id: implement
    node: implement
    timeout: "{{config.agent_timeout_seconds}}s"
    config:
      command_template: "{{config.agent_command_template}}"
      follow_up_template: "{{config.agent_follow_up_template}}"
      tools: "{{config.mcp_extensions}}"
      task_type_prompts:
        bugfix:
          prepend: |
            PRIORITY: Identify root cause. Write reproducing test. Minimal fix.
        feature:
          prepend: |
            Follow existing patterns. Add tests. Update docs if needed.
        refactor:
          prepend: |
            ZERO behavior changes. All existing tests MUST pass.
        chore:
          prepend: |
            Strictly scoped. No features, no refactoring.

  # ==== PHASE 4: LOCAL VALIDATION ====
  - id: lint_fix
    node: lint_fix
    if: "config.lint_fix_command != ''"
    on_failure: skip
    config:
      command: "{{config.lint_fix_command}}"

  - id: run_tests
    node: run_tests
    if: "config.test_command_template != ''"
    on_failure: skip
    config:
      command_template: "{{config.test_command_template}}"
      spec_pattern: "{{config.spec_file_pattern}}"

  - id: validate
    node: validate
    if: "config.validation_command != ''"
    config:
      command: "{{config.validation_command}}"
      error_parser:
        type: auto

  - id: validation_loop
    if: "steps.validate.outputs.passed == false"
    loop:
      max_iterations: "{{vars.max_validation_rounds}}"
      sequence:
        - id: fix_val
          node: fix_validation
          timeout: "{{config.agent_timeout_seconds}}s"
          config:
            command_template: "{{config.agent_command_template}}"
            tools: "{{config.mcp_extensions}}"
        - id: lint_refix
          node: lint_fix
          if: "config.lint_fix_command != ''"
          on_failure: skip
          config:
            command: "{{config.lint_fix_command}}"
        - id: revalidate
          node: validate
          config:
            command: "{{config.validation_command}}"
            error_parser:
              type: auto
      until: "revalidate.outputs.passed == true"
      on_exhausted: abort

  # ==== PHASE 5: QUALITY GATES ====
  - id: quality_gate
    node: diff_quality_gate
    config:
      max_diff_lines: "{{config.max_diff_lines}}"
      max_changed_files: "{{config.max_changed_files}}"

  - id: scope_judge
    node: scope_judge
    if: "config.scope_judge_enabled == true"
    on_failure: warn
    config:
      max_diff_chars: 8000

  # ==== PHASE 6: COMMIT & PUSH ====
  - id: commit
    node: commit

  - id: push
    node: push
    if: "config.dry_run == false"
    retry:
      max_attempts: 1
      backoff: 5s

  # ==== PHASE 7: CI FEEDBACK LOOP ====
  - id: wait_for_ci
    node: wait_for_ci
    if: "config.dry_run == false && config.ci_feedback_enabled == true"
    config:
      mode: poll
      poll_interval_seconds: 30
      max_wait_seconds: 600

  - id: ci_loop
    if: "steps.wait_for_ci.outputs.status == 'failure'"
    loop:
      max_iterations: "{{vars.max_ci_rounds}}"
      sequence:
        - id: parse_ci
          node: parse_ci_results
          config:
            fetch_logs: true
            max_log_chars: 5000
        - id: fix_ci
          node: fix_ci
          timeout: "{{config.agent_timeout_seconds}}s"
          config:
            command_template: "{{config.agent_command_template}}"
            tools: "{{config.mcp_extensions}}"
        - id: lint_ci
          node: lint_fix
          if: "config.lint_fix_command != ''"
          on_failure: skip
          config:
            command: "{{config.lint_fix_command}}"
        - id: recommit
          node: commit
          config:
            message_template: "{{app_slug}}: fix CI (round {{loop.iteration}})"
        - id: repush
          node: push
        - id: rewait_ci
          node: wait_for_ci
          config:
            mode: poll
            poll_interval_seconds: 30
            max_wait_seconds: 600
      until: "rewait_ci.outputs.status == 'success'"
      on_exhausted: warn

  # ==== PHASE 8: REVIEW APP & BROWSER VERIFICATION ====
  - id: deploy_review
    node: deploy_review_app
    if: "config.review_app_enabled == true && config.dry_run == false"
    on_failure: skip
    config:
      trigger_command: "{{config.review_app_trigger_command}}"
      max_wait_seconds: 300

  - id: browser_verify
    node: browser_verify
    if: "ctx.reviewAppUrl != null && ctx.changedFiles | any_match('**/*.{tsx,jsx,vue,svelte,html,css}')"
    on_failure: warn
    config:
      max_interactions: 30
      tools:
        - "npx @anthropic/mcp-browser"

  # ==== PHASE 9: PR ====
  - id: create_pr
    node: create_pr
    if: "config.dry_run == false"
    config:
      labels:
        - "automated"
        - "gooseherd"

  # ==== PHASE 10: NOTIFICATION ====
  - id: notify
    node: notify
    if: always()
    on_failure: skip
    config:
      channels:
        - type: slack_thread

on_pipeline_failure:
  - node: notify
    config:
      channels:
        - type: slack_thread
      template: |
        Pipeline failed at step `{{failed_step.id}}`.
        Error: {{failed_step.error}}
        Use `@gooseherd tail` for details.
```

---

## 6. Pipeline Engine Architecture

### 6.1 Execution Model: Linear State Machine with Loop Constructs

After evaluating the options (full DAG, pure state machine, linear pipeline), the recommended approach is a **linear state machine with loop constructs**. This is the simplest model that covers all our use cases:

```
                    PIPELINE ENGINE
                    ===============

   ┌─────────────────────────────────────────────────┐
   │                  PipelineRunner                  │
   │                                                  │
   │  ┌──────────┐   ┌──────────┐   ┌──────────┐    │
   │  │  Step 1   │──>│  Step 2   │──>│  Step 3   │   │
   │  │  (clone)  │   │ (hydrate) │   │(implement)│   │
   │  └──────────┘   └──────────┘   └──────────┘    │
   │        │               │              │          │
   │        ▼               ▼              ▼          │
   │  ┌─────────────────────────────────────────┐    │
   │  │          CONTEXT BAG (shared state)      │    │
   │  │  repoDir, changedFiles, ciResult, ...    │    │
   │  └─────────────────────────────────────────┘    │
   │                                                  │
   │  ┌──────────────────────────────────────────┐   │
   │  │          STEP EXECUTOR (per node type)    │   │
   │  │                                           │   │
   │  │  DeterministicExecutor  — shell commands  │   │
   │  │  AgenticExecutor        — agent invocation│   │
   │  │  ConditionalExecutor    — expression eval │   │
   │  │  AsyncExecutor          — poll/webhook    │   │
   │  └──────────────────────────────────────────┘   │
   │                                                  │
   │  ┌──────────────────────────────────────────┐   │
   │  │          LOOP CONTROLLER                  │   │
   │  │                                           │   │
   │  │  Manages validate->fix->validate cycles   │   │
   │  │  Tracks iteration count, exit conditions  │   │
   │  └──────────────────────────────────────────┘   │
   │                                                  │
   │  ┌──────────────────────────────────────────┐   │
   │  │          STATE PERSISTER                  │   │
   │  │                                           │   │
   │  │  Checkpoints context bag after each step  │   │
   │  │  Enables resume after crash/restart       │   │
   │  └──────────────────────────────────────────┘   │
   └─────────────────────────────────────────────────┘
```

**Why not a full DAG?** Most agent runs are linear. Adding DAG scheduling complexity (topological sort, parallel branch merging, fan-out/fan-in) for a pipeline that is sequential 95% of the time adds unnecessary complexity. The loop construct handles the only non-linear pattern we need (validate->fix cycles).

**Why not a pure state machine?** A full state machine with arbitrary transitions makes pipelines harder to reason about and visualize. The linear + loop model is strictly less powerful but covers all Stripe Blueprint patterns while being much simpler to implement and debug.

### 6.2 Core Types

```typescript
// Pipeline configuration (parsed from YAML)
interface PipelineConfig {
  apiVersion: string;
  kind: 'Pipeline';
  metadata: {
    name: string;
    description: string;
  };
  defaults: StepDefaults;
  vars: Record<string, string>;
  steps: StepConfig[];
  on_pipeline_failure?: StepConfig[];
}

interface StepConfig {
  id: string;
  node: NodeType;
  if?: string;                    // Conditional expression
  config?: Record<string, any>;   // Node-specific configuration
  timeout?: string;               // Override default timeout
  retry?: RetryPolicy;
  on_failure?: 'abort' | 'skip' | 'warn';
  loop?: LoopConfig;
}

interface LoopConfig {
  max_iterations: number;
  sequence: StepConfig[];
  until: string;                  // Expression that must be true to exit
  on_exhausted: 'abort' | 'skip' | 'warn';
}

interface RetryPolicy {
  max_attempts: number;
  backoff: string;                // Duration string: "5s", "30s", etc.
  retry_on?: string[];            // Conditions: "exit_code_nonzero", "timeout"
}

interface StepDefaults {
  timeout: string;
  retry: RetryPolicy;
  on_failure: 'abort' | 'skip' | 'warn';
}

// Node type registry
type NodeType =
  | 'clone' | 'hydrate_context' | 'plan_task' | 'implement'
  | 'lint_fix' | 'run_tests' | 'validate' | 'fix_validation'
  | 'diff_quality_gate' | 'scope_judge' | 'commit' | 'push'
  | 'wait_for_ci' | 'parse_ci_results' | 'fix_ci'
  | 'deploy_review_app' | 'browser_verify' | 'create_pr' | 'notify';

// Each node implements this interface
interface PipelineNode<TConfig = Record<string, any>> {
  readonly type: NodeType;
  readonly category: 'deterministic' | 'agentic' | 'conditional' | 'async';

  execute(
    ctx: PipelineContext,
    config: TConfig,
    logger: StepLogger
  ): Promise<StepResult>;
}

interface StepResult {
  status: 'success' | 'failure' | 'skipped';
  outputs: Record<string, any>;    // Written to context bag
  error?: string;
  duration_ms: number;
}

// Step execution log entry
interface StepLogEntry {
  step_id: string;
  node: NodeType;
  status: StepResult['status'];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  outputs_keys: string[];
  error?: string;
  loop_iteration?: number;
}
```

### 6.3 Execution Flow

```
1. LOAD pipeline YAML
2. VALIDATE pipeline config (schema check, node type check, expression syntax check)
3. INITIALIZE context bag with { run, config, pipeline }
4. FOR each step in pipeline.steps:
   a. EVALUATE step.if expression against context bag
      - If false: mark step as "skipped", continue to next step
   b. RESOLVE step.config templates (replace {{...}} with context values)
   c. IF step has loop:
      - Execute loop controller (see 6.4)
   d. ELSE:
      - EXECUTE node with retry policy
      - On success: merge outputs into context bag, log step, continue
      - On failure:
        - If on_failure == "abort": run on_pipeline_failure handlers, abort
        - If on_failure == "skip": log warning, mark skipped, continue
        - If on_failure == "warn": log warning, mark warned, continue
   e. CHECKPOINT context bag to disk (enables resume)
5. RETURN final pipeline result (success/failure + context bag)
```

### 6.4 Loop Controller

The loop controller handles validate->fix->validate cycles and CI fix loops:

```
LOOP_CONTROLLER(loop_config, ctx):
  FOR iteration = 1 TO loop_config.max_iterations:
    FOR each step in loop_config.sequence:
      EVALUATE step.if against ctx
      IF false: skip step, continue
      EXECUTE step (same as main pipeline step execution)
      IF step fails and step.on_failure == "abort":
        EXIT loop with failure
      MERGE step outputs into ctx
    END FOR

    EVALUATE loop_config.until expression against ctx
    IF true: EXIT loop with success
  END FOR

  // All iterations exhausted without until-condition becoming true
  HANDLE loop_config.on_exhausted:
    "abort" -> pipeline aborts
    "skip"  -> continue pipeline, log warning
    "warn"  -> continue pipeline, log warning
```

### 6.5 Async Node Handling (Waiting for CI)

Async nodes use a suspend/resume pattern inspired by Temporal's Signals:

**Poll mode** (initial implementation):

```typescript
class AsyncPollExecutor {
  async execute(ctx: PipelineContext, config: WaitForCIConfig): Promise<StepResult> {
    const deadline = Date.now() + config.max_wait_seconds * 1000;

    while (Date.now() < deadline) {
      const checkStatus = await this.pollCheckSuites(ctx.run.repoSlug, ctx.commitSha);

      if (checkStatus.allComplete) {
        return {
          status: 'success',
          outputs: { ciResult: checkStatus },
          duration_ms: Date.now() - startTime
        };
      }

      // Checkpoint current state before sleeping
      await this.checkpointState(ctx, { pollIteration: iteration });

      await sleep(config.poll_interval_seconds * 1000);
    }

    return {
      status: 'success',  // timeout is a valid result, not an error
      outputs: { ciResult: { status: 'timeout' } },
      duration_ms: Date.now() - startTime
    };
  }
}
```

**Webhook mode** (future enhancement):

```typescript
class AsyncWebhookExecutor {
  async execute(ctx: PipelineContext, config: WaitForCIConfig): Promise<StepResult> {
    // 1. Register this run's callback with the webhook handler
    const callbackId = await this.webhookRegistry.register({
      runId: ctx.run.id,
      stepId: this.stepId,
      event: 'check_suite.completed',
      filter: { sha: ctx.commitSha }
    });

    // 2. Persist pipeline state to disk (full context bag + current step position)
    await this.persistPipelineState(ctx);

    // 3. SUSPEND execution -- the pipeline runner exits
    //    The webhook handler will RESUME the pipeline when the event arrives
    return { status: 'suspended', callbackId };
  }
}

// In the webhook HTTP handler:
app.post('/webhooks/github', async (req, res) => {
  const event = parseGitHubWebhookEvent(req);
  const registration = await webhookRegistry.findMatch(event);

  if (registration) {
    // Resume the suspended pipeline
    const savedState = await loadPipelineState(registration.runId);
    const result = convertWebhookToStepResult(event);
    pipelineRunner.resume(savedState, registration.stepId, result);
  }
});
```

### 6.6 Resume After Crash/Restart

Every step completion checkpoints the full context bag to disk:

```typescript
interface PipelineCheckpoint {
  runId: string;
  pipelineName: string;
  completedSteps: StepLogEntry[];
  currentStepIndex: number;
  contextBag: PipelineContext;
  savedAt: string;
}
```

On startup, the engine checks for incomplete checkpoints:

```
1. SCAN checkpoint directory for files matching running runs
2. FOR each checkpoint:
   a. LOAD context bag from checkpoint
   b. IDENTIFY the step that was in progress when crash occurred
   c. RE-EXECUTE from that step (the step is idempotent or restartable)
   d. CONTINUE pipeline from that point
```

This mirrors Temporal's durable execution model where workflows resume from the last completed step after a crash.

### 6.7 Timeout Handling

Three levels of timeout:

1. **Step-level timeout**: Each step has a `timeout` field. When exceeded, the step's subprocess is killed (SIGTERM, then SIGKILL after 5s grace period). The step result is `{ status: 'failure', error: 'timeout' }`.

2. **Loop-level timeout**: Not explicit -- the loop exits when `max_iterations` is reached. Each iteration's steps have their own timeouts.

3. **Pipeline-level timeout**: Optional `metadata.max_duration` field. If the entire pipeline exceeds this, all running steps are killed and the pipeline aborts.

### 6.8 Expression Evaluator

The `if` expressions and template interpolation require a lightweight expression evaluator. This should NOT be a full JavaScript `eval()` for security reasons.

Supported operations:

```
# Comparison
steps.validate.outputs.passed == true
config.dry_run == false
ctx.changedFiles.length > 0

# String comparison
config.lint_fix_command != ''

# Null checks
ctx.reviewAppUrl != null

# Status functions
always()                                    # always true
success()                                   # all prior steps succeeded
failure()                                   # any prior step failed

# Pipe functions (for filtering)
ctx.changedFiles | any_match('**/*.tsx')     # glob match any file in list
ctx.changedFiles | count > 5                # count items in array

# Logical operators
config.ci_enabled == true && steps.push.status == 'success'
config.dry_run == true || config.skip_push == true

# Template interpolation (in config values)
{{config.agent_timeout_seconds}}
{{ctx.repoDir}}
{{loop.iteration}}
{{vars.max_ci_rounds}}
```

Implementation: A small recursive-descent parser that evaluates against the context bag. Libraries like `expr-eval` or `filtrex` provide this out of the box for JavaScript.

---

## 7. Real-World Pipeline Examples

### 7.1 Startup with Jest + Vercel Previews

**Scenario**: Small JS/TS repo (Next.js), Jest tests, Vercel preview deployments on every push, team of 5-10 engineers.

```yaml
apiVersion: gooseherd/v1
kind: Pipeline
metadata:
  name: startup-nextjs
  description: JS/TS repo with Jest tests and Vercel preview deployments

vars:
  max_validation_rounds: 2
  max_ci_rounds: 1

steps:
  - id: clone
    node: clone
    retry:
      max_attempts: 1
      backoff: 5s

  - id: hydrate
    node: hydrate_context
    on_failure: skip
    config:
      sources:
        - type: memory
          query_from: task
        - type: repo_rules
          scan_dirs: [".cursor/rules"]

  - id: implement
    node: implement
    timeout: 900s
    config:
      command_template: >
        goose run --with-extension "npx @anthropic/cems-mcp"
        -i {{prompt_file}} -d {{repo_dir}}
      task_type_prompts:
        bugfix:
          prepend: "Write a failing Jest test first, then fix the bug."
        feature:
          prepend: "Follow Next.js App Router patterns. Use server components by default."

  # Jest has excellent auto-fix for snapshots
  - id: lint_fix
    node: lint_fix
    on_failure: skip
    config:
      command: "cd {{repo_dir}} && npx eslint --fix . && npx prettier --write ."

  # Run only changed test files (Jest --findRelatedTests is perfect here)
  - id: run_tests
    node: run_tests
    on_failure: skip
    config:
      command_template: "cd {{repo_dir}} && npx jest --findRelatedTests {{changed_files}} --passWithNoTests"

  - id: validate
    node: validate
    config:
      command: "cd {{repo_dir}} && npm run build && npx tsc --noEmit && npx jest --ci"
      error_parser:
        type: structured
        parsers:
          - format: typescript
          - format: jest
          - format: eslint

  - id: validation_loop
    if: "steps.validate.outputs.passed == false"
    loop:
      max_iterations: "{{vars.max_validation_rounds}}"
      sequence:
        - id: fix_val
          node: fix_validation
          timeout: 900s
        - id: lint_refix
          node: lint_fix
          on_failure: skip
          config:
            command: "cd {{repo_dir}} && npx eslint --fix . && npx prettier --write ."
        - id: revalidate
          node: validate
          config:
            command: "cd {{repo_dir}} && npm run build && npx tsc --noEmit && npx jest --ci"
      until: "revalidate.outputs.passed == true"
      on_exhausted: abort

  - id: quality_gate
    node: diff_quality_gate
    config:
      max_diff_lines: 500
      max_changed_files: 15

  - id: commit
    node: commit

  - id: push
    node: push
    if: "config.dry_run == false"

  # Vercel auto-deploys on push -- just wait for the deployment
  - id: wait_for_ci
    node: wait_for_ci
    if: "config.dry_run == false"
    config:
      mode: poll
      poll_interval_seconds: 20
      max_wait_seconds: 300
      # Vercel creates a deployment check; Jest CI runs separately
      required_checks: ["Vercel", "test"]

  # If CI fails, one fix attempt (startup = fast CI, cheap to retry)
  - id: ci_loop
    if: "steps.wait_for_ci.outputs.status == 'failure'"
    loop:
      max_iterations: "{{vars.max_ci_rounds}}"
      sequence:
        - id: parse_ci
          node: parse_ci_results
        - id: fix_ci
          node: fix_ci
          timeout: 600s
        - id: recommit
          node: commit
          config:
            message_template: "gooseherd: fix CI"
        - id: repush
          node: push
        - id: rewait
          node: wait_for_ci
          config:
            mode: poll
            poll_interval_seconds: 20
            max_wait_seconds: 300
      until: "rewait.outputs.status == 'success'"
      on_exhausted: warn

  # Browser verify against Vercel preview (only for view changes)
  - id: browser_verify
    node: browser_verify
    if: "ctx.reviewAppUrl != null && ctx.changedFiles | any_match('**/*.{tsx,jsx,css}')"
    on_failure: warn
    timeout: 180s
    config:
      max_interactions: 20
      tools:
        - "npx @anthropic/mcp-browser"
      system_prompt: |
        Navigate to the Vercel preview URL. Check that:
        1. The page loads without errors
        2. The changed components render correctly
        3. No console errors appear
        Report PASS or FAIL with screenshots.

  - id: create_pr
    node: create_pr
    if: "config.dry_run == false"
    config:
      labels: ["automated", "gooseherd"]

  - id: notify
    node: notify
    if: always()
    on_failure: skip
```

---

### 7.2 Enterprise Rails with RSpec + Review Apps

**Scenario**: Large Rails monolith (500K+ LOC), 30 parallel RSpec workers in CI, review apps on AWS ECS, strict code review process, team of 50+ engineers.

```yaml
apiVersion: gooseherd/v1
kind: Pipeline
metadata:
  name: enterprise-rails
  description: Large Rails app with RSpec, review apps on AWS, and strict quality gates

vars:
  max_validation_rounds: 2
  max_ci_rounds: 2

steps:
  - id: clone
    node: clone
    config:
      depth: 1    # Shallow clone -- large repo, save time
    retry:
      max_attempts: 1
      backoff: 10s

  - id: hydrate
    node: hydrate_context
    on_failure: skip
    timeout: 45s
    config:
      sources:
        - type: memory
          query_from: task
        - type: repo_rules
          scan_dirs: [".cursor/rules", "doc/agent_rules"]
        - type: ticket_links
          mcp_tool: fetch_url
        - type: file_finder
          strategy: grep_task_keywords

  # Planning is valuable for large repos -- helps the agent scope correctly
  - id: plan
    node: plan_task
    on_failure: skip
    timeout: 120s
    config:
      system_prompt: |
        This is a large Rails monolith. Before implementing:
        1. Identify which models, controllers, and services are involved.
        2. Check for existing patterns in similar features.
        3. Note any database migration requirements.
        4. Identify which spec files need updates.

  - id: implement
    node: implement
    timeout: 1200s    # 20 minutes -- large repo needs more time
    config:
      command_template: >
        goose run
        --with-extension "npx @anthropic/cems-mcp"
        --with-extension "npx @github/mcp-server"
        -i {{prompt_file}} -d {{repo_dir}}
      task_type_prompts:
        bugfix:
          prepend: |
            Write a failing RSpec example first. Use FactoryBot for test data.
            Check for N+1 queries with Bullet gem.
        feature:
          prepend: |
            Follow Rails conventions: thin controllers, fat models, service objects
            for complex logic. Use Strong Parameters. Add request specs.
        refactor:
          prepend: |
            ZERO behavior changes. Run full RSpec suite to confirm.
            If touching ActiveRecord models, check for missing indexes.

  # RuboCop auto-fix is safe and fast
  - id: lint_fix
    node: lint_fix
    on_failure: skip
    config:
      command: "cd {{repo_dir}} && bundle exec rubocop -A --fail-level error"

  # Run only the spec files related to changed files
  - id: run_tests
    node: run_tests
    on_failure: skip
    timeout: 180s
    config:
      command_template: "cd {{repo_dir}} && bundle exec rspec {{changed_spec_files}} --format progress"
      spec_pattern: "s|app/(.*)\\.rb|spec/\\1_spec.rb|"

  - id: validate
    node: validate
    timeout: 300s
    config:
      command: "cd {{repo_dir}} && bundle exec rubocop && bundle exec rspec --format progress"
      error_parser:
        type: structured
        parsers:
          - format: rubocop
          - format: rspec
        max_errors_per_category: 10

  - id: validation_loop
    if: "steps.validate.outputs.passed == false"
    loop:
      max_iterations: "{{vars.max_validation_rounds}}"
      sequence:
        - id: fix_val
          node: fix_validation
          timeout: 1200s
        - id: lint_refix
          node: lint_fix
          on_failure: skip
          config:
            command: "cd {{repo_dir}} && bundle exec rubocop -A --fail-level error"
        - id: revalidate
          node: validate
          timeout: 300s
          config:
            command: "cd {{repo_dir}} && bundle exec rubocop && bundle exec rspec --format progress"
      until: "revalidate.outputs.passed == true"
      on_exhausted: abort

  # Strict quality gates for enterprise
  - id: quality_gate
    node: diff_quality_gate
    config:
      max_diff_lines: 800
      max_changed_files: 20

  - id: scope_judge
    node: scope_judge
    on_failure: warn
    config:
      max_diff_chars: 10000

  - id: commit
    node: commit

  - id: push
    node: push
    if: "config.dry_run == false"

  # Enterprise CI is slow (30 parallel workers, 15-20 min)
  - id: wait_for_ci
    node: wait_for_ci
    if: "config.dry_run == false"
    config:
      mode: poll
      poll_interval_seconds: 60
      max_wait_seconds: 1200     # 20 minutes for slow CI
      ignore_checks: ["codecov/project", "codecov/patch"]

  - id: ci_loop
    if: "steps.wait_for_ci.outputs.status == 'failure'"
    loop:
      max_iterations: "{{vars.max_ci_rounds}}"
      sequence:
        - id: parse_ci
          node: parse_ci_results
          config:
            fetch_logs: true
            max_log_chars: 8000
        - id: fix_ci
          node: fix_ci
          timeout: 1200s
        - id: lint_ci
          node: lint_fix
          on_failure: skip
          config:
            command: "cd {{repo_dir}} && bundle exec rubocop -A --fail-level error"
        - id: recommit
          node: commit
          config:
            message_template: "gooseherd: fix CI (round {{loop.iteration}})"
        - id: repush
          node: push
        - id: rewait
          node: wait_for_ci
          config:
            mode: poll
            poll_interval_seconds: 60
            max_wait_seconds: 1200
      until: "rewait.outputs.status == 'success'"
      on_exhausted: warn

  # AWS ECS review app deployment
  - id: deploy_review
    node: deploy_review_app
    if: "config.dry_run == false"
    on_failure: skip
    config:
      trigger_command: "aws ecs create-service --cluster review-apps --service {{run.branchName}} ..."
      mode: poll
      poll_url_template: "https://{{run.branchName}}.review.company.com/health"
      max_wait_seconds: 300

  - id: browser_verify
    node: browser_verify
    if: "ctx.reviewAppUrl != null && ctx.changedFiles | any_match('app/views/**')"
    on_failure: warn
    timeout: 240s
    config:
      max_interactions: 30
      system_prompt: |
        Navigate to the review app. Verify:
        1. The changed views render correctly
        2. Forms submit without errors
        3. Flash messages appear as expected
        4. No broken layouts or missing assets

  - id: create_pr
    node: create_pr
    if: "config.dry_run == false"
    config:
      labels: ["automated", "gooseherd", "needs-review"]
      reviewers: ["@platform-team"]
      draft: true     # Enterprise: always create as draft for human review

  - id: notify
    node: notify
    if: always()
    on_failure: skip
    config:
      channels:
        - type: slack_thread
        - type: slack_channel
          channel: "#eng-automated-prs"
```

---

### 7.3 Python ML Team with pytest

**Scenario**: Python repo (ML team), pytest suite with fixtures, no browser testing needed, focus on notebook compatibility and data pipeline correctness, team of 8-12 data scientists/ML engineers.

```yaml
apiVersion: gooseherd/v1
kind: Pipeline
metadata:
  name: python-ml
  description: Python ML repo with pytest, no browser testing

vars:
  max_validation_rounds: 2

steps:
  - id: clone
    node: clone
    retry:
      max_attempts: 1
      backoff: 5s

  - id: hydrate
    node: hydrate_context
    on_failure: skip
    config:
      sources:
        - type: memory
          query_from: task
        - type: repo_rules
          scan_dirs: [".cursor/rules"]

  - id: implement
    node: implement
    timeout: 900s
    config:
      command_template: >
        goose run
        --with-extension "npx @anthropic/cems-mcp"
        -i {{prompt_file}} -d {{repo_dir}}
      task_type_prompts:
        bugfix:
          prepend: |
            Write a failing pytest test first. Use conftest.py fixtures.
            Check for numpy dtype mismatches and shape errors.
        feature:
          prepend: |
            Follow existing module patterns. Add type hints (PEP 484).
            Use numpy docstring format for public functions.
            Add pytest parametrize for edge cases.
        refactor:
          prepend: |
            ZERO behavior changes. Verify numerical stability is preserved.
            Run pytest with --tb=short to confirm all tests pass.

  # Python auto-formatters: black + isort + ruff
  - id: lint_fix
    node: lint_fix
    on_failure: skip
    config:
      command: "cd {{repo_dir}} && ruff check --fix . && ruff format . && isort ."

  # Run only changed test files
  - id: run_tests
    node: run_tests
    on_failure: skip
    timeout: 180s
    config:
      command_template: "cd {{repo_dir}} && python -m pytest {{changed_spec_files}} -x --tb=short"
      spec_pattern: "s|src/(.*)\\.py|tests/test_\\1.py|"

  - id: validate
    node: validate
    timeout: 300s
    config:
      command: >
        cd {{repo_dir}} &&
        ruff check . &&
        python -m mypy src/ --ignore-missing-imports &&
        python -m pytest --tb=short -q
      error_parser:
        type: structured
        parsers:
          - format: pytest
          - format: generic   # catches mypy and ruff errors via file:line pattern

  - id: validation_loop
    if: "steps.validate.outputs.passed == false"
    loop:
      max_iterations: "{{vars.max_validation_rounds}}"
      sequence:
        - id: fix_val
          node: fix_validation
          timeout: 900s
        - id: lint_refix
          node: lint_fix
          on_failure: skip
          config:
            command: "cd {{repo_dir}} && ruff check --fix . && ruff format . && isort ."
        - id: revalidate
          node: validate
          timeout: 300s
          config:
            command: >
              cd {{repo_dir}} &&
              ruff check . &&
              python -m mypy src/ --ignore-missing-imports &&
              python -m pytest --tb=short -q
      until: "revalidate.outputs.passed == true"
      on_exhausted: abort

  - id: quality_gate
    node: diff_quality_gate
    config:
      max_diff_lines: 400
      max_changed_files: 12

  - id: commit
    node: commit

  - id: push
    node: push
    if: "config.dry_run == false"

  # Simple CI wait -- pytest in CI is usually fast for ML repos
  - id: wait_for_ci
    node: wait_for_ci
    if: "config.dry_run == false && config.ci_feedback_enabled == true"
    config:
      mode: poll
      poll_interval_seconds: 20
      max_wait_seconds: 300
      ignore_checks: ["codecov/project"]

  - id: create_pr
    node: create_pr
    if: "config.dry_run == false"
    config:
      labels: ["automated", "gooseherd"]

  - id: notify
    node: notify
    if: always()
    on_failure: skip
```

---

## 8. Migration Path from Current Executor

### 8.1 Phased Approach

The migration from the current `executor.ts` to the pipeline engine should be **incremental and backward-compatible**:

**Phase 0: Extract node implementations from executor.ts (no behavior change)**

The current `executor.ts` already contains the logic for most nodes -- it just needs to be extracted into standalone functions:

| Current executor.ts code | Becomes node |
|--------------------------|-------------|
| Lines 187-292 (clone + branch logic) | `CloneNode` |
| Lines 193-226 (.goosehints + prompt) | `HydrateContextNode` (partial) |
| Lines 303-321 (agent invocation) | `ImplementNode` |
| Lines 335-342 (lint fix command) | `LintFixNode` |
| Lines 348-399 (validation loop) | `ValidateNode` + `FixValidationNode` + loop controller |
| Lines 402-439 (diff check + commit) | `DiffQualityGateNode` + `CommitNode` |
| Lines 454-460 (push) | `PushNode` |
| Lines 462-480 (PR creation) | `CreatePRNode` |

**Phase 1: Build the pipeline engine alongside the existing executor**

- Implement `PipelineRunner`, `PipelineContext`, expression evaluator, YAML parser
- Implement each node type as a class implementing `PipelineNode`
- Write the default pipeline YAML that replicates exact current behavior
- Add a config flag: `PIPELINE_ENGINE_ENABLED=false` (default off)
- When enabled, `RunManager` calls `PipelineRunner.execute()` instead of `RunExecutor.execute()`
- Run both in parallel during testing to validate identical behavior

**Phase 2: Add new capabilities only available in pipeline mode**

- `wait_for_ci` node (CI feedback loop)
- `scope_judge` node (LLM-as-judge)
- `deploy_review_app` + `browser_verify` nodes
- Structured error parser for `fix_validation`
- Task-type prompt routing

**Phase 3: Make pipeline engine the default, deprecate RunExecutor**

- Set `PIPELINE_ENGINE_ENABLED=true` by default
- Allow `PIPELINE_CONFIG` env var to point to a custom pipeline YAML
- Remove `RunExecutor` class

### 8.2 Backward Compatibility

All existing environment variables (`AGENT_COMMAND_TEMPLATE`, `VALIDATION_COMMAND`, `LINT_FIX_COMMAND`, `MAX_VALIDATION_ROUNDS`, etc.) continue to work. They are injected into the pipeline context as `config.*` values and referenced by the default pipeline YAML via `{{config.*}}` templates.

New features are gated behind new config flags:
- `CI_FEEDBACK_ENABLED` (default: false)
- `SCOPE_JUDGE_ENABLED` (default: false)
- `REVIEW_APP_ENABLED` (default: false)
- `PIPELINE_CONFIG` (path to custom YAML, default: uses built-in default pipeline)
- `MAX_DIFF_LINES` (default: 0 = disabled)
- `MAX_CHANGED_FILES` (default: 0 = disabled)

---

## 9. Research Sources

### Stripe Minions (Blueprint Pattern)
- [Stripe Dev Blog - Minions Part 1](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) -- overview of agent architecture, devbox provisioning, context gathering
- [Stripe Dev Blog - Minions Part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2) -- Blueprint state machine architecture, deterministic vs agentic nodes, CI feedback loop, tool curation
- [Stripe's coding agents: the walls matter more than the model](https://www.anup.io/stripes-coding-agents-the-walls-matter-more-than-the-model/) -- analysis of Stripe's reliability-first architecture

### Temporal.io (Durable Workflow Execution)
- [Temporal: Durable Execution That Survives the Apocalypse](https://james-carr.org/posts/2026-01-29-temporal-workflow-orchestration/) -- overview of durable execution patterns, webhook delivery, crash recovery
- [Temporal GitHub - SDK Python](https://github.com/temporalio/sdk-python) -- Signal pattern for async waiting
- [Agentic AI Workflows: Why Orchestration with Temporal is Key](https://intuitionlabs.ai/articles/agentic-ai-temporal-orchestration) -- applying Temporal to AI agent workflows

### Inngest (Durable Step Functions)
- [Inngest - Steps & Workflows](https://www.inngest.com/docs/features/inngest-functions/steps-workflows) -- step-based workflow definition, data flow between steps
- [Inngest - Durable Workflows](https://www.inngest.com/uses/durable-workflows) -- memoized execution, automatic retries, waitForEvent pattern
- [Inngest - How Functions Are Executed](https://www.inngest.com/docs/learn/how-functions-are-executed) -- durable execution engine internals

### GitHub Actions (Workflow YAML Syntax)
- [GitHub Actions Workflow Syntax](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions) -- `needs`, `outputs`, `if` expressions, status check functions
- [Using Conditions to Control Job Execution](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution) -- `success()`, `failure()`, `always()` patterns
- [How to Use Conditional Steps in GitHub Actions](https://oneuptime.com/blog/post/2025-12-20-conditional-steps-github-actions/view) -- practical conditional patterns

### Airflow / Prefect (DAG Pipeline Configuration)
- [Apache Airflow vs. Prefect: A 2025 Comparison](https://www.sql-datatools.com/2025/10/apache-airflow-vs-prefect-2025.html) -- DAG model comparison, task dependencies, trigger rules
- [Orchestration Showdown: Dagster vs Prefect vs Airflow](https://www.zenml.io/blog/orchestration-showdown-dagster-vs-prefect-vs-airflow) -- benchmark comparison, architectural tradeoffs
- [Decoding Data Orchestration Tools](https://engineering.freeagent.com/2025/05/29/decoding-data-orchestration-tools-comparing-prefect-dagster-airflow-and-mage/) -- practical comparison for production use

### AI Agent Orchestration Patterns
- [Microsoft: AI Agent Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) -- state machine, sequential pipeline, hierarchical patterns
- [The 2026 Guide to Agentic Workflow Architectures](https://www.stack-ai.com/blog/the-2026-guide-to-agentic-workflow-architectures) -- hybrid workflow patterns, Plan-and-Execute
- [20 Agentic AI Workflow Patterns That Actually Work in 2025](https://skywork.ai/blog/agentic-ai-examples-workflow-patterns-2025/) -- practical patterns for production agents
