import type { TokenPricingRate } from '../types/user.js';

export const OPENAI_PRICING_SOURCE_URL = 'https://developers.openai.com/api/docs/models/compare';
export const GPT_6_ASTRA_PRICING_SOURCE_URL =
  'https://developers.openai.com/api/docs/models/gpt-6-astra';
export const DEFAULT_CNY_PER_USD = 7.2;

/**
 * Official OpenAI list prices captured on 2026-08-25, expressed in USD per
 * one million tokens. These are API-equivalent estimates; subscription usage
 * and special service tiers can be billed differently.
 */
export const OFFICIAL_TOKEN_PRICING: Readonly<Record<string, TokenPricingRate>> = {
  'gpt-6-astra': {
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    cacheWriteUsdPerMillion: 12.5,
    outputUsdPerMillion: 50,
    source: 'official',
    sourceUrl: GPT_6_ASTRA_PRICING_SOURCE_URL,
    updatedAt: '2026-09-05T00:00:00.000Z',
  },
  'gpt-5.6-sol': {
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 20,
    source: 'official',
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
  'gpt-5.6-terra': {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
    source: 'official',
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
  'gpt-5.6-luna': {
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.2,
    source: 'official',
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
};

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^openai\//, '');
}

export function officialPricingKeyForModel(modelId: string): string | undefined {
  const normalized = normalizeModelId(modelId);
  if (OFFICIAL_TOKEN_PRICING[normalized]) return normalized;
  return Object.keys(OFFICIAL_TOKEN_PRICING).find(
    (known) => normalized.startsWith(`${known}-`) || normalized.startsWith(`${known}[`)
  );
}

export function getOfficialTokenPricing(modelId: string): TokenPricingRate | undefined {
  const key = officialPricingKeyForModel(modelId);
  return key ? OFFICIAL_TOKEN_PRICING[key] : undefined;
}
