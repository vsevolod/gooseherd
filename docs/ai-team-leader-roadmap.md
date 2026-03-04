# AI Team Leader / Smart Orchestrator Roadmap

## Vision

Replace static YAML pipeline execution with an **LLM-powered orchestrator** that dynamically decides what steps to run based on context. Instead of every request following a fixed pipeline, a "team leader" agent classifies the request, selects or constructs a pipeline, delegates to sub-agents, and adapts on failure.

## Current State

### What We Have
- **Pipeline engine** (`pipeline-engine.ts`) — executes static YAML DAGs with on_failure retry loops
- **19 node handlers** — each a specialized TypeScript function (clone, agent, browser_verify, fix_browser, etc.)
- **Context bag** — mutable shared state flowing through every node
- **Smart triage** (`observer/smart-triage.ts`) — proto-orchestrator that classifies events as trigger/discard/defer/escalate
- **callLLMWithTools** (`llm/caller.ts`) — general-purpose tool-calling loop, ready for orchestrator use

### What's Missing
- **No "think before acting"** — every Slack mention hard-codes to `parseCommand() → enqueueRun()`
- **No request classification** — can't distinguish "question" from "code change" from "status query"
- **No dynamic pipeline construction** — no way for an LLM to say "for this, I need [clone, read_file, reply]"
- **No lightweight response path** — answering a question always spawns a full pipeline run
- **No sub-agent delegation** — team leader can't spawn focused mini-agents for specific subtasks

## Architecture Sketch

```
Any input (Slack, webhook, API, dashboard)
  → Orchestrator.receive(input)
    |
    v
  [LLM Router: "What kind of request is this?"]
    |
    +── "question" ────────→ InformationAgent (clone, read, reply to Slack)
    +── "code_change" ─────→ PipelineEngine.execute(dynamically chosen pipeline)
    +── "conversation" ────→ ConversationAgent (multi-turn Slack dialogue)
    +── "status_query" ────→ DirectReply (query store, reply)
    +── "meta_operation" ──→ ToolAgent (create repo, configure CI, etc.)
```

### Two Approaches to Dynamic Pipelines

1. **Template selection** (easier): LLM picks from existing YAML presets (`default.yml`, `with-preview.yml`, etc.) based on request analysis. Can also modify parameters (skip browser_verify for docs-only changes).

2. **Runtime composition** (harder): LLM constructs a `PipelineConfig` object in memory — picks which nodes to include, sets their config, defines dependencies. Full dynamic control.

### Decision Node Concept

```yaml
# New node type in pipeline YAML
- id: team_leader
  action: decide_next_step
  config:
    model: openai/gpt-4.1-mini
    context_keys: [changedFiles, browserVerdict, ciStatus, lastError]
    # Returns: {nextSteps: ["fix_css", "retry_browser_verify"], skipSteps: [...]}
```

The team leader node:
1. Receives full `ContextBag` (last failure, browser verdict, CI status, changed files)
2. Calls LLM with structured prompt: "Given this state, what should we do next?"
3. Returns `NodeResult` with instructions the engine interprets to modify remaining execution

## Phases

### Phase 1: Request Classification (LLM Router)
**New file: `src/orchestrator/orchestrator.ts`**

- Classify incoming requests: question / code_change / conversation / status_query
- Route questions to a lightweight read-only agent (no pipeline needed)
- Route code changes to pipeline engine with appropriate preset
- Support multi-turn Slack conversations

**Depends on**: `callLLMWithTools` (already exists), `smart-triage.ts` (extend)

### Phase 2: Dynamic Pipeline Selection
- LLM chooses which pipeline preset to use based on request analysis
- Can modify pipeline parameters (e.g., skip browser_verify for README changes)
- Falls back to `default.yml` if uncertain

### Phase 3: Decision Node in Pipeline
- New `decide_next_step` node handler
- Engine supports mid-execution plan modification
- Team leader can insert/skip/reorder remaining nodes

### Phase 4: Sub-Agent Delegation
- Team leader spawns focused sub-agents for specific tasks
- Each sub-agent gets a scoped context (not full pipeline state)
- Results feed back into team leader's decision-making

### Phase 5: Multi-Agent Review
- Multiple AI reviewers assess code changes
- Consensus/voting mechanism (inspired by Relay's ConsensusEngine)
- Configurable quorum rules

## External Framework Assessment

### AgentWorkforce/Relay (v2.3.14, Rust+TypeScript)
**Assessed 2026-02-28. Verdict: Don't adopt. Take inspiration.**

- Relay is inter-agent *messaging* infrastructure (PTY-based), not a dynamic orchestration engine
- Its workflow runner (static YAML DAGs) is LESS capable than our pipeline engine
- No dynamic step injection, no shared context bag, cloud dependency
- **Useful patterns to steal**:
  - 24 swarm topologies (supervisor, reflection, review-loop, fan-out)
  - Non-interactive agent execution (`claude -p "task"` one-shot pattern)
  - Consensus/voting engine (~500 lines, clean implementation)
  - Idle detection + nudging for stuck agents

### Other Frameworks Considered
| Framework | Language | Dynamic Decisions | Fit | Notes |
|-----------|----------|-------------------|-----|-------|
| LangGraph | Python/JS | Yes (state machines) | Medium | Closest to AI team leader concept |
| CrewAI | Python | Partial | Low | Python-only, too opinionated |
| AutoGen | Python | Yes | Low | Strong multi-agent, but Python |
| **Build it ourselves** | **TypeScript** | **Full control** | **High** | **Extends existing pipeline engine** |

## Key Design Decisions

1. **Build, don't integrate** — Our pipeline engine already handles the hard parts (sandbox, Docker, on_failure loops, context bag). Adding an LLM decision layer on top is far less risky than replacing the engine with an external framework.

2. **Incremental rollout** — Phase 1 (classification) delivers immediate value (answer questions without full pipeline). Each phase is independently useful.

3. **Keep YAML pipelines** — Static pipelines work great for well-defined flows. The team leader adds intelligence for ambiguous or complex scenarios, not replace the simple path.

4. **GPT-4.1-mini for decisions** — At $0.02/call, the router/decision calls are essentially free. No need for expensive models for classification.

## Related Files
- `src/observer/smart-triage.ts` — proto-orchestrator (event classification)
- `src/llm/caller.ts` — `callLLMWithTools` for tool-calling loops
- `src/pipeline/pipeline-engine.ts` — execution engine to extend
- `docs/configurable-pipeline-engine-research.md` — `plan_task` node research
- `docs/bulletproof_system_architecture_2026-02-21.md` — system evolution vision
