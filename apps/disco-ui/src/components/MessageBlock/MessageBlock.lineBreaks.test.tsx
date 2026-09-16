import type { Message } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';

function message(content: string, role = 'user'): Message {
  return {
    message_id: 'line-breaks',
    session_id: 'line-break-session',
    type: 'message',
    role,
    index: 0,
    timestamp: '2026-09-16T08:00:00.000Z',
    content,
    content_preview: content,
  } as Message;
}

describe('user message line breaks', () => {
  it.each(['\n', '\r\n'])('shows entered line endings %j as visible breaks', (newline) => {
    const text = ['第一行', '第二行', 'Third line', '', '新的段落'].join(newline);
    const { container } = render(<MessageBlock message={message(text)} />);
    const paragraphs = container.querySelectorAll('.disco-message-markdown p');

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].querySelectorAll('br')).toHaveLength(2);
    expect(paragraphs[1]).toHaveTextContent('新的段落');
  });

  it('preserves breaks when a long message is expanded and collapsed', () => {
    const text = Array.from({ length: 20 }, (_, i) => `消息第 ${i + 1} 行`).join('\n');
    const { container } = render(<MessageBlock message={message(text)} />);

    expect(container.querySelectorAll('.disco-message-markdown p br')).toHaveLength(11);
    fireEvent.click(screen.getByRole('button', { name: 'show more' }));
    expect(container.querySelectorAll('.disco-message-markdown p br')).toHaveLength(19);
    expect(screen.getByText(/消息第 20 行/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'show less' }));
    expect(container.querySelectorAll('.disco-message-markdown p br')).toHaveLength(11);
  });

  it('keeps markdown formatting and code while avoiding duplicate hard breaks', async () => {
    const text = [
      '**加粗**',
      '[链接](https://example.com)',
      '',
      '- 第一项',
      '  继续第一项',
      '- 第二项',
      '',
      '已有硬换行  ',
      '第二行\\',
      '第三行',
      '',
      '```text',
      'code one',
      '  code two',
      '```',
    ].join('\n');
    const { container } = render(<MessageBlock message={message(text)} isLatestMessage />);

    expect(container.querySelector('[data-streamdown="strong"]')).toHaveTextContent('加粗');
    expect(screen.getByRole('link', { name: '链接' })).toHaveAttribute(
      'href',
      'https://example.com/'
    );
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('li')?.querySelectorAll('br')).toHaveLength(1);
    expect(container.querySelectorAll('.disco-message-markdown p br')).toHaveLength(3);
    await waitFor(() => {
      const lines = container.querySelectorAll('[data-streamdown="code-block-body"] code > span');
      expect(Array.from(lines, (line) => line.textContent)).toEqual(['code one', '  code two']);
    });
    expect(container.querySelector('pre br')).toBeNull();
  });

  it('retains standard markdown paragraph wrapping for assistant output', () => {
    const { container } = render(<MessageBlock message={message('第一行\n第二行', 'assistant')} />);
    expect(container.querySelectorAll('.disco-message-markdown p')).toHaveLength(1);
    expect(container.querySelector('br')).toBeNull();
  });
});
