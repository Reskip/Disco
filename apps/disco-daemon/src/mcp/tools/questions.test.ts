import type { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../server.js';

vi.mock('../../utils/append-system-message.js', () => ({
  appendSystemMessage: vi.fn(async () => ({ index: 4 })),
}));
vi.mock('../../utils/session-tasks.js', () => ({
  findHostTaskForSession: vi.fn(async () => ({ task_id: 'task-a', status: 'running' })),
}));

import { appendSystemMessage } from '../../utils/append-system-message.js';
import { findHostTaskForSession } from '../../utils/session-tasks.js';
import { registerQuestionTools } from './questions.js';

function setup(owner = 'user-a') {
  const get = vi.fn(async () => ({ session_id: 'session-a', created_by: owner }));
  const ctx = {
    sessionId: 'session-a',
    userId: 'user-a',
    app: { service: () => ({ get }) },
    db: {},
    baseServiceParams: {},
  } as unknown as McpContext;
  const registerTool = vi.fn();
  registerQuestionTools({ registerTool } as unknown as McpServer, ctx);
  return {
    handler: registerTool.mock.calls[0]![2] as (
      args: unknown
    ) => Promise<{ content: Array<{ text: string }> }>,
    get,
  };
}

describe('disco_ask_questions', () => {
  beforeEach(() => vi.clearAllMocks());
  it('persists the card in the current task and immediately returns pending, without inventing an answer', async () => {
    const { handler } = setup();
    const result = await handler({ questions: [{ id: 'choice', question: '选择哪种方案？' }] });
    const created = vi.mocked(appendSystemMessage).mock.calls[0]![0];
    expect(created).toMatchObject({
      sessionId: 'session-a',
      taskId: 'task-a',
      type: 'widget_request',
    });
    expect(created.metadata?.widget).toMatchObject({
      widget_type: 'questions',
      status: 'pending',
      auto_resume: true,
    });
    expect(created.messageId).toBe(created.metadata?.widget?.widget_id);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      widget_id: created.messageId,
      status: 'waiting_for_user',
    });
  });
  it('rejects another session owner and inactive tasks before writing', async () => {
    await expect(
      setup('user-b').handler({ questions: [{ id: 'q', question: 'Q' }] })
    ).rejects.toThrow(/owner/u);
    vi.mocked(findHostTaskForSession).mockResolvedValueOnce({
      task_id: 'task-a',
      status: 'completed',
    } as never);
    await expect(setup().handler({ questions: [{ id: 'q', question: 'Q' }] })).rejects.toThrow(
      /running/u
    );
    expect(appendSystemMessage).not.toHaveBeenCalled();
  });
});
