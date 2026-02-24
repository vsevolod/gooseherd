# Slack UX Issues & Improvements

Tracking file for Slack bot interaction issues discovered during testing.

## Fixed

### 1. Natural command format not supported
- **Date**: 2026-02-24
- **Issue**: `@bot epiccoders/pxls Add hover animation` returned "Unknown command"
- **Expected**: Bot should parse `owner/repo task` naturally without requiring `run owner/repo | task`
- **Fix**: Updated `command-parser.ts` to detect leading repo slugs and parse natural format
- **Status**: FIXED

### 2. ENOENT for run.log on first pipeline execution
- **Date**: 2026-02-24
- **Issue**: `ENOENT: no such file or directory, open '.work/<run-id>/run.log'`
- **Cause**: Pipeline engine logged to `run.log` before the clone node created the directory
- **Fix**: Added `mkdir` + initial log write in `pipeline-engine.ts execute()` before pipeline starts
- **Status**: FIXED

## Open

### 3. Error message not helpful for users
- **Symptom**: When a run fails, the Slack card shows raw error messages like `ENOENT: no such file or directory`
- **Improvement**: Show user-friendly error messages with actionable hints
- **Priority**: Medium

### 4. No progress indicator during cloning
- **Symptom**: The Slack card shows "cloning repo" with a spinner but no ETA or repo size hint
- **Improvement**: Could show clone progress or at least "cloning [repo]..."
- **Priority**: Low

### 5. Help text could be more discoverable
- **Symptom**: Users try natural language first; help text only shown when they type "help"
- **Improvement**: On first interaction in a channel, post a brief "getting started" hint
- **Priority**: Low

### 6. Dashboard URL in Slack card uses local address
- **Symptom**: `http://127.0.0.1:8787` in Slack buttons is not accessible to remote users
- **Improvement**: Add `DASHBOARD_PUBLIC_URL` config for the Slack card link
- **Priority**: Medium
