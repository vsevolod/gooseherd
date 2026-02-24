# Gooseherd — Implementation Tasks

> Generated from 13-agent gap analysis across all docs/ research.
> Each task includes severity, source docs, and codex verification status.
> Completed tasks are removed — git history has the full original list (35 remaining).

---

## Document Reference Map

| Doc | Type | Notes |
|-----|------|-------|
| `docs/architecture.md` | Living reference | Stale in places — needs update |
| `docs/bulletproof_system_architecture_2026-02-21.md` | Vision (authoritative) | Most complete spec, 15 unimplemented features |
| `docs/hubble_expansion_research_2026-02-18.md` | Research | CEMS/memory gaps, feedback loop, deployment |
| `docs/hubble_system_blueprint_2026-02-17.md` | Research (descoped) | Enterprise blueprint, deliberately simplified |
| `docs/installation-tiers-research-2026-02-21.md` | Research | Adoption blockers, config, DX |
| `docs/minion_system_research_2026-02-17.md` | Research (oldest) | License analysis, runner substrate decision |
| `docs/minions_v2_deep_research_2026-02-20.md` | Research | Priority tracking, 2 of 6 still open |
| `docs/observer_system_research_2026-02-20.md` | Research | Most detailed gap list, phases 4-5 incomplete |
| `docs/slack-ux-issues.md` | Issue tracker | 4 open issues |
| `docs/findings_original_mvp.md` | Historical | MVP decisions, tech debt noted |
| `docs/progress_original_mvp.md` | Historical | No actionable items |
| `docs/task_plan_original_mvp.md` | Historical | Definition of Done still valid |

---

## ~~CRITICAL — The Agent Is Blind and Dumb~~ DONE

All 3 critical tasks completed. Agent now has codebase context, task-type-specific prompts, and output analysis with garbage detection.

---

## ~~HIGH — Core Features Are Stubs or Dead Code~~ MOSTLY DONE

~~Task 4~~, ~~Task 5~~, ~~Task 6~~, ~~Task 8~~, ~~Task 9~~, ~~Task 11~~ — all completed (Phases 8-9).

~~Remaining HIGH: Task 7 (Slack channel adapter), Task 10 (screenshots).~~ **ALL DONE**

---

### ~~Task 7: Wire Slack Channel Adapter to Bolt~~ DONE
### ~~Task 8: Multi-MCP Extension Support~~ DONE
### ~~Task 9: Enable CI Feedback in Default Pipeline~~ DONE
### ~~Task 10: Visual Screenshot/Preview Step in Slack~~ DONE

---

### ~~Task 11: "Awaiting Instructions" Idle State in Slack~~ DONE

---

## ~~MEDIUM-HIGH — Adoption Blockers and Missing Polish~~ ALL DONE

~~Task 12~~ (DRY_RUN default), ~~Task 13~~ (agent default detection), ~~Task 14~~ (dashboard URL), ~~Task 15~~ (error classifier), ~~Task 16~~ (enriched memory), ~~Task 17~~ (CEMS team ID), ~~Task 18~~ (follow-up diffs) — all completed (Phases 8-9).

---

## MEDIUM — Missing Features From Vision Docs

### ~~Task 19: Plan Task Node (LLM Planning Before Implementation)~~ DONE
### ~~Task 20: Local Test Node (Run Tests Before Push)~~ DONE

---

### Task 21: Observer Learning Loop (Phase 5)

**Severity:** MEDIUM
**Status:** Not started
**Codex verified:** N/A
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — Phase 5: Learning system

**Problem:** Observer has no feedback loop. It doesn't learn from successful/failed runs to adjust triage rules or confidence thresholds.

**What's needed:**
- Track observer trigger → run outcome correlation
- Adjust triage confidence thresholds based on success rates
- Auto-disable trigger rules that consistently produce failed runs
- Surface learning insights in dashboard

---

### ~~Task 22: Observer Threshold Configuration~~ DONE

---

### Task 23: GitHub Observer — Actions API Polling and Dependabot

**Severity:** MEDIUM
**Status:** Partial — webhook only
**Codex verified:** N/A
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — Phase 3: GitHub sources

**Problem:** GitHub observer only works via webhooks. No proactive polling of GitHub Actions failures. No Dependabot alert integration.

**What's needed:**
- Poll GitHub Actions API for failed workflow runs
- Parse Dependabot security alerts as trigger events
- Both feed into existing safety pipeline

---

