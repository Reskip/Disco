import os from 'node:os';
import { loadManagedAgenticToolSdk } from '@disco/core/agentic-integrations';
import type * as CodexSdk from '@openai/codex-sdk';
import type { CodexGenerateTitlePayload, ExecutorResult } from '../payload-types.js';
import { buildCodexHttpsTransportConfig } from '../sdk-handlers/codex/https-transport.js';

const TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
  },
  required: ['title'],
  additionalProperties: false,
} as const;

function normalizeGeneratedTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const compact = value
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/[。！？!?：:；;]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(compact);
  return characters.length > 42 ? `${characters.slice(0, 41).join('')}…` : compact;
}

export async function handleCodexGenerateTitle(
  payload: CodexGenerateTitlePayload
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
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 25_000);
  try {
    const result = await thread.run(
      [
        '将下面的用户消息概括成一个简短会话标题：使用同一语言，准确概括意图，不要机械复制开头，不要引号、句号、前缀或解释。',
        '',
        payload.params.prompt,
      ].join('\n'),
      { outputSchema: TITLE_OUTPUT_SCHEMA, signal: abortController.signal }
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.finalResponse);
    } catch {
      parsed = { title: result.finalResponse };
    }
    const title = normalizeGeneratedTitle((parsed as { title?: unknown })?.title);
    if (!title) {
      return {
        success: false,
        error: { code: 'EMPTY_GENERATED_TITLE', message: 'Codex returned an empty title' },
      };
    }
    return { success: true, data: { title } };
  } finally {
    clearTimeout(timeout);
  }
}
