/**
 * Parses raw agent logs into structured events for dashboard rendering.
 *
 * Supports two agent formats (auto-detected):
 *
 * 1. Goose (--debug mode) — regex-parsed:
 *   ─── tool_name | extension ──────────────────────────
 *   key: value                    (tool parameters)
 *   <stdout from tool>
 *   Annotated { ... }             (tool result in Rust debug format)
 *   <free text>                   (agent thinking)
 *
 * 2. pi-agent (--mode json) — JSONL-parsed:
 *   {"type":"session","version":3,...}
 *   {"type":"agent_start"}
 *   {"type":"message_start","message":{"role":"assistant","model":"...",...}}
 *   {"type":"message_update","assistantMessageEvent":{"type":"thinking_end",...}}
 *   {"type":"message_end","message":{"role":"toolResult","toolName":"read",...}}
 *   {"type":"agent_end","messages":[...]}
 *
 * Both formats are mixed with pipeline shell commands:
 *   $ command                     (shell commands)
 *   <AppName> run <uuid>          (run header)
 *   [pipeline] node: status       (pipeline status markers)
 */

export type RunEventType =
  | "session_start"
  | "agent_thinking"
  | "tool_call"
  | "shell_cmd"
  | "phase_marker"
  | "pipeline_message"
  | "info";

export interface RunEvent {
  type: RunEventType;
  index: number;
  progressPercent: number;

  // tool_call fields
  tool?: string;
  extension?: string;
  params?: Record<string, string>;

  // shell_cmd fields
  command?: string;

  // session_start fields
  provider?: string;
  model?: string;

  // phase_marker fields
  phase?: string;

  // tool result (extracted from Annotated blocks for memory/cems tools)
  result?: string;

  // Common
  content: string;
}

// ── Pattern matchers ──────────────────────────────────────

