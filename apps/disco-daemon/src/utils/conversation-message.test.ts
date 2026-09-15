import type { Message } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import { conversationMessage } from './conversation-message';

describe('conversation message projection', () => {
  it('defers bulky tools while preserving text, attachments, plans and error status', () => {
    const input = { code: 'x'.repeat(1_000_000), description: '检查数据' };
    const content = [
      { type: 'text', text: '完整正文' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input },
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'y'.repeat(1_000_000),
        is_error: true,
        diff: { files: [] },
      },
      { type: 'file_citation', upload_ref: 'upload-file', filename: 'report.zip' },
      {
        type: 'tool_use',
        id: 'plan',
        name: 'TodoWrite',
        input: { todos: [{ content: '检查', status: 'completed' }] },
      },
    ];
    const original = {
      message_id: 'm1',
      content,
      tool_uses: [{ id: 'tool-1', name: 'Bash', input }],
      metadata: { attachments: [{ upload_ref: 'photo' }] },
    } as unknown as Message;
    const projected = conversationMessage(original);
    expect(JSON.stringify(projected).length).toBeLessThan(2000);
    expect(projected.content).toEqual([
      content[0],
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { description: '检查数据' },
        deferred: { message_id: 'm1', block_index: 1 },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: '',
        is_error: true,
        deferred: { message_id: 'm1', block_index: 2 },
      },
      content[3],
      content[4],
    ]);
    expect(projected.metadata).toBe(original.metadata);
    expect(original.content).toBe(content);
    expect((original.content as typeof content)[1].input).toBe(input);
    expect(original.tool_uses?.[0].input.code).toHaveLength(1_000_000);
  });

  it('keeps question requests and plain text unchanged', () => {
    for (const content of ['正文', { questions: [{ question: '请选择' }] }]) {
      const message = { content } as Message;
      expect(conversationMessage(message)).toBe(message);
    }
  });
});
