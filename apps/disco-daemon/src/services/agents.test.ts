import { access, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRepository } from '@disco/core/db';
import type { AuthenticatedParams, Session, UserID } from '@disco/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { AGENTS_SERVICE_TRANSPORT_METHODS, AgentsService } from './agents';

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanup].map(directory => rm(directory, { recursive: true, force: true }).catch(() => {}))
  );
  cleanup.clear();
});

function params(userId: string): AuthenticatedParams {
  return {
    user: { user_id: userId, username: userId, role: 'member' },
  } as AuthenticatedParams;
}

describe('AgentsService', () => {
  it('exposes guarded Agent removal at the authenticated transport boundary', () => {
    expect(AGENTS_SERVICE_TRANSPORT_METHODS).toContain('remove');
  });

  dbTest('creates an owned Agent workspace and keeps another user blind to it', async ({ db }) => {
    const root = path.join(os.tmpdir(), `disco-agents-service-${Date.now()}-${Math.random()}`);
    cleanup.add(root);
    const service = new AgentsService(db, () => root);
    const owner = '00000000-0000-7000-8000-000000000001' as UserID;
    const other = '00000000-0000-7000-8000-000000000002' as UserID;

    const created = await service.create(
      {
        display_name: '家庭管家',
        description: '维护家庭设备',
        emoji: '🏠',
      },
      params(owner)
    );

    expect(created).toMatchObject({
      created_by: owner,
      display_name: '家庭管家',
      state: 'ready',
    });
    await expect(readFile(path.join(created.workspace_path, '.disco', 'agent.json'), 'utf8')).resolves
      .toContain('家庭管家');
    await expect(service.find(params(owner))).resolves.toHaveLength(1);
    await expect(service.find(params(other))).resolves.toHaveLength(0);
    await expect(service.get(created.agent_id, params(other))).rejects.toThrow('Agent not found');
  });

  dbTest('synchronizes edited Agent metadata into the canonical profile source', async ({ db }) => {
    const root = path.join(os.tmpdir(), `disco-agents-sync-${Date.now()}-${Math.random()}`);
    cleanup.add(root);
    const service = new AgentsService(db, () => root);
    const owner = '00000000-0000-7000-8000-000000000001' as UserID;
    const created = await service.create({ display_name: '旧名称' }, params(owner));

    const updated = await service.patch(
      created.agent_id,
      { display_name: '新名称', description: '新的长期职责' },
      params(owner)
    );
    const profile = JSON.parse(
      (await readFile(path.join(updated.workspace_path, '.disco', 'agent.json'), 'utf8')).replace(
        /^\uFEFF/u,
        ''
      )
    ) as { display_name: string; responsibilities_summary: string };

    expect(profile).toMatchObject({
      display_name: '新名称',
      responsibilities_summary: '新的长期职责',
    });
    await expect(
      readFile(path.join(updated.workspace_path, '.disco', 'IDENTITY.md'), 'utf8')
    ).resolves.toContain('名称：新名称');
  });

  dbTest(
    'requires the exact typed confirmation and rejects deletion by another user',
    async ({ db }) => {
      const root = path.join(os.tmpdir(), `disco-agents-delete-guard-${Date.now()}-${Math.random()}`);
      cleanup.add(root);
      const service = new AgentsService(db, () => root);
      const owner = '00000000-0000-7000-8000-000000000001' as UserID;
      const other = '00000000-0000-7000-8000-000000000002' as UserID;
      const created = await service.create({ display_name: '不可误删' }, params(owner));

      await expect(service.remove(created.agent_id, params(owner))).rejects.toThrow(
        '删除智能体 不可误删'
      );
      await expect(
        service.remove(created.agent_id, {
          ...params(owner),
          query: { confirmation: '删除智能体 错误名称' },
        })
      ).rejects.toThrow('删除智能体 不可误删');
      await expect(
        service.remove(created.agent_id, {
          ...params(other),
          query: { confirmation: '删除智能体 不可误删' },
        })
      ).rejects.toThrow('Agent not found');

      await expect(service.get(created.agent_id, params(owner))).resolves.toMatchObject({
        display_name: '不可误删',
      });
      await expect(access(created.workspace_path)).resolves.toBeUndefined();
    }
  );

  dbTest(
    'deletes only the selected Agent sessions and workspace while preserving sibling and standalone sessions',
    async ({ db }) => {
      const root = path.join(os.tmpdir(), `disco-agents-delete-scope-${Date.now()}-${Math.random()}`);
      cleanup.add(root);
      const service = new AgentsService(db, () => root);
      const sessions = new SessionRepository(db);
      const owner = '00000000-0000-7000-8000-000000000001' as UserID;
      const target = await service.create({ display_name: '待删除' }, params(owner));
      const sibling = await service.create({ display_name: '保留智能体' }, params(owner));

      const createSession = (data: Pick<Session, 'agent_id' | 'working_directory'>) =>
        sessions.create({
          created_by: owner,
          agentic_tool: 'codex',
          status: 'idle',
          agent_id: data.agent_id,
          working_directory: data.working_directory,
        });
      const targetSession = await createSession({
        agent_id: target.agent_id,
        working_directory: target.workspace_path,
      });
      const siblingSession = await createSession({
        agent_id: sibling.agent_id,
        working_directory: sibling.workspace_path,
      });
      const standaloneSession = await createSession({
        agent_id: null,
        working_directory: path.join(root, 'standalone-session'),
      });

      await expect(
        service.remove(target.agent_id, {
          ...params(owner),
          query: { confirmation: '删除智能体 待删除' },
        })
      ).resolves.toMatchObject({ agent_id: target.agent_id, display_name: '待删除' });

      await expect(service.get(target.agent_id, params(owner))).rejects.toThrow('Agent not found');
      await expect(sessions.findById(targetSession.session_id)).resolves.toBeNull();
      await expect(sessions.findById(siblingSession.session_id)).resolves.toMatchObject({
        agent_id: sibling.agent_id,
      });
      await expect(sessions.findById(standaloneSession.session_id)).resolves.toMatchObject({
        agent_id: null,
      });
      await expect(service.get(sibling.agent_id, params(owner))).resolves.toMatchObject({
        display_name: '保留智能体',
      });
      await expect(access(target.workspace_path)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(sibling.workspace_path)).resolves.toBeUndefined();
    }
  );
});
