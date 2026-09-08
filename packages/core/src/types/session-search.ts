import type { AgentID, MessageID, SessionID } from './id';
import type { MessageRole } from './message';
import type { SessionStatus } from './session';

export const SESSION_SEARCH_SCOPES = ['all', 'standalone', 'agent', 'archived'] as const;

export type SessionSearchScope = (typeof SESSION_SEARCH_SCOPES)[number];

export const SESSION_SEARCH_KINDS = ['all', 'standalone', 'agent'] as const;

export type SessionSearchKind = (typeof SESSION_SEARCH_KINDS)[number];

export const SESSION_SEARCH_ORDERS = ['relevance', 'newest', 'oldest'] as const;

export type SessionSearchOrder = (typeof SESSION_SEARCH_ORDERS)[number];

export interface SessionSearchQuery {
  /** Empty queries are accepted only for the archived-session manager. */
  q?: string;
  scope?: SessionSearchScope;
  kind?: SessionSearchKind;
  updated_after?: string;
  updated_before?: string;
  order?: SessionSearchOrder;
  limit?: number;
  offset?: number;
}

export type SessionSearchMatchKind = 'title' | 'message' | 'attachment' | 'agent';

export interface SessionSearchMatch {
  session_id: SessionID;
  title: string;
  agent_id?: AgentID | null;
  agent_name?: string;
  archived: boolean;
  status: SessionStatus;
  ready_for_prompt: boolean;
  created_at: string;
  last_updated: string;
  match_kind: SessionSearchMatchKind;
  snippet: string;
  message_id?: MessageID;
  message_role?: MessageRole;
  match_count: number;
}

export interface SessionSearchResult {
  total: number;
  limit: number;
  offset: number;
  data: SessionSearchMatch[];
}
