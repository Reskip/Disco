/**
 * TaskBlock — groupMessagesIntoBlocks unit tests.
 *
 * Setup forms follow the agent's closing explanation. Question cards retain
 * their chronological place as they resolve and the task continues streaming.
 * Neither presentation policy rewrites message indices or identity.
 */

import type { Message, Task } from '@disco-live/client';
import { describe, expect, it } from 'vitest';

import {
  type Block,
  findActiveAgentChainIndex,
  findActiveCompactionIndex,
  findTurnStatusInsertIndex,
  groupMessagesIntoBlocks,
  isVerifiedRuntimeInterruption,
  shouldRenderLiveTaskProgress,
} from './TaskBlock';

function userMessage(index: number, id: string): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    type: 'message',
    role: 'user',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: 'user text',
    content_preview: 'user text',
  } as unknown as Message;
}

function assistantText(index: number, id: string, text: string): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    type: 'message',
    role: 'assistant',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: [{ type: 'text', text }],
    content_preview: text,
  } as unknown as Message;
}

function assistantActivity(
  index: number,
  id: string,
  content: Array<Record<string, unknown>>
): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    type: 'message',
    role: 'assistant',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content,
    content_preview: '',
  } as unknown as Message;
}

function widgetRequest(index: number, id: string): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    type: 'widget_request',
    role: 'system',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: 'Please provide gateway tokens',
    content_preview: 'Please provide gateway tokens',
    metadata: { widget: { widget_id: id, widget_type: 'gateway_token' } },
  } as unknown as Message;
}

function compactionMessage(index: number, id: string, content: Record<string, unknown>): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    task_id: 'compact-task',
    type: 'message',
    role: 'system',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: [content],
    content_preview: '',
  } as unknown as Message;
}

/** Message id of a block, for order assertions. */
function blockId(block: Block): string {
  return block.type === 'message' ? block.message.message_id : block.messages[0].message_id;
}

describe('groupMessagesIntoBlocks — widget_request ordering', () => {
  it.each(['pending', 'resolving', 'submitted', 'dismissed'] as const)(
    'keeps a %s question before later replies and activity',
    (status) => {
      const card = widgetRequest(1, 'question');
      card.metadata = { widget: { ...card.metadata!.widget!, widget_type: 'questions', status } };
      const messages = [
        userMessage(0, 'u0'),
        card,
        assistantText(2, 'reply', '继续处理你的回答'),
        assistantActivity(3, 'activity', [
          { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
        ]),
      ];
      const blocks = groupMessagesIntoBlocks(messages);
      expect(blocks.map(blockId)).toEqual(['u0', 'question', 'reply', 'activity']);
      expect(findActiveAgentChainIndex(blocks)).toBe(3);
      expect(messages[1]).toBe(card);
      expect(card.index).toBe(1);
    }
  );

  it('moves a widget_request block to the end even when its index sorts mid-turn', () => {
    // Widget (index 1) fired BEFORE the agent's closing text (index 2).
    const messages = [
      userMessage(0, 'u0'),
      widgetRequest(1, 'w1'),
      assistantText(2, 'a2', 'Here are the setup steps.'),
    ];

    const blocks = groupMessagesIntoBlocks(messages);

    // Widget renders LAST, after the agent's closing text.
    expect(blocks.map(blockId)).toEqual(['u0', 'a2', 'w1']);
    expect(blockId(blocks[blocks.length - 1])).toBe('w1');
  });

  it('appends multiple widget_request blocks in their original relative order', () => {
    const messages = [
      widgetRequest(0, 'w0'),
      assistantText(1, 'a1', 'closing text'),
      widgetRequest(2, 'w2'),
    ];

    const blocks = groupMessagesIntoBlocks(messages);

    expect(blocks.map(blockId)).toEqual(['a1', 'w0', 'w2']);
  });

  it('does not disturb ordering when there are no widget_request messages', () => {
    const messages = [
      userMessage(0, 'u0'),
      assistantText(1, 'a1', 'first'),
      assistantText(2, 'a2', 'second'),
    ];

    const blocks = groupMessagesIntoBlocks(messages);

    expect(blocks.map(blockId)).toEqual(['u0', 'a1', 'a2']);
  });

  it('does not mutate the source messages array or message indices', () => {
    const messages = [
      userMessage(0, 'u0'),
      widgetRequest(1, 'w1'),
      assistantText(2, 'a2', 'closing'),
    ];
    const originalOrder = messages.map((m) => m.message_id);
    const originalIndices = messages.map((m) => m.index);

    groupMessagesIntoBlocks(messages);

    expect(messages.map((m) => m.message_id)).toEqual(originalOrder);
    expect(messages.map((m) => m.index)).toEqual(originalIndices);
  });
});

describe('groupMessagesIntoBlocks — assistant activity', () => {
  it('renders thinking plus user-facing text as a regular message', () => {
    const message = assistantActivity(0, 'a0', [
      { type: 'thinking', text: 'Internal reasoning' },
      { type: 'text', text: 'Working. What do you need?' },
    ]);

    expect(groupMessagesIntoBlocks([message])).toEqual([{ type: 'message', message }]);
  });

  it.each([
    { content: [{ type: 'thinking', text: 'Internal reasoning' }] },
    { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] },
  ])('keeps pure thinking or tool activity in the agent chain', ({ content }) => {
    const message = assistantActivity(0, 'a0', content);

    expect(groupMessagesIntoBlocks([message])).toEqual([
      { type: 'agent-chain', messages: [message] },
    ]);
  });

  it('keeps activity and assistant replies in chronological, separately settled groups', () => {
    const firstActivity = assistantActivity(1, 'activity-1', [
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
    ]);
    const reply = assistantText(2, 'reply-1', 'I found the relevant code.');
    const secondActivity = assistantActivity(3, 'activity-2', [
      { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: 'a.ts' } },
    ]);

    const blocks = groupMessagesIntoBlocks([
      userMessage(0, 'user-1'),
      firstActivity,
      reply,
      secondActivity,
    ]);

    expect(blocks.map((block) => block.type)).toEqual([
      'message',
      'agent-chain',
      'message',
      'agent-chain',
    ]);
    expect(blockId(blocks[1])).toBe('activity-1');
    expect(blockId(blocks[2])).toBe('reply-1');
    expect(blockId(blocks[3])).toBe('activity-2');
    expect(findTurnStatusInsertIndex(blocks)).toBe(1);
    expect(findActiveAgentChainIndex(blocks)).toBe(3);
    expect(findActiveAgentChainIndex(blocks.slice(0, 3))).toBe(-1);
  });
});

