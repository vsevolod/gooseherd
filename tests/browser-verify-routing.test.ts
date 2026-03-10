import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyBrowserVerifyFailure,
  deriveAuthSignals,
  detectAuthErrorType,
  detectModelProvider,
  isNonCodeFixFailure,
  resolveStagehandProvider,
} from "../src/pipeline/quality-gates/browser-verify-routing.js";

describe("detectModelProvider", () => {
  test("detects common provider families", () => {
    assert.equal(detectModelProvider("openai/gpt-4.1-mini"), "openai");
    assert.equal(detectModelProvider("gpt-5.3-chat"), "openai");
    assert.equal(detectModelProvider("anthropic/claude-sonnet-4.6"), "anthropic");
    assert.equal(detectModelProvider("google/gemini-3.1-flash-lite-preview"), "google");
    assert.equal(detectModelProvider("openrouter/z-ai/glm-5"), "openrouter");
    assert.equal(detectModelProvider("z-ai/glm-5"), "other");
  });
});

describe("resolveStagehandProvider", () => {
  test("prefers native OpenAI when compatible", () => {
    const result = resolveStagehandProvider(
      "openai/gpt-4.1-mini",
      undefined,
      { openaiApiKey: "sk-openai", anthropicApiKey: undefined, openrouterApiKey: "or-key" }
    );
    assert.equal(result.ok, true);
    assert.equal(result.route, "native_openai");
    assert.equal(result.baseURL, undefined);
  });

  test("routes mixed providers through OpenRouter", () => {
    const result = resolveStagehandProvider(
      "openai/gpt-4.1-mini",
      "google/gemini-3.1-flash-lite-preview",
      { openaiApiKey: "sk-openai", anthropicApiKey: undefined, openrouterApiKey: "or-key" }
    );
    assert.equal(result.ok, true);
    assert.equal(result.route, "openrouter");
    assert.equal(result.baseURL, "https://openrouter.ai/api/v1");
  });

  test("fails mixed providers without OpenRouter key", () => {
    const result = resolveStagehandProvider(
      "openai/gpt-4.1-mini",
      "google/gemini-3.1-flash-lite-preview",
      { openaiApiKey: "sk-openai", anthropicApiKey: undefined, openrouterApiKey: undefined }
    );
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, "provider_mismatch");
  });
});

describe("deriveAuthSignals", () => {
  test("detects login redirect/auth gate patterns", () => {
    const signals = deriveAuthSignals(
      [
        { type: "goto", pageUrl: "https://x.test/login" },
      ],
      [
        { url: "https://x.test/user/edit", status: 302, method: "GET" },
        { url: "https://x.test/login", status: 200, method: "GET" },
      ],
      "Without access to the authenticated page"
    );

    assert.equal(signals.loginPageSeen, true);
    assert.equal(signals.authGateLikely, true);
    assert.equal(signals.redirectedToLogin, true);
  });

  test("detects signup availability", () => {
    const signals = deriveAuthSignals(
      [{ pageUrl: "https://x.test/users/sign_up", type: "goto" }],
      [{ url: "https://x.test/users/sign_up", status: 200 }],
      ""
    );
    assert.equal(signals.signupPageSeen, true);
  });
});

