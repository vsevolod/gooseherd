import assert from "node:assert/strict";
import test from "node:test";
import {
  isCasualMessage,
  stripMentions
} from "../src/slack-app.js";

// ── stripMentions ───────────────────────────────────────

test("stripMentions removes Slack user mentions", () => {
  assert.equal(stripMentions("<@U1234> hello"), "hello");
  assert.equal(stripMentions("<@U1234> <@U5678> fix the bug"), "fix the bug");
  assert.equal(stripMentions("no mentions here"), "no mentions here");
  assert.equal(stripMentions("<@UBOT>"), "");
});

// ── isCasualMessage ─────────────────────────────────────

test("isCasualMessage: casual greetings and acknowledgments", () => {
  const casualInputs = [
    "thanks", "thank you!", "thx", "ty", "ok", "okay", "cool",
    "nice", "great!", "awesome", "perfect", "good", "yep", "yeah",
    "yes", "no", "nah", "nope", "sure", "np", "lol", "haha", "wow",
    "👍", "👎", "🎉", "✅", "❌", "k"
  ];
  for (const input of casualInputs) {
    assert.ok(isCasualMessage(input), `"${input}" should be casual`);
  }
});

test("isCasualMessage: casual with trailing punctuation", () => {
  assert.ok(isCasualMessage("thanks!"));
  assert.ok(isCasualMessage("ok."));
  assert.ok(isCasualMessage("cool?"));
  assert.ok(isCasualMessage("nice!!"));
});

test("isCasualMessage: casual ignores mentions before classifying", () => {
  assert.ok(isCasualMessage("<@U1234> thanks"));
  assert.ok(isCasualMessage("<@UBOT> ok"));
  assert.ok(isCasualMessage("<@U1234> 👍"));
});

test("isCasualMessage: empty or mention-only is casual", () => {
  assert.ok(isCasualMessage(""));
  assert.ok(isCasualMessage("<@U1234>"));
  assert.ok(isCasualMessage("   "));
});

test("isCasualMessage: short messages without action verbs are casual", () => {
  assert.ok(isCasualMessage("I see"));
  assert.ok(isCasualMessage("got it"));
  assert.ok(isCasualMessage("hmm"));
});

test("isCasualMessage: action-oriented messages are NOT casual", () => {
  assert.ok(!isCasualMessage("add error handling to the form"));
  assert.ok(!isCasualMessage("fix the typo in the header"));
  assert.ok(!isCasualMessage("change the button color to blue"));
  assert.ok(!isCasualMessage("update the README with the new API"));
  assert.ok(!isCasualMessage("refactor the auth module"));
});

test("isCasualMessage: questions are NOT casual", () => {
  assert.ok(!isCasualMessage("what model does browser verify use?"));
  assert.ok(!isCasualMessage("how does the pipeline engine work?"));
  assert.ok(!isCasualMessage("which repos are configured?"));
});

test("isCasualMessage: longer messages are NOT casual even without action verbs", () => {
  assert.ok(!isCasualMessage("the button on the landing page should be green instead of red"));
});

test("isCasualMessage: mentions stripped before classifying", () => {
  assert.ok(!isCasualMessage("<@UBOT> add a new endpoint for user profiles"));
});

test("isCasualMessage: help/status/tail keywords are NOT casual", () => {
  assert.ok(!isCasualMessage("help"));
  assert.ok(!isCasualMessage("status"));
  assert.ok(!isCasualMessage("show me the status"));
  assert.ok(!isCasualMessage("retry"));
});
