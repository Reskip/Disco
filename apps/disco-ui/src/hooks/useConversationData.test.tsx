import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoStore } from '../store/discoStore';
import { useConversationData } from './useConversationData';

type Listener = (payload: unknown) => void;

function makeClient(
  seed: Record<string, unknown[]> = {},
  findAllOverrides: Record<string, Promise<unknown[]>> = {}
) {
  const requestedServices: string[] = [];
  const listeners = new Map<string, Map<string, Listener[]>>();
  const ioListeners = new Map<string, Listener[]>();

  const service = (name: string) => {
    requestedServices.push(name);
    return {
      find: vi.fn().mockResolvedValue({ data: seed[name] ?? [] }),
      findAll: vi.fn(() => findAllOverrides[name] ?? Promise.resolve(seed[name] ?? [])),
      get: vi.fn().mockResolvedValue(seed[`${name}:get`]?.[0] ?? null),
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
  };
}

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
      new Set([
        'sessions',
        'users',
        'mcp-servers',
        'session-mcp-servers',
        'agentic-tool-settings',
      ])
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
      new Set([
        'sessions',
        'users',
        'mcp-servers',
        'session-mcp-servers',
        'agentic-tool-settings',
      ])
    );
  });
});
