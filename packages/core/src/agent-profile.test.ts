import { describe, expect, it } from 'vitest';

import {
  createDefaultDiscoAgentProfile,
  renderDiscoAgentInstructions,
  renderDiscoAgentProfileFiles,
} from './agent-profile.js';

describe('Disco agent generated profile files', () => {
  it('keeps AGENTS.md as a concise generated-view notice', () => {
    const instructions = renderDiscoAgentInstructions();

    expect(instructions).toContain('自动生成');
    expect(instructions).toContain('请勿手动编辑');
    expect(instructions).not.toContain('管理页面');
    expect(instructions.length).toBeLessThan(100);
  });

  it('never persists runtime governance or storage implementation rules', () => {
    const profile = createDefaultDiscoAgentProfile({
      displayName: '家庭管家',
      responsibilities: '维护家庭设备。',
      now: '2026-08-29T00:00:00.000Z',
    });
    const files = renderDiscoAgentProfileFiles(profile);
    const persistedText = Object.values(files).join('\n');

    expect(files['.disco/IDENTITY.md']).toContain('家庭管家');
    expect(files['.disco/RESPONSIBILITIES.md']).toContain('维护家庭设备');
    for (const forbidden of [
      'Disco 用户目录边界',
      '当前用户目录：',
      '不要访问用户目录根',
      'Disco 托管记忆方法',
      'Disco 托管技能方法',
      'disco_files_publish',
      'disco_search_tools',
      'agent-inference',
      '32 KiB',
    ]) {
      expect(persistedText).not.toContain(forbidden);
    }
  });
});
