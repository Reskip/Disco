import type { Message, Task } from '@disco-live/client';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskBlock } from './TaskBlock';

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

const card = {
  ...message,
  message_id: 'card-1',
  type: 'widget_request',
  role: 'system',
  index: 1,
  content: rows.map((row) => row.question).join('\n'),
  metadata: {
    widget: {
      widget_id: 'widget-1',
      widget_type: 'questions',
      schema_version: 1,
      requested_at: '2026-09-15T00:00:00Z',
      status: 'submitted',
      params: {
        questions: rows.map((row, index) => ({ id: String(index), question: row.question })),
      },
      result_meta: {
        answers: Object.fromEntries(
          rows.map((row, index) => [
            String(index),
            {
              selected: row.selected,
              text: row.answer,
            },
          ])
        ),
      },
    },
  },
} as Message;

function renderTask(value: Task, taskMessages: Message[] = [message], questionWidgets?: Message[]) {
  return render(
    <TaskBlock
      task={value}
      isExpanded
      onExpandChange={vi.fn()}
      taskMessages={taskMessages}
      questionWidgets={questionWidgets}
      taskMessagesLoaded
      onLoadTaskMessages={vi.fn()}
      onUnloadTaskMessages={vi.fn()}
    />
  );
}

describe('question answers in the conversation', () => {
  it('shows the saved answer card once and keeps the model continuation out of user bubbles', () => {
    const { container } = renderTask(task, [message, card]);
    expect(screen.getAllByText('已回答')).toHaveLength(1);
    expect(screen.getAllByText('文件怎样处理？')).toHaveLength(1);
    expect(screen.getAllByText('保留现有文件')).toHaveLength(1);
    expect(
      within(screen.getByText('已回答').closest('.ant-card')!).getByText(/确认后再导入/u)
    ).toHaveStyle({ whiteSpace: 'pre-wrap' });
    expect(container.textContent).not.toContain('[Disco]');
    expect(container.textContent).not.toContain('"selected"');
    expect(container.textContent).not.toContain('&#x20;');
    expect(task.full_prompt).toContain('不是对其他操作的授权');
    expect(message.content).toBe(task.full_prompt);
  });

  it('keeps subsequent user messages separate from the submitted answers', () => {
    renderTask(task, [
      message,
      { ...message, message_id: 'steering-1' as never, index: 1, content: '还有一个要求' },
    ]);
    expect(screen.queryByRole('article', { name: '提问回复' })).not.toBeInTheDocument();
    expect(screen.getByText('还有一个要求')).toBeInTheDocument();
  });

  it('removes the legacy raw steering bubble without removing the card or assistant output', () => {
    const original = { ...task, full_prompt: '检查文件', metadata: { source: 'disco' } };
    const { container } = renderTask(original, [
      card,
      { ...message, index: 2, metadata: { source: 'disco', is_steering_hint: true } },
      {
        ...message,
        message_id: 'assistant-1' as never,
        index: 3,
        role: 'assistant',
        content: '收到，继续检查文件。',
      },
    ]);
    expect(screen.getAllByText('已回答')).toHaveLength(1);
    expect(screen.getByText('收到，继续检查文件。')).toBeInTheDocument();
    const cardElement = screen.getByText('已回答').closest('.ant-card')!;
    const continuation = screen.getByText('收到，继续检查文件。');
    expect(
      cardElement.compareDocumentPosition(continuation) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(container.textContent).not.toContain('[Disco]');
  });

  it('recognizes a continuation in the next task using its previous saved question card', () => {
    const next = { ...task, task_id: 'next-task' as never, metadata: { source: 'disco' } };
    const { container } = renderTask(next, [{ ...message, task_id: next.task_id }], [card]);
    expect(container.textContent).not.toContain('[Disco]');
    expect(container.textContent).not.toContain('"selected"');
  });

  it('does not hide protocol text pasted into an ordinary user task', () => {
    const { container } = renderTask({ ...task, metadata: { source: 'disco' } });
    expect(screen.queryByRole('article', { name: '提问回复' })).not.toBeInTheDocument();
    expect(container.textContent).toContain('[Disco]');
  });
});
