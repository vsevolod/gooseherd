import type { AppConfig } from "../../config.js";
import type { BrowserCheck } from "./browser-verify.js";

export type ModelProvider = "openai" | "anthropic" | "google" | "openrouter" | "other";

export type BrowserVerifyFailureCode =
  | "provider_mismatch"
  | "auth_required"
  | "auth_action_blocked"
  | "signup_failed"
  | "feature_not_found"
  | "accessibility_noise"
  | "verify_inconclusive"
  | "unknown";

export interface StagehandProviderResolution {
  ok: boolean;
  route?: "native_openai" | "native_anthropic" | "openrouter";
  apiKey?: string;
  baseURL?: string;
  reason: string;
  primaryProvider: ModelProvider;
  executionProvider: ModelProvider;
  failureCode?: "provider_mismatch" | "missing_api_key";
}

export interface AgentActionEntry {
  type?: string;
  pageUrl?: string;
  reasoning?: string;
}

export interface NetworkEntry {
  url?: string;
  method?: string;
  status?: number;
}

export interface BrowserAuthSignals {
  redirectedToLogin: boolean;
  loginPageSeen: boolean;
  signupPageSeen: boolean;
  authGateLikely: boolean;
  authActionBlocked: boolean;
}

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

export function detectModelProvider(model: string): ModelProvider {
  const normalized = normalizeModelName(model);
  if (!normalized) return "other";

  if (normalized.startsWith("openrouter/")) return "openrouter";
  if (
    normalized.startsWith("openai/")
    || normalized.startsWith("gpt-")
    || normalized.startsWith("o1")
    || normalized.startsWith("o3")
    || normalized.startsWith("o4")
    || normalized.startsWith("o5")
  ) {
    return "openai";
  }
  if (normalized.startsWith("anthropic/") || normalized.startsWith("claude")) return "anthropic";
  if (normalized.startsWith("google/") || normalized.startsWith("gemini")) return "google";

  return "other";
}

/**
 * Resolve provider routing for Stagehand primary + execution models.
 *
 * Rule: mixed-provider model pairs run through OpenRouter when available.
 * This avoids native-provider API key mismatches for executionModel.
 */
export function resolveStagehandProvider(
  primaryModel: string,
  executionModel: string | undefined,
  config: Pick<AppConfig, "openaiApiKey" | "anthropicApiKey" | "openrouterApiKey">
): StagehandProviderResolution {
  const primaryProvider = detectModelProvider(primaryModel);
  const executionProvider = detectModelProvider(executionModel ?? primaryModel);
  const providersDiffer = executionModel !== undefined && primaryProvider !== executionProvider;

  if (providersDiffer) {
    if (config.openrouterApiKey) {
      return {
        ok: true,
        route: "openrouter",
        apiKey: config.openrouterApiKey,
        baseURL: "https://openrouter.ai/api/v1",
        reason: `Mixed providers (${primaryProvider} + ${executionProvider}) routed through OpenRouter`,
        primaryProvider,
        executionProvider
      };
    }
    return {
      ok: false,
      reason: `Mixed providers (${primaryProvider} + ${executionProvider}) require OPENROUTER_API_KEY`,
      primaryProvider,
      executionProvider,
      failureCode: "provider_mismatch"
    };
  }

  if (primaryProvider === "openrouter") {
    if (config.openrouterApiKey) {
      return {
        ok: true,
        route: "openrouter",
        apiKey: config.openrouterApiKey,
        baseURL: "https://openrouter.ai/api/v1",
        reason: "Primary model explicitly targets OpenRouter",
        primaryProvider,
        executionProvider
      };
    }
    return {
      ok: false,
      reason: "Primary model requires OpenRouter but OPENROUTER_API_KEY is missing",
      primaryProvider,
      executionProvider,
      failureCode: "missing_api_key"
    };
  }

  if (primaryProvider === "openai") {
    if (config.openaiApiKey) {
      return {
        ok: true,
        route: "native_openai",
        apiKey: config.openaiApiKey,
        baseURL: undefined,
        reason: "Using native OpenAI provider",
        primaryProvider,
        executionProvider
      };
    }
    if (config.openrouterApiKey) {
      return {
        ok: true,
        route: "openrouter",
        apiKey: config.openrouterApiKey,
        baseURL: "https://openrouter.ai/api/v1",
        reason: "OPENAI_API_KEY missing, using OpenRouter fallback",
        primaryProvider,
        executionProvider
      };
    }
    return {
      ok: false,
      reason: "No API key for OpenAI model (need OPENAI_API_KEY or OPENROUTER_API_KEY)",
      primaryProvider,
      executionProvider,
      failureCode: "missing_api_key"
    };
  }

  if (primaryProvider === "anthropic") {
    if (config.anthropicApiKey) {
      return {
        ok: true,
        route: "native_anthropic",
        apiKey: config.anthropicApiKey,
        baseURL: undefined,
        reason: "Using native Anthropic provider",
        primaryProvider,
        executionProvider
      };
    }
    if (config.openrouterApiKey) {
      return {
        ok: true,
        route: "openrouter",
        apiKey: config.openrouterApiKey,
        baseURL: "https://openrouter.ai/api/v1",
        reason: "ANTHROPIC_API_KEY missing, using OpenRouter fallback",
        primaryProvider,
        executionProvider
      };
    }
    return {
      ok: false,
      reason: "No API key for Anthropic model (need ANTHROPIC_API_KEY or OPENROUTER_API_KEY)",
      primaryProvider,
      executionProvider,
      failureCode: "missing_api_key"
    };
  }

  // Google and unknown providers default to OpenRouter routing.
  if (config.openrouterApiKey) {
    return {
      ok: true,
      route: "openrouter",
      apiKey: config.openrouterApiKey,
      baseURL: "https://openrouter.ai/api/v1",
      reason: `Provider '${primaryProvider}' routed via OpenRouter`,
      primaryProvider,
      executionProvider
    };
  }

  return {
    ok: false,
    reason: `Provider '${primaryProvider}' requires OPENROUTER_API_KEY in current runtime`,
    primaryProvider,
    executionProvider,
    failureCode: "provider_mismatch"
  };
}

