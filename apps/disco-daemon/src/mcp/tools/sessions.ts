import { AGENTIC_TOOL_CAPABILITIES } from '@disco/agentic-tools';
import { SessionRelationshipRepository } from '@disco/core/db';
import {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  CODEX_MODEL_METADATA,
  COPILOT_MODEL_METADATA,
  CURSOR_MODEL_METADATA,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
} from '@disco/core/models';
import {
  AGENTIC_TOOL_NAMES,
  type AgenticToolName,
  getSessionType,
  type Session,
  type SessionType,
} from '@disco/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SessionsServiceImpl } from '../../declarations.js';
import type { SessionParams } from '../../services/sessions.js';
import { requireActiveAgenticTool } from '../../utils/agentic-tool-runtime.js';
import { ensureCanPromptTargetSession } from '../../utils/session-authorization.js';
import { emitServiceEvent } from '../../utils/emit-service-event.js';
import { resolveMcpServerId, resolveSessionId } from '../resolve-ids.js';
import {
  mcpListLimit,
  mcpOffset,
  mcpOptionalId,
  mcpOptionalNonEmptyString,
  mcpOptionalString,
  mcpPageResult,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { sessionContextRequiredResult, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';
import { listAttachedMcpServers } from './mcp-servers.js';

/**
 * Shared Zod schema for specifying a model override at session-create / spawn /
 * subsession time. Mirrors Session['model_config']: `model` is required (the
 * whole point of this object is to pin a specific model), while `mode`,
 * `effort`, `advisorModel`, and `provider` are optional and fall back to
 * sensible defaults.
 * Wired through to `session.model_config` so the executor actually spawns on
 * the requested model (see query-builder.ts).
 *
 * Accepts two shapes for MCP-client ergonomics:
 *   - String shorthand: `"claude-opus-4-6"` — coerced via `coerceModelConfig`
 *     in each handler to `{ model: "claude-opus-4-6" }`. Most callers just
 *     want to pin a model — forcing them to construct the full object is
 *     hostile UX (and several MCP clients silently drop nested objects in
 *     tool args, see PR #1056 background).
 *   - Full object: `{ mode, model, effort, advisorModel, provider }` for
 *     callers that need to override `mode`/`effort`/`advisorModel`/`provider`.
 *
 * IMPORTANT — no `.transform()` here. Zod's JSON-Schema converter
 * (`zod/v4-mini`'s `toJSONSchema`, used in `mcp/server.ts` to populate the
 * cached registry consumed by `disco_get_tool_details`) throws on
 * transforms with "Transforms cannot be represented in JSON Schema". The
 * catch in `server.ts` then degrades the WHOLE containing tool schema to
 * `{ type: 'object' }`, hiding every input parameter from MCP clients. So
 * normalization happens in `coerceModelConfig` instead, called inline by
 * each handler.
 *
 * Call `disco_models_list` to discover valid model IDs per agenticTool.
 */
const modelConfigObjectSchema = z.object({
  mode: z.enum(['alias', 'exact']).optional().describe("Model selection mode (default: 'alias')"),
  // .min(1): reject empty-string model explicitly so callers don't silently
  // fall through to user defaults when they meant to pin a specific model.
  model: mcpRequiredString(
    'modelConfig.model',
    "Model identifier (e.g. 'claude-opus-4-6', 'claude-sonnet-4-6')"
  ),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe('Reasoning effort level (default: high)'),
  advisorModel: mcpOptionalString(
    'modelConfig.advisorModel',
    "Claude Code advisor model override (e.g. 'opus', 'sonnet', 'fable', or a full model ID)."
  ),
  provider: mcpOptionalString(
    'modelConfig.provider',
    "Provider ID (OpenCode only, e.g. 'anthropic')"
  ),
});

const modelConfigInputSchema = z
  .union([
    mcpRequiredString(
      'modelConfig',
      "Shorthand: just the model ID string (e.g. 'claude-opus-4-6'). Equivalent to { model: <id> }."
    ),
    modelConfigObjectSchema,
  ])
  .optional()
  .describe(
    "Model override for this session. Pass either a model ID string (e.g. 'claude-opus-4-6') or a full { mode, model, effort, advisorModel, provider } object. Overrides the user default model_config and is threaded through to the spawned agent process. Call disco_models_list to discover valid model IDs per agenticTool."
  );

/**
 * Normalize the two input shapes (string shorthand or full object) into the
 * partial-object shape downstream code expects (`ModelConfigInput` from
 * `@disco/core/models`). See `modelConfigInputSchema` for why this lives at
 * the handler boundary instead of as a Zod `.transform()`.
 */
type ModelConfigArg = string | z.infer<typeof modelConfigObjectSchema> | undefined;
function coerceModelConfig(
  input: ModelConfigArg
): z.infer<typeof modelConfigObjectSchema> | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string') return { model: input };
  return input;
}

function redactSessionForMcp<T extends { mcp_token?: unknown }>(
  session: T
): Omit<T, 'mcp_token'> {
  const { mcp_token: _mcpToken, ...safeSession } = session;
  return safeSession;
}

function compactSessionForMcp(session: Session) {
  return {
    session_id: session.session_id,
    title: session.title,
    description: session.description,
    status: session.status,
    agentic_tool: session.agentic_tool,
    url: session.url,
    created_by: session.created_by,
    created_at: session.created_at,
    last_updated: session.last_updated,
    genealogy: session.genealogy,
    task_count: session.tasks?.length ?? 0,
    schedule_id: session.schedule_id,
  };
}

function redactSessionFindResult<T extends { mcp_token?: unknown }>(
  result: T[] | { data: T[]; [key: string]: unknown }
):
  | Array<Omit<T, 'mcp_token'>>
  | {
      data: Array<Omit<T, 'mcp_token'>>;
      [key: string]: unknown;
    } {
  if (Array.isArray(result)) {
    return result.map(redactSessionForMcp);
  }

  return { ...result, data: result.data.map(redactSessionForMcp) };
}

export function registerSessionTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: disco_sessions_list
  server.registerTool(
    'disco_sessions_list',
    {
      description:
        'List a lean page of sessions accessible to the current user. Runtime configuration, context files, task ID arrays, and SDK state are omitted by default; use disco_sessions_get for details or lean:false when required. Advance with offset=nextOffset while hasMore is true.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: mcpListLimit(),
        offset: mcpOffset(),
        lean: z.boolean().optional().describe('Return compact session records (default: true).'),
        status: z
          .enum(['idle', 'running', 'completed', 'failed'])
          .optional()
          .describe('Filter by session status'),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived sessions in results (default: false). By default, archived sessions are excluded.'
          ),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Filter to show ONLY archived sessions. When true, returns only archived sessions. Overrides includeArchived.'
          ),
        sessionType: z
          .enum(['scheduled', 'agent'])
          .optional()
          .describe(
            "Filter by conversation type. 'scheduled' = scheduler-created conversations; 'agent' = ordinary interactive conversations."
          ),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      // When sessionType is set, skip service-level pagination
      // (it runs before our post-query filters) and apply the requested limit
      // ourselves after filtering.
      // Keep handler defaults explicit because unit/in-process callers may
      // invoke captured handlers without going through Zod defaulting.
      const requestedLimit = args.limit ?? 25;
      const requestedOffset = args.offset ?? 0;
      const needsPostQueryLimit = Boolean(args.sessionType);
      if (!needsPostQueryLimit) {
        query.$limit = requestedLimit;
        query.$skip = requestedOffset;
      }
      query.$sort = { created_at: -1, session_id: 1 };
      if (args.status) query.status = args.status;
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      const result = await ctx.app.service('sessions').find({
        query: needsPostQueryLimit ? { ...query, $limit: 10000, $skip: 0 } : query,
        ...ctx.baseServiceParams,
      });

      // Apply post-query filters. sessionType is derived from fields that are
      // not in the query schema.
      if (needsPostQueryLimit) {
        const allData: Session[] = Array.isArray(result) ? result : result.data;
        const filtered = args.sessionType
          ? allData.filter((s) => getSessionType(s) === (args.sessionType as SessionType))
          : allData;
        const limited = filtered.slice(requestedOffset, requestedOffset + requestedLimit);

        if (Array.isArray(result)) {
          const data = limited.map((session) =>
            args.lean === false ? redactSessionForMcp(session) : compactSessionForMcp(session)
          );
          return textResult(mcpPageResult(data, requestedLimit, requestedOffset));
        }
        return textResult(
          mcpPageResult(
            {
              ...result,
              data: limited.map((session) =>
                args.lean === false ? redactSessionForMcp(session) : compactSessionForMcp(session)
              ),
              total: filtered.length,
            },
            requestedLimit,
            requestedOffset
          )
        );
      }

      const page = mcpPageResult(
        redactSessionFindResult(result) as {
          data: Array<Omit<Session, 'mcp_token'>>;
          total?: number;
          limit?: number;
          skip?: number;
        },
        requestedLimit,
        requestedOffset
      );
      return textResult(
        args.lean === false
          ? page
          : { ...page, data: page.data.map((session) => compactSessionForMcp(session as Session)) }
      );
    }
  );

  // Tool 2: disco_sessions_get
  server.registerTool(
    'disco_sessions_get',
    {
      description:
        'Get detailed information about a specific session, including genealogy, current state, and the MCP servers currently attached to it (with OAuth status — check `attached_mcp_servers[].oauth_authenticated` to spot servers needing auth). The response includes a `url` field with a clickable link to view the session in the UI.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID (UUIDv7 or short ID like 01a1b2c3)'
        ),
      }),
    },
    async (args) => {
      const sessionParams: SessionParams = {
        ...ctx.baseServiceParams,
        _include_last_message: true,
        _last_message_truncation_length: 500,
      };
      const session = await ctx.app
        .service('sessions')
        .get(args.sessionId, sessionParams as Parameters<SessionsServiceImpl['get']>[1]);
      const attached_mcp_servers = await listAttachedMcpServers(ctx, session.session_id);
      return textResult({ ...redactSessionForMcp(session), attached_mcp_servers });
    }
  );

  // Tool 3: disco_sessions_get_current
  server.registerTool(
    'disco_sessions_get_current',
    {
      description:
        'Get information about the current Disco conversation and the MCP servers attached to it. The response intentionally omits retired internal workspace carriers and account-external product structure.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const currentSessionId = ctx.sessionId;
      const currentSessionParams: SessionParams = {
        ...ctx.baseServiceParams,
        _include_last_message: true,
        _last_message_truncation_length: 500,
      };
      const session = await ctx.app
        .service('sessions')
        .get(currentSessionId, currentSessionParams as Parameters<SessionsServiceImpl['get']>[1]);

      const attached_mcp_servers = await listAttachedMcpServers(ctx, currentSessionId);

      return textResult({
        session: redactSessionForMcp(session),
        attached_mcp_servers,
      });
    }
  );

  // Tool 4: disco_sessions_spawn
  server.registerTool(
    'disco_sessions_spawn',
    {
      description:
        'Spawn a child conversation for delegated work. It inherits the current conversation workspace and records parent-child genealogy. Configuration comes from the current Agent when staying with that Agent, otherwise from the user defaults.',
      inputSchema: z.object({
        prompt: mcpRequiredString('prompt', 'The prompt/task for the subsession agent to execute'),
        title: mcpOptionalNonEmptyString(
          'title',
          'Optional title for the session (defaults to first 100 chars of prompt)'
        ),
        agenticTool: z
          .enum(AGENTIC_TOOL_NAMES)
          .optional()
          .describe('Which agent to use for the subsession (defaults to same as parent)'),
        enableCallback: z
          .boolean()
          .optional()
          .describe('Enable callback to parent on completion (default: true)'),
        includeLastMessage: z
          .boolean()
          .optional()
          .describe("Include child's final result in callback (default: true)"),
        includeOriginalPrompt: z
          .boolean()
          .optional()
          .describe('Include original spawn prompt in callback (default: false)'),
        extraInstructions: mcpOptionalString(
          'extraInstructions',
          'Extra instructions appended to spawn prompt'
        ),
        taskId: mcpOptionalId('taskId', 'Task', 'Optional task ID to link the spawned session to'),
        mcpServerIds: z
          .array(mcpRequiredId('mcpServerIds[]', 'MCP server'))
          .optional()
          .describe(
            'MCP server IDs to attach. Overrides parent session inheritance. Omit to inherit from parent. Pass empty array for no MCPs.'
          ),
        modelConfig: modelConfigInputSchema,
      }),
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const currentSessionId = ctx.sessionId;
      const spawnData: Partial<import('@disco/core/types').SpawnConfig> = {
        prompt: args.prompt,
        title: args.title,
        agent: args.agenticTool as AgenticToolName | undefined,
        enableCallback: args.enableCallback,
        includeLastMessage: args.includeLastMessage,
        includeOriginalPrompt: args.includeOriginalPrompt,
        extraInstructions: args.extraInstructions,
        task_id: args.taskId,
        mcpServerIds: args.mcpServerIds,
        modelConfig: coerceModelConfig(args.modelConfig),
      };

      const childSession = await (
        ctx.app.service('sessions') as unknown as SessionsServiceImpl
      ).spawn(currentSessionId, spawnData, ctx.baseServiceParams);

      const task = await ctx.app.service('/sessions/:id/prompt').create(
        {
          prompt: args.prompt,
          permissionMode: childSession.permission_config?.mode || 'acceptEdits',
          stream: true,
        },
        {
          ...ctx.baseServiceParams,
          route: { id: childSession.session_id },
        }
      );

      return textResult({
        session: redactSessionForMcp(childSession),
        taskId: task.task_id,
        status: task.status,
        note: 'Subsession created and prompt execution started in background.',
      });
    }
  );

  // Tool 5: disco_sessions_prompt
  server.registerTool(
    'disco_sessions_prompt',
    {
      description:
        'Prompt an existing conversation to continue work. Supports continue, fork (copy at a decision point), subsession (delegate to a child), and btw (an ephemeral side question that does not disrupt the target conversation). Configuration is inherited from the source conversation or user defaults.',
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID to prompt (UUIDv7 or short ID)'
        ),
        prompt: mcpRequiredString('prompt', 'The prompt/task to execute'),
        mode: z
          .enum(['continue', 'fork', 'subsession', 'btw'])
          .describe(
            'How to route the work: continue (add to existing session), fork (create sibling session), subsession (create child session), btw (ephemeral fork — works even on running sessions, auto-callbacks result to caller, auto-archives when done)'
          ),
        agenticTool: z
          .enum(AGENTIC_TOOL_NAMES)
          .optional()
          .describe(
            'Agent for subsession (subsession mode only, defaults to parent agent). Fork mode always uses parent agent.'
          ),
        title: mcpOptionalNonEmptyString('title', 'Session title (for fork/subsession only)'),
        taskId: mcpOptionalId('taskId', 'Task', 'Fork/spawn point task ID (optional)'),
        mcpServerIds: z
          .array(mcpRequiredId('mcpServerIds[]', 'MCP server'))
          .optional()
          .describe(
            'MCP server IDs for subsession mode. Overrides parent inheritance. Omit to inherit from parent. Pass empty array for no MCPs.'
          ),
        modelConfig: modelConfigInputSchema,
        callback: z
          .boolean()
          .optional()
          .describe(
            'Send a one-shot completion report for the exact prompted task back to the current calling Disco session.'
          ),
      }),
    },
    async (args) => {
      const mode = args.mode;
      const sessionId = await resolveSessionId(ctx, args.sessionId);
      if (args.callback && !ctx.sessionId) return sessionContextRequiredResult();
      if (args.callback) {
        await ensureCanPromptTargetSession(ctx.sessionId!, ctx.userId, ctx.app);
      }
      const callbackParams = args.callback
        ? {
            ...ctx.baseServiceParams,
            _taskCompletionCallback: {
              target_session_id: ctx.sessionId!,
              requested_from_session_id: ctx.sessionId!,
              requested_by_user_id: ctx.userId,
            },
          }
        : ctx.baseServiceParams;

      if (mode === 'continue') {
        // The prompt route returns the Task entity directly. Whether it ran
        // immediately or got queued is encoded in `task.status` — there's no
        // separate "queued vs ran" wire shape to branch on.
        const task = await ctx.app
          .service('/sessions/:id/prompt')
          .create(
            { prompt: args.prompt, stream: true },
            { ...callbackParams, route: { id: sessionId } }
          );

        if (task.status === 'queued') {
          return textResult({
            success: true,
            queued: true,
            taskId: task.task_id,
            queue_position: task.queue_position,
            note: 'Session is busy. Prompt has been queued and will execute automatically when the session becomes idle.',
          });
        }
        return textResult({
          success: true,
          taskId: task.task_id,
          status: task.status,
          note: 'Prompt added to existing session and execution started.',
        });
      } else if (mode === 'fork' || mode === 'btw') {
        // Check if the target session's tool supports forking
        const targetSession = await ctx.app
          .service('sessions')
          .get(sessionId, ctx.baseServiceParams);
        const targetTool = requireActiveAgenticTool(targetSession.agentic_tool);
        const caps = AGENTIC_TOOL_CAPABILITIES[targetTool];
        if (caps && !caps.supportsSessionFork) {
          return textResult({
            error: `${targetSession.agentic_tool} does not support session forking. Use mode "subsession" instead to delegate work to a fresh session.`,
          });
        }
        let btwCallbackSessionId: typeof ctx.sessionId;
        if (mode === 'btw') {
          if (!ctx.sessionId) return sessionContextRequiredResult();
          btwCallbackSessionId = ctx.sessionId;
        }

        // Shared fork+prompt flow for both "fork" and "btw" modes
        const forkData: { prompt: string; task_id?: string } = { prompt: args.prompt };
        if (args.taskId) forkData.task_id = args.taskId;

        const forkedSession = await (
          ctx.app.service('sessions') as unknown as SessionsServiceImpl
        ).fork(sessionId, forkData, ctx.baseServiceParams);

        // Build patch for the fork — title for both modes, btw-specific metadata for btw
        const forkPatch: Record<string, unknown> = {};
        if (args.title) forkPatch.title = args.title;

        if (mode === 'btw') {
          forkPatch.fork_origin = 'btw';
          forkPatch.callback_config = {
            enabled: true,
            callback_session_id: btwCallbackSessionId,
            callback_created_by: ctx.userId,
            callback_mode: 'once',
          };
        }

        if (Object.keys(forkPatch).length > 0) {
          await ctx.app
            .service('sessions')
            .patch(forkedSession.session_id, forkPatch, ctx.baseServiceParams);
        }

        const updatedSession = await ctx.app
          .service('sessions')
          .get(forkedSession.session_id, ctx.baseServiceParams);

        const task = await ctx.app.service('/sessions/:id/prompt').create(
          {
            prompt: args.prompt,
            permissionMode: updatedSession.permission_config?.mode,
            stream: true,
          },
          { ...callbackParams, route: { id: forkedSession.session_id } }
        );

        const note =
          mode === 'btw'
            ? 'Ephemeral "btw" fork created. Result will be sent back via callback when done, then the fork will auto-archive.'
            : 'Forked session created and prompt execution started.';

        return textResult({
          session: redactSessionForMcp(updatedSession),
          taskId: task.task_id,
          status: task.status,
          note,
        });
      } else if (mode === 'subsession') {
        const spawnData: Partial<import('@disco/core/types').SpawnConfig> = {
          prompt: args.prompt,
          mcpServerIds: args.mcpServerIds,
          modelConfig: coerceModelConfig(args.modelConfig),
        };
        if (args.title) spawnData.title = args.title;
        if (args.agenticTool) spawnData.agent = args.agenticTool as AgenticToolName;
        if (args.taskId) spawnData.task_id = args.taskId;

        const childSession = await (
          ctx.app.service('sessions') as unknown as SessionsServiceImpl
        ).spawn(sessionId, spawnData, ctx.baseServiceParams);

        const task = await ctx.app.service('/sessions/:id/prompt').create(
          {
            prompt: args.prompt,
            permissionMode: childSession.permission_config?.mode,
            stream: true,
          },
          { ...callbackParams, route: { id: childSession.session_id } }
        );

        return textResult({
          session: redactSessionForMcp(childSession),
          taskId: task.task_id,
          status: task.status,
          note: 'Subsession created and prompt execution started.',
        });
      }

      return textResult({ error: `Unknown mode: ${mode}` });
    }
  );

  // Tool 5b: disco_session_relationships_list
  server.registerTool(
    'disco_session_relationships_list',
    {
      description:
        'List durable non-genealogy relationships for a conversation, including remotely created child/parent links. Defaults to the current conversation.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: mcpOptionalId(
          'sessionId',
          'Session',
          'Session ID to inspect (defaults to current session)'
        ),
      }),
    },
    async (args) => {
      const sessionId = args.sessionId
        ? await resolveSessionId(ctx, args.sessionId)
        : ctx.sessionId;
      if (!sessionId) return sessionContextRequiredResult();

      // Validate normal session access/RBAC before returning links.
      await ctx.app.service('sessions').get(sessionId, ctx.baseServiceParams);

      const relationships = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new SessionRelationshipRepository(db).findForSession(sessionId)
      );
      return textResult({ relationships });
    }
  );

  // Tool 5c: disco_session_relationships_set_callback
  server.registerTool(
    'disco_session_relationships_set_callback',
    {
      description:
        'Enable or disable callback/report-back delivery for a durable session relationship without deleting the relationship itself.',
      inputSchema: z.object({
        relationshipId: mcpRequiredString(
          'relationshipId',
          'Session relationship ID returned by disco_session_relationships_list'
        ),
        callbackEnabled: z.boolean().describe('Whether the remote child should report back.'),
      }),
    },
    async (args) => {
      const relationshipId =
        args.relationshipId as import('@disco/core/types').SessionRelationshipID;
      const existingRelationship = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new SessionRelationshipRepository(db).get(relationshipId)
      );

      // Authorize visibility/access before mutating the durable relationship.
      // Reading both sides through the sessions service keeps this tool aligned
      // with normal session RBAC instead of treating relationship IDs as ambient
      // authority.
      await ctx.app
        .service('sessions')
        .get(existingRelationship.source_session_id, ctx.baseServiceParams);
      const targetSession = await ctx.app
        .service('sessions')
        .get(existingRelationship.target_session_id, ctx.baseServiceParams);

      const relationship = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new SessionRelationshipRepository(db).setCallbackEnabled(
          relationshipId,
          args.callbackEnabled
        )
      );
      const callbackSessionId = relationship.callback_session_id ?? relationship.source_session_id;
      await ctx.app.service('sessions').patch(
        relationship.target_session_id,
        {
          callback_config: {
            ...(targetSession.callback_config ?? {}),
            enabled: args.callbackEnabled,
            callback_session_id: callbackSessionId,
          },
        },
        {
          ...ctx.baseServiceParams,
          _skipRelationshipCallbackSync: true,
        } as typeof ctx.baseServiceParams
      );

      return textResult({ relationship });
    }
  );

  // Tool 7: disco_sessions_update
  server.registerTool(
    'disco_sessions_update',
    {
      description:
        'Update session metadata (title, description, status, archived, callback config). Useful for agents to self-document their work or manage callback settings.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID to update (UUIDv7 or short ID)'
        ),
        title: mcpOptionalString('title', 'New session title (optional)'),
        description: mcpOptionalString('description', 'New session description (optional)'),
        status: z
          .enum(['idle', 'running', 'completed', 'failed'])
          .optional()
          .describe('New session status (optional)'),
        archived: z
          .boolean()
          .optional()
          .describe('Set archive state. true to archive, false to unarchive (optional)'),
        enableCallback: z
          .boolean()
          .optional()
          .describe('Enable or disable callbacks on this session (optional)'),
        callbackMode: z
          .enum(['once', 'persistent'])
          .optional()
          .describe(
            'Callback mode: "once" fires once then auto-disables, "persistent" fires every time (optional)'
          ),
      }),
    },
    async (args) => {
      const updates: Record<string, unknown> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;
      if (args.archived !== undefined) {
        updates.archived = args.archived;
        updates.archived_reason = args.archived ? 'manual' : undefined;
      }

      // Handle callback config updates
      if (args.enableCallback !== undefined || args.callbackMode !== undefined) {
        const sessionId = await resolveSessionId(ctx, args.sessionId);
        const existingSession = await ctx.app
          .service('sessions')
          .get(sessionId, ctx.baseServiceParams);
        const existingCallback = existingSession.callback_config || {};
        updates.callback_config = {
          ...existingCallback,
          ...(args.enableCallback !== undefined ? { enabled: args.enableCallback } : {}),
          ...(args.callbackMode !== undefined ? { callback_mode: args.callbackMode } : {}),
        };
      }

      if (Object.keys(updates).length === 0) {
        throw new Error(
          'At least one field (title, description, status, archived, enableCallback, callbackMode) must be provided'
        );
      }

      const session = await ctx.app
        .service('sessions')
        .patch(args.sessionId, updates, ctx.baseServiceParams);
      return textResult({
        session: redactSessionForMcp(session),
        note: 'Session updated successfully.',
      });
    }
  );

  // Tool 8: disco_sessions_archive
  server.registerTool(
    'disco_sessions_archive',
    {
      description:
        'Archive a session (soft delete). Archived sessions are hidden from listings by default but can be restored. By default, all child sessions (forks and subsessions) are also archived. Set includeChildren to false to archive only the target session.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID to archive (UUIDv7 or short ID)'
        ),
        includeChildren: z
          .boolean()
          .optional()
          .describe('Also archive all child sessions (forks and subsessions). Default: true.'),
      }),
    },
    async (args) => {
      const includeChildren = args.includeChildren !== false;
      const sessionsService = ctx.app.service('sessions') as unknown as SessionsServiceImpl;
      const result = await sessionsService.archive(
        args.sessionId,
        { includeChildren },
        ctx.baseServiceParams
      );

      return textResult({
        success: true,
        archivedCount: result.count,
        message: `Archived ${result.count} session(s).`,
      });
    }
  );

  // Tool 9: disco_sessions_unarchive
  server.registerTool(
    'disco_sessions_unarchive',
    {
      description:
        'Restore a previously archived session. By default, all child sessions are also unarchived. Set includeChildren to false to unarchive only the target session.',
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID to unarchive (UUIDv7 or short ID)'
        ),
        includeChildren: z
          .boolean()
          .optional()
          .describe('Also unarchive all child sessions (forks and subsessions). Default: true.'),
      }),
    },
    async (args) => {
      const includeChildren = args.includeChildren !== false;
      const sessionsService = ctx.app.service('sessions') as unknown as SessionsServiceImpl;
      const result = await sessionsService.unarchive(
        args.sessionId,
        { includeChildren },
        ctx.baseServiceParams
      );

      return textResult({
        success: true,
        unarchivedCount: result.count,
        message: `Unarchived ${result.count} session(s).`,
      });
    }
  );

  // Tool 12: disco_sessions_stop
  server.registerTool(
    'disco_sessions_stop',
    {
      description:
        'Request that a running session stop. The session becomes idle only after Disco verifies executor quiescence or process absence; otherwise it remains guarded in stopping. Use this for emergency stops, timeout-based cancellation, or human-in-the-loop gates. Only works on sessions in active states (running, stopping, awaiting_permission, awaiting_input).',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        sessionId: mcpRequiredId('sessionId', 'Session', 'Session ID to stop (UUIDv7 or short ID)'),
        reason: mcpOptionalString(
          'reason',
          'Audit log reason for the stop (e.g. "timeout", "user requested", "safety gate")'
        ),
      }),
    },
    async (args) => {
      const sessionId = await resolveSessionId(ctx, args.sessionId);

      const result = await ctx.app
        .service('/sessions/:id/stop')
        .create(
          { ...(args.reason ? { reason: args.reason } : {}) },
          { ...ctx.baseServiceParams, route: { id: sessionId } }
        );

      const stopResult = result as { success: boolean; status?: string; reason?: string };

      if (!stopResult.success) {
        return textResult({
          success: false,
          sessionId,
          error: stopResult.reason || 'Failed to stop session',
        });
      }

      return textResult({
        success: true,
        sessionId,
        status: stopResult.status,
        ...(args.reason ? { reason: args.reason } : {}),
        note: stopResult.reason || 'Session stopped successfully.',
      });
    }
  );

  // Tool 13: disco_models_list
  //
  // Discovery tool so MCP-driven agents can find valid `model` strings without
  // having to scrape tool descriptions. Sourced from the same in-process model
  // registries the UI uses (packages/core/src/models/*). This reads the
  // registry loaded by the running daemon; it is not provider discovery.
  //
  // Caveats:
  //   - Gemini's authoritative list is fetched live from the Google API per
  //     user (fetchGeminiModels). The hardcoded fallback IS exposed here as a
  //     best-effort starter list.
  //   - Copilot and Cursor have dynamic discovery exposed via /copilot-models
  //     and /cursor-models in the daemon. Static fallbacks are exposed here.
  //   - OpenCode is a provider+model matrix and doesn't have a single static
  //     list. Its entry explains that discovery happens after provider choice.
  server.registerTool(
    'disco_models_list',
    {
      description:
        'List selectable model aliases grouped by agenticTool. Use this to discover what to pass for `modelConfig` (or its string shorthand) in spawn or prompt operations. Lists the registry loaded by the running daemon; provider-specific exact IDs may be account-dependent.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agenticTool: z
          .enum(AGENTIC_TOOL_NAMES)
          .optional()
          .describe('Filter to a single agentic tool. Omit to return all tools.'),
      }),
    },
    async (args) => {
      const claudeModels = AVAILABLE_CLAUDE_MODEL_ALIASES.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        family: m.family,
      }));

      const codexModels = Object.entries(CODEX_MODEL_METADATA).map(([id, meta]) => ({
        id,
        displayName: meta.name,
        description: meta.description,
        status: meta.status,
        availability: meta.availability,
      }));

      const copilotModels = Object.entries(COPILOT_MODEL_METADATA).map(([id, meta]) => ({
        id,
        displayName: meta.name,
        description: meta.description,
        provider: meta.provider,
      }));

      // Note: Gemini's live list comes from the Google API (per-user API key).
      // We surface the hardcoded fallback so agents have *something* to pass —
      // but more recent models may exist on the user's account.
      const geminiModels = Object.entries(GEMINI_MODELS).map(([id, meta]) => ({
        id,
        displayName: meta.name,
        description: meta.description,
        useCase: meta.useCase,
      }));

      const all = {
        'claude-code': {
          default: DEFAULT_CLAUDE_MODEL,
          models: claudeModels,
          note: 'Claude models are also fetched live via /claude-models (uses the Anthropic Models API). This is the static fallback.',
        },
        codex: {
          default: DEFAULT_CODEX_MODEL,
          models: codexModels,
          note: 'Latest models are listed first; omit modelConfig to use the default. Current models are supported defaults; older entries marked provider-dependent may vary by Codex account and are checked by Codex at startup. This is Disco’s known-model registry, not a dynamic Codex CLI/provider listing. Provider-specific IDs absent from this list must be passed with mode "exact". Known unsupported legacy aliases are omitted.',
        },
        gemini: {
          default: DEFAULT_GEMINI_MODEL,
          models: geminiModels,
          note: 'Gemini models are normally fetched live from the Google API per-user. This is the static fallback list — newer models may exist.',
        },
        opencode: {
          default: null,
          models: [],
          note: 'OpenCode models are provider-specific and are discovered after selecting a provider. Pass both modelConfig.provider and modelConfig.model from the OpenCode provider catalog.',
        },
        copilot: {
          default: DEFAULT_COPILOT_MODEL,
          models: copilotModels,
          note: "Copilot models are also fetched live via /copilot-models (uses the SDK's listModels()). This is the static fallback — BYOK-configured models may not appear here.",
        },
        cursor: {
          default: DEFAULT_CURSOR_MODEL,
          models: [
            {
              id: DEFAULT_CURSOR_MODEL,
              displayName: CURSOR_MODEL_METADATA[DEFAULT_CURSOR_MODEL].displayName,
              description: CURSOR_MODEL_METADATA[DEFAULT_CURSOR_MODEL].description,
            },
          ],
          note: "Cursor models are also fetched live via /cursor-models (uses @cursor/sdk's Cursor.models.list()). This is the static fallback — account-specific models may not appear here.",
        },
      } satisfies Record<
        AgenticToolName,
        { default: string | null; models: unknown[]; note: string }
      >;

      if (args.agenticTool) {
        return textResult({ [args.agenticTool]: all[args.agenticTool] });
      }
      return textResult(all);
    }
  );
}
