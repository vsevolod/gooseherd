import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContextBag } from "../src/pipeline/context-bag.js";

describe("ContextBag.append()", () => {
  test("creates array when key doesn't exist", () => {
    const ctx = new ContextBag();
    ctx.append("items", "first");
    assert.deepEqual(ctx.get("items"), ["first"]);
  });

  test("pushes to existing array", () => {
    const ctx = new ContextBag();
    ctx.append("items", "first");
    ctx.append("items", "second");
    ctx.append("items", "third");
    assert.deepEqual(ctx.get("items"), ["first", "second", "third"]);
  });

  test("replaces non-array value with new array", () => {
    const ctx = new ContextBag({ items: "not-an-array" });
    ctx.append("items", "first");
    // Non-array existing value → creates new array (doesn't append to string)
    assert.deepEqual(ctx.get("items"), ["first"]);
  });

  test("works with complex objects", () => {
    const ctx = new ContextBag();
    ctx.append("failures", { round: 1, verdict: "failed" });
    ctx.append("failures", { round: 2, verdict: "still failed" });
    const failures = ctx.get<Array<{ round: number; verdict: string }>>("failures");
    assert.equal(failures?.length, 2);
    assert.equal(failures?.[0].round, 1);
    assert.equal(failures?.[1].round, 2);
  });
});

describe("ContextBag basics", () => {
  test("get/set/has work", () => {
    const ctx = new ContextBag();
    assert.equal(ctx.has("key"), false);
    ctx.set("key", "value");
    assert.equal(ctx.has("key"), true);
    assert.equal(ctx.get("key"), "value");
  });

  test("getRequired throws for missing keys", () => {
    const ctx = new ContextBag();
    assert.throws(() => ctx.getRequired("missing"), /required key 'missing'/);
  });

  test("constructor accepts initial data", () => {
    const ctx = new ContextBag({ foo: "bar", num: 42 });
    assert.equal(ctx.get("foo"), "bar");
    assert.equal(ctx.get("num"), 42);
  });

  test("mergeOutputs writes multiple keys", () => {
    const ctx = new ContextBag();
    ctx.mergeOutputs({ a: 1, b: 2 });
    assert.equal(ctx.get("a"), 1);
    assert.equal(ctx.get("b"), 2);
  });

  test("toObject returns plain object", () => {
    const ctx = new ContextBag({ x: 1 });
    const obj = ctx.toObject();
    assert.deepEqual(obj, { x: 1 });
  });
});

describe("ContextBag.toSummary()", () => {
  test("includes string values truncated to 500 chars", () => {
    const longStr = "x".repeat(600);
    const ctx = new ContextBag({ msg: longStr });
    const summary = ctx.toSummary();
    assert.ok(summary.includes("msg: "));
    assert.equal(summary, `msg: ${"x".repeat(500)}`);
  });

  test("includes array values with preview", () => {
    const ctx = new ContextBag({ items: [1, 2, 3] });
    const summary = ctx.toSummary();
    assert.ok(summary.includes("items: [1,2,3]"));
  });

  test("truncates large arrays", () => {
    const ctx = new ContextBag({ items: [1, 2, 3, 4, 5, 6] });
    const summary = ctx.toSummary();
    assert.ok(summary.includes("[6 items]"));
    assert.ok(summary.includes("[1,2,3]..."));
  });

  test("skips empty arrays", () => {
    const ctx = new ContextBag({ items: [], other: "val" });
    const summary = ctx.toSummary();
    assert.ok(!summary.includes("items"));
    assert.ok(summary.includes("other: val"));
  });

  test("includes object values as JSON truncated to 300 chars", () => {
    const ctx = new ContextBag({ config: { a: 1, b: "two" } });
    const summary = ctx.toSummary();
    assert.ok(summary.includes('config: {"a":1,"b":"two"}'));
  });

  test("includes primitive values", () => {
    const ctx = new ContextBag({ count: 42, flag: true });
    const summary = ctx.toSummary();
    assert.ok(summary.includes("count: 42"));
    assert.ok(summary.includes("flag: true"));
  });

  test("filters by specified keys", () => {
    const ctx = new ContextBag({ a: "one", b: "two", c: "three" });
    const summary = ctx.toSummary(["a", "c"]);
    assert.ok(summary.includes("a: one"));
    assert.ok(summary.includes("c: three"));
    assert.ok(!summary.includes("b: two"));
  });

  test("skips _tokenUsage_ keys by default", () => {
    const ctx = new ContextBag({ task: "test", _tokenUsage_impl: { in: 100 } });
    const summary = ctx.toSummary();
    assert.ok(summary.includes("task: test"));
    assert.ok(!summary.includes("_tokenUsage_"));
  });

  test("skips undefined values in selected keys", () => {
    const ctx = new ContextBag({ a: "one" });
    const summary = ctx.toSummary(["a", "nonexistent"]);
    assert.equal(summary, "a: one");
  });
});
