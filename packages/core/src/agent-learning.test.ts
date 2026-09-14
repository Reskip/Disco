import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { completeAgentLearningReview, recordAgentMemoryChange } from './agent-learning.js';
import { createDefaultDiscoAgentProfile } from './agent-profile.js';
import {
  prepareDiscoAgentRuntimeContext,
  readDiscoAgentLearningStatus,
  readDiscoAgentMemories,
} from './agent-runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'disco-learning-'));
  roots.push(root);
  mkdirSync(path.join(root, '.disco', 'memory'), { recursive: true });
  writeFileSync(
    path.join(root, '.disco', 'agent.json'),
    JSON.stringify(createDefaultDiscoAgentProfile({ displayName: '学习测试' }))
  );
  return root;
}

function update(root: string, index: number) {
  writeFileSync(
    path.join(root, '.disco', 'memory', 'preferences.md'),
    `---\nstatus: active\n---\n# 偏好\n\n有效信息 ${index}。\n`,
    'utf8'
  );
  recordAgentMemoryChange(root, readDiscoAgentMemories(root));
}

function review(root: string, consolidation = false) {
  const memories = readDiscoAgentMemories(root);
  const before = readDiscoAgentLearningStatus(root);
  return completeAgentLearningReview({
    workspace: root,
    memories,
    sessionId: 'session-1',
    input: {
      phase: 'complete',
      taskId: 'task-1',
      memoryDecision: '已检查偏好。',
      skillDecision: '没有新的已验证流程。',
      ...(consolidation
        ? {
            consolidation: {
              fingerprint: before.fingerprint,
              sourcePaths: memories.map((memory) => memory.relativePath),
              content: '最新已验证的偏好；原文保留详细来源。',
            },
          }
        : {}),
    },
  });
}

describe('agent learning lifecycle', () => {
  it('counts real changes to the same topic, ignores duplicates, and preserves pending work across reviews', () => {
    const root = fixture();
    for (let index = 1; index <= 7; index++) update(root, index);
    update(root, 7);
    expect(review(root)).toMatchObject({ pendingUpdates: 7, consolidationDue: false });
    update(root, 8);
    expect(readDiscoAgentLearningStatus(root)).toMatchObject({
      pendingUpdates: 8,
      consolidationDue: true,
    });
    expect(() => review(root)).toThrow(/consolidation is due/u);
    const before = readFileSync(path.join(root, '.disco', 'memory', 'preferences.md'), 'utf8');
    expect(review(root, true)).toMatchObject({ pendingUpdates: 0, consolidationDue: false });
    expect(readFileSync(path.join(root, '.disco', 'memory', 'preferences.md'), 'utf8')).toBe(
      before
    );
    expect(readDiscoAgentLearningStatus(root).reviews).toHaveLength(1);
  });

  it('rejects stale or incomplete snapshots without resetting the pending counter', () => {
    const root = fixture();
    for (let index = 1; index <= 8; index++) update(root, index);
    const stale = readDiscoAgentLearningStatus(root);
    update(root, 9);
    const input = {
      phase: 'complete' as const,
      taskId: 'task-1',
      memoryDecision: '记录',
      skillDecision: '无',
      consolidation: {
        fingerprint: stale.fingerprint,
        sourcePaths: ['.disco/memory/preferences.md'],
        content: '过期摘要',
      },
    };
    expect(() =>
      completeAgentLearningReview({
        workspace: root,
        memories: readDiscoAgentMemories(root),
        sessionId: 's',
        input,
      })
    ).toThrow(/Memory changed/u);
    input.consolidation.fingerprint = readDiscoAgentLearningStatus(root).fingerprint;
    input.consolidation.sourcePaths = [];
    expect(() =>
      completeAgentLearningReview({
        workspace: root,
        memories: readDiscoAgentMemories(root),
        sessionId: 's',
        input,
      })
    ).toThrow(/Memory changed/u);
    expect(readDiscoAgentLearningStatus(root)).toMatchObject({
      pendingUpdates: 9,
      consolidationDue: true,
      reviews: [],
    });
  });

  it('loads a current summary with provenance and falls back to original records after an edit or disable', () => {
    const root = fixture();
    update(root, 1);
    review(root, true);
    const options = { agentWorkspace: root, sessionWorkspace: path.join(root, 'sessions', 'one') };
    expect(prepareDiscoAgentRuntimeContext(options).content).toContain('最新已验证的偏好');
    expect(prepareDiscoAgentRuntimeContext(options).content).toContain(
      '.disco/memory/preferences.md'
    );
    update(root, 2);
    const changed = prepareDiscoAgentRuntimeContext(options).content;
    expect(changed).toContain('有效信息 2');
    expect(changed).not.toContain('最新已验证的偏好');
    review(root, true);
    writeFileSync(
      path.join(root, '.disco', 'capabilities.json'),
      JSON.stringify({ enabled: { 'memory:.disco/memory/preferences.md': false } })
    );
    expect(prepareDiscoAgentRuntimeContext(options).content).not.toContain('最新已验证的偏好');
    expect(readDiscoAgentMemories(root)).toEqual([]);
  });

  it('detects large legacy memory and retains a deferred consolidation request', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, '.disco', 'memory', 'legacy.md'),
      `# 长期记录\n${'甲'.repeat(12_001)}`
    );
    expect(readDiscoAgentLearningStatus(root).consolidationDue).toBe(true);
    const result = completeAgentLearningReview({
      workspace: root,
      memories: readDiscoAgentMemories(root),
      sessionId: 's',
      input: {
        phase: 'complete',
        taskId: 't',
        memoryDecision: '待核对',
        skillDecision: '无',
        deferReason: '来源冲突需要核实',
      },
    });
    expect(result.consolidationDue).toBe(true);
    expect(result.reviews[0]?.deferReason).toContain('冲突');
  });
});
