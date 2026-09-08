import type { Message } from '@disco-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CompactionBlock } from './CompactionBlock';

function compactionMessage(id: string, content: Record<string, unknown>, index = 0): Message {
  return {
    message_id: id,
    session_id: 'session-1',
    task_id: 'compact-1',
    type: 'message',
    role: 'system',
    index,
    timestamp: `2026-08-28T09:00:0${index}.000Z`,
    content: [content],
    content_preview: '',
  } as unknown as Message;
}

describe('CompactionBlock', () => {
  it('shows exactly one understated running indicator while compaction is active', () => {
    const { container } = render(
      <CompactionBlock
        messages={[compactionMessage('start', { type: 'system_status', status: 'compacting' })]}
      />
    );

    expect(screen.getByRole('status', { name: '正在压缩上下文' })).toHaveTextContent(
      '正在压缩上下文…'
    );
    expect(container.querySelectorAll('.ant-spin')).toHaveLength(1);
    expect(screen.queryByText('Details')).not.toBeInTheDocument();
    expect(container.querySelector('.ant-bubble')).not.toBeInTheDocument();
  });

  it('settles to a small check marker without avatar, card, metadata, or spinner', () => {
    const { container } = render(
      <CompactionBlock
        messages={[
          compactionMessage('start', { type: 'system_status', status: 'compacting' }),
          compactionMessage(
            'complete',
            {
              type: 'system_complete',
              systemType: 'compaction',
              trigger: 'automatic',
              pre_tokens: 123456,
            },
            1
          ),
        ]}
      />
    );

    expect(screen.getByRole('status', { name: '上下文已自动压缩' })).toHaveTextContent(
      '上下文已自动压缩'
    );
    expect(container.querySelector('.anticon-check-circle')).toBeInTheDocument();
    expect(container.querySelector('.ant-spin')).not.toBeInTheDocument();
    expect(screen.queryByText(/触发原因|压缩前 Token|耗时|Details/)).not.toBeInTheDocument();
    expect(container.querySelector('.ant-bubble')).not.toBeInTheDocument();
  });
});
