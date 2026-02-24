# Observer System: Proactive Alert Monitoring for Gooseherd

Date: 2026-02-20
Scope: Architecture research and design for a system that watches external alert sources and auto-triggers Gooseherd agent runs to investigate and fix issues.

---

## 1. Problem Statement

Today, Gooseherd is purely reactive: a human types `@gooseherd run owner/repo | fix the broken spec` in Slack. The agent only acts when explicitly told.

The vision: **what if Gooseherd could watch for problems on its own and start fixing them before a human even notices?**

Motivating example: An engineer set a Time Off accrual rate to 999 hours per 1 hour worked, which prevented team payment finalization. Sentry caught the error. If Gooseherd had been watching Sentry, it could have:

1. Seen the Sentry alert about the accrual validation failure
2. Pulled the stack trace and error context from Sentry
3. Identified the affected repo and code path
4. Auto-triggered a Goose run with a task like: "Add validation to prevent accrual rates above a reasonable threshold (e.g., 24h per 1h worked). The current lack of validation caused payment finalization failures. See Sentry issue PROJ-1234 for stack trace."
5. Opened a PR with the fix

---

## 2. Current Gooseherd Architecture (Relevant Parts)

### 2.1 How Runs Are Triggered Today

All runs flow through `RunManager.enqueueRun()` which accepts a `NewRunInput`:

```typescript
// src/types.ts
interface NewRunInput {
  repoSlug: string;      // e.g., "hubstaff/hubstaff-server"
  task: string;           // free-text task description
  baseBranch: string;     // e.g., "main"
  requestedBy: string;    // Slack user ID or "local-trigger"
  channelId: string;      // Slack channel for status updates
  threadTs: string;       // Slack thread timestamp
  parentRunId?: string;   // for follow-up runs
  feedbackNote?: string;  // engineer's follow-up instruction
}
```

There are currently three entry points:

| Entry Point | File | How It Works |
|-------------|------|-------------|
| Slack `app_mention` | `src/slack-app.ts` | Human @-mentions the bot with `run owner/repo \| task` |
| Local trigger CLI | `src/local-trigger.ts` | `npm run local:trigger -- owner/repo "task"` |
| Dashboard retry/continue | `src/dashboard-server.ts` | POST to `/api/runs/:id/retry` or `/continue` |

Key observation: **`NewRunInput` requires `channelId` and `threadTs`** because the RunManager posts status updates to Slack. An observer-triggered run would need either:
- A dedicated Slack channel for observer alerts (recommended), or
- Synthetic channel/thread values with a separate notification path.

### 2.2 Slack Integration

Gooseherd uses `@slack/bolt` in **Socket Mode** (WebSocket, no inbound HTTP needed). The app currently only listens for `app_mention` events and action button callbacks. It does NOT listen for general channel messages.

Relevant Slack Bolt capabilities already available:
- `app.event("message", ...)` -- can listen to all messages in channels where the bot is a member
- `app.event("app_mention", ...)` -- currently used
- Bot can be added to any channel to passively observe messages

### 2.3 Run Execution Pipeline

The executor (`src/executor.ts`) follows this pipeline:
```
clone repo -> write prompt -> run Goose agent -> validate -> push -> open PR
```

The prompt is built by `buildPromptSections()` which assembles:
- Run metadata (ID, repo, base branch)
- Hook-injected memory sections (from CEMS)
- Parent context (for follow-ups)
- Task description

This prompt builder is the natural injection point for alert context (stack traces, error details, affected code paths).

### 2.4 Lifecycle Hooks

The `RunLifecycleHooks` class (`src/hooks/run-lifecycle.ts`) already provides:
- `onPromptEnrich(run)` -- injects CEMS memories into the prompt
- `onRunComplete(run, result)` -- stores completion data
- `onFeedback(run, rating, note)` -- stores feedback corrections

This hook system is extensible. The observer could use similar patterns.

---

## 3. Observer System Architecture

### 3.1 High-Level Design

```
                                         +---------------------+
                                         |   Sentry REST API   |
                                         +----------+----------+
                                                    |
+-------------------+    +-----------+    +---------v---------+    +-----------------+
|  Slack Channel    |--->|           |    |                   |    |                 |
|  (alert messages) |    | Observer  |--->| Alert Classifier  |--->| Run Composer    |
+-------------------+    | Daemon    |    | & Deduplicator    |    | (builds prompt  |
                         |           |    |                   |    |  + NewRunInput) |
+-------------------+    | (cron /   |    +-------------------+    +--------+--------+
|  GitHub Actions   |--->| heartbeat)|                                      |
|  (CI failures,    |    |           |                                      v
|   dependabot)     |    +-----------+                             +--------+--------+
+-------------------+                                              |  RunManager     |
                                                                   |  .enqueueRun()  |
+-------------------+                                              +---------+-------+
|  Webhook Endpoint |-----> (optional: direct push from Sentry)              |
|  (future)         |                                                        v
+-------------------+                                              +--------+--------+
                                                                   |  Normal Goose   |
                                                                   |  execution      |
                                                                   |  pipeline       |
                                                                   +-----------------+
```

### 3.2 Core Decision: Same Process vs Separate Service

**Recommendation: Same process, separate module.**

Reasons:
- The observer needs direct access to `RunManager.enqueueRun()` and the Slack `WebClient`
- Gooseherd is already a single-process Node.js app with several subsystems (Slack, dashboard, workspace cleaner)
- Adding a cron-based observer is architecturally identical to `WorkspaceCleaner` (which already runs on `setInterval`)
- No need for inter-process communication, shared state, or service discovery
- Docker compose stays simple (one container)

The observer would be instantiated in `src/index.ts` alongside the other subsystems:

```typescript
// In src/index.ts (conceptual)
const observer = new ObserverDaemon(config, runManager, webClient);
observer.start();
```

### 3.3 Module Structure

```
src/
  observer/
    daemon.ts              # Main loop: setInterval heartbeat
    sources/
      slack-channel.ts     # Watches Slack channels for alert messages
      sentry-api.ts        # Polls Sentry REST API for new issues
      github-ci.ts         # Polls GitHub for failed CI runs
    classifier.ts          # Determines if an alert is actionable
    deduplicator.ts        # Prevents duplicate runs for the same alert
    run-composer.ts        # Builds NewRunInput with enriched context
    types.ts               # AlertEvent, ObserverConfig, etc.
```

