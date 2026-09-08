import { AgentRepository, generateId, MessagesRepository, SessionRepository } from '@disco/core/db';
import type { AuthenticatedParams, Message, Session, UUID } from '@disco/core/types';
import { MessageRole, ROLES } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { extractSessionSearchMessage, SessionSearchService } from './session-search';

function params(userId: UUID, query: Record<string, unknown>): AuthenticatedParams {
  return {
    provider: 'rest',
    query,
    user: {
      user_id: userId,
      email: `${userId}@example.test`,
      role: ROLES.ADMIN,
    },
  } as AuthenticatedParams;
}

async function createSession(
  db: Parameters<typeof dbTest>[0]['db'],
  owner: UUID,
  data: Partial<Session> = {}
): Promise<Session> {
  return new SessionRepository(db).create({
    created_by: owner,
    working_directory: `C:\\Disco\\users\\${owner}\\sessions\\${generateId()}`,
    ...data,
  });
}

async function createMessage(
  db: Parameters<typeof dbTest>[0]['db'],
  session: Session,
  index: number,
  content: Message['content'],
  overrides: Partial<Pick<Message, 'role' | 'type' | 'content_preview'>> = {}
): Promise<void> {
  await new MessagesRepository(db).create({
    message_id: generateId(),
    session_id: session.session_id,
    type: 'user',
    role: MessageRole.USER,
    index,
    timestamp: new Date(1_780_000_000_000 + index * 1000).toISOString(),
    content_preview: typeof content === 'string' ? content.slice(0, 120) : '',
    content,
    ...overrides,
  });
}

