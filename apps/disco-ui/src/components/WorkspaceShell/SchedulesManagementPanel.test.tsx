import type { Agent, DiscoClient, Schedule, User } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { SchedulesManagementPanel } from './SchedulesManagementPanel';

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    Button: ({
      children,
      icon,
      onClick,
      disabled,
      'aria-label': ariaLabel,
    }: {
      children?: React.ReactNode;
      icon?: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      'aria-label'?: string;
    }) => (
      <button type="button" aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
        {icon}
        {children}
      </button>
    ),
    Switch: ({
      checked,
      onChange,
      'aria-label': ariaLabel,
    }: {
      checked?: boolean;
      onChange?: (checked: boolean) => void;
      'aria-label'?: string;
    }) => (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        onClick={() => onChange?.(!checked)}
      />
    ),
  };
});

vi.mock('../ScheduleModal', () => ({
  ScheduleModal: ({ open, agents }: { open: boolean; agents: Agent[] }) =>
    open ? <div data-testid="schedule-modal">{agents.map((agent) => agent.display_name).join(',')}</div> : null,
}));

vi.mock('../ScheduleRunsPanel', () => ({
  ScheduleRunsPanel: () => null,
}));

const user = {
  user_id: '00000000-0000-7000-8000-000000000001',
  username: 'tester',
  name: 'Tester',
  role: 'member',
} as User;

const agent = {
  agent_id: '00000000-0000-7000-8000-000000000002',
  created_by: user.user_id,
  display_name: '研究员',
  description: null,
  emoji: '🔎',
  avatar_url: null,
  workspace_path: '/tmp/researcher',
  state: 'ready',
  error_message: null,
  archived: false,
  created_at: '2026-08-29T00:00:00.000Z',
  updated_at: '2026-08-29T00:00:00.000Z',
} as Agent;

function makeSchedule(overrides: Partial<Schedule>): Schedule {
  return {
    schedule_id: crypto.randomUUID(),
    agent_id: null,
    name: '独立日报',
    cron_expression: '0 9 * * *',
    timezone_mode: 'utc',
    prompt: '总结今天',
    agentic_tool_config: { agentic_tool: 'codex' },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 5,
    created_by: user.user_id,
    created_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z',
    ...overrides,
  } as Schedule;
}

function makeClient(schedules: Schedule[]) {
  const scheduleFind = vi.fn(async () => ({ data: schedules }));
  const schedulePatch = vi.fn(async (id: string, patch: Partial<Schedule>) => ({
    ...schedules.find((schedule) => schedule.schedule_id === id)!,
    ...patch,
  }));
  const services = {
    schedules: {
      find: scheduleFind,
      patch: schedulePatch,
      remove: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    agents: { find: vi.fn(async () => ({ data: [agent] })) },
    'mcp-servers': { find: vi.fn(async () => ({ data: [] })) },
  };
  const client = {
    service: (name: keyof typeof services) => services[name],
  } as unknown as DiscoClient;
  return { client, services, scheduleFind, schedulePatch };
}

function renderPanel(client: DiscoClient) {
  return render(
    <ConfigProvider wave={{ disabled: true }}>
      <SchedulesManagementPanel client={client} currentUser={user} />
    </ConfigProvider>
  );
}

describe('SchedulesManagementPanel', () => {
  it('loads user-owned schedules without a Branch query and labels direct targets', async () => {
    const standalone = makeSchedule({ name: '独立日报', agent_id: null });
    const targeted = makeSchedule({ name: '研究任务', agent_id: agent.agent_id });
    const { client, scheduleFind } = makeClient([standalone, targeted]);

    renderPanel(client);

    expect(await screen.findByText('独立日报')).toBeInTheDocument();
    expect(screen.getByText('研究任务')).toBeInTheDocument();
    expect(screen.getAllByText(/独立会话/)).not.toHaveLength(0);
    expect(screen.getByText(/研究员/)).toBeInTheDocument();
    expect(scheduleFind).toHaveBeenCalledWith({ query: { $sort: { created_at: -1 } } });
    expect(scheduleFind.mock.calls[0][0].query).not.toHaveProperty('branch_id');
  });

  it('toggles through the user-owned Schedule service and opens creation with Agents', async () => {
    const schedule = makeSchedule({ name: '独立日报', enabled: true });
    const { client, schedulePatch } = makeClient([schedule]);

    renderPanel(client);
    await screen.findByText('独立日报');

    fireEvent.click(screen.getByRole('switch', { name: '停用 独立日报' }));
    await waitFor(() =>
      expect(schedulePatch).toHaveBeenCalledWith(schedule.schedule_id, { enabled: false })
    );

    fireEvent.click(screen.getByRole('button', { name: /新建/ }));
    expect(screen.getByTestId('schedule-modal')).toHaveTextContent('研究员');
  });
});