---

## 4. Alert Sources

### 4.1 Slack Channel Monitoring

**How it works:** The Slack bot joins designated "alert" channels (e.g., `#sentry-alerts`, `#deploy-alerts`, `#pagerduty`). It passively reads messages from integration bots.

**Implementation:**

The existing Slack Bolt app can listen for `message` events on any channel where the bot is a member. This requires the `channels:history` (public channels) and/or `groups:history` (private channels) OAuth scopes, plus `channels:read` to list channels.

```typescript
// Conceptual: in slack-app.ts or a separate observer slack listener
app.event("message", async ({ event, client }) => {
  // Only process messages in observer-watched channels
  if (!isObserverChannel(event.channel)) return;

  // Only process messages from known bot integrations
  if (!isAlertBot(event.bot_id, event.username)) return;

  // Parse the alert content
  const alert = parseAlertMessage(event);
  if (alert) {
    observer.handleAlert(alert);
  }
});
```

**Identifying alert bots:** Slack messages from integrations like Sentry, PagerDuty, and Datadog include identifying fields:

| Field | How to Use |
|-------|-----------|
| `event.bot_id` | Each Slack app has a unique bot ID. Configure allowlist. |
| `event.username` | Some integrations post as named bots (e.g., `sentry`) |
| `event.bot_profile.name` | Human-readable bot name |
| `event.attachments` | Sentry/PagerDuty alerts typically use rich attachments with structured fields |
| `event.blocks` | Modern Slack apps use Block Kit with identifiable patterns |

**Parsing alert messages:**

Sentry Slack messages follow a recognizable pattern:
- Title: error message or issue title
- Fields: project, environment, level, times seen, users affected
- Link: URL back to Sentry issue
- Color coding: red for errors, yellow for warnings

PagerDuty messages include:
- Incident title and description
- Service name, severity, status
- Acknowledge/resolve action buttons

Datadog messages include:
- Monitor name and status
- Alert query and threshold
- Affected hosts/services

The classifier would use a combination of:
1. Bot identification (bot_id allowlist)
2. Message structure patterns (attachments, blocks)
3. Keyword extraction (error types, severity levels)
4. URL parsing (Sentry issue URLs contain project slug and issue ID)

**Required Slack scopes (additions to current):**

| Scope | Purpose | Currently Have? |
|-------|---------|----------------|
| `channels:history` | Read messages in public channels | Check app manifest |
| `groups:history` | Read messages in private channels | Check app manifest |
| `channels:read` | List channels | Check app manifest |
| `chat:write` | Post messages (already needed) | Yes |

**Configuration:**

```
OBSERVER_ENABLED=true
OBSERVER_SLACK_CHANNELS=C01234ALERTS,C05678SENTRY
OBSERVER_ALERT_BOT_IDS=B01SENTRY,B02PAGERDUTY,B03DATADOG
OBSERVER_POLL_INTERVAL_SECONDS=60
```

### 4.2 Sentry REST API

**Sentry's REST API** provides comprehensive access to error data. This is the highest-value integration because Sentry contains the exact information an agent needs to fix a bug: stack traces, error messages, affected code, frequency data.

#### Key Endpoints

**List project issues (new/unresolved):**
```
GET /api/0/projects/{organization_slug}/{project_slug}/issues/
?query=is:unresolved&sort=date&statsPeriod=1h
```

Response includes:
- `title`: Error message
- `culprit`: Module/function where error occurred
- `count`: Number of occurrences
- `userCount`: Affected users
- `firstSeen`, `lastSeen`: Timing
- `level`: `error`, `warning`, `fatal`
- `metadata.type`: Exception class name
- `metadata.value`: Exception message

**Get issue details:**
```
GET /api/0/issues/{issue_id}/
```

**Get latest event for an issue (includes stack trace):**
```
GET /api/0/issues/{issue_id}/events/latest/
```

Response includes:
- `entries[].type === "exception"`: Full stack trace with:
  - `values[].type`: Exception class
  - `values[].value`: Exception message
  - `values[].stacktrace.frames[]`: Array of stack frames with:
    - `filename`: Source file path
    - `function`: Function name
    - `lineNo`, `colNo`: Exact location
    - `context`: Surrounding source code lines (if source maps configured)
    - `inApp`: Boolean -- whether this frame is in your code vs a library
- `tags`: Environment, browser, OS, release version
- `contexts`: Runtime, device, OS info

**List issue events (for pattern analysis):**
```
GET /api/0/issues/{issue_id}/events/
```

**Authentication:**
```
Authorization: Bearer <SENTRY_AUTH_TOKEN>
```

Sentry auth tokens are created at `https://sentry.io/settings/account/api/auth-tokens/` with scopes:
- `project:read` -- list projects, read project settings
- `event:read` -- read events and issues
- `org:read` -- read organization data

#### Sentry Webhooks (Alternative to Polling)

Sentry supports **internal integrations** that can send webhooks on specific events:

- `issue.created` -- new issue detected
- `issue.resolved` -- issue marked resolved
- `issue.ignored` -- issue marked ignored
- `issue.assigned` -- issue assigned
- `error.created` -- new error event (high volume, not recommended)
- `comment.created` -- comment added to issue

Webhook payload includes:
```json
{
  "action": "created",
  "data": {
    "issue": {
      "id": "12345",
      "title": "ZeroDivisionError: division by zero",
      "culprit": "app.utils.calculate_accrual",
      "level": "error",
      "url": "https://sentry.io/organizations/hubstaff/issues/12345/"
    }
  },
  "installation": { "uuid": "..." }
}
```

**Webhook security:** Payloads include `Sentry-Hook-Signature` (HMAC) for verification using your Internal Integration's Client Secret, plus `Sentry-Hook-Timestamp` and `Sentry-Hook-Resource` headers.

**Important:** If issue webhooks are enabled on an Internal Integration, ALL issue state changes fire webhooks (not just alert-rule-matched ones), so filtering is needed on the receiver side.

