/**
 * Service Hooks Registration
 *
 * Registers all FeathersJS service hooks (before/after/error)
 * for authentication, authorization, RBAC, and business logic.
 * Extracted from index.ts for maintainability.
 */

import { AGENTIC_TOOL_DISPLAY_NAMES } from '@disco/agentic-tools';
import { analyticsLogger } from '@disco/core/analytics';
import {
  type DiscoConfig,
  type ResolvedDeploymentConfig,
  resolveMultiTenancyConfig,
  resolveMultiTenancyDatabaseDialect,
  resolveTenantContext,
  TenantResolutionError,
} from '@disco/core/config';
import {
  assertTenantWritable,
  getCurrentTenantDatabaseScope,
  isPostgresDatabaseHandle,
  ScheduleRepository,
  type SessionRepository,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
  TenantWriteGateActiveError,
  UserMCPOAuthTokenRepository,
  type UsersRepository,
} from '@disco/core/db';
import type { Application, FeathersService } from '@disco/core/feathers';
import {
  BadRequest,
  Forbidden,
  NotAuthenticated,
  NotFound,
  Unavailable,
} from '@disco/core/feathers';
import {
  mcpCatalogQueryValidator,
  mcpServerQueryValidator,
  messageQueryValidator,
  sessionQueryValidator,
  taskQueryValidator,
  typedValidateQuery,
  userQueryValidator,
} from '@disco/core/lib/feathers-validation';
import { isMCPServerUsableBy } from '@disco/core/mcp';
import type {
  AuthenticatedParams,
  HookContext,
  MCPServer,
  MessageID,
  Paginated,
  Params,
  Session,
  Task,
  User,
  UserID,
} from '@disco/core/types';
import {
  hasMinimumRole,
  ROLES,
  SCHEDULE_CREATE_WRITE_FIELDS,
  SCHEDULE_PATCH_WRITE_FIELDS,
  TaskStatus,
} from '@disco/core/types';
import {
  executorRuntimeScopeGuard,
  isTaskScopedExecutorRequest,
  requireExecutorRuntimeToken,
} from './auth/executor-runtime-scope.js';
import type { MessagesServiceImpl, SessionsServiceImpl, TasksServiceImpl } from './declarations.js';
import { rejectInConstrainedHa } from './ha-support.js';
import {
  classifyMissingCredentialFailure,
  protectExternalProviderFailureMetadata,
} from './hooks/classify-missing-credential.js';
import { validateMessageCreate } from './hooks/validate-message-create.js';
import { resolveForUserIdWithGate } from './oauth-auth-helpers.js';
import { protectExternalPermissionMessageWrites } from './permissions/permission-message-boundary.js';
import type { RedisRealtimeRuntime } from './realtime/redis-realtime.js';
import { isMCPOAuthGrantBoundToServer } from './services/mcp-oauth-grant-binding.js';
import {
  isRemoteRelationshipsEnrichedResult,
  markRemoteRelationshipsEnrichedResult,
} from './services/sessions.js';
import { isAuthenticationUserLookup, isLocalAuthenticationLookup } from './services/users.js';
import { buildSessionCreatedAnalyticsProperties } from './utils/analytics-payloads.js';
import { ensureMinimumRole, requireMinimumRole } from './utils/authorization.js';
import { injectCreatedBy } from './utils/inject-created-by.js';
import {
  redactMCPServerSecrets,
  shouldExposeMCPServerSecrets,
} from './utils/mcp-header-secrets.js';
import { createMcpServerWriteAuthorizationHook } from './utils/mcp-server-authorization.js';
import {
  RealtimeAccessCache,
  type RealtimeAccessSessionRepository,
} from './utils/realtime-access-cache.js';
import { configureRealtimePublish } from './utils/realtime-publish.js';
import {
  resolveSandboxProtectedDataRoots,
  validateFilesystemHomeOverride,
} from './utils/sandbox-context.js';
import {
  ensureScheduleLoaded,
  ensureScheduleRunsAsCaller,
  recomputeNextRunAt,
  scopeSchedulesToCaller,
  validateScheduleConfig,
} from './utils/schedule-hooks.js';
import {
  ensureCanPromptTargetSession,
  ensurePersonalSessionOwner,
  ensureSessionImmutability,
  loadSession,
  resolveSessionContext,
  scopeFindToPersonalSessionsSql,
} from './utils/session-authorization.js';
import { createSessionMcpTokenAfterHooks } from './utils/session-mcp-token-hook.js';
import { deferWithSessionQueueTenantScope } from './utils/session-queue-tenant-scope.js';
import {
  isTerminalQueueProcessingSuppressed,
  sessionCanStartTask,
} from './utils/session-task-state.js';
import { createTenantDatabaseScopeAroundHook } from './utils/tenant-db-scope.js';
import { enforcePublicWriteFields, markWriteDataPrepared } from './utils/write-data-boundary.js';
import { protectExternalWidgetMessageWrites } from './widgets/message-boundary.js';

const DEBUG_MCP_TOKENS =
  process.env.DISCO_DEBUG_MCP_TOKENS === '1' || process.env.DEBUG?.includes('mcp-tokens');

function mcpTokenDebug(...args: unknown[]): void {
  if (DEBUG_MCP_TOKENS) {
    console.debug(...args);
  }
}

/**
 * Session fields written as runtime bookkeeping during the prompt/execution
 * lifecycle, on behalf of the session's authenticated user. These are NOT
 * session metadata (name, model_config, permission_config, callback_config).
 *
 * Sources:
 *   - `/sessions/:id/prompt`  → `tasks`, `archived`, `archived_reason`
 *   - `/sessions/:id/stop`    → `status`, `ready_for_prompt`
 *   - executor status updates → `status`, `ready_for_prompt`
 *     (claude/copilot permission-hooks, see packages/executor)
 *   - executor opencode init   → `sdk_session_id` (SDK session handle)
 *
 * The Session owner check still applies. This list only distinguishes internal
 * execution bookkeeping from user-editable Session metadata; mixed-field
 * patches fail `isPromptFlowPatchOnly` and follow the metadata write path.
 *
 * NOTE: `sdk_session_id` is on this list because the executor
 * authenticates as the session creator (see auth/session-token-strategy.ts),
 * not as a service account. Proper long-term fix is to give the executor a
 * service-account token so these patches bypass RBAC entirely.
 */
