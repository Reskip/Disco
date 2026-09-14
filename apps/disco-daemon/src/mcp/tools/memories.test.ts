import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../server.js';
import { registerMemoryTools } from './memories.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function captureHandler(ctx: McpContext, method = 'disco_agent_memory_save'): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: ToolHandler) {
      if (name === method) handler = callback;
    },
  } as unknown as McpServer;
  registerMemoryTools(server, ctx);
  if (!handler) throw new Error('disco_agent_memory_save was not registered');
  return handler;
}

function createContext(agentId?: string) {
  const saveMemory = vi.fn(async () => ({ id: 'memory-1', kind: 'memory' }));
  const reviewLearning = vi.fn(async () => ({ reviewed: true }));
  const ctx = {
    app: {
      service(name: string) {
        if (name === 'agent-capabilities') return { create: saveMemory, reviewLearning };
        throw new Error(`Unexpected service: ${name}`);
      },
    },
    sessionId: 'session-1',
    authenticatedSession: {
      session_id: 'session-1',
      agent_id: agentId ?? null,
      branch_id: 'legacy-placeholder',
      agentic_tool: 'codex',
    },
    baseServiceParams: {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    },
  } as unknown as McpContext;
  return { ctx, saveMemory, reviewLearning };
}

describe('Disco agent memory MCP tool', () => {
  it('routes learning checkpoints through current-agent authorization and rejects standalone', async () => {
    const context = createContext('agent-1');
    await captureHandler(
      context.ctx,
      'disco_agent_learning_review'
    )({ taskId: 'task-1', phase: 'inspect' });
    expect(context.saveMemory).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        phase: 'inspect',
        kind: 'learning-review',
        source_session_id: 'session-1',
      },
      expect.objectContaining({ query: { agent_id: 'agent-1' } })
    );
    expect(context.reviewLearning).not.toHaveBeenCalled();
    const standalone = createContext();
    await expect(
      captureHandler(
        standalone.ctx,
        'disco_agent_learning_review'
      )({ taskId: 'task-1', phase: 'complete' })
    ).rejects.toThrow(/persistent agent/u);
    expect(standalone.reviewLearning).not.toHaveBeenCalled();
    expect(standalone.saveMemory).not.toHaveBeenCalled();
  });
  it('saves memory into the current persistent agent through the managed service', async () => {
    const context = createContext('agent-1');
    const result = await captureHandler(context.ctx)({
      topic: '用户偏好',
      content: '用户希望先给结论。',
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      saved: true,
      memory: { id: 'memory-1', kind: 'memory' },
    });
    expect(context.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'memory',
        topic: '用户偏好',
        content: '用户希望先给结论。',
        source_session_id: 'session-1',
      }),
      expect.objectContaining({ query: { agent_id: 'agent-1' } })
    );
  });

  it('rejects standalone conversations because they have no persistent memory', async () => {
    const context = createContext();
    await expect(
      captureHandler(context.ctx)({ topic: '临时信息', content: '不应保存。' })
    ).rejects.toThrow(/only available in a persistent agent/i);
    expect(context.saveMemory).not.toHaveBeenCalled();
  });
});
