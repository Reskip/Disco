import { runWithTenantDatabaseScope, SessionRepository, type TenantScopeAwareDatabase } from '@disco/core/db';
import { BadRequest, Forbidden } from '@disco/core/feathers';
import type { AuthenticatedParams } from '@disco/core/types';
import type { AuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';

type ConfigurationQuery = { session_id?: unknown };

/** Resolve OpenCode discovery to an owned Disco Session working directory. */
export async function resolveOpenCodeConfigurationDirectory(input: {
  db: TenantScopeAwareDatabase;
  context: AuthenticatedOpenCodeSubjectContext;
  params?: AuthenticatedParams & { query?: ConfigurationQuery };
}): Promise<string | undefined> {
  const query = input.params?.query;
  const unsupported = Object.keys(query ?? {}).find((field) => field !== 'session_id');
  if (unsupported) {
    throw new BadRequest('OpenCode configuration discovery accepts only an optional session ID.');
  }

  const rawSessionId = query?.session_id;
  if (rawSessionId !== undefined && typeof rawSessionId !== 'string') {
    throw new BadRequest('Session ID must be a string.');
  }
  const sessionId = rawSessionId?.trim();
  if (rawSessionId !== undefined && !sessionId) {
    throw new BadRequest('Session ID cannot be empty.');
  }
  if (!sessionId) return undefined;

  return runWithTenantDatabaseScope(input.db, input.context.tenantId, async (tenantDb) => {
    const session = await new SessionRepository(tenantDb).findById(sessionId);
    if (!session || session.created_by !== input.context.subjectUserId) {
      throw new Forbidden('OpenCode configuration session is not authorized.');
    }
    return session.working_directory ?? undefined;
  });
}
