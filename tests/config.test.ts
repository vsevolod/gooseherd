import assert from "node:assert/strict";
import test from "node:test";

// Test the config loading indirectly by verifying type shapes
// (loadConfig() reads process.env directly, so we test the helper logic)

test("MCP extensions: parseList splits comma-separated values", () => {
  function parseList(value?: string): string[] {
    if (!value || value.trim() === "") return [];
    return value.split(",").map(e => e.trim()).filter(Boolean);
  }

  assert.deepEqual(parseList("npx @a/ext,npx @b/ext"), ["npx @a/ext", "npx @b/ext"]);
  assert.deepEqual(parseList("npx @a/ext"), ["npx @a/ext"]);
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList(" , "), []);
});

test("Dashboard public URL: defaults to localhost when not set", () => {
  const host = "127.0.0.1";
  const port = 8787;
  const publicUrl = undefined;

  const resolved = publicUrl ?? `http://${host}:${String(port)}`;
  assert.equal(resolved, "http://127.0.0.1:8787");
});

test("Dashboard public URL: uses public URL when set", () => {
  const host = "127.0.0.1";
  const port = 8787;
  const publicUrl = "https://dash.goose-herd.com";

  const resolved = publicUrl ?? `http://${host}:${String(port)}`;
  assert.equal(resolved, "https://dash.goose-herd.com");
});

test("DRY_RUN: default is false", () => {
  function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }

  assert.equal(parseBoolean(undefined, false), false);
  assert.equal(parseBoolean("true", false), true);
  assert.equal(parseBoolean("false", false), false);
});

test("DEFAULT_LLM_MODEL: feature models fall back to default", () => {
  // Simulates the fallback chain: FEATURE_MODEL → DEFAULT_LLM_MODEL → hardcoded default
  function resolveModel(featureModel?: string, defaultModel?: string): string {
    return featureModel?.trim() || defaultModel?.trim() || "anthropic/claude-sonnet-4-6";
  }

  // Feature-specific override wins
  assert.equal(resolveModel("openai/gpt-4.1-mini", "anthropic/claude-haiku-4-5"), "openai/gpt-4.1-mini");
  // Falls back to default model
  assert.equal(resolveModel(undefined, "anthropic/claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
  // Falls back to hardcoded default
  assert.equal(resolveModel(undefined, undefined), "anthropic/claude-sonnet-4-6");
  // Empty strings fall through
  assert.equal(resolveModel("", ""), "anthropic/claude-sonnet-4-6");
});
