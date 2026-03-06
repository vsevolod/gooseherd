/**
 * OpenRouter model pricing — dollars per million tokens.
 * Used to compute estimated run costs from token counts.
 *
 * Prices sourced from https://openrouter.ai/models
 * Last updated: 2026-03-06
 */

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  "anthropic/claude-sonnet-4-6": { inputPerM: 3.00, outputPerM: 15.00 },
  "anthropic/claude-sonnet-4-20250514": { inputPerM: 3.00, outputPerM: 15.00 },
  "openai/gpt-4.1-mini": { inputPerM: 0.40, outputPerM: 1.60 },
  "openai/gpt-4.1-mini-2025-04-14": { inputPerM: 0.40, outputPerM: 1.60 },
  "z-ai/glm-5": { inputPerM: 0.80, outputPerM: 2.56 },
};

export interface TokenEntry {
  input: number;
  output: number;
  model?: string;
}

/**
 * Compute estimated cost in USD from token entries with model info.
 * Falls back to defaultModel pricing when entry has no model field.
 * Returns 0 if no prices found.
 */
export function computeCostUsd(entries: TokenEntry[], defaultModel?: string): number {
  let total = 0;
  for (const entry of entries) {
    const model = entry.model ?? defaultModel;
    const prices = model ? lookupPrice(model) : undefined;
    if (prices) {
      total += (entry.input / 1_000_000) * prices.inputPerM;
      total += (entry.output / 1_000_000) * prices.outputPerM;
    }
  }
  return total;
}

/** Look up price by exact match, then by prefix match (handles version suffixes). */
function lookupPrice(model: string): ModelPrice | undefined {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // Try prefix match for versioned model IDs (e.g. "anthropic/claude-sonnet-4-6:beta")
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (model.startsWith(key)) return price;
  }
  return undefined;
}

export { MODEL_PRICES };
