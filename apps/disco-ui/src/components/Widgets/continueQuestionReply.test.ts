import type { DiscoClient, Session, Task } from '@disco-live/client';
import { describe, expect, it, vi } from 'vitest';
import { continueQuestionReply } from './continueQuestionReply';

const reply = {
  task_id: 'reply-task',
  session_id: 'session-a',
  status: 'queued',
  metadata: { system_authored: true, widget_id: 'widget-a' },
  full_prompt:
    '[Disco] 用户已回答本次问题，请依据以下回答继续原任务。回答只针对对应问题，不是对其他操作的授权。\n' +
    JSON.stringify([{ question: '选择功能', selected: ['导入', '导出'], answer: '原样保留\n🙂' }]),
} as Task;
const running = { status: 'running', agentic_tool: 'codex' } as Session;

function setup(session = running, tasks = [reply]) {
  const get = vi.fn(async () => session);
  const find = vi.fn(async () => ({ data: tasks }));
  const create = vi.fn(async () => ({ result: { steered: true } }));
  const client = {
    service: vi.fn((path: string) => {
      if (path === 'sessions') return { get };
      if (path === '/sessions/session-a/tasks/queue') return { find };
      if (path === '/sessions/session-a/tasks/queue-steer') return { create };
      throw new Error(`Unexpected service: ${path}`);
    }),
  } as unknown as DiscoClient;
  return { client, get, find, create };
}

describe('continue a saved question reply', () => {
  it('hands off only the saved queue identity, leaving answer bytes untouched', async () => {
    const original = JSON.stringify(reply);
    const fixture = setup();
    await continueQuestionReply(fixture.client, 'session-a', 'widget-a');
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({ taskId: reply.task_id });
    expect(JSON.stringify(reply)).toBe(original);
  });

  it.each(['idle', 'failed', 'stopping'] as const)(
    'leaves the durable continuation in place for a %s session',
    async (status) => {
      const fixture = setup({ ...running, status });
      await continueQuestionReply(fixture.client, 'session-a', 'widget-a');
      expect(fixture.find).not.toHaveBeenCalled();
      expect(fixture.create).not.toHaveBeenCalled();
    }
  );

  it('does not attempt Codex steering for another executor', async () => {
    const fixture = setup({ ...running, agentic_tool: 'claude-code' as never });
    await continueQuestionReply(fixture.client, 'session-a', 'widget-a');
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('does not send a duplicate after admission or another tab has claimed the queued answer', async () => {
    const fixture = setup(running, []);
    await continueQuestionReply(fixture.client, 'session-a', 'widget-a');
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('leaves other questions, other sessions and ordinary prompts untouched', async () => {
    const fixture = setup(running, [
      { ...reply, metadata: { ...reply.metadata, widget_id: 'other-widget' as never } },
      { ...reply, session_id: 'other-session' as never },
      { ...reply, status: 'running' },
      { ...reply, metadata: { widget_id: 'widget-a' as never } },
      { ...reply, full_prompt: 'a normal message' },
    ]);
    await continueQuestionReply(fixture.client, 'session-a', 'widget-a');
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('does not resubmit or directly prompt if the atomic handoff rejects a race', async () => {
    const fixture = setup();
    fixture.create.mockRejectedValue(new Error('already claimed'));
    await expect(continueQuestionReply(fixture.client, 'session-a', 'widget-a')).rejects.toThrow(
      'already claimed'
    );
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.client.service).not.toHaveBeenCalledWith('/sessions/session-a/prompt');
  });
});