**Auth token recommendation:** Create an **Internal Integration** with scopes `org:read`, `project:read`, `event:read`. This gives both a webhook URL endpoint AND an auth token for API calls. One integration handles both pushing (webhooks) and pulling (polling).

**Implementation consideration:** Webhooks require an inbound HTTP endpoint. Gooseherd currently uses Socket Mode (WebSocket only, no inbound HTTP). The dashboard server already listens on port 8787, so a `/webhooks/sentry` route could be added there. However, this requires Sentry to be able to reach the Gooseherd instance (which may be behind a firewall). **Polling is simpler to start with.**

**Org-level endpoint (preferred over project-level):**
```
GET /api/0/organizations/{org}/issues/?query=is:unresolved&statsPeriod=1h
```
This is the recommended approach (project-level endpoint is deprecated). Use `project` query param with `-1` for all projects or specific project IDs.

#### Data Needed for Agent Context

When composing a Goose agent prompt from a Sentry alert, the optimal context includes:

```markdown
## Sentry Alert Context

**Error:** ZeroDivisionError: division by zero
**Project:** hubstaff-server
**Culprit:** app/services/accrual_calculator.rb:47 in `calculate_rate`
**Level:** error
**First Seen:** 2026-02-20T10:30:00Z
**Occurrences:** 142 in last hour
**Affected Users:** 23

### Stack Trace (app frames only)
app/services/accrual_calculator.rb:47 in `calculate_rate`
  > rate = total_hours / period_hours  # period_hours is 0
app/controllers/time_off_controller.rb:123 in `update_accrual`
app/jobs/payroll/finalize_job.rb:67 in `process_team`

### Error Context
The accrual rate calculation divides by a period that can be zero when
misconfigured. This is blocking payment finalization for affected teams.

### Sentry Issue URL
https://sentry.io/organizations/hubstaff/issues/12345/
```

### 4.3 GitHub CI Failures and Security Advisories

**GitHub Actions API** can be polled for failed workflow runs:

```
GET /repos/{owner}/{repo}/actions/runs?status=failure&created=>2026-02-20T10:00:00Z
```

**Dependabot security advisories:**
```
GET /repos/{owner}/{repo}/dependabot/alerts?state=open&severity=critical,high
```

**GitHub webhook events (if using GitHub App):**
- `workflow_run.completed` with `conclusion: "failure"`
- `dependabot_alert.created`
- `code_scanning_alert.created`

The existing `GitHubService` (`src/github.ts`) uses Octokit and could be extended to poll these endpoints.

### 4.4 Direct Webhook Endpoint

For maximum flexibility, the observer should also support a generic webhook endpoint:

```
POST /webhooks/alert
Content-Type: application/json

{
  "source": "sentry",
  "severity": "error",
  "title": "ZeroDivisionError in calculate_rate",
  "description": "...",
  "repo": "hubstaff/hubstaff-server",
  "url": "https://sentry.io/issues/12345/",
  "metadata": { ... }
}
```

This endpoint would be added to the existing dashboard HTTP server (`src/dashboard-server.ts`), which already handles various API routes.

---

## 5. Alert Classification and Filtering

### 5.1 Why Classification Matters

