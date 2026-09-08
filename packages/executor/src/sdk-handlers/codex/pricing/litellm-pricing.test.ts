import { describe, expect, it } from 'vitest';
import { estimateCodexCostUsd, getLiteLlmPricingForModel } from './litellm-pricing.js';

describe('LiteLLM Codex pricing snapshot', () => {
  it('contains current Codex default model pricing', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const pricing = getLiteLlmPricingForModel(model);

      expect(pricing?.input_cost_per_token).toBeGreaterThan(0);
      expect(pricing?.output_cost_per_token).toBeGreaterThan(0);
      expect(pricing?.cache_read_input_token_cost).toBeGreaterThan(0);
    }
  });

  it('contains the verified GPT-6 Astra base and long-context rates', () => {
    const pricing = getLiteLlmPricingForModel('gpt-6-astra');

    expect(pricing?.input_cost_per_token).toBe(0.00001);
    expect(pricing?.cache_read_input_token_cost).toBe(0.000001);
    expect(pricing?.output_cost_per_token).toBe(0.00005);
    expect(pricing?.input_cost_per_token_above_272k_tokens).toBe(0.00002);
    expect(pricing?.output_cost_per_token_above_272k_tokens).toBe(0.000075);
  });

  it('estimates GPT-6 Astra base cost from a task-local token delta', () => {
    expect(
      estimateCodexCostUsd({
        modelId: 'gpt-6-astra',
        inputTokens: 10_000,
        cacheReadTokens: 4_000,
        outputTokens: 1_000,
      })
    ).toBeCloseTo(0.114, 8);
  });

  it('prices GPT-6 Astra prompt-cache writes without double-counting input', () => {
    expect(
      estimateCodexCostUsd({
        modelId: 'gpt-6-astra',
        inputTokens: 10_000,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 2_000,
        outputTokens: 1_000,
      })
    ).toBeCloseTo(0.119, 8);
  });

  it('estimates cost with cached input tokens as a subset of input tokens', () => {
    const cost = estimateCodexCostUsd({
      modelId: 'gpt-5.6-sol',
      inputTokens: 10_000,
      cacheReadTokens: 4_000,
      outputTokens: 1_000,
    });

    // gpt-5.6-sol snapshot: 6k uncached input * $0.000005 +
    // 4k cached input * $0.0000005 + 1k output * $0.00003.
    expect(cost).toBeCloseTo(0.062, 8);
  });

  it('does not infer long-context pricing from cumulative Codex input tokens', () => {
    const cost = estimateCodexCostUsd({
      modelId: 'gpt-5.6-sol',
      inputTokens: 300_000,
      cacheReadTokens: 100_000,
      outputTokens: 10_000,
    });

    // Codex SDK input usage is cumulative across the agent loop; 300k here
    // does not prove any single model request crossed the 272k tier. Use base
    // prices until Codex exposes per-request pricing-tier information:
    // 200k uncached input * $0.000005 +
    // 100k cached input * $0.0000005 + 10k output * $0.00003.
    expect(cost).toBeCloseTo(1.35, 8);
  });

  it('returns undefined for unknown explicit models instead of guessing', () => {
    expect(
      estimateCodexCostUsd({
        modelId: 'future-model-not-in-pricing-map',
        inputTokens: 1_000,
        outputTokens: 1_000,
      })
    ).toBeUndefined();
  });
});
