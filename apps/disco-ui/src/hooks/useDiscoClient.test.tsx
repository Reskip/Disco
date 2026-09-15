import { createClient } from '@disco-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findConversationPage } from '../utils/conversationHttp';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';
import { useDiscoClient } from './useDiscoClient';

vi.mock('../utils/conversationHttp', () => ({ findConversationPage: vi.fn() }));

// Keep every real export; only stub the client factory so the hook wires a
// controllable mock instead of opening a real socket.
vi.mock('@disco-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@disco-live/client')>()),
  createClient: vi.fn(),
}));

// Mock only refreshAndReauthenticate so the reconnect refresh-fallback path is
// drivable; keep the event name + error class real for the other paths.
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('../utils/singleFlightRefresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/singleFlightRefresh')>()),
  refreshAndReauthenticate: refreshMock,
}));

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Mock client that drives the REAL connect→authenticate flow: io.connect()
// marks the socket connected so connect()'s wait-promise resolves; io 'connect'
// handlers are captured so reconnects can be fired; authenticate() resolves by
// default and can be overridden per-call. Unknown property access resolves to a
// no-op fn so the rest of connect() can't throw.
function makeSeamClient() {
  const create = vi.fn(async () => ({ session_id: '', subscribed: false }));
  const ioHandlers: Record<string, Array<(...a: unknown[]) => void>> = {};

  const permissive = (target: Record<string, unknown>) =>
    new Proxy(target, {
      get(t, prop: string) {
        if (prop in t) return t[prop];
        const fn = vi.fn();
        t[prop] = fn;
        return fn;
      },
    });

  const io = permissive({
    connected: false,
    on: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
      const handlers = ioHandlers[event] ?? [];
      handlers.push(handler);
      ioHandlers[event] = handlers;
    }),
    once: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(() => {
      io.connected = true; // wait-for-connection resolves on next check
    }),
  });

  const client = permissive({
    io,
    on: vi.fn(),
    off: vi.fn(),
    hooks: vi.fn(),
    service: vi.fn((name: string) => (name === 'session-streams' ? { create } : permissive({}))),
    authenticate: vi.fn(() => Promise.resolve({})),
  });

  const fireIo = (event: string) => {
    for (const handler of [...(ioHandlers[event] ?? [])]) handler();
  };
  return { client, create, fireIo };
}

type AroundHook = (
  context: {
    path: string;
    method: string;
    params?: Record<string, unknown>;
    arguments?: unknown[];
    result?: unknown;
  },
  next: () => Promise<void>
) => Promise<void>;

function registeredAroundHook(client: ReturnType<typeof makeSeamClient>['client']): AroundHook {
  const registration = client.hooks.mock.calls[0]?.[0] as
    | { around?: { all?: AroundHook[] } }
    | undefined;
  const hook = registration?.around?.all?.[0];
  if (!hook) throw new Error('Expected useDiscoClient to register its authentication hook');
  return hook;
}