const TOOL_HEADER_RE = /^─── (\S+) \| (\S+) ─+$/;
const SHELL_CMD_RE = /^\$ (.+)$/;
const SESSION_START_RE = /^starting session \| provider: (\S+) model: (.+)$/;
const ANNOTATED_START_RE = /^Annotated\s*\{/;
const APP_RUN_RE = /^\w+ run ([\w-]+)$/;
const TOOL_PARAM_RE = /^([a-z_]+): (.+)$/;
const SESSION_META_RE = /^\s+(session id|working directory): .+$/;

const NOISE_PATTERNS = [
  /^---\s*loading\s+\.bash_profile/,
  /All secrets loaded from cache/,
  /^🎊/,
  /^\s*$/,
  /^zsh:\d+: command not found:/,
];

// Patterns that indicate leaked Annotated block content (safety net).
// Covers Rust Debug fields that appear in Goose tool result blocks.
const ANNOTATED_LEAK_RE =
  /^\s*(raw:\s*Text\(|RawTextContent\s*\{|annotations:\s*(Some|None)|Annotations\s*\{|audience:\s*Some\(|priority:\s*Some\(|meta:\s*None)/;

function isNoiseLine(line: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

// ── Annotated block skipper ──────────────────────────────

function skipAnnotatedBlock(lines: string[], startIndex: number): number {
  let depth = 1;
  let i = startIndex + 1;
  while (i < lines.length && depth > 0) {
    const line = lines[i];
    // Safety valve: tool headers never appear inside valid Annotated blocks.
    // If we hit one, the brace counting got confused by interleaved async output.
    if (TOOL_HEADER_RE.test(line)) break;
    // Count braces, but skip braces inside quoted strings.
    // Rust Debug format wraps string values in "..." — braces inside
    // those strings (e.g. CSS, code snippets) must not affect depth.
    let inQuote = false;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '"' && (ci === 0 || line[ci - 1] !== "\\")) {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
    }
    i++;
    if (depth <= 0) break;
  }
  return i;
}

// Tools whose Annotated result blocks should be extracted (not skipped)
const RESULT_CAPTURE_TOOLS = new Set(["memory_search", "memory_add", "memory_forget", "memory_update"]);

/**
 * Extract a human-readable summary from an Annotated block for memory tools.
 * Looks for JSON inside `text: "..."` fields and formats memory results.
 */
function extractAnnotatedResult(lines: string[], startIndex: number): { endIndex: number; summary: string } {
  const collected: string[] = [];
  let depth = 1;
  let i = startIndex + 1;
  while (i < lines.length && depth > 0) {
    const line = lines[i];
    // Safety valve: tool headers never appear inside valid Annotated blocks.
    if (TOOL_HEADER_RE.test(line)) break;
    collected.push(line);
    let inQuote = false;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '"' && (ci === 0 || line[ci - 1] !== "\\")) {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
    }
    i++;
    if (depth <= 0) break;
  }

  // Try to find JSON in the text field
  const blob = collected.join("\n");
  const jsonMatch = blob.match(/text:\s*"(\{.*?\})"/s);
  if (!jsonMatch) return { endIndex: i, summary: "" };

  try {
    // Unescape the Rust debug string (\\n → \n, \\" → ")
    const raw = jsonMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    const data = JSON.parse(raw);

    if (data.results && Array.isArray(data.results)) {
      // memory_search response
      const count = data.count ?? data.results.length;
      const summaryParts = [`${count} result${count !== 1 ? "s" : ""}`];
      if (data.mode) summaryParts.push(`(${data.mode})`);
      if (data.tokens_used) summaryParts.push(`${data.tokens_used} tokens`);

      const resultLines = [summaryParts.join(" ")];
      for (const r of data.results.slice(0, 3)) {
        const score = typeof r.score === "number" ? ` [${Math.round(r.score * 100)}%]` : "";
        const content = (r.content ?? "").slice(0, 150);
        resultLines.push(`  ${score} ${content}${(r.content ?? "").length > 150 ? "..." : ""}`);
      }
      if (data.results.length > 3) {
        resultLines.push(`  ... and ${data.results.length - 3} more`);
      }
      return { endIndex: i, summary: resultLines.join("\n") };
    }

    if (data.success !== undefined) {
      // memory_add / memory_update / memory_forget response
      return { endIndex: i, summary: data.success ? "stored" : "failed" };
    }
  } catch {
    // JSON parse failed — return raw truncated
  }

  return { endIndex: i, summary: "" };
}

/**
 * Find the first memory tool call event that hasn't received a result yet.
 * Used to match orphaned Annotated blocks back to their originating tool call
 * when Goose batches parallel calls (headers first, results later in FIFO order).
 */
function findFirstUnresolvedMemoryEvent(events: RunEvent[]): number | undefined {
  for (let k = 0; k < events.length; k++) {
    if (
      events[k].type === "tool_call" &&
      RESULT_CAPTURE_TOOLS.has(events[k].tool ?? "") &&
      !events[k].result
    ) {
      return k;
    }
  }
  return undefined;
}

// ── pi-agent JSONL detection ─────────────────────────────

/**
 * Detect whether a raw log contains pi-agent JSONL output.
 * Checks for characteristic pi-agent event types in the first few JSON lines.
 */
export function isPiAgentJsonl(rawLog: string): boolean {
  const lines = rawLog.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    // Check for pi-agent-specific event types
    if (
      trimmed.includes('"type":"agent_start"') ||
      trimmed.includes('"type":"session"') ||
      trimmed.includes('"type":"message_start"') ||
      trimmed.includes('"type":"turn_start"')
    ) {
      return true;
    }
    // Stop checking after finding a few non-JSON lines (pipeline output zone)
    break;
  }
  // Also check deeper — pi-agent JSONL may start after pipeline $ commands
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"type":"agent_start"')) {
      return true;
    }
  }
  return false;
}

// ── pi-agent JSONL content types ─────────────────────────
interface PiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface PiUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens: number;
  cost?: { input: number; output: number; total: number };
}

/**
 * Parse pi-agent JSONL output (--mode json) into RunEvent[].
 * Handles mixed logs: pipeline shell commands + JSONL events.
 *
 * Event mapping:
 * - message_start (assistant, first) → session_start with model/provider
 * - message_update thinking_end → agent_thinking
 * - message_update text_end → agent_thinking (assistant text shown as agent output)
 * - message_end (assistant) with toolCall content → tool_call
 * - message_end (toolResult) → attach result to matching tool_call
 * - agent_end → info with cost/token summary
 * - $ command lines → shell_cmd / phase_marker (unchanged regex)
 */
export function parsePiAgentJsonl(rawLog: string): RunEvent[] {
  const lines = rawLog.split("\n");
  const events: RunEvent[] = [];
  let sessionEmitted = false;
  // Map toolCallId → events index for matching tool results
  const toolCallIndex = new Map<string, number>();
  let toolCallCount = 0;
  // Track cumulative usage across turns
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ── Pipeline shell commands (non-JSON lines) ──
    if (!trimmed.startsWith("{")) {
      // Shell command
      const shellMatch = SHELL_CMD_RE.exec(trimmed);
      if (shellMatch) {
        const command = shellMatch[1];
        let phase: string | undefined;
        if (command.includes("git clone")) phase = "cloning";
        else if (command.includes("pi -p") || command.includes("goose run") || command.includes("AGENT_COMMAND")) phase = "agent";
        else if (command.includes("git push")) phase = "pushing";
        else if (command.includes("git add") || command.includes("git commit")) phase = "committing";

        events.push({
          type: phase ? "phase_marker" : "shell_cmd",
          index: 0,
          progressPercent: 0,
          command,
          phase,
          content: `$ ${command}`,
        });
        continue;
      }
      // App run header
      const appRunMatch = APP_RUN_RE.exec(trimmed);
      if (appRunMatch) {
        events.push({ type: "info", index: 0, progressPercent: 0, content: trimmed });
        continue;
      }
      // Pipeline status markers [pipeline] node: status
      if (trimmed.startsWith("[pipeline]")) {
        const pipelineText = trimmed.slice("[pipeline]".length).trim();
        // Classify message: success, failure, warning, or neutral
        let pipelineLevel: string = "info";
        if (/\bsuccess\b|\bresolved\b/i.test(pipelineText)) pipelineLevel = "success";
        else if (/\bfail|\berror\b|\bexhausted\b/i.test(pipelineText)) pipelineLevel = "error";
        else if (/\bwarn|\bskip|\bno changes\b/i.test(pipelineText)) pipelineLevel = "warn";
        events.push({
          type: "pipeline_message",
          index: 0,
          progressPercent: 0,
          content: pipelineText,
          phase: pipelineLevel
        });
        continue;
      }
      // Skip other non-JSON noise
      continue;
    }

    // ── Parse JSONL event ──
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // Skip malformed JSON
    }

    const eventType = event.type as string;

    // ── session — emit session_start ──
    if (eventType === "session" && !sessionEmitted) {
      // Don't emit yet — wait for first assistant message_start which has model info
      continue;
    }

    // ── message_start — extract model/provider from first assistant message ──
    if (eventType === "message_start") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg && msg.role === "assistant" && !sessionEmitted) {
        const provider = (msg.provider as string) ?? "unknown";
        const model = (msg.model as string) ?? "unknown";
        sessionEmitted = true;
        events.push({
          type: "session_start",
          index: 0,
          progressPercent: 0,
          provider,
          model,
          content: `Session started with ${provider} / ${model}`,
        });
      }
      continue;
    }

    // ── message_update — extract completed thinking/text blocks ──
    if (eventType === "message_update") {
      const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!ame) continue;

      const subType = ame.type as string;

      if (subType === "thinking_end") {
        const content = (ame.content as string) ?? "";
        if (content.trim()) {
          events.push({
            type: "agent_thinking",
            index: 0,
            progressPercent: 0,
            content: content.trim(),
          });
        }
      } else if (subType === "text_end") {
        const content = (ame.content as string) ?? "";
        if (content.trim()) {
          events.push({
            type: "agent_thinking",
            index: 0,
            progressPercent: 0,
            content: content.trim(),
          });
        }
      }
      continue;
    }

    // ── message_end — extract tool calls and tool results ──
    if (eventType === "message_end") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      if (msg.role === "assistant") {
        // Extract tool calls from content array
        const content = msg.content as Array<Record<string, unknown>> | undefined;
        if (!content || !Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === "toolCall") {
            const toolName = (block.name as string) ?? "unknown";
            const args = (block.arguments as Record<string, unknown>) ?? {};
            const callId = (block.id as string) ?? "";
            toolCallCount++;

            // Build readable summary
            let summary = toolName;
            if (args.path) summary = `${toolName}: ${shortenPath(String(args.path))}`;
            else if (args.command) summary = `${toolName}: ${String(args.command).slice(0, 100)}`;
            else if (args.pattern) summary = `${toolName}: "${String(args.pattern).slice(0, 80)}"`;

            // Truncate args for params display
            const params: Record<string, string> = {};
            for (const [k, v] of Object.entries(args)) {
              params[k] = String(v).slice(0, 200);
            }

            const idx = events.length;
            events.push({
              type: "tool_call",
              index: 0,
              progressPercent: 0,
              tool: toolName,
              extension: "pi-agent",
              params,
              content: summary,
            });
            if (callId) toolCallIndex.set(callId, idx);
          }
        }

        // Track usage from assistant message_end
        const usage = msg.usage as PiUsage | undefined;
        if (usage) {
          totalInput += usage.input ?? 0;
          totalOutput += usage.output ?? 0;
          if (usage.cost) totalCost += usage.cost.total ?? 0;
        }
      } else if (msg.role === "toolResult") {
        // Attach result to matching tool_call
        const callId = (msg.toolCallId as string) ?? "";
        const toolName = (msg.toolName as string) ?? "";
        const resultContent = msg.content as Array<Record<string, unknown>> | undefined;

        let resultText = "";
        if (Array.isArray(resultContent)) {
          for (const block of resultContent) {
            if (block.type === "text") {
              resultText += (block.text as string) ?? "";
            }
          }
        }

        // Truncate result for display
        if (resultText.length > 300) {
          resultText = resultText.slice(0, 300) + "...";
        }

        // Find matching tool call event
        const matchIdx = toolCallIndex.get(callId);
        if (matchIdx !== undefined && events[matchIdx]) {
          events[matchIdx].result = resultText;
        } else if (resultText && toolName) {
          // Fallback: find last tool_call with matching name that has no result
          for (let k = events.length - 1; k >= 0; k--) {
            if (events[k].type === "tool_call" && events[k].tool === toolName && !events[k].result) {
              events[k].result = resultText;
              break;
            }
          }
        }
      }
      continue;
    }

    // ── agent_end — extract final cost/token summary ──
    if (eventType === "agent_end") {
      const costStr = totalCost > 0 ? `$${totalCost.toFixed(4)}` : "";
      const tokenStr = totalInput + totalOutput > 0
        ? `${totalInput} in / ${totalOutput} out`
        : "";
      const parts = [costStr, tokenStr].filter(Boolean);

      events.push({
        type: "info",
        index: 0,
        progressPercent: 0,
        content: parts.length > 0
          ? `Agent complete — ${parts.join(", ")}`
          : "Agent complete",
      });
      continue;
    }
  }

  // Assign indices and progress
  for (let idx = 0; idx < events.length; idx++) {
    events[idx].index = idx;
  }

  // Progress: phase-based (same as Goose parser) + tool-based within agent phase
  let currentPhasePercent = 0;
  let agentToolsSeen = 0;
  for (const ev of events) {
    if (ev.type === "phase_marker") {
      if (ev.phase === "cloning") currentPhasePercent = 5;
      else if (ev.phase === "agent") currentPhasePercent = 10;
      else if (ev.phase === "committing") currentPhasePercent = 85;
      else if (ev.phase === "pushing") currentPhasePercent = 92;
      ev.progressPercent = currentPhasePercent;
    } else if (ev.type === "tool_call" && currentPhasePercent >= 10 && currentPhasePercent < 85) {
      // Within agent phase: increment progress per tool call, cap at 80%
      agentToolsSeen++;
      currentPhasePercent = Math.min(10 + agentToolsSeen * 3, 80);
      ev.progressPercent = currentPhasePercent;
    } else {
      ev.progressPercent = currentPhasePercent;
    }
  }

  return events;
}

