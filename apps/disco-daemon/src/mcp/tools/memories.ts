import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerMemoryTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'disco_agent_memory_save',
    {
      description:
        'Proactively save stable preferences, explicit user corrections and verified cross-session facts to the current persistent agent. Do this during the task without waiting for the user to say remember. Exclude temporary progress, secrets and unsupported guesses; preserve uncertainty. Unavailable in standalone conversations.',
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
        expectedUpdatedAt: z
          .string()
          .optional()
          .describe(
            'For a correction, copy updated_at from the inspected memory to prevent overwriting a concurrent update'
          ),
      }),
    },
    async (args) => {
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
          source: args.source ?? 'agent-inference',
          confidence: args.confidence,
          source_session_id: ctx.sessionId ?? null,
          expected_updated_at: args.expectedUpdatedAt,
        },
        { ...ctx.baseServiceParams, query: { agent_id: agentId } }
      );
      return textResult({ saved: true, memory: saved });
    }
  );

  server.registerTool(
    'disco_agent_learning_review',
    {
      description:
        'Inspect or complete the current agent task learning checkpoint. Before finishing meaningful work, evaluate durable memory and reusable skills; record why changes were or were not useful. Inspect returns original active memories and a fingerprint. When consolidation is due, submit a concise summary with all source paths, preserving corrections, uncertainty and provenance. Original records are retained. Install useful skills with disco_skills_install before completing this review.',
      annotations: { destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        taskId: z.string().min(1).max(128),
        phase: z.enum(['inspect', 'complete']),
        memoryDecision: z.string().min(1).max(2000).optional(),
        skillDecision: z.string().min(1).max(2000).optional(),
        consolidation: z
          .object({
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
            content: z.string().min(1).max(24_000),
            sourcePaths: z.array(z.string().min(1).max(512)).max(2000),
          })
          .optional(),
        deferReason: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe('Only if consolidation cannot be completed now; keeps it pending'),
      }),
    },
    async (args) => {
      const agentId = ctx.authenticatedSession?.agent_id;
      if (!agentId || !ctx.sessionId)
        throw new Error('Long-term learning is only available in a persistent agent conversation');
      return textResult(
        await ctx.app.service('agent-capabilities').create(
          { ...args, kind: 'learning-review', source_session_id: ctx.sessionId },
          {
            ...ctx.baseServiceParams,
            query: { agent_id: agentId },
          }
        )
      );
    }
  );
}
