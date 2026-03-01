# Task Plan: CDP Console & Network Capture + Dashboard Display

## Goal
Add CDP console log capture and network request capture alongside CdpScreencast, write to JSON files in the run directory, and display in the dashboard as a Browserbase-style tabbed session viewer.

## Architecture Decisions
- Follow CdpScreencast pattern: same CdpSession interface, same start/stop lifecycle, same runDir output
- Console logs → `console-logs.json` in runDir
- Network requests → `network-log.json` in runDir
- Agent actions → `agent-actions.json` in runDir (type, reasoning, pageUrl, timestamp)
- Dashboard: extend `/api/runs/:id/media` response to include `consoleLogs`, `networkLog`, `agentActions`
- Dashboard UI: Browserbase-style tabbed "Browser session" card with Replay | Actions | Console | Network tabs
- Non-fatal: all capture is best-effort, never blocks verification

## Key Files
| File | Role |
|------|------|
| `src/pipeline/quality-gates/cdp-screencast.ts` | Pattern to follow (CdpSession, start/stop, writeFile) |
| `src/pipeline/quality-gates/cdp-console-capture.ts` | NEW — console log capture |
| `src/pipeline/quality-gates/cdp-network-capture.ts` | NEW — network request capture |
| `src/pipeline/quality-gates/stagehand-verify.ts` | Wiring point (alongside screencast) + agent actions save |
| `src/pipeline/quality-gates/browser-verify-node.ts` | Context bag propagation |
| `src/dashboard-server.ts` | Media API + HTML + CSS + JS (tabbed session viewer) |
| `tests/cdp-console-capture.test.ts` | NEW — 9 tests |
| `tests/cdp-network-capture.test.ts` | NEW — 11 tests |

## Phases

### Phase 1: CdpConsoleCapture (TDD) — `complete`
- [x] Write tests: start/stop, log capture with types (log/warn/error/info), JSON save, idempotent stop, serializes args
- [x] Implement `CdpConsoleCapture` class
- [x] Run tests, verify pass (9/9 pass)
- [x] Codex-investigator review

### Phase 2: CdpNetworkCapture (TDD) — `complete`
- [x] Write tests: start/stop, request+response pairing by requestId, JSON save, timing calculation, failed requests, redirect chains
- [x] Implement `CdpNetworkCapture` class
- [x] Run tests, verify pass (11/11 pass)
- [x] Codex-investigator review — found and fixed: redirect chain data loss, partial startup leak, renamed `pending` → `requests`

### Phase 3: Wire into stagehand-verify.ts — `complete`
- [x] Start console + network capture alongside screencast (per-capture try/catch)
- [x] Stop + save in finally block
- [x] Return consolePath + networkPath in result object
- [x] Store in context bag (browser-verify-node.ts)

### Phase 4: Dashboard API + UI — `complete`
- [x] Extend `/api/runs/:id/media` to scan for console-logs.json and network-log.json
- [x] Add collapsible "Console logs" panel (filterable by level: all/error/warning)
- [x] Add collapsible "Network requests" table (URL, method, status, duration, size)
- [x] Color-code: errors=red, warnings=yellow, slow requests highlighted

### Phase 5: Integration test — `complete`
- [x] Rebuild Docker image
- [x] Run test-browser-verify-docker.mjs — PASS verdict, 806KB video, 209 frames
- [x] Verify console-logs.json (7 entries, all info) + network-log.json (63 requests) generated
- [x] Dashboard: to verify visually, start dashboard and select a run with these files

### Phase 6: Browserbase-style dashboard redesign — `complete`
- [x] Save Stagehand agent actions to `agent-actions.json` (type, reasoning, pageUrl, timestamp, detail fields)
- [x] Add `actionsPath` to `StagehandVerifyResult` + context bag propagation
- [x] Extend media API to serve `agentActions` from `agent-actions.json`
- [x] Replace collapsible `<details>` panels with tabbed "Browser session" card
- [x] **Replay tab**: video player + screenshot grid (unchanged logic, cleaner layout)
- [x] **Actions tab**: numbered table with color-coded type pills (goto/act/screenshot/extract/done), reasoning, page links
- [x] **Console tab**: filter buttons (All/Errors/Warnings), color-coded entries (info=blue, warning=yellow, error=red)
- [x] **Network tab**: clean table with URL, Method, Status, Duration, Size; color-coded (green=ok, red=4xx+, yellow=slow)
- [x] CSS: tab bar, tab count badges, action type pills, console entry styles, network table styles
- [x] XSS protection via `escapeHtml()` helper
- [x] Visual verification with mock data — all 4 tabs render correctly
- [x] 28/28 tests pass, TypeScript clean
