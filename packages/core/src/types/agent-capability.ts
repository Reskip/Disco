import type { AgentID } from './id';
import type { DiscoSkillLifecycleRecord } from './codex-skill';

export type AgentCapabilityKind = 'profile' | 'memory' | 'skill';

export interface AgentCapabilityEntry {
  id: string;
  agent_id: AgentID;
  kind: AgentCapabilityKind;
  name: string;
  description: string;
  relative_path: string;
  content: string;
  enabled: boolean;
  editable: boolean;
  removable: boolean;
  updated_at: string;
  lifecycle?: DiscoSkillLifecycleRecord;
}

export interface AgentCapabilityPatch {
  enabled?: boolean;
  content?: string;
  action?: 'uninstall';
  confirmation?: string;
}

export interface AgentMemoryUpsertInput {
  kind: 'memory';
  topic: string;
  content: string;
  operation?: 'append' | 'replace';
  source?: 'user-explicit' | 'agent-inference';
  confidence?: number;
  source_session_id?: string | null;
}
