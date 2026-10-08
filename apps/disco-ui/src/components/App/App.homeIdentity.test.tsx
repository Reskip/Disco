import type { User } from '@disco-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../contexts/LocaleContext';
import { EMPTY_MAPS } from '../../store/discoMaps';
import { discoStore } from '../../store/discoStore';
import { App } from './App';

vi.mock('../HomePage/HomeTokenUsageCard', () => ({ HomeTokenUsageCard: () => null }));
vi.mock('../HomePage/useDailyHomeGreeting', () => ({
  useDailyHomeGreeting: (_userId: string, name: string) => [
    `${name}，今天从哪里开始？`,
    '聊聊你的想法。',
  ],
}));
vi.mock('../SessionPanel', () => ({ SessionPanel: () => null }));
const mediaState = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../hooks/useMediaQuery', async (original) => ({
  ...(await original<typeof import('../../hooks/useMediaQuery')>()),
  useMediaQuery: () => mediaState.mobile,
}));
vi.mock('../WorkspaceShell', async () => {
  const { WorkspaceSidebar } = await import('../WorkspaceShell/WorkspaceSidebar');
  return {
    WorkspaceSidebar,
    WorkspaceSettingsModal: ({ open }: { open: boolean }) =>
      open ? <div role="dialog" aria-label="测试设置" /> : null,
    WorkspaceSessionSearchModal: ({ open }: { open: boolean }) =>
      open ? <div role="dialog" aria-label="测试搜索" /> : null,
    WorkspaceAgentEditModal: () => null,
  };
});

const USER = { user_id: 'account-a', name: '星河', username: 'xinghe' } as User;

function workspace(user: User) {
  return (
    <MemoryRouter>
      <LocaleProvider>
        <AntApp>
          <App client={null} user={user} availableAgents={[]} workspaceLoading />
        </AntApp>
      </LocaleProvider>
    </MemoryRouter>
  );
}

describe('home and sidebar current-user identity', () => {
  beforeEach(() => {
    mediaState.mobile = false;
    discoStore.setState({ ...EMPTY_MAPS });
  });

  it('opens settings on mobile instead of hiding or discarding the action', () => {
    mediaState.mobile = true;
    const { container } = render(workspace(USER));
    fireEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="打开设置"]')!);
    expect(container.querySelector('[role="dialog"][aria-label="测试设置"]')).not.toBeNull();
  });

  it('opens conversation search on mobile', () => {
    mediaState.mobile = true;
    const { container } = render(workspace(USER));
    fireEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="搜索对话"]')!);
    expect(container.querySelector('[role="dialog"][aria-label="测试搜索"]')).not.toBeNull();
  });

  it('shows the authenticated name on the first render before the user directory arrives', () => {
    const { container } = render(workspace(USER));
    expect(container.querySelector('.disco-workspace-account-button')).toHaveTextContent('星河');
    expect(container.querySelector('.disco-home-intro h2')).toHaveTextContent(
      '星河，今天从哪里开始？'
    );

    act(() => discoStore.setState({ userById: new Map([[USER.user_id, USER]]) }));
    expect(container.querySelector('.disco-home-intro h2')).toHaveTextContent(
      '星河，今天从哪里开始？'
    );
  });

  it('uses the same username fallback as the sidebar when the display name is empty', () => {
    const { container } = render(workspace({ ...USER, name: '' }));
    expect(container.querySelector('.disco-workspace-account-button')).toHaveTextContent('xinghe');
    expect(container.querySelector('.disco-home-intro h2')).toHaveTextContent(
      'xinghe，今天从哪里开始？'
    );
  });

  it('updates both locations together when the current profile changes', () => {
    const { container, rerender } = render(workspace(USER));
    rerender(workspace({ ...USER, name: '山海 $& <hello>' }));
    expect(container.querySelector('.disco-workspace-account-button')).toHaveTextContent(
      '山海 $& <hello>'
    );
    expect(container.querySelector('.disco-home-intro h2')).toHaveTextContent(
      '山海 $& <hello>，今天从哪里开始？'
    );
    expect(screen.queryByText('星河，今天从哪里开始？')).not.toBeInTheDocument();
  });

  it('shows the new account immediately while an old account remains in the directory', () => {
    discoStore.setState({ userById: new Map([[USER.user_id, USER]]) });
    const { container, rerender } = render(workspace(USER));
    rerender(workspace({ ...USER, user_id: 'account-b', name: '山海', username: 'shanhai' }));
    expect(container.querySelector('.disco-workspace-account-button')).toHaveTextContent('山海');
    expect(container.querySelector('.disco-home-intro h2')).toHaveTextContent(
      '山海，今天从哪里开始？'
    );
    expect(screen.queryByText('星河，今天从哪里开始？')).not.toBeInTheDocument();
  });
});
