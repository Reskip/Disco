import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { Agent } from '@disco-live/client';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../contexts/LocaleContext';
import { WorkspaceAgentEditModal } from './WorkspaceAgentEditModal';

describe('WorkspaceAgentEditModal', () => {
  const agent = {
    agent_id: 'agent-1',
    created_by: 'user-1',
    display_name: '测试智能体',
    description: '',
    emoji: '🤖',
    avatar_url: null,
    workspace_path: 'C:\\Disco\\users\\user-1\\agents\\agent-1',
    state: 'ready',
    error_message: null,
    archived: false,
    created_at: '2026-08-23T09:00:00.000Z',
    updated_at: '2026-08-23T09:00:00.000Z',
  } as Agent;

  it('closes from the modal close button', async () => {
    const onClose = vi.fn();
    const onDeleteAgent = vi.fn();
    const find = vi.fn().mockResolvedValue([]);
    const client = {
      service: vi.fn(() => ({ find })),
    } as any;
    render(
      <WorkspaceAgentEditModal
        open
        client={client}
        agent={agent}
        onDeleteAgent={onDeleteAgent}
        onClose={onClose}
      />
    );

    await waitFor(() => expect(find).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('requires typed confirmation and a final confirmation before deleting', async () => {
    const onClose = vi.fn();
    const onDeleteAgent = vi.fn().mockResolvedValue(undefined);
    const find = vi.fn().mockResolvedValue([]);
    const client = {
      service: vi.fn(() => ({ find })),
    } as any;
    render(
      <WorkspaceAgentEditModal
        open
        client={client}
        agent={agent}
        onDeleteAgent={onDeleteAgent}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: '删除智能体' }));
    const deleteButton = screen.getByRole('button', { name: /删除智能体/ });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('删除智能体 测试智能体'), {
      target: { value: '删除智能体 测试智能体' },
    });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);
    expect(onDeleteAgent).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: '永久删除' }));
    await waitFor(() =>
      expect(onDeleteAgent).toHaveBeenCalledWith('agent-1', '删除智能体 测试智能体')
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks basic and capability fields until the user explicitly starts editing', async () => {
    const profileEntry = {
      id: 'profile-1',
      agent_id: 'agent-1',
      kind: 'profile',
      name: '身份',
      relative_path: '.disco/IDENTITY.md',
      content: '# 身份\n\n- 名称：测试智能体',
      description: '智能体身份',
      enabled: true,
      removable: false,
    };
    const find = vi.fn().mockResolvedValue([profileEntry]);
    const patch = vi.fn().mockResolvedValue(profileEntry);
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'agent-capabilities') return { find, patch };
        if (name === 'agents') return { patch: vi.fn() };
        return { find };
      }),
    } as any;
    render(
      <AntApp>
        <LocaleProvider>
          <WorkspaceAgentEditModal
            open
            client={client}
            agent={agent}
            onDeleteAgent={vi.fn()}
            onClose={vi.fn()}
          />
        </LocaleProvider>
      </AntApp>
    );

    const nameInput = await screen.findByLabelText('智能体名称');
    expect(screen.getByRole('combobox', { name: '智能体设置页面' })).toBeInTheDocument();
    expect(nameInput).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '编辑基础资料' }));
    expect(nameInput).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消编辑基础资料' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '核心设定' }));
    const identityEditor = await screen.findByLabelText('身份内容');
    expect(screen.getByRole('button', { name: '返回列表' })).toBeInTheDocument();
    expect(identityEditor).toHaveAttribute('readonly');
    expect(screen.getByRole('switch', { name: '参与后续任务' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '编辑身份' }));
    expect(identityEditor).not.toHaveAttribute('readonly');
    expect(screen.getByRole('switch', { name: '参与后续任务' })).toBeEnabled();
  });

  it('shows only the selected Agent skill and supports disable plus confirmed uninstall', async () => {
    const skillEntry = {
      id: 'capability-skill-1',
      agent_id: 'agent-1',
      kind: 'skill',
      name: 'agent-private-helper',
      relative_path: 'skills/agent-private-helper/SKILL.md',
      content:
        '---\nname: agent-private-helper\ndescription: Agent private helper\n---\n\n# Helper\n',
      description: 'Agent private helper',
      enabled: true,
      editable: true,
      removable: true,
      updated_at: '2026-08-27T00:00:00.000Z',
      lifecycle: {
        id: 'skill-agent-1',
        name: 'Agent Private Helper',
        slug: 'agent-private-helper',
        description: 'Agent private helper',
        scope: 'agent',
        owner_user_id: 'user-1',
        agent_id: 'agent-1',
        source: 'agent-installed',
        source_session_id: 'session-1',
        relative_path: 'skills/agent-private-helper/SKILL.md',
        status: 'enabled',
        version: 1,
        fingerprint: 'a'.repeat(64),
        installed_at: '2026-08-27T00:00:00.000Z',
        updated_at: '2026-08-27T00:00:00.000Z',
        uninstalled_at: null,
      },
    };
    const find = vi.fn().mockResolvedValue([skillEntry]);
    const patch = vi.fn(async (_id: string, data: { enabled?: boolean; action?: string }) => ({
      ...skillEntry,
      enabled: data.action === 'uninstall' ? false : (data.enabled ?? skillEntry.enabled),
      lifecycle: {
        ...skillEntry.lifecycle,
        status:
          data.action === 'uninstall'
            ? 'uninstalled'
            : data.enabled === false
              ? 'disabled'
              : 'enabled',
      },
    }));
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'agent-capabilities') return { find, patch };
        if (name === 'agents') return { patch: vi.fn() };
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as any;

    render(
      <AntApp>
        <LocaleProvider>
          <WorkspaceAgentEditModal
            open
            client={client}
            agent={agent}
            onDeleteAgent={vi.fn()}
            onClose={vi.fn()}
          />
        </LocaleProvider>
      </AntApp>
    );

    fireEvent.click(screen.getByRole('tab', { name: '技能' }));
    expect(await screen.findByText('智能体技能')).toBeInTheDocument();
    expect(screen.getAllByText('agent-private-helper').length).toBeGreaterThan(0);
    expect(find).toHaveBeenCalledWith({ query: { agent_id: 'agent-1' } });

    fireEvent.click(screen.getByRole('switch', { name: '参与后续任务' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        'capability-skill-1',
        { enabled: false },
        { query: { agent_id: 'agent-1' } }
      )
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑agent-private-helper' }));
    fireEvent.click(screen.getByRole('button', { name: /卸载/ }));
    fireEvent.click(await screen.findByRole('button', { name: '继续卸载' }));
    const permanentUninstall = await screen.findByRole('button', { name: '永久卸载' });
    expect(permanentUninstall).toBeDisabled();
    fireEvent.change(screen.getByLabelText('输入智能体技能名称以确认卸载'), {
      target: { value: 'Agent Private Helper' },
    });
    expect(permanentUninstall).toBeEnabled();
    fireEvent.click(permanentUninstall);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        'capability-skill-1',
        { action: 'uninstall', confirmation: 'Agent Private Helper' },
        { query: { agent_id: 'agent-1' } }
      )
    );
  });
});
