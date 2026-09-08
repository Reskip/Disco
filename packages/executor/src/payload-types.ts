/**
 * Private command contract between the Disco daemon and the task-scoped executor.
 *
 * The executor is not a second application API. It exposes only the operations
 * that still need to run in the selected execution substrate.
 */

import { type ResolvedConfigSlice, ResolvedConfigSliceSchema } from '@disco/core/config';
import { AGENTIC_TOOL_NAMES, type AgenticToolName } from '@disco/core/types';
import { z } from 'zod';

export { type ResolvedConfigSlice, ResolvedConfigSliceSchema };

export const ToolTypeSchema = z.enum(AGENTIC_TOOL_NAMES);
export type ToolType = AgenticToolName;

export const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'autoEdit',
  'yolo',
  'ask',
  'auto',
  'on-failure',
  'allow-all',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const BasePayloadSchema = z.object({
  command: z.string(),
  daemonUrl: z.string().url().optional(),
  env: z.record(z.string(), z.string()).optional(),
  agenticToolContext: z.record(z.string(), z.unknown()).optional(),
  resolvedConfig: ResolvedConfigSliceSchema.optional(),
});

export const PromptPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('prompt'),
  sessionToken: z.string(),
  params: z.object({
    sessionId: z.string().uuid(),
    taskId: z.string().uuid(),
    prompt: z.string(),
    tool: ToolTypeSchema,
    permissionMode: PermissionModeSchema.optional(),
    cwd: z.string(),
    messageSource: z.literal('disco').optional(),
  }),
});
export type PromptPayload = z.infer<typeof PromptPayloadSchema>;

export const AgenticToolInvokePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('agentic-tool.invoke'),
  params: z.object({
    tool: ToolTypeSchema,
    request: z.record(z.string(), z.unknown()),
  }),
});
export type AgenticToolInvokePayload = z.infer<typeof AgenticToolInvokePayloadSchema>;

export const WorkspaceFilesListPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('workspace.files.list'),
  sessionToken: z.string(),
  params: z.object({
    workingDirectory: z.string().min(1),
    search: z.string(),
    limit: z.number().int().positive().max(100).optional().default(10),
  }),
});
export type WorkspaceFilesListPayload = z.infer<typeof WorkspaceFilesListPayloadSchema>;

export const CodexAuthFilePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('codex.auth-file'),
  params: z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('inspect') }),
    z.object({ operation: z.literal('write'), content: z.string().max(64 * 1024) }),
    z.object({ operation: z.literal('delete') }),
  ]),
});
export type CodexAuthFilePayload = z.infer<typeof CodexAuthFilePayloadSchema>;

export const CodexGenerateTitlePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('codex.generate-title'),
  params: z.object({ prompt: z.string().min(1).max(4000) }),
});
export type CodexGenerateTitlePayload = z.infer<typeof CodexGenerateTitlePayloadSchema>;

export const CodexLookupTokenPricingPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('codex.lookup-token-pricing'),
  params: z.object({ model: z.string().trim().min(1).max(200) }),
});
export type CodexLookupTokenPricingPayload = z.infer<
  typeof CodexLookupTokenPricingPayloadSchema
>;

export const ExecutorPayloadSchema = z.discriminatedUnion('command', [
  PromptPayloadSchema,
  AgenticToolInvokePayloadSchema,
  WorkspaceFilesListPayloadSchema,
  CodexAuthFilePayloadSchema,
  CodexGenerateTitlePayloadSchema,
  CodexLookupTokenPricingPayloadSchema,
]);
export type ExecutorPayload = z.infer<typeof ExecutorPayloadSchema>;

export const ExecutorResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});
export type ExecutorResult = z.infer<typeof ExecutorResultSchema>;

export function parseExecutorPayload(json: string): ExecutorPayload {
  return ExecutorPayloadSchema.parse(JSON.parse(json));
}

export function getSupportedCommands(): string[] {
  return ExecutorPayloadSchema.options.map((schema) => schema.shape.command.value);
}

export function isPromptPayload(payload: ExecutorPayload): payload is PromptPayload {
  return payload.command === 'prompt';
}
