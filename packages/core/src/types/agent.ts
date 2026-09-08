import type { AgentID, UserID } from './id';

export type AgentState = 'creating' | 'ready' | 'failed';

/**
 * A persistent Disco identity. Sessions point here directly instead of using
 * a Git Branch row as a surrogate Agent record.
 */
export interface Agent {
  agent_id: AgentID;
  created_by: UserID;
  display_name: string;
  description: string | null;
  emoji: string | null;
  avatar_url: string | null;
  workspace_path: string;
  state: AgentState;
  error_message: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentInput {
  display_name: string;
  description?: string | null;
  emoji?: string | null;
  avatar_url?: string | null;
}

export interface PatchAgentInput {
  display_name?: string;
  description?: string | null;
  emoji?: string | null;
  avatar_url?: string | null;
  archived?: boolean;
}