function isLoginPath(url: string): boolean {
  return /\/(login|sign_in|users\/sign_in)(?:[/?#]|$)/i.test(url);
}

function isSignupPath(url: string): boolean {
  return /\/(sign_up|signup|register|users\/sign_up)(?:[/?#]|$)/i.test(url);
}

function isProtectedPath(url: string): boolean {
  return /\/(user|account|settings|dashboard|admin)(?:[/?#]|$)/i.test(url);
}

function hasAuthBlockedLanguage(text: string): boolean {
  return /(api key limitation|unable to log in|blocked from logging in|cannot log in|auth(?:entication)?\s+issue)/i.test(text);
}

export function deriveAuthSignals(
  actions: AgentActionEntry[],
  network: NetworkEntry[],
  reasonText?: string
): BrowserAuthSignals {
  let redirectedToLogin = false;
  let loginPageSeen = false;
  let signupPageSeen = false;
  let protectedRedirectSeen = false;

  for (const entry of actions) {
    const pageUrl = entry.pageUrl ?? "";
    if (pageUrl && isLoginPath(pageUrl)) loginPageSeen = true;
    if (pageUrl && isSignupPath(pageUrl)) signupPageSeen = true;
    if (isLoginPath(pageUrl) && /goto|navigate|act|ariaTree/i.test(entry.type ?? "")) {
      redirectedToLogin = true;
    }
    if (entry.reasoning && hasAuthBlockedLanguage(entry.reasoning)) {
      redirectedToLogin = true;
    }
  }

  for (const req of network) {
    const url = req.url ?? "";
    const status = req.status ?? 0;

    if (isLoginPath(url)) loginPageSeen = true;
    if (isSignupPath(url)) signupPageSeen = true;

    if (status >= 300 && status < 400 && isProtectedPath(url)) {
      protectedRedirectSeen = true;
    }

    if (isLoginPath(url) && (status === 200 || (status >= 300 && status < 400))) {
      redirectedToLogin = true;
    }
  }

  const reason = reasonText ?? "";
  const authActionBlocked = hasAuthBlockedLanguage(reason);
  const authGateLikely = redirectedToLogin || loginPageSeen || protectedRedirectSeen || /without access to the authenticated|requires authentication/i.test(reason);

  return {
    redirectedToLogin,
    loginPageSeen,
    signupPageSeen,
    authGateLikely,
    authActionBlocked
  };
}

function hasFeatureMissingLanguage(reason: string): boolean {
  return /(not\s+visible|not\s+found|missing|still\s+shows\s+old|could not find|cannot confirm|unable to verify|did not detect|does not match|did not match|wrong text|instead of|expected.*but)/i.test(reason);
}

function hasAuthRequiredLanguage(reason: string): boolean {
  return /(without access to the authenticated|requires authentication|login required|auth(?:entication)? required|access denied|please sign in)/i.test(reason);
}

export function classifyBrowserVerifyFailure(input: {
  checks: BrowserCheck[];
  verifyReason?: string;
  authSignals?: BrowserAuthSignals;
  preflightFailureCode?: "provider_mismatch" | "missing_api_key";
}): BrowserVerifyFailureCode {
  if (input.preflightFailureCode === "provider_mismatch") {
    return "provider_mismatch";
  }

  const reason = input.verifyReason ?? "";
  const auth = input.authSignals;

  if (auth?.authActionBlocked || /(api key limitation|blocked from logging in|unable to log in)/i.test(reason)) {
    return "auth_action_blocked";
  }

  const featureCheck = input.checks.find((c) => c.name === "feature_verification");
  const accessibilityCheck = input.checks.find((c) => c.name === "accessibility");
  const featureMissing = featureCheck && !featureCheck.passed && hasFeatureMissingLanguage(reason || featureCheck.details);
  const authRequired = hasAuthRequiredLanguage(reason || featureCheck?.details || "");

  if (featureMissing && !authRequired) {
    return "feature_not_found";
  }

  if (auth?.authGateLikely || authRequired || /(authenticated user edit page)/i.test(reason)) {
    if (auth?.signupPageSeen && /(signup failed|could not sign up|registration failed)/i.test(reason)) {
      return "signup_failed";
    }
    return "auth_required";
  }

  if (featureMissing) {
    return "feature_not_found";
  }

  if (accessibilityCheck && !accessibilityCheck.passed && (!featureCheck || !featureCheck.passed)) {
    return "accessibility_noise";
  }

  if (featureCheck && !featureCheck.passed) {
    return "verify_inconclusive";
  }

  return "unknown";
}

export function isNonCodeFixFailure(code: BrowserVerifyFailureCode | undefined): boolean {
  if (!code) return false;
  return code === "provider_mismatch"
    || code === "auth_required"
    || code === "auth_action_blocked"
    || code === "signup_failed"
    || code === "accessibility_noise"
    || code === "verify_inconclusive";
}
