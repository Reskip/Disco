import type { KnowledgeLibraryStatus } from '@disco/core/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KnowledgeProgress } from './KnowledgeProgress';

describe('knowledge processing progress', () => {
  it('shows an active model wait without marking the queued entry as completed', () => {
    render(
      <KnowledgeProgress
        status={{
          total: 1,
          conversations: 1,
          documents: 0,
          notes: 0,
          humanEdited: 0,
          pendingIndex: 0,
          deleted: 0,
          totalBytes: 10,
          processing: {
            index: { indexed: 1, pending: 0, failed: 0, unsupported: 0 },
            summary: {
              completed: 0,
              pending: 1,
              failed: 0,
              active: '原始会话',
              progress: { phase: 'waiting_model', stage: 'map', completed: 0, total: 1 },
            },
          },
        }}
      />
    );
    expect(screen.getByText('原始会话 · 等待模型响应')).toBeInTheDocument();
    expect(screen.getByText('知识整理 · 0 份已处理')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '知识整理进度' })).toHaveAttribute(
      'aria-valuenow',
      '0'
    );
  });

  it('does not mark a large batch complete while a few entries remain', () => {
    const status: KnowledgeLibraryStatus = {
      total: 1712,
      conversations: 300,
      documents: 1348,
      notes: 64,
      humanEdited: 0,
      pendingIndex: 8,
      deleted: 0,
      totalBytes: 0,
      processing: {
        index: { indexed: 1704, pending: 8, failed: 0, unsupported: 1348 },
        summary: { completed: 299, pending: 1, failed: 0, archivedOnly: 235 },
      },
    };
    const { rerender } = render(<KnowledgeProgress status={status} />);
    expect(screen.getByText('知识整理 · 299 份已处理')).toBeInTheDocument();
    expect(screen.getByText(/笔记 64 篇 · 待整理 1 · 235 份仅归档/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '检索索引进度' })).toHaveAttribute(
      'aria-valuenow',
      '99'
    );
    expect(screen.getByRole('progressbar', { name: '知识整理进度' })).toHaveAttribute(
      'aria-valuenow',
      '99'
    );
    rerender(
      <KnowledgeProgress
        status={{
          ...status,
          pendingIndex: 0,
          processing: {
            index: { indexed: 1712, pending: 0, failed: 0, unsupported: 1348 },
            summary: { completed: 300, pending: 0, failed: 0 },
          },
        }}
      />
    );
    expect(screen.getByRole('progressbar', { name: '检索索引进度' })).toHaveAttribute(
      'aria-valuenow',
      '100'
    );
    expect(screen.getByRole('progressbar', { name: '知识整理进度' })).toHaveAttribute(
      'aria-valuenow',
      '100'
    );
  });
});
