import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CodexSkillSettingsRepository,
  SkillLifecycleRepository,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexSkillsService,
  clearCodexSkillCatalogCache,
  discoverCodexSkills,
  resolveCodexSkillRuntimeEntries,
} from './codex-skills.js';

afterEach(() => {
  clearCodexSkillCatalogCache();
  vi.restoreAllMocks();
});

async function writeSkill(skillPath: string, name: string, description: string) {
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`,
    'utf8'
  );
}

describe('Codex skills catalog', () => {
  it('inherits Codex official SYSTEM and installed official plugin skills, but not personal skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disco-skills-'));
    const codexHome = path.join(root, 'codex');
    const dataHome = path.join(root, 'data');
    await writeSkill(
      path.join(codexHome, 'skills', '.system', 'documents', 'SKILL.md'),
      'documents',
      'Create documents'
    );
    await writeSkill(
      path.join(codexHome, 'skills', 'personal-summary', 'SKILL.md'),
      'personal-summary',
      'A desktop personal skill'
    );
    await writeSkill(
      path.join(
        codexHome,
        'plugins',
        'cache',
        'openai-bundled',
        'browser',
        '99.0',
        'skills',
        'control-in-app-browser',
        'SKILL.md'
      ),
      'control-in-app-browser',
      'Control the desktop browser'
    );
    await mkdir(
      path.join(
        codexHome,
        'plugins',
        'cache',
        'openai-bundled',
        'browser',
        '99.0',
        '.codex-plugin'
      ),
      { recursive: true }
    );
    await writeFile(
      path.join(
        codexHome,
        'plugins',
        'cache',
        'openai-bundled',
        'browser',
        '99.0',
        '.codex-plugin',
        'plugin.json'
      ),
      '{}',
      'utf8'
    );
    await writeSkill(
      path.join(dataHome, 'skills', 'family-helper', 'SKILL.md'),
      'family-helper',
      'A local Disco skill'
    );

    try {
      const catalog = discoverCodexSkills(
        {
          DISCO_HOST_CODEX_HOME: codexHome,
          CODEX_HOME: codexHome,
          DISCO_DATA_HOME: dataHome,
        },
        1
      );
      expect(catalog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'documents', source: 'codex-sync', available: true }),
          expect.objectContaining({
            name: 'control-in-app-browser',
            source: 'codex-sync',
            source_detail: 'Codex 官方插件 · browser',
          }),
          expect.objectContaining({
            name: 'family-helper',
            source: 'disco-local',
            available: true,
          }),
        ])
      );
      expect(catalog.map((entry) => entry.name)).not.toContain('personal-summary');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers the isolated Runtime Home for duplicate official SYSTEM skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disco-runtime-skills-'));
    const runtimeHome = path.join(root, 'codex-runtime');
    const hostHome = path.join(root, 'host-codex');
    const dataHome = path.join(root, 'disco');
    const runtimeSkill = path.join(runtimeHome, 'skills', '.system', 'openai-docs', 'SKILL.md');
    const hostSkill = path.join(hostHome, 'skills', '.system', 'openai-docs', 'SKILL.md');
    await writeSkill(runtimeSkill, 'openai-docs', 'Runtime official docs');
    await writeSkill(hostSkill, 'openai-docs', 'Desktop official docs');

    try {
      const catalog = discoverCodexSkills(
        {
          DISCO_CODEX_RUNTIME_HOME: runtimeHome,
          DISCO_HOST_CODEX_HOME: hostHome,
          CODEX_HOME: hostHome,
          DISCO_DATA_HOME: dataHome,
        },
        1
      );
      const matching = catalog.filter((entry) => entry.name === 'openai-docs');
      expect(matching).toHaveLength(1);
      expect(matching[0]?.skillPath).toBe(path.resolve(runtimeSkill));
      expect(matching[0]?.description).toBe('Runtime official docs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns no host path publicly and persists an admin toggle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disco-skill-service-'));
    const codexHome = path.join(root, 'codex');
    await writeSkill(
      path.join(codexHome, 'skills', '.system', 'documents', 'SKILL.md'),
      'documents',
      'Create documents'
    );
    const previousHostHome = process.env.DISCO_HOST_CODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.DISCO_HOST_CODEX_HOME = codexHome;
    process.env.CODEX_HOME = codexHome;
    clearCodexSkillCatalogCache();
    vi.spyOn(CodexSkillSettingsRepository.prototype, 'find').mockResolvedValue({});
    vi.spyOn(SkillLifecycleRepository.prototype, 'findRecords').mockResolvedValue([]);
    vi.spyOn(SkillLifecycleRepository.prototype, 'findRecord').mockResolvedValue(undefined);
    const patch = vi.spyOn(CodexSkillSettingsRepository.prototype, 'patch').mockResolvedValue({});
    const service = new CodexSkillsService({} as TenantScopeAwareDatabase);

    try {
      const entries = await service.find();
      const documents = entries.find((entry) => entry.name === 'documents');
      expect(documents).toBeDefined();
      expect(documents).not.toHaveProperty('skillPath');
      await expect(
        service.patch(documents!.id, { enabled: false }, {
          user: { user_id: 'member-1', role: 'member' },
        } as never)
      ).rejects.toThrow(/only administrators/i);
      await expect(
        service.patch(documents!.id, { enabled: false }, {
          user: { user_id: 'admin-1', role: 'admin' },
        } as never)
      ).resolves.toMatchObject({ id: documents!.id, enabled: false });
      expect(patch).toHaveBeenCalledWith(documents!.id, false, 'admin-1');
    } finally {
      if (previousHostHome === undefined) delete process.env.DISCO_HOST_CODEX_HOME;
      else process.env.DISCO_HOST_CODEX_HOME = previousHostHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adds enabled skills from the current agent workspace only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disco-agent-runtime-skills-'));
    const skillPath = path.join(root, 'skills', 'self-review', 'SKILL.md');
    const nestedSession = path.join(root, 'sessions', 'session-1');
    await writeSkill(skillPath, 'self-review', 'Review the agent memory');
    await mkdir(path.join(root, '.disco'), { recursive: true });
    await writeFile(path.join(root, '.disco', 'agent.json'), '{}', 'utf8');
    await mkdir(nestedSession, { recursive: true });
    vi.spyOn(CodexSkillSettingsRepository.prototype, 'find').mockResolvedValue({});
    vi.spyOn(SkillLifecycleRepository.prototype, 'findRecords').mockResolvedValue([]);
    try {
      const enabled = await resolveCodexSkillRuntimeEntries({} as TenantScopeAwareDatabase, {
        workspacePath: nestedSession,
      });
      expect(enabled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: path.resolve(skillPath), enabled: true }),
        ])
      );

      await writeFile(
        path.join(root, '.disco', 'capabilities.json'),
        JSON.stringify({
          version: 1,
          enabled: { 'skill:skills/self-review/skill.md': false },
        }),
        'utf8'
      );
      const disabled = await resolveCodexSkillRuntimeEntries({} as TenantScopeAwareDatabase, {
        workspacePath: nestedSession,
      });
      expect(disabled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: path.resolve(skillPath), enabled: false }),
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
