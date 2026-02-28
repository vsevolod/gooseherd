# Browser Verify Model Testing Results

## Goal
Find a working, cheap model for Stagehand browser verification agent.

**Test flow**: Homepage → /user/edit (redirect) → Sign up → Fill credentials → Auto-login → /user/edit → Verify
**Target URL**: https://643.stg.epicpxls.com (PR #643 — "Curated collections" heading change)

## Production Config (Recommended)

```env
# Primary model — best value: honest, capable, $0.02/run
BROWSER_VERIFY_MODEL=openai/gpt-4.1-mini
OPENAI_API_KEY=sk-...

# Fallback for OpenRouter models (xAI, Gemini, etc.)
OPENROUTER_API_KEY=sk-or-...

# Optional: Anthropic for highest quality ($0.30/run)
# BROWSER_VERIFY_MODEL=anthropic/claude-sonnet-4-6
# ANTHROPIC_API_KEY=sk-ant-...
```

### API Routing (automatic in browser-verify-node.ts)

| Model prefix | Routes to | Env var needed |
|---|---|---|
| `openai/*`, `gpt-*`, `o1*`, `o3*`, `o4*` | Direct OpenAI | `OPENAI_API_KEY` |
| `anthropic/*` | Direct Anthropic | `ANTHROPIC_API_KEY` |
| Everything else (`x-ai/*`, `google/*`, etc.) | OpenRouter | `OPENROUTER_API_KEY` |

