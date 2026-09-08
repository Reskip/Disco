import type { DiscoClient, Session } from '@disco-live/client';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionActions } from './useSessionActions';

function makeClient(services: Record<string, unknown>): DiscoClient {
  return {
    service: vi.fn((name: string) => {
      const service = services[name];
      if (!service) throw new Error(`Unexpected service: ${name}`);
      return service;
    }),
  } as unknown as DiscoClient;
}

describe('useSessionActions archive helpers', () => {
  it('archives through the cascade archive route instead of generic sessions.patch', async () => {
    const archivedSession = { session_id: 'session-1', archived: true } as Session;
    const archiveCreate = vi.fn(async () => ({ session: archivedSession }));
    const sessionsPatch = vi.fn();
    const client = makeClient({
      'sessions/session-1/archive': { create: archiveCreate },
      sessions: { patch: sessionsPatch },
    });

    const { result } = renderHook(() => useSessionActions(client));
    let returned: Session | null = null;
    await act(async () => {
      returned = await result.current.archiveSession('session-1' as Session['session_id']);
    });

    expect(returned).toBe(archivedSession);
    expect(archiveCreate).toHaveBeenCalledWith({});
    expect(sessionsPatch).not.toHaveBeenCalled();
  });

  it('unarchives through the cascade unarchive route instead of generic sessions.patch', async () => {
    const unarchivedSession = { session_id: 'session-1', archived: false } as Session;
    const unarchiveCreate = vi.fn(async () => ({ session: unarchivedSession }));
    const sessionsPatch = vi.fn();
    const client = makeClient({
      'sessions/session-1/unarchive': { create: unarchiveCreate },
      sessions: { patch: sessionsPatch },
    });

    const { result } = renderHook(() => useSessionActions(client));
    let returned: Session | null = null;
    await act(async () => {
      returned = await result.current.unarchiveSession('session-1' as Session['session_id']);
    });

    expect(returned).toBe(unarchivedSession);
    expect(unarchiveCreate).toHaveBeenCalledWith({});
    expect(sessionsPatch).not.toHaveBeenCalled();
  });
});

it('preserves the session create failure for its caller', async () => {
  const failure = new Error('Select an exact provider and model');
  const client = makeClient({
    sessions: { create: vi.fn(async () => Promise.reject(failure)) },
  });
  const { result } = renderHook(() => useSessionActions(client));

  await act(async () => {
    await expect(
      result.current.createSession({ agent_id: 'agent-1', agent: 'opencode' })
    ).rejects.toBe(failure);
  });
  expect(result.current.error).toBe(failure.message);
});

it('creates an Agent conversation with agent_id and no legacy branch binding', async () => {
  const created = { session_id: 'session-agent', agent_id: 'agent-1' } as Session;
  const create = vi.fn(async () => created);
  const client = makeClient({ sessions: { create } });
  const { result } = renderHook(() => useSessionActions(client));

  await act(async () => {
    await expect(
      result.current.createSession({ agent_id: 'agent-1', agent: 'codex' })
    ).resolves.toBe(created);
  });

  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ agent_id: 'agent-1', agentic_tool: 'codex' })
  );
  expect(create.mock.calls[0]?.[0]).not.toHaveProperty('branch_id');
});
