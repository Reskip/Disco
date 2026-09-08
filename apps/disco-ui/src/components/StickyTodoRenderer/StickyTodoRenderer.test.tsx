import type { Message } from '@disco-live/client';
import { TaskStatus } from '@disco-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import { StickyTodoRenderer } from './StickyTodoRenderer';

describe('StickyTodoRenderer', () => {
  it('shows compact multi-step progress and expands the complete plan', () => {
    const messages = [
      {
        message_id: 'plan-message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: '定位问题', activeForm: '正在定位问题', status: 'completed' },
                { content: '修改活动流', activeForm: '正在修改活动流', status: 'in_progress' },
                { content: '部署验证', activeForm: '正在部署验证', status: 'pending' },
              ],
            },
          },
        ],
      },
    ] as unknown as Message[];

    render(
      <ConfigProvider>
        <StickyTodoRenderer messages={messages} taskStatus={TaskStatus.RUNNING} />
      </ConfigProvider>
    );

    const progress = screen.getByRole('button', { name: '查看任务计划' });
    expect(progress).toHaveTextContent('第 2/3 步');
    expect(progress).toHaveTextContent('修改活动流');

    fireEvent.click(progress);
    expect(screen.queryByText('执行步骤')).not.toBeInTheDocument();
    expect(screen.getByText('部署验证')).toBeInTheDocument();
  });

  it.each([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.STOPPED, TaskStatus.TIMED_OUT])(
    'removes the live plan as soon as the task settles (%s)',
    taskStatus => {
      const messages = [
        {
          message_id: 'stale-plan-message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'todo-stale',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: '第一步', status: 'completed' },
                  { content: '第二步', activeForm: '正在执行第二步', status: 'in_progress' },
                ],
              },
            },
          ],
        },
      ] as unknown as Message[];

      render(
        <ConfigProvider>
          <StickyTodoRenderer messages={messages} taskStatus={taskStatus} />
        </ConfigProvider>
      );

      expect(screen.queryByRole('button', { name: '查看任务计划' })).not.toBeInTheDocument();
    }
  );
});
