import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

const supportingFileSchema = z.object({
  relativePath: z
    .string()
    .min(1)
    .max(240)
    .describe('Path relative to the skill directory, for example scripts/check.ps1'),
  content: z.string().max(2 * 1024 * 1024),
});

async function resolveTargetAgentId(
  ctx: McpContext,
  requestedAgentId?: string
): Promise<string | null> {
  const candidate = requestedAgentId ?? ctx.authenticatedSession?.agent_id ?? null;
  if (!candidate) return null;
  const agent = await ctx.app.service('agents').get(candidate, ctx.baseServiceParams);
  return agent.agent_id;
}

export function registerSkillTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'disco_skills_list',
    {
      description:
        'List managed skills visible in the current Disco scope. Agent sessions list that agent\'s private skills; standalone sessions list Disco shared skills.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        targetAgentId: z
          .string()
          .optional()
          .describe('Optional target Agent ID. The caller must own that Agent.'),
      }),
    },
    async args => {
      const targetAgentId = await resolveTargetAgentId(ctx, args.targetAgentId);
      if (targetAgentId) {
        const entries = await ctx.app.service('agent-capabilities').find({
          ...ctx.baseServiceParams,
          query: { agent_id: targetAgentId },
        });
        return textResult(
          entries.filter((entry: { kind: string }) => entry.kind === 'skill')
        );
      }
      return textResult(await ctx.app.service('codex-skills').find(ctx.baseServiceParams));
    }
  );

  server.registerTool(
    'disco_skills_install',
    {
      description:
        'Install or update a reusable skill through Disco lifecycle management. In an agent session it belongs to that agent. In a standalone session it becomes Disco shared. Set targetAgentId only when the user explicitly names another owned agent.',
      annotations: { destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(600).optional(),
        skillMarkdown: z
          .string()
          .min(1)
          .max(2 * 1024 * 1024)
          .describe('Complete canonical SKILL.md content'),
        files: z.array(supportingFileSchema).max(64).optional(),
        targetAgentId: z
          .string()
          .optional()
          .describe('Explicit target Agent ID; omit to use the current session scope.'),
        generatedByAgent: z
          .boolean()
          .optional()
          .describe('True only for a skill synthesized by the current agent.'),
      }),
    },
    async args => {
      const targetAgentId = await resolveTargetAgentId(ctx, args.targetAgentId);
      const data = {
        name: args.name,
        description: args.description,
        skill_markdown: args.skillMarkdown,
        files: args.files?.map(file => ({
          relative_path: file.relativePath,
          content: file.content,
        })),
        source: args.generatedByAgent ? ('agent-generated' as const) : undefined,
        source_session_id: ctx.sessionId,
      };
      if (targetAgentId) {
        const installed = await ctx.app.service('agent-capabilities').create(data, {
          ...ctx.baseServiceParams,
          query: { agent_id: targetAgentId },
        });
        return textResult({
          installed: true,
          scope: 'agent',
          target_agent_id: targetAgentId,
          skill: installed,
        });
      }
      const installed = await ctx.app.service('codex-skills').create(data, ctx.baseServiceParams);
      return textResult({ installed: true, scope: 'shared', skill: installed });
    }
  );

  server.registerTool(
    'disco_skills_set_enabled',
    {
      description: 'Enable or disable a managed Disco skill without deleting it.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        capabilityId: z
          .string()
          .optional()
          .describe('Agent capability ID returned by disco_skills_list'),
        skillId: z.string().optional().describe('Shared skill ID returned by disco_skills_list'),
        targetAgentId: z.string().optional(),
        enabled: z.boolean(),
      }),
    },
    async args => {
      if (Boolean(args.capabilityId) === Boolean(args.skillId)) {
        throw new Error('Provide exactly one of capabilityId or skillId');
      }
      if (args.capabilityId) {
        const targetAgentId = await resolveTargetAgentId(ctx, args.targetAgentId);
        if (!targetAgentId) throw new Error('An Agent is required');
        return textResult(
          await ctx.app.service('agent-capabilities').patch(
            args.capabilityId,
            { enabled: args.enabled },
            { ...ctx.baseServiceParams, query: { agent_id: targetAgentId } }
          )
        );
      }
      return textResult(
        await ctx.app
          .service('codex-skills')
          .patch(args.skillId!, { enabled: args.enabled }, ctx.baseServiceParams)
      );
    }
  );

  server.registerTool(
    'disco_skills_uninstall',
    {
      description:
        'Permanently delete a managed skill runtime after explicit confirmation. The audit record remains.',
      annotations: { destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        capabilityId: z.string().optional(),
        skillId: z.string().optional(),
        targetAgentId: z.string().optional(),
        confirmation: z
          .string()
          .describe('Exact skill name, supplied only after the user confirms permanent uninstall'),
      }),
    },
    async args => {
      if (Boolean(args.capabilityId) === Boolean(args.skillId)) {
        throw new Error('Provide exactly one of capabilityId or skillId');
      }
      if (args.capabilityId) {
        const targetAgentId = await resolveTargetAgentId(ctx, args.targetAgentId);
        if (!targetAgentId) throw new Error('An Agent is required');
        return textResult(
          await ctx.app.service('agent-capabilities').patch(
            args.capabilityId,
            { action: 'uninstall', confirmation: args.confirmation },
            { ...ctx.baseServiceParams, query: { agent_id: targetAgentId } }
          )
        );
      }
      return textResult(
        await ctx.app.service('codex-skills').patch(
          args.skillId!,
          { action: 'uninstall', confirmation: args.confirmation },
          ctx.baseServiceParams
        )
      );
    }
  );
}
