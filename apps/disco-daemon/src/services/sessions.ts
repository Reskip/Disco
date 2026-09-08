/**
 * Sessions Service
 *
 * Provides REST + WebSocket API for session management.
 * Uses DrizzleService adapter with SessionRepository.
 */

import { mkdir } from 'node:fs/promises';

import { getAgenticToolModelConfiguration } from '@disco/agentic-tools';
import {
  resolveDiscoAgentSessionWorkingDirectory,
  resolveDiscoStandaloneSessionWorkingDirectory,
  resolveDiscoUserWorkspaceDirectory,
} from '@disco/core';
import {
  prepareDiscoAgentRuntimeContext,
  writeDiscoAgentPreloadFailure,
} from '@disco/core/agent-runtime';
import {
  isResolvedAgenticToolModelConfiguration,
  materializeAgenticToolConfiguration,
} from '@disco/agentic-tools/config';
import { isTenantAgenticToolEnabled, PAGINATION, getWorktreesRoot } from '@disco/core/config';
import {
  AgentRepository,
  bindRepositoryToTenantUnitOfWork,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  SessionEnvSelectionRepository,
  SessionMCPServerRepository,
  SessionRelationshipRepository,
  SessionRepository,
  generateId,
  type SessionWithLastMessage,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';
import {
  type Application,
  BadRequest,
  Conflict,
  Forbidden,
  NotAuthenticated,
} from '@disco/core/feathers';
import {
  formatModelToolMismatchWarning,
  getCodexModelSelectionError,
  isInvalidModelConfigError,
  isResolvedModelConfig,
  lintModelToolMatch,
} from '@disco/core/models';
import type {
  AgenticToolName,
  AuthenticatedParams,
  CreateSessionInput,
  MCPServerID,
  Paginated,
  QueryParams,
  Session,
  SessionID,
  SessionUpdate,
  TaskID,
  UUID,
} from '@disco/core/types';
import {
  isAgenticToolDefaultConfigurationReference,
  SessionStatus,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
} from '@disco/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { requireActiveAgenticTool } from '../utils/agentic-tool-runtime.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { parseLastMessageTruncationLength } from '../utils/query-params.js';
import { deploymentAgenticToolUnavailableMessage } from './agentic-tool-deployment.js';

type MaterializedAgenticToolConfiguration = Awaited<
  ReturnType<typeof materializeAgenticToolConfiguration>
>;

type SessionArchiveReason = NonNullable<Session['archived_reason']>;
type SessionArchiveTarget = {
  session: Session;
  archived: boolean;
  archivedReason: SessionArchiveReason | null;
};

const MANUAL_ARCHIVED_REASON = 'manual' satisfies SessionArchiveReason;
const PARENT_ARCHIVED_REASON = 'parent_archived' satisfies SessionArchiveReason;

function sessionConfigurationSource(
  data: Pick<CreateSessionInput, 'model_config' | 'permission_config'>
): import('@disco/core/types').AgenticToolConfigurationSource {
  return {
    configuration: {
      modelConfig: data.model_config ?? undefined,
      permissionMode: data.permission_config?.mode,
      codexSandboxMode: data.permission_config?.codex?.sandboxMode,
      codexApprovalPolicy: data.permission_config?.codex?.approvalPolicy,
      codexNetworkAccess: data.permission_config?.codex?.networkAccess,
    },
  };
}

function resolvedSessionPresetId(
  reference: CreateSessionInput['agentic_tool_preset_id']
): Session['agentic_tool_preset_id'] {
  if (reference && isAgenticToolDefaultConfigurationReference(reference)) {
    throw new BadRequest('agentic_tool_preset_id must be resolved before session creation');
  }
  return reference;
}

function resolvedSessionModelConfig(
  modelConfig: CreateSessionInput['model_config']
): Session['model_config'] {
  if (modelConfig == null) return modelConfig;
  if (!isResolvedModelConfig(modelConfig)) {
    throw new BadRequest('model_config must be resolved before session creation');
  }
  return modelConfig;
}

/**
 * Internal service params shared between services that support last-message enrichment.
 * Bypasses Feathers query filtering for internal service-to-service calls.
 */
export interface InternalEnrichmentParams {
  /** Root-level truncation length (bypasses Feathers query filtering, used by internal service calls) */
  _last_message_truncation_length?: number;
}

/**
 * Session service params
 */
export type SessionParams = QueryParams<{
  status?: Session['status'];
  agentic_tool?: Session['agentic_tool'];
  include_last_message?: boolean | 'true' | 'false'; // Opt-in last message enrichment
  last_message_truncation_length?: number; // Default: 500 chars, min: 50, max: 10000
  /** Marks a `remove` as the delete half of a "switch tool" swap (see `remove`). */
  _swapReplace?: boolean;
}> &
  AuthenticatedParams &
  InternalEnrichmentParams & {
    /** Root-level include_last_message flag (bypasses Feathers query filtering, used by internal service calls) */
    _include_last_message?: boolean | 'true' | 'false';
    /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
    _discoSqlSessionAccessUserId?: UUID;
    /** Disco personal-workspace boundary; unlike RBAC this never grants admin bypass. */
    _discoSqlSessionOwnerUserId?: UUID;
    /** Internal task-start reconciliation of a live preset. */
    _applyingAgenticToolPreset?: boolean;
    /**
     * Internal caller already resolved permission/model fallbacks and must not inherit user defaults.
     * Root-level service params are server-controlled; transport query/data cannot set this marker.
     */
    _agenticConfigResolved?: boolean;
  };

/**
 * Whether a sessions `find` query should be served by `SessionRepository.findPage`
 * (SQL recency sort + limit/offset) rather than the generic in-memory path. We
 * only divert the loader's bounded list queries that sort by `updated_at`, and
 * only when the rest of the query is a shape findPage fully models (archived +
 * pagination). Anything
 * with extra filters, operators, or `$select` falls through to the existing path
 * so we never silently drop semantics findPage doesn't implement.
 */
function shouldSqlPageSessionQuery(query?: Record<string, unknown>, forcePage = false): boolean {
  if (!query) return forcePage;

  const sort = query.$sort as Record<string, unknown> | undefined;
  const wantsRecency = !!sort && sort.updated_at !== undefined;
  if (!wantsRecency && !forcePage) return false;

  const allowedKeys = new Set(['archived', '$sort', '$limit', '$skip']);
  for (const key of Object.keys(query)) {
    if (!allowedKeys.has(key)) return false;
  }
  if (query.archived !== undefined && typeof query.archived !== 'boolean') return false;
  if (sort) {
    const sortKeys = Object.keys(sort);
    if (sortKeys.length !== 1 || sortKeys[0] !== 'updated_at') return false;
    if (sort.updated_at !== 1 && sort.updated_at !== -1) return false;
  }
  return true;
}

const remoteRelationshipsEnrichedResults = new WeakSet<object>();

export function markRemoteRelationshipsEnrichedResult<T extends object>(result: T): T {
  remoteRelationshipsEnrichedResults.add(result);
  return result;
}

export function isRemoteRelationshipsEnrichedResult(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null && remoteRelationshipsEnrichedResults.has(result)
  );
}

