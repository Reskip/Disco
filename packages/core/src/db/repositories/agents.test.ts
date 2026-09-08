import { describe, expect } from 'vitest';
import type { UserID } from '../../types';
import { dbTest } from '../test-helpers';
import { AgentRepository } from './agents';

describe('AgentRepository', () => {
  dbTest('stores a first-class Agent and enforces owner lookup', async ({ db }) => {
    const repository = new AgentRepository(db);
    const owner = '00000000-0000-7000-8000-000000000001' as UserID;
    const other = '00000000-0000-7000-8000-000000000002' as UserID;
    const created = await repository.create({
      createdBy: owner,
      displayName: '家庭管家',
      description: '维护家庭设备',
      emoji: '🏠',
      workspacePath: 'C:/disco/users/user-1/agents/agent-1',
      state: 'ready',
    });

    await expect(repository.findOwnedById(created.agent_id, owner)).resolves.toMatchObject({
      display_name: '家庭管家',
      workspace_path: 'C:/disco/users/user-1/agents/agent-1',
      state: 'ready',
    });
    await expect(repository.findOwnedById(created.agent_id, other)).resolves.toBeNull();
  });

  dbTest('patches editable metadata without changing identity or workspace', async ({ db }) => {
    const repository = new AgentRepository(db);
    const owner = '00000000-0000-7000-8000-000000000001' as UserID;
    const created = await repository.create({
      createdBy: owner,
      displayName: '测试智能体',
      workspacePath: 'C:/disco/users/user-1/agents/agent-2',
    });

    const patched = await repository.patch(created.agent_id, {
      display_name: '新名称',
      description: '新职责',
      archived: true,
    });

    expect(patched).toMatchObject({
      agent_id: created.agent_id,
      created_by: owner,
      display_name: '新名称',
      description: '新职责',
      workspace_path: created.workspace_path,
      archived: true,
    });
  });
});
