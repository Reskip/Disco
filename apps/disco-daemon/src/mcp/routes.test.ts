/**
 * MCP HTTP integration contract.
 *
 * These tests require a running daemon and an MCP token:
 *   $env:INTEGRATION='true'
 *   $env:MCP_TEST_TOKEN='<session token>'
 *   pnpm --filter @disco/daemon exec vitest run src/mcp/routes.test.ts
 */

import { beforeAll, describe, expect, it } from 'vitest';

const runIntegration = process.env.INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;
const daemonUrl = process.env.MCP_TEST_DAEMON_URL || 'http://localhost:3030';

let sessionToken = '';

async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await fetch(`${daemonUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
  const data = (await response.json()) as {
    error?: { message: string };
    result?: unknown;
  };
  if (data.error) {
    throw new Error(`MCP ${method} failed: ${data.error.message}`);
  }
  return data.result;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = (await rpc('tools/call', {
    name,
    arguments: args,
  })) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

describeIntegration('MCP HTTP method-governance contract', () => {
  beforeAll(() => {
    sessionToken = process.env.MCP_TEST_TOKEN || '';
    if (!sessionToken) {
      throw new Error('MCP_TEST_TOKEN is required when INTEGRATION=true');
    }
  });

  it('exposes current orchestration methods and none of the retired architecture methods', async () => {
    const result = (await rpc('tools/list')) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'disco_sessions_list',
        'disco_sessions_get',
        'disco_sessions_get_current',
        'disco_sessions_spawn',
        'disco_sessions_prompt',
        'disco_sessions_update',
        'disco_models_list',
        'disco_files_publish',
        'disco_skills_list',
        'disco_skills_install',
      ])
    );

    expect(names).not.toEqual(
      expect.arrayContaining([
        'disco_sessions_get_current_context',
        'disco_sessions_create',
        'disco_sessions_bulk_archive',
        'disco_analytics_leaderboard',
        'disco_upload_materialize',
      ])
    );

    for (const prefix of [
      'disco_repos_',
      'disco_branches_',
      'disco_boards_',
      'disco_cards_',
      'disco_card_types_',
      'disco_artifacts_',
      'disco_schedules_',
      'disco_environment_',
    ]) {
      expect(names.some((name) => name.startsWith(prefix))).toBe(false);
    }
  });

  it('returns carrier-free session summaries', async () => {
    const sessions = await callTool('disco_sessions_list', { limit: 5 });

    expect(sessions).toHaveProperty('total');
    expect(Array.isArray(sessions.data)).toBe(true);
    for (const session of sessions.data) {
      expect(session).not.toHaveProperty('mcp_token');
      expect(session).not.toHaveProperty('branch_id');
      expect(session).not.toHaveProperty('branch_board_id');
    }
  });

  it('returns the current session without legacy repo, branch, or board envelopes', async () => {
    const session = await callTool('disco_sessions_get_current');

    expect(session).toHaveProperty('session_id');
    expect(session).not.toHaveProperty('mcp_token');
    expect(session).not.toHaveProperty('branch_id');
    expect(session).not.toHaveProperty('branch');
    expect(session).not.toHaveProperty('repository');
    expect(session).not.toHaveProperty('board');
  });

  it('keeps the model catalog callable for active orchestration methods', async () => {
    const models = await callTool('disco_models_list', { agenticTool: 'codex' });

    expect(Object.keys(models)).toEqual(['codex']);
    expect(models.codex.models.length).toBeGreaterThan(0);
  });
});
