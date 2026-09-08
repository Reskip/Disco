import type { DiscoClient, User } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../contexts/LocaleContext';
import { WorkspaceSettingsModal } from './WorkspaceSettingsModal';

vi.mock('../ModelSelector', () => ({
  ModelSelector: ({ value }: { value?: { model?: string } }) => (
    <div data-testid="default-model-value">{value?.model}</div>
  ),
}));

vi.mock('../EffortSelector', () => ({
  EffortSelector: ({ value }: { value?: string }) => (
    <div data-testid="default-effort-value">{value}</div>
  ),
}));

const ADMIN = {
  user_id: 'admin-1',
  name: '管理员',
  username: 'familyadmin',
  role: 'admin',
  default_agentic_config: {
    codex: {
      modelConfig: {
        mode: 'alias',
        model: 'gpt-5.6-sol',
      },
    },
  },
} as unknown as User;

describe('WorkspaceSettingsModal', () => {
  it('从账号目录补全认证上下文缺失的登录账号，并提供头像上传入口', async () => {
    const sparseCurrentUser = { ...ADMIN, username: undefined } as unknown as User;
    render(
      <AntApp>
        <LocaleProvider>
          <WorkspaceSettingsModal
            open
            currentUser={sparseCurrentUser}
            users={[ADMIN]}
            onClose={() => {}}
            onUpdateUser={vi.fn(async () => {})}
          />
        </LocaleProvider>
      </AntApp>
    );

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '登录账号' })).toHaveValue('familyadmin')
    );
    expect(screen.getByRole('textbox', { name: '登录账号' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /上传图片/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '编辑个人资料' }));
    expect(screen.getByRole('textbox', { name: '登录账号' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /上传图片/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '取消编辑个人资料' }));
    expect(screen.getByRole('textbox', { name: '登录账号' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /上传图片/ })).toBeDisabled();
  });

  it('按常用功能分栏，并为未配置账号显式选中倒数第二高思考深度', async () => {
    const onUpdateUser = vi.fn(async () => {});
    render(
      <AntApp>
        <LocaleProvider>
          <WorkspaceSettingsModal
            open
            currentUser={ADMIN}
            users={[ADMIN]}
            onClose={() => {}}
            onUpdateUser={onUpdateUser}
          />
        </LocaleProvider>
      </AntApp>
    );

    expect(screen.getByRole('tab', { name: /个人资料/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /模型与思考/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /界面/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /账号与安全/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Codex 连接/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /家庭账号/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '设置页面' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /模型与思考/ }));
    await waitFor(() =>
      expect(screen.getByTestId('default-model-value')).toHaveTextContent('gpt-5.6-sol')
    );
    expect(screen.getByTestId('default-effort-value')).toHaveTextContent('xhigh');
    expect(screen.getByText('默认响应模式')).toBeInTheDocument();
    expect(
      screen.getByText('这些默认值用于新对话；桌面端可在会话输入框旁单独调整。')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /账号与安全/ }));
    expect(screen.getByLabelText('新密码')).toBeDisabled();
    expect(screen.queryByText('共享 Codex 连接')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑登录密码' }));
    expect(screen.getByLabelText('新密码')).toBeEnabled();

    fireEvent.click(screen.getByRole('tab', { name: /Codex 连接/ }));
    expect(await screen.findByText('共享 Codex 连接')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设备码登录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入 auth.json' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/队友|teammate/i);
  });

  it('更新密码成功后立即退出当前登录并关闭设置', async () => {
    const onUpdateUser = vi.fn(async () => {});
    const onLogout = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <AntApp>
        <LocaleProvider>
          <WorkspaceSettingsModal
            open
            currentUser={ADMIN}
            users={[ADMIN]}
            onClose={onClose}
            onLogout={onLogout}
            onUpdateUser={onUpdateUser}
          />
        </LocaleProvider>
      </AntApp>
    );

    fireEvent.click(screen.getByRole('tab', { name: /账号与安全/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑登录密码' }));
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password-123' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), {
      target: { value: 'new-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '更新密码' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认更新' }));

    await waitFor(() =>
      expect(onUpdateUser).toHaveBeenCalledWith('admin-1', { password: 'new-password-123' })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('展示两种来源的技能，并允许管理员启停可用技能', async () => {
    const patch = vi.fn(async (id: string, data: { enabled?: boolean; action?: string }) => ({
      id,
      name: 'documents',
      description: '创建和编辑文档',
      source: 'codex-sync' as const,
      source_detail: 'Codex 内置',
      available: true,
      enabled: data.enabled ?? false,
    }));
    const client = {
      service: (path: string) => {
        if (path === 'codex-skills') {
          return {
            find: async () => [
              {
                id: 'skill_documents',
                name: 'documents',
                description: '创建和编辑文档',
                source: 'codex-sync',
                source_detail: 'Codex 内置',
                available: true,
                enabled: true,
                lifecycle: {
                  id: 'skill_local',
                  name: '家庭助手',
                  slug: 'family-helper',
                  description: 'Disco 本地技能',
                  scope: 'shared',
                  owner_user_id: 'admin-1',
                  agent_id: null,
                  source: 'disco-shared',
                  source_session_id: 'session-1',
                  relative_path: 'family-helper/SKILL.md',
                  status: 'enabled',
                  version: 1,
                  fingerprint: 'a'.repeat(64),
                  installed_at: '2026-08-27T00:00:00.000Z',
                  updated_at: '2026-08-27T00:00:00.000Z',
                  uninstalled_at: null,
                },
              },
              {
                id: 'skill_local',
                name: '家庭助手',
                description: 'Disco 本地技能',
                source: 'disco-local',
                source_detail: 'Disco 本地安装',
                available: true,
                enabled: true,
              },
              {
                id: 'skill_browser',
                name: 'browser',
                description: '浏览器控制',
                source: 'codex-sync',
                source_detail: 'Codex 插件 · browser',
                available: false,
                unavailable_reason: '服务端不可用',
                enabled: false,
              },
              {
                id: 'skill_agent_only',
                name: 'agent-private-helper',
                description: '只属于指定智能体',
                source: 'agent-generated',
                source_detail: 'Agent 专属',
                available: true,
                enabled: true,
                lifecycle: {
                  id: 'skill_agent_only',
                  name: 'agent-private-helper',
                  slug: 'agent-private-helper',
                  description: '只属于指定智能体',
                  scope: 'agent',
                  owner_user_id: 'admin-1',
                  agent_id: 'agent-1',
                  source: 'agent-generated',
                  source_session_id: 'session-agent',
                  relative_path: 'skills/agent-private-helper/SKILL.md',
                  status: 'enabled',
                  version: 1,
                  fingerprint: 'c'.repeat(64),
                  installed_at: '2026-08-27T00:00:00.000Z',
                  updated_at: '2026-08-27T00:00:00.000Z',
                  uninstalled_at: null,
                },
              },
            ],
            patch,
          };
        }
        if (path === 'users') return { get: async () => ADMIN };
        if (path === 'branches') return { find: async () => [] };
        throw new Error(`Unexpected service: ${path}`);
      },
    } as unknown as DiscoClient;

    render(
      <AntApp>
        <LocaleProvider>
          <WorkspaceSettingsModal
            open
            currentUser={ADMIN}
            users={[ADMIN]}
            client={client}
            onClose={() => {}}
            onUpdateUser={vi.fn(async () => {})}
          />
        </LocaleProvider>
      </AntApp>
    );

    fireEvent.click(screen.getByRole('tab', { name: /技能管理/ }));
    expect(await screen.findByText('家庭助手')).toBeInTheDocument();
    expect(screen.getAllByText('Codex 官方同步').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Disco 本地').length).toBeGreaterThan(0);
    expect(screen.queryByText('agent-private-helper')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '启用 browser' })).toBeDisabled();

    const documentsRow = screen
      .getAllByText('documents')
      .find((element) => element.tagName.toLowerCase() === 'strong')
      ?.closest('button');
    expect(documentsRow).not.toBeNull();
    fireEvent.click(documentsRow as HTMLButtonElement);
    expect(document.querySelector('.disco-skill-manager-shell')).toHaveClass('is-mobile-detail');
    fireEvent.click(screen.getByLabelText('返回技能列表'));
    expect(document.querySelector('.disco-skill-manager-shell')).toHaveClass('is-mobile-list');

    fireEvent.click(screen.getByRole('switch', { name: '启用 documents' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('skill_documents', { enabled: false }));
  });

  it('从后端真实注册目录只读展示运行能力，不维护第二份方法清单', async () => {
    const findRuntimeCapabilities = vi.fn(async () => ({
      schemaVersion: 1 as const,
      fingerprint: 'b'.repeat(64),
      entries: [
        {
          id: 'codex-native:image-generation',
          name: 'imageGeneration',
          provider: 'codex-native' as const,
          kind: 'event' as const,
          exposure: 'runtime-event' as const,
          description: 'Receive generated image events from Codex.',
          audiences: ['agent', 'standalone'] as const,
          ownership: 'current-session' as const,
          outputKinds: ['image'] as const,
          lifecycle: 'fixed' as const,
          dependencies: ['codex-app-server'],
        },
        {
          id: 'disco-mcp:disco_files_publish',
          name: 'disco_files_publish',
          provider: 'disco-mcp' as const,
          kind: 'method' as const,
          exposure: 'agent-callable' as const,
          description: 'Publish selected files to the current conversation.',
          audiences: ['agent', 'standalone'] as const,
          ownership: 'current-session' as const,
          outputKinds: ['file', 'image'] as const,
          lifecycle: 'managed' as const,
          dependencies: ['database', 'file-storage'],
          inputSchema: { type: 'object' },
        },
      ],
    }));
    const client = {
      service: (path: string) => {
        if (path === 'runtime-capabilities') return { find: findRuntimeCapabilities };
        if (path === 'users') return { get: async () => ADMIN };
        throw new Error(`Unexpected service: ${path}`);
      },
    } as unknown as DiscoClient;

    render(
      <AntApp>
        <LocaleProvider>
          <WorkspaceSettingsModal
            open
            currentUser={ADMIN}
            users={[ADMIN]}
            client={client}
            onClose={() => {}}
            onUpdateUser={vi.fn(async () => {})}
          />
        </LocaleProvider>
      </AntApp>
    );

    fireEvent.click(screen.getByRole('tab', { name: /能力目录/ }));

    expect(await screen.findByText('disco_files_publish')).toBeInTheDocument();
    expect(screen.getByText('imageGeneration')).toBeInTheDocument();
    expect(screen.getByText('bbbbbbbbbbbb')).toBeInTheDocument();
    expect(findRuntimeCapabilities).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('disco_upload_materialize')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
