import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRepository,
  createUser,
  createDatabase,
  initializeDatabase,
  SkillLifecycleRepository,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';
import { createDefaultDiscoAgentProfile } from '@disco/core';
import { prepareDiscoAgentRuntimeContext } from '@disco/core/agent-runtime';
import type { Agent, UserID } from '@disco/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adoptExistingAgentSkill,
  installManagedDiscoSkill,
  patchManagedDiscoSkill,
} from './skill-lifecycle.js';
import { AgentCapabilitiesService } from './agent-capabilities.js';
import { CodexSkillsService, clearCodexSkillCatalogCache } from './codex-skills.js';

const createdRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdRoots.splice(0).map(async (root) => {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        // The libSQL Windows test handle can outlive the assertion briefly.
      }
    })
  );
});

async function testContext() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'disco-skill-lifecycle-'));
  createdRoots.push(root);
  const agentWorkspace = path.join(root, 'worktrees', 'user-1', 'agent-a');
  const dataHome = path.join(root, 'data');
  await mkdir(path.join(agentWorkspace, '.disco'), { recursive: true });
  await writeFile(
    path.join(agentWorkspace, '.disco', 'agent.json'),
    `${JSON.stringify(
      createDefaultDiscoAgentProfile({
        displayName: 'Test agent',
        responsibilities: 'Exercise managed skills.',
        now: '2026-08-27T00:00:00.000Z',
      }),
      null,
      2
    )}\n`,
    'utf8'
  );
  const db = createDatabase({ url: `file:${path.join(root, 'test.db')}` });
  await initializeDatabase(db);
  const actor = await createUser(db, {
    username: `owner-${path.basename(root).toLowerCase()}`,
    password: 'test-password',
    name: 'Owner',
  });
  const agent = {
    agent_id: 'agent-a',
    workspace_path: agentWorkspace,
    created_by: actor.user_id,
    display_name: 'Test agent',
    description: 'Exercise managed skills.',
    emoji: null,
    avatar_url: null,
    state: 'ready',
    error_message: null,
    archived: false,
    created_at: '2026-08-27T00:00:00.000Z',
    updated_at: '2026-08-27T00:00:00.000Z',
  } as unknown as Agent;
  vi.spyOn(AgentRepository.prototype, 'findOwnedById').mockImplementation(async (id, owner) =>
    id === agent.agent_id && owner === agent.created_by ? agent : null
  );
  return {
    root,
    dataHome,
    agentWorkspace,
    agent,
    db: db as unknown as TenantScopeAwareDatabase,
    actorUserId: actor.user_id as UserID,
  };
}

