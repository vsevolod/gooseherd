# Progress Log

- Initialized planning files and scope.
- Gathered benchmark metrics from WebArena leaderboard, VisualWebArena, WebVoyager, BrowserArena, Mind2Web, Online-Mind2Web, WebCanvas, and SoM prompting paper.
- Gathered architecture data from Stagehand, Playwright MCP, browser-use, Cursor browser docs, OpenHands browser integration docs.
- Gathered deployment/cost references from Anthropic model pricing, vision tokenization docs, and computer-use demo Docker setup.
- Synthesized findings into architecture recommendations with explicit tradeoffs for DOM vs vision vs computer-use.
- Added primary-source checks for OpenAI computer-use docs, Anthropic Claude Opus 4.6 System Card use-tool benchmarks, and Google Project Mariner benchmark claims.

## Session: CDP Video + Model Testing (2026-02-28)

### CDP Video Recording (COMPLETE)
- Created `cdp-screencast.ts` — CdpScreencast class using Chrome DevTools Protocol
- Wired into `stagehand-verify.ts` — start before navigate, stop+encode after agent
- Updated `browser-verify-node.ts` — propagates `videoPath` to context
- Dashboard auto-discovers `.mp4` files in runDir (zero changes needed)
- Updated Dockerfile with chromium + ffmpeg for deployment
- Fixed 4 CDP bugs: frame sequencing, dimension padding, pendingWrites drain, start_number

### Model Testing (COMPLETE — 17 tests across 2 sessions)
- **Winner: `openai/gpt-4.1-mini`** via direct OpenAI API
  - Honest verdicts, 23 actions max, ~$0.02/run, 58.7s typical
  - Only failed at staging app limitations (email confirmation required)
- **DON'T USE: `google/gemini-2.5-flash`** — hallucinated PASS verdict
- **Qwen models**: ALL fail (tool_choice unsupported)
- **Staging app blocker**: 643.stg.epicpxls.com doesn't auto-login after signup
- Full results: `docs/model-testing.md`

### Production Code Changes
- Added `OPENAI_API_KEY` to config.ts (env schema + AppConfig + loadConfig)
- Updated `browser-verify-node.ts` API routing: anthropic/* → Anthropic, openai/* → OpenAI, else → OpenRouter
- Updated `scripts/test-browser-verify.ts` with same routing logic