/**
 * Execute task data payload
 * Used by setExecuteHandler, executeTask, and related methods
 */
export type ExecuteTaskData = {
  taskId: string;
  prompt: string;
  permissionMode?: import('@disco/core/types').PermissionMode;
  stream?: boolean;
  messageSource?: import('@disco/core/types').MessageSource;
};

export type SessionArchiveOptions = {
  includeChildren?: boolean;
};

export type SessionArchiveResult = {
  session: Session;
  affectedSessions: Session[];
  count: number;
};

/**
 * Extended sessions service with custom methods
 */
export class SessionsService extends DrizzleService<Session, SessionUpdate, SessionParams> {
  private sessionRepo: SessionRepository;
  private app: Application;
  private sessionMCPRepo: SessionMCPServerRepository;
  private sessionRelationshipRepo: SessionRelationshipRepository;
  private sessionEnvSelectionRepo: SessionEnvSelectionRepository;
  private agentRepo: AgentRepository;
  private taskRepo: TaskRepository;
  private db: TenantScopeAwareDatabase;
  private deploymentAvailable: (tool: AgenticToolName) => boolean;
  private worktreesRoot: (tenantId?: string) => string;

  private assertDeploymentToolConfigured(tool: AgenticToolName): void {
    if (this.deploymentAvailable(tool)) return;
    throw new BadRequest(deploymentAgenticToolUnavailableMessage(tool));
  }

  private assertSupportedModelConfig(
    agenticTool: Session['agentic_tool'],
    modelConfig: Session['model_config'] | undefined
  ): void {
    if (agenticTool !== 'codex' || !modelConfig) return;
    const modelError = getCodexModelSelectionError(modelConfig);
    if (modelError) throw new BadRequest(modelError);
  }

  private async resolveDirectCreateModelFallback(
    agenticTool: AgenticToolName,
    data: CreateSessionInput,
    params?: SessionParams
  ) {
    const policy = getAgenticToolModelConfiguration(agenticTool);
    if (
      !policy?.modelCatalogService ||
      !policy.resolveCatalogFallback ||
      !params?.user ||
      data.created_by !== params.user.user_id
    ) {
      return undefined;
    }
    const app = this.app as unknown as {
      service(path: string): { find(params?: SessionParams): Promise<unknown> };
    };
    const catalog = await app.service(policy.modelCatalogService).find(params);
    return policy.resolveCatalogFallback(catalog);
  }

  constructor(
    db: TenantScopeAwareDatabase,
    app: Application,
    deploymentAvailable: (tool: AgenticToolName) => boolean = () => true,
    worktreesRoot: (tenantId?: string) => string = getWorktreesRoot
  ) {
    const sessionRepo = new SessionRepository(db);
    super(sessionRepo, {
      id: 'session_id',
      resourceType: 'Session',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['patch', 'remove'], // Allow multi-patch and multi-remove
    });

    this.sessionRepo = sessionRepo;
    this.db = db;
    this.deploymentAvailable = deploymentAvailable;
    this.worktreesRoot = worktreesRoot;
    this.app = app;
    // Custom service-to-service methods such as setMCPServers() can run with
    // tenant identity but without a request-scoped database transaction. Bind
    // this repository to short per-method units so those paths remain RLS-safe
    // without extending a transaction across session/provider orchestration.
    this.sessionMCPRepo = bindRepositoryToTenantUnitOfWork(db, new SessionMCPServerRepository(db));
    this.sessionRelationshipRepo = new SessionRelationshipRepository(db);
    this.sessionEnvSelectionRepo = new SessionEnvSelectionRepository(db);
    this.agentRepo = new AgentRepository(db);
    this.taskRepo = new TaskRepository(db);
  }

  /**
   * `agentic_tool` picks the SDK a session's tasks are executed with — it
   * can't change mid-session once a task exists (the messages/tasks already
   * on the session were produced by a specific tool's SDK). The UI only
   * offers "Switch tool" while `session.tasks.length === 0`, but that's a
   * client-side convenience, not a security boundary: any other caller of
   * `sessions.patch` (a stale tab, the MCP session-update tool, CLI) could
   * otherwise desync `agentic_tool` from the tool that actually produced a
   * session's existing tasks/messages. Enforce it here so the constraint
   * holds regardless of caller.
   */
  private async assertAgenticToolMutable(
    sessionId: string,
    nextTool: AgenticToolName
  ): Promise<void> {
    if (nextTool === undefined) return;

    const existing = await this.sessionRepo.findById(sessionId);
    if (!existing || existing.agentic_tool === nextTool) return;
    requireActiveAgenticTool(existing.agentic_tool);

    const taskCount = await this.taskRepo.countBySession(sessionId);
    if (taskCount > 0) {
      // Conflict (409), not Forbidden (403): nothing about the caller's identity
      // is at issue — the session's *state* forbids the change. Matches the
      // sibling `_swapReplace` guard in `remove`.
      throw new Conflict(
        `Cannot change agentic_tool on session ${sessionId}: it already has ${taskCount} task(s). ` +
          "The tool that produced a session's existing tasks/messages cannot be changed after the fact."
      );
    }
  }