describe("classifyBrowserVerifyFailure", () => {
  test("returns provider_mismatch when preflight mismatch occurred", () => {
    const code = classifyBrowserVerifyFailure({
      checks: [{ name: "feature_verification", passed: false, details: "provider preflight failed" }],
      verifyReason: "provider preflight failed",
      preflightFailureCode: "provider_mismatch"
    });
    assert.equal(code, "provider_mismatch");
  });

  test("returns auth_action_blocked when login automation is blocked", () => {
    const code = classifyBrowserVerifyFailure({
      checks: [{ name: "feature_verification", passed: false, details: "unable to log in" }],
      verifyReason: "API key limitations preventing input actions",
      authSignals: {
        redirectedToLogin: true,
        loginPageSeen: true,
        signupPageSeen: false,
        authGateLikely: true,
        authActionBlocked: true,
      }
    });
    assert.equal(code, "auth_action_blocked");
  });

  test("returns feature_not_found for actual missing feature evidence", () => {
    const code = classifyBrowserVerifyFailure({
      checks: [{ name: "feature_verification", passed: false, details: "Feature missing from page" }],
      verifyReason: "Feature missing from page"
    });
    assert.equal(code, "feature_not_found");
  });

  test("prefers feature_not_found over auth_required after successful auth navigation", () => {
    const code = classifyBrowserVerifyFailure({
      checks: [{ name: "feature_verification", passed: false, details: "Still shows old title value" }],
      verifyReason: "Still shows old title value on /user/edit",
      authSignals: {
        redirectedToLogin: true,
        loginPageSeen: true,
        signupPageSeen: true,
        authGateLikely: true,
        authActionBlocked: false,
      }
    });
    assert.equal(code, "feature_not_found");
  });

  test("classifies text mismatch wording as feature_not_found even with auth signals", () => {
    const code = classifyBrowserVerifyFailure({
      checks: [{ name: "feature_verification", passed: false, details: "Heading does not match expected text" }],
      verifyReason: "The visible heading does not match the exact required text",
      authSignals: {
        redirectedToLogin: true,
        loginPageSeen: true,
        signupPageSeen: true,
        authGateLikely: true,
        authActionBlocked: false,
      }
    });
    assert.equal(code, "feature_not_found");
  });
});

describe("isNonCodeFixFailure", () => {
  test("marks provider/auth_exhausted/inconclusive classes as non-code-fix", () => {
    assert.equal(isNonCodeFixFailure("provider_mismatch"), true);
    assert.equal(isNonCodeFixFailure("auth_exhausted"), true);
    assert.equal(isNonCodeFixFailure("auth_action_blocked"), true);
    assert.equal(isNonCodeFixFailure("verify_inconclusive"), true);
    assert.equal(isNonCodeFixFailure("feature_not_found"), false);
  });

  test("auth_required and signup_failed now enter fix loop", () => {
    assert.equal(isNonCodeFixFailure("auth_required"), false);
    assert.equal(isNonCodeFixFailure("signup_failed"), false);
  });
});

describe("detectAuthErrorType", () => {
  test("detects email_rejected from DOM findings", () => {
    const result = detectAuthErrorType(
      ["Email has already been taken"],
      [],
      ""
    );
    assert.equal(result, "email_rejected");
  });

  test("detects email_rejected from action reasoning", () => {
    const result = detectAuthErrorType(
      [],
      [{ reasoning: "The email address is already registered" }],
      ""
    );
    assert.equal(result, "email_rejected");
  });

  test("detects password_too_weak", () => {
    const result = detectAuthErrorType(
      ["Password is too short (minimum 8 characters)"],
      [],
      ""
    );
    assert.equal(result, "password_too_weak");
  });

  test("detects captcha_required", () => {
    const result = detectAuthErrorType(
      [],
      [],
      "The page shows a reCAPTCHA challenge that I cannot solve"
    );
    assert.equal(result, "captcha_required");
  });

  test("detects form_error for generic validation issues", () => {
    const result = detectAuthErrorType(
      ["Validation failed for this field"],
      [],
      ""
    );
    assert.equal(result, "form_error");
  });

  test("returns unknown when no patterns match", () => {
    const result = detectAuthErrorType(
      [],
      [],
      "The page loaded successfully"
    );
    assert.equal(result, "unknown");
  });

  test("detects hcaptcha variant", () => {
    const result = detectAuthErrorType(
      ["hcaptcha widget visible on form"],
      [],
      ""
    );
    assert.equal(result, "captcha_required");
  });

  test("detects password policy requirement", () => {
    const result = detectAuthErrorType(
      [],
      [{ reasoning: "Password does not meet minimum characters policy" }],
      ""
    );
    assert.equal(result, "password_too_weak");
  });
});
