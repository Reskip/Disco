/**
 * Short ID Resolution Utilities for MCP Tools
 *
 * Resolves short ID prefixes (e.g. "5bb05f13") to full UUIDs by looking up
 * the entity via the service layer. Each resolver calls service.get() which
 * triggers the repository's resolveId() — handling exact match, prefix match,
 * ambiguity errors, and not-found errors consistently.
 *
 * Usage: call at the top of MCP tool handlers before using IDs in service
 * calls, route params, or FK values.
 *
 * All functions accept IdInput (short prefix or full UUID) and return the
 * canonical full UUID.
 */

import type { IdInput, SessionID, TaskID } from '@disco/core/types';
import type { McpContext } from './server.js';

export async function resolveSessionId(ctx: McpContext, id: IdInput): Promise<SessionID> {
  const entity = await ctx.app.service('sessions').get(id, ctx.baseServiceParams);
  return entity.session_id;
}

export async function resolveTaskId(ctx: McpContext, id: IdInput): Promise<TaskID> {
  const entity = await ctx.app.service('tasks').get(id, ctx.baseServiceParams);
  return entity.task_id;
}

export async function resolveMcpServerId(ctx: McpContext, id: IdInput): Promise<string> {
  const entity = await ctx.app.service('mcp-servers').get(id, ctx.baseServiceParams);
  return entity.mcp_server_id;
}
