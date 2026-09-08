import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRepository,
  SkillLifecycleRepository,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';
import { prepareDiscoAgentRuntimeContext } from '@disco/core/agent-runtime';
import type { Agent, AuthenticatedParams, DiscoSkillLifecycleRecord } from '@disco/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentCapabilitiesService,
  discoverAgentCapabilityFiles,
  isAgentCapabilityEnabled,
} from './agent-capabilities.js';

afterEach(() => vi.restoreAllMocks());

function params(
  agentId: string,
  userId = 'user-1',
  role: 'member' | 'admin' | 'superadmin' = 'member'
): AuthenticatedParams {
  return {
    query: { agent_id: agentId },
    user: { user_id: userId, username: userId, role },
  } as AuthenticatedParams;
}

function agentFixture(agentId: string, workspacePath: string, owner = 'user-1'): Agent {
  return {
    agent_id: agentId,
    created_by: owner,
    display_name: '测试智能体',
    description: null,
    emoji: null,
    avatar_url: null,
    workspace_path: workspacePath,
    state: 'ready',
    error_message: null,
    archived: false,
    created_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z',
  } as Agent;
}

describe('agent capabilities', () => {
  it('discovers, edits, disables and removes only the selected agent files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disco-agent-capabilities-'));
    const skillPath = path.join(root, 'skills', 'summarize', 'SKILL.md');
    const memoryPath = path.join(root, '.disco', 'memory', 'preferences.md');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await mkdir(path.dirname(memoryPath), { recursive: true });
    await writeFile(
      skillPath,
      '---\nname: summary\ndescription: Summarize durable work\n---\n\n# Summary\n',
      'utf8'
    );
    await writeFile(
      memoryPath,
      '---\nversion: 1\ntopic: 用户偏好\nsource: user-explicit\nconfidence: 1\nstatus: active\ncreated_at: 2026-08-26T00:00:00.000Z\nupdated_at: 2026-08-26T00:00:00.000Z\n---\n# 用户偏好\n\n用户偏好简洁回答。\n',
      'utf8'
    );
    await writeFile(
      path.join(root, '.disco', 'capabilities.json'),
      '\uFEFF{\n  "version": 1,\n  "enabled": {\n    "memory:.disco/memory/preferences.md": true\n  }\n}\n',
      'utf8'
    );

    const agent = agentFixture('agent-1', root);
    vi.spyOn(AgentRepository.prototype, 'findOwnedById').mockImplementation(
      async (id, owner) => (id === agent.agent_id && owner === agent.created_by ? agent : null)
    );
    let lifecycleRecords: DiscoSkillLifecycleRecord[] = [];
    vi.spyOn(SkillLifecycleRepository.prototype, 'findRecords').mockImplementation(
      async () => lifecycleRecords
    );
    vi.spyOn(SkillLifecycleRepository.prototype, 'findRecord').mockImplementation(
      async id => lifecycleRecords.find(record => record.id === id) ?? null
    );
    vi.spyOn(SkillLifecycleRepository.prototype, 'setRecord').mockImplementation(async record => {
      lifecycleRecords = [
        ...lifecycleRecords.filter(candidate => candidate.id !== record.id),
        record,
      ];
      return record;
    });
    vi.spyOn(SkillLifecycleRepository.prototype, 'appendAudit').mockResolvedValue({} as never);
    const service = new AgentCapabilitiesService({} as TenantScopeAwareDatabase);

    try {
      const initial = await service.find(params('agent-1'));
      expect(initial).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'profile',
            relative_path: '.disco/IDENTITY.md',
            removable: false,
          }),
          expect.objectContaining({
            kind: 'profile',
            relative_path: '.disco/RESPONSIBILITIES.md',
            removable: false,
          }),
          expect.objectContaining({
            kind: 'profile',
            relative_path: '.disco/SOUL.md',
            removable: false,
          }),
          expect.objectContaining({
            kind: 'profile',
            relative_path: '.disco/USER.md',
            removable: false,
          }),
          expect.objectContaining({
            kind: 'skill',
            name: 'summary',
            enabled: true,
            lifecycle: expect.objectContaining({
              scope: 'agent',
              source: 'agent-generated',
              owner_user_id: 'user-1',
            }),
          }),
          expect.objectContaining({ kind: 'memory', name: '用户偏好', removable: true }),
        ])
      );
      expect(await readFile(path.join(root, '.disco', 'IDENTITY.md'), 'utf8')).toContain(
        'Disco 持久智能体'
      );
      expect(await readFile(path.join(root, '.disco', 'RESPONSIBILITIES.md'), 'utf8')).toContain(
        '维护自己的长期职责'
      );
      expect(await readFile(path.join(root, '.disco', 'SOUL.md'), 'utf8')).toContain('性格与原则');
      expect(await readFile(path.join(root, '.disco', 'USER.md'), 'utf8')).toContain('用户偏好');
      const soul = initial.find(entry => entry.relative_path === '.disco/SOUL.md')!;
      await service.patch(soul.id, { content: '# 性格与原则\n\n先给结论。\n' }, params('agent-1'));
      expect(
        JSON.parse(await readFile(path.join(root, '.disco', 'agent.json'), 'utf8')).documents.soul
      ).toContain('先给结论');
      expect(await readFile(path.join(root, '.disco', 'SOUL.md'), 'utf8')).toContain('先给结论');

      const memory = initial.find(entry => entry.relative_path.endsWith('preferences.md'))!;
      await service.patch(memory.id, { content: '# 用户偏好\n\n使用中文。\n' }, params('agent-1'));
      const storedMemory = await readFile(memoryPath, 'utf8');
      expect(storedMemory).toContain('source: user-explicit');
      expect(storedMemory).toContain('使用中文');
      expect(await readFile(path.join(root, '.disco', 'MEMORY.md'), 'utf8')).toContain(
        'memory/preferences.md'
      );
      const skill = initial.find(entry => entry.kind === 'skill')!;

      const sessionWorkspace = path.join(root, 'sessions', 'session-after-edit');
      await mkdir(sessionWorkspace, { recursive: true });
      const runtimeAfterEdit = prepareDiscoAgentRuntimeContext({
        agentWorkspace: root,
        sessionWorkspace,
      });
      expect(runtimeAfterEdit.content).toContain('先给结论');
      expect(runtimeAfterEdit.content).toContain('使用中文');
      expect(runtimeAfterEdit.content).toContain('Summarize durable work');

      await service.patch(skill.id, { enabled: false }, params('agent-1'));
      expect(isAgentCapabilityEnabled(root, 'skill', 'skills/summarize/SKILL.md')).toBe(false);
      expect(
        JSON.parse(
          (await readFile(path.join(root, '.disco', 'capabilities.json'), 'utf8')).replace(
            /^\uFEFF/u,
            ''
          )
        ).enabled
      ).toEqual({
        'memory:.disco/memory/preferences.md': true,
        'skill:skills/summarize/skill.md': false,
      });

      await service.patch(memory.id, { enabled: false }, params('agent-1'));
      const runtimeAfterDisable = prepareDiscoAgentRuntimeContext({
        agentWorkspace: root,
        sessionWorkspace,
      });
      expect(runtimeAfterDisable.content).not.toContain('使用中文');
      expect(runtimeAfterDisable.content).not.toContain('Summarize durable work');

      await service.patch(
        skill.id,
        { content: '# Updated skill\n\nNew behavior.\n' },
        params('agent-1')
      );
      expect(await readFile(skillPath, 'utf8')).toContain('New behavior');

      await expect(service.remove(skill.id, params('agent-1'))).rejects.toThrow(
        /confirmed uninstall action/i
      );
      expect(discoverAgentCapabilityFiles(agent.agent_id, root)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: skill.id })])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps internal managed-block markers out of capability descriptions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disco-agent-capability-description-'));
    const responsibilitiesPath = path.join(root, '.disco', 'RESPONSIBILITIES.md');
    await mkdir(path.dirname(responsibilitiesPath), { recursive: true });
    await writeFile(
      responsibilitiesPath,
      '# 长期职责\n\n<!-- disco:summary:start -->\n## 当前职责摘要\n\n维护自己的长期职责。\n<!-- disco:summary:end -->\n',
      'utf8'
    );

    try {
      const responsibilities = discoverAgentCapabilityFiles('agent-1' as Agent['agent_id'], root).find(
        entry => entry.relative_path === '.disco/RESPONSIBILITIES.md'
      );
      expect(responsibilities?.description).toBe('维护自己的长期职责。');
      expect(responsibilities?.description).not.toContain('disco:summary');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects another member and an unavailable Agent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disco-agent-auth-'));
    const agent = agentFixture('agent-2', root, 'owner');
    vi.spyOn(AgentRepository.prototype, 'findOwnedById').mockImplementation(
      async (id, owner) => (id === agent.agent_id && owner === agent.created_by ? agent : null)
    );
    vi.spyOn(SkillLifecycleRepository.prototype, 'findRecords').mockResolvedValue([]);
    const service = new AgentCapabilitiesService({} as TenantScopeAwareDatabase);
    try {
      await expect(service.find(params('agent-2', 'other'))).rejects.toThrow(/not found/i);
      await expect(service.find(params('agent-2', 'admin', 'superadmin'))).rejects.toThrow(
        /not found/i
      );
      agent.state = 'failed';
      await expect(service.find(params('agent-2', 'owner'))).rejects.toThrow(/not found/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('saves structured memory by topic without duplicate files or no-op rewrites', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disco-agent-memory-'));
    const agent = agentFixture('agent-memory', root);
    vi.spyOn(AgentRepository.prototype, 'findOwnedById').mockImplementation(
      async (id, owner) => (id === agent.agent_id && owner === agent.created_by ? agent : null)
    );
    vi.spyOn(SkillLifecycleRepository.prototype, 'findRecords').mockResolvedValue([]);
    const service = new AgentCapabilitiesService({} as TenantScopeAwareDatabase);

    try {
      const created = await service.create(
        {
          kind: 'memory',
          topic: '回归口令',
          content: '口令是银杏钟摆-8274。',
          source: 'user-explicit',
          source_session_id: 'session-1',
        },
        params('agent-memory')
      );
      expect(created).toMatchObject({ kind: 'memory', name: '回归口令', enabled: true });
      expect(created.content).toContain('source: user-explicit');
      expect(created.content).toContain('confidence: 1');
      expect(created.content).toContain('银杏钟摆-8274');
      expect(await readFile(path.join(root, '.disco', 'MEMORY.md'), 'utf8')).toContain(
        created.relative_path.replace(/^\.disco\//u, '')
      );

      const target = path.join(root, ...created.relative_path.split('/'));
      const firstMtime = (await stat(target)).mtimeMs;
      const duplicate = await service.create(
        {
          kind: 'memory',
          topic: '回归口令',
          content: '口令是银杏钟摆-8274。',
        },
        params('agent-memory')
      );
      expect(duplicate.id).toBe(created.id);
      expect((await stat(target)).mtimeMs).toBe(firstMtime);
      expect(
        (await readdir(path.join(root, '.disco', 'memory'))).filter(name => name.endsWith('.md'))
      ).toHaveLength(1);

      const replaced = await service.create(
        {
          kind: 'memory',
          topic: '回归口令',
          content: '口令已经更新为海盐星轨-9136。',
          operation: 'replace',
        },
        params('agent-memory')
      );
      expect(replaced.id).toBe(created.id);
      expect(replaced.content).toContain('海盐星轨-9136');
      expect(replaced.content).not.toContain('银杏钟摆-8274');

      await expect(
        service.create(
          { kind: 'memory', topic: '越权', content: '不应写入。' },
          params('agent-memory', 'other')
        )
      ).rejects.toThrow(/not found/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
