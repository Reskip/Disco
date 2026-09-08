import os from 'node:os';
import { loadManagedAgenticToolSdk } from '@disco/core/agentic-integrations';
import type * as CodexSdk from '@openai/codex-sdk';
import type { CodexLookupTokenPricingPayload, ExecutorResult } from '../payload-types.js';
import { buildCodexHttpsTransportConfig } from '../sdk-handlers/codex/https-transport.js';

const PRICING_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    model: { type: 'string' },
    inputUsdPerMillion: { type: ['number', 'null'] },
    cachedInputUsdPerMillion: { type: ['number', 'null'] },
    outputUsdPerMillion: { type: ['number', 'null'] },
    sourceUrl: { type: ['string', 'null'] },
  },
  required: [
    'found',
    'model',
    'inputUsdPerMillion',
    'cachedInputUsdPerMillion',
    'outputUsdPerMillion',
    'sourceUrl',
  ],
  additionalProperties: false,
} as const;

interface PricingResult {
  found?: unknown;
  model?: unknown;
  inputUsdPerMillion?: unknown;
  cachedInputUsdPerMillion?: unknown;
  outputUsdPerMillion?: unknown;
  sourceUrl?: unknown;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function handleCodexLookupTokenPricing(
  payload: CodexLookupTokenPricingPayload
): Promise<ExecutorResult> {
  const Codex = await loadManagedAgenticToolSdk<typeof CodexSdk>('codex');
  const client = new Codex.Codex({
    config: buildCodexHttpsTransportConfig({ useNativeAuth: true }),
  });
  const thread = client.startThread({
    model: 'gpt-5.6-luna',
    modelReasoningEffort: 'low',
    sandboxMode: 'read-only',
    workingDirectory: os.tmpdir(),
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    webSearchMode: 'live',
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 45_000);
  try {
    const result = await thread.run(
      [
        `查找模型 ${payload.params.model} 的官方 OpenAI API 标价。`,
        '只能使用 developers.openai.com 或 openai.com 官方资料。',
        '返回每 100 万 Token 的美元价格，分别为普通输入、缓存输入和输出。',
        '如果官方资料没有这个模型，found=false；不要猜测，不要使用第三方报价。',
      ].join('\n'),
      { outputSchema: PRICING_OUTPUT_SCHEMA, signal: abortController.signal }
    );

    let parsed: PricingResult;
    try {
      parsed = JSON.parse(result.finalResponse) as PricingResult;
    } catch {
      return {
        success: false,
        error: { code: 'INVALID_PRICING_RESPONSE', message: 'Codex returned invalid pricing JSON' },
      };
    }
    const input = nonNegativeNumber(parsed.inputUsdPerMillion);
    const cached = nonNegativeNumber(parsed.cachedInputUsdPerMillion);
    const output = nonNegativeNumber(parsed.outputUsdPerMillion);
    const sourceUrl = typeof parsed.sourceUrl === 'string' ? parsed.sourceUrl.trim() : '';
    const officialSource = /^https:\/\/(?:[^/]+\.)?(?:openai\.com|developers\.openai\.com)\//i.test(
      sourceUrl
    );
    if (parsed.found !== true || input === null || cached === null || output === null || !officialSource) {
      return {
        success: false,
        error: { code: 'OFFICIAL_PRICING_NOT_FOUND', message: 'Official model pricing was not found' },
      };
    }
    return {
      success: true,
      data: {
        model: payload.params.model,
        inputUsdPerMillion: input,
        cachedInputUsdPerMillion: cached,
        outputUsdPerMillion: output,
        sourceUrl,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
