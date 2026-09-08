import type { DiscoClient } from '@disco-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSessionSearchModal } from './WorkspaceSessionSearchModal';

function createClient() {
  const find = vi.fn(async () => ({
    total: 2,
    limit: 60,
    offset: 0,
    data: [
      {
        session_id: 'session-live',
        title: '北海道旅行',
        agent_id: null,
        archived: false,
        status: 'idle',
        ready_for_prompt: true,
        created_at: '2026-08-01T00:00:00.000Z',
        last_updated: '2026-08-02T00:00:00.000Z',
        match_kind: 'message',
        snippet: '札幌到小樽的路线',
        match_count: 1,
      },
      {
        session_id: 'session-archived',
        title: '旧旅行计划',
        agent_id: 'agent-1',
        agent_name: '旅行规划师',
        archived: true,
        status: 'idle',
        ready_for_prompt: false,
        created_at: '2026-07-01T00:00:00.000Z',
        last_updated: '2026-07-02T00:00:00.000Z',
        match_kind: 'title',
        snippet: '旧旅行计划',
        match_count: 1,
      },
    ],
  }));
  return {
    client: { service: () => ({ find }) } as unknown as DiscoClient,
    find,
  };
}

describe('WorkspaceSessionSearchModal', () => {
  it('searches after two characters and routes live and archived results separately', async () => {
    const { client, find } = createClient();
    const onOpenSession = vi.fn();
    const onOpenArchivedSession = vi.fn();
    render(
      <AntApp>
        <WorkspaceSessionSearchModal
          open
          client={client}
          onClose={() => {}}
          onOpenSession={onOpenSession}
          onOpenArchivedSession={onOpenArchivedSession}
        />
      </AntApp>
    );

    fireEvent.change(screen.getByRole('textbox', { name: '搜索对话' }), {
      target: { value: '旅' },
    });
    await new Promise((resolve) => setTimeout(resolve, 280));
    expect(find).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: '搜索对话' }), {
      target: { value: '旅行' },
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    expect(find).toHaveBeenCalledWith({
      query: { q: '旅行', scope: 'all', limit: 60, offset: 0 },
    });

    await waitFor(() =>
      expect(document.querySelectorAll('.disco-session-search-result')).toHaveLength(2)
    );
    expect(screen.getAllByText('旅行', { selector: 'strong' })).toHaveLength(4);
    const options = document.querySelectorAll<HTMLButtonElement>('.disco-session-search-result');
    expect(options).toHaveLength(2);
    fireEvent.click(options[0]);
    expect(onOpenSession).toHaveBeenCalledWith('session-live');

    fireEvent.click(options[1]);
    expect(onOpenArchivedSession).toHaveBeenCalledWith('session-archived');
  });

  it('passes the selected scope to the backend service', async () => {
    const { client, find } = createClient();
    render(
      <AntApp>
        <WorkspaceSessionSearchModal
          open
          client={client}
          onClose={() => {}}
          onOpenSession={() => {}}
          onOpenArchivedSession={() => {}}
        />
      </AntApp>
    );

    fireEvent.click(screen.getByText('已归档', { selector: '.ant-segmented-item-label' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索对话' }), {
      target: { value: '旅行' },
    });

    await waitFor(() =>
      expect(find).toHaveBeenCalledWith({
        query: { q: '旅行', scope: 'archived', limit: 60, offset: 0 },
      })
    );
  });
});