describe('useDiscoClient session-streams announce seam', () => {
  it('uses HTTP only for opted-in conversation reads and leaves realtime operations on the socket', async () => {
    const { client } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    renderHook(() => useDiscoClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(client.hooks).toHaveBeenCalled());
    const page = { data: [], total: 0, skip: 0, limit: 1000 };
    vi.mocked(findConversationPage).mockResolvedValue(page);
    const query = { session_id: 'session', view: 'conversation', $limit: 1000 };
    const context = { path: 'messages', method: 'find', params: { query }, result: undefined };
    const next = vi.fn().mockResolvedValue(undefined);
    const hook = registeredAroundHook(client);
    await hook(context, next);
    expect(context.result).toBe(page);
    expect(findConversationPage).toHaveBeenCalledWith('http://daemon.test', query);
    expect(next).not.toHaveBeenCalled();
    await hook({ path: 'messages', method: 'create', params: {} }, next);
    await hook(
      { path: 'messages', method: 'find', params: { query: { session_id: 'session' } } },
      next
    );
    expect(next).toHaveBeenCalledTimes(2);
  });
  afterEach(() => {
    vi.clearAllMocks();
    refreshMock.mockReset();
  });

  it('announces session-streams capability only after authenticate() resolves', async () => {
    const { client, create } = makeSeamClient();
    const authDeferred = makeDeferred<Record<string, unknown>>();
    client.authenticate.mockReturnValue(authDeferred.promise);
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useDiscoClient({ url: 'http://daemon.test', accessToken: 'access-token' }));

    // Drive the flow up to the pending authenticate() call.
    await waitFor(() => expect(client.authenticate).toHaveBeenCalled());

    // Pre-auth: announcing here would 401 — must NOT have fired yet.
    expect(create).not.toHaveBeenCalled();

    authDeferred.resolve({});
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ capability: true });
  });

  it('re-announces on reconnect direct re-auth', async () => {
    const { client, create, fireIo } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useDiscoClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); // initial auth

    // First connect marks hasConnectedOnce; the second runs the reconnect
    // handler (isReconnect=true) → direct authenticate() resolves → announce.
    fireIo('connect');
    fireIo('connect');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith({ capability: true });
  });

  it('re-announces on reconnect refresh-fallback', async () => {
    const { client, create, fireIo } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useDiscoClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); // initial auth

    fireIo('connect'); // marks hasConnectedOnce
    // Reconnect: direct authenticate() rejects, refresh succeeds → announce.
    client.authenticate.mockRejectedValueOnce(new Error('jwt expired'));
    refreshMock.mockResolvedValue({ accessToken: 'fresh', refreshToken: 'r' });
    fireIo('connect');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith({ capability: true });
  });

  it('re-announces on in-place token-refresh reauth', async () => {
    const { client, create } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useDiscoClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); // initial auth

    // Token replacement on the live socket → in-place authenticate() resolves → announce.
    window.dispatchEvent(
      new CustomEvent(TOKENS_REFRESHED_EVENT, {
        detail: { accessToken: 'fresh', refreshToken: 'r' },
      })
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith({ capability: true });
  });

  it('does not leak a raw jwt-expired error when refresh is temporarily unavailable', async () => {
    const { client } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useDiscoClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(client.hooks).toHaveBeenCalledTimes(1));

    refreshMock.mockRejectedValue(Object.assign(new Error('service unavailable'), { code: 503 }));
    const next = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('jwt expired'), { name: 'NotAuthenticated', code: 401 })
      );

    await expect(
      registeredAroundHook(client)(
        { path: 'messages', method: 'find', params: {}, arguments: [{}] },
        next
      )
    ).rejects.toThrow('连接暂时中断，请稍后重试。');
  });

  it('uses the localized session-expired error when no refresh token can recover the call', async () => {
    const { client } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useDiscoClient({ url: 'http://daemon.test', accessToken: 'access-token' }));
    await waitFor(() => expect(client.hooks).toHaveBeenCalledTimes(1));

    refreshMock.mockResolvedValue(null);
    const next = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('jwt expired'), { name: 'NotAuthenticated', code: 401 })
      );

    await expect(
      registeredAroundHook(client)(
        { path: 'messages', method: 'find', params: {}, arguments: [{}] },
        next
      )
    ).rejects.toThrow('登录状态已过期，请重新登录。');
  });

  it('reconnects a suspended mobile socket when the page is restored', async () => {
    const { client, create } = makeSeamClient();
    vi.mocked(createClient).mockReturnValue(client as never);

    const { unmount } = renderHook(() =>
      useDiscoClient({ url: 'http://daemon.test', accessToken: 'access-token' })
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const initialConnectCalls = client.io.connect.mock.calls.length;

    client.io.connected = false;
    client.io.active = false;
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
    });

    expect(client.io.connect).toHaveBeenCalledTimes(initialConnectCalls + 1);
    unmount();
  });

  it('uses the refresh token when initial socket authentication races access-token expiry', async () => {
    const { client, create } = makeSeamClient();
    client.authenticate
      .mockRejectedValueOnce(
        Object.assign(new Error('jwt expired'), { name: 'NotAuthenticated', code: 401 })
      )
      .mockResolvedValue({});
    refreshMock.mockResolvedValue({ accessToken: 'fresh', refreshToken: 'refresh' });
    vi.mocked(createClient).mockReturnValue(client as never);

    renderHook(() => useDiscoClient({ url: 'http://daemon.test', accessToken: 'expired-token' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
});
