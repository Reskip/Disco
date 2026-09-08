import type { Session } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import { buildSessionCreatedAnalyticsProperties } from './analytics-payloads.js';

describe('analytics payload builders', () => {
  it('keeps session.created payloads curated and avoids metadata/full records', () => {
    const session = {
      session_id: 'session-1',
      agent_id: 'agent-1',
      created_by: 'user-1',
      name: 'sensitive session title',
      agentic_tool: 'codex',
      agentic_tool_version: '1.2.3',
      model_config: {
        mode: 'alias',
        model: 'gpt-test',
        provider: 'test-provider',
      },
      permission_config: { mode: 'allow-all' },
      genealogy: {
        parent_session_id: 'parent-1',
        forked_from_session_id: null,
      },
      metadata: { prompt: 'do not emit raw prompt metadata' },
      callback_config: { callback_session_id: 'callback-1' },
    } as unknown as Session;

    const payload = buildSessionCreatedAnalyticsProperties(session);

    expect(payload).toEqual({
      session_id: 'session-1',
      agent_id: 'agent-1',
      agentic_tool: 'codex',
      agentic_tool_version: '1.2.3',
      model: 'gpt-test',
      model_mode: 'alias',
      provider: 'test-provider',
      permission_mode: 'allow-all',
      has_parent_session: true,
      has_fork_source: false,
      fork_origin: null,
    });
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('metadata');
    expect(payload).not.toHaveProperty('callback_config');
  });
});