## Requirements
1. Must support `tool_choice: "required"` (Stagehand's `handleDoneToolCall` hardcodes it)
2. Must complete multi-step browser flows in ≤15 steps
3. Must produce honest structured verdict output (no hallucinations)
4. Must be available via direct API or OpenRouter

## Test Results (Session 3 — Clean Form Filling, Direct API)

**Key fix**: Cleaner task instructions — explicit field values, no `\!` escaping, `@gmail.com` domain.

| # | Model | API | Duration | Actions | Video | Signup | Auto-Login | /user/edit | Verdict | Notes |
|---|-------|-----|----------|---------|-------|--------|------------|-------------|---------|-------|
| 12 | **gpt-4.1-mini** | **Direct OpenAI** | **45.2s** | **20** | **52 frames** | **YES** | **YES** | Blocked (confirmable) | FAIL (honest) | Full flow works; /user/edit blocked by Devise confirmable |
| 13 | **gpt-4o** | **Direct OpenAI** | **46.8s** | **20** | **yes** | **YES** | **YES** | Blocked (confirmable) | FAIL (honest) | Same result as gpt-4.1-mini |
| 14 | x-ai/grok-4-fast | OpenRouter | 3.3s | 0 | 9 frames | - | - | - | NONE | OpenRouter $50/mo credit limit exhausted |
| 15 | google/gemini-2.5-flash-lite | OpenRouter | 3.3s | 0 | - | - | - | - | NONE | Same credit limit issue |

### Session 3 Conclusions
- **Signup + auto-login WORKS** — user was correct, previous sessions had broken form filling (escaped `\!`, wrong email domain)
- **Devise `confirmable`** blocks `/user/edit` for unconfirmed accounts — visible in screenshot banner: "Please confirm your email account"
- Both GPT-4.1-mini and GPT-4o perform identically; GPT-4.1-mini is 3x cheaper
- xAI/Gemini untestable — OpenRouter monthly credit limit hit

## Test Results (Session 2 — Direct API Testing)

| # | Model | API | Duration | Actions | Video Frames | Signup | Login | Edit Page | Verdict | Issue |
|---|-------|-----|----------|---------|--------------|--------|-------|-----------|---------|-------|
| 1 | kimi-k2.5 + gemini exec | OpenRouter | 65.7s | 11 | 114 (113KB) | Partial | No | No | FAIL (honest) | Email filled, passwords empty, "is invalid" |
| 2 | gemini-2.5-flash | OpenRouter | 14.1s | 4 | 15 | No | No | No | **FALSE PASS** | Hallucinated success — screenshot shows empty form |
| 3 | claude-sonnet-4-6 | OpenRouter | 122.6s | - | - | - | - | - | TIMEOUT | Credit limit / timeout |
| 4 | gpt-4.1-mini | OpenRouter | 3.5s | 0 | 9 | - | - | - | NONE | OpenRouter credit limit hit |
| 5 | kimi-k2.5 | OpenRouter | 2.8s | 0 | - | - | - | - | NONE | OpenRouter credit limit hit |
| 6 | **gpt-4.1-mini** | **Direct OpenAI** | **58.7s** | **23** | **211** | **YES** | **YES** | No | FAIL (honest) | Couldn't find edit page nav |
| 7 | gpt-4.1-mini | Direct OpenAI | 34.3s | ~8 | - | YES | No | Error | FAIL (honest) | /user/edit "not public" error |
| 8 | gpt-4.1-mini | Direct OpenAI | 31.0s | ~6 | No | No | Error | - | FAIL (honest) | Test creds don't exist on staging |
| 9 | gpt-4.1-mini | Direct OpenAI | 62.9s | ~8 | - | No | No | No | FAIL (honest) | Test creds don't exist |
| 10 | gpt-4.1-mini | Direct OpenAI | 32.0s | ~8 | - | YES | No | Error | FAIL (honest) | Broken form filling (\! escaping) |
| 11 | gpt-4.1-mini | Direct OpenAI | 28.6s | ~7 | - | YES | No | N/A | FAIL (honest) | Broken form filling (\! escaping) |

## Test Results (Session 1 — OpenRouter Only)

| # | Model (logic) | Model (execution) | Result | Actions | Duration | Issue |
|---|---------------|-------------------|--------|---------|----------|-------|
| 1 | anthropic/claude-sonnet-4-6 | (same) | FAIL | 13 | ~60s | OpenRouter monthly limit hit |
| 2 | google/gemini-2.5-flash | (same) | PARTIAL | 22 | 44s | No structured verdict, vision fallback |
| 3 | qwen/qwen3.5-flash-02-23 | gemini-2.5-flash | FAIL | 3 | ~10s | `tool_choice` unsupported |
| 4 | openai/gpt-5.3-codex | qwen/qwen3.5-flash-02-23 | PARTIAL | 5 | ~15s | Didn't complete flow |
| 5 | qwen/qwen3.5-35b-a3b | gemini-2.5-flash | FAIL | 2 | ~8s | `tool_choice` unsupported |
| 6 | qwen/qwen3.5-flash-02-23 | (same) | FAIL | 3 | ~10s | `tool_choice` unsupported |

## Key Findings

### Staging App: Devise Confirmable
The staging app (643.stg.epicpxls.com) **auto-logs in after signup** but requires **email confirmation** (Devise `confirmable`) before accessing protected pages like `/user/edit`. Banner says: "Please confirm your email account." This is an app-level restriction, not a model limitation.

### Model Verdict Honesty
- **GPT-4.1-mini**: Always gives honest FAIL verdicts with accurate reasoning. Best model.
- **GPT-4o**: Same honesty, slightly more expensive (3x cost).
- **Gemini-2.5-flash**: **HALLUCINATED a PASS** — claimed success with screenshot showing empty form. Unreliable.
- **Kimi-k2.5**: Honest FAIL but couldn't complete form fill (passwords left empty).

### tool_choice Compatibility (Stagehand Requirement)
Stagehand's V3 agent uses `toolChoice: "auto"` in main loop and hardcodes `toolChoice: { type: "tool", toolName: "done" }` in `handleDoneToolCall`. Models MUST support the `type_function` tool_choice parameter.

| Model | tool_choice Support | Notes |
|-------|-------------------|-------|
| openai/gpt-4.1-mini | YES | Direct OpenAI or OpenRouter — **RECOMMENDED** |
| openai/gpt-4o | YES | Direct OpenAI — works, 3x cost of mini |
| openai/gpt-5-nano | YES | $0.05/$0.40 — cheapest OpenAI, untested |
| x-ai/grok-4-fast | YES | $0.20/$0.50 on OpenRouter — untested (credits exhausted) |
| x-ai/grok-code-fast-1 | YES | $0.20/$1.50 on OpenRouter — untested |
| google/gemini-2.5-flash | YES | **UNRELIABLE** — hallucinated verdicts |
| google/gemini-2.5-flash-lite | YES | $0.10/$0.40 on OpenRouter — untested (credits exhausted) |
| anthropic/claude-sonnet-4-6 | YES | Best quality, expensive ($3/$15) |
| moonshotai/kimi-k2.5 | YES (Chutes) | Partial form fill issues |
| qwen/* | NO | Primary endpoints don't support it |
| deepseek/* | NO | Lacks native structured output |

### Cost Comparison
| Model | Input $/1M | Output $/1M | Est. per run | Verdict Quality |
|-------|-----------|-------------|-------------|-----------------|
| gpt-4.1-mini | $0.40 | $1.60 | ~$0.02 | Excellent (honest) |
| gpt-4o | $2.50 | $10.00 | ~$0.06 | Excellent (honest) |
| gpt-5-nano | $0.05 | $0.40 | ~$0.005 | Untested |
| x-ai/grok-4-fast | $0.20 | $0.50 | ~$0.01 | Untested |
| gemini-2.5-flash | $0.15 | $0.60 | ~$0.01 | BAD (hallucinations) |
| claude-sonnet-4-6 | $3.00 | $15.00 | ~$0.30 | Best |

## Stagehand Recommended Models

From Stagehand docs and source code analysis:
- **Production default**: `google/gemini-2.0-flash` (in their example configs)
- **DOM agent mode**: Uses `toolChoice: "auto"` — compatible with most models
- **CUA mode**: Only specific models (Claude, GPT-4o CUA variants)
- **Kimi special handling**: Stagehand has prompt-based JSON fallback for Kimi models
- **DeepSeek**: Explicitly unsupported for structured output
- **xAI**: `xai/grok-4-fast-reasoning` explicitly listed in Stagehand model support

## Models Still To Test (blocked by OpenRouter credits)

When OpenRouter credits reset or direct API keys are available:
1. `x-ai/grok-4-fast` — $0.20/$0.50, Stagehand-endorsed, likely excellent
2. `x-ai/grok-code-fast-1` — $0.20/$1.50, optimized for code tasks
3. `google/gemini-2.5-flash-lite` — $0.10/$0.40, cheapest option if verdicts are honest
4. `openai/gpt-5-nano` — $0.05/$0.40, potentially best value if it handles the flow