### Task 24: Sentry Webhook Receiver

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/bulletproof_system_architecture_2026-02-21.md` — Sentry webhook
- `docs/observer_system_research_2026-02-20.md` — real-time webhook alternative to polling

**Problem:** Observer only polls Sentry REST API on an interval. Bulletproof spec also wants a real-time Sentry webhook endpoint for instant event processing.

**What's needed:**
- Add `/webhooks/sentry` endpoint to webhook server
- Verify Sentry webhook signatures
- Parse Sentry webhook payload into TriggerEvent
- Route through existing safety pipeline

---

### Task 25: Config Hot-Reload

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** YES — finding #8: config loaded once at startup
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — config hot-reload

**Problem:** Config is loaded once at startup. Changing env vars or trigger rules requires a full restart.

**What's needed:**
- Watch config files (trigger rules YAML, gooseherd.yml) with fs.watch
- Reload on change without restarting the process
- Env var changes still require restart (standard behavior)

---

### ~~Task 26: Slack App Manifest~~ DONE

---

### Task 27: Dashboard Observer Panel

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — dashboard visualization
- `docs/bulletproof_system_architecture_2026-02-21.md` — trigger/gate visualization

**Problem:** Dashboard shows runs only. Zero observer awareness — no trigger log, no event queue, no triage decisions, no approval status.

**What's needed:**
- Add observer events feed to dashboard
- Show trigger → triage → approval → run flow
- Display active trigger rules and their hit counts
- Show pending approvals

---

### Task 28: Create-Gooseherd Setup Wizard

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — npx create-gooseherd
- `docs/bulletproof_system_architecture_2026-02-21.md` — setup wizard

**Problem:** Installation is manual .env configuration. No guided setup experience.

**What's needed:**
- Interactive CLI wizard: detect available tools, ask for tokens, generate .env
- Auto-detect: Goose binary, GitHub token validity, Slack app existence
- Generate minimal config for "just works" experience

---

### Task 29: Activate Notify Node (Currently Stub)

**Severity:** MEDIUM
**Status:** Intentional stub
**Codex verified:** YES — finding #7: documented placeholder, returns immediate success
**Source docs:**
- `docs/architecture.md` — notify node described as placeholder

**Problem:** Notify node exists in the pipeline but does nothing. Currently notification is handled externally by RunManager's Slack card updates. No webhook, email, or external notification support.

**What's needed:**
- Define what notifications should go here vs RunManager (avoid duplication)
- Options: webhook callback, email notification, custom notification plugins
- Or: formalize it as intentionally handled by RunManager and remove from pipeline

---

## LOW — Nice-to-Haves and Long-Term Vision

### Task 30: Container Isolation for Agent Runs

**Severity:** LOW
**Status:** Not implemented — open decision from earliest research
**Codex verified:** N/A
**Source docs:**
- `docs/minion_system_research_2026-02-17.md` — runner substrate decision unresolved

**Problem:** Agent runs execute directly on host. No sandboxing, no resource limits, no isolation between concurrent runs.

---

### Task 31: Run Events Log and Artifacts Storage

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/hubble_system_blueprint_2026-02-17.md` — run_events, run_artifacts tables

**Problem:** No structured event log for run lifecycle. No content-addressed artifact storage for diffs, logs, agent output.

---

### Task 32: GitHub App Auth (Replace PAT)

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/hubble_system_blueprint_2026-02-17.md` — GitHub App over PAT
- `docs/installation-tiers-research-2026-02-21.md` — GitHub App auth

**Problem:** Uses personal access token. GitHub App would provide better security, per-repo permissions, and higher rate limits.

---

### Task 33: Token Usage Tracking

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — token/cost tracking

**Problem:** No visibility into LLM token consumption per run. Can't track costs or set budgets.

---

### Task 34: Multi-Tenant Team Support

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — multi-tenant teams

**Problem:** Single-tenant only. No team isolation, no per-team config, no team-scoped runs.

---

### Task 35: Dashboard Authentication

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — dashboard auth

**Problem:** Dashboard is open to anyone who can reach the URL. No auth, no access control.

---

### Task 36: Clone Progress Indicator in Slack

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/slack-ux-issues.md` — open issue (Low)

**Problem:** Large repo clones can take minutes with no feedback. User sees "Queued" then nothing until implementation starts.

---

### Task 37: Help Command Discoverability (App Home Tab)

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/slack-ux-issues.md` — open issue (Low)

**Problem:** Users must know to type `@bot help`. No Slack App Home tab with documentation and quick-start guide.

---

## Housekeeping Task: Update architecture.md

**Severity:** LOW (but should be done alongside any implementation)
**Source:** `docs/architecture.md` agent findings

**Stale items to fix:**
- Test count: says 220, reality is 259
- 3 test file names are incorrect
- Memory architecture doesn't reflect MemoryProvider refactor
- File map missing: `logger.ts`, `local-trigger.ts`, `error-parser.ts`, `gate-report.ts`, `hooks/run-lifecycle.ts`, `memory/provider.ts`

---

## Summary Stats

| Severity | Count | Description |
|----------|-------|-------------|
| ~~CRITICAL~~ | ~~3~~ | ~~Agent is blind, mute, and generic~~ **DONE** |
| ~~HIGH~~ | ~~8~~ | ~~Dead code, stubs, missing wiring~~ **ALL DONE** |
| ~~MEDIUM-HIGH~~ | ~~7~~ | ~~Adoption blockers, missing polish~~ **ALL DONE** |
| MEDIUM | 11 → 7 | Vision features not yet built |
| LOW | 8 | Nice-to-haves, long-term |
| Housekeeping | 1 | Doc staleness |
| **Completed** | **25** | |
| **Remaining** | **12** | |

---

## Codex-Verified Findings Cross-Reference

These gaps were confirmed by reading actual source code (not just docs):

| Codex # | Task # | What Was Found | Status |
|---------|--------|----------------|--------|
| #1 | ~~Task 4~~ | Per-repo pipeline override | **FIXED** |
| #2 | ~~Task 5~~ | Observer approval buttons | **FIXED** |
| #3 | ~~Task 6~~ | Smart triage pipeline hint | **FIXED** |
| #4 | ~~Task 8~~ | Single MCP slot | **FIXED** |
| #5 | ~~Task 16~~ | Memory: flat one-liner | **FIXED** |
| #6 | ~~Task 14~~ | Dashboard URL: localhost | **FIXED** |
| #7 | Task 29 | Notify node: intentional stub | Open |
| #8 | Task 25 | Config: loaded once at startup | Open |
| #9 | ~~Task 2~~ | Agent output analysis | **FIXED** |
| #10 | N/A | Follow-up template | No gap |
| N/A | ~~Task 10~~ | Browser-verify: no screenshots | **FIXED** |
