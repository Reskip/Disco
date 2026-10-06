import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), close: vi.fn(), options: vi.fn() }));
vi.mock('../sdk-handlers/codex/app-server-client.js', () => ({
  CodexAppServerClient: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    listModels = mocks.list;
    close = mocks.close;
  },
}));
vi.mock('../sdk-handlers/codex/runtime-environment.js', () => ({
  ensureDiscoCodexRuntimeHome: async () => '/disco/runtime',
  buildDiscoCodexChildEnvironment: (_source: unknown, options: unknown) => options,
}));

import { handleCodexModels } from './codex-models';

beforeEach(() => vi.clearAllMocks());
it('lists metadata in the execution home without starting a conversation', async () => {
  mocks.list.mockResolvedValue([{ model: 'new-model', displayName: 'New model' }]);
  const result = await handleCodexModels(
    { command: 'codex.models', params: { useNativeAuth: true, sharedRuntime: true } },
    {}
  );
  expect(result.success).toBe(true);
  expect(mocks.options).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ codexHome: '/disco/runtime', useSubscription: true }),
    })
  );
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('closes the subprocess on failure and does not return potentially sensitive stderr', async () => {
  mocks.list.mockRejectedValue(new Error('sensitive stderr'));
  const result = await handleCodexModels(
    { command: 'codex.models', params: { useNativeAuth: false, sharedRuntime: false } },
    {}
  );
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain('sensitive stderr');
  expect(mocks.close).toHaveBeenCalledOnce();
});
