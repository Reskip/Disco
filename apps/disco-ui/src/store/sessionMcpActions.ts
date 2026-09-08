/**
 * Transport-neutral session ↔ MCP relationship store actions.
 *
 * REST mutation confirmations and websocket events both use these idempotent
 * actions.
 */
import { type DiscoState, discoStore } from './discoStore';

const setMap: DiscoState['setMap'] = (key, value) => discoStore.getState().setMap(key, value);

export function sessionMcpCreated(relationship: { session_id: string; mcp_server_id: string }) {
  setMap('sessionMcpServerIds', (prev) => {
    const sessionMcpIds = prev.get(relationship.session_id) || [];
    if (sessionMcpIds.includes(relationship.mcp_server_id)) return prev;

    const next = new Map(prev);
    next.set(relationship.session_id, [...sessionMcpIds, relationship.mcp_server_id]);
    return next;
  });
}

export function sessionMcpRemoved(relationship: { session_id: string; mcp_server_id: string }) {
  setMap('sessionMcpServerIds', (prev) => {
    const sessionMcpIds = prev.get(relationship.session_id) || [];
    const filtered = sessionMcpIds.filter((id) => id !== relationship.mcp_server_id);
    if (filtered.length === sessionMcpIds.length) return prev;

    const next = new Map(prev);
    if (filtered.length > 0) next.set(relationship.session_id, filtered);
    else next.delete(relationship.session_id);
    return next;
  });
}
