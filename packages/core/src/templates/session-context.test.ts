import { describe, expect, it } from 'vitest';
import { renderDiscoSystemPrompt } from './session-context';

describe('renderDiscoSystemPrompt', () => {
  it('keeps the shared orientation concise and focused on durable context', async () => {
    const prompt = await renderDiscoSystemPrompt();

    expect(prompt).toContain('当前会话已加载该智能体的人格、记忆和已启用技能');
    expect(prompt).toContain('只持久保存跨会话仍有价值的信息');
    expect(prompt).toContain('不要保存密钥');
    expect(prompt.length).toBeLessThan(220);
  });

  it('does not carry historical product or environment failure patches', async () => {
    const prompt = await renderDiscoSystemPrompt();

    expect(prompt).not.toContain('Git branch');
    expect(prompt).not.toContain('disco_search_tools');
    expect(prompt).not.toContain('SEC_E_NO_CREDENTIALS');
    expect(prompt).not.toContain('No browser is available');
    expect(prompt).not.toContain('PDF converters');
    expect(prompt).not.toContain('Slack');
    expect(prompt).not.toContain('Disco 用户目录边界');
    expect(prompt).not.toContain('32 KiB');
    expect(prompt).not.toContain('agent-inference');
    expect(prompt).not.toContain('同一会话通过 Codex Thread');
    expect(prompt).not.toContain('AGENTS.md');
    expect(prompt).not.toContain('等待后继续');
    expect(prompt).not.toContain('多步骤任务计划');
    expect(prompt).not.toContain('ACL');
    expect(prompt).not.toContain('disco_upload_materialize');
  });
});