// ── Main parser ──────────────────────────────────────────

export function parseRunLog(rawLog: string): RunEvent[] {
  // Auto-detect pi-agent JSONL format
  if (isPiAgentJsonl(rawLog)) {
    return parsePiAgentJsonl(rawLog);
  }

  // Fall through to Goose regex parser
  return parseGooseLog(rawLog);
}

/** Goose regex-based log parser (original implementation). */
function parseGooseLog(rawLog: string): RunEvent[] {
  const lines = rawLog.split("\n");
  const events: RunEvent[] = [];
  let i = 0;
  let thinkingBuffer: string[] = [];

  function flushThinking(): void {
    // Filter out lines that look like leaked Annotated block internals.
    // This is a safety net for when skipAnnotatedBlock exits too early
    // (e.g. interleaved async tool output corrupts brace counting).
    const cleaned = thinkingBuffer.filter(
      (line) => !ANNOTATED_LEAK_RE.test(line)
    );
    const text = cleaned.join("\n").trim();

    // If the block starts with Annotated block debris, discard entirely.
    // Catches: "),", "},", "]" (closing delimiters from Rust Debug),
    // and "text: " (the text field inside RawTextContent).
    if (/^["'),}\]]/.test(text) || /^text:\s*"/.test(text)) {
      thinkingBuffer = [];
      return;
    }

    if (text.length > 0) {
      events.push({
        type: "agent_thinking",
        index: 0,
        progressPercent: 0,
        content: text,
      });
    }
    thinkingBuffer = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    // Skip noise lines
    if (isNoiseLine(line)) {
      i++;
      continue;
    }

    // Handle orphaned Annotated { ... } blocks between tool calls.
    // When Goose batches parallel tool calls, results arrive as separate
    // Annotated blocks AFTER all the call headers. Try to attach memory
    // results to the first unresolved memory tool call (FIFO order).
    if (ANNOTATED_START_RE.test(line)) {
      const unresolvedIdx = findFirstUnresolvedMemoryEvent(events);
      if (unresolvedIdx !== undefined) {
        const extracted = extractAnnotatedResult(lines, i);
        i = extracted.endIndex;
        if (extracted.summary) {
          events[unresolvedIdx].result = extracted.summary;
        }
      } else {
        i = skipAnnotatedBlock(lines, i);
      }
      continue;
    }

    // ── App run header ────────────────────────────
    const appRunMatch = APP_RUN_RE.exec(line);
    if (appRunMatch) {
      flushThinking();
      events.push({
        type: "info",
        index: 0,
        progressPercent: 0,
        content: line,
      });
      i++;
      continue;
    }

    // ── Session start ────────────────────────────
    const sessionMatch = SESSION_START_RE.exec(line);
    if (sessionMatch) {
      flushThinking();
      // Skip the following session metadata lines (session id, working directory)
      let j = i + 1;
      while (j < lines.length && SESSION_META_RE.test(lines[j])) {
        j++;
      }
      events.push({
        type: "session_start",
        index: 0,
        progressPercent: 0,
        provider: sessionMatch[1],
        model: sessionMatch[2],
        content: `Session started with ${sessionMatch[1]} / ${sessionMatch[2]}`,
      });
      i = j;
      continue;
    }

    // ── Shell command ($ prefix) ──────────────────
    const shellMatch = SHELL_CMD_RE.exec(line);
    if (shellMatch) {
      flushThinking();
      const command = shellMatch[1];

      // Determine phase from command
      let phase: string | undefined;
      if (command.includes("git clone")) phase = "cloning";
      else if (command.includes("goose run") || command.includes("pi -p") || command.includes("AGENT_COMMAND")) phase = "agent";
      else if (command.includes("git push")) phase = "pushing";
      else if (command.includes("git add") || command.includes("git commit")) phase = "committing";

      // Skip stdout lines until next structural element
      let j = i + 1;
      const outputLines: string[] = [];
      while (j < lines.length) {
        const nextLine = lines[j];
        if (
          TOOL_HEADER_RE.test(nextLine) ||
          SHELL_CMD_RE.test(nextLine) ||
          SESSION_START_RE.test(nextLine) ||
          APP_RUN_RE.test(nextLine)
        ) {
          break;
        }
        if (ANNOTATED_START_RE.test(nextLine)) {
          j = skipAnnotatedBlock(lines, j);
          continue;
        }
        if (!isNoiseLine(nextLine)) {
          outputLines.push(nextLine);
        }
        j++;
      }

      const output = outputLines.join("\n").trim();
      events.push({
        type: phase ? "phase_marker" : "shell_cmd",
        index: 0,
        progressPercent: 0,
        command,
        phase,
        content: output ? `$ ${command}\n${output}` : `$ ${command}`,
      });
      i = j;
      continue;
    }

    // ── Tool call header ─────────────────────────
    const toolMatch = TOOL_HEADER_RE.exec(line);
    if (toolMatch) {
      flushThinking();
      const tool = toolMatch[1];
      const extension = toolMatch[2];
      const params: Record<string, string> = {};

      // Collect params (key: value lines immediately after header)
      let j = i + 1;
      while (j < lines.length) {
        const paramLine = lines[j];
        if (isNoiseLine(paramLine)) {
          j++;
          continue;
        }
        const paramMatch = TOOL_PARAM_RE.exec(paramLine);
        if (paramMatch) {
          params[paramMatch[1]] = paramMatch[2];
          j++;
          continue;
        }
        break;
      }

      // Collect tool stdout until Annotated block or next structural element.
      // Once we see the Annotated block (tool result), the tool call is done —
      // any text after it is agent thinking, not tool output.
      // For memory tools (memory_search, memory_add), extract a human-readable
      // summary from the Annotated block instead of discarding it.
      const outputLines: string[] = [];
      let toolResult: string | undefined;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (
          TOOL_HEADER_RE.test(nextLine) ||
          SHELL_CMD_RE.test(nextLine) ||
          SESSION_START_RE.test(nextLine) ||
          APP_RUN_RE.test(nextLine)
        ) {
          break;
        }
        if (ANNOTATED_START_RE.test(nextLine)) {
          if (RESULT_CAPTURE_TOOLS.has(tool)) {
            const extracted = extractAnnotatedResult(lines, j);
            j = extracted.endIndex;
            if (extracted.summary) toolResult = extracted.summary;
          } else {
            j = skipAnnotatedBlock(lines, j);
          }
          // After the Annotated result block, the tool call is complete.
          // Skip trailing noise/blank lines but stop before real content.
          while (j < lines.length && isNoiseLine(lines[j])) {
            j++;
          }
          break;
        }
        if (!isNoiseLine(nextLine)) {
          outputLines.push(nextLine);
        }
        j++;
      }

      // Build a readable summary for the tool call
      let summary = `${tool}`;
      if (params.path) {
        summary = `${tool}: ${shortenPath(params.path)}`;
      } else if (params.command) {
        summary = `${tool}: ${params.command}`;
      } else if (params.query) {
        summary = `${tool}: "${params.query}"`;
      }

      const output = outputLines.join("\n").trim();
      events.push({
        type: "tool_call",
        index: 0,
        progressPercent: 0,
        tool,
        extension,
        params,
        result: toolResult,
        content: output ? `${summary}\n${output}` : summary,
      });
      i = j;
      continue;
    }

    // ── Agent thinking (free text) ───────────────
    thinkingBuffer.push(line);
    i++;
  }

  // Flush any remaining thinking text
  flushThinking();

  // Assign indices
  for (let idx = 0; idx < events.length; idx++) {
    events[idx].index = idx;
  }

  // Pipeline-level progress: events inherit the phase they belong to.
  // Phase markers get fixed percentages; events between phases inherit
  // the last phase's value. This is stable regardless of event count.
  let currentPhasePercent = 0;
  for (const event of events) {
    if (event.type === "phase_marker") {
      if (event.phase === "cloning") currentPhasePercent = 5;
      else if (event.phase === "agent") currentPhasePercent = 10;
      else if (event.phase === "committing") currentPhasePercent = 85;
      else if (event.phase === "pushing") currentPhasePercent = 92;
      else currentPhasePercent = 0;
      event.progressPercent = currentPhasePercent;
    } else {
      event.progressPercent = currentPhasePercent;
    }
  }

  return events;
}

