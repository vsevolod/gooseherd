# Gooseherd — LLM Cost Report

## Model Pricing (OpenRouter)

| Model | Used For | Input $/M tokens | Output $/M tokens |
|-------|----------|------------------:|-------------------:|
| `anthropic/claude-sonnet-4-6` | Default agent, plan_task, scope_judge, browser_verify, generate_title, summarize_changes | $3.00 | $15.00 |
| `openai/gpt-4.1-mini` | Orchestrator chat, decide_next_step fallback | $0.40 | $1.60 |
| `z-ai/glm-5` | decide_next_step primary | $0.80 | $2.56 |

*Prices sourced from OpenRouter API on 2026-03-06.*

## Cost Per Pipeline Node (Estimated)

These are estimated costs per node invocation based on typical token usage:

| Node | Model | Typical Input Tokens | Typical Output Tokens | Est. Cost |
|------|-------|---------------------:|----------------------:|----------:|
| `generate_title` | claude-sonnet-4-6 | ~200 | ~30 | $0.001 |
| `plan_task` | claude-sonnet-4-6 | ~1,500 | ~500 | $0.012 |
| `scope_judge` | claude-sonnet-4-6 | ~3,000 | ~300 | $0.014 |
| `summarize_changes` | claude-sonnet-4-6 | ~2,000 | ~300 | $0.011 |
| `decide_next_step` | z-ai/glm-5 | ~2,000 | ~200 | $0.002 |
| `browser_verify` (plan) | claude-sonnet-4-6 | ~1,000 | ~200 | $0.006 |
| `browser_verify` (vision) | claude-sonnet-4-6 | ~2,000 | ~300 | $0.011 |
| `implement` (pi-agent) | claude-sonnet-4-6 | ~50,000 | ~5,000 | $0.225 |
| **Orchestrator** (per message) | gpt-4.1-mini | ~2,000 | ~500 | $0.002 |

## Estimated Cost Per Run Type

| Run Type | Pipeline Nodes Hit | Est. Gate Cost | Est. Agent Cost | **Total** |
|----------|-------------------|---------------:|----------------:|----------:|
| **Simple change** (no browser verify) | title, plan, implement, scope, summarize | $0.04 | $0.20–0.50 | **$0.25–0.55** |
| **UI change** (with browser verify) | + deploy_preview, browser_verify, decide | $0.06 | $0.20–0.50 | **$0.27–0.57** |
| **Complex with auth** (browser verify + fix loop) | + fix_browser × 2, browser_verify × 3, decide × 3 | $0.10 | $0.40–1.00 | **$0.50–1.10** |
| **Orchestrator Q&A** (chat, no pipeline) | orchestrator only | $0.01 | — | **$0.01** |

## How Cost Is Tracked

1. **Gate tokens**: Each LLM-calling node stores `_tokenUsage_{node}` entries in the ContextBag with `{ input, output, model }`
2. **Agent tokens**: The `implement` node extracts pi-agent cost from JSONL output (already in USD from Anthropic API)
3. **Aggregation**: `aggregateTokenUsage()` combines all entries, computes gate cost from the price table, adds agent cost
4. **Display**: Dashboard shows `$X.XXXX` cost chip per run alongside token counts

## Cost Controls

- **Orchestrator**: `gpt-4.1-mini` at $0.40/$1.60 per M — 7.5× cheaper than Sonnet for chat
- **Decision node**: `z-ai/glm-5` at $0.80/$2.56 per M — cheap for structured JSON decisions
- **Token budgets**: `maxInputTokens` on agent tool-use loop prevents runaway costs
- **Wall-clock timeout**: 5-minute default prevents stuck agents from burning tokens
- **Scope judge**: Prevents agents from doing unnecessary work (out-of-scope detection)

## Test Runs

_To be populated after running test scenarios on epiccoders/pxls._

| Run ID | Scenario | Gate Tokens | Agent Tokens | Cost | Duration |
|--------|----------|------------:|-------------:|-----:|---------:|
| | Q&A back-and-forth | | | | |
| | Homepage change + browser verify | | | | |
| | Auth/signup + browser verify | | | | |
