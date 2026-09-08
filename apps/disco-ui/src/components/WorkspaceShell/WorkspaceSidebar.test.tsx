import type { Agent, Session, User } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/discoMaps';
import { discoStore } from '../../store/discoStore';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const USER = {
  user_id: 'user-1',
  name: '测试用户',
  email: 'user@example.test',
  avatar_url: 'https://cdn.example.test/user-1.png',
} as User;

const AGENT = {
  agent_id: 'agent-1',
  created_by: USER.user_id,
  display_name: '代码智能体',
  description: '维护代码工作区',
  emoji: '🤖',
  avatar_url: null,
  workspace_path: 'C:\\Disco\\users\\user-1\\agents\\agent-1',
  state: 'ready',
  error_message: null,
  archived: false,
  created_at: '2026-08-23T09:00:00.000Z',
  updated_at: '2026-08-23T09:00:00.000Z',
} as Agent;

function makeSession(
  sessionId: string,
  agentId: string | null,
  title: string,
  lastUpdated: string
): Session {
  return {
    session_id: sessionId,
    agent_id: agentId,
    title,
    status: 'idle',
    agentic_tool: 'codex',
    created_by: USER.user_id,
    created_at: lastUpdated,
    last_updated: lastUpdated,
  } as Session;
}

const STANDALONE_SESSION = makeSession(
  'session-standalone',
  null,
  '独立测试对话',
  '2026-08-23T10:00:00.000Z'
);
const AGENT_SESSION = makeSession(
  'session-agent',
  AGENT.agent_id,
  '与智能体的对话',
  '2026-08-23T11:00:00.000Z'
);
const ARCHIVED_SESSION = {
  ...makeSession('session-archived', null, '已经归档的对话', '2026-08-22T10:00:00.000Z'),
  archived: true,
} as Session;

function seedStore() {
  discoStore.setState({
    ...EMPTY_MAPS,
    sessionById: new Map([
      [STANDALONE_SESSION.session_id, STANDALONE_SESSION],
      [AGENT_SESSION.session_id, AGENT_SESSION],
      [ARCHIVED_SESSION.session_id, ARCHIVED_SESSION],
    ]),
  });
}

function renderSidebar(
  loading = false,
  mobile = false,
  selectedSessionId: string | null = STANDALONE_SESSION.session_id
) {
  const callbacks = {
    onSelectSession: vi.fn(),
    onNewStandalone: vi.fn(),
    onTalkToAgent: vi.fn(),
    onRenameSession: vi.fn(async () => {}),
    onDeleteSession: vi.fn(async () => {}),
    onArchiveSession: vi.fn(async () => {}),
    onEditAgent: vi.fn(),
    onOpenSettings: vi.fn(),
    onGoHome: vi.fn(),
    onLogout: vi.fn(),
  };
  render(
    <AntApp>
      <WorkspaceSidebar
        currentUser={USER}
        agents={loading ? [] : [AGENT]}
        selectedSessionId={selectedSessionId}
        loading={loading}
        mobile={mobile}
        connected
        {...callbacks}
      />
    </AntApp>
  );
  return callbacks;
}