Not every alert should trigger an agent run. A naive "run Goose on every Sentry error" approach would cause:
- Alert fatigue (too many PRs to review)
- Wasted compute (agent can't fix infrastructure issues)
- Noise (transient errors, expected failures, already-handled issues)

### 5.2 Classification Pipeline

```
Raw Alert
    |
    v
[Source Parser] --> Normalized AlertEvent
    |
    v
[Severity Filter] --> Drop: info, debug, warning (configurable)
    |
    v
[Repo Matcher] --> Drop: alerts for repos not in allowlist
    |
    v
[Deduplicator] --> Drop: same issue triggered a run in last N hours
    |
    v
[Cooldown Check] --> Drop: repo has had N observer runs in last M hours
    |
    v
[Actionability Classifier] --> Drop: infrastructure issues, config issues
    |
    v
[Run Composer] --> NewRunInput with enriched prompt
    |
    v
[RunManager.enqueueRun()]
```

### 5.3 AlertEvent Interface

```typescript
interface AlertEvent {
  // Identity
  id: string;                    // Unique alert ID (e.g., Sentry issue ID)
  source: "sentry" | "slack" | "github" | "webhook";
  sourceUrl?: string;            // Link back to source (Sentry URL, etc.)

  // Classification
  severity: "critical" | "error" | "warning" | "info";
  category: "exception" | "ci_failure" | "security" | "performance" | "custom";

  // Repo mapping
  repoSlug?: string;             // e.g., "hubstaff/hubstaff-server"
  affectedFiles?: string[];      // Files mentioned in stack trace

  // Content
  title: string;                 // Short description
  description: string;           // Full context (stack trace, error details)
  stackTrace?: string;           // Raw stack trace if available
  errorType?: string;            // Exception class name
  errorMessage?: string;         // Exception message

  // Metrics
  occurrences?: number;          // How many times this happened
  affectedUsers?: number;        // How many users affected
  firstSeen?: string;            // ISO timestamp
  lastSeen?: string;             // ISO timestamp

  // Raw data
  rawPayload?: unknown;          // Original alert data for debugging
}
```

### 5.4 Severity Thresholds

Default configuration (all overridable):

```
OBSERVER_MIN_SEVERITY=error          # Minimum severity to trigger a run
OBSERVER_MIN_OCCURRENCES=5           # Minimum occurrences before acting
OBSERVER_MIN_AFFECTED_USERS=1        # Minimum affected users
OBSERVER_COOLDOWN_HOURS=4            # Hours between runs for same issue
OBSERVER_MAX_RUNS_PER_REPO_PER_DAY=5 # Prevent runaway runs
```

### 5.5 Repo Mapping

Alerts must be mapped to a `repoSlug` for the run. Mapping strategies:

| Source | Mapping Strategy |
|--------|-----------------|
| Sentry | Sentry project slug -> configured repo mapping. E.g., `sentry_project:hubstaff-server` -> `hubstaff/hubstaff-server` |
| GitHub CI | Already contains `owner/repo` |
| Slack alerts | Parse repo name from message text, attachment fields, or URL |
| Webhook | Explicit `repo` field in payload |

Configuration:
```
OBSERVER_REPO_MAP=hubstaff-server:hubstaff/hubstaff-server,hubstaff-web:hubstaff/hubstaff-web
```

### 5.6 Deduplication

The deduplicator maintains a lightweight in-memory map (persisted to `data/observer-state.json`):

```typescript
interface ObserverState {
  // Map of alert fingerprint -> last run info
  alertHistory: Record<string, {
    alertId: string;
    source: string;
    lastRunId: string;
    lastRunAt: string;
    runCount: number;
  }>;

  // Map of repoSlug -> daily run count
  repoRunCounts: Record<string, {
    date: string;  // YYYY-MM-DD
    count: number;
  }>;
}
```

Fingerprint generation:
- Sentry: `sentry:{issue_id}`
- GitHub CI: `github-ci:{repo}:{workflow}:{branch}`
- Slack: `slack:{channel}:{message_hash}` (hash of title + first 200 chars)
- Webhook: `webhook:{source}:{id}`

---

## 6. Run Composition

### 6.1 Building the Task Prompt

The Run Composer is the critical component that transforms an alert into an actionable agent task. The quality of this prompt directly determines whether the agent produces a useful fix.

**Template for Sentry errors:**

```markdown
## Automated Investigation: Sentry Error

**Error:** {{error_type}}: {{error_message}}
**Project:** {{sentry_project}}
**Severity:** {{severity}}
**Occurrences:** {{occurrences}} in last {{time_window}}
**Affected Users:** {{affected_users}}

### Stack Trace
{{stack_trace}}

### Task

Investigate this error and implement a fix. Specifically:

1. Read the code at the locations shown in the stack trace
2. Understand the root cause of the error
3. Implement a defensive fix (input validation, null checks, error handling)
4. Add or update tests to cover the failure case
5. Keep changes minimal -- only fix this specific issue

### Context

- Sentry issue: {{sentry_url}}
- This was detected automatically by the Gooseherd observer system
- A human will review any PR before merge

### Constraints

- Do NOT refactor unrelated code
- Do NOT change database schemas
- If the fix requires changes outside this repo, document them in a code comment
- If the root cause is unclear, add better error handling and logging rather than guessing
```

**Template for CI failures:**

```markdown
## Automated Investigation: CI Failure

**Workflow:** {{workflow_name}}
**Branch:** {{branch}}
**Failed Job:** {{job_name}}
**Failure Output:**
```
{{failure_log_tail}}
```

### Task

Fix the CI failure. The test/build failure is shown above. Investigate the cause
and implement the minimum change needed to make CI pass again.

### Context

- GitHub Actions run: {{actions_url}}
- This was detected automatically by the Gooseherd observer system
```

**Template for security advisories:**

```markdown
## Automated Investigation: Security Advisory

**Advisory:** {{advisory_title}}
**Severity:** {{severity}}
**Package:** {{package_name}} (current: {{current_version}}, fixed: {{fixed_version}})

### Task

Update the vulnerable dependency to the patched version. Run the test suite to
verify nothing breaks. If tests fail after the upgrade, fix any compatibility issues.

### Context

- Advisory URL: {{advisory_url}}
- This was detected automatically by the Gooseherd observer system
```

### 6.2 Creating the NewRunInput

```typescript
function composeObserverRun(
  alert: AlertEvent,
  config: ObserverConfig
): NewRunInput {
  return {
    repoSlug: alert.repoSlug!,
    task: buildTaskPrompt(alert),
    baseBranch: config.defaultBaseBranch,
    requestedBy: "observer",       // Special requester ID
    channelId: config.reportChannelId,  // Dedicated observer channel
    threadTs: generateThreadTs(),   // New thread per alert
  };
}
```

The `requestedBy: "observer"` marker lets downstream systems (Slack cards, dashboard, CEMS memory) identify auto-triggered runs vs human-triggered ones.

### 6.3 Reporting Channel

Observer-triggered runs should post to a dedicated Slack channel (e.g., `#gooseherd-observer`) rather than the alert source channel. This:
- Keeps alert channels clean
- Creates a reviewable audit trail of observer actions
- Lets the team tune the observer without disrupting alert flow

The observer would post an initial message like:
```
Detected Sentry error in hubstaff/hubstaff-server:
> ZeroDivisionError: division by zero in accrual_calculator.rb:47
> 142 occurrences, 23 users affected

Auto-triggering investigation run...
```

Then the normal RunManager flow takes over, posting status updates and the run card in the same thread.

---

## 7. MCP Ecosystem for Agent Enrichment

### 7.1 What MCP Servers Exist

MCP (Model Context Protocol) servers allow the Goose agent to access external tools during a run. The agent can query these tools to gather more context while investigating.

| MCP Server | Status | What It Provides |
|-----------|--------|-----------------|
| **Sentry MCP** | Official (`getsentry/sentry-mcp`) | 16+ tools: `list_issues`, `get_issue_details`, `search_issues` (AI-powered), `resolve_issue`. Stdio transport: `npx @sentry/mcp-server-stdio --token <TOKEN>`. Remote: `mcp.sentry.dev`. |
| **GitHub MCP** | Official (`github/github-mcp-server`) | 70+ tools across toolsets. Enable `actions` for CI, `code_security` + `dependabot` for security alerts. Env: `GITHUB_TOOLSETS="repos,issues,pull_requests,actions,code_security,dependabot"`. |
| **PagerDuty MCP** | Official (`PagerDuty/pagerduty-mcp-server`) | Hosted at `mcp.pagerduty.com/mcp`. Read-only by default. Retrieves incidents, services, schedules. Auth: `PAGERDUTY_USER_API_KEY`. |
| **Datadog MCP** | Official (Preview) + Community | Official: `docs.datadoghq.com/bits_ai/mcp_server/` (allowlisted orgs only). Community: `shelfio/datadog-mcp` (monitors, dashboards, metrics, logs). |
| **New Relic MCP** | Official (Preview) | Natural language to NRQL translation. Check alert statuses, analyze deployment impact. `docs.newrelic.com/docs/agentic-ai/mcp/overview/`. |
| **Slack MCP** | Official + Community | Official: `docs.slack.dev/ai/slack-mcp-server/`. Community: `korotovsky/slack-mcp-server` (DMs, history, stealth mode). |
| **Postgres MCP** | Community | Direct DB queries (use with extreme caution) |

### 7.2 How MCP Servers Would Be Used

Gooseherd already supports MCP extensions via `CEMS_MCP_COMMAND` in the config, which appends `--with-extension <command>` to the Goose agent invocation. This mechanism could be extended to support multiple MCP servers.

During an observer-triggered run, the Goose agent could:

1. **Sentry MCP**: Fetch additional events for the same issue, check if it's a regression, find related issues
2. **GitHub MCP**: Search for similar patterns in the codebase, check if a fix was already attempted, read related PRs
3. **CEMS Memory**: Check if this error type was encountered before, what fix worked previously

Example agent flow with MCP tools:
```
1. Read the task prompt (contains stack trace from observer)
2. memory_search("ZeroDivisionError accrual_calculator") -> finds previous fix attempt
3. Read the file at app/services/accrual_calculator.rb
4. sentry_get_events(issue_id) -> sees the error happens with period_hours=0
5. Implement the fix: add guard clause for zero period
6. Run tests
7. memory_add("Fixed ZeroDivisionError in accrual_calculator.rb by adding zero guard")
```

### 7.3 MCP Configuration for Observer Runs

The observer could configure additional MCP extensions specifically for alert-triggered runs:

```
OBSERVER_MCP_EXTENSIONS=sentry-mcp:npx @sentry/mcp-server --token $SENTRY_AUTH_TOKEN
```

Or, the Sentry MCP could be included in the global `AGENT_COMMAND_TEMPLATE` so it's available to all runs.

### 7.4 Practical Recommendation

**Start without MCP for Sentry. Use the REST API in the observer to pre-fetch all context and inject it into the prompt.**

Reasons:
- The observer already has the Sentry auth token and can fetch full issue details
- Pre-fetched context in the prompt is deterministic (the agent always sees it)
- MCP tool calls are non-deterministic (the agent might not call the right tool)
- Reduces complexity -- no need to install/configure additional MCP servers
- The existing CEMS MCP is sufficient for cross-run memory

Later, as a refinement, Sentry MCP could be added so the agent can do **ad-hoc** queries (e.g., "are there other errors in this file?" or "what's the error rate trend?").

### 7.5 MCP Extensions Available for Observer Runs

When the observer triggers a Goose agent run, these MCP extensions can be attached via `--with-extension`:

| Extension | Command | What It Gives the Agent |
|-----------|---------|------------------------|
| Sentry | `npx @sentry/mcp-server-stdio --token $SENTRY_AUTH_TOKEN` | Query issues, events, search errors in real-time during investigation |
| GitHub | `docker run ghcr.io/github/github-mcp-server stdio` | Search code, read files, check CI, list PRs, query Dependabot alerts |
| PagerDuty | `docker run ghcr.io/pagerduty/pagerduty-mcp-server stdio` | Read active incidents, on-call schedules, service context |
| CEMS | `cems-mcp` (already configured) | Cross-run memory: past fixes, architectural decisions, conventions |

The observer could selectively attach extensions based on the alert source. A Sentry alert would get the Sentry MCP; a CI failure would get the GitHub MCP.

---

## 8. Data Flow: End-to-End

### 8.1 Sentry Alert via API Polling

```
+------------------+     +-----------------+     +------------------+
|  Sentry REST API |     |  Observer       |     |  Alert Classifier|
|  GET /issues/    |---->|  Daemon         |---->|  + Dedup         |
|  ?query=unresolv |     |  (60s interval) |     |                  |
+------------------+     +-----------------+     +--------+---------+
                                                          |
                                            [actionable?] |
                                                          v
                         +-----------------+     +--------+---------+
                         |  Sentry REST API|     |  Run Composer    |
                         |  GET /issues/   |---->|  (enriches with  |
                         |  {id}/events/   |     |  stack trace,    |
                         |  latest/        |     |  builds prompt)  |
                         +-----------------+     +--------+---------+
                                                          |
                                                          v
+------------------+     +-----------------+     +--------+---------+
|  Slack Channel   |<----|  RunManager     |<----|  NewRunInput     |
|  #gooseherd-     |     |  .enqueueRun()  |     |  (task includes  |
|   observer       |     |                 |     |   full context)  |
+------------------+     +--------+--------+     +------------------+
                                  |
                                  v
                         +--------+--------+
                         |  RunExecutor    |
                         |  .execute()     |
                         |  (clone, agent, |
                         |   validate,     |
                         |   push, PR)     |
                         +-----------------+
```

### 8.2 Slack Channel Alert

```
+------------------+     +-----------------+     +------------------+
|  Sentry bot      |     |  Slack Bolt     |     |  Alert Parser    |
|  posts to        |---->|  message event  |---->|  (extracts error |
|  #sentry-alerts  |     |  listener       |     |  details, URL)   |
+------------------+     +-----------------+     +--------+---------+
                                                          |
                                            [recognized?] |
                                                          v
                         +-----------------+     +--------+---------+
                         |  Sentry REST API|     |  Enrichment      |
                         |  (optional:     |---->|  (fetches full   |
                         |   fetch more    |     |  stack trace)    |
                         |   context)      |     |                  |
                         +-----------------+     +--------+---------+
                                                          |
                                                          v
                                                 +--------+---------+
                                                 |  Same pipeline   |
                                                 |  as above:       |
                                                 |  classify ->     |
                                                 |  compose ->      |
                                                 |  enqueue         |
                                                 +------------------+
```

### 8.3 Full ASCII Architecture

```
+===================================================================+
|                        GOOSEHERD PROCESS                          |
|                                                                   |
|  +-------------+  +-------------+  +---------------------------+  |
|  | Slack Bot   |  | Dashboard   |  | Observer Daemon           |  |
|  | (Bolt)      |  | HTTP Server |  |                           |  |
|  |             |  |             |  |  +---------+ +---------+  |  |
|  | app_mention |  | /api/runs   |  |  | Slack   | | Sentry  |  |  |
|  | message*    |  | /webhooks/* |  |  | Channel | | Poller  |  |  |
|  +------+------+  +------+------+  |  | Watcher | |         |  |  |
|         |                |          |  +----+----+ +----+----+  |  |
|         |                |          |       |           |       |  |
|         v                v          |  +----v-----------v----+  |  |
|  +------+------+  +------+------+  |  | Classifier + Dedup  |  |  |
|  | Command     |  | Webhook     |  |  +----------+----------+  |  |
|  | Parser      |  | Handler     |  |             |              |  |
|  +------+------+  +------+------+  |  +----------v----------+  |  |
|         |                |          |  | Run Composer         |  |  |
|         |                |          |  +----------+----------+  |  |
|         v                v                        |              |  |
|  +------+----------------+------------------------v-----------+  |  |
|  |                     RunManager                             |  |  |
|  |  .enqueueRun()  .retryRun()  .continueRun()              |  |  |
|  +----------------------------+------------------------------+  |  |
|                               |                                  |  |
|  +----------------------------v------------------------------+  |  |
|  |                     RunExecutor                            |  |  |
|  |  clone -> prompt -> Goose agent -> validate -> push -> PR |  |  |
|  +------------------------------------------------------------+  |  |
|                                                                   |
|  +------------------------------------------------------------+  |  |
|  |  RunStore (data/runs.json)  |  ObserverStore (observer.json)|  |
|  +------------------------------------------------------------+  |  |
+===================================================================+

External:
  - Slack API (Socket Mode WebSocket)
  - GitHub API (Octokit REST)
  - Sentry API (REST, polling)
  - CEMS API (REST, for memory)
```

---

## 9. Preventing Alert Fatigue

This is arguably the most important section. An overzealous observer that triggers 50 runs per day will be turned off within a week.

### 9.1 Multi-Layer Filtering

| Layer | What It Prevents | Default |
|-------|-----------------|---------|
| **Severity threshold** | Low-severity alerts triggering runs | `error` minimum |
| **Occurrence threshold** | One-off transient errors | 5 minimum occurrences |
| **User impact threshold** | Errors affecting no real users | 1 minimum affected user |
| **Issue age filter** | Old issues re-surfacing | Only issues first seen in last 24h |
| **Deduplication** | Same issue triggering multiple runs | 4-hour cooldown per alert fingerprint |
| **Per-repo rate limit** | Runaway runs on a problematic repo | 5 runs per repo per day |
| **Global rate limit** | Total observer run volume | 20 runs per day |
| **Repo allowlist** | Runs on repos we don't manage | Uses existing `REPO_ALLOWLIST` |
| **Manual override** | Emergency stop | `OBSERVER_ENABLED=false` |

### 9.2 Escalation vs Auto-Fix

Not all detected issues should trigger auto-fix runs. The observer should support an **escalation mode** for ambiguous cases:

| Confidence Level | Action |
|-----------------|--------|
| **High** -- clear exception with code-level stack trace, in-app frames, known repo | Auto-trigger Goose run |
| **Medium** -- exception but unclear repo mapping, or infrastructure-adjacent | Post to observer channel for human decision |
| **Low** -- warning level, or category is performance/configuration | Log and ignore |

The confidence level would be determined by:
- Does the stack trace contain `inApp: true` frames? (Sentry marks these)
- Can we map the project to a repo in our allowlist?
- Is the error category one we've seen the agent fix before? (CEMS memory query)
- Has a human previously approved/rejected a similar alert? (learning from history)

### 9.3 Feedback Loop

The observer system itself should learn:

| Signal | What to Store | Effect |
|--------|--------------|--------|
| Run completed + PR merged | "This type of alert was successfully auto-fixed" | Increase confidence for similar alerts |
| Run completed + PR rejected | "This type of alert produced a bad fix" | Decrease confidence, switch to escalation mode |
| Run failed | "Agent couldn't handle this type of issue" | Add to exclusion patterns |
| Human dismisses observer message | "This alert type isn't worth investigating" | Add to suppression list |

This feedback would be stored via CEMS with `category: "observer-learning"`.

---

## 10. Configuration Reference

### 10.1 New Environment Variables

```bash
# ── Observer System ──

# Master switch
OBSERVER_ENABLED=false

# Slack: channels to watch for alert messages
OBSERVER_SLACK_CHANNELS=              # Comma-separated channel IDs

# Slack: bot IDs recognized as alert sources
OBSERVER_ALERT_BOT_IDS=              # Comma-separated Slack bot IDs

# Slack: channel where observer posts its own runs
OBSERVER_REPORT_CHANNEL=             # Channel ID for observer status messages

# Sentry integration
SENTRY_AUTH_TOKEN=                   # Sentry API auth token
SENTRY_ORG_SLUG=                     # Sentry organization slug
SENTRY_PROJECT_SLUGS=                # Comma-separated Sentry project slugs to monitor

# Repo mapping (Sentry project -> GitHub repo)
OBSERVER_REPO_MAP=                   # Format: sentry-proj:owner/repo,proj2:owner/repo2

# Polling
OBSERVER_POLL_INTERVAL_SECONDS=60    # How often to check sources
OBSERVER_LOOKBACK_MINUTES=5          # How far back to look on each poll

# Thresholds
OBSERVER_MIN_SEVERITY=error          # Minimum: critical, error, warning, info
OBSERVER_MIN_OCCURRENCES=5           # Minimum event count before acting
OBSERVER_MIN_AFFECTED_USERS=1        # Minimum affected users
OBSERVER_MAX_ISSUE_AGE_HOURS=24      # Ignore issues older than this

# Rate limiting
OBSERVER_COOLDOWN_HOURS=4            # Hours between runs for same alert
OBSERVER_MAX_RUNS_PER_REPO_PER_DAY=5
OBSERVER_MAX_RUNS_PER_DAY=20

# MCP extensions for observer runs (optional)
OBSERVER_MCP_EXTENSIONS=
```

### 10.2 Docker Compose Addition

```yaml
services:
  gooseherd:
    environment:
      # ... existing vars ...

      # ── Observer System ──
      - OBSERVER_ENABLED=${OBSERVER_ENABLED:-false}
      - OBSERVER_SLACK_CHANNELS=${OBSERVER_SLACK_CHANNELS:-}
      - OBSERVER_ALERT_BOT_IDS=${OBSERVER_ALERT_BOT_IDS:-}
      - OBSERVER_REPORT_CHANNEL=${OBSERVER_REPORT_CHANNEL:-}
      - SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN:-}
      - SENTRY_ORG_SLUG=${SENTRY_ORG_SLUG:-}
      - SENTRY_PROJECT_SLUGS=${SENTRY_PROJECT_SLUGS:-}
      - OBSERVER_REPO_MAP=${OBSERVER_REPO_MAP:-}
      - OBSERVER_POLL_INTERVAL_SECONDS=${OBSERVER_POLL_INTERVAL_SECONDS:-60}
      - OBSERVER_MIN_SEVERITY=${OBSERVER_MIN_SEVERITY:-error}
      - OBSERVER_MIN_OCCURRENCES=${OBSERVER_MIN_OCCURRENCES:-5}
      - OBSERVER_COOLDOWN_HOURS=${OBSERVER_COOLDOWN_HOURS:-4}
      - OBSERVER_MAX_RUNS_PER_REPO_PER_DAY=${OBSERVER_MAX_RUNS_PER_REPO_PER_DAY:-5}
      - OBSERVER_MAX_RUNS_PER_DAY=${OBSERVER_MAX_RUNS_PER_DAY:-20}
```

---

## 11. Implementation Plan

### Phase 1: Sentry Poller (MVP)

**Goal:** Poll Sentry for new errors, auto-trigger runs for clear-cut exceptions.

Files to create:
- `src/observer/types.ts` -- AlertEvent, ObserverConfig interfaces
- `src/observer/sources/sentry-api.ts` -- Sentry REST API client
- `src/observer/classifier.ts` -- Severity + occurrence filtering
- `src/observer/deduplicator.ts` -- Fingerprint-based dedup with JSON persistence
- `src/observer/run-composer.ts` -- Builds task prompt from alert context
- `src/observer/daemon.ts` -- Main loop with setInterval

Files to modify:
- `src/config.ts` -- Add observer config fields to `AppConfig`
- `src/index.ts` -- Instantiate and start observer daemon
- `src/types.ts` -- Add `triggerSource?: "human" | "observer"` to RunRecord

**Estimated effort:** 3-5 days for a senior engineer.

### Phase 2: Slack Channel Watching

**Goal:** Watch designated Slack channels for alert bot messages, parse and classify them.

Files to create:
- `src/observer/sources/slack-channel.ts` -- Message parser for Sentry/PagerDuty/Datadog bot formats

Files to modify:
- `src/slack-app.ts` -- Add `message` event listener that routes to observer

**Estimated effort:** 2-3 days.

### Phase 3: GitHub CI + Dependabot

**Goal:** Watch for failed CI runs and security advisories.

Files to create:
- `src/observer/sources/github-ci.ts` -- GitHub Actions failure poller
- `src/observer/sources/github-security.ts` -- Dependabot alert poller

Files to modify:
- `src/github.ts` -- Add methods for Actions and Dependabot APIs

**Estimated effort:** 2-3 days.

### Phase 4: Webhook Endpoint

**Goal:** Accept webhook pushes from Sentry, PagerDuty, and custom sources.

Files to modify:
- `src/dashboard-server.ts` -- Add `/webhooks/sentry`, `/webhooks/generic` routes

**Estimated effort:** 1-2 days.

### Phase 5: Learning + Tuning

**Goal:** Observer learns from run outcomes to improve alert triage over time.

Files to create:
- `src/observer/feedback-loop.ts` -- Stores observer outcomes in CEMS

Files to modify:
- `src/hooks/run-lifecycle.ts` -- Add `onObserverRunComplete` hook
- `src/observer/classifier.ts` -- Query CEMS for historical success/failure patterns

**Estimated effort:** 2-3 days.

---

## 12. Dashboard Integration

The existing dashboard (`src/dashboard-server.ts`) would be extended with:

### 12.1 Observer Status Panel

- Current observer state (enabled/disabled, last poll time)
- Recent alerts detected (with classification result: triggered / escalated / suppressed)
- Run rate metrics (runs today, per-repo counts, cooldown status)

### 12.2 Alert Review Queue

For medium-confidence alerts in escalation mode:
- List of pending alerts awaiting human decision
- "Investigate" button to trigger a run
- "Suppress" button to ignore (stores feedback)
- "Suppress pattern" button to permanently ignore this error class

### 12.3 API Endpoints

```
GET  /api/observer/status        -- Observer health and metrics
GET  /api/observer/alerts        -- Recent detected alerts
POST /api/observer/alerts/:id/approve  -- Approve a pending alert for investigation
POST /api/observer/alerts/:id/suppress -- Suppress an alert
GET  /api/observer/config        -- Current observer configuration
```

---

## 13. The Motivating Example: Full Walkthrough

Here is how the Time Off accrual bug would be handled end-to-end:

**T+0 seconds:** Engineer sets accrual rate to 999h per 1h worked. System saves the value.

**T+5 minutes:** Payroll finalization job runs, calls `accrual_calculator.rb:47` which divides by `period_hours`. The misconfigured rate causes a `ZeroDivisionError`. Sentry captures the exception.

**T+60 seconds (observer poll):** Observer daemon polls Sentry API:
```
GET /api/0/projects/hubstaff/hubstaff-server/issues/?query=is:unresolved&sort=date&statsPeriod=1h
```
Finds the new `ZeroDivisionError` issue. Checks:
- Severity: `error` -- passes threshold
- Occurrences: 142 -- passes minimum (5)
- Affected users: 23 -- passes minimum (1)
- First seen: 5 minutes ago -- passes age filter (24h)
- Fingerprint: `sentry:12345` -- not in dedup cache -- passes
- Repo: `hubstaff-server` maps to `hubstaff/hubstaff-server` -- in allowlist

**T+62 seconds (context enrichment):** Observer fetches full event details:
```
GET /api/0/issues/12345/events/latest/
```
Extracts: stack trace (in-app frames only), exception type, message, affected code paths.

**T+63 seconds (run composition):** Run Composer builds the task:
```
Investigate and fix this Sentry error:

Error: ZeroDivisionError: division by zero
File: app/services/accrual_calculator.rb:47 in `calculate_rate`
Occurrences: 142 in last hour, affecting 23 users

Stack Trace:
  app/services/accrual_calculator.rb:47 in `calculate_rate`
  app/controllers/time_off_controller.rb:123 in `update_accrual`
  app/jobs/payroll/finalize_job.rb:67 in `process_team`

Implement a fix:
1. Add input validation to prevent invalid accrual rates
2. Add a guard clause for zero-division scenarios
3. Add tests covering the edge case
4. Keep changes minimal
```

**T+64 seconds (enqueue):** `RunManager.enqueueRun()` called. Run posted to `#gooseherd-observer`:
```
[Observer] Detected Sentry error in hubstaff/hubstaff-server:
> ZeroDivisionError: division by zero (142 occurrences, 23 users)
Queued run for hubstaff/hubstaff-server
Branch: gooseherd/abc12345
```

**T+2 minutes:** Goose agent clones repo, reads the file, CEMS search finds: "Previous fix attempt for accrual validation used max_rate constant". Agent implements the fix with proper validation.

**T+8 minutes:** Validation passes. Agent pushes branch and opens PR:
```
gooseherd: Add accrual rate validation to prevent ZeroDivisionError

## Task
Investigate and fix Sentry error: ZeroDivisionError in accrual_calculator.rb

## Changes
- Added `MAX_ACCRUAL_RATE = 24.0` constant
- Added guard clause: `raise ArgumentError if period_hours <= 0`
- Added validation in TimeOffController: rejects rates > MAX_ACCRUAL_RATE
- Added specs covering zero-division and excessive rate scenarios

## Context
- Sentry issue: https://sentry.io/issues/12345/
- Triggered automatically by Gooseherd Observer
```

**T+8 minutes:** RunManager updates the Slack card in `#gooseherd-observer` with the PR link. Engineer reviews and merges.

---

## 14. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Agent creates wrong fix, merged carelessly | HIGH | All PRs require human review. Observer runs are labeled `[Observer]` for extra scrutiny. |
| Too many runs overwhelm the review queue | MEDIUM | Per-repo and global rate limits. Start with conservative thresholds. |
| Agent modifies sensitive code paths | HIGH | Existing `REPO_ALLOWLIST` plus potential path-level restrictions in observer config. |
| Sentry API rate limiting | LOW | Sentry rate limit is 20 req/s for authenticated requests. Polling once per minute is well within limits. |
| Stale alerts re-triggering | LOW | Deduplication + issue age filter + cooldown period. |
| Observer triggers on already-fixed issues | LOW | Check Sentry issue status (`resolved`) before triggering. |
| Cost overrun (agent API calls) | MEDIUM | Global daily run limit + existing `AGENT_TIMEOUT_SECONDS`. |
| Observer itself crashes | LOW | Same-process architecture means it restarts with Gooseherd. Persisted state file survives restarts. |

---

## 15. Open Questions

1. **Sentry project-to-repo mapping**: Should this be configured manually or auto-discovered from Sentry's repo integration settings?

2. **Stack trace filtering**: How aggressively should we filter library frames? Only `inApp: true` frames, or include one level of library context?

3. **Multi-repo errors**: What if a Sentry issue spans multiple repos (e.g., API + frontend)? Pick the primary repo from the deepest in-app frame?

4. **Observer channel permissions**: Should the observer channel be private (team only) or public (visibility)?

5. **Approval workflow**: Should high-confidence alerts auto-trigger immediately, or should there always be a brief delay (e.g., 5 minutes) to allow human override?

6. **Existing issue handling**: Should the observer only act on *new* issues (first seen recently), or also on *regression* issues (previously resolved, now re-opened)?

7. **Integration with existing Sentry workflows**: If the team already has Sentry alert rules that page on-call, how does the observer complement (not compete with) that workflow?

---

## 16. Summary of Recommendations

1. **Start with Sentry API polling** as the first alert source. It provides the richest context (stack traces, code locations) and the clearest actionable signal.

2. **Build it as a module inside the existing Gooseherd process**, following the same pattern as `WorkspaceCleaner`. No separate service needed.

3. **Be conservative with auto-triggering**. Default thresholds should be high (error severity, 5+ occurrences, 1+ affected users). Better to miss some alerts than to flood the team with bad PRs.

4. **Pre-fetch all context into the prompt** rather than relying on MCP tools for Sentry data. The observer has the auth token and can build a better prompt than the agent would construct ad-hoc.

5. **Deduplicate aggressively**. The 4-hour cooldown per alert fingerprint plus per-repo daily limits prevent runaway behavior.

6. **Use a dedicated Slack channel** for observer output. Keep it separate from human-triggered runs.

7. **Label observer runs clearly** in both Slack and PRs so reviewers know these were auto-triggered and should be reviewed with extra care.

8. **Add Slack channel watching as Phase 2** after the Sentry poller is proven. This captures alerts from tools that don't have a REST API.

9. **Plan for the feedback loop** from day one. Store observer outcomes in CEMS so the classifier can learn which alert types produce good fixes and which don't.

---

## 17. Source References

- Sentry REST API documentation: https://docs.sentry.io/api/
- Sentry issue endpoints: https://docs.sentry.io/api/events/list-a-projects-issues/
- Sentry event details: https://docs.sentry.io/api/events/retrieve-the-latest-event-for-an-issue/
- Sentry webhooks/integrations: https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
- Sentry auth tokens: https://docs.sentry.io/api/auth/
- Slack Events API: https://api.slack.com/events-api
- Slack message event: https://api.slack.com/events/message
- Slack Bolt event listeners: https://slack.dev/bolt-js/concepts/event-listening
- GitHub Actions REST API: https://docs.github.com/en/rest/actions/workflow-runs
- GitHub Dependabot alerts API: https://docs.github.com/en/rest/dependabot/alerts
- MCP specification: https://spec.modelcontextprotocol.io/
- GitHub MCP Server: https://github.com/github/github-mcp-server
- Goose MCP extensions: https://block.github.io/goose/docs/getting-started/using-extensions
- Block Goose documentation: https://block.github.io/goose/
