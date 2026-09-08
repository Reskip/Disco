import type { MCPServer, Session, User } from '@disco-live/client';
import { replaceIfChanged } from './discoMaps';
import { type DiscoState, discoStore } from './discoStore';

const setMap: DiscoState['setMap'] = (key, value) => discoStore.getState().setMap(key, value);

export function sessionCreated(session: Session): void {
  setMap('sessionById', (previous) => replaceIfChanged(previous, session.session_id, session));
}

export const sessionPatched = sessionCreated;

export function sessionRemoved(session: Session): void {
  setMap('sessionById', (previous) => {
    if (!previous.has(session.session_id)) return previous;
    const next = new Map(previous);
    next.delete(session.session_id);
    return next;
  });
  setMap('sessionMcpServerIds', (previous) => {
    if (!previous.has(session.session_id)) return previous;
    const next = new Map(previous);
    next.delete(session.session_id);
    return next;
  });
}

export function userCreated(user: User): void {
  setMap('userById', (previous) => replaceIfChanged(previous, user.user_id, user));
}

export const userPatched = userCreated;

export function userRemoved(user: User): void {
  setMap('userById', (previous) => {
    if (!previous.has(user.user_id)) return previous;
    const next = new Map(previous);
    next.delete(user.user_id);
    return next;
  });
}

export function mcpServerCreated(server: MCPServer): void {
  setMap('mcpServerById', (previous) =>
    replaceIfChanged(previous, server.mcp_server_id, server)
  );
}

export const mcpServerPatched = mcpServerCreated;

export function mcpServerRemoved(server: MCPServer): void {
  setMap('mcpServerById', (previous) => {
    if (!previous.has(server.mcp_server_id)) return previous;
    const next = new Map(previous);
    next.delete(server.mcp_server_id);
    return next;
  });
  setMap('userAuthenticatedMcpServerIds', (previous) => {
    if (!previous.has(server.mcp_server_id)) return previous;
    const next = new Set(previous);
    next.delete(server.mcp_server_id);
    return next;
  });
}

export { sessionMcpCreated, sessionMcpRemoved } from './sessionMcpActions';