describe('WorkspaceSidebar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedStore();
  });

  it('只展示独立对话和智能体两层结构，隐藏项目和分支实现细节', () => {
    renderSidebar();

    expect(screen.getByText('独立对话', { selector: '.ant-typography' })).toBeInTheDocument();
    expect(screen.getByText('智能体', { selector: '.ant-typography' })).toBeInTheDocument();
    expect(screen.getByText('独立测试对话')).toBeInTheDocument();
    expect(screen.getByText('代码智能体')).toBeInTheDocument();
    expect(screen.getByText('与智能体的对话')).toBeInTheDocument();
    expect(screen.queryByText('已经归档的对话')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/repository|branch/i);
    expect(document.body.textContent).not.toMatch(/队友|teammate/i);
  });

  it('将独立对话、智能体对话和新建操作分别路由', () => {
    const callbacks = renderSidebar();

    fireEvent.click(screen.getByText('独立测试对话'));
    expect(callbacks.onSelectSession).toHaveBeenCalledWith(STANDALONE_SESSION.session_id);

    fireEvent.click(screen.getByRole('button', { name: '与 代码智能体 开始新对话' }));
    expect(callbacks.onTalkToAgent).toHaveBeenCalledWith(AGENT.agent_id);

    fireEvent.click(screen.getByRole('button', { name: '新建独立对话' }));
    expect(callbacks.onNewStandalone).toHaveBeenCalledTimes(1);
  });

  it('点击 Disco 标识返回主页', () => {
    const callbacks = renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: '返回主页' }));
    expect(callbacks.onGoHome).toHaveBeenCalledTimes(1);
  });

  it('加载期间显示明确状态，并使用用户上传的头像', () => {
    discoStore.setState({ ...EMPTY_MAPS });
    renderSidebar(true);

    expect(screen.getByText('正在加载对话列表…')).toBeInTheDocument();
    expect(screen.getByText('正在加载智能体…')).toBeInTheDocument();
    expect(screen.queryByText('暂无独立对话')).not.toBeInTheDocument();
    expect(screen.queryByText('暂无智能体')).not.toBeInTheDocument();
    expect(document.querySelector('.disco-workspace-account img')).toHaveAttribute(
      'src',
      USER.avatar_url
    );
  });

  it('从三点菜单在原标题位置直接重命名，不打开弹窗', async () => {
    const callbacks = renderSidebar();

    fireEvent.click(screen.getAllByRole('button', { name: '对话操作' })[0]);
    fireEvent.click(await screen.findByText('重命名'));

    const input = screen.getByRole('textbox', { name: '编辑对话标题' });
    expect(input).toHaveValue('独立测试对话');
    expect(screen.queryByRole('dialog', { name: '重命名对话' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '新的独立对话标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(callbacks.onRenameSession).toHaveBeenCalledWith(
      STANDALONE_SESSION.session_id,
      '新的独立对话标题'
    );
  });

  it('从对话菜单归档，并把归档作为独立操作交给应用层', async () => {
    const callbacks = renderSidebar();

    fireEvent.click(screen.getAllByRole('button', { name: '对话操作' })[0]);
    fireEvent.click(await screen.findByText('归档'));

    expect(callbacks.onArchiveSession).toHaveBeenCalledWith(STANDALONE_SESSION.session_id);
    expect(callbacks.onDeleteSession).not.toHaveBeenCalled();
  });

  it('从智能体三点菜单进入编辑智能体', async () => {
    const callbacks = renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: '代码智能体 的操作' }));
    fireEvent.click(await screen.findByText('编辑智能体'));

    expect(callbacks.onEditAgent).toHaveBeenCalledWith(AGENT.agent_id);
    expect(screen.queryByText('删除智能体')).not.toBeInTheDocument();
  });

  it('只在右侧展示运行中与未读完成状态，不再展示左侧灰绿圆点', () => {
    discoStore.setState({
      sessionById: new Map([
        [STANDALONE_SESSION.session_id, { ...STANDALONE_SESSION, status: 'running' } as Session],
        [
          AGENT_SESSION.session_id,
          { ...AGENT_SESSION, status: 'idle', ready_for_prompt: true } as Session,
        ],
      ]),
    });

    renderSidebar();

    expect(screen.getByLabelText('任务运行中')).toBeInTheDocument();
    expect(screen.getByLabelText('有未读完成结果')).toBeInTheDocument();
    expect(document.querySelector('.disco-workspace-session-dot')).not.toBeInTheDocument();
  });

  it('手机端只保留基础会话入口，隐藏搜索、设置、编辑和对话管理', async () => {
    const callbacks = renderSidebar(false, true);

    expect(screen.getByRole('button', { name: '新建独立对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '与 代码智能体 开始新对话' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '搜索对话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '代码智能体 的操作' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '对话操作' })).not.toBeInTheDocument();

    expect(screen.queryByText('测试用户')).not.toBeInTheDocument();
    const accountButton = screen.getByRole('button', { name: '打开账号菜单' });
    expect(accountButton).toHaveClass('is-mobile');
    fireEvent.click(accountButton);
    expect(await screen.findByRole('menuitem', { name: /退出登录/ })).toBeInTheDocument();
    expect(document.querySelector('.disco-workspace-mobile-account-menu')).not.toBeNull();
    expect(screen.queryByText('设置')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /退出登录/ }));
    expect(callbacks.onLogout).toHaveBeenCalledTimes(1);
  });

  it('每组默认展示最近五段，并允许展开剩余对话', () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      makeSession(
        `session-${index}`,
        null,
        `历史对话 ${index + 1}`,
        `2026-08-${String(23 - index).padStart(2, '0')}T10:00:00.000Z`
      )
    );
    discoStore.setState({
      ...EMPTY_MAPS,
      sessionById: new Map(sessions.map((session) => [session.session_id, session])),
    });

    renderSidebar();

    expect(screen.getByText('历史对话 1')).toBeInTheDocument();
    expect(screen.getByText('历史对话 5')).toBeInTheDocument();
    expect(screen.queryByText('历史对话 6')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '显示其余 2 段对话' }));
    expect(screen.getByText('历史对话 6')).toBeInTheDocument();
    expect(screen.getByText('历史对话 7')).toBeInTheDocument();
  });

  it('按账号恢复折叠状态，并在用户展开后持久化新状态', async () => {
    window.localStorage.setItem(
      `disco:workspace-sidebar:${USER.user_id}`,
      JSON.stringify({
        collapsedStandalone: true,
        collapsedAgents: [AGENT.agent_id],
      })
    );

    renderSidebar(false, false, null);

    const sectionToggles = document.querySelectorAll<HTMLButtonElement>(
      '.disco-workspace-section-toggle'
    );
    const standaloneToggle = sectionToggles[0];
    const agentToggle = document.querySelector<HTMLButtonElement>('.disco-workspace-agent-toggle');
    expect(agentToggle).not.toBeNull();
    await waitFor(() => expect(standaloneToggle).toHaveAttribute('aria-expanded', 'false'));
    expect(agentToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('独立测试对话')).not.toBeInTheDocument();
    expect(screen.queryByText('与智能体的对话')).not.toBeInTheDocument();

    fireEvent.click(standaloneToggle);
    expect(screen.getByText('独立测试对话')).toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(`disco:workspace-sidebar:${USER.user_id}`) || '{}'
      );
      expect(stored.collapsedStandalone).toBe(false);
      expect(stored.collapsedAgents).toContain(AGENT.agent_id);
    });
  });

  it('即使已保存为折叠，当前选中的会话所在层级仍保持展开', async () => {
    window.localStorage.setItem(
      `disco:workspace-sidebar:${USER.user_id}`,
      JSON.stringify({
        collapsedAgentsSection: true,
        collapsedAgents: [AGENT.agent_id],
      })
    );

    renderSidebar(false, false, AGENT_SESSION.session_id);

    await waitFor(() => {
      const sectionToggles = document.querySelectorAll<HTMLButtonElement>(
        '.disco-workspace-section-toggle'
      );
      expect(sectionToggles[1]).toHaveAttribute('aria-expanded', 'true');
    });
    expect(document.querySelector('.disco-workspace-agent-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('与智能体的对话')).toBeInTheDocument();
  });
});
