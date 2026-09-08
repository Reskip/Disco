import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerMemoryTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'disco_agent_memory_save',
    {
      description:
        'Save durable information to the current persistent agent memory through Disco management. Use this when the user explicitly asks the agent to remember something, or for a stable cross-session fact. This tool is unavailable in standalone conversations.',
      annotations: { destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        topic: z.string().min(1).max(120).describe('Short stable topic for the memory record'),
        content: z
          .string()
          .min(1)
          .max(512 * 1024)
          .describe('The durable fact or preference to remember, without temporary task details'),
        operation: z
          .enum(['append', 'replace'])
          .optional()
          .describe('Append to the same topic by default; replace only when correcting that topic'),
        source: z.enum(['user-explicit', 'agent-inference']).optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    },
    async args => {
      const agentId = ctx.authenticatedSession?.agent_id;
      if (!agentId) {
        throw new Error('Long-term memory is only available in a persistent agent conversation');
      }
      const saved = await ctx.app.service('agent-capabilities').create(
        {
          kind: 'memory',
          topic: args.topic,
          content: args.content,
          operation: args.operation,
          source: args.source,
          confidence: args.confidence,
          source_session_id: ctx.sessionId ?? null,
        },
        { ...ctx.baseServiceParams, query: { agent_id: agentId } }
      );
      return textResult({ saved: true, memory: saved });
    }
  );
}
