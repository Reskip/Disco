export type CodexSkillSource = 'codex-sync' | 'disco-local' | 'agent-generated';

export type DiscoSkillScope = 'shared' | 'agent';
export type DiscoSkillStatus = 'enabled' | 'disabled' | 'uninstalled';
export type DiscoSkillOrigin = 'disco-shared' | 'agent-installed' | 'agent-generated';
export type DiscoSkillAuditAction =
  | 'install'
  | 'update'
  | 'enable'
  | 'disable'
  | 'uninstall';

export interface DiscoSkillLifecycleRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  scope: DiscoSkillScope;
  owner_user_id: string;
  agent_id: string | null;
  source: DiscoSkillOrigin;
  source_session_id: string | null;
  relative_path: string;
  status: DiscoSkillStatus;
  version: number;
  fingerprint: string;
  installed_at: string;
  updated_at: string;
  uninstalled_at: string | null;
}

export interface DiscoSkillAuditRecord {
  audit_id: string;
  skill_id: string;
  action: DiscoSkillAuditAction;
  scope: DiscoSkillScope;
  owner_user_id: string;
  agent_id: string | null;
  actor_user_id: string;
  source_session_id: string | null;
  occurred_at: string;
  details: Record<string, unknown>;
}

export interface DiscoSkillSupportingFile {
  relative_path: string;
  content: string;
}

export interface DiscoSkillInstallInput {
  name: string;
  skill_markdown: string;
  description?: string;
  scope?: DiscoSkillScope;
  agent_id?: string;
  source?: DiscoSkillOrigin;
  source_session_id?: string;
  files?: DiscoSkillSupportingFile[];
}

export interface DiscoSkillLifecyclePatch {
  enabled?: boolean;
  skill_markdown?: string;
  description?: string;
  action?: 'uninstall';
  confirmation?: string;
}

/** A skill visible in Disco's shared Codex runtime. */
export interface CodexSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: CodexSkillSource;
  source_detail: string;
  enabled: boolean;
  available: boolean;
  unavailable_reason?: string;
  lifecycle?: DiscoSkillLifecycleRecord;
}

export interface CodexSkillSettingsPatch {
  enabled?: boolean;
  skill_markdown?: string;
  description?: string;
  action?: 'uninstall';
  confirmation?: string;
}

/** Trusted daemon-to-executor representation; never returned by the public API. */
export interface CodexSkillRuntimeEntry {
  path: string;
  enabled: boolean;
}
