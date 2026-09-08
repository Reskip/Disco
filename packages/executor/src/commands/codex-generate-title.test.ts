import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.fn();
const startThread = vi.fn(() => ({ run }));
const constructCodex = vi.fn();

vi.mock('@disco/core/agentic-integrations', () => ({
  loadManagedAgenticToolSdk: vi.fn(async () => ({
    Codex: class {
      constructor(options: unknown) {
        constructCodex(options);
      }
      startThread = startThread;
    },
  })),
}));

import { handleCodexGenerateTitle } from './codex-generate-title.js';

describe('codex.generate-title', () => {
  beforeEach(() => {
    run.mockReset();
    startThread.mockClear();
    constructCodex.mockClear();
  });

  it('uses the fast minimal model and returns a normalized title', async () => {
    run.mockResolvedValue({ finalResponse: JSON.stringify({ title: '“修复 Disco 活动流。”' }) });

    const result = await handleCodexGenerateTitle({
      command: 'codex.generate-title',
      params: { prompt: '请把 Disco 的活动流改成 Codex 样式' },
    });

    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-luna', modelReasoningEffort: 'low' })
    );
    expect(constructCodex).toHaveBeenCalledWith({
      config: expect.objectContaining({
        model_provider: 'disco_openai_https',
        model_providers: expect.objectContaining({
          disco_openai_https: expect.objectContaining({
            wire_api: 'responses',
            supports_websockets: false,
          }),
        }),
      }),
    });
    expect(result).toEqual({ success: true, data: { title: '修复 Disco 活动流' } });
  });
});
