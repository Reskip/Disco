import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultDiscoAgentProfile } from './agent-profile.js';
import { prepareDiscoAgentRuntimeContext, writeDiscoAgentPreloadFailure } from './agent-runtime.js';

const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'disco-agent-runtime-'));
  temporaryRoots.push(root);
  const agentWorkspace = path.join(root, 'worktrees', 'user-alpha', 'agents', 'helper');
  const sessionWorkspace = path.join(agentWorkspace, 'sessions', 'session-1');
  mkdirSync(path.join(agentWorkspace, '.disco', 'memory'), { recursive: true });
  mkdirSync(path.join(agentWorkspace, 'skills', 'house-rules'), { recursive: true });
  mkdirSync(sessionWorkspace, { recursive: true });

  const profile = createDefaultDiscoAgentProfile({
    displayName: '家庭管家',
    responsibilities: '维护家庭设备并记住长期约定。',
    now: '2026-08-27T01:00:00.000Z',
  });
  profile.documents.soul = '# 性格与原则\n\n耐心、简洁。\n';
  profile.documents.user_preferences = '# 用户偏好\n\n称呼用户为老板。\n';
  writeFileSync(
    path.join(agentWorkspace, '.disco', 'agent.json'),
    `${JSON.stringify(profile, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    path.join(agentWorkspace, '.disco', 'memory', 'network.md'),
    `---\ntopic: 家庭网络\nsource: user-explicit\nconfidence: 1\nstatus: active\ncreated_at: 2026-08-27T01:00:00.000Z\nupdated_at: 2026-08-27T01:00:00.000Z\n---\n# 家庭网络\n\nNAS 地址是 192.168.1.10。\n`,
    'utf8'
  );
  writeFileSync(
    path.join(agentWorkspace, 'skills', 'house-rules', 'SKILL.md'),
    '# 家庭设备检查\n\n先检查连通性，再修改配置。\n',
    'utf8'
  );
  writeFileSync(
    path.join(agentWorkspace, '.disco', 'capabilities.json'),
    '{\n  "version": 1,\n  "enabled": {}\n}\n',
    'utf8'
  );
  return { agentWorkspace, sessionWorkspace };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('Disco agent runtime preload', () => {
  it('materializes canonical identity, enabled memory, and enabled skills for a nested session', () => {
    const { agentWorkspace, sessionWorkspace } = fixture();
    const snapshot = prepareDiscoAgentRuntimeContext({
      agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T02:00:00.000Z',
    });

    expect(snapshot).toMatchObject({
      status: 'ready',
      memory_files: 1,
      skill_files: 1,
      profile_updated_at: '2026-08-27T01:00:00.000Z',
    });
    expect(snapshot.content).toContain('家庭管家');
    expect(snapshot.content).toContain('NAS 地址是 192.168.1.10');
    expect(snapshot.content).toContain('家庭设备检查');
    expect(snapshot.content).not.toContain('先检查连通性，再修改配置');
    expect(snapshot.content).toContain('以下为当前有效资料');
    expect(snapshot.content).toContain('完整技能说明在任务相关时按需加载');
    expect(snapshot.content).toContain('## 身份\n\n- 名称：家庭管家');
    expect(snapshot.content).not.toContain('## 身份\n\n# 身份');
    expect(snapshot.content).not.toContain('## 当前职责摘要');
    expect(snapshot.content).not.toContain('disco:summary');
    expect(snapshot.content).toContain('### 家庭网络\n\nNAS 地址是 192.168.1.10');
    expect(snapshot.content).not.toContain('topic: 家庭网络');
    expect(snapshot.content).not.toContain('.disco/memory/network.md');
    expect(snapshot.content).not.toContain('skills/house-rules/SKILL.md');
    expect(snapshot.content).not.toContain('同一会话通过 Codex Thread 延续历史');
    expect(snapshot.content).not.toContain('.disco/capabilities.json');
    expect(snapshot.content).not.toContain(path.resolve(agentWorkspace));
    expect(snapshot.content).not.toContain(path.resolve(sessionWorkspace));
    expect(snapshot.content).not.toContain('## 资料维护');
    expect(snapshot.content).not.toContain('agent-inference');
    expect(snapshot.content).not.toContain('32 KiB');
    expect(snapshot.content).not.toContain('Disco 用户目录边界');
    expect(readFileSync(snapshot.context_file, 'utf8')).toBe(snapshot.content);
    expect(
      JSON.parse(
        readFileSync(path.join(sessionWorkspace, '.disco-runtime', 'preload.json'), 'utf8')
      )
    ).toMatchObject({
      status: 'ready',
      fingerprint: snapshot.fingerprint,
      memory_files: 1,
      skill_files: 1,
    });
  });

  it('reuses the existing session snapshot while canonical content is unchanged', () => {
    const { agentWorkspace, sessionWorkspace } = fixture();
    const first = prepareDiscoAgentRuntimeContext({
      agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T02:00:00.000Z',
    });
    const statusPath = path.join(sessionWorkspace, '.disco-runtime', 'preload.json');
    const contextBefore = readFileSync(first.context_file, 'utf8');
    const statusBefore = readFileSync(statusPath, 'utf8');

    const reused = prepareDiscoAgentRuntimeContext({
      agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T03:00:00.000Z',
    });

    expect(reused.fingerprint).toBe(first.fingerprint);
    expect(reused.prepared_at).toBe('2026-08-27T02:00:00.000Z');
    expect(readFileSync(reused.context_file, 'utf8')).toBe(contextBefore);
    expect(readFileSync(statusPath, 'utf8')).toBe(statusBefore);
  });

  it('omits disabled memories and skills from the prompt snapshot', () => {
    const { agentWorkspace, sessionWorkspace } = fixture();
    writeFileSync(
      path.join(agentWorkspace, '.disco', 'capabilities.json'),
      `\uFEFF${JSON.stringify(
        {
          version: 1,
          enabled: {
            'profile:.disco/soul.md': false,
            'memory:.disco/memory/network.md': false,
            'skill:skills/house-rules/skill.md': false,
          },
        },
        null,
        2
      )}`,
      'utf8'
    );

    const snapshot = prepareDiscoAgentRuntimeContext({ agentWorkspace, sessionWorkspace });
    expect(snapshot.memory_files).toBe(0);
    expect(snapshot.skill_files).toBe(0);
    expect(snapshot.content).not.toContain('192.168.1.10');
    expect(snapshot.content).not.toContain('先检查连通性');
    expect(snapshot.content).not.toContain('耐心、简洁');
  });

  it('does not load an empty placeholder as long-term memory', () => {
    const { agentWorkspace, sessionWorkspace } = fixture();
    writeFileSync(
      path.join(agentWorkspace, '.disco', 'memory', 'network.md'),
      `---\ntopic: 通用\nstatus: active\n---\n# 通用记忆\n\n尚未记录。\n`,
      'utf8'
    );

    const snapshot = prepareDiscoAgentRuntimeContext({ agentWorkspace, sessionWorkspace });
    expect(snapshot.memory_files).toBe(0);
    expect(snapshot.content).not.toContain('### 通用');
  });

  it('refreshes an existing session snapshot after canonical memory changes', () => {
    const { agentWorkspace, sessionWorkspace } = fixture();
    const first = prepareDiscoAgentRuntimeContext({
      agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T02:00:00.000Z',
    });
    writeFileSync(
      path.join(agentWorkspace, '.disco', 'memory', 'network.md'),
      `---\ntopic: 家庭网络\nsource: user-explicit\nconfidence: 1\nstatus: active\ncreated_at: 2026-08-27T01:00:00.000Z\nupdated_at: 2026-08-27T02:30:00.000Z\n---\n# 家庭网络\n\nNAS 地址已经改成 192.168.1.20。\n`,
      'utf8'
    );

    const refreshed = prepareDiscoAgentRuntimeContext({
      agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T03:00:00.000Z',
    });

    expect(refreshed.fingerprint).not.toBe(first.fingerprint);
    expect(refreshed.content).toContain('192.168.1.20');
    expect(refreshed.content).not.toContain('192.168.1.10');
    expect(readFileSync(refreshed.context_file, 'utf8')).toBe(refreshed.content);
    expect(
      JSON.parse(
        readFileSync(path.join(sessionWorkspace, '.disco-runtime', 'preload.json'), 'utf8')
      )
    ).toMatchObject({
      status: 'ready',
      fingerprint: refreshed.fingerprint,
      prepared_at: '2026-08-27T03:00:00.000Z',
    });
  });

  it('persists a recoverable failed preload state without creating a chat task', () => {
    const { agentWorkspace, sessionWorkspace } = fixture();
    const failure = writeDiscoAgentPreloadFailure(
      sessionWorkspace,
      new Error('profile not ready'),
      '2026-08-27T03:00:00.000Z'
    );
    expect(failure).toEqual({
      version: 1,
      status: 'failed',
      attempted_at: '2026-08-27T03:00:00.000Z',
      message: 'profile not ready',
    });
    expect(
      JSON.parse(
        readFileSync(path.join(sessionWorkspace, '.disco-runtime', 'preload.json'), 'utf8')
      )
    ).toEqual(failure);

    const retried = prepareDiscoAgentRuntimeContext({
      agentWorkspace,
      sessionWorkspace,
      now: '2026-08-27T03:01:00.000Z',
    });
    expect(retried.status).toBe('ready');
    expect(
      JSON.parse(
        readFileSync(path.join(sessionWorkspace, '.disco-runtime', 'preload.json'), 'utf8')
      )
    ).toMatchObject({ status: 'ready', prepared_at: '2026-08-27T03:01:00.000Z' });
  });
});