  async create(data: CreateSessionInput, params?: SessionParams): Promise<Session>;
  async create(
    data: Partial<Session> | Partial<Session>[],
    params?: SessionParams
  ): Promise<Session | Session[]>;
  async create(
    data: CreateSessionInput | Partial<Session> | Partial<Session>[],
    params?: SessionParams
  ): Promise<Session | Session[]> {
    if (Array.isArray(data)) {
      return Promise.all(data.map((session) => this.create(session, params) as Promise<Session>));
    }
    // Disco's user-facing runtime is Codex.  Keep direct REST/MCP callers on
    // the same default as the UI instead of silently reviving Agor's legacy
    // Claude default when `agentic_tool` is omitted.
    const agenticTool = requireActiveAgenticTool(data.agentic_tool ?? 'codex');
    this.assertDeploymentToolConfigured(agenticTool);
    if (!(await isTenantAgenticToolEnabled(agenticTool, this.db))) {
      throw new BadRequest(`${agenticTool} is disabled for this workspace`);
    }
    const {
      agentic_tool_preset_id: configurationReference,
      model_config: originalModelConfig,
      ...sessionData
    } = data;
    let createData: Partial<Session> = { ...sessionData };
    if (params?._agenticConfigResolved) {
      createData = {
        ...createData,
        agentic_tool_preset_id: resolvedSessionPresetId(configurationReference),
        model_config: resolvedSessionModelConfig(originalModelConfig),
      };
    } else {
      const source = configurationReference
        ? ({ reference: configurationReference } as const)
        : data.model_config != null || data.permission_config != null
          ? sessionConfigurationSource(data)
          : ({ reference: USER_DEFAULT_AGENTIC_CONFIGURATION } as const);
      let materialized: MaterializedAgenticToolConfiguration;
      try {
        materialized = await materializeAgenticToolConfiguration(this.db, {
          tool: agenticTool,
          source,
          executionOwnerId: data.created_by as import('@disco/core/types').UserID | undefined,
        });
      } catch (error) {
        const shouldUseCatalogFallback =
          isInvalidModelConfigError(error) &&
          (!configurationReference ||
            isAgenticToolDefaultConfigurationReference(configurationReference));
        if (!shouldUseCatalogFallback) {
          throw error;
        }
        const modelFallback = await this.resolveDirectCreateModelFallback(
          agenticTool,
          data as CreateSessionInput,
          params
        );
        materialized = await materializeAgenticToolConfiguration(this.db, {
          tool: agenticTool,
          source,
          executionOwnerId: data.created_by as import('@disco/core/types').UserID | undefined,
          modelFallback,
        });
      }
      createData = {
        ...createData,
        agentic_tool_preset_id: materialized.agentic_tool_preset_id,
        permission_config: materialized.permission_config,
        model_config: materialized.model_config,
      };
    }
    const modelPolicy = getAgenticToolModelConfiguration(agenticTool);
    if (
      modelPolicy?.isResolved &&
      !isResolvedAgenticToolModelConfiguration(agenticTool, createData.model_config)
    ) {
      throw new BadRequest(modelPolicy.missingSelectionError ?? 'model_config is not resolved');
    }
    if (createData.model_config != null && !createData.model_config.updated_at) {
      throw new BadRequest('model_config must be resolved before session creation');
    }
    this.assertSupportedModelConfig(agenticTool, createData.model_config);
    const createdBy = createData.created_by ?? params?.user?.user_id;
    if (!createdBy) throw new NotAuthenticated('Session creation requires an authenticated user');
    const sessionId = createData.session_id ?? (generateId() as SessionID);
    const requestedAgentId = createData.agent_id ?? null;
    const agent = requestedAgentId
      ? await this.agentRepo.findOwnedById(requestedAgentId, createdBy)
      : null;
    if (requestedAgentId && (!agent || agent.state !== 'ready' || agent.archived)) {
      throw new BadRequest('Agent is unavailable');
    }
    const userRoot = resolveDiscoUserWorkspaceDirectory(
      this.worktreesRoot(getCurrentTenantId()),
      createdBy
    );
    const workingDirectory = agent
      ? resolveDiscoAgentSessionWorkingDirectory(agent.workspace_path, sessionId)
      : resolveDiscoStandaloneSessionWorkingDirectory(userRoot, sessionId);
    createData = {
      ...createData,
      session_id: sessionId,
      created_by: createdBy,
      agent_id: agent?.agent_id ?? null,
      working_directory: workingDirectory,
    };

    const created = await super.create(createData, params);
    if (Array.isArray(created)) {
      throw new Error('Single-session creation returned multiple sessions');
    }
    await mkdir(workingDirectory, { recursive: true });
    if (agent) {
      try {
        // This is an invisible filesystem preload, not a chat task. Returning
        // the newly-created Session only after this snapshot exists makes the
        // first user prompt reuse the prepared context instead of racing a
        // second initializer.
        prepareDiscoAgentRuntimeContext({
          agentWorkspace: agent.workspace_path,
          sessionWorkspace: workingDirectory,
        });
      } catch (error) {
        // Agent creation must remain recoverable when the workspace is still
        // materializing. The real prompt path repeats the preparation after
        // synchronizing the canonical profile and replaces this failure.
        try {
          writeDiscoAgentPreloadFailure(workingDirectory, error);
        } catch {
          // The prompt path will surface the original filesystem problem.
        }
        console.warn(
          `[SessionsService] Agent context preload deferred for ${created.session_id}:`,
          error
        );
      }
    }
    return created;
  }

  /** Re-resolve a live preset immediately before a task starts. */
  async materializeAgenticToolPreset(session: Session, _params?: SessionParams): Promise<Session> {
    const agenticTool = requireActiveAgenticTool(session.agentic_tool);
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new Error('Missing active tenant context for agentic tool preset materialization');
    }