export const PROMPT_FLOW_PATCH_FIELDS: readonly string[] = [
  'tasks',
  'archived',
  'archived_reason',
  'status',
  'ready_for_prompt',
  'sdk_session_id',
];

export function isPromptFlowPatchOnly(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  return keys.every((key) => PROMPT_FLOW_PATCH_FIELDS.includes(key));
}

export function shouldRunSessionPostTurnHooks(
  session: Pick<Session, 'status' | 'ready_for_prompt'>
): boolean {
  return sessionCanStartTask(session.status, session.ready_for_prompt);
}

export function shouldDrainQueueAfterSessionPostTurnPatch(
  session: Pick<Session, 'status' | 'ready_for_prompt'>,
  params?: Params
): boolean {
  return (
    shouldRunSessionPostTurnHooks(session) &&
    session.ready_for_prompt === true &&
    !isTerminalQueueProcessingSuppressed(params)
  );
}

export function getTrustedSessionTenantId(session: unknown): string | undefined {
  const tenantId = (session as { tenant_id?: unknown } | undefined)?.tenant_id;
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : undefined;
}

export async function enrichSessionFindResultWithRemoteRelationships(
  result: Paginated<Session> | Session[],
  sessionsService: Pick<SessionsServiceImpl, 'enrichRemoteRelationships'>
): Promise<Paginated<Session> | Session[]> {
  if (isRemoteRelationshipsEnrichedResult(result)) return result;

  if (Array.isArray(result)) {
    return markRemoteRelationshipsEnrichedResult(
      await sessionsService.enrichRemoteRelationships(result)
    );
  }

  return markRemoteRelationshipsEnrichedResult({
    ...result,
    data: await sessionsService.enrichRemoteRelationships(result.data),
  });
}

/**
 * Interface for dependencies needed by hook registration.
 */
export interface RegisterHooksContext {
  db: TenantScopeAwareDatabase;
  app: Application & { io?: import('socket.io').Server };
  config: DiscoConfig;
  jwtSecret: string;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  realtimeRelay?: Pick<RedisRealtimeRuntime, 'relay' | 'setRelayHandler'>;
  deployment: ResolvedDeploymentConfig;

  // Service instances from registerServices()
  sessionsService: SessionsServiceImpl;
  messagesService: MessagesServiceImpl;
  usersRepository: UsersRepository;
  sessionsRepository: SessionRepository;
}

/**
 * Register all FeathersJS service hooks.
 */
export const TENANT_OWNED_SERVICE_PATHS = [
  'agents',
  'sessions',
  'sessions/:id/mcp-servers',
  'session-relationships',
  'tasks',
  'messages',
  'schedules',
  'users',
  'app-variables',
  'agentic-tool-settings',
  'agentic-tool-presets',
  'codex-skills',
  'agent-capabilities',
  'mcp-servers',
  'mcp-servers/oauth-attempt-status',
  'mcp-servers/oauth-disconnect',
  'mcp-servers/oauth-status',
  'session-mcp-servers',
  'user-mcp-oauth-tokens',
  'session-env-selections',
  'leaderboard',
  'session-search',
];

// These endpoints perform network/process work after their tenant DB reads,
// so they carry tenant identity for the full request and open short database
// units of work at the call site instead of holding an HTTP-long transaction.
export const TENANT_IDENTITY_ONLY_SERVICE_PATHS = [
  'executor-transcripts',
  'check-auth',
  'codex-quota',
  'files',
  // Global catalog: no tenant column to scope, no writes to stamp.
  'mcp-catalog',
  'codex-auth/device',
  'codex-auth/import',
  'codex-auth/logout',
  'opencode-auth',
  'opencode-models',
  'claude-models',
  'copilot-models',
  'cursor-models',
  'terminals',
  // These OAuth/discovery endpoints perform provider network I/O or wait for
  // a browser callback. Their durable one-shot claim must commit before any
  // authorization-code exchange, so they must never inherit an HTTP-long
  // tenant transaction. Each DB access opens a short tenant unit of work.
  'mcp-servers/discover',
  'mcp-servers/oauth-complete',
  'mcp-servers/oauth-start',
  'mcp-servers/oauth-auth-headers',
  'mcp-servers/oauth-refresh',
  'mcp-servers/test-oauth',
] as const;

/**
 * Service endpoints whose implementation retains process-local credentials,
 * provider handshakes, or native runtime state. Keep this inventory exported
 * so the constrained HA fail-closed boundary has direct regression coverage.
 * `mcp-servers/discover` is included because an OAuth-protected probe can start
 * the same pending PKCE/callback flow as the explicit OAuth endpoints.
 */
export const CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES = [
  ['mcp-servers/discover', 'mcpOAuth'],
  ['mcp-servers/oauth-auth-headers', 'mcpOAuth'],
  ['mcp-servers/oauth-complete', 'mcpOAuth'],
  ['mcp-servers/oauth-disconnect', 'mcpOAuth'],
  ['mcp-servers/oauth-refresh', 'mcpOAuth'],
  ['mcp-servers/oauth-start', 'mcpOAuth'],
  ['mcp-servers/oauth-status', 'mcpOAuth'],
  ['mcp-servers/test-oauth', 'mcpOAuth'],
  ['codex-auth/device', 'codexDeviceAuth'],
  ['codex-auth/import', 'codexAuth'],
  ['codex-auth/logout', 'codexAuth'],
  ['opencode-auth', 'openCodeAuth'],
  ['opencode-models', 'openCodeAuth'],
] as const satisfies ReadonlyArray<readonly [string, Parameters<typeof rejectInConstrainedHa>[1]]>;

const taskFieldSet = (...fields: (keyof Task)[]) => new Set<string>(fields);