describe('groupMessagesIntoBlocks — compaction activity', () => {
  it('keeps compaction as the sole active status until completion arrives', () => {
    const start = compactionMessage(0, 'compact-start', {
      type: 'system_status',
      status: 'compacting',
    });
    const activeBlocks = groupMessagesIntoBlocks([start]);

    expect(activeBlocks).toHaveLength(1);
    expect(activeBlocks[0]?.type).toBe('compaction');
    expect(findActiveCompactionIndex(activeBlocks)).toBe(0);

    const complete = compactionMessage(1, 'compact-complete', {
      type: 'system_complete',
      systemType: 'compaction',
    });
    const settledBlocks = groupMessagesIntoBlocks([start, complete]);

    expect(settledBlocks).toHaveLength(1);
    expect(findActiveCompactionIndex(settledBlocks)).toBe(-1);
  });
});

describe('verified runtime interruption projection', () => {
  const task = {
    status: 'failed',
    sdk_failure: { termination: 'verified' },
    termination_request: { cause: 'heartbeat_lost' },
  } as unknown as Task;

  it('offers outcome-based recovery only for the latest verified interruption', () => {
    expect(isVerifiedRuntimeInterruption(task, true)).toBe(true);
    expect(isVerifiedRuntimeInterruption(task, false)).toBe(false);
  });

  it('keeps unverified containment and user Stop out of Resume UX', () => {
    expect(
      isVerifiedRuntimeInterruption(
        { ...task, sdk_failure: { ...task.sdk_failure!, termination: 'unverified' } } as Task,
        true
      )
    ).toBe(false);
    expect(
      isVerifiedRuntimeInterruption(
        { ...task, termination_request: { ...task.termination_request!, cause: 'user_stop' } },
        true
      )
    ).toBe(false);
  });
});

describe('live runtime projection', () => {
  it.each(['running', 'stopping'])('keeps progress visible while the Task is %s', (status) => {
    expect(shouldRenderLiveTaskProgress({ status } as Task)).toBe(true);
  });

  it.each(['stopped', 'completed', 'failed'])('settles progress after the Task is %s', (status) => {
    expect(shouldRenderLiveTaskProgress({ status } as Task)).toBe(false);
  });
});
