import { describe, expect, it, vi } from 'vitest';
import {
  emitHaNativeSocketEvent,
  HA_NATIVE_SOCKET_EVENT_INVENTORY,
  tenantChannelName,
  tenantUserChannelName,
} from './routing';

describe('realtime routing boundary', () => {
  it('centralizes tenant room and channel names', () => {
    expect(tenantChannelName('tenant-a')).toBe('tenant:tenant-a');
    expect(tenantUserChannelName('tenant-a', 'user-a')).toBe('tenant:tenant-a:user:user-a');
  });

  it('emits only through the explicit native HA event inventory', () => {
    expect(HA_NATIVE_SOCKET_EVENT_INVENTORY).toEqual(['oauth:completed', 'oauth:disconnected']);
    const target = { emit: vi.fn() };
    emitHaNativeSocketEvent(target, 'oauth:disconnected', {
      mcp_server_id: '019fe5bc-65cf-7095-b160-454363604446' as never,
    });
    expect(target.emit).toHaveBeenCalledWith('oauth:disconnected', {
      mcp_server_id: '019fe5bc-65cf-7095-b160-454363604446',
    });
  });
});
