/**
 * MCP server inheritance for quick-start session creation.
 *
 * Quick-start has no per-form override, so it inherits the current user's
 * shared MCP defaults. Agent-specific configuration is resolved separately
 * by the Agent session creation path.
 */

import type { User } from '@disco-live/client';

export function resolveQuickStartMcpServerIds(
  user: Pick<User, 'default_mcp_server_ids'> | null | undefined
): string[] {
  return user?.default_mcp_server_ids ?? [];
}
