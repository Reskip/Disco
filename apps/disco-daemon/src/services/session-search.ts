import {
  type AgentRow,
  agents as agentsTable,
  and,
  asc,
  desc,
  eq,
  gte,
  isNull,
  lte,
  type MessageRow,
  messages as messagesTable,
  or,
  type SessionRow,
  type SQL,
  select,
  sessions as sessionsTable,
  sql,
  type TenantScopeAwareDatabase,
  visibleSessionReferenceAccessExists,
} from '@disco/core/db';
import { BadRequest, NotAuthenticated } from '@disco/core/feathers';
import type {
  AgentID,
  AuthenticatedParams,
  ContentBlock,
  MessageID,
  MessageRole,
  SessionID,
  SessionSearchKind,
  SessionSearchMatch,
  SessionSearchOrder,
  SessionSearchQuery,
  SessionSearchResult,
  SessionSearchScope,
  UserID,
} from '@disco/core/types';

const MAX_RESULTS = 100;
const DEFAULT_RESULTS = 40;
const SNIPPET_LENGTH = 180;

type SearchableMessage = {
  text: string;
  attachmentText: string;
};

function normalizeLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, Math.trunc(parsed)));
}

function normalizeOffset(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function normalizeScope(value: unknown): SessionSearchScope {
  if (value === undefined || value === null || value === '') return 'all';
  if (value === 'all' || value === 'standalone' || value === 'agent' || value === 'archived') {
    return value;
  }
  throw new BadRequest('Unsupported session search scope');
}

function normalizeKind(value: unknown): SessionSearchKind {
  if (value === undefined || value === null || value === '') return 'all';
  if (value === 'all' || value === 'standalone' || value === 'agent') return value;
  throw new BadRequest('Unsupported session search kind');
}

function normalizeOrder(value: unknown, hasQuery: boolean): SessionSearchOrder {
  if (value === undefined || value === null || value === '') {
    return hasQuery ? 'relevance' : 'newest';
  }
  if (value === 'relevance' || value === 'newest' || value === 'oldest') return value;
  throw new BadRequest('Unsupported session search order');
}

function normalizeDate(value: unknown, label: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequest(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequest(`${label} must be an ISO timestamp`);
  return parsed;
}

function collectAttachmentLabels(value: unknown, labels: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentLabels(item, labels, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    if (
      typeof nested === 'string' &&
      ['filename', 'name', 'displayname', 'originalname', 'filepath', 'path'].includes(
        normalizedKey
      )
    ) {
      labels.push(nested);
      continue;
    }
    collectAttachmentLabels(nested, labels, depth + 1);
  }
}

export function extractSessionSearchMessage(content: unknown, preview = ''): SearchableMessage {
  if (typeof content === 'string') {
    return { text: content, attachmentText: '' };
  }

  const textParts: string[] = [];
  const attachmentParts: string[] = [];
  if (Array.isArray(content)) {
    for (const rawBlock of content) {
      if (!rawBlock || typeof rawBlock !== 'object') continue;
      const block = rawBlock as ContentBlock;
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'image' || block.type === 'file_citation') {
        if (block.type === 'file_citation') {
          const presentation =
            block.presentation && typeof block.presentation === 'object'
              ? (block.presentation as Record<string, unknown>)
              : undefined;
          const locator =
            block.locator && typeof block.locator === 'object'
              ? (block.locator as Record<string, unknown>)
              : undefined;
          if (typeof presentation?.title === 'string') attachmentParts.push(presentation.title);
          if (typeof locator?.label === 'string') attachmentParts.push(locator.label);
        }
        collectAttachmentLabels(block, attachmentParts);
      }
    }
  }

  if (textParts.length === 0 && preview.trim()) textParts.push(preview);
  return {
    text: textParts.join('\n').trim(),
    attachmentText: attachmentParts.join(' ').trim(),
  };
}

function includesEveryTerm(text: string, terms: string[]): boolean {
  const normalized = text.toLocaleLowerCase();
  return terms.every((term) => normalized.includes(term));
}

function buildSnippet(text: string, terms: string[]): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const lowered = compact.toLocaleLowerCase();
  const indexes = terms.map((term) => lowered.indexOf(term)).filter((index) => index >= 0);
  const first = indexes.length > 0 ? Math.min(...indexes) : 0;
  const start = Math.max(0, first - 54);
  const end = Math.min(compact.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

function sessionMatchesScope(
  session: { agent_id: string | null; archived: boolean },
  scope: SessionSearchScope
): boolean {
  if (scope === 'standalone') return !session.agent_id;
  if (scope === 'agent') return Boolean(session.agent_id);
  if (scope === 'archived') return Boolean(session.archived);
  return true;
}

function sessionMatchesKind(
  session: { agent_id: string | null },
  kind: SessionSearchKind
): boolean {
  if (kind === 'standalone') return !session.agent_id;
  if (kind === 'agent') return Boolean(session.agent_id);
  return true;
}

function sessionTitle(session: SessionRow): string {
  const data = session.data as { title?: string; description?: string };
  return data.title?.trim() || data.description?.trim() || '未命名对话';
}

function sessionLastUpdated(session: SessionRow): string {
  return new Date(session.updated_at ?? session.created_at).toISOString();
}

function basicSessionMatch(session: SessionRow, agentName: string | undefined): SessionSearchMatch {
  return {
    session_id: session.session_id as SessionID,
    title: sessionTitle(session),
    agent_id: session.agent_id as AgentID | null,
    agent_name: agentName,
    archived: Boolean(session.archived),
    status: session.status,
    ready_for_prompt: Boolean(session.ready_for_prompt),
    created_at: new Date(session.created_at).toISOString(),
    last_updated: sessionLastUpdated(session),
    match_kind: 'title',
    snippet: '',
    match_count: 0,
  };
}

/**
 * Search is intentionally user-owned, even for admins. Tenant RLS is a second
 * boundary; the correlated owner predicate prevents family-account history
 * from becoming visible through this convenience endpoint.
 */
export class SessionSearchService {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  async find(params?: AuthenticatedParams): Promise<SessionSearchResult> {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) throw new NotAuthenticated('Authentication required');

    const query = (params?.query ?? {}) as Partial<SessionSearchQuery>;
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const scope = normalizeScope(query.scope);
    if (!q && scope !== 'archived') {
      throw new BadRequest('Search query must contain at least 2 characters');
    }
    const minimumQueryLength = scope === 'archived' ? 1 : 2;
    if (q && [...q].length < minimumQueryLength) {
      throw new BadRequest(`Search query must contain at least ${minimumQueryLength} characters`);
    }
    if ([...q].length > 120) throw new BadRequest('Search query is too long');

    const terms = q
      .toLocaleLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const kind = normalizeKind(query.kind);
    const order = normalizeOrder(query.order, Boolean(q));
    const updatedAfter = normalizeDate(query.updated_after, 'updated_after');
    const updatedBefore = normalizeDate(query.updated_before, 'updated_before');
    if (updatedAfter && updatedBefore && updatedAfter > updatedBefore) {
      throw new BadRequest('updated_after must not be later than updated_before');
    }
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);

    const sessionConditions: SQL[] = [eq(sessionsTable.created_by, userId)];
    if (scope === 'archived') sessionConditions.push(eq(sessionsTable.archived, true));
    if (scope === 'standalone' || kind === 'standalone') {
      sessionConditions.push(isNull(sessionsTable.agent_id));
    } else if (scope === 'agent' || kind === 'agent') {
      sessionConditions.push(sql`${sessionsTable.agent_id} IS NOT NULL`);
    }
    if (updatedAfter) sessionConditions.push(gte(sessionsTable.updated_at, updatedAfter));
    if (updatedBefore) sessionConditions.push(lte(sessionsTable.updated_at, updatedBefore));
    const sessionWhere = and(...sessionConditions);

    if (!q) {
      const [countRow, sessionRowsResult, agentRowsResult] = await Promise.all([
        select(this.db, { count: sql<number>`count(*)` })
          .from(sessionsTable)
          .where(sessionWhere)
          .one(),
        select(this.db)
          .from(sessionsTable)
          .where(sessionWhere)
          .orderBy(
            order === 'oldest' ? asc(sessionsTable.updated_at) : desc(sessionsTable.updated_at),
            order === 'oldest' ? asc(sessionsTable.created_at) : desc(sessionsTable.created_at)
          )
          .limit(limit)
          .offset(offset)
          .all(),
        select(this.db).from(agentsTable).where(eq(agentsTable.created_by, userId)).all(),
      ]);
      const agentNames = new Map(
        (agentRowsResult as AgentRow[]).map((agent) => [agent.agent_id, agent.display_name])
      );
      return {
        total: Number(countRow?.count ?? 0),
        limit,
        offset,
        data: (sessionRowsResult as SessionRow[]).map((session) =>
          basicSessionMatch(
            session,
            session.agent_id ? agentNames.get(session.agent_id) : undefined
          )
        ),
      };
    }

    const [sessionRowsResult, agentRowsResult] = await Promise.all([
      select(this.db).from(sessionsTable).where(sessionWhere).all(),
      select(this.db).from(agentsTable).where(eq(agentsTable.created_by, userId)).all(),
    ]);
    const sessionRows = sessionRowsResult as SessionRow[];
    const agentRows = agentRowsResult as AgentRow[];

    const agentNames = new Map(agentRows.map((agent) => [agent.agent_id, agent.display_name]));
    const eligibleSessions = new Map(
      sessionRows
        .filter(
          (session) =>
            sessionMatchesScope(
              { agent_id: session.agent_id, archived: Boolean(session.archived) },
              scope
            ) && sessionMatchesKind({ agent_id: session.agent_id }, kind)
        )
        .map((session) => [session.session_id, session])
    );

    const matches = new Map<string, { result: SessionSearchMatch; score: number }>();
    const addMatch = (result: SessionSearchMatch, score: number) => {
      const previous = matches.get(result.session_id);
      if (!previous) {
        matches.set(result.session_id, { result, score });
        return;
      }
      previous.result.match_count += 1;
      if (score > previous.score) {
        result.match_count = previous.result.match_count;
        matches.set(result.session_id, { result, score });
      }
    };

    for (const session of eligibleSessions.values()) {
      const title = sessionTitle(session);
      const agentName = session.agent_id ? agentNames.get(session.agent_id) : undefined;
      const titleMatches = includesEveryTerm(title, terms);
      const agentMatches = Boolean(agentName && includesEveryTerm(agentName, terms));
      if (!titleMatches && !agentMatches) continue;

      addMatch(
        {
          session_id: session.session_id as SessionID,
          title,
          agent_id: session.agent_id as AgentID | null,
          agent_name: agentName,
          archived: Boolean(session.archived),
          status: session.status,
          ready_for_prompt: Boolean(session.ready_for_prompt),
          created_at: new Date(session.created_at).toISOString(),
          last_updated: sessionLastUpdated(session),
          match_kind: titleMatches ? 'title' : 'agent',
          snippet: titleMatches ? title : (agentName ?? ''),
          match_count: 1,
        },
        titleMatches ? 120 : 90
      );
    }

    if (eligibleSessions.size > 0) {
      const searchConditions = terms.map(
        (term) => sql`LOWER(CAST(${messagesTable.data} AS TEXT)) LIKE ${`%${term}%`}` as SQL
      );
      const roleCondition = or(eq(messagesTable.role, 'user'), eq(messagesTable.role, 'assistant'));
      const messageRows = (await select(this.db)
        .from(messagesTable)
        .where(
          and(
            roleCondition,
            sql`${messagesTable.type} IN ('user', 'assistant')`,
            visibleSessionReferenceAccessExists(this.db, userId, messagesTable.session_id),
            ...searchConditions
          )
        )
        .orderBy(desc(messagesTable.timestamp))
        .all()) as MessageRow[];

      for (const message of messageRows) {
        const session = eligibleSessions.get(message.session_id);
        if (!session) continue;
        const data = message.data as { content?: unknown };
        const searchable = extractSessionSearchMessage(
          data?.content,
          message.content_preview ?? ''
        );
        const humanMatches = includesEveryTerm(searchable.text, terms);
        const attachmentMatches = includesEveryTerm(searchable.attachmentText, terms);
        if (!humanMatches && !attachmentMatches) continue;

        const title = sessionTitle(session);
        const sourceText = humanMatches ? searchable.text : searchable.attachmentText;
        addMatch(
          {
            session_id: session.session_id as SessionID,
            title,
            agent_id: session.agent_id as AgentID | null,
            agent_name: session.agent_id ? agentNames.get(session.agent_id) : undefined,
            archived: Boolean(session.archived),
            status: session.status,
            ready_for_prompt: Boolean(session.ready_for_prompt),
            created_at: new Date(session.created_at).toISOString(),
            last_updated: sessionLastUpdated(session),
            match_kind: humanMatches ? 'message' : 'attachment',
            snippet: buildSnippet(sourceText, terms),
            message_id: message.message_id as MessageID,
            message_role: message.role as MessageRole,
            match_count: 1,
          },
          humanMatches ? 70 : 65
        );
      }
    }

    const ordered = [...matches.values()]
      .sort((a, b) => {
        const dateDelta =
          new Date(b.result.last_updated).getTime() - new Date(a.result.last_updated).getTime();
        if (order === 'newest') return dateDelta || b.score - a.score;
        if (order === 'oldest') return -dateDelta || b.score - a.score;
        return b.score - a.score || dateDelta;
      })
      .map(({ result }) => result);

    return {
      total: ordered.length,
      limit,
      offset,
      data: ordered.slice(offset, offset + limit),
    };
  }
}

export function createSessionSearchService(db: TenantScopeAwareDatabase): SessionSearchService {
  return new SessionSearchService(db);
}
