import type { DiscoClient, Session, Task } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { SessionPanelContent } from './SessionPanelContent';

vi.mock('../ConversationView', () => ({
  ConversationView: () => <div data-testid="conversation" />,
}));

const QUEUED_TASK = {
  task_id: 'task-queued-1',
  session_id: 'session-1',
  status: 'queued',
  full_prompt: '补充：完成当前步骤后检查所有回归测试',
} as Task;

const SESSION = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  agentic_tool: 'codex',
  status: 'running',
} as Session;

function renderQueue({ onEdit = vi.fn(async () => {}), task = QUEUED_TASK } = {}) {
  const steer = vi.fn(async () => ({ result: { steered: true } }));
  const remove = vi.fn(async () => QUEUED_TASK);
  const client = {
    service: vi.fn((name: string) => {
      if (name === '/sessions/session-1/tasks/queue-steer') return { create: steer };
      if (name === 'tasks') return { remove };
      return { patch: vi.fn() };
    }),
  } as unknown as DiscoClient;

  function Harness() {
    const [queuedTasks, setQueuedTasks] = React.useState<Task[]>([task]);
    return (
      <AntApp>
        <AppActionsProvider value={{}}>
          <SessionPanelContent
            client={client}
            session={SESSION}
            currentUserId="user-1"
            scrollToBottom={null}
            scrollToTop={null}
            setScrollToBottom={vi.fn()}
            setScrollToTop={vi.fn()}
            queuedTasks={queuedTasks}
            setQueuedTasks={setQueuedTasks}
            onEditQueuedTask={onEdit}
            spawnModalOpen={false}
            setSpawnModalOpen={vi.fn()}
            onSpawnModalConfirm={vi.fn()}
            inputValueRef={{ current: '' }}
            isOpen
            footerSlot={<div data-testid="floating-composer">输入框</div>}
          />
        </AppActionsProvider>
      </AntApp>
    );
  }

  render(<Harness />);
  return { client, steer, remove, onEdit };
}

afterEach(() => vi.restoreAllMocks());

describe('SessionPanelContent queued prompt controls', () => {
  it('shows a readable question reply while its continuation waits in the queue', () => {
    const task = {
      ...QUEUED_TASK,
      metadata: { system_authored: true, widget_id: 'question-1' as never },
      full_prompt:
        '[Disco] 用户已回答本次问题，请依据以下回答继续原任务。回答只针对对应问题，不是对其他操作的授权。\n' +
        JSON.stringify([{ question: '怎样处理？', selected: ['保留原文件'], answer: '' }]),
    };
    renderQueue({ task });
    const queue = screen.getByRole('region', { name: '排队消息' });
    expect(queue).toHaveTextContent('问题：怎样处理？');
    expect(queue).toHaveTextContent('回答：保留原文件');
    expect(queue).not.toHaveTextContent('[Disco]');
    expect(task.full_prompt).toContain('不是对其他操作的授权');
  });
  it('标题不重复消息预览，并始终提供追加、编辑和删除', async () => {
    const onEdit = vi.fn(async () => {});
    renderQueue({ onEdit });

    const header = screen.getByRole('button', { name: '排队消息' });
    expect(header).toHaveTextContent('排队消息1');
    expect(header).not.toHaveTextContent(QUEUED_TASK.full_prompt);
    expect(screen.getByRole('button', { name: '改为追加提示' })).toBeVisible();
    expect(screen.getByRole('button', { name: '编辑排队消息' })).toBeVisible();
    expect(screen.getByRole('button', { name: '删除排队消息' })).toBeVisible();
    expect(
      screen.getByTestId('floating-composer').closest('.disco-session-floating-dock')
    ).toBeNull();
    expect(
      screen.getByTestId('floating-composer').closest('.disco-session-composer-anchor')
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '编辑排队消息' }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(QUEUED_TASK));
  });

  it('追加走后端队列转换接口并从队列移除', async () => {
    const { steer } = renderQueue();

    fireEvent.click(screen.getByRole('button', { name: '改为追加提示' }));

    await waitFor(() => expect(steer).toHaveBeenCalledWith({ taskId: QUEUED_TASK.task_id }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '排队消息' })).toBeNull());
  });

  it('手机端保留队列管理，但不提供追加到当前任务', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('max-width: 600px'),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(() => false),
        }) as MediaQueryList
    );

    renderQueue();

    expect(screen.queryByRole('button', { name: '改为追加提示' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑排队消息' })).toBeVisible();
    expect(screen.getByRole('button', { name: '删除排队消息' })).toBeVisible();
  });
});