// ── Helpers ──────────────────────────────────────────────

function shortenPath(fullPath: string): string {
  // Strip the long .work/<uuid>/repo/ prefix for readability
  const repoIndex = fullPath.indexOf("/repo/");
  if (repoIndex >= 0) {
    return fullPath.slice(repoIndex + 6);
  }
  // Fallback: show last 3 segments
  const segments = fullPath.split("/");
  if (segments.length > 3) {
    return ".../" + segments.slice(-3).join("/");
  }
  return fullPath;
}

/** Parse events and return summary stats */
export function getEventStats(events: RunEvent[]): {
  totalEvents: number;
  toolCalls: number;
  thinkingBlocks: number;
  shellCommands: number;
  tools: Record<string, number>;
} {
  const tools: Record<string, number> = {};
  let toolCalls = 0;
  let thinkingBlocks = 0;
  let shellCommands = 0;

  for (const event of events) {
    if (event.type === "tool_call") {
      toolCalls++;
      const name = event.tool ?? "unknown";
      tools[name] = (tools[name] ?? 0) + 1;
    } else if (event.type === "agent_thinking") {
      thinkingBlocks++;
    } else if (event.type === "shell_cmd" || event.type === "phase_marker") {
      shellCommands++;
    }
  }

  return {
    totalEvents: events.length,
    toolCalls,
    thinkingBlocks,
    shellCommands,
    tools,
  };
}
