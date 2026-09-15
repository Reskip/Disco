import type { Message, Task } from '@disco-live/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskBlock } from './TaskBlock';

const { copy } = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock('../../utils/clipboard', () => ({ useCopyToClipboard: () => [false, copy] }));

const prefix =
  '[Disco] 用户已回答本次问题，请依据以下回答继续原任务。回答只针对对应问题，不是对其他操作的授权。\n';
const rows = [
  { question: '文件怎样处理？', selected: [], answer: '保留现有文件' },
  { question: '先执行哪些步骤？', selected: ['预览'], answer: '确认后再导入\n保留中文和 emoji 🙂' },
];
const task = {
  task_id: 'task-1',
  session_id: 'session-1',
  status: 'completed',
  full_prompt: prefix + JSON.stringify(rows, null, 2),
  metadata: { system_authored: true, widget_id: 'widget-1', initial_message_id: 'reply-1' },
  created_at: '2026-09-15T00:00:00Z',
  duration_ms: 1000,
  message_range: { start_index: 0, end_index: 0, start_timestamp: '2026-09-15T00:00:00Z' },
  git_state: { sha_at_start: 'unknown', ref_at_start: 'unknown' },
} as unknown as Task;
const message = {
  message_id: 'reply-1',
  task_id: task.task_id,
  session_id: task.session_id,
  role: 'user',
  type: 'message',
  index: 0,
  content: task.full_prompt,
  metadata: { source: 'disco' },
} as Message;

function renderTask(value: Task, taskMessages: Message[] = [message]) {
  return render(
    <TaskBlock
      task={value}
      isExpanded
      onExpandChange={vi.fn()}
      taskMessages={taskMessages}
      taskMessagesLoaded
      onLoadTaskMessages={vi.fn()}
      onUnloadTaskMessages={vi.fn()}
    />
  );
}

describe('question answers in the conversation', () => {
  it('renders existing Task-only metadata as readable answers, and copies that same text', () => {
    const { container } = renderTask(task);
    const reply = screen.getByRole('article', { name: '提问回复' });
    expect(within(reply).getByText('已回答')).toBeVisible();
    expect(within(reply).getByText('文件怎样处理？')).toBeVisible();
    expect(within(reply).getByText('保留现有文件')).toBeVisible();
    expect(within(reply).getByText(/确认后再导入/u)).toHaveStyle({ whiteSpace: 'pre-wrap' });
    expect(container.textContent).not.toContain('[Disco]');
    expect(container.textContent).not.toContain('"selected"');
    expect(container.textContent).not.toContain('&#x20;');
    fireEvent.mouseEnter(reply.parentElement!);
    fireEvent.click(reply.parentElement!.querySelector('.anticon-copy')!);
    expect(copy).toHaveBeenLastCalledWith(
      '问题：文件怎样处理？\n回答：保留现有文件\n\n问题：先执行哪些步骤？\n回答：预览\n确认后再导入\n保留中文和 emoji 🙂'
    );
    expect(task.full_prompt).toContain('不是对其他操作的授权');
    expect(message.content).toBe(task.full_prompt);
  });

  it('keeps subsequent user messages separate from the submitted answers', () => {
    renderTask(task, [
      message,
      { ...message, message_id: 'steering-1' as never, index: 1, content: '还有一个要求' },
    ]);
    expect(screen.getAllByRole('article', { name: '提问回复' })).toHaveLength(1);
    expect(screen.getByText('还有一个要求')).toBeInTheDocument();
  });

  it('does not hide protocol text pasted into an ordinary user task', () => {
    const { container } = renderTask({ ...task, metadata: { source: 'disco' } });
    expect(screen.queryByRole('article', { name: '提问回复' })).not.toBeInTheDocument();
    expect(container.textContent).toContain('[Disco]');
  });
});
