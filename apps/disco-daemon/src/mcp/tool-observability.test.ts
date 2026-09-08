import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import {
  observedToolRegistrationProxy,
  type ToolInvocationLogRecord,
} from './tool-observability.js';
import type { ToolEntry } from './tool-registry.js';

const entry: ToolEntry = {
  name: 'disco_files_publish',
  description: 'Publish a file',
  inputSchema: { type: 'object' },
  domain: 'files',
  governance: {
    provider: 'disco-mcp',
    audiences: ['standalone', 'agent'],
    ownership: 'current-session',
    outputKinds: ['image', 'file'],
    lifecycle: 'runtime',
    dependencies: [],
  },
};

function harness(
  handler: (args: unknown) => unknown,
  records: ToolInvocationLogRecord[],
  times = [1_000, 1_025]
) {
  let registered: ((args: unknown) => unknown) | undefined;
  const server = {
    registerTool: vi.fn((_name, _config, callback) => {
      registered = callback;
    }),
  } as unknown as McpServer;
  const now = vi.fn(() => times.shift() ?? 1_025);
  observedToolRegistrationProxy(server, {
    context: {
      userId: 'user-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      audiences: ['agent'],
    },
    getEntry: () => entry,
    sink: (record) => records.push(record),
    now,
  }).registerTool('disco_files_publish', { inputSchema: {} }, handler);
  return (args: unknown) => Promise.resolve(registered?.(args));
}

describe('observedToolRegistrationProxy', () => {
  it('records authenticated identity, requested target, timing and media result kinds', async () => {
    const records: ToolInvocationLogRecord[] = [];
    const invoke = harness(
      async () => ({
        content: [
          { type: 'text', text: 'published' },
          { type: 'image', data: 'omitted' },
        ],
        structuredContent: { display_kind: 'image' },
      }),
      records
    );

    await invoke({ targetAgentId: 'agent-2', sessionId: 'session-2', path: 'secret.png' });

    expect(records).toEqual([
      expect.objectContaining({
        phase: 'started',
        provider: 'disco-mcp',
        method: 'disco_files_publish',
        domain: 'files',
        scope: 'agent',
        user_id: 'user-1',
        target: {
          user_id: 'user-1',
          session_id: 'session-2',
          agent_id: 'agent-2',
        },
      }),
      expect.objectContaining({
        phase: 'completed',
        status: 'succeeded',
        duration_ms: 25,
        result_types: ['image', 'text'],
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('secret.png');
  });

  it('classifies published file display types from the structured publication result', async () => {
    const records: ToolInvocationLogRecord[] = [];
    const invoke = harness(
      async () => ({
        content: [{ type: 'text', text: 'published' }],
        structuredContent: {
          type: 'disco_file_publication',
          files: [{ displayType: 'file' }, { displayType: 'pdf' }],
        },
      }),
      records
    );

    await invoke({});

    expect(records[1]).toMatchObject({
      phase: 'completed',
      status: 'succeeded',
      result_types: ['file', 'pdf', 'text'],
    });
  });

  it('classifies thrown failures without logging the sensitive error message', async () => {
    const records: ToolInvocationLogRecord[] = [];
    const invoke = harness(() => {
      const error = new Error('private cross-user path');
      Object.assign(error, { status: 403, code: 'FORBIDDEN' });
      throw error;
    }, records);

    await expect(invoke({ targetUserId: 'user-2' })).rejects.toThrow('private cross-user path');

    expect(records[1]).toMatchObject({
      phase: 'completed',
      status: 'failed',
      error_class: 'authorization',
      result_types: ['error'],
      target: {
        user_id: 'user-1',
        session_id: 'session-1',
        agent_id: 'agent-1',
        requested_user_id: 'user-2',
      },
    });
    expect(JSON.stringify(records)).not.toContain('private cross-user path');
  });

  it('treats MCP isError results as failed calls', async () => {
    const records: ToolInvocationLogRecord[] = [];
    const invoke = harness(
      () => ({ isError: true, content: [{ type: 'text', text: 'not published' }] }),
      records
    );

    await invoke({});

    expect(records[1]).toMatchObject({
      phase: 'completed',
      status: 'failed',
      error_class: 'tool_result_error',
      result_types: ['text'],
    });
  });
});