describe('managed Disco skill lifecycle', () => {
  it('adopts an existing agent skill without rewriting it and keeps it manageable', async () => {
    const context = await testContext();
    const skillDirectory = path.join(context.agentWorkspace, 'skills', 'legacy-helper');
    await mkdir(path.join(skillDirectory, 'scripts'), { recursive: true });
    const original =
      '---\nname: legacy-helper\ndescription: Existing agent skill\n---\n\n# Legacy\n';
    await Promise.all([
      writeFile(path.join(skillDirectory, 'SKILL.md'), original, 'utf8'),
      writeFile(path.join(skillDirectory, 'scripts', 'check.ps1'), 'Write-Output legacy\n', 'utf8'),
    ]);

    const adopted = await adoptExistingAgentSkill({
      db: context.db,
      actorUserId: context.actorUserId,
      agent: context.agent,
      relativePath: 'skills/legacy-helper/SKILL.md',
      name: 'legacy-helper',
      description: 'Existing agent skill',
      enabled: true,
    });
    expect(adopted).toMatchObject({
      scope: 'agent',
      source: 'agent-generated',
      status: 'enabled',
      version: 1,
    });
    expect(readFileSync(path.join(skillDirectory, 'SKILL.md'), 'utf8')).toBe(original);
    expect((await new SkillLifecycleRepository(context.db).findAudit(adopted.id))[0]).toMatchObject(
      {
        action: 'install',
        details: expect.objectContaining({ imported_existing: true }),
      }
    );

    const adoptedAgain = await adoptExistingAgentSkill({
      db: context.db,
      actorUserId: context.actorUserId,
      agent: context.agent,
      relativePath: 'skills/legacy-helper/SKILL.md',
      name: 'legacy-helper',
      description: 'Existing agent skill',
      enabled: true,
    });
    expect(adoptedAgain).toEqual(adopted);
    expect(await new SkillLifecycleRepository(context.db).findAudit(adopted.id)).toHaveLength(1);
  });

  it('records agent ownership, versions, fingerprints, enable state and retained uninstall audit', async () => {
    const context = await testContext();
    const sessionWorkspace = path.join(context.agentWorkspace, 'sessions', 'session-runtime');
    await mkdir(sessionWorkspace, { recursive: true });
    const beforeInstall = prepareDiscoAgentRuntimeContext({
      agentWorkspace: context.agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T01:00:00.000Z',
    });
    expect(beforeInstall.skill_files).toBe(0);

    const installed = await installManagedDiscoSkill({
      db: context.db,
      actorUserId: context.actorUserId,
      defaultScope: 'agent',
      defaultAgentId: context.agent.agent_id,
      sourceSessionId: 'session-source',
      env: { DISCO_DATA_HOME: context.dataHome },
      input: {
        name: 'Evidence Helper',
        skill_markdown:
          '---\nname: evidence-helper\ndescription: Verify evidence first\n---\n\n# Evidence\n',
        files: [{ relative_path: 'scripts/check.ps1', content: 'Write-Output ok\n' }],
      },
    });

    const skillDirectory = path.join(context.agentWorkspace, 'skills', 'evidence-helper');
    expect(installed).toMatchObject({
      scope: 'agent',
      owner_user_id: context.actorUserId,
      agent_id: context.agent.agent_id,
      source_session_id: 'session-source',
      status: 'enabled',
      version: 1,
    });
    expect(installed.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(path.join(skillDirectory, 'SKILL.md'), 'utf8')).toContain(
      'Verify evidence first'
    );
    expect(readFileSync(path.join(skillDirectory, 'scripts', 'check.ps1'), 'utf8')).toContain(
      'Write-Output ok'
    );
    const afterInstall = prepareDiscoAgentRuntimeContext({
      agentWorkspace: context.agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T01:01:00.000Z',
    });
    expect(afterInstall.fingerprint).not.toBe(beforeInstall.fingerprint);
    expect(afterInstall.skill_files).toBe(1);
    expect(afterInstall.content).toContain('Verify evidence first');

    const disabled = await patchManagedDiscoSkill({
      db: context.db,
      actorUserId: context.actorUserId,
      skillId: installed.id,
      patch: { enabled: false },
      env: { DISCO_DATA_HOME: context.dataHome },
    });
    expect(disabled).toMatchObject({ status: 'disabled', version: 2 });
    expect(
      JSON.parse(
        readFileSync(path.join(context.agentWorkspace, '.disco', 'capabilities.json'), 'utf8')
      ).enabled
    ).toMatchObject({ 'skill:skills/evidence-helper/skill.md': false });
    const afterDisable = prepareDiscoAgentRuntimeContext({
      agentWorkspace: context.agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T01:02:00.000Z',
    });
    expect(afterDisable.fingerprint).not.toBe(afterInstall.fingerprint);
    expect(afterDisable.skill_files).toBe(0);
    expect(afterDisable.content).not.toContain('Verify evidence first');

    const edited = await patchManagedDiscoSkill({
      db: context.db,
      actorUserId: context.actorUserId,
      skillId: installed.id,
      patch: {
        enabled: true,
        skill_markdown:
          '---\nname: evidence-helper\ndescription: Verify twice\n---\n\n# Evidence v2\n',
      },
      env: { DISCO_DATA_HOME: context.dataHome },
    });
    expect(edited).toMatchObject({ status: 'enabled', version: 3 });
    expect(edited.fingerprint).not.toBe(installed.fingerprint);
    const afterEdit = prepareDiscoAgentRuntimeContext({
      agentWorkspace: context.agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T01:03:00.000Z',
    });
    expect(afterEdit.fingerprint).not.toBe(afterDisable.fingerprint);
    expect(afterEdit.skill_files).toBe(1);
    expect(afterEdit.content).toContain('Verify twice');
    expect(afterEdit.content).not.toContain('Verify evidence first');

    const other = await createUser(context.db, {
      username: `other-${path.basename(context.root).toLowerCase()}`,
      password: 'test-password',
      name: 'Other',
    });
    await expect(
      patchManagedDiscoSkill({
        db: context.db,
        actorUserId: other.user_id as UserID,
        skillId: installed.id,
        patch: { enabled: false },
        env: { DISCO_DATA_HOME: context.dataHome },
      })
    ).rejects.toThrow(/not found/i);
    await expect(
      patchManagedDiscoSkill({
        db: context.db,
        actorUserId: context.actorUserId,
        skillId: installed.id,
        patch: { action: 'uninstall', confirmation: 'wrong' },
        env: { DISCO_DATA_HOME: context.dataHome },
      })
    ).rejects.toThrow(/type the skill name exactly/i);

    const uninstalled = await patchManagedDiscoSkill({
      db: context.db,
      actorUserId: context.actorUserId,
      skillId: installed.id,
      patch: { action: 'uninstall', confirmation: installed.name },
      env: { DISCO_DATA_HOME: context.dataHome },
    });
    expect(uninstalled).toMatchObject({ status: 'uninstalled', version: 4 });
    expect(existsSync(skillDirectory)).toBe(false);
    const afterUninstall = prepareDiscoAgentRuntimeContext({
      agentWorkspace: context.agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T01:04:00.000Z',
    });
    expect(afterUninstall.fingerprint).not.toBe(afterEdit.fingerprint);
    expect(afterUninstall.skill_files).toBe(0);
    expect(afterUninstall.content).not.toContain('Verify twice');

    const repository = new SkillLifecycleRepository(context.db);
    expect(await repository.findRecord(installed.id)).toMatchObject({
      status: 'uninstalled',
      fingerprint: edited.fingerprint,
    });
    expect((await repository.findAudit(installed.id)).map((entry) => entry.action).sort()).toEqual(
      ['disable', 'enable', 'install', 'uninstall', 'update'].sort()
    );
  });

  it('installs standalone skills into Disco shared storage and rejects escaping support files', async () => {
    const context = await testContext();
    const other = await createUser(context.db, {
      username: `other-${path.basename(context.root).toLowerCase()}`,
      password: 'test-password',
      name: 'Other user',
    });
    const shared = await installManagedDiscoSkill({
      db: context.db,
      actorUserId: context.actorUserId,
      defaultScope: 'shared',
      env: { DISCO_DATA_HOME: context.dataHome },
      input: {
        name: 'Family Notes',
        skill_markdown:
          '---\nname: family-notes\ndescription: Shared household notes\n---\n\n# Notes\n',
      },
    });
    expect(shared).toMatchObject({
      scope: 'shared',
      agent_id: null,
      status: 'enabled',
      version: 1,
    });
    expect(
      readFileSync(path.join(context.dataHome, 'skills', 'family-notes', 'SKILL.md'), 'utf8')
    ).toContain('Shared household notes');

    await expect(
      patchManagedDiscoSkill({
        db: context.db,
        actorUserId: other.user_id as UserID,
        skillId: shared.id,
        patch: { enabled: false },
        env: { DISCO_DATA_HOME: context.dataHome },
      })
    ).rejects.toThrow(/not found/i);
    await expect(
      patchManagedDiscoSkill({
        db: context.db,
        actorUserId: other.user_id as UserID,
        skillId: shared.id,
        patch: { enabled: false },
        allowSharedAdminOverride: true,
        env: { DISCO_DATA_HOME: context.dataHome },
      })
    ).resolves.toMatchObject({ status: 'disabled' });

    await expect(
      installManagedDiscoSkill({
        db: context.db,
        actorUserId: context.actorUserId,
        defaultScope: 'shared',
        env: { DISCO_DATA_HOME: context.dataHome },
        input: {
          name: 'Unsafe',
          skill_markdown: '# Unsafe\n',
          files: [{ relative_path: '../escape.txt', content: 'no' }],
        },
      })
    ).rejects.toThrow(/invalid skill file path/i);
    expect(existsSync(path.join(context.dataHome, 'escape.txt'))).toBe(false);
  });

  it('keeps shared and Agent skill management data sources isolated across their full lifecycle', async () => {
    const context = await testContext();
    const previousDataHome = process.env.DISCO_DATA_HOME;
    process.env.DISCO_DATA_HOME = context.dataHome;
    clearCodexSkillCatalogCache();
    const sharedService = new CodexSkillsService(context.db);
    const agentService = new AgentCapabilitiesService(context.db);
    const user = { user_id: context.actorUserId, role: 'member' };
    const agentParams = {
      user,
      query: { agent_id: context.agent.agent_id },
    } as never;
    const sharedParams = { user } as never;

    try {
      const agentSkill = await agentService.create(
        {
          name: 'Agent Only Helper',
          skill_markdown:
            '---\nname: agent-only-helper\ndescription: Agent private helper\n---\n\n# Agent only\n',
        },
        agentParams
      );
      expect(agentSkill.lifecycle).toMatchObject({
        scope: 'agent',
        agent_id: context.agent.agent_id,
        status: 'enabled',
      });
      expect(
        (await agentService.find(agentParams)).map((entry) => entry.lifecycle?.id).filter(Boolean)
      ).toContain(agentSkill.lifecycle!.id);
      expect((await sharedService.find()).map((entry) => entry.id)).not.toContain(
        agentSkill.lifecycle!.id
      );
      await expect(
        sharedService.patch(agentSkill.lifecycle!.id, { enabled: false }, sharedParams)
      ).rejects.toThrow(/not found/i);

      const disabled = await agentService.patch(agentSkill.id, { enabled: false }, agentParams);
      expect(disabled).toMatchObject({ enabled: false });
      expect(
        existsSync(path.join(context.agentWorkspace, 'skills', 'agent-only-helper', 'SKILL.md'))
      ).toBe(true);
      await expect(
        agentService.patch(
          agentSkill.id,
          { action: 'uninstall', confirmation: 'wrong' },
          agentParams
        )
      ).rejects.toThrow(/type the skill name exactly/i);
      await agentService.patch(
        agentSkill.id,
        { action: 'uninstall', confirmation: 'Agent Only Helper' },
        agentParams
      );
      expect(existsSync(path.join(context.agentWorkspace, 'skills', 'agent-only-helper'))).toBe(
        false
      );
      expect(
        (await agentService.find(agentParams)).map((entry) => entry.lifecycle?.id).filter(Boolean)
      ).not.toContain(agentSkill.lifecycle!.id);
      expect(
        (await new SkillLifecycleRepository(context.db).findAudit(agentSkill.lifecycle!.id)).map(
          (entry) => entry.action
        )
      ).toEqual(expect.arrayContaining(['install', 'disable', 'uninstall']));

      const sharedSkill = await sharedService.create(
        {
          name: 'Household Shared Helper',
          skill_markdown:
            '---\nname: household-shared-helper\ndescription: Shared household helper\n---\n\n# Shared\n',
        },
        sharedParams
      );
      expect(sharedSkill.lifecycle).toMatchObject({ scope: 'shared', agent_id: null });
      expect((await sharedService.find()).map((entry) => entry.id)).toContain(sharedSkill.id);
      expect(
        (await agentService.find(agentParams)).map((entry) => entry.lifecycle?.id).filter(Boolean)
      ).not.toContain(sharedSkill.id);
      await expect(
        agentService.patch(sharedSkill.id, { enabled: false }, agentParams)
      ).rejects.toThrow(/not found/i);
    } finally {
      clearCodexSkillCatalogCache();
      if (previousDataHome === undefined) delete process.env.DISCO_DATA_HOME;
      else process.env.DISCO_DATA_HOME = previousDataHome;
    }
  });
});