const EXECUTOR_TASK_PATCH_FIELDS = taskFieldSet(
  'status',
  'completed_at',
  'git_state',
  'message_range',
  'model',
  'raw_sdk_response',
  'normalized_sdk_response',
  'computed_context_window',
  'tool_use_count',
  'duration_ms',
  'agent_session_id',
  'error_message',
  'report',
  'permission_request'
);

const EXTERNAL_TASK_CREATE_FIELDS = taskFieldSet('session_id', 'full_prompt', 'status');

/** Keep the documented two-step create/run API dormant until the explicit run call. */
export function protectExternalTaskCreate(context: HookContext): HookContext {
  if (!context.params.provider) return context;

  const data =
    context.data && typeof context.data === 'object' && !Array.isArray(context.data)
      ? (context.data as Record<string, unknown>)
      : undefined;
  if (!data) throw new BadRequest('Task creation requires one task');

  const unsupported = Object.keys(data).find((field) => !EXTERNAL_TASK_CREATE_FIELDS.has(field));
  if (unsupported) throw new BadRequest(`Task create field is not client-managed: ${unsupported}`);
  if (typeof data.session_id !== 'string' || !data.session_id) {
    throw new BadRequest('session_id is required when creating a task');
  }
  if (typeof data.full_prompt !== 'string') {
    throw new BadRequest('full_prompt is required when creating a task');
  }
  if (data.status !== undefined && data.status !== TaskStatus.CREATED) {
    throw new BadRequest('Externally created tasks must use status created');
  }

  data.status = TaskStatus.CREATED;
  return context;
}

/** Prevent callers on a Feathers transport from forging executor-owned task state. */
export async function protectServerManagedTaskWrites(context: HookContext): Promise<HookContext> {
  if (!context.params.provider) return context;

  if (typeof context.id !== 'string' || !isTaskScopedExecutorRequest(context, context.id)) {
    throw new Forbidden('Task patches require an executor token scoped to this task');
  }

  const write =
    context.data && typeof context.data === 'object' && !Array.isArray(context.data)
      ? (context.data as Record<string, unknown>)
      : undefined;
  if (!write || Object.keys(write).some((field) => !EXECUTOR_TASK_PATCH_FIELDS.has(field))) {
    throw new Forbidden('Task patch contains fields that are not executor-managed');
  }

  return context;
}

export function authorizeUsersGet(context: HookContext): HookContext {
  const params = context.params as AuthenticatedParams;

  if (isAuthenticationUserLookup(params)) {
    return context;
  }

  ensureMinimumRole(params, ROLES.MEMBER, 'view users');
  return context;
}

/** Protect and canonicalize the admin-owned host path used for sandbox homes. */
export function protectFilesystemHomeWrite(context: HookContext, config: DiscoConfig): HookContext {
  const records = Array.isArray(context.data) ? context.data : [context.data];
  const writesFilesystemHome = records.some(
    (record) => record && Object.hasOwn(record as object, 'filesystem_home')
  );
  if (!writesFilesystemHome) return context;

  const params = context.params as AuthenticatedParams;
  if (params.provider && !hasMinimumRole(params.user?.role, ROLES.ADMIN)) {
    throw new Forbidden('Only admins can modify filesystem_home');
  }

  const protectedDataRoots = resolveSandboxProtectedDataRoots(config);
  for (const record of records) {
    if (!record || !Object.hasOwn(record as object, 'filesystem_home')) continue;
    const writable = record as Record<string, unknown>;
    const value = writable.filesystem_home;
    if (value === null) continue;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequest('filesystem_home must be a non-empty absolute path or null');
    }
    try {
      let validated = value.trim();
      for (const root of protectedDataRoots) {
        validated = validateFilesystemHomeOverride(validated, root);
      }
      writable.filesystem_home = validated;
    } catch (error) {
      throw new BadRequest(error instanceof Error ? error.message : String(error));
    }
  }
  return context;
}

/**
 * Prevent a regular administrator from mutating or deleting a
 * superadministrator account. Checking only the requested role is
 * insufficient because it still permits demotion, password reset, or removal
 * of an existing superadministrator.
 */
export async function protectSuperadminTargetFromAdmin(
  context: HookContext,
  usersService: { get(id: UserID): Promise<User> }
): Promise<HookContext> {
  const params = context.params as AuthenticatedParams;
  if (!params.provider || context.id == null) return context;

  const callerRole = params.user?.role;
  if (!hasMinimumRole(callerRole, ROLES.ADMIN) || hasMinimumRole(callerRole, ROLES.SUPERADMIN)) {
    return context;
  }

  const target = await usersService.get(context.id as UserID);
  if (hasMinimumRole(target.role, ROLES.SUPERADMIN)) {
    throw new Forbidden('Only superadmins can modify or delete superadmin users');
  }

  return context;
}

