/**
 * Session Repository
 *
 * Type-safe CRUD operations for sessions with short ID support.
 */

import type { Session, SessionID, SessionUpdate, UUID } from '@disco/core/types';
import { SessionStatus } from '@disco/core/types';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { getBaseUrl } from '../../config/config-manager';
import { generateId, shortId } from '../../lib/ids';
import { getSessionUrl } from '../../utils/url';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  isPostgresDatabase,
  lockRowForUpdate,
  select,
  txAsDb,
  update,
} from '../database-wrapper';
import { sanitizeDbError } from '../sanitize-error';
import { messages, type SessionInsert, type SessionRow, sessions, tasks } from '../schema';
import {
  AmbiguousIdError,
  attachHiddenTenant,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { deepMerge } from './merge-utils';

/**
 * Session with enriched last message
 */
export interface SessionWithLastMessage extends Session {
  last_message?: string;
}

export interface IncompleteScheduledSessionRef {
  session_id: SessionID;
  /**
   * The live FK is nullable because deleting a schedule must not erase the
   * scheduler's ability to finish an occurrence admitted before that delete.
   * Recovery uses the schedule ID snapshotted in custom_context when this is
   * absent; system discovery projects this only as bounded diagnostic context.
   */
  schedule_id?: import('@disco/core/types').ScheduleID;
  scheduled_run_at: number;
  created_at: number;
  tenant_id?: string;
}

export type IncompleteScheduledSessionCursor = Pick<
  IncompleteScheduledSessionRef,
  'created_at' | 'session_id'
>;

type SessionArchiveReason = NonNullable<Session['archived_reason']>;

export type SessionArchiveStateUpdate = {
  id: string;
  archived: boolean;
  archivedReason: SessionArchiveReason | null;
};

/**
 * Patches that only acknowledge UI attention state should not make a session
 * look recently active. Keep this intentionally value-aware: setting
 * ready_for_prompt=true is emitted by task/stop/executor completion paths and
 * is activity; clearing it is the session-open/highlight acknowledgement path.
 *
 * Do not add title/description/model/permission fields here — those are
 * user-visible session metadata changes and should continue to affect recency.
 */
function isSessionTimestampNeutralPatch(updates: SessionUpdate): boolean {
  const keys = Object.keys(updates);
  return keys.length === 1 && keys[0] === 'ready_for_prompt' && updates.ready_for_prompt === false;
}

/**
 * Session repository implementation
 */
export class SessionRepository implements BaseRepository<Session, Partial<Session>> {
  constructor(private db: Database) {}

  /** Convert a direct Session row without consulting repository-era carriers. */
  private rowToSession(row: SessionRow, baseUrl?: string): Session {
    const genealogyData = row.data.genealogy || { children: [] };
    // Older rows may still contain the former session-level git_state JSON.
    // Task snapshots are authoritative; do not expose the legacy projection.
    const { git_state: _legacyGitState, ...sessionData } = row.data as typeof row.data & {
      git_state?: unknown;
    };
    const sessionId = row.session_id as SessionID;
    const url = baseUrl ? getSessionUrl(sessionId, baseUrl) : null;

    return attachHiddenTenant(
      {
        session_id: sessionId,
        status: row.status,
        agentic_tool: row.agentic_tool,
        agentic_tool_preset_id:
          (row.agentic_tool_preset_id as Session['agentic_tool_preset_id']) ?? undefined,
        created_at: new Date(row.created_at).toISOString(),
        last_updated: row.updated_at
          ? new Date(row.updated_at).toISOString()
          : new Date(row.created_at).toISOString(),
        created_by: row.created_by,
        agent_id: (row.agent_id as Session['agent_id']) ?? null,
        working_directory: row.working_directory ?? null,
        unix_username: row.unix_username || null,
        url,
        ...sessionData,
        tasks: row.data.tasks.map((id) => id as UUID),
        genealogy: {
          parent_session_id: row.parent_session_id as UUID | undefined,
          forked_from_session_id: row.forked_from_session_id as UUID | undefined,
          fork_point_task_id: genealogyData.fork_point_task_id as UUID | undefined,
          fork_point_message_index: genealogyData.fork_point_message_index,
          spawn_point_task_id: genealogyData.spawn_point_task_id as UUID | undefined,
          spawn_point_message_index: genealogyData.spawn_point_message_index,
          children: genealogyData.children.map((id) => id as UUID),
        },
        permission_config: row.data.permission_config,
        scheduled_run_at: row.scheduled_run_at ?? undefined,
        is_scheduled: row.is_scheduled ?? false,
        schedule_id: (row.schedule_id as UUID | null) ?? undefined,
        ready_for_prompt: row.ready_for_prompt ?? false,
        archived: Boolean(row.archived), // Convert SQLite integer (0/1) to boolean
        archived_reason: row.archived_reason ?? undefined,
        current_context_usage: row.data.current_context_usage,
        context_window_limit: row.data.context_window_limit,
        last_context_update_at: row.data.last_context_update_at,
      },
      row
    );
  }

  /**
   * Convert Session to database insert format
   */
  private sessionToInsert(session: Partial<Session>): SessionInsert {
    const now = Date.now();
    const sessionId = session.session_id ?? generateId();

    if (!session.created_by) {
      throw new RepositoryError('Session must have a created_by');
    }

    return {
      session_id: sessionId,
      created_at: new Date(session.created_at ? session.created_at : now),
      updated_at: session.last_updated ? new Date(session.last_updated) : new Date(now),
      status: session.status ?? SessionStatus.IDLE,
      // Repository callers that omit the tool must agree with the Disco
      // session service and UI: Codex is the product default.
      agentic_tool: session.agentic_tool ?? 'codex',
      agentic_tool_preset_id: session.agentic_tool_preset_id ?? null,
      created_by: session.created_by,
      agent_id: session.agent_id ?? null,
      working_directory: session.working_directory ?? null,
      unix_username: session.unix_username ?? null, // Immutable execution-home stamp set at creation
      parent_session_id: session.genealogy?.parent_session_id ?? null,
      forked_from_session_id: session.genealogy?.forked_from_session_id ?? null,
      scheduled_run_at: session.scheduled_run_at ?? null,
      is_scheduled: session.is_scheduled ?? false,
      schedule_id: session.schedule_id ?? null,
      ready_for_prompt: session.ready_for_prompt ?? false,
      archived: session.archived ?? false, // Default false for new sessions
      archived_reason: session.archived_reason ?? null,
      data: {
        agentic_tool_version: session.agentic_tool_version,
        ...(session.sdk_session_id !== undefined ? { sdk_session_id: session.sdk_session_id } : {}),
        mcp_token: session.mcp_token, // MCP authentication token for Disco self-access
        title: session.title,
        description: session.description,
        genealogy: session.genealogy ?? {
          children: [],
        },
        contextFiles: session.contextFiles ?? [],
        tasks: session.tasks ?? [],
        permission_config: session.permission_config,
        model_config: session.model_config ?? undefined,
        callback_config: session.callback_config,
        fork_origin: session.fork_origin,
        custom_context: session.custom_context,
        current_context_usage: session.current_context_usage,
        context_window_limit: session.context_window_limit,
        last_context_update_at: session.last_context_update_at,
        billing_mode: session.billing_mode,
      },
    };
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'Session', async (pattern) => {
      const rows = await select(this.db)
        .from(sessions)
        .where(like(sessions.session_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { session_id: string }) => r.session_id);
    });
  }

  /**
   * Create a new session
   */
  async create(data: Partial<Session>): Promise<Session> {
    try {
      const insertData = this.sessionToInsert(data);
      await insert(this.db, sessions).values(insertData).run();

      const baseUrl = await getBaseUrl();

      const result = await select(this.db)
        .from(sessions)
        .where(eq(sessions.session_id, insertData.session_id))
        .one();

      if (!result) {
        throw new RepositoryError('Failed to retrieve created session');
      }

      return this.rowToSession(result as SessionRow, baseUrl);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find session by ID (supports short ID)
   */
  async findById(id: string): Promise<Session | null> {
    try {
      const fullId = await this.resolveId(id);
      const baseUrl = await getBaseUrl();

      const result = await select(this.db)
        .from(sessions)
        .where(eq(sessions.session_id, fullId))
        .one();

      if (!result) {
        return null;
      }

      return this.rowToSession(result as SessionRow, baseUrl);
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Resolve the owning user id for a session without hydrating the full row.
   * Used by realtime delivery to offer streaming events to the session
   * creator's own connections as a fallback, so their open tabs keep updating
   * even before they subscribe to the per-session stream channel.
   */
  async findCreatedByBySessionId(id: string): Promise<UUID | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db, { created_by: sessions.created_by })
        .from(sessions)
        .where(eq(sessions.session_id, fullId))
        .one();
      return (row?.created_by as UUID | undefined) ?? null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find session owner: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all sessions
   */
  async findAll(filter?: { visibleToUserId?: UUID; ownerUserId?: UUID }): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();
      // `visibleToUserId` is retained temporarily at the internal call seam,
      // but now means direct owner. Branch visibility cannot widen access.
      const ownerUserId = filter?.ownerUserId ?? filter?.visibleToUserId;
      const query = select(this.db).from(sessions);
      const results = ownerUserId
        ? await query.where(eq(sessions.created_by, ownerUserId)).all()
        : await query.all();

      return (results as SessionRow[]).map((row) => this.rowToSession(row, baseUrl));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions by status
   */
  async findByStatus(status: Session['status']): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();

      const results = await select(this.db)
        .from(sessions)
        .where(eq(sessions.status, status))
        .all();

      return (results as SessionRow[]).map((row) => this.rowToSession(row, baseUrl));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by status: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Paginated session listing with SQL-side filtering, recency sort, and
   * limit/offset. Powers the bounded first-paint slices (recent-N and the
   * owner-scoped set) so the cap and recency ordering run in SQL.
   *
   * Why SQL and not the generic in-memory path: the Session object exposes its
   * last-updated time as `last_updated`, but callers sort by the DB column name
   * `updated_at`. `DrizzleService.sortData` / `paginateClientSide` would look up
   * `item.updated_at` (undefined) and no-op the sort, then slice an arbitrary
   * page. Ordering here on the real `sessions.updated_at` column makes the
   * recent-N slice actually recent.
   *
   * @returns `{ data, total }` where `total` is the full match count (so Feathers
   *          pagination and the client `findAll` loop behave correctly).
   */
  async findPage(opts: {
    archived?: boolean;
    sortUpdatedAt?: 1 | -1;
    limit?: number;
    skip?: number;
    visibleToUserId?: UUID;
    ownerUserId?: UUID;
  }): Promise<{ data: Session[]; total: number }> {
    try {
      const baseUrl = await getBaseUrl();

      const conditions = [];
      if (opts.archived !== undefined) conditions.push(eq(sessions.archived, opts.archived));
      const ownerUserId = opts.ownerUserId ?? opts.visibleToUserId;
      if (ownerUserId) conditions.push(eq(sessions.created_by, ownerUserId));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Total matching rows — drives Feathers pagination + the findAll loop.
      let countQuery: any = select(this.db, { count: sql<number>`count(*)` })
        .from(sessions);
      const countRow = await (whereClause ? countQuery.where(whereClause) : countQuery).one();
      const total = Number(countRow?.count ?? 0);

      // Page of rows, recency-sorted in SQL on the real `updated_at` column.
      let dataQuery: any = select(this.db).from(sessions);
      if (whereClause) dataQuery = dataQuery.where(whereClause);
      if (opts.sortUpdatedAt !== undefined) {
        dataQuery = dataQuery.orderBy(
          opts.sortUpdatedAt === -1 ? desc(sessions.updated_at) : sessions.updated_at
        );
      }
      if (opts.limit !== undefined) dataQuery = dataQuery.limit(opts.limit);
      if (opts.skip) dataQuery = dataQuery.offset(opts.skip);

      const results = await dataQuery.all();
      const data = (results as SessionRow[]).map((row) => this.rowToSession(row, baseUrl));

      return { data, total };
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions page: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find child sessions (forked or spawned from this session)
   */
  async findChildren(sessionId: string): Promise<Session[]> {
    try {
      const fullId = await this.resolveId(sessionId);
      const baseUrl = await getBaseUrl();

      const results = await select(this.db)
        .from(sessions)
        .where(
          or(eq(sessions.parent_session_id, fullId), eq(sessions.forked_from_session_id, fullId))
        )
        .all();

      return (results as SessionRow[]).map((row) => this.rowToSession(row, baseUrl));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find child sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Find all descendants owned by the same Disco user in one bounded read. */
  async findOwnerDescendants(sessionId: string, ownerUserId: string): Promise<Session[]> {
    try {
      const fullId = await this.resolveId(sessionId);
      const baseUrl = await getBaseUrl();
      const results = await select(this.db)
        .from(sessions)
        .where(eq(sessions.created_by, ownerUserId))
        .all();

      const sessionById = new Map<string, Session>();
      const childrenByParent = new Map<string, Session[]>();
      for (const row of results as SessionRow[]) {
        const session = this.rowToSession(row, baseUrl);
        sessionById.set(session.session_id, session);

        const parentIds = [
          session.genealogy?.parent_session_id,
          session.genealogy?.forked_from_session_id,
        ].filter((id): id is SessionID => typeof id === 'string' && id.length > 0);
        for (const parentId of parentIds) {
          const siblings = childrenByParent.get(parentId) ?? [];
          siblings.push(session);
          childrenByParent.set(parentId, siblings);
        }
      }

      const descendants: Session[] = [];
      const visited = new Set<string>([fullId]);
      const queue = [...(childrenByParent.get(fullId) ?? [])];
      while (queue.length > 0) {
        const child = queue.shift();
        if (!child || visited.has(child.session_id)) continue;
        visited.add(child.session_id);
        descendants.push(child);
        queue.push(...(childrenByParent.get(child.session_id) ?? []));
      }

      return descendants.filter((session) => sessionById.has(session.session_id));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find owner-scoped descendants: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find ancestor sessions (parent chain)
   *
   * OPTIMIZED: Uses indexed parent_session_id lookups instead of iterating with findById.
   * Each parent lookup is O(log n) on indexed column instead of potentially O(1) hash on ID.
   * Total still O(n) but with dramatically lower constant factor due to schema optimization.
   */
  async findAncestors(sessionId: string): Promise<Session[]> {
    try {
      const fullId = await this.resolveId(sessionId);
      const ancestors: Session[] = [];
      const visited = new Set<string>();

      let currentSessionId: string | undefined = fullId;
      let depth = 0;
      const MAX_DEPTH = 100; // Prevent infinite loops

      while (currentSessionId && depth < MAX_DEPTH) {
        // Get current session to find parent
        const current = await this.findById(currentSessionId);
        if (!current) break;

        const parentId =
          current.genealogy?.parent_session_id || current.genealogy?.forked_from_session_id;

        if (!parentId || visited.has(parentId)) break;

        // Use indexed parent lookup (faster than looping through all sessions)
        const parent = await this.findById(parentId);
        if (!parent) break;

        ancestors.push(parent);
        visited.add(parentId);
        currentSessionId = parentId;
        depth++;
      }

      return ancestors;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find ancestor sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update session by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., user changes settings while permission
   * hook is saving allowedTools).
   */
  async update(
    id: string,
    updates: SessionUpdate,
    options: { replaceAgenticConfig?: boolean } = {}
  ): Promise<Session> {
    try {
      const fullId = await this.resolveId(id);
      const baseUrl = await getBaseUrl();

      const statusInfo = updates.status
        ? ` (status: ${updates.status}, ready_for_prompt: ${updates.ready_for_prompt})`
        : '';
      console.debug(`🔄 [SessionRepo] Updating session ${shortId(fullId)}${statusInfo}`);

      // Use transaction to make read-merge-write atomic
      // This prevents race conditions where another update happens between read and write
      const result = await this.db.transaction(async (tx) => {
        // STEP 0: Acquire row-level lock on PostgreSQL to prevent lost updates.
        // Without FOR UPDATE, two concurrent patches can both read the same state,
        // then the last writer silently overwrites the first writer's changes.

        await lockRowForUpdate(txAsDb(tx), this.db, sessions, eq(sessions.session_id, fullId));

        // STEP 1: Read the direct Session row within the transaction.
        const currentResult = await select(txAsDb(tx))
          .from(sessions)
          .where(eq(sessions.session_id, fullId))
          .one();

        if (!currentResult) {
          throw new EntityNotFoundError('Session', id);
        }

        const currentRow = currentResult as SessionRow;
        const current = this.rowToSession(currentRow, baseUrl);

        // STEP 2: Deep merge updates into current session (in memory)
        // IMPORTANT: Receiver-side merge for nested objects (permission_config, model_config, etc.)
        // This prevents partial updates from losing existing nested fields.
        // Strategy: Objects = deep merge, Arrays = replace, Primitives = replace
        const { sdk_session_id: sdkSessionIdUpdate, ...genericUpdates } = updates;
        const merged = deepMerge(current, genericUpdates);
        if (sdkSessionIdUpdate === null) {
          delete merged.sdk_session_id;
        } else if (sdkSessionIdUpdate !== undefined) {
          merged.sdk_session_id = sdkSessionIdUpdate;
        }
        if (options.replaceAgenticConfig) {
          if (Object.hasOwn(updates, 'model_config')) {
            merged.model_config = updates.model_config;
          }
          if (Object.hasOwn(updates, 'permission_config')) {
            merged.permission_config = updates.permission_config;
          }
        }

        const insertData = this.sessionToInsert(merged);

        // STEP 3: Write merged session (within same transaction)
        // Pass all columns via insertData (matches branch repo pattern).
        // Previously used an explicit column allowlist that silently dropped
        // columns like archived/archived_reason, causing data to revert on reload.
        // Refresh updated_at for meaningful updates. sessionToInsert() preserves
        // the old timestamp from the merged session, so timestamp-neutral UI
        // acknowledgements (currently only ready_for_prompt:false) can keep
        // recency ordering stable. Meaningful activity/settings/status patches
        // still advance it; without that, the staleness check in query-builder.ts
        // (hoursSinceUpdate > 24) would erroneously clear sdk_session_id and
        // disconnect agents from their history.
        const shouldRefreshLastUpdated = !isSessionTimestampNeutralPatch(updates);
        if (shouldRefreshLastUpdated) {
          insertData.updated_at = new Date();
        }

        await update(txAsDb(tx), sessions)
          .set(insertData)
          .where(eq(sessions.session_id, fullId))
          .run();

        if (!insertData.updated_at) {
          throw new RepositoryError('Session update did not produce an updated_at timestamp');
        }

        // Return merged session with the persisted timestamp and hidden tenant
        // metadata preserved from the tenant-owned row. The in-memory merge uses
        // object spread, so it intentionally does not carry non-enumerable
        // properties from rowToSession(currentRow).
        merged.last_updated = insertData.updated_at.toISOString();
        if (insertData.archived_reason === null) {
          merged.archived_reason = undefined;
        }
        return attachHiddenTenant(merged, currentRow);
      });

      return result;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Atomically update archive state for a known set of sessions.
   *
   * This is used by manual archive/unarchive cascades so either the whole
   * Session tree flips state or none of it does.
   */
  async updateArchiveStateForIds(
    ids: string[],
    archived: boolean,
    archivedReason: SessionArchiveReason | null
  ): Promise<Session[]> {
    return this.updateArchiveStateForTargets(
      ids.map((id) => ({
        id,
        archived,
        archivedReason,
      }))
    );
  }

  /**
   * Atomically update archive state for known sessions that may need distinct
   * archive reasons.
   */
  async updateArchiveStateForTargets(targets: SessionArchiveStateUpdate[]): Promise<Session[]> {
    if (targets.length === 0) return [];

    try {
      const ids = targets.map((target) => target.id);
      const fullIds = await Promise.all(ids.map((id) => this.resolveId(id)));
      const updates = targets.map((target, index) => ({
        ...target,
        id: fullIds[index],
      }));
      const baseUrl = await getBaseUrl();
      const now = new Date();
      const result = await this.db.transaction(async (tx) => {
        const groups = new Map<string, SessionArchiveStateUpdate[]>();
        for (const updateTarget of updates) {
          const key = `${updateTarget.archived}:${updateTarget.archivedReason ?? ''}`;
          const group = groups.get(key) ?? [];
          group.push(updateTarget);
          groups.set(key, group);
        }

        for (const group of groups.values()) {
          const [first] = group;
          if (!first) continue;
          await update(txAsDb(tx), sessions)
            .set({
              archived: first.archived,
              archived_reason: first.archivedReason,
              updated_at: now,
            })
            .where(
              inArray(
                sessions.session_id,
                group.map((target) => target.id)
              )
            )
            .run();
        }

        const rows = await select(txAsDb(tx))
          .from(sessions)
          .where(inArray(sessions.session_id, fullIds))
          .all();

        if (rows.length !== fullIds.length) {
          throw new EntityNotFoundError('Session', ids[0]);
        }

        const byId = new Map<string, Session>();
        for (const row of rows as SessionRow[]) {
          byId.set(row.session_id, this.rowToSession(row, baseUrl));
        }

        return fullIds.map((id) => {
          const session = byId.get(id);
          if (!session) throw new EntityNotFoundError('Session', id);
          return session;
        });
      });

      return result;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update session archive state: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count messages for a session (live query, no caching)
   */
  async countMessages(sessionId: string): Promise<number> {
    const fullId = await this.resolveId(sessionId);
    const result = await select(this.db, {
      count: sql<number>`count(*)`,
    })
      .from(messages)
      .where(eq(messages.session_id, fullId))
      .one();
    return Number(result?.count ?? 0);
  }

  /**
   * Delete session by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, sessions)
        .where(eq(sessions.session_id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Session', id);
      }
    } catch (error) {
      console.error(`❌ [SessionRepo] Failed to delete session ${id}:`, sanitizeDbError(error));
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find sessions with running tasks
   */
  async findRunning(): Promise<Session[]> {
    return this.findByStatus(SessionStatus.RUNNING);
  }

  /**
   * Count total sessions
   */
  async count(): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` }).from(sessions).one();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find the session that corresponds to one specific scheduled run.
   *
   * Used by the scheduler to dedup: "is there already a session for
   * (schedule_id, scheduled_run_at)?". PostgreSQL uses the tenant-aware
   * covering index `sessions_schedule_run_unique
   * (tenant_id, schedule_id, scheduled_run_at)`; SQLite uses the standalone
   * two-column equivalent. The lookup is O(log n), not a full table scan.
   *
   * Returns the matching direct Session row or null if no match.
   */
  async findScheduleRun(
    scheduleId: import('@disco/core/types').ScheduleID,
    scheduledRunAt: number
  ): Promise<Session | null> {
    try {
      const baseUrl = await getBaseUrl();
      const result = await select(this.db)
        .from(sessions)
        .where(
          and(eq(sessions.schedule_id, scheduleId), eq(sessions.scheduled_run_at, scheduledRunAt))
        )
        .one();
      if (!result) return null;
      return this.rowToSession(result as SessionRow, baseUrl);
    } catch (error) {
      throw new RepositoryError(
        `Failed to find scheduled run: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Bounded routing-only discovery for recoverable scheduler initialization. */
  async findIncompleteScheduledRefs(
    limit = 25,
    after?: IncompleteScheduledSessionCursor
  ): Promise<IncompleteScheduledSessionRef[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RepositoryError('Incomplete scheduled Session limit must be between 1 and 1000');
    }
    const tenantColumn = (sessions as unknown as { tenant_id?: unknown }).tenant_id;
    const columns = {
      session_id: sessions.session_id,
      schedule_id: sessions.schedule_id,
      scheduled_run_at: sessions.scheduled_run_at,
      created_at: sessions.created_at,
      ...(isPostgresDatabase(this.db) && tenantColumn ? { tenant_id: tenantColumn } : {}),
    };
    const afterCondition = after
      ? or(
          gt(sessions.created_at, new Date(after.created_at)),
          and(
            eq(sessions.created_at, new Date(after.created_at)),
            gt(sessions.session_id, after.session_id)
          )
        )
      : undefined;
    const rows = await select(this.db, columns)
      .from(sessions)
      .where(
        and(
          eq(sessions.is_scheduled, true),
          isNotNull(sessions.scheduled_run_at),
          isNull(sessions.scheduler_init_completed_at),
          afterCondition
        )
      )
      .orderBy(asc(sessions.created_at), asc(sessions.session_id))
      .limit(limit)
      .all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      session_id: row.session_id as SessionID,
      ...(typeof row.schedule_id === 'string'
        ? { schedule_id: row.schedule_id as import('@disco/core/types').ScheduleID }
        : {}),
      scheduled_run_at: Number(row.scheduled_run_at),
      created_at:
        row.created_at instanceof Date
          ? row.created_at.getTime()
          : new Date(row.created_at as string | number).getTime(),
      ...(typeof row.tenant_id === 'string' ? { tenant_id: row.tenant_id } : {}),
    }));
  }

  async isScheduledInitializationComplete(sessionId: SessionID): Promise<boolean> {
    const row = await select(this.db, { completedAt: sessions.scheduler_init_completed_at })
      .from(sessions)
      .where(eq(sessions.session_id, sessionId))
      .one();
    return row?.completedAt != null;
  }

  /** Conditional/idempotent completion marker written after schedule finalization. */
  async markScheduledInitializationComplete(sessionId: SessionID): Promise<boolean> {
    const result = await update(this.db, sessions)
      .set({ scheduler_init_completed_at: new Date() })
      .where(
        and(
          eq(sessions.session_id, sessionId),
          eq(sessions.is_scheduled, true),
          isNull(sessions.scheduler_init_completed_at)
        )
      )
      .run();
    return result.rowsAffected === 1;
  }

  /**
   * Find all sessions for a schedule, optionally ordered by scheduled_run_at.
   *
   * Used by the scheduler for retention enforcement (`desc` to keep the
   * newest N) and the run-index count. Uses the same
   * `sessions_schedule_run_unique` as `findScheduleRun`.
   */
  async findByScheduleId(
    scheduleId: import('@disco/core/types').ScheduleID,
    opts: { orderByScheduledRunAt?: 'asc' | 'desc' } = {}
  ): Promise<Session[]> {
    try {
      const baseUrl = await getBaseUrl();
      let query = select(this.db)
        .from(sessions)
        .where(eq(sessions.schedule_id, scheduleId));
      if (opts.orderByScheduledRunAt === 'desc') {
        query = query.orderBy(desc(sessions.scheduled_run_at));
      } else if (opts.orderByScheduledRunAt === 'asc') {
        query = query.orderBy(sessions.scheduled_run_at);
      }
      const results = await query.all();
      return (results as SessionRow[]).map((row) => this.rowToSession(row, baseUrl));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find sessions by schedule: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count sessions linked to a schedule. Used by the scheduler to
   * compute the `run_index` ('this is the Nth run of schedule X') for
   * the spawned session's `custom_context.scheduled_run`.
   */
  async countByScheduleId(scheduleId: import('@disco/core/types').ScheduleID): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` })
        .from(sessions)
        .where(eq(sessions.schedule_id, scheduleId))
        .one();
      return Number(result?.count ?? 0);
    } catch (error) {
      throw new RepositoryError(
        `Failed to count sessions by schedule: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * True iff at least one session for this schedule has a status in the
   * given set. Used by the scheduler's per-schedule concurrency guard.
   */
  async existsInScheduleWithStatuses(
    scheduleId: import('@disco/core/types').ScheduleID,
    statuses: ReadonlyArray<Session['status']>
  ): Promise<boolean> {
    if (statuses.length === 0) return false;
    try {
      const row = await select(this.db, { one: sql<number>`1` })
        .from(sessions)
        .where(and(eq(sessions.schedule_id, scheduleId), inArray(sessions.status, [...statuses])))
        .limit(1)
        .one();
      return row != null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to probe sessions in schedule: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Scheduler admission probe covering both an active Session and the narrow
   * initialization window before its first Task reaches DISPATCHING. A
   * completed scheduled session is IDLE with only terminal tasks and does not
   * block the next occurrence.
   */
  async existsActiveOrInitializingInSchedule(
    scheduleId: import('@disco/core/types').ScheduleID,
    activeSessionStatuses: ReadonlySet<Session['status']>,
    activeTaskStatuses: ReadonlySet<import('@disco/core/types').Task['status']>
  ): Promise<boolean> {
    const activeSession =
      activeSessionStatuses.size > 0
        ? inArray(sessions.status, [...activeSessionStatuses])
        : sql`false`;
    const taskIsActive =
      activeTaskStatuses.size > 0 ? inArray(tasks.status, [...activeTaskStatuses]) : sql`false`;
    try {
      const row = await select(this.db, { one: sql<number>`1` })
        .from(sessions)
        .where(
          and(
            eq(sessions.schedule_id, scheduleId),
            or(
              activeSession,
              // New scheduled Sessions remain initialization-active until the
              // scheduler writes its internal completion marker. Migrations
              // backfill historical Sessions so old no-Task rows do not block
              // a schedule forever.
              isNull(sessions.scheduler_init_completed_at),
              sql`EXISTS (SELECT 1 FROM ${tasks} WHERE ${tasks.session_id} = ${sessions.session_id} AND ${taskIsActive})`
            )
          )
        )
        .limit(1)
        .one();
      return row != null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to probe active or initializing scheduled sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Return Sessions visible to their direct owner. */
  async findAccessibleSessions(userId: UUID): Promise<Session[]> {
    return await this.findAll({ ownerUserId: userId });
  }

  /**
   * Enrich a single session with last assistant message
   *
   * @param session - Session to enrich
   * @param truncationLength - Maximum length for last_message (default: 500)
   * @returns Session with last_message added
   */
  async enrichWithLastMessage(
    session: Session,
    truncationLength = 500
  ): Promise<SessionWithLastMessage> {
    const enriched = await this.enrichManyWithLastMessage([session], truncationLength);
    return enriched[0] || session;
  }

  /**
   * Enrich multiple sessions with last assistant message (batch operation)
   *
   * Fetches the most recent assistant message for each session.
   *
   * @param sessions - Array of sessions to enrich
   * @param truncationLength - Maximum length for last_message (default: 500)
   * @returns Array of sessions with last_message added
   */
  async enrichManyWithLastMessage(
    sessions: Session[],
    truncationLength = 500
  ): Promise<SessionWithLastMessage[]> {
    // Quick path: if no sessions, return empty array
    if (sessions.length === 0) {
      return [];
    }

    try {
      const sessionIds = sessions.map((s) => s.session_id);

      // Import messages table dynamically
      const { messages: messagesTable } = await import('../schema');

      // Get last assistant message for each session using N+1 queries
      // This is acceptable since we're enriching a small number of sessions at a time
      // Much better than fetching all messages which could be huge for long-running sessions
      const lastMessageBySession = new Map<string, string>();

      for (const sessionId of sessionIds) {
        const query = select(this.db, {
          data: messagesTable.data,
        })
          .from(messagesTable)
          .where(and(eq(messagesTable.session_id, sessionId), eq(messagesTable.role, 'assistant')));

        // Chain orderBy and limit, then execute with one()
        // The spread operator in the wrapper passes through these methods
        const lastMessage = await query.orderBy(desc(messagesTable.index)).limit(1).one();

        if (lastMessage) {
          // Extract text content from message data and truncate to requested length
          const messageData = lastMessage.data as {
            content?: Array<{ type: string; text?: string }>;
          };
          let fullText = '';

          // Extract text from content blocks (messages can have multiple content blocks)
          if (messageData?.content && Array.isArray(messageData.content)) {
            fullText = messageData.content
              .filter((block) => block.type === 'text' && block.text)
              .map((block) => block.text)
              .join('\n');
          }

          // Truncate to requested length
          if (fullText.length > truncationLength) {
            fullText = `${fullText.substring(0, truncationLength)}...`;
          }

          lastMessageBySession.set(sessionId, fullText);
        }
      }

      // Enrich sessions with last message
      return sessions.map((session) => {
        const lastMessage = lastMessageBySession.get(session.session_id) || '';
        return {
          ...session,
          last_message: lastMessage,
        };
      });
    } catch (error) {
      console.warn(
        'Failed to enrich sessions with last message:',
        error instanceof Error ? error.message : String(error)
      );
      // Return sessions without last message on error
      return sessions.map((session) => ({ ...session, last_message: '' }));
    }
  }

  /**
   * Check whether a session with the given id exists. Used by the MCP-token
   * validation path to reject tokens whose session has been deleted.
   */
  async exists(sessionId: string): Promise<boolean> {
    try {
      const row = (await select(this.db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one()) as { session_id?: string } | null | undefined;
      return row != null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to check session existence: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
