import type { UserID } from '@disco/core/types';
import type { Database } from '../client';
import { AppVariableRepository } from './app-variables';

export const CODEX_SKILL_SETTINGS_NAMESPACE = 'codex-skills';
export const CODEX_SKILL_SETTINGS_KEY = 'enabled-overrides';

export type CodexSkillEnabledOverrides = Record<string, boolean>;

function parseOverrides(raw: string | null): CodexSkillEnabledOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] =>
          entry[0].startsWith('skill_') && typeof entry[1] === 'boolean'
      )
    );
  } catch {
    // Corrupt settings must fail closed to the catalog defaults instead of
    // making every Codex prompt unavailable.
    return {};
  }
}

export class CodexSkillSettingsRepository {
  private variables: AppVariableRepository;

  constructor(private db: Database) {
    this.variables = new AppVariableRepository(db);
  }

  async find(): Promise<CodexSkillEnabledOverrides> {
    return parseOverrides(
      await this.variables.getPlain(CODEX_SKILL_SETTINGS_NAMESPACE, CODEX_SKILL_SETTINGS_KEY)
    );
  }

  async set(
    overrides: CodexSkillEnabledOverrides,
    updatedBy?: UserID | null
  ): Promise<CodexSkillEnabledOverrides> {
    const normalized = Object.fromEntries(
      Object.entries(overrides).filter(
        (entry): entry is [string, boolean] =>
          entry[0].startsWith('skill_') && typeof entry[1] === 'boolean'
      )
    );
    await this.variables.set({
      namespace: CODEX_SKILL_SETTINGS_NAMESPACE,
      key: CODEX_SKILL_SETTINGS_KEY,
      value: JSON.stringify(normalized),
      content_type: 'application/json',
      updated_by: updatedBy ?? null,
    });
    return normalized;
  }

  async patch(
    skillId: string,
    enabled: boolean,
    updatedBy?: UserID | null
  ): Promise<CodexSkillEnabledOverrides> {
    const current = await this.find();
    return this.set({ ...current, [skillId]: enabled }, updatedBy);
  }
}
