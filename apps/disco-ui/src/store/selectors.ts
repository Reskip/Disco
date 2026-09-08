import type { Session } from '@disco-live/client';
import type { DiscoState } from './discoStore';

export const selectSessionById = (state: DiscoState) => state.sessionById;
export const selectUserById = (state: DiscoState) => state.userById;
export const selectMcpServerById = (state: DiscoState) => state.mcpServerById;
export const selectSessionMcpServerIds = (state: DiscoState) => state.sessionMcpServerIds;
export const selectUserAuthenticatedMcpServerIds = (state: DiscoState) =>
  state.userAuthenticatedMcpServerIds;

export function makeSessionSelector(
  sessionId: string | null | undefined
): (state: DiscoState) => Session | undefined {
  return (state) => (sessionId ? state.sessionById.get(sessionId) : undefined);
}

export function makeSessionExistsSelector(
  sessionId: string | null | undefined
): (state: DiscoState) => boolean {
  return (state) => Boolean(sessionId && state.sessionById.has(sessionId));
}

export function makeSessionMcpServerIdsSelector(
  sessionId: string | null | undefined
): (state: DiscoState) => string[] | undefined {
  return (state) => (sessionId ? state.sessionMcpServerIds.get(sessionId) : undefined);
}
