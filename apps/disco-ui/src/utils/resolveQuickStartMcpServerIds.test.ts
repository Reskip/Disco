import { describe, expect, it } from 'vitest';
import { resolveQuickStartMcpServerIds } from './resolveQuickStartMcpServerIds';

describe('resolveQuickStartMcpServerIds', () => {
  it('uses the current user shared MCP defaults', () => {
    const result = resolveQuickStartMcpServerIds({ default_mcp_server_ids: ['user-mcp'] });
    expect(result).toEqual(['user-mcp']);
  });

  it('returns an empty array when the user has no default', () => {
    expect(resolveQuickStartMcpServerIds(null)).toEqual([]);
  });
});