export function registerHooks(ctx: RegisterHooksContext): void {
  const {
    db,
    app,
    config,
    jwtSecret,
    requireAuth,
    sessionsService,
    messagesService,
    sessionsRepository,
    realtimeRelay,
    deployment,
  } = ctx;

  // Used by classifyMissingCredentialFailure to look up the acting user for
  // a failed task (no service-layer equivalent already in ctx).
  const taskRepository = new TaskRepository(db);

  // Helper: safely get a service (returns undefined if not registered due to tier=off)
  const safeService = (path: string) => {
    try {
      return app.service(path);
    } catch {
      return undefined;
    }
  };

  if (deployment.mode === 'ha') {
    for (const [path, feature] of CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES) {
      safeService(path)?.hooks({ before: { all: [rejectInConstrainedHa(deployment, feature)] } });
    }
  }

  const multiTenancy = resolveMultiTenancyConfig(config);
  const tenantColumnsEnabled = resolveMultiTenancyDatabaseDialect(config) === 'postgresql';
  const sessionMcpTokenAfterHooks = createSessionMcpTokenAfterHooks({
    app,
    config,
    onGetAttached: (session) =>
      mcpTokenDebug(`🔄 Resolved MCP token for session ${shortId(session.session_id)}`),
    onCreateAttached: (session) =>
      console.log(`🎫 MCP token issued for session ${shortId(session.session_id)}`),
  });

  const tenantOwnedServicePaths = TENANT_OWNED_SERVICE_PATHS;

  const stripTenantData = (data: unknown): unknown => {
    if (Array.isArray(data)) return data.map(stripTenantData);
    if (!data || typeof data !== 'object') return data;
    const clone = { ...(data as Record<string, unknown>) };
    delete clone.tenant_id;
    return clone;
  };

  const resultBelongsToTenant = (result: unknown, tenantId: string): boolean => {
    if (Array.isArray(result)) return result.every((item) => resultBelongsToTenant(item, tenantId));
    if (!result || typeof result !== 'object') return true;
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.data))
      return record.data.every((item) => resultBelongsToTenant(item, tenantId));
    if (!('tenant_id' in record)) return true;
    return record.tenant_id === tenantId;
  };

  const tenantDatabaseScopeAround = createTenantDatabaseScopeAroundHook({
    db,
    config,
    jwtSecret,
  });
  const tenantIdentityAround = createTenantDatabaseScopeAroundHook({
    db,
    config,
    jwtSecret,
    transaction: false,
  });

  const ensureTenantContext = async (context: HookContext): Promise<HookContext> => {
    try {
      context.params.tenant = resolveTenantContext(multiTenancy, { params: context.params });
      return context;
    } catch (error) {
      if (error instanceof TenantResolutionError) {
        throw new NotAuthenticated(error.message);
      }
      throw error;
    }
  };

  const scopeTenantBefore = async (context: HookContext): Promise<HookContext> => {
    await ensureTenantContext(context);
    const tenantId = context.params.tenant?.tenant_id;
    if (!tenantId) return context;

    if (context.method === 'update' || context.method === 'patch') {
      context.data = stripTenantData(context.data) as typeof context.data;
    }

    // Do not inject tenant_id into Feathers find queries. Several services
    // intentionally omit tenant_id from their public DTOs; the generic in-memory
    // adapter would then filter every row out after RLS already did the DB-level
    // isolation. Tenant isolation for reads is enforced by the transaction-local
    // Postgres RLS setting plus the after-hook assertion below.
    return context;
  };

  const assertTenantAfter = async (context: HookContext): Promise<HookContext> => {
    const tenantId = context.params.tenant?.tenant_id;
    if (tenantId && !resultBelongsToTenant(context.result, tenantId)) {
      throw new NotAuthenticated('Tenant isolation check failed');
    }
    return context;
  };

  // Enforce the per-tenant write gate on request-driven writes. Runs after
  // scopeTenantBefore has resolved the trusted tenant. Reads are never gated;
  // only create/update/patch/remove are blocked while a freeze is held. This is
  // the request-traffic enforcement point for the generic write gate; deferred
  // operators (scheduler/gateway/executor/queue) enforce at their own entry
  // points. Fails closed with 503 so an orchestrator sees a transient block.
  const WRITE_METHODS = new Set(['create', 'update', 'patch', 'remove']);
  const writeGateBefore = async (context: HookContext): Promise<HookContext> => {
    if (!WRITE_METHODS.has(context.method)) return context;
    const tenantId = context.params.tenant?.tenant_id;
    if (!tenantId) return context;
    // Only enforce inside an active tenant database scope — the one the around
    // hook (`tenantDatabaseScopeAround`) opens before these before-hooks run.
    // The gate read joins that transaction; without an active scope there is no
    // tenant transaction to read against (e.g. identity-only services, or a unit
    // test that invokes the before-hooks directly), so there is nothing to
    // enforce here and we must not open a stray transaction.
    if (!getCurrentTenantDatabaseScope()) return context;
    try {
      await assertTenantWritable(db, tenantId);
    } catch (error) {
      if (error instanceof TenantWriteGateActiveError) {
        throw new Unavailable(error.message);
      }
      throw error;
    }
    return context;
  };

  const registerTenantHooks = (): void => {
    for (const path of tenantOwnedServicePaths) {
      const service = safeService(path);
      if (!service) continue;
      service.hooks({
        around: { all: [tenantDatabaseScopeAround] },
        before: { all: [scopeTenantBefore, writeGateBefore] },
        after: { all: [assertTenantAfter] },
      });
    }
  };

  const registerTenantIdentityHooks = (): void => {
    for (const path of TENANT_IDENTITY_ONLY_SERVICE_PATHS) {
      safeService(path)?.hooks({ around: { all: [tenantIdentityAround] } });
    }
  };

  // Without tenant columns (SQLite / single-tenant), tenant-owned services skip
  // the full RLS-transaction hooks — but they must still carry ambient tenant
  // identity for tenant-aware call sites. MCP session-token issuance can
  // resolve the configured tenant without ambient identity in static mode,
  // while required_from_auth remains fail-closed. Identity only: no data
  // stamping or DB transaction, which are Postgres tenant-column mechanics.
  const registerTenantIdentityForOwnedServices = (): void => {
    for (const path of tenantOwnedServicePaths) {
      safeService(path)?.hooks({ around: { all: [tenantIdentityAround] } });
    }
  };

  const realtimeAccessCache = new RealtimeAccessCache({
    sessionsRepository: sessionsRepository as unknown as RealtimeAccessSessionRepository,
  });

  safeService('agentic-tool-settings')?.hooks({
    before: {
      patch: [requireMinimumRole(ROLES.ADMIN, 'manage workspace agentic tools')],
    },
  });

  safeService('agentic-tool-presets')?.hooks({
    before: {
      create: [requireMinimumRole(ROLES.ADMIN, 'manage agentic tool presets')],
      patch: [requireMinimumRole(ROLES.ADMIN, 'manage agentic tool presets')],
      remove: [requireMinimumRole(ROLES.ADMIN, 'manage agentic tool presets')],
    },
  });

  // Helper to get usersService from app
  const usersService = app.service('users');

  /**
   * Authorization chain shared by the two externally-initiated prompt writes,
   * `messages.create` and `tasks.create`.
   *
   * Direct Session ownership always gates the write. `unix_user_mode` then
   * decides whether the session may execute as the
   *    execution-home key it was stamped with. Only `delegated` consumes the
   *    stamp; `simple` and `sandbox` do not. Once the creator's key changes,
   *    the stamp names an identity the user no longer has and the SDK state
   *    lives in a home directory this instance cannot reach, so the prompt is
   *    refused.
   *
   * The session load is the precondition of both, and is memoised per request.
   */
  const promptWriteGuards = [
    resolveSessionContext(),
    loadSession(sessionsService),
    ensurePersonalSessionOwner(),
  ];

  // ============================================================================
  // Messages hooks
  // ============================================================================

  const protectWidgetMessageWrites = protectExternalWidgetMessageWrites((messageId) =>
    messagesService.findByIdForScopeCheck(messageId as MessageID)
  );
  const protectProviderFailureMetadata = protectExternalProviderFailureMetadata((messageId) =>
    messagesService.findByIdForScopeCheck(messageId as MessageID)
  );
  const protectPermissionMessageWrites = protectExternalPermissionMessageWrites((messageId) =>
    messagesService.findByIdForScopeCheck(messageId as MessageID)
  );

  app.service('messages').hooks({
    before: {
      all: [typedValidateQuery(messageQueryValidator), requireAuth, executorRuntimeScopeGuard()],
      find: [scopeFindToPersonalSessionsSql()],
      get: [resolveSessionContext(), loadSession(sessionsService), ensurePersonalSessionOwner()],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create messages'),
        validateMessageCreate,
        protectProviderFailureMetadata,
        protectWidgetMessageWrites,
        protectPermissionMessageWrites,
        ...promptWriteGuards,
        // Reclassify executor-scoped credential and narrow provider-credit
        // failures structurally, never by matching arbitrary provider text.
        classifyMissingCredentialFailure(
          db,
          taskRepository,
          sessionsRepository,
          AGENTIC_TOOL_DISPLAY_NAMES
        ),
      ],
      update: [
        resolveSessionContext(),
        loadSession(sessionsService),
        ensurePersonalSessionOwner(),
        protectProviderFailureMetadata,
        protectWidgetMessageWrites,
        protectPermissionMessageWrites,
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update messages'),
        protectProviderFailureMetadata,
        resolveSessionContext(),
        loadSession(sessionsService),
        ensurePersonalSessionOwner(),
        protectWidgetMessageWrites,
        protectPermissionMessageWrites,
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete messages'),
        resolveSessionContext(),
        loadSession(sessionsService),
        ensurePersonalSessionOwner(),
        protectWidgetMessageWrites,
        protectPermissionMessageWrites,
      ],
    },
    after: {
      create: [],
      patch: [
        async (context: HookContext<import('@disco/core/types').Message>) => {
          // Detect permission resolution and notify executor via IPC
          const message = context.result as import('@disco/core/types').Message;

          // Only process permission_request messages
          if (message.type !== 'permission_request') {
            return context;
          }

          // Check if the message content has approval status
          const content = message.content;
          if (typeof content !== 'object' || !content || Array.isArray(content)) {
            return context;
          }

          const contentObj = content as unknown as Record<string, unknown>;
          const status = contentObj.status;
          if (status !== 'approved' && status !== 'denied') {
            return context;
          }

          // Permission was resolved! Notify the executor via IPC
          console.log(`[daemon] Permission ${status} for request ${contentObj.request_id}`);

          // NOTE: Permission decisions are handled by the executor listening to WebSocket permission events
          // No IPC needed - executor subprocess watches for permission message updates via WebSocket
          console.log('[daemon] Permission decision will be delivered to executor via WebSocket');

          return context;
        },
      ],
    },
  });

  // ============================================================================
  // MCP servers hooks (with per-user OAuth token injection)
  // ============================================================================

  // Hook to inject per-user OAuth tokens into MCP server responses
  const injectPerUserOAuthTokens = async (context: HookContext) => {
    // Try multiple sources for user ID:
    // 1. params.user (from socket authentication)
    // 2. query.forUserId (explicitly passed from executor for per-user OAuth)
    const queryForUserId = (context.params?.query as Record<string, unknown>)?.forUserId as
      | string
      | undefined;
    const authPayloadType = (
      context.params?.authentication as { payload?: { type?: unknown } } | undefined
    )?.payload?.type;
    const userId = resolveForUserIdWithGate({
      queryForUserId,
      isServiceAccount: context.params?.user?._isServiceAccount,
      authPayloadType,
      callerUserId: context.params?.user?.user_id,
    });
    if (!userId) {
      return context;
    }

    const injectToken = async (server: MCPServer) => {
      if (server.auth?.type !== 'oauth') {
        return server;
      }

      // Tokens for both modes live in user_mcp_oauth_tokens:
      //   - per_user  → row keyed by (userId, serverId)
      //   - shared    → row keyed by (NULL, serverId)
      const mode = server.auth.oauth_mode ?? 'per_user';
      const tokenUserId: import('@disco/core/types').UserID | null =
        mode === 'per_user' ? (userId as import('@disco/core/types').UserID) : null;

      try {
        const userTokenRepo = new UserMCPOAuthTokenRepository(db);
        const row = await userTokenRepo.getToken(tokenUserId, server.mcp_server_id);

        if (!row) {
          return server;
        }
        if (
          isPostgresDatabaseHandle(db) &&
          !isMCPOAuthGrantBoundToServer(process.env.DISCO_MASTER_SECRET!, server, row)
        ) {
          console.warn('[MCP OAuth] grant_rejected category=binding_mismatch');
          return server;
        }

        // Response enrichment is a durable read only. Refresh is coordinated
        // by oauth-auth-headers/manual refresh, never from an after hook that
        // may hold an unrelated tenant transaction.
        if (
          row.refresh_status !== 'idle' ||
          (row.oauth_token_expires_at && row.oauth_token_expires_at <= new Date())
        ) {
          return server;
        }
        const accessToken = row.oauth_access_token;
        const expiresAt = row.oauth_token_expires_at;

        return {
          ...server,
          auth: {
            ...server.auth,
            oauth_access_token: accessToken,
            // Surface expiry so the UI can render "expires in X" tooltips.
            // Stored as Date in the repo, emitted as ms epoch to match MCPAuth.
            oauth_token_expires_at:
              expiresAt instanceof Date ? expiresAt.getTime() : (expiresAt ?? undefined),
          },
        };
      } catch {
        console.warn('[MCP OAuth] grant_resolution_failed category=local_error');
      }

      return server;
    };

    // Handle both single result and array/paginated results
    if (Array.isArray(context.result)) {
      context.result = await Promise.all(context.result.map(injectToken));
    } else if (context.result?.data && Array.isArray(context.result.data)) {
      context.result.data = await Promise.all(context.result.data.map(injectToken));
    } else if (context.result?.mcp_server_id) {
      context.result = await injectToken(context.result);
    }

    return context;
  };

  const redactMCPServerSecretFields = async (context: HookContext) => {
    if (shouldExposeMCPServerSecrets(context.params)) return context;

    if (Array.isArray(context.result)) {
      context.result = context.result.map(redactMCPServerSecrets);
    } else if (context.result?.data && Array.isArray(context.result.data)) {
      context.result.data = context.result.data.map(redactMCPServerSecrets);
    } else if (context.result?.mcp_server_id) {
      context.result = redactMCPServerSecrets(context.result);
    }

    return context;
  };

  // Writes are decided by `mcp_member_policy` plus ownership, not by role
  // alone — see `authorizeMcpServerWrite`. Reads are narrowed to the servers
  // the caller may use, because a private server is another user's
  // configuration and credential, not shared tenant configuration.
  const authorizeMcpServerWriteHook = createMcpServerWriteAuthorizationHook(db) as unknown as (
    context: HookContext
  ) => Promise<HookContext>;

  const scopeMcpServerFindToUsable = async (context: HookContext): Promise<HookContext> => {
    if (!context.params.provider) return context;
    const user = context.params.user;
    if (!user || (user as { _isServiceAccount?: boolean })._isServiceAccount) return context;
    if (!hasMinimumRole(user.role, ROLES.ADMIN)) {
      // Do not trust a caller-supplied usableByUserId; it is an internal
      // authorization filter, not a public query capability.
      context.params.query = {
        ...(context.params.query ?? {}),
        usableByUserId: user.user_id,
      };
    }
    return context;
  };

  const denyMcpServerGetOfAnotherUsersPrivate = async (
    context: HookContext
  ): Promise<HookContext> => {
    if (!context.params.provider) return context;
    const user = context.params.user;
    if (
      !user ||
      (user as { _isServiceAccount?: boolean })._isServiceAccount ||
      hasMinimumRole(user.role, ROLES.ADMIN)
    ) {
      return context;
    }
    if (!isMCPServerUsableBy(context.result as MCPServer, user.user_id)) {
      throw new NotFound(`MCP server not found: ${String(context.id)}`);
    }
    return context;
  };

  safeService('mcp-servers')?.hooks({
    before: {
      all: [typedValidateQuery(mcpServerQueryValidator), requireAuth],
      find: [scopeMcpServerFindToUsable],
      create: [authorizeMcpServerWriteHook],
      update: [authorizeMcpServerWriteHook],
      patch: [authorizeMcpServerWriteHook],
      remove: [authorizeMcpServerWriteHook],
    },
    after: {
      find: [injectPerUserOAuthTokens, redactMCPServerSecretFields],
      get: [
        denyMcpServerGetOfAnotherUsersPrivate,
        injectPerUserOAuthTokens,
        redactMCPServerSecretFields,
      ],
      create: [redactMCPServerSecretFields],
      patch: [redactMCPServerSecretFields],
      update: [redactMCPServerSecretFields],
    },
  });

  // The MCP catalog is a file checked into this repository — no tenant data, no
  // database behind it, and no writes through this service. Authentication
  // still gates it so an unauthenticated visitor cannot enumerate the browse
  // surface. Query validation no longer guards a query: `find` takes no
  // parameters, and the empty schema is what strips a stale client's filters
  // instead of letting them look honoured.
  safeService('mcp-catalog')?.hooks({
    before: {
      all: [typedValidateQuery(mcpCatalogQueryValidator), requireAuth],
    },
  });

  safeService('session-mcp-servers')?.hooks({
    before: {
      all: [requireAuth],
      find: [scopeFindToPersonalSessionsSql()],
    },
    after: {
      find: [injectPerUserOAuthTokens, redactMCPServerSecretFields],
    },
  });

  // Top-level `/session-env-selections` exists mainly to surface WebSocket
  // events emitted by the `/sessions/:id/env-selections` route handlers. Its
  // `find()` must still be gated — without these hooks any authenticated
  // user could read selection metadata for sessions they can't access,
  // bypassing the creator/admin gate on the nested route. Mirror the
  // `/session-mcp-servers` pattern exactly so the two stay consistent.
  safeService('session-env-selections')?.hooks({
    before: {
      all: [requireAuth],
      find: [
        // This top-level service is event-only and always returns []; do not
        // run RBAC preloads for an intentionally empty result set.
      ],
    },
  });

  safeService('context')?.hooks({
    before: {
      all: [requireAuth],
    },
  });

  safeService('files')?.hooks({
    before: {
      all: [requireAuth, requireMinimumRole(ROLES.MEMBER, 'access published files')],
    },
  });

  // ============================================================================
  // Groups hooks
  // ============================================================================

  // ============================================================================
  // Users hooks
  // ============================================================================

  app.service('users').hooks({
    before: {
      all: [typedValidateQuery(userQueryValidator)],
      find: [
        (context) => {
          const params = context.params as AuthenticatedParams;

          if (!params.provider) {
            return context;
          }

          if (params.user) {
            ensureMinimumRole(params, ROLES.MEMBER, 'list users');
            return context;
          }

          const query = params.query || {};
          if (query.username && isLocalAuthenticationLookup(params)) {
            // Allow only the Feathers local authentication pipeline to perform
            // unauthenticated exact-username lookup. Direct external /users?username
            // calls are denied below so hashes/private auth fields cannot leak
            // through lookup/enumeration responses.
            params.query = { ...query, $limit: 1 };
            return context;
          }

          throw new NotAuthenticated('Authentication required');
        },
      ],
      get: [authorizeUsersGet],
      create: [
        (context) => protectFilesystemHomeWrite(context, config),
        async (context: HookContext<User>) => {
          const params = context.params as AuthenticatedParams;

          if (!params.provider) {
            return context;
          }

          const existing = (await usersService.find({ query: { $limit: 1 } })) as Paginated<User>;
          if (existing.total > 0) {
            ensureMinimumRole(params, ROLES.ADMIN, 'create users');
          }

          // Only superadmins can create superadmin users
          // Guard both 'superadmin' and legacy 'owner' to prevent bypass
          // Cast to include 'owner' for legacy client compatibility (UserRole excludes 'owner')
          const data = context.data as Partial<Omit<User, 'role'> & { role?: string }>;
          if (hasMinimumRole(data?.role, ROLES.SUPERADMIN)) {
            const callerRole = params.user?.role;
            if (!hasMinimumRole(callerRole, ROLES.SUPERADMIN)) {
              throw new Forbidden('Only superadmins can create superadmin users');
            }
          }

          return context;
        },
      ],
      patch: [
        (context) => protectFilesystemHomeWrite(context, config),
        (context) => protectSuperadminTargetFromAdmin(context, usersService),
        async (context) => {
          const params = context.params as AuthenticatedParams;
          const userId = context.id as string;
          const callerRole = params.user?.role;
          const callerIsAdmin = hasMinimumRole(callerRole, ROLES.ADMIN);

          // Field-level restrictions: only admins can modify unix_username, role, and must_change_password.
          // filesystem_home is protected and validated by the preceding hook.
          if (!Array.isArray(context.data)) {
            if (context.data?.unix_username !== undefined) {
              if (!callerIsAdmin) {
                throw new Forbidden('Only admins can modify unix_username');
              }
            }
            if (context.data?.role !== undefined) {
              if (!callerIsAdmin) {
                throw new Forbidden('Only admins can modify user roles');
              }
              // Only superadmins can assign the superadmin role
              // Guard both 'superadmin' and legacy 'owner' to prevent bypass
              if (
                hasMinimumRole(context.data.role, ROLES.SUPERADMIN) &&
                !hasMinimumRole(callerRole, ROLES.SUPERADMIN)
              ) {
                // Bootstrap: allow first superadmin promotion if none exist yet
                // Note: usersService.find() doesn't filter by role, so filter in JS
                const allUsers = (await usersService.find({})) as Paginated<User>;
                const hasSuperadmin = allUsers.data.some((u) => u.role === ROLES.SUPERADMIN);
                if (hasSuperadmin) {
                  throw new Forbidden('Only superadmins can assign the superadmin role');
                }
              }
            }
            if (context.data?.must_change_password !== undefined) {
              if (!callerIsAdmin) {
                throw new Forbidden('Only admins can force password changes');
              }
            }
          }

          // General authorization: admins can patch any user
          if (callerIsAdmin) {
            return context;
          }

          // Any authenticated user can update their own profile (except unix_username and role, checked above)
          if (params.user && params.user.user_id === userId) {
            return context;
          }

          // Env-var-specific trusted write escape hatch. Set ONLY by the widget
          // submit path, which has already authorized the caller via
          // `canResolveWidget` (Session owner)
          // before calling users.patch on the session creator's behalf.
          //
          // Deliberately narrow: only allows `env_vars` + `env_var_scopes`
          // fields — any attempt to slip in other fields (e.g. role, unix_username)
          // throws immediately. Field-level admin gates above run first and are
          // NOT bypassed regardless.
          //
          // Grep for: trustedEnvVarWrite — to audit every site that sets it.
          if (
            !context.params.provider &&
            (params as { trustedEnvVarWrite?: boolean }).trustedEnvVarWrite === true
          ) {
            const keys = Object.keys(context.data ?? {});
            if (!keys.every((k) => k === 'env_vars' || k === 'env_var_scopes')) {
              throw new Forbidden(
                'trustedEnvVarWrite only permits env_vars and env_var_scopes updates'
              );
            }
            return context;
          }

          // Otherwise forbidden
          throw new Forbidden('You can only update your own profile');
        },
      ],
      remove: [
        requireMinimumRole(ROLES.ADMIN, 'delete users'),
        (context) => protectSuperadminTargetFromAdmin(context, usersService),
      ],
    },
  });

  // ============================================================================
  // Publish service events
  // ============================================================================

  configureRealtimePublish({
    app,
    db,
    sessionsRepository,
    accessCache: realtimeAccessCache,
    multiTenancy,
    realtimeRelay,
  });

  // ============================================================================
  // Sessions hooks
  // ============================================================================

  // Sessions are directly owned by one Disco user. Agent and standalone
  // conversations share this authorization path; no repository/Branch grant
  // can make another user's conversation visible or writable.
  const sessionWriteGuards = [
    ensureSessionImmutability(),
    resolveSessionContext(),
    loadSession(sessionsService),
    ensurePersonalSessionOwner(),
    async (context: HookContext) => {
      const patchCbConfig = (context.data as Record<string, unknown> | undefined)
        ?.callback_config as { callback_session_id?: string } | undefined;
      if (patchCbConfig?.callback_session_id && context.params.provider) {
        const userId =
          (context.params as { user?: { user_id: string } }).user?.user_id || 'unknown';
        await ensureCanPromptTargetSession(patchCbConfig.callback_session_id, userId, context.app);
      }
      return context;
    },
  ];

  app.service('sessions').hooks({
    before: {
      all: [typedValidateQuery(sessionQueryValidator), requireAuth, executorRuntimeScopeGuard()],
      find: [scopeFindToPersonalSessionsSql()],
      get: [resolveSessionContext(), loadSession(sessionsService), ensurePersonalSessionOwner()],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create sessions'),
        injectCreatedBy(),
        async (context) => {
          // Callback targets must be owned by the same authenticated user.
          const cbConfig = (context.data as Record<string, unknown> | undefined)?.callback_config as
            | { callback_session_id?: string }
            | undefined;
          if (cbConfig?.callback_session_id && context.params.provider) {
            // Use authenticated user, NOT context.data.created_by (which could be client-supplied)
            const authenticatedUserId =
              (context.params as { user?: { user_id: string } }).user?.user_id || 'unknown';
            await ensureCanPromptTargetSession(
              cbConfig.callback_session_id,
              authenticatedUserId,
              context.app
            );
          }

          return context;
        },
      ],
      update: sessionWriteGuards,
      patch: sessionWriteGuards,
      remove: [resolveSessionContext(), loadSession(sessionsService), ensurePersonalSessionOwner()],
    },
    after: {
      find: [
        async (context) => {
          // Session find results may be produced by custom hooks or service
          // methods. Enrich once, as a single batched query over the final page.
          context.result = await enrichSessionFindResultWithRemoteRelationships(
            context.result as Paginated<Session> | Session[],
            sessionsService
          );
          return context;
        },
      ],
      get: [sessionMcpTokenAfterHooks.get],
      create: [
        async (context) => {
          const session = context.result as Session;
          analyticsLogger.track(
            'session.created',
            buildSessionCreatedAnalyticsProperties(session),
            { userId: session.created_by }
          );
          return context;
        },
        sessionMcpTokenAfterHooks.create,
        // TODO: OpenCode session creation moved to executor - implement via IPC if needed
      ],
      patch: [
        async (context) => {
          // Automatically run post-turn side effects when a session becomes promptable.
          // Historically that meant IDLE; failed terminal tasks are now promptable too
          // (status=failed, ready_for_prompt=true) so the UI can surface the failure
          // without blocking queue draining or post-turn finalization.
          const session = Array.isArray(context.result) ? context.result[0] : context.result;

          if (session && shouldRunSessionPostTurnHooks(session)) {
            if (shouldDrainQueueAfterSessionPostTurnPatch(session, context.params)) {
              const sessionTenantId = getTrustedSessionTenantId(session);
              // Same fresh-scope pattern: queue processing must run outside the
              // outer transaction but still inside the session tenant for RLS.
              // Some completion/background paths have minimal params, so this
              // relies on params.tenant, current tenant ALS, the already-returned
              // session row tenant_id, or static tenant config and otherwise
              // fails closed.
              deferWithSessionQueueTenantScope(
                {
                  db,
                  config,
                  sessionId: session.session_id,
                  params: context.params,
                  tenantIdHint: sessionTenantId,
                  label: 'SessionsService.after.patch queue drain',
                },
                async (queueParams) => {
                  console.log(
                    `🔄 [SessionsService.after.patch] Session ${shortId(session.session_id)} became promptable (${session.status}), checking for queued tasks...`
                  );

                  await sessionsService.triggerQueueProcessing(session.session_id, queueParams);
                },
                (error) => {
                  console.error(
                    `❌ [SessionsService.after.patch] Failed to process queue for session ${shortId(session.session_id)}:`,
                    error
                  );
                  // Don't throw - queue processing failure shouldn't break session patches
                }
              );
            } else {
              console.log(
                `⏭️  [SessionsService.after.patch] Queue drain suppressed for session ${shortId(session.session_id)} (suppressTerminalQueueProcessing or not ready)`
              );
            }
          }

          return context;
        },
      ],
    },
  });
  app.service('leaderboard').hooks({
    before: {
      all: [requireAuth],
    },
  });
  app.service('session-search').hooks({
    before: {
      all: [requireAuth],
    },
  });

  // ============================================================================
  // Schedules hooks
  // ============================================================================
  const scheduleRepository = new ScheduleRepository(db);

  app.service('schedules').hooks({
    before: {
      all: [requireAuth],
      find: [scopeSchedulesToCaller()],
      get: [ensureScheduleLoaded(scheduleRepository), ensureScheduleRunsAsCaller()],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create schedules'),
        enforcePublicWriteFields('Schedule', SCHEDULE_CREATE_WRITE_FIELDS),
        injectCreatedBy(),
        validateScheduleConfig(),
        recomputeNextRunAt(),
        markWriteDataPrepared(),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update schedules'),
        enforcePublicWriteFields('Schedule', SCHEDULE_PATCH_WRITE_FIELDS),
        ensureScheduleLoaded(scheduleRepository),
        ensureScheduleRunsAsCaller(),
        validateScheduleConfig(),
        recomputeNextRunAt(),
        markWriteDataPrepared(),
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete schedules'),
        ensureScheduleLoaded(scheduleRepository),
        ensureScheduleRunsAsCaller(),
      ],
    },
  });

  // ============================================================================
  // Tasks hooks
  // ============================================================================

  const tasksService = app.service('tasks') as FeathersService<Application, TasksServiceImpl>;
  tasksService.hooks({
    before: {
      all: [typedValidateQuery(taskQueryValidator), requireAuth, executorRuntimeScopeGuard()],
      find: [scopeFindToPersonalSessionsSql()],
      get: [resolveSessionContext(), loadSession(sessionsService), ensurePersonalSessionOwner()],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create tasks'),
        ...promptWriteGuards,
        protectExternalTaskCreate,
        injectCreatedBy(),
      ],
      patch: [
        protectServerManagedTaskWrites,
        resolveSessionContext(),
        loadSession(sessionsService),
        ensurePersonalSessionOwner(),
      ],
      connectExecutor: [requireExecutorRuntimeToken()],
      reportTerminationComplete: [requireExecutorRuntimeToken()],
      reportRuntimeTelemetry: [requireExecutorRuntimeToken()],
      reportSdkHealthFailure: [requireExecutorRuntimeToken()],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete tasks'),
        resolveSessionContext(),
        loadSession(sessionsService),
        ensurePersonalSessionOwner(),
      ],
    },
  });

  // Tenant hooks are registered last so service-specific authentication hooks
  // (which populate params.user / params.authentication) run before tenant
  // resolution in required_from_auth mode.
  if (tenantColumnsEnabled) {
    registerTenantHooks();
  } else {
    registerTenantIdentityForOwnedServices();
  }
  registerTenantIdentityHooks();
}
