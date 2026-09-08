/**
 * Shared SQL predicates for user-owned Session data.
 *
 * Disco isolates users at the Session owner boundary. Agent and standalone
 * Sessions use the same rule; an Agent only changes which profile snapshot is
 * loaded when the Session starts.
 */

import type { UUID } from '@disco/core/types';
import { and, eq, exists, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { sessions } from '../schema';

/** Correlated ownership predicate for child tables that carry a session_id. */
export function visibleSessionReferenceAccessExists(
  db: Database,
  userId: UUID,
  // Drizzle accepts columns and SQL wrappers from both supported dialects.
  // biome-ignore lint/suspicious/noExplicitAny: cross-dialect correlated column
  sessionId: any
): SQL {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: cross-dialect select overloads
    (db as any)
      .select({ _: sql`1` })
      .from(sessions)
      .where(and(eq(sessions.session_id, sessionId), eq(sessions.created_by, userId)))
  );
}
