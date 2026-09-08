import type { MCPOAuthAttemptID, MCPServerID } from '@disco/core/types';

/** One authoritative naming scheme for Socket.IO rooms and Feathers channels. */
export function tenantChannelName(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function tenantUserChannelName(tenantId: string, userId: string): string {
  return `tenant:${tenantId}:user:${userId}`;
}

interface HaNativeSocketPayloads {
  'oauth:completed': {
    attempt_id: MCPOAuthAttemptID;
    success: boolean;
    mcp_server_id?: string;
    oauth_mode: 'per_user' | 'shared';
  };
  'oauth:disconnected': { mcp_server_id: MCPServerID };
}

/** Native Socket.IO packets intentionally permitted to cross the HA Redis adapter. */
export const HA_NATIVE_SOCKET_EVENT_INVENTORY = [
  'oauth:completed',
  'oauth:disconnected',
] as const satisfies readonly (keyof HaNativeSocketPayloads)[];

type NativeSocketTarget = {
  emit(event: string, payload: unknown): unknown;
};

/**
 * Audited boundary for native cross-replica packets. Other room-targeted
 * Socket.IO emissions must opt into `.local` so a missed feature gate cannot
 * silently put a new payload onto Redis.
 */
export function emitHaNativeSocketEvent<Event extends keyof HaNativeSocketPayloads>(
  target: NativeSocketTarget,
  event: Event,
  payload: HaNativeSocketPayloads[Event]
): void {
  target.emit(event, payload);
}
