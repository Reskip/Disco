import { shortId } from '@disco/core/db';
import { Forbidden, NotAuthenticated, NotFound } from '@disco/core/feathers';
import type { AuthenticatedParams, HookContext, Session, UUID } from '@disco/core/types';

interface SessionActor {
  user_id?: string;
  _isServiceAccount?: boolean;
}

type SessionContextParams = AuthenticatedParams & {
  session?: Session;
  sessionId?: string;
  _discoSessionCache?: Map<string, Session>;
  _discoPrefetchedRecord?: {
    id: string;
    idField: string;
    record: unknown;
  };
};

function rememberPrefetchedRecord(
  context: HookContext,
  record: unknown,
  idField: string,
  id: string
): void {
  (context.params as SessionContextParams)._discoPrefetchedRecord = {
    id,
    idField,
    record,
  };
}

async function loadCachedSession(
  params: AuthenticatedParams,
  // biome-ignore lint/suspicious/noExplicitAny: narrow Feathers service seam
  sessionService: any,
  sessionId: string
): Promise<Session> {
  const scoped = params as SessionContextParams;
  if (scoped.session?.session_id === sessionId) return scoped.session;
  scoped._discoSessionCache ??= new Map();
  const cached = scoped._discoSessionCache.get(sessionId);
  if (cached) return cached;
  const session = (await sessionService.get(sessionId, { provider: undefined })) as Session | null;
  if (!session) throw new NotFound('Session not found');
  scoped._discoSessionCache.set(sessionId, session);
  return session;
}

/** Resolve the canonical Session id for Session, Task, and Message hooks. */
export function resolveSessionContext() {
  return async (context: HookContext) => {
    if (!context.params.provider) return context;

    const data = context.data as Record<string, unknown> | undefined;
    const query = context.params.query as Record<string, unknown> | undefined;
    let sessionId: string | undefined;

    if (context.path === 'sessions') {
      sessionId =
        context.method === 'create'
          ? (data?.session_id as string | undefined)
          : context.id
            ? String(context.id)
            : undefined;
    } else if (context.path === 'tasks' || context.path === 'messages') {
      if (context.method === 'create') {
        sessionId = data?.session_id as string | undefined;
      } else if (context.method === 'find') {
        sessionId = query?.session_id as string | undefined;
      } else if (context.id) {
        // Id-addressed resources authorize against their stored parent. Never
        // trust a client-supplied session_id for update/remove operations.
        // biome-ignore lint/suspicious/noExplicitAny: Feathers service seam
        const existing = await (context.service as any).get(context.id, { provider: undefined });
        sessionId = existing?.session_id;
        if (existing) {
          rememberPrefetchedRecord(
            context,
            existing,
            context.path === 'tasks' ? 'task_id' : 'message_id',
            String(context.id)
          );
        }
      }
    }

    if (!sessionId) {
      throw new Error(
        `Cannot resolve session context: session_id not found for ${context.path}.${context.method}`
      );
    }
    context.params.sessionId = sessionId;
    return context;
  };
}

/** Load the resolved Session exactly once for the current hook request. */
export function loadSession(
  // biome-ignore lint/suspicious/noExplicitAny: narrow Feathers service seam
  sessionService: any
) {
  return async (context: HookContext) => {
    if (!context.params.provider) return context;
    const sessionId = context.params.sessionId;
    if (!sessionId) throw new Error('resolveSessionContext hook must run before loadSession');
    const session = await loadCachedSession(context.params, sessionService, sessionId);
    context.params.session = session;
    if (context.path === 'sessions' && context.id && String(context.id) === sessionId) {
      rememberPrefetchedRecord(context, session, 'session_id', sessionId);
    }
    return context;
  };
}

/** Keep the user, Agent, and filesystem identity of an existing Session stable. */
export function ensureSessionImmutability() {
  return (context: HookContext) => {
    if (context.method !== 'patch' && context.method !== 'update') return context;
    const data = context.data as Record<string, unknown> | undefined;
    for (const field of ['created_by', 'agent_id', 'working_directory'] as const) {
      if (data?.[field] !== undefined) {
        throw new Forbidden(`session.${field} is immutable`);
      }
    }
    return context;
  };
}

function externalSessionUserId(context: HookContext): UUID | undefined {
  if (!context.params.provider || context.params.user?._isServiceAccount) return undefined;
  const userId = context.params.user?.user_id;
  if (!userId) throw new NotAuthenticated('Authentication required');
  return userId as UUID;
}

/** Mark a session-scoped find for repository-level direct-owner filtering. */
export function scopeFindToPersonalSessionsSql() {
  return (context: HookContext) => {
    const userId = externalSessionUserId(context);
    if (userId) {
      (context.params as { _discoSqlSessionOwnerUserId?: UUID })._discoSqlSessionOwnerUserId = userId;
    }
    return context;
  };
}

/** Require a loaded Session to belong to the current browser/API user. */
export function ensurePersonalSessionOwner() {
  return (context: HookContext) => {
    const userId = externalSessionUserId(context);
    if (!userId) return context;
    const session = context.params.session as Session | undefined;
    if (!session) throw new Error('loadSession hook must run before ensurePersonalSessionOwner');
    if (session.created_by !== userId) throw new NotFound('Session not found');
    return context;
  };
}

/**
 * Disco conversations are private to their creating user. Agent and standalone
 * sessions differ only in the identity snapshot loaded at startup; neither
 * grants another Disco user access through a shared repository or Branch.
 */
export function assertSessionOwnedByActor(actor: SessionActor | undefined, session: Session): void {
  if (!actor?.user_id) throw new NotAuthenticated('Authentication required');
  if (actor._isServiceAccount) return;
  if (session.created_by !== actor.user_id) {
    throw new Forbidden('Cannot access a Session owned by another Disco user');
  }
}

/** Load a target Session and enforce the direct user boundary. */
export async function ensureCanPromptTargetSession(
  sessionId: string,
  userId: string,
  // biome-ignore lint/suspicious/noExplicitAny: narrow Feathers lookup seam
  app: { service(name: string): any }
): Promise<Session> {
  let session: Session;
  try {
    session = await app.service('sessions').get(sessionId, { provider: undefined });
  } catch {
    throw new Forbidden(`Invalid callback target: session ${shortId(sessionId)} not found`);
  }
  assertSessionOwnedByActor({ user_id: userId }, session);
  return session;
}
