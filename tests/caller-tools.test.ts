/**
 * Tests for callLLMWithTools (agentic tool_use loop) and extractJSON.
 * These test the general-purpose tool loop in caller.ts, not browser-specific code.
 */

import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { extractJSON, type ToolDefinition } from "../src/llm/caller.js";

// Simple tool definitions for testing (not browser-specific)
const TEST_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_data",
      description: "Get some data",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description: "Run a check",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

// ── callLLMWithTools integration (mocked) ──

describe("callLLMWithTools", () => {
  test("completes when LLM returns text (no tool_calls)", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = mock.fn(async () => {
      callCount++;
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"passed": true, "confidence": "high", "reasoning": "Feature visible"}' } }],
        model: "test-model",
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const { callLLMWithTools } = await import("../src/llm/caller.js");
      const result = await callLLMWithTools(
        { apiKey: "test-key", defaultModel: "test-model", defaultTimeoutMs: 5000 },
        {
          system: "You are a test agent.",
          initialMessages: [{ role: "user", content: "Check the data" }],
          tools: TEST_TOOLS,
          executeTool: async () => "tool result"
        }
      );

      assert.equal(callCount, 1, "should make exactly 1 API call");
      assert.equal(result.turnsUsed, 1);
      assert.ok(result.content.includes("passed"));
      assert.equal(result.totalInputTokens, 100);
      assert.equal(result.totalOutputTokens, 20);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("executes tool calls and continues the loop", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "get_data", arguments: '{"query":"title"}' }
              }]
            }
          }],
          model: "test-model",
          usage: { prompt_tokens: 100, completion_tokens: 15 }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"passed": true, "confidence": "high", "reasoning": "Title is correct"}' } }],
        model: "test-model",
        usage: { prompt_tokens: 200, completion_tokens: 20 }
      }), { status: 200 });
    }) as typeof fetch;

    const toolCalls: string[] = [];

    try {
      const { callLLMWithTools } = await import("../src/llm/caller.js");
      const result = await callLLMWithTools(
        { apiKey: "test-key", defaultModel: "test-model", defaultTimeoutMs: 5000 },
        {
          system: "You are a test agent.",
          initialMessages: [{ role: "user", content: "Check the data" }],
          tools: TEST_TOOLS,
          executeTool: async (name, args) => {
            toolCalls.push(`${name}(${JSON.stringify(args)})`);
            return "My Page Title";
          }
        }
      );

      assert.equal(callCount, 2, "should make 2 API calls");
      assert.equal(result.turnsUsed, 2);
      assert.equal(toolCalls.length, 1);
      assert.ok(toolCalls[0]!.includes("get_data"));
      assert.equal(result.totalInputTokens, 300);
      assert.equal(result.totalOutputTokens, 35);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects maxTurns limit and returns fallback verdict", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call_${Date.now()}`,
              type: "function",
              function: { name: "run_check", arguments: "{}" }
            }]
          }
        }],
        model: "test-model",
        usage: { prompt_tokens: 50, completion_tokens: 10 }
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const { callLLMWithTools } = await import("../src/llm/caller.js");
      const result = await callLLMWithTools(
        { apiKey: "test-key", defaultModel: "test-model", defaultTimeoutMs: 5000 },
        {
          system: "Test",
          initialMessages: [{ role: "user", content: "Test" }],
          tools: TEST_TOOLS,
          executeTool: async () => "check data",
          maxTurns: 3
        }
      );

      assert.equal(result.turnsUsed, 3, "should stop at maxTurns");
      assert.ok(result.content.includes("max turns reached"), "should mention exhaustion reason");
      const parsed = JSON.parse(result.content) as { passed: boolean };
      assert.equal(parsed.passed, false, "exhaustion verdict should be FAIL");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects wall-clock timeout", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock.fn(async () => {
      await new Promise(r => setTimeout(r, 50));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call_${Date.now()}`,
              type: "function",
              function: { name: "run_check", arguments: "{}" }
            }]
          }
        }],
        model: "test-model",
        usage: { prompt_tokens: 50, completion_tokens: 10 }
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const { callLLMWithTools } = await import("../src/llm/caller.js");
      const result = await callLLMWithTools(
        { apiKey: "test-key", defaultModel: "test-model", defaultTimeoutMs: 5000 },
        {
          system: "Test",
          initialMessages: [{ role: "user", content: "Test" }],
          tools: TEST_TOOLS,
          executeTool: async () => "check data",
          maxTurns: 100,
          wallClockTimeoutMs: 200
        }
      );

      assert.ok(result.turnsUsed < 100, "should stop before maxTurns due to wall-clock");
      assert.ok(result.content.includes("wall-clock timeout"), "should mention wall-clock timeout");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles tool execution errors gracefully", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_err",
                type: "function",
                function: { name: "get_data", arguments: '{"query":"test"}' }
              }]
            }
          }],
          model: "test-model",
          usage: { prompt_tokens: 100, completion_tokens: 15 }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"passed": false, "confidence": "high", "reasoning": "Data not found"}' } }],
        model: "test-model",
        usage: { prompt_tokens: 200, completion_tokens: 20 }
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const { callLLMWithTools } = await import("../src/llm/caller.js");
      const result = await callLLMWithTools(
        { apiKey: "test-key", defaultModel: "test-model", defaultTimeoutMs: 5000 },
        {
          system: "Test",
          initialMessages: [{ role: "user", content: "Test" }],
          tools: TEST_TOOLS,
          executeTool: async () => { throw new Error("Data source unavailable"); }
        }
      );

      assert.equal(result.turnsUsed, 2);
      const toolMsg = result.messages.find(m => m.role === "tool");
      assert.ok(toolMsg);
      assert.ok("content" in toolMsg && toolMsg.content.includes("Error:"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("compacts old tool results when maxToolResultLength is set", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount <= 4) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `call_${String(callCount)}`,
                type: "function",
                function: { name: "run_check", arguments: "{}" }
              }]
            }
          }],
          model: "test-model",
          usage: { prompt_tokens: 100, completion_tokens: 10 }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"passed": true, "confidence": "high", "reasoning": "OK"}' } }],
        model: "test-model",
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const { callLLMWithTools } = await import("../src/llm/caller.js");
      const bigData = "A".repeat(2000);

      const result = await callLLMWithTools(
        { apiKey: "test-key", defaultModel: "test-model", defaultTimeoutMs: 5000 },
        {
          system: "Test",
          initialMessages: [{ role: "user", content: "Test" }],
          tools: TEST_TOOLS,
          executeTool: async () => bigData,
          maxTurns: 10,
          maxToolResultLength: 300
        }
      );

      assert.equal(result.turnsUsed, 5);

      const toolMsgs = result.messages.filter(m => m.role === "tool");
      assert.ok(toolMsgs.length >= 4, `expected 4+ tool messages, got ${String(toolMsgs.length)}`);

      const firstTool = toolMsgs[0]!;
      assert.ok("content" in firstTool);
      assert.ok(firstTool.content.length < 500, `first tool result should be truncated, got ${String(firstTool.content.length)}`);
      assert.ok(firstTool.content.includes("[...truncated"), "should have truncation marker");

      const lastTool = toolMsgs[toolMsgs.length - 1]!;
      assert.ok("content" in lastTool);
      assert.equal(lastTool.content.length, 2000, "last tool result should be full size");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects maxInputTokens budget", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call_${Date.now()}`,
              type: "function",
              function: { name: "run_check", arguments: "{}" }
            }]
          }
        }],
        model: "test-model",
        usage: { prompt_tokens: 5000, completion_tokens: 10 }
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const { callLLMWithTools } = await import("../src/llm/caller.js");
      const result = await callLLMWithTools(
        { apiKey: "test-key", defaultModel: "test-model", defaultTimeoutMs: 5000 },
        {
          system: "Test",
          initialMessages: [{ role: "user", content: "Test" }],
          tools: TEST_TOOLS,
          executeTool: async () => "data",
          maxTurns: 100,
          maxInputTokens: 12_000
        }
      );

      assert.ok(result.turnsUsed <= 3, `expected <=3 turns, got ${String(result.turnsUsed)}`);
      assert.ok(result.content.includes("token budget exceeded"), "should mention token budget");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── extractJSON (used for parsing LLM verdict) ──

describe("extractJSON for verdict parsing", () => {
  test("parses clean JSON verdict", () => {
    const result = extractJSON<{ passed: boolean; confidence: string }>(
      '{"passed": true, "confidence": "high", "reasoning": "Feature visible"}'
    );
    assert.ok(result);
    assert.equal(result.passed, true);
    assert.equal(result.confidence, "high");
  });

  test("extracts JSON from prose", () => {
    const result = extractJSON<{ passed: boolean }>(
      'Based on my analysis, here is my verdict:\n{"passed": false, "confidence": "medium", "reasoning": "Heading not found"}\nEnd.'
    );
    assert.ok(result);
    assert.equal(result.passed, false);
  });

  test("extracts JSON from code fences", () => {
    const result = extractJSON<{ passed: boolean }>(
      '```json\n{"passed": true, "confidence": "high", "reasoning": "All good"}\n```'
    );
    assert.ok(result);
    assert.equal(result.passed, true);
  });
});
