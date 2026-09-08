import type { SessionSearchMatch, SessionSearchResult } from '@disco/core/types';
import type { DiscoClient, Message, Session } from '@disco-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel';

const ARCHIVED = {
  session_id: 'session-archived',
  title: '北海道旧计划',
  agent_id: null,
  archived: true,
  archived_reason: 'manual',
  status: 'idle',
  agentic_tool: 'codex',
  created_by: 'user-1',
  created_at: '2026-07-01T00:00:00.000Z',
  last_updated: '2026-07-02T00:00:00.000Z',
} as Session;

const ARCHIVED_MATCH = {
  session_id: ARCHIVED.session_id,
  title: ARCHIVED.title,
  agent_id: null,
  archived: true,
  status: 'idle',
  ready_for_prompt: false,
  created_at: ARCHIVED.created_at,
  last_updated: ARCHIVED.last_updated,
  match_kind: 'title',
  snippet: '',
  match_count: 0,
} as SessionSearchMatch;

const MESSAGES = [
  {
    message_id: 'message-user',
    session_id: ARCHIVED.session_id,
    type: 'user',
    role: 'user',
    content: '帮我规划北海道路线',
    content_preview: '帮我规划北海道路线',
    index: 0,
    timestamp: '2026-07-01T00:00:00.000Z',
  },
  {
    message_id: 'message-assistant',
    session_id: ARCHIVED.session_id,
    type: 'assistant',
    role: 'assistant',
    content: '先从札幌开始。',
    content_preview: '先从札幌开始。',
    index: 1,
    timestamp: '2026-07-01T00:01:00.000Z',
  },
  {
    message_id: 'message-tool',
    session_id: ARCHIVED.session_id,
    type: 'tool',
    role: 'system',
    content: '内部工具输出不应展示',
    content_preview: '内部工具输出不应展示',
    index: 2,
    timestamp: '2026-07-01T00:02:00.000Z',
  },
] as Message[];

function createClient(result: Partial<SessionSearchResult> = {}) {
  const findArchives = vi.fn(async () => ({
    total: 1,
    limit: 20,
    offset: 0,
    data: [ARCHIVED_MATCH],
    ...result,
  }));
  const findMessages = vi.fn(async () => ({
    total: MESSAGES.length,
    limit: 120,
    skip: 0,
    data: MESSAGES,
  }));
  const getSession = vi.fn(async () => ARCHIVED);
  const unarchive = vi.fn(async () => ({}));
  const remove = vi.fn(async () => ({}));
  const client = {
    service: (path: string) => {
      if (path === 'session-search') return { find: findArchives };
      if (path === 'sessions') return { get: getSession, remove };
      if (path === 'messages') return { find: findMessages };
      if (path === `sessions/${ARCHIVED.session_id}/unarchive`) {
        return { create: unarchive };
      }
      throw new Error(`Unexpected service ${path}`);
    },
  } as unknown as DiscoClient;
  return { client, findArchives, findMessages, getSession, unarchive, remove };
}

describe('ArchivedSessionsPanel', () => {
  it('uses a paginated server query and opens the compact transcript only on demand', async () => {
    const { client, findArchives, findMessages } = createClient();
    render(
      <AntApp>
        <ArchivedSessionsPanel client={client} active />
      </AntApp>
    );

    await screen.findByText('北海道旧计划');
    expect(findArchives).toHaveBeenCalledWith({
      query: {
        scope: 'archived',
        kind: 'all',
        order: 'newest',
        limit: 20,
        offset: 0,
      },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(findMessages).not.toHaveBeenCalled();

    const archiveRow = document.querySelector<HTMLButtonElement>('.disco-archives-list-main');
    expect(archiveRow).not.toBeNull();
    fireEvent.click(archiveRow as HTMLButtonElement);
    const preview = await screen.findByRole('dialog');
    expect(await within(preview).findByText('帮我规划北海道路线')).toBeInTheDocument();
    expect(within(preview).getByText('先从札幌开始。')).toBeInTheDocument();
    expect(within(preview).queryByText('内部工具输出不应展示')).not.toBeInTheDocument();
    expect(within(preview).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('sends keyword and precise activity-time filters to the server', async () => {
    const { client, findArchives } = createClient();
    render(
      <AntApp>
        <ArchivedSessionsPanel client={client} active />
      </AntApp>
    );
    await screen.findByText('北海道旧计划');
    findArchives.mockClear();

    fireEvent.change(screen.getByRole('textbox', { name: '搜索已归档会话' }), {
      target: { value: '北海道' },
    });
    fireEvent.change(screen.getByLabelText('开始时间'), {
      target: { value: '2026-07-01T08:30' },
    });
    fireEvent.change(screen.getByLabelText('结束时间'), {
      target: { value: '2026-07-31T18:45' },
    });

    await waitFor(() =>
      expect(findArchives).toHaveBeenCalledWith({
        query: {
          scope: 'archived',
          kind: 'all',
          order: 'newest',
          limit: 20,
          offset: 0,
          q: '北海道',
          updated_after: new Date('2026-07-01T08:30').toISOString(),
          updated_before: new Date('2026-07-31T18:45').toISOString(),
        },
      })
    );
    expect(screen.getByText('北海道', { selector: 'strong' })).toBeInTheDocument();
  });

  it('opens a deep-linked archive even when it is outside the current result page', async () => {
    const { client, getSession } = createClient({ total: 0, data: [] });
    render(
      <AntApp>
        <ArchivedSessionsPanel client={client} active initialSessionId={ARCHIVED.session_id} />
      </AntApp>
    );

    const preview = await screen.findByRole('dialog');
    expect(getSession).toHaveBeenCalledWith(ARCHIVED.session_id);
    expect(within(preview).getByText('北海道旧计划')).toBeInTheDocument();
  });

  it('requires confirmation before permanently deleting an archive', async () => {
    const { client, remove } = createClient();
    render(
      <AntApp>
        <ArchivedSessionsPanel client={client} active />
      </AntApp>
    );

    await screen.findByText('北海道旧计划');
    fireEvent.click(screen.getByRole('button', { name: '删除存档 北海道旧计划' }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '永久删除' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(ARCHIVED.session_id));
  });
});
