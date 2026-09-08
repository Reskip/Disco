import {
  DEFAULT_CNY_PER_USD,
  getOfficialTokenPricing,
  OFFICIAL_TOKEN_PRICING,
  type LeaderboardEntry,
  type TokenPricingPreferences,
  type TokenPricingRate,
} from '@disco-live/client';

const ONE_MILLION = 1_000_000;

export function getEffectiveTokenPricing(
  modelId: string,
  preferences?: TokenPricingPreferences
): TokenPricingRate | undefined {
  const exact = preferences?.models?.[modelId];
  return exact ?? getOfficialTokenPricing(modelId);
}

export function getEffectiveTokenPricingTable(
  preferences?: TokenPricingPreferences
): Record<string, TokenPricingRate> {
  return { ...OFFICIAL_TOKEN_PRICING, ...(preferences?.models ?? {}) };
}

export function estimateEntryCostUsd(
  entry: LeaderboardEntry,
  preferences?: TokenPricingPreferences
): number {
  const pricing = entry.model ? getEffectiveTokenPricing(entry.model, preferences) : undefined;
  if (!pricing) return Math.max(0, entry.totalCost || 0);

  const input = Math.max(0, entry.totalInputTokens || 0);
  const cachedInput = Math.min(input, Math.max(0, entry.totalCacheReadTokens || 0));
  const cacheWrite = Math.min(
    Math.max(0, entry.totalCacheCreationTokens || 0),
    Math.max(0, input - cachedInput)
  );
  const uncachedInput = Math.max(0, input - cachedInput - cacheWrite);
  const output = Math.max(0, entry.totalOutputTokens || 0);
  return (
    (uncachedInput * pricing.inputUsdPerMillion +
      cachedInput * pricing.cachedInputUsdPerMillion +
      cacheWrite * (pricing.cacheWriteUsdPerMillion ?? pricing.inputUsdPerMillion) +
      output * pricing.outputUsdPerMillion) /
    ONE_MILLION
  );
}

export function estimateEntriesCostCny(
  entries: LeaderboardEntry[],
  preferences?: TokenPricingPreferences
): number {
  const cnyPerUsd = Math.max(0, preferences?.cnyPerUsd ?? DEFAULT_CNY_PER_USD);
  return entries.reduce((sum, entry) => sum + estimateEntryCostUsd(entry, preferences), 0) * cnyPerUsd;
}

export function formatEstimatedCny(value: number, locale: string): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'CNY',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeValue);
}
