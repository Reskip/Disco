import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoStore } from '../store/discoStore';
import { SESSION_STATUS_REFRESH_MS, useConversationData } from './useConversationData';

type Listener = (payload: unknown) => void;

function makeClient(
  seed: Record<string, unknown[]> = {},
  findAllOverrides: Record<string, Promise<unknown[]>> = {},
  getOverrides: Record<string, Promise<unknown>> = {}
) {
  const requestedServices: string[] = [];
  const listeners = new Map<string, Map<string, Listener[]>>();
  const ioListeners = new Map<string, Listener[]>();

  const service = (name: string) => {
    requestedServices.push(name);
    return {
      find: vi.fn(() => Promise.resolve({ data: seed[name] ?? [] })),
      findAll: vi.fn(() => findAllOverrides[name] ?? Promise.resolve(seed[name] ?? [])),
      get: vi.fn(
        (id: string) =>
          getOverrides[name] ??
          Promise.resolve(
            seed[`${name}:get`]?.[0] ??
              seed[name]?.find((value) => (value as { session_id?: string }).session_id === id) ??
              null
          )
      ),
      on: (event: string, listener: Listener) => {
        const serviceListeners = listeners.get(name) ?? new Map<string, Listener[]>();
        serviceListeners.set(event, [...(serviceListeners.get(event) ?? []), listener]);
        listeners.set(name, serviceListeners);
      },
      removeListener: (event: string, listener: Listener) => {
        const serviceListeners = listeners.get(name);
        if (!serviceListeners) return;
        serviceListeners.set(
          event,
          (serviceListeners.get(event) ?? []).filter((candidate) => candidate !== listener)
        );
      },
    };
  };

  return {
    client: {
      service,
      io: {
        on: (event: string, listener: Listener) =>
          ioListeners.set(event, [...(ioListeners.get(event) ?? []), listener]),
        off: (event: string, listener: Listener) =>
          ioListeners.set(
            event,
            (ioListeners.get(event) ?? []).filter((candidate) => candidate !== listener)
          ),
      },
    } as never,
    requestedServices,
    emitIo: (event: string) => {
      for (const listener of ioListeners.get(event) ?? []) listener(undefined);
    },
    emitService: (name: string, event: string, value: unknown) => {
      for (const listener of listeners.get(name)?.get(event) ?? []) listener(value);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const runningSession = {
  session_id: 's-1',
  status: 'running',
  ready_for_prompt: false,
  archived: false,
  created_at: '2026-09-11T00:00:00.000Z',
  updated_at: '2026-09-11T00:00:00.000Z',
};
const completedSession = {
  ...runningSession,
  status: 'idle',
  ready_for_prompt: true,
  updated_at: '2026-09-11T00:00:10.000Z',
};

async function waitForLoad(result: {
  current: ReturnType<typeof useConversationData>;
}): Promise<void> {
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
    expect(result.current.initialSyncComplete).toBe(true);
  });
}

describe('useConversationData', () => {
  beforeEach(() => {
    discoStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('cold-loads only current conversation services', async () => {
    const session = {
      session_id: 's-1',
      status: 'idle',
      archived: false,
      created_at: '2026-08-29T00:00:00.000Z',
      updated_at: '2026-08-29T00:00:00.000Z',
    };
    const { client, requestedServices } = makeClient({ sessions: [session] });

    const { result } = renderHook(() => useConversationData(client));
    await waitForLoad(result);

    await waitFor(() => expect(requestedServices).toContain('agentic-tool-settings'));

    expect(new Set(requestedServices)).toEqual(
      new Set(['sessions', 'users', 'mcp-servers', 'session-mcp-servers', 'agentic-tool-settings'])
    );
    expect(requestedServices).not.toEqual(
      expect.arrayContaining([
        'repos',
        'branches',
        'boards',
        'board-objects',
        'card-types',
        'cards',
        'artifacts',
        'board-comments',
      ])
    );
    expect(discoStore.getState().sessionById.get('s-1')).toMatchObject(session);
  });

  it('does not hold the first usable frame on secondary settings collections', async () => {
    const never = new Promise<unknown[]>(() => {});
    const { client } = makeClient(
      {
        sessions: [
          {
            session_id: 's-fast',
            status: 'idle',
            archived: false,
            created_at: '2026-09-06T00:00:00.000Z',
            updated_at: '2026-09-06T00:00:00.000Z',
          },
        ],
      },
      {
        'mcp-servers': never,
        'session-mcp-servers': never,
        'agentic-tool-settings': never,
      }
    );

    const { result } = renderHook(() => useConversationData(client));
    await waitForLoad(result);

    expect(discoStore.getState().sessionById.has('s-fast')).toBe(true);
  });

  it('uses the same current-service snapshot on reconnect', async () => {
    const { client, requestedServices, emitIo } = makeClient();
    const { result } = renderHook(() => useConversationData(client));
    await waitForLoad(result);
    requestedServices.length = 0;

    await act(async () => emitIo('connect'));
    await waitFor(() => expect(requestedServices).toContain('sessions'));

    expect(new Set(requestedServices)).toEqual(
      new Set(['sessions', 'users', 'mcp-servers', 'session-mcp-servers', 'agentic-tool-settings'])
    );
  });

  it('keeps a completion received while the initial snapshot is in flight', async () => {
    const users = deferred<unknown[]>();
    const background = deferred<unknown[]>();
    const { client, emitService } = makeClient(
      { sessions: [runningSession] },
      { users: users.promise, sessions: background.promise }
    );
    const { result } = renderHook(() => useConversationData(client));
    act(() => emitService('sessions', 'patched', completedSession));
    await act(async () => users.resolve([]));
    await waitForLoad(result);
    expect(discoStore.getState().sessionById.get('s-1')).toEqual(completedSession);
  });

  it('keeps live completions, creations, and removals over a delayed background snapshot', async () => {
    const settings = deferred<unknown[]>();
    const removedSession = { ...runningSession, session_id: 's-removed' };
    const createdSession = { ...completedSession, session_id: 's-new' };
    const { client, requestedServices, emitService } = makeClient(
      { sessions: [runningSession, removedSession] },
      { 'mcp-servers': settings.promise }
    );
    const { result } = renderHook(() => useConversationData(client));
    await waitForLoad(result);
    await waitFor(() => expect(requestedServices).toContain('mcp-servers'));
    act(() => {
      emitService('sessions', 'patched', completedSession);
      emitService('sessions', 'removed', removedSession);
      emitService('sessions', 'created', createdSession);
    });
    await act(async () => settings.resolve([]));
    expect(discoStore.getState().sessionById.get('s-1')).toEqual(completedSession);
    expect(discoStore.getState().sessionById.has('s-removed')).toBe(false);
    expect(discoStore.getState().sessionById.get('s-new')).toEqual(createdSession);
  });

  it('switches between loaded sessions without refetching the workspace', async () => {
    const { client, requestedServices } = makeClient({
      sessions: [runningSession, { ...completedSession, session_id: 's-2' }],
    });
    const { result, rerender } = renderHook(
      ({ id }) => useConversationData(client, { directSessionId: id }),
      { initialProps: { id: 's-1' } }
    );
    await waitForLoad(result);
    await waitFor(() => expect(requestedServices).toContain('agentic-tool-settings'));
    requestedServices.length = 0;
    rerender({ id: 's-2' });
    await act(async () => {});
    expect(requestedServices).toEqual([]);
  });

  it('recovers a missed completion when the window regains focus', async () => {
    const seed = { sessions: [runningSession] };
    const { client, requestedServices } = makeClient(seed);
    const { result } = renderHook(() => useConversationData(client));
    await waitForLoad(result);
    await waitFor(() => expect(requestedServices).toContain('agentic-tool-settings'));
    seed.sessions = [completedSession];
    await act(async () => window.dispatchEvent(new Event('focus')));
    await waitFor(() =>
      expect(discoStore.getState().sessionById.get('s-1')).toEqual(completedSession)
    );
  });

  it('periodically reconciles active sessions and pauses requests while hidden', async () => {
    vi.useFakeTimers();
    const seed = { sessions: [runningSession] };
    const { client, requestedServices } = makeClient(seed);
    const { unmount } = renderHook(() => useConversationData(client));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    seed.sessions = [completedSession];
    requestedServices.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_STATUS_REFRESH_MS);
    });
    expect(requestedServices).toEqual([]);
    expect(discoStore.getState().sessionById.get('s-1')).toEqual(runningSession);
    visibility.mockReturnValue('visible');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_STATUS_REFRESH_MS);
    });
    expect(discoStore.getState().sessionById.get('s-1')).toEqual(completedSession);
    requestedServices.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_STATUS_REFRESH_MS);
    });
    expect(requestedServices).toEqual([]);
    unmount();
  });

  it('does not let a recovery response overwrite a newer run', async () => {
    const responses: Record<string, Promise<unknown>> = {};
    const { client, requestedServices, emitService } = makeClient(
      { sessions: [runningSession] },
      {},
      responses
    );
    const { result } = renderHook(() => useConversationData(client));
    await waitForLoad(result);
    await waitFor(() => expect(requestedServices).toContain('agentic-tool-settings'));
    const response = deferred<unknown>();
    responses.sessions = response.promise;
    act(() => window.dispatchEvent(new Event('focus')));
    const newRun = {
      ...runningSession,
      tasks: ['new-task'],
      last_updated: '2026-09-11T00:00:20.000Z',
    };
    act(() => emitService('sessions', 'patched', newRun));
    await act(async () => response.resolve(completedSession));
    expect(discoStore.getState().sessionById.get('s-1')).toEqual(newRun);
  });

  it('discards a recovery response after the account is disabled', async () => {
    const responses: Record<string, Promise<unknown>> = {};
    const { client, requestedServices } = makeClient({ sessions: [runningSession] }, {}, responses);
    const { result, rerender } = renderHook(
      ({ enabled }) => useConversationData(client, { enabled }),
      { initialProps: { enabled: true } }
    );
    await waitForLoad(result);
    await waitFor(() => expect(requestedServices).toContain('agentic-tool-settings'));
    const response = deferred<unknown>();
    responses.sessions = response.promise;
    act(() => window.dispatchEvent(new Event('focus')));
    rerender({ enabled: false });
    discoStore.getState().reset();
    await act(async () => response.resolve(completedSession));
    expect(discoStore.getState().sessionById.size).toBe(0);
  });

  it('loads an uncached deep link without reloading other collections', async () => {
    const linkedSession = { ...completedSession, session_id: 's-linked' };
    const { client, requestedServices } = makeClient({
      sessions: [runningSession],
      'sessions:get': [linkedSession],
    });
    const { result, rerender } = renderHook(
      ({ id }) => useConversationData(client, { directSessionId: id }),
      { initialProps: { id: 's-1' } }
    );
    await waitForLoad(result);
    await waitFor(() => expect(requestedServices).toContain('agentic-tool-settings'));
    requestedServices.length = 0;
    rerender({ id: 's-linked' });
    await waitFor(() =>
      expect(discoStore.getState().sessionById.get('s-linked')).toEqual(linkedSession)
    );
    expect(requestedServices).toEqual(['sessions']);
  });
});
