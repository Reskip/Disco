import type {
  CodexModelCatalog,
  LeaderboardEntry,
  TokenPricingPreferences,
} from '@disco-live/client';
import { describe, expect, it } from 'vitest';
import {
  estimateEntriesCostCny,
  estimateEntryCostUsd,
  formatEstimatedCny,
  getCatalogTokenPricingRows,
  getEffectiveTokenPricing,
  hasCompleteTokenPricing,
} from './tokenPricing';

const entry = (overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
  model: 'gpt-5.6-sol',
  totalTokens: 11_000,
  totalInputTokens: 10_000,
  totalOutputTokens: 1_000,
  totalCacheReadTokens: 4_000,
  totalCacheCreationTokens: 0,
  totalCost: 0,
  taskCount: 1,
  sessionCount: 1,
  totalDurationMs: 0,
  ...overrides,
});

describe('token pricing', () => {
  it('uses current catalog order, omits hidden models, and leaves unknown prices unset', () => {
    const catalog: CodexModelCatalog = {
      source: 'dynamic',
      default: 'gpt-6-sol',
      models: ['gpt-6-sol', 'gpt-5.6-sol', 'hidden-model'].map((id) => ({
        id,
        displayName: id,
        hidden: id === 'hidden-model',
        isDefault: id === 'gpt-6-sol',
      })),
    };
    const manual = {
      model: 'gpt-5.6-sol',
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.2,
      outputUsdPerMillion: 5,
      source: 'manual' as const,
      updatedAt: '2026-10-09T00:00:00Z',
    };
    const rows = getCatalogTokenPricingRows(catalog, [manual, { model: 'retired-model' }]);
    expect(rows).toEqual([{ model: 'gpt-6-sol' }, manual]);
    expect(hasCompleteTokenPricing(rows[0]!)).toBe(false);
    expect(hasCompleteTokenPricing(rows[1]!)).toBe(true);
  });

  it('distinguishes incomplete pricing from a deliberately entered zero rate', () => {
    const draft = { model: 'new-model', source: 'manual' as const, updatedAt: '2026-10-09' };
    expect(hasCompleteTokenPricing({ ...draft, inputUsdPerMillion: 0 })).toBe(false);
    expect(
      hasCompleteTokenPricing({
        ...draft,
        inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
      })
    ).toBe(true);
    expect(
      hasCompleteTokenPricing({
        ...draft,
        inputUsdPerMillion: Number.NaN,
        cachedInputUsdPerMillion: 0,
        outputUsdPerMillion: 1,
      })
    ).toBe(false);
  });

  it('prices cached input separately using the official model table', () => {
    expect(estimateEntryCostUsd(entry())).toBeCloseTo(0.0456, 8);
  });

  it('prefers a user override and converts to CNY', () => {
    const preferences: TokenPricingPreferences = {
      cnyPerUsd: 7,
      models: {
        'gpt-5.6-sol': {
          inputUsdPerMillion: 1,
          cachedInputUsdPerMillion: 0.1,
          outputUsdPerMillion: 2,
          source: 'manual',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      },
    };

    expect(estimateEntriesCostCny([entry()], preferences)).toBeCloseTo(0.0588, 8);
    expect(getEffectiveTokenPricing('gpt-5.6-sol', preferences)?.source).toBe('manual');
  });

  it('falls back to the persisted task estimate for an unknown model', () => {
    expect(estimateEntryCostUsd(entry({ model: 'future-model', totalCost: 0.25 }))).toBe(0.25);
  });

  it('prices GPT-6 Astra cache writes from the official table', () => {
    expect(
      estimateEntryCostUsd(
        entry({
          model: 'gpt-6-astra',
          totalInputTokens: 10_000,
          totalCacheReadTokens: 4_000,
          totalCacheCreationTokens: 2_000,
          totalOutputTokens: 1_000,
        })
      )
    ).toBeCloseTo(0.119, 8);
  });

  it('always formats estimates with exactly two decimal places', () => {
    expect(() => formatEstimatedCny(123.45, 'zh-CN')).not.toThrow();
    expect(formatEstimatedCny(123.45, 'zh-CN')).toContain('123.45');
    expect(formatEstimatedCny(1, 'zh-CN')).toContain('1.00');
    expect(formatEstimatedCny(0.004, 'zh-CN')).toContain('0.00');
  });

  it('normalizes non-finite and negative estimates before formatting', () => {
    expect(formatEstimatedCny(Number.NaN, 'zh-CN')).toContain('0.00');
    expect(formatEstimatedCny(-10, 'zh-CN')).toContain('0.00');
  });
});
