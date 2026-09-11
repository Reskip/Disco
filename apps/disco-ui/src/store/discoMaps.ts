import type { MCPServer, Session, User } from '@disco-live/client';
import { shallowEqualEntity } from '../utils/shallowEqual';

/** Normalized state used by the conversation product. */
export interface DataMaps {
  sessionById: Map<string, Session>;
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  sessionMcpServerIds: Map<string, string[]>;
  userAuthenticatedMcpServerIds: Set<string>;
}

export const EMPTY_MAPS: DataMaps = {
  sessionById: new Map(),
  userById: new Map(),
  mcpServerById: new Map(),
  sessionMcpServerIds: new Map(),
  userAuthenticatedMcpServerIds: new Set(),
};

export const MAP_KEYS = Object.keys(EMPTY_MAPS) as (keyof DataMaps)[];

export function pickMaps(state: DataMaps): DataMaps {
  return {
    sessionById: state.sessionById,
    userById: state.userById,
    mcpServerById: state.mcpServerById,
    sessionMcpServerIds: state.sessionMcpServerIds,
    userAuthenticatedMcpServerIds: state.userAuthenticatedMcpServerIds,
  };
}

export function replaceIfChanged<T extends object>(
  previous: Map<string, T>,
  id: string,
  entity: T
): Map<string, T> {
  const existing = previous.get(id);
  if (existing && shallowEqualEntity(existing, entity)) return previous;
  const next = new Map(previous);
  next.set(id, entity);
  return next;
}

export function reconcileByIdMap<T extends object>(
  previous: Map<string, T> | undefined,
  next: Map<string, T>
): Map<string, T> {
  if (!previous || previous.size === 0) return next;
  let changed = previous.size !== next.size;
  for (const [id, value] of next) {
    const prior = previous.get(id);
    if (prior !== undefined && (prior === value || shallowEqualEntity(prior, value))) {
      next.set(id, prior);
    } else {
      changed = true;
    }
  }
  return changed ? next : previous;
}

export function buildById<T extends object>(
  list: readonly T[],
  key: keyof T,
  previous?: Map<string, T>
): Map<string, T> {
  const next = new Map<string, T>();
  for (const item of list) next.set(item[key] as unknown as string, item);
  return reconcileByIdMap(previous, next);
}

export function buildSessionMaps(
  sessions: readonly Session[],
  previous?: Pick<DataMaps, 'sessionById'>
): Pick<DataMaps, 'sessionById'> {
  return { sessionById: buildById(sessions, 'session_id', previous?.sessionById) };
}

/** Merge a server snapshot without undoing mutations observed after its request began. */
export function reconcileSessionSnapshot(
  sessions: readonly Session[],
  current: Map<string, Session>,
  atRequestStart: Map<string, Session>,
  replaceMissing = false
): Map<string, Session> {
  const next = replaceMissing ? new Map<string, Session>() : new Map(current);
  for (const session of sessions) next.set(session.session_id, session);
  for (const [id, session] of current) {
    if (session !== atRequestStart.get(id)) next.set(id, session);
  }
  for (const id of atRequestStart.keys()) {
    if (!current.has(id)) next.delete(id);
  }
  return reconcileByIdMap(current, next);
}

export function buildSessionMcpMap(
  relationships: readonly { session_id: string; mcp_server_id: string }[]
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const relationship of relationships) {
    const current = result.get(relationship.session_id) ?? [];
    if (!current.includes(relationship.mcp_server_id)) {
      result.set(relationship.session_id, [...current, relationship.mcp_server_id]);
    }
  }
  return result;
}