describe('SessionSearchService', () => {
  dbTest('searches titles, human messages, attachments, and agent names', async ({ db }) => {
    const owner = generateId() as UUID;
    const agent = await new AgentRepository(db).create({
      createdBy: owner,
      displayName: '旅行规划师',
      workspacePath: `C:\\Disco\\users\\${owner}\\agents\\travel`,
      state: 'ready',
    });
    const titled = await createSession(db, owner, { title: '北海道行程复盘' });
    const messaged = await createSession(db, owner, { title: '普通对话' });
    const attached = await createSession(db, owner, { title: '资料整理' });
    const agentSession = await createSession(db, owner, {
      title: '第一次会话',
      agent_id: agent.agent_id,
    });
    await createMessage(db, messaged, 0, '请帮我安排札幌到小樽的路线');
    await createMessage(db, attached, 0, [
      {
        type: 'file_citation',
        filename: '烟台蓬莱行程.pdf',
        purpose: 'source',
        available: true,
      },
    ] as Message['content']);

    const service = new SessionSearchService(db);

    await expect(service.find(params(owner, { q: '北海道' }))).resolves.toMatchObject({
      data: [expect.objectContaining({ session_id: titled.session_id, match_kind: 'title' })],
    });
    await expect(service.find(params(owner, { q: '札幌 小樽' }))).resolves.toMatchObject({
      data: [expect.objectContaining({ session_id: messaged.session_id, match_kind: 'message' })],
    });
    await expect(service.find(params(owner, { q: '蓬莱行程' }))).resolves.toMatchObject({
      data: [
        expect.objectContaining({ session_id: attached.session_id, match_kind: 'attachment' }),
      ],
    });
    await expect(service.find(params(owner, { q: '旅行规划师' }))).resolves.toMatchObject({
      data: [expect.objectContaining({ session_id: agentSession.session_id, match_kind: 'agent' })],
    });
  });

  dbTest('never returns another user history, even to an admin-shaped caller', async ({ db }) => {
    const owner = generateId() as UUID;
    const otherUser = generateId() as UUID;
    const own = await createSession(db, owner, { title: '我的预算计划' });
    const other = await createSession(db, otherUser, { title: '别人的预算计划' });
    await createMessage(db, other, 0, '只有另一个用户才知道的预算秘密');

    const result = await new SessionSearchService(db).find(params(owner, { q: '预算' }));

    expect(result.data.map((item) => item.session_id)).toEqual([own.session_id]);
    expect(result.data).not.toContainEqual(
      expect.objectContaining({ session_id: other.session_id })
    );
  });

  dbTest('filters archived scope and ignores tool-only payload text', async ({ db }) => {
    const owner = generateId() as UUID;
    const live = await createSession(db, owner, { title: '合同讨论' });
    const archived = await createSession(db, owner, {
      title: '历史合同讨论',
      archived: true,
      archived_reason: 'manual',
    });
    await createMessage(db, live, 0, '正常用户正文');
    await createMessage(db, live, 1, '不应被检索的工具秘密', {
      type: 'tool',
      role: MessageRole.SYSTEM,
    });

    const service = new SessionSearchService(db);
    const archivedOnly = await service.find(params(owner, { q: '合同', scope: 'archived' }));
    const toolOnly = await service.find(params(owner, { q: '工具秘密' }));

    expect(archivedOnly.data.map((item) => item.session_id)).toEqual([archived.session_id]);
    expect(toolOnly.data).toEqual([]);
  });

  dbTest(
    'pages archived sessions by kind, activity time, and requested order without a keyword',
    async ({ db }) => {
      const owner = generateId() as UUID;
      const agent = await new AgentRepository(db).create({
        createdBy: owner,
        displayName: '资料助手',
        workspacePath: `C:\\Disco\\users\\${owner}\\agents\\archive`,
        state: 'ready',
      });
      const oldest = await createSession(db, owner, {
        title: '一月存档',
        archived: true,
        archived_reason: 'manual',
        last_updated: '2026-01-10T08:00:00.000Z',
      });
      const newest = await createSession(db, owner, {
        title: '二月存档',
        archived: true,
        archived_reason: 'manual',
        last_updated: '2026-02-10T08:00:00.000Z',
      });
      await createSession(db, owner, {
        title: '智能体存档',
        agent_id: agent.agent_id,
        archived: true,
        archived_reason: 'manual',
        last_updated: '2026-02-15T08:00:00.000Z',
      });
      await createSession(db, owner, { title: '未归档对话' });

      const service = new SessionSearchService(db);
      const firstPage = await service.find(
        params(owner, {
          scope: 'archived',
          kind: 'standalone',
          order: 'oldest',
          updated_after: '2026-01-01T00:00:00.000Z',
          updated_before: '2026-02-28T23:59:59.999Z',
          limit: 1,
          offset: 0,
        })
      );
      const secondPage = await service.find(
        params(owner, {
          scope: 'archived',
          kind: 'standalone',
          order: 'oldest',
          updated_after: '2026-01-01T00:00:00.000Z',
          updated_before: '2026-02-28T23:59:59.999Z',
          limit: 1,
          offset: 1,
        })
      );

      expect(firstPage).toMatchObject({
        total: 2,
        limit: 1,
        offset: 0,
        data: [expect.objectContaining({ session_id: oldest.session_id, match_count: 0 })],
      });
      expect(secondPage.data).toEqual([
        expect.objectContaining({ session_id: newest.session_id, agent_id: null }),
      ]);
    }
  );

  dbTest(
    'allows a single-character keyword only inside archived-session search',
    async ({ db }) => {
      const owner = generateId() as UUID;
      const archived = await createSession(db, owner, {
        title: '旧账',
        archived: true,
        archived_reason: 'manual',
      });
      const service = new SessionSearchService(db);

      await expect(
        service.find(params(owner, { q: '账', scope: 'archived' }))
      ).resolves.toMatchObject({
        data: [expect.objectContaining({ session_id: archived.session_id })],
      });
      await expect(service.find(params(owner, { q: '账' }))).rejects.toThrow(
        'at least 2 characters'
      );
    }
  );

  dbTest('rejects inverted archive time ranges', async ({ db }) => {
    const owner = generateId() as UUID;
    await expect(
      new SessionSearchService(db).find(
        params(owner, {
          scope: 'archived',
          updated_after: '2026-03-01T00:00:00.000Z',
          updated_before: '2026-02-01T00:00:00.000Z',
        })
      )
    ).rejects.toThrow('must not be later');
  });

  dbTest('rejects undersized queries before touching history', async ({ db }) => {
    const owner = generateId() as UUID;
    await expect(new SessionSearchService(db).find(params(owner, { q: 'a' }))).rejects.toThrow(
      'at least 2 characters'
    );
  });
});

describe('extractSessionSearchMessage', () => {
  it('keeps human text while excluding tool input', () => {
    expect(
      extractSessionSearchMessage([
        { type: 'text', text: '可检索正文' },
        { type: 'tool_use', name: 'powershell', input: { command: '机密脚本' } },
      ])
    ).toEqual({ text: '可检索正文', attachmentText: '' });
  });

  it('indexes visualization titles without requiring protocol text', () => {
    expect(
      extractSessionSearchMessage([
        {
          type: 'file_citation',
          filename: 'route-map.html',
          purpose: 'output',
          available: true,
          presentation: { type: 'visualization', mode: 'wide', title: '湖滨 5K 跑步轨迹' },
          locator: { artifactKind: 'visualization', label: '酒店跑步路线' },
        },
      ])
    ).toEqual({
      text: '',
      attachmentText: '湖滨 5K 跑步轨迹 酒店跑步路线 route-map.html',
    });
  });
});
