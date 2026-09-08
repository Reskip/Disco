import { CheckOutlined } from '@ant-design/icons';
import { type Message, TaskStatus } from '@disco-live/client';
import { Button, Popover, Spin } from 'antd';
import { useMemo } from 'react';
import {
  parseTodosInput,
  type RenderableTodoItem,
  type RenderableTodoStatus,
} from '../ToolUseRenderer/renderers/TodoListRenderer';

export interface TaskPlanViewModel {
  todos: RenderableTodoItem[];
  activeIndex: number;
  completedCount: number;
  complete: boolean;
}

interface StickyTodoRendererProps {
  messages: Message[];
  taskStatus: TaskStatus;
  plan?: TaskPlanViewModel | null;
}

function inProgressOverrideFor(taskStatus: TaskStatus): RenderableTodoStatus | null {
  switch (taskStatus) {
    case TaskStatus.STOPPED:
    case TaskStatus.STOPPING:
      return 'stopped';
    case TaskStatus.COMPLETED:
    case TaskStatus.FAILED:
    case TaskStatus.TIMED_OUT:
      return 'unknown';
    default:
      return null;
  }
}

export function buildTaskPlanViewModel(
  messages: Message[],
  taskStatus: TaskStatus
): TaskPlanViewModel | null {
  // The floating plan is live task chrome, not transcript content. Once the
  // owning task has settled it must disappear immediately — especially after
  // a user-requested stop — instead of leaving a stale "completed" plan above
  // the composer.
  if (
    taskStatus === TaskStatus.COMPLETED ||
    taskStatus === TaskStatus.FAILED ||
    taskStatus === TaskStatus.STOPPED ||
    taskStatus === TaskStatus.TIMED_OUT
  ) {
    return null;
  }
  let latestTodos: RenderableTodoItem[] | null = null;
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0 && !latestTodos;
    messageIndex -= 1
  ) {
    const content = messages[messageIndex]?.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex];
      if (block.type !== 'tool_use' || block.name !== 'TodoWrite') continue;
      const input = block.input as Record<string, unknown> | undefined;
      const parsed = parseTodosInput(input?.todos);
      if (parsed.length > 0) latestTodos = parsed;
      break;
    }
  }

  if (!latestTodos) return null;
  const override = inProgressOverrideFor(taskStatus);
  const todos: RenderableTodoItem[] = override
    ? latestTodos.map(todo =>
        todo.status === 'in_progress' ? { ...todo, status: override } : todo
      )
    : latestTodos;
  const completedCount = todos.filter(todo => todo.status === 'completed').length;
  const inProgressIndex = todos.findIndex(todo => todo.status === 'in_progress');
  const firstOpenIndex = todos.findIndex(todo => todo.status !== 'completed');
  const complete = completedCount === todos.length;
  const activeIndex =
    inProgressIndex >= 0 ? inProgressIndex : complete ? todos.length - 1 : firstOpenIndex;
  return { todos, activeIndex: Math.max(0, activeIndex), completedCount, complete };
}

function PlanList({ plan }: { plan: TaskPlanViewModel }) {
  return (
    <ol className="disco-task-plan-list" aria-label="任务计划">
      {plan.todos.map((todo, index) => {
        const current = index === plan.activeIndex && !plan.complete;
        return (
          <li
            key={`${todo.content}:${todo.activeForm ?? ''}`}
            className={`${todo.status === 'completed' ? 'is-complete' : ''}${
              current ? ' is-current' : ''
            }`}
          >
            <span className="disco-task-plan-list-status" aria-hidden>
              {todo.status === 'completed' ? (
                <CheckOutlined />
              ) : current ? (
                <Spin size="small" />
              ) : (
                <span className="disco-task-plan-list-ring" />
              )}
            </span>
            <span>{current && todo.activeForm ? todo.activeForm : todo.content}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function TaskPlanProgress({ plan }: { plan: TaskPlanViewModel | null }) {
  if (!plan) return null;
  const current = plan.todos[plan.activeIndex];
  const label = plan.complete
    ? `${plan.todos.length}/${plan.todos.length} 步已完成`
    : `第 ${plan.activeIndex + 1}/${plan.todos.length} 步`;

  return (
    <Popover
      trigger="click"
      placement="top"
      overlayClassName="disco-task-plan-popover"
      content={<PlanList plan={plan} />}
    >
      <Button type="text" className="disco-task-plan-progress" aria-label="查看任务计划">
        <span className="disco-task-plan-dot" aria-hidden />
        <strong>{label}</strong>
        <span className="disco-task-plan-current">
          {current
            ? !plan.complete && current.activeForm
              ? current.activeForm
              : current.content
            : ''}
        </span>
      </Button>
    </Popover>
  );
}

export function StickyTodoRenderer({ messages, taskStatus, plan }: StickyTodoRendererProps) {
  const derivedPlan = useMemo(
    () => plan ?? buildTaskPlanViewModel(messages, taskStatus),
    [messages, plan, taskStatus]
  );
  return <TaskPlanProgress plan={derivedPlan} />;
}
