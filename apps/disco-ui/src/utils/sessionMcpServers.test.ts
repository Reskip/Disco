import type { DiscoClient } from '@disco-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoStore } from '../store/discoStore';
import { sessionMcpCreated } from '../store/sessionMcpActions';
import { updateSessionMcpServers } from './sessionMcpServers';

describe('updateSessionMcpServers', () => {
  beforeEach(() => discoStore.getState().resetMaps());

  it('updates the relationship store from successful REST responses without waiting for websocket events', async () => {
    discoStore.getState().setMap('sessionMcpServerIds', new Map([['session-1', ['remove-me']]]));
    const create = vi.fn().mockResolvedValue({});
    const remove = vi.fn().mockResolvedValue({});
    const client = { service: () => ({ create, remove }) } as unknown as DiscoClient;

    await updateSessionMcpServers(client, 'session-1', ['remove-me'], ['add-me']);

    expect(create).toHaveBeenCalledWith({ mcpServerId: 'add-me' });
    expect(remove).toHaveBeenCalledWith('remove-me');
    expect(discoStore.getState().sessionMcpServerIds.get('session-1')).toEqual(['add-me']);
  });

  it('remains idempotent when the websocket event arrived before the REST response', async () => {
    const create = vi.fn().mockImplementation(async () => {
      sessionMcpCreated({ session_id: 'session-1', mcp_server_id: 'add-me' });
    });
    const client = {
      service: () => ({ create, remove: vi.fn() }),
    } as unknown as DiscoClient;

    await updateSessionMcpServers(client, 'session-1', [], ['add-me']);

    expect(discoStore.getState().sessionMcpServerIds.get('session-1')).toEqual(['add-me']);
  });
});