    return runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
      if (!session.agentic_tool_preset_id) {
        const policy = getAgenticToolModelConfiguration(agenticTool);
        if (
          policy?.isResolved &&
          !isResolvedAgenticToolModelConfiguration(agenticTool, session.model_config)
        ) {
          throw new BadRequest(policy.missingSelectionError ?? 'model_config is not resolved');
        }
        return session;
      }
      const materialized = await materializeAgenticToolConfiguration(tenantDb, {
        tool: agenticTool,
        source: { reference: session.agentic_tool_preset_id },
        executionOwnerId: session.created_by as import('@disco/core/types').UserID,
      });
      this.assertSupportedModelConfig(agenticTool, materialized.model_config);
      return this.sessionRepo.update(
        session.session_id,
        {
          permission_config: materialized.permission_config,
          model_config: materialized.model_config,
        },
        {
          replaceAgenticConfig: true,
        }
      );
    });
  }

  protected async fetchData(_query: Query, params?: SessionParams): Promise<Session[]> {
    return this.sessionRepo.findAll({
      visibleToUserId: params?._discoSqlSessionAccessUserId,
    });
  }

  async enrichRemoteRelationships(sessionList: Session[]): Promise<Session[]> {
    const sessionIds = sessionList.map((session) => session.session_id);
    if (sessionIds.length === 0) return sessionList;

    const relationships = await this.sessionRelationshipRepo.findForSessions(sessionIds);
    if (relationships.length === 0) return sessionList;

    const bySessionId = new Map<SessionID, NonNullable<Session['remote_relationships']>>();

    for (const relationship of relationships) {
      const sourceBucket =
        bySessionId.get(relationship.source_session_id) ??
        ({ as_source: [], as_target: [] } satisfies NonNullable<Session['remote_relationships']>);
      sourceBucket.as_source?.push(relationship);
      bySessionId.set(relationship.source_session_id, sourceBucket);

      const targetBucket =
        bySessionId.get(relationship.target_session_id) ??
        ({ as_source: [], as_target: [] } satisfies NonNullable<Session['remote_relationships']>);
      targetBucket.as_target?.push(relationship);
      bySessionId.set(relationship.target_session_id, targetBucket);
    }

    return sessionList.map((session) => {
      const remoteRelationships = bySessionId.get(session.session_id);
      if (!remoteRelationships) return session;
      return { ...session, remote_relationships: remoteRelationships };
    });
  }

  /**
   * Attach explicit MCP server IDs to a session.
   * Emits WebSocket events so the UI updates in real-time.
   */
  async setMCPServers(sessionId: SessionID, serverIds: string[], label: string): Promise<void> {
    for (const serverId of serverIds) {
      try {
        await this.sessionMCPRepo.addServer(sessionId, serverId as MCPServerID);
        emitServiceEvent(this.app, {
          path: 'session-mcp-servers',
          event: 'created',
          data: {
            session_id: sessionId,
            mcp_server_id: serverId,
            enabled: true,
            added_at: new Date(),
          },
        });
      } catch (error) {
        // Dropping one server rather than failing the whole session is the
        // established behaviour here, and the right one for inherited and
        // default selections. Say why, though: "skipped" alone cannot tell an
        // ownership refusal from a deleted row or a database fault, and the
        // first of those is the only one a user can act on.
        console.warn(
          `Skipped MCP server ${serverId} during ${label}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  /**
   * Copy MCP servers from a source session to a target session.
   * Emits WebSocket events so the UI updates in real-time.
   */
  private async copyMCPServers(
    sourceSessionId: SessionID,
    targetSessionId: SessionID,
    label: string
  ): Promise<void> {
    try {
      const parentServers = await this.sessionMCPRepo.listServers(sourceSessionId, true);
      for (const server of parentServers) {
        try {
          await this.sessionMCPRepo.addServer(targetSessionId, server.mcp_server_id as MCPServerID);
          // Emit WebSocket event for real-time UI updates
          emitServiceEvent(this.app, {
            path: 'session-mcp-servers',
            event: 'created',
            data: {
              session_id: targetSessionId,
              mcp_server_id: server.mcp_server_id,
              enabled: true,
              added_at: new Date(),
            },
          });
        } catch {
          // Silently skip — server may have been deleted between list and add
        }
      }
    } catch (error) {
      console.warn(`Failed to copy MCP servers during ${label}:`, error);
    }
  }

  /** Resolve the direct owner for a child Session. */
  private async resolveChildOwner(parent: Session, params?: SessionParams): Promise<string> {
    if (!params?.provider) return parent.created_by;
    const callerId = params.user?.user_id;
    if (!callerId) {
      throw new Forbidden('Cannot spawn/fork a Session without an authenticated user.');
    }
    if (callerId !== parent.created_by) {
      throw new Forbidden('A Session may only be continued or forked by its owner.');
    }
    return callerId;
  }

  /**
   * Custom method: Fork a session
   *
   * Creates a new Session fork from the current Session at a decision point.
   */
  async fork(
    id: string,
    data: { prompt: string; task_id?: string },
    params?: SessionParams
  ): Promise<Session> {
    const parent = await this.get(id, params);
    const parentTool = requireActiveAgenticTool(parent.agentic_tool);

    const created_by = await this.resolveChildOwner(parent, params);
    const inherited = await materializeAgenticToolConfiguration(this.db, {
      tool: parentTool,
      source: parent.agentic_tool_preset_id
        ? { reference: parent.agentic_tool_preset_id }
        : sessionConfigurationSource(parent),
      executionOwnerId: created_by as import('@disco/core/types').UserID,
    });
    this.assertSupportedModelConfig(parentTool, inherited.model_config);

    const forkedSession = await this.create(
      {
        agentic_tool: parentTool,
        agentic_tool_preset_id: inherited.agentic_tool_preset_id,
        status: SessionStatus.IDLE,
        title: data.prompt.substring(0, 100), // First 100 chars as title
        description: data.prompt,
        created_by,
        genealogy: {
          forked_from_session_id: parent.session_id,
          fork_point_task_id: data.task_id as TaskID,
          fork_point_message_index: await this.sessionRepo.countMessages(parent.session_id),
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        permission_config: inherited.permission_config,
        model_config: inherited.model_config,
        tasks: [],
        // Don't copy sdk_session_id - fork will get its own via forkSession:true
      },
      { ...params, _agenticConfigResolved: true }
    );

    // Cast forkedSession to Session to handle return type
    const session = forkedSession as Session;

    // Copy MCP servers from parent session to forked session
    await this.copyMCPServers(
      parent.session_id as SessionID,
      session.session_id as SessionID,
      'fork'
    );

    // Copy parent's env var *names* to forked session.
    // Names resolve at execution time against the child session's owner's
    // env vars (see env-var-access.md), so when a cross-user fork happens
    // these names are looked up under the caller's namespace, not the parent
    // owner's — no leakage of parent credentials into a fork the caller owns.
    const parentEnvSelections = await this.sessionEnvSelectionRepo.listNames(
      parent.session_id as SessionID
    );
    if (parentEnvSelections.length > 0) {
      await this.sessionEnvSelectionRepo.setAll(
        session.session_id as SessionID,
        parentEnvSelections
      );
    }

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /** Spawn a child after atomically materializing its selected source for the child owner. */
  async spawn(
    id: string,
    data: Partial<import('@disco/core/types').SpawnConfig>,
    params?: SessionParams
  ): Promise<Session> {
    if (!data.prompt) {
      throw new Error('Spawn requires a prompt');
    }
    const parent = await this.get(id, params);
    requireActiveAgenticTool(parent.agentic_tool);
    const targetTool = requireActiveAgenticTool(data.agent || parent.agentic_tool);
    const hasAtomicOverride =
      data.permissionMode !== undefined ||
      data.modelConfig !== undefined ||
      data.codexSandboxMode !== undefined ||
      data.codexApprovalPolicy !== undefined ||
      data.codexNetworkAccess !== undefined;
    const inheritedPresetId =
      targetTool === parent.agentic_tool ? parent.agentic_tool_preset_id : undefined;
    const presetId = data.presetId ?? inheritedPresetId ?? undefined;
    if (presetId && hasAtomicOverride) {
      throw new BadRequest(
        'Preset-backed child sessions cannot override individual configuration fields'
      );
    }

    const created_by = await this.resolveChildOwner(parent, params);

    // Preload the child owner when the app service is available; the shared
    // materializer can also resolve the owner directly from its scoped DB.
    let user: import('@disco/core/types').User | null = null;
    if (created_by && this.app) {
      try {
        user = (await this.app
          .service('users')
          .get(created_by, params)) as import('@disco/core/types').User;
      } catch (error) {
        console.warn(
          'Could not fetch user preferences for spawned session, using system defaults:',
          error
        );
      }
    }

    let resolved: MaterializedAgenticToolConfiguration;
    try {
      resolved = await materializeAgenticToolConfiguration(this.db, {
        tool: targetTool,
        source: presetId
          ? { reference: presetId }
          : hasAtomicOverride || targetTool === parent.agentic_tool
            ? {
                configuration: {
                  modelConfig: data.modelConfig,
                  permissionMode: data.permissionMode,
                  codexSandboxMode: data.codexSandboxMode,
                  codexApprovalPolicy: data.codexApprovalPolicy,
                  codexNetworkAccess: data.codexNetworkAccess,
                },
              }
            : { reference: USER_DEFAULT_AGENTIC_CONFIGURATION },
        executionOwnerId: created_by as import('@disco/core/types').UserID,
        ...(user ? { executionOwner: user } : {}),
        parent,
      });
    } catch (error) {
      if (isInvalidModelConfigError(error)) throw new BadRequest(error.message);
      throw error;
    }
    const permissionConfig = resolved.permission_config;
    const modelConfig = resolved.model_config;

    // Soft validation: warn (don't block) when the resolved model looks like
    // it belongs to a different tool. Custom model strings are accepted.
    const lintWarning = formatModelToolMismatchWarning(
      lintModelToolMatch(modelConfig?.model, targetTool)
    );
    if (lintWarning) {
      console.warn(`[SessionsService.spawn] ${lintWarning}`);
    }

    this.assertSupportedModelConfig(targetTool, modelConfig);

    // callback_session_id is the single source of truth for where to deliver
    // callbacks. Default to parent session when callbacks are enabled (which
    // is the default for spawn).
    const isCallbackEnabled = data.enableCallback !== false;
    const callbackConfig = {
      ...(data.enableCallback !== undefined ? { enabled: data.enableCallback } : {}),
      ...(isCallbackEnabled
        ? { callback_session_id: parent.session_id, callback_created_by: parent.created_by }
        : {}),
      ...(data.includeLastMessage !== undefined
        ? { include_last_message: data.includeLastMessage }
        : {}),
      ...(data.includeOriginalPrompt !== undefined
        ? { include_original_prompt: data.includeOriginalPrompt }
        : {}),
      callback_mode: data.callbackMode ?? 'once',
    };

    let finalPrompt = data.prompt;
    if (data.extraInstructions) {
      finalPrompt = `${data.prompt}\n\n${data.extraInstructions}`;
    }

    const spawnedSession = await this.create(
      {
        agentic_tool: targetTool,
        agentic_tool_preset_id: resolved.agentic_tool_preset_id,
        status: SessionStatus.IDLE,
        title: data.title || data.prompt.substring(0, 100), // Use provided title or first 100 chars
        description: finalPrompt, // Use final prompt with extra instructions if provided
        created_by,
        genealogy: {
          parent_session_id: parent.session_id,
          spawn_point_task_id: data.task_id as TaskID,
          spawn_point_message_index: await this.sessionRepo.countMessages(parent.session_id),
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        tasks: [],
        permission_config: permissionConfig,
        model_config: modelConfig,
        callback_config: callbackConfig,
        // Don't copy sdk_session_id - spawn will get its own via forkSession:true
      },
      { ...params, _agenticConfigResolved: true }
    );

    // Cast spawnedSession to Session to handle return type (create returns Session | Session[])
    const session = spawnedSession as Session;

    // MCP servers: explicit mcpServerIds > copy from parent
    // An explicit empty array means "no MCPs" — does NOT fall through to parent.
    if (data.mcpServerIds !== undefined) {
      await this.setMCPServers(session.session_id as SessionID, data.mcpServerIds, 'spawn');
    } else {
      await this.copyMCPServers(
        parent.session_id as SessionID,
        session.session_id as SessionID,
        'spawn'
      );
    }

    // Session env var selections: explicit envVarNames > copy from parent.
    // Only the parent's owner may override selections.
    const callerUserId = params?.user?.user_id as string | undefined;
    const callerIsCreator = callerUserId === parent.created_by;

    if (data.envVarNames !== undefined && callerIsCreator) {
      await this.sessionEnvSelectionRepo.setAll(session.session_id as SessionID, data.envVarNames);
    } else {
      const parentNames = await this.sessionEnvSelectionRepo.listNames(
        parent.session_id as SessionID
      );
      if (parentNames.length > 0) {
        await this.sessionEnvSelectionRepo.setAll(session.session_id as SessionID, parentNames);
      }
    }

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /**
   * Custom method: Execute a prompt on this session
   *
   * Spawns an executor subprocess to run the prompt against the session.
   * The executor connects back to daemon via Feathers/WebSocket.
   *
   * NOTE: The actual implementation is provided by index.ts via setExecuteHandler
   */
  private executeHandler?: (
    sessionId: string,
    data: ExecuteTaskData,
    params?: SessionParams
  ) => Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }>;

  setExecuteHandler(
    handler: (
      sessionId: string,
      data: ExecuteTaskData,
      params?: SessionParams
    ) => Promise<{
      success: boolean;
      taskId: string;
      status: string;
      streaming: boolean;
    }>
  ): void {
    this.executeHandler = handler;
  }

  async executeTask(
    id: string,
    data: ExecuteTaskData,
    params?: SessionParams
  ): Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }> {
    if (this.executeHandler) {
      return this.executeHandler(id, data, params);
    }
    throw new Error('Execute handler not set - cannot execute task');
  }

  /**
   * Custom method: Trigger queue processing
   *
   * Drains the next queued task for an idle session.
   * Used by callback system to trigger immediate queue processing.
   *
   * NOTE: The actual implementation is provided by index.ts via setQueueProcessor
   */
  private queueProcessor?: (sessionId: string, params?: SessionParams) => Promise<void>;

  setQueueProcessor(processor: (sessionId: string, params?: SessionParams) => Promise<void>): void {
    this.queueProcessor = processor;
  }

  async triggerQueueProcessing(id: string, params?: SessionParams): Promise<void> {
    if (this.queueProcessor) {
      await this.queueProcessor(id, params);
    } else {
      console.warn('⚠️  [SessionsService] Queue processor not set, cannot trigger queue processing');
    }
  }

  /**
   * Custom method: Get session genealogy tree
   *
   * Returns ancestors and descendants for visualization.
   */
  async getGenealogy(
    id: string,
    params?: SessionParams
  ): Promise<{
    session: Session;
    ancestors: Session[];
    children: Session[];
  }> {
    const session = await this.get(id, params);

    // Get ancestors
    const ancestors = await this.sessionRepo.findAncestors(id);

    // Get children
    const children = await this.sessionRepo.findChildren(id);

    return {
      session,
      ancestors,
      children,
    };
  }

  private async collectOwnerDescendants(root: Session): Promise<Session[]> {
    return this.sessionRepo.findOwnerDescendants(root.session_id, root.created_by);
  }

  private async assertCanArchiveSessions(
    sessions: Session[],
    archived: boolean,
    params?: SessionParams
  ): Promise<void> {
    if (!params?.provider) return;

    const user = params.user;
    if (!user) {
      throw new NotAuthenticated('Authentication required');
    }

    if (user._isServiceAccount) {
      return;
    }

    const userId = user.user_id as UUID | undefined;
    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    const action = archived ? 'archive sessions' : 'unarchive sessions';

    for (const session of sessions) {
      if (session.created_by !== userId) {
        throw new Forbidden(`Only the Session owner may ${action}.`);
      }
    }
  }

  private async setArchiveStateForTree(
    id: string,
    archived: boolean,
    options: SessionArchiveOptions | undefined,
    params?: SessionParams
  ): Promise<SessionArchiveResult> {
    const root = await this.get(id, params);
    const includeChildren = options?.includeChildren !== false;
    const descendants = includeChildren ? await this.collectOwnerDescendants(root) : [];
    const targets: SessionArchiveTarget[] = [
      {
        session: root,
        archived,
        archivedReason: archived ? MANUAL_ARCHIVED_REASON : null,
      },
    ];

    for (const session of descendants) {
      if (archived) {
        if (!session.archived) {
          targets.push({
            session,
            archived: true,
            archivedReason: PARENT_ARCHIVED_REASON,
          });
        }
        continue;
      }

      if (session.archived_reason === PARENT_ARCHIVED_REASON) {
        targets.push({
          session,
          archived: false,
          archivedReason: null,
        });
      }
    }

    await this.assertCanArchiveSessions(
      targets.map((target) => target.session),
      archived,
      params
    );

    const affectedSessions = await this.sessionRepo.updateArchiveStateForTargets(
      targets.map((target) => ({
        id: target.session.session_id,
        archived: target.archived,
        archivedReason: target.archivedReason,
      }))
    );

    for (const affectedSession of affectedSessions) {
      emitServiceEvent(this.app, {
        path: 'sessions',
        event: 'patched',
        data: affectedSession,
        params,
        id: affectedSession.session_id,
      });
    }

    const [session] = affectedSessions;
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    return {
      session,
      affectedSessions,
      count: affectedSessions.length,
    };
  }

  /**
   * Archive a Session and, by default, its relationship descendants.
   *
   * Generic `patch({ archived })` intentionally remains single-row so bulk
   * archive and auto-cleanup paths keep their existing
   * semantics.
   */
  async archive(
    id: string,
    options?: SessionArchiveOptions,
    params?: SessionParams
  ): Promise<SessionArchiveResult> {
    return this.setArchiveStateForTree(id, true, options, params);
  }

  /**
   * Restore a Session and, by default, its relationship descendants.
   */
  async unarchive(
    id: string,
    options?: SessionArchiveOptions,
    params?: SessionParams
  ): Promise<SessionArchiveResult> {
    return this.setArchiveStateForTree(id, false, options, params);
  }

  /**
   * Override remove to cascade delete children (forks and subsessions)
   */
  async remove(
    id: import('@disco/core/types').NullableId,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    if (id === null) {
      const sessions = (await super.find(params)) as Session[];
      const results: Session[] = [];

      for (const session of sessions) {
        const deleted = await this.removeOne(session.session_id, params, false);
        results.push(deleted);
      }

      return results;
    }

    // "Switch tool" (`chooseAgenticTool` in the UI) removes the session it's
    // replacing as an implementation detail of swapping — never a user-visible
    // delete. It's only offered on a session with zero tasks at the moment the
    // swap is *initiated*, but on a multiplayer canvas a task can land on that
    // same session (another tab, a collaborator, an MCP `disco_sessions_prompt`
    // call) before the swap *completes*. Callers performing that specific swap
    // mark the request via `query._swapReplace`; a normal user-intentional
    // delete of a session with history is unaffected and still allowed.
    //
    // The guard lives here at the top level (not in `removeOne`) so it only
    // gates the replaced session itself. The cascade into children runs through
    // `removeOne`, which never re-evaluates the marker — a child that has gained
    // a task can't abort a legitimate cascade partway through.
    if ((params?.query as { _swapReplace?: boolean } | undefined)?._swapReplace) {
      const taskCount = await this.taskRepo.countBySession(String(id));
      if (taskCount > 0) {
        throw new Conflict(
          `Cannot complete tool switch: session ${id} has gained ${taskCount} task(s) since the switch ` +
            'was initiated. Refresh and try again — the in-flight work has not been touched.'
        );
      }
    }

    return this.removeOne(String(id), params, false);
  }

  private async removeOne(
    id: string,
    params: SessionParams | undefined,
    emitRemoved: boolean
  ): Promise<Session> {
    const session = await this.get(id, params);
    const children = await this.sessionRepo.findChildren(id);

    for (const child of children) {
      await this.removeOne(child.session_id, params, true);
    }

    await this.sessionRepo.delete(id);

    if (emitRemoved) {
      emitServiceEvent(this.app, {
        path: 'sessions',
        event: 'removed',
        data: session,
        params,
        id,
      });
    }

    return session;
  }

  /**
   * Override patch to keep durable relationship callback state synchronized
   * with the existing callback_config.enabled execution switch.
   */
  async patch(
    id: import('@disco/core/types').NullableId,
    data: SessionUpdate,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    let replaceAgenticConfig = false;
    if (
      (id === null || Array.isArray(id)) &&
      (data.agentic_tool !== undefined ||
        data.agentic_tool_preset_id !== undefined ||
        data.model_config !== undefined ||
        data.permission_config !== undefined)
    ) {
      throw new BadRequest('Agentic configuration cannot be changed with a multi-session patch');
    }
    const patchedAgenticTool =
      data.agentic_tool === undefined ? undefined : requireActiveAgenticTool(data.agentic_tool);
    if (patchedAgenticTool && !(await isTenantAgenticToolEnabled(patchedAgenticTool, this.db))) {
      throw new BadRequest(`${patchedAgenticTool} is disabled for this workspace`);
    }
    if (patchedAgenticTool) this.assertDeploymentToolConfigured(patchedAgenticTool);
    // `agentic_tool` is immutable once a session has tasks. Multi-session and
    // array patches that touch it are already rejected above, so the single-id
    // path is the only one that can reach the actual mutation — enforce the
    // guard there, matching the exact target the patch will modify.
    if (data.agentic_tool !== undefined && id !== null && !Array.isArray(id)) {
      await this.assertAgenticToolMutable(String(id), patchedAgenticTool!);
    }
    if (id && !Array.isArray(id) && !params?._applyingAgenticToolPreset) {
      const current = await this.get(String(id), params);
      const mutatesAtomicConfig =
        data.model_config !== undefined ||
        data.permission_config !== undefined ||
        data.agentic_tool !== undefined ||
        data.agentic_tool_preset_id === null;
      if (
        current.agentic_tool_preset_id &&
        mutatesAtomicConfig &&
        data.agentic_tool_preset_id === undefined
      ) {
        throw new BadRequest(
          'Preset-backed session configuration can only be changed by selecting a preset'
        );
      }
      if (data.agentic_tool_preset_id) {
        const tool = requireActiveAgenticTool(data.agentic_tool ?? current.agentic_tool);
        const materialized = await materializeAgenticToolConfiguration(this.db, {
          tool,
          source: { reference: data.agentic_tool_preset_id },
          executionOwnerId: current.created_by as import('@disco/core/types').UserID,
        });
        data = {
          ...data,
          agentic_tool_preset_id: materialized.agentic_tool_preset_id,
          permission_config: materialized.permission_config,
          model_config: materialized.model_config,
        };
        replaceAgenticConfig = true;
      } else if (mutatesAtomicConfig) {
        const tool = requireActiveAgenticTool(data.agentic_tool ?? current.agentic_tool);
        const materialized = await materializeAgenticToolConfiguration(this.db, {
          tool,
          source: sessionConfigurationSource({
            model_config:
              data.model_config === undefined ? current.model_config : data.model_config,
            permission_config:
              data.permission_config === undefined
                ? current.permission_config
                : data.permission_config,
          }),
          executionOwnerId: current.created_by as import('@disco/core/types').UserID,
        });
        data = {
          ...data,
          agentic_tool_preset_id: null,
          permission_config: materialized.permission_config,
          model_config: materialized.model_config,
        };
        replaceAgenticConfig = true;
      }
      // Validate only a newly selected/effective model. Existing persisted
      // sessions remain patchable when the curated registry changes.
      if (
        data.model_config !== undefined ||
        data.agentic_tool !== undefined ||
        data.agentic_tool_preset_id !== undefined
      ) {
        const effectiveTool = requireActiveAgenticTool(data.agentic_tool ?? current.agentic_tool);
        const effectiveModelConfig =
          data.model_config === undefined ? current.model_config : data.model_config;
        const modelPolicy = getAgenticToolModelConfiguration(effectiveTool);
        if (
          modelPolicy?.isResolved &&
          !isResolvedAgenticToolModelConfiguration(effectiveTool, effectiveModelConfig)
        ) {
          throw new BadRequest(modelPolicy.missingSelectionError ?? 'model_config is not resolved');
        }
        this.assertSupportedModelConfig(effectiveTool, effectiveModelConfig);
      }
    }
    const result = (
      replaceAgenticConfig && id && !Array.isArray(id)
        ? await this.sessionRepo.update(String(id), data, { replaceAgenticConfig: true })
        : await super.patch(id, data, params)
    ) as Session | Session[];

    const callbackEnabled = data.callback_config?.enabled;
    if (
      typeof callbackEnabled === 'boolean' &&
      !(params as (SessionParams & { _skipRelationshipCallbackSync?: boolean }) | undefined)
        ?._skipRelationshipCallbackSync
    ) {
      const sessionsToSync = Array.isArray(result) ? result : [result];
      for (const session of sessionsToSync) {
        await this.sessionRelationshipRepo.setCallbackEnabledForTargetSession(
          session.session_id as SessionID,
          callbackEnabled
        );
      }
    }

    return result;
  }

  async update(id: string, data: SessionUpdate, params?: SessionParams): Promise<Session> {
    return (await this.patch(id, data, params)) as Session;
  }

  /**
   * Override get to optionally enrich with last message
   *
   * Last message enrichment is opt-in via include_last_message query parameter
   */
  async get(id: string, params?: SessionParams): Promise<SessionWithLastMessage> {
    // Check both query params and root-level params (root-level bypasses Feathers query filtering)
    const includeLastMessageQuery = params?.query?.include_last_message;
    const includeLastMessageRoot = params?._include_last_message;
    const includeLastMessage = includeLastMessageRoot ?? includeLastMessageQuery;

    const session = await super.get(id, params);
    const [enrichedSession] = await this.enrichRemoteRelationships([session]);
    const sessionWithRelationships = enrichedSession ?? session;

    // Only enrich with last message if explicitly requested
    if (includeLastMessage === true || includeLastMessage === 'true') {
      const truncationLengthQuery = params?.query?.last_message_truncation_length;
      const truncationLengthRoot = params?._last_message_truncation_length;
      const truncationLength = parseLastMessageTruncationLength(
        truncationLengthRoot ?? truncationLengthQuery
      );
      const result = await this.sessionRepo.enrichWithLastMessage(
        sessionWithRelationships as Session,
        truncationLength
      );
      return result;
    }

    return sessionWithRelationships as SessionWithLastMessage;
  }

  /**
   * Override find to include durable remote relationships in list results.
   * Note: Last message is NOT included in list operations - only on single GET.
   */
  async find(params?: SessionParams): Promise<Paginated<Session> | Session[]> {
    // SQL-pushdown path for recency-sorted first-paint queries. The generic
    // adapter sorts on `updated_at`, while the stored field is `last_updated`,
    // so findPage performs the bounded ordering in SQL.
    const query = params?.query as Record<string, unknown> | undefined;
    if (
      shouldSqlPageSessionQuery(
        query,
        !!params?._discoSqlSessionAccessUserId || !!params?._discoSqlSessionOwnerUserId
      )
    ) {
      const sortSpec = query?.$sort as { updated_at?: 1 | -1 } | undefined;
      const limit = (query?.$limit as number | undefined) ?? PAGINATION.DEFAULT_LIMIT;
      const skip = (query?.$skip as number | undefined) ?? 0;
      const { data, total } = await this.sessionRepo.findPage({
        archived: query?.archived as boolean | undefined,
        sortUpdatedAt: sortSpec?.updated_at,
        limit,
        skip,
        visibleToUserId: params?._discoSqlSessionAccessUserId,
        ownerUserId: params?._discoSqlSessionOwnerUserId,
      });
      const enriched = await this.enrichRemoteRelationships(data);
      return markRemoteRelationshipsEnrichedResult({ total, limit, skip, data: enriched });
    }

    if (params?._discoSqlSessionOwnerUserId) {
      const rows = await this.sessionRepo.findAll({
        ownerUserId: params._discoSqlSessionOwnerUserId,
      });
      const residual = (params.query ?? {}) as Query;
      const filtered = this.filterData(rows, residual);
      const total = filtered.length;
      const sorted = this.sortData(filtered, residual.$sort);
      const selected = this.selectFields(sorted, residual.$select);
      const paged = this.paginateData(selected as Session[], residual, total);
      if (Array.isArray(paged)) {
        return markRemoteRelationshipsEnrichedResult(await this.enrichRemoteRelationships(paged));
      }
      return markRemoteRelationshipsEnrichedResult({
        ...paged,
        data: await this.enrichRemoteRelationships(paged.data),
      });
    }

    const result = await super.find(params);

    if (Array.isArray(result)) {
      const enriched = await this.enrichRemoteRelationships(result);
      return markRemoteRelationshipsEnrichedResult(enriched);
    }

    const enrichedData = await this.enrichRemoteRelationships(result.data);
    return markRemoteRelationshipsEnrichedResult({
      ...result,
      data: enrichedData,
    });
  }
}

/**
 * Service factory function
 */
export function createSessionsService(
  db: TenantScopeAwareDatabase,
  app: Application,
  deploymentAvailable: (tool: AgenticToolName) => boolean = () => true
): SessionsService {
  return new SessionsService(db, app, deploymentAvailable);
}
