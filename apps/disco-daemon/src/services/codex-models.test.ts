import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), key: vi.fn(), route: vi.fn() }));
vi.mock('@disco/core/config', async () => ({
  ...(await vi.importActual('@disco/core/config')),
  isTenantAgenticToolEnabled: async () => true,
  createUserProcessEnvironment: async () => ({
    CODEX_HOME: '/shared',
    OPENAI_API_KEY: 'ambient-key',
  }),
  resolveApiKey: mocks.key,
}));
vi.mock('@disco/core/db', () => ({
  getCurrentTenantId: () => 'tenant-a',
  runWithTenantDatabaseScope: async (
    _db: unknown,
    _tenant: unknown,
    work: (db: unknown) => unknown
  ) => work({}),
}));
vi.mock('./codex-auth-shared.js', () => ({
  usesServerSharedCodexAuth: () => false,
  resolveCodexCredentialRoute: mocks.route,
}));
vi.mock('../utils/spawn-executor.js', () => ({ runExecutorCommand: mocks.run }));

import { createCodexModelsService } from './codex-models';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.key.mockResolvedValue({
    useNativeAuth: false,
    apiKey: 'user-key',
    connection: { OPENAI_API_KEY: 'user-key' },
  });
  mocks.route.mockImplementation(async (id) => ({
    ok: true,
    userId: id,
    delegatedHomeKey: id,
    codexHome: `/users/${id}/.codex`,
  }));
  mocks.run.mockResolvedValue({
    success: true,
    data: { source: 'dynamic', default: 'new', models: [{ id: 'new' }] },
  });
});
afterEach(() => vi.restoreAllMocks());
const service = () =>
  createCodexModelsService({ get: () => ({}), service: () => ({}) } as never, {} as never);
const params = (id: string) => ({
  user: { user_id: id, username: id, role: 'member' },
  query: { userId: 'another-user' },
});

it('derives execution identity only from auth and resolves credentials on every read', async () => {
  const catalog = service();
  await catalog.find(params('user-a'));
  await catalog.find(params('user-b'));
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(mocks.run.mock.calls[0][1]).toMatchObject({
    delegatedHomeKey: 'user-a',
    env: { CODEX_HOME: '/users/user-a/.codex', OPENAI_API_KEY: 'user-key' },
    templateVariables: { user_id: 'user-a' },
    sensitiveOutput: true,
  });
  expect(mocks.run.mock.calls[1][1].env.CODEX_HOME).toBe('/users/user-b/.codex');
  expect(JSON.stringify(await catalog.find(params('user-b')))).not.toContain('user-key');
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(mocks.key).toHaveBeenCalledTimes(3);
});
it('invalidates the server cache when the resolved credential changes', async () => {
  const catalog = service();
  await catalog.find(params('user-a'));
  await catalog.find(params('user-a'));
  expect(mocks.run).toHaveBeenCalledOnce();
  mocks.key.mockResolvedValue({
    useNativeAuth: false,
    apiKey: 'replacement-key',
    connection: { OPENAI_API_KEY: 'replacement-key' },
  });
  await catalog.find(params('user-a'));
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(mocks.run.mock.calls[1][1].env.OPENAI_API_KEY).toBe('replacement-key');
});
it('serves a stale catalog immediately and refreshes it without a user action', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const catalog = service();
  await catalog.find(params('user-a'));
  mocks.run.mockResolvedValue({
    success: true,
    data: { source: 'dynamic', default: 'newer', models: [{ id: 'newer' }] },
  });
  now += 30 * 60_000 + 1;
  expect((await catalog.find(params('user-a'))).default).toBe('new');
  await vi.waitFor(async () =>
    expect((await catalog.find(params('user-a'))).default).toBe('newer')
  );
  expect(mocks.run).toHaveBeenCalledTimes(2);
});
it('deduplicates concurrent discovery and does not cache a failed fallback', async () => {
  let finish!: (value: unknown) => void;
  mocks.run.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const catalog = service();
  const first = catalog.find(params('user-a'));
  const second = catalog.find(params('user-a'));
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
  finish({ success: true, data: { source: 'dynamic', default: 'new', models: [{ id: 'new' }] } });
  expect((await first).source).toBe('dynamic');
  expect((await second).source).toBe('dynamic');

  mocks.run.mockRejectedValue(new Error('offline'));
  expect((await catalog.find(params('user-b'))).source).toBe('static');
  expect((await catalog.find(params('user-b'))).source).toBe('static');
  expect(mocks.run).toHaveBeenCalledTimes(3);
});
it('never returns another user catalog on failure or missing authentication', async () => {
  const catalog = service();
  await catalog.find(params('user-a'));
  mocks.run.mockRejectedValue(new Error('secret stderr'));
  const failed = await catalog.find(params('user-b'));
  expect(failed.source).toBe('static');
  expect(failed.models.some((model) => model.id === 'new')).toBe(false);
  await expect(catalog.find()).rejects.toThrow('登录');
});
