import type {
  DiscoSkillAuditAction,
  DiscoSkillAuditRecord,
  DiscoSkillLifecycleRecord,
  UserID,
} from '@disco/core/types';
import { randomUUID } from 'node:crypto';
import type { Database } from '../client';
import { AppVariableRepository } from './app-variables';

export const DISCO_SKILL_LIFECYCLE_NAMESPACE = 'disco-skill-lifecycle';

const RECORD_PREFIX = 'record:';
const AUDIT_PREFIX = 'audit:';

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export class SkillLifecycleRepository {
  private variables: AppVariableRepository;

  constructor(private db: Database) {
    this.variables = new AppVariableRepository(db);
  }

  async findRecords(): Promise<DiscoSkillLifecycleRecord[]> {
    return (await this.variables.findByNamespace(DISCO_SKILL_LIFECYCLE_NAMESPACE))
      .filter(variable => variable.key.startsWith(RECORD_PREFIX))
      .map(variable => parseJson<DiscoSkillLifecycleRecord>(variable.value_text ?? null))
      .filter((entry): entry is DiscoSkillLifecycleRecord => Boolean(entry))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  async findRecord(id: string): Promise<DiscoSkillLifecycleRecord | null> {
    return parseJson<DiscoSkillLifecycleRecord>(
      await this.variables.getPlain(DISCO_SKILL_LIFECYCLE_NAMESPACE, `${RECORD_PREFIX}${id}`)
    );
  }

  async setRecord(
    record: DiscoSkillLifecycleRecord,
    updatedBy?: UserID | null
  ): Promise<DiscoSkillLifecycleRecord> {
    await this.variables.set({
      namespace: DISCO_SKILL_LIFECYCLE_NAMESPACE,
      key: `${RECORD_PREFIX}${record.id}`,
      value: JSON.stringify(record),
      content_type: 'application/json',
      updated_by: updatedBy ?? null,
      metadata: {
        kind: 'skill-record',
        scope: record.scope,
        owner_user_id: record.owner_user_id,
        agent_id: record.agent_id,
        status: record.status,
      },
    });
    return record;
  }

  async appendAudit(input: {
    skill: DiscoSkillLifecycleRecord;
    action: DiscoSkillAuditAction;
    actorUserId: UserID;
    sourceSessionId?: string | null;
    details?: Record<string, unknown>;
    occurredAt?: string;
  }): Promise<DiscoSkillAuditRecord> {
    const audit: DiscoSkillAuditRecord = {
      audit_id: `skillaudit_${randomUUID()}`,
      skill_id: input.skill.id,
      action: input.action,
      scope: input.skill.scope,
      owner_user_id: input.skill.owner_user_id,
      agent_id: input.skill.agent_id,
      actor_user_id: input.actorUserId,
      source_session_id: input.sourceSessionId ?? input.skill.source_session_id ?? null,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      details: input.details ?? {},
    };
    await this.variables.set({
      namespace: DISCO_SKILL_LIFECYCLE_NAMESPACE,
      key: `${AUDIT_PREFIX}${audit.audit_id}`,
      value: JSON.stringify(audit),
      content_type: 'application/json',
      updated_by: input.actorUserId,
      metadata: {
        kind: 'skill-audit',
        skill_id: audit.skill_id,
        action: audit.action,
      },
    });
    return audit;
  }

  async findAudit(skillId?: string): Promise<DiscoSkillAuditRecord[]> {
    return (await this.variables.findByNamespace(DISCO_SKILL_LIFECYCLE_NAMESPACE))
      .filter(variable => variable.key.startsWith(AUDIT_PREFIX))
      .map(variable => parseJson<DiscoSkillAuditRecord>(variable.value_text ?? null))
      .filter(
        (entry): entry is DiscoSkillAuditRecord =>
          Boolean(entry) && (!skillId || entry?.skill_id === skillId)
      )
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  }
}
