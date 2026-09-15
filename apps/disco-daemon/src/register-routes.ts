/**
 * Authentication & Custom REST Routes Registration
 *
 * Registers authentication configuration, token refresh, custom REST
 * endpoints (prompt, stop, fork, spawn, upload, etc.), and the error handler.
 * Extracted from index.ts for maintainability.
 */

import {
  type DiscoConfig,
  type ResolvedDeploymentConfig,
  requireDeploymentId,
  resolveMultiTenancyConfig,
  resolveSdkWatchdogConfig,
  resolveTenantContext,
} from '@disco/core/config';
import {
  assertTenantWritable,
  bindRepositoryToTenantUnitOfWork,
  generateId,
  getCurrentTenantId,
  MessagesRepository,
  resolveMcpMemberPolicy,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  type SessionRepository,
  setMcpMemberPolicy,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UploadRepository,
  UsersRepository,
} from '@disco/core/db';
import type { Application } from '@disco/core/feathers';
import {
  AuthenticationService,
  BadRequest,
  Conflict,
  errorHandler,
  Forbidden,
  LocalStrategy,
  NotAuthenticated,
  NotFound,
} from '@disco/core/feathers';
import {
  filterMCPServersForSession,
  isMCPServerUsableInSession,
  MCPServerNotUsableError,
} from '@disco/core/mcp';
import type {
  AuthenticatedParams,
  HookContext,
  MCPMemberPolicy,
  MCPMemberPolicySetting,
  Message,
  MessageID,
  MessageSource,
  Params,
  ScheduleID,
  Session,
  SessionID,
  SessionMCPServer,
  StreamingEventType,
  Task,
  TaskMetadata,
  TenantID,
  UploadOwner,
  UploadRef,
  User,
  UUID,
} from '@disco/core/types';
import {
  hasMinimumRole,
  isTaskExecuting,
  isTaskPendingDispatch,
  MCP_MEMBER_POLICIES,
  MessageRole,
  ROLES,
  SessionStatus,
  TaskStatus,
} from '@disco/core/types';
import { NotFoundError } from '@disco/core/utils/errors';
import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { BROWSER_ACCESS_TOKEN_TTL, BROWSER_REFRESH_TOKEN_TTL } from './auth/browser-token-ttl.js';
import {
  getExecutorSessionTokenSessionId,
  isExecutorSessionTokenPayload,
} from './auth/executor-session-token.js';
import { createIssueBrowserTokensHook } from './auth/issue-browser-tokens-hook.js';
import { createRefreshTokenService } from './auth/refresh-token-service.js';
import {
  issueRuntimeToken,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from './auth/runtime-tokens.js';
import { authTokenIssuedAtClaim } from './auth/token-invalidation.js';
import type { SessionsServiceImpl, TasksServiceImpl } from './declarations.js';
import { probeDatabase, probePendingMigrations } from './health/db-probe.js';
import {
  authenticatedHealthDb,
  healthMigrations,
  healthStatus,
  publicHealthDb,
} from './health/payload.js';
import { registerHealthProbeRoutes } from './health/routes.js';
import { resolveForUserIdWithGate } from './oauth-auth-helpers.js';
import {
  deliverPermissionDecision,
  type PermissionDecisionSubmission,
} from './permissions/deliver-permission-decision.js';
import { createMCPCatalogConnectService } from './services/mcp-catalog-connect.js';
import {
  ScheduleBusyError,
  ScheduleNotReadyError,
  type SchedulerService,
} from './services/scheduler.js';
import { createUserApiKeysService } from './services/user-api-keys.js';
import { markAuthenticationUserLookup, markLocalAuthenticationLookup } from './services/users.js';
import { forceFailUnverifiedTask } from './termination-coordinator.js';
import {
  REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE,
  requireActiveAgenticTool,
} from './utils/agentic-tool-runtime.js';
import { appendSystemMessage } from './utils/append-system-message.js';
import { buildAuthRateLimitKey } from './utils/auth-rate-limit-key.js';
import {
  ensureMinimumRole,
  registerAuthenticatedRoute as registerAuthenticatedRouteBase,
  requireMinimumRole,
} from './utils/authorization.js';
import { buildInitialUserMessage } from './utils/build-initial-user-message.js';
import { buildPrompterPrefixedPrompt } from './utils/build-prompter-prefix.js';
import { emitServiceEvent } from './utils/emit-service-event.js';
import {
  redactMCPServerSecrets,
  shouldExposeMCPServerSecrets,
} from './utils/mcp-header-secrets.js';
import { canConfigureMcpServers } from './utils/mcp-server-authorization.js';
import {
  buildPromptTaskMetadata,
  type InternalPromptTaskMetadataInput,
} from './utils/prompt-task-metadata.js';
import { ensureScheduleRunsAsCaller } from './utils/schedule-hooks.js';
import { archiveSessionNow } from './utils/session-archive.js';
import { assertSessionOwnedByActor } from './utils/session-authorization.js';
import {
  deferWithSessionQueueTenantScope,
  runWithSessionQueueTenantScope,
} from './utils/session-queue-tenant-scope.js';
import { stopSessionPreserveQueue } from './utils/session-stop.js';
import {
  sessionCanStartTask,
  shouldReconcileSessionPromptState,
} from './utils/session-task-state.js';
import { findActiveTasksForSession } from './utils/session-tasks.js';
import { type SessionTurnLocks, withSessionTurnLock } from './utils/session-turn-lock.js';
import { formatStructuredLog, structuredLogErrorCode } from './utils/structured-log.js';
import {
  shouldReconcileStableInitialMessage,
  stableInitialMessageIdForTask,
} from './utils/task-initial-message.js';
import { buildTaskLaunchState } from './utils/task-launch-state.js';
import { normalizeMessageSource, runExistingTask } from './utils/task-runner.js';
import { isAgenticToolEnabledForTenant } from './utils/tenant-agentic-tool-validation.js';
import {
  createTenantDatabaseScopeAroundHook,
  deferWithTenantContext,
} from './utils/tenant-db-scope.js';
import {
  createUploadMiddleware,
  enforceTotalUploadSize,
  getUploadLimits,
  type StagedMulterFile,
} from './utils/upload.js';
import { getUploadStagingStore } from './utils/upload-staging.js';
import { UploadThumbnailCache } from './utils/upload-thumbnail.js';
import { WidgetResolutionStore } from './widgets/resolution-store.js';
import { resolveWidget } from './widgets/submissions.js';

const DEBUG_AUTH_EVENTS =
  process.env.DISCO_DEBUG_AUTH_EVENTS === '1' || process.env.DEBUG?.includes('auth-events');

function authEventDebug(...args: unknown[]): void {
  if (DEBUG_AUTH_EVENTS) {
    console.debug(...args);
  }
}

const DEBUG_TASK_QUEUE =
  process.env.DISCO_DEBUG_TASK_QUEUE === '1' || process.env.DEBUG?.includes('task-queue');

function taskQueueDebug(...args: unknown[]): void {
  if (DEBUG_TASK_QUEUE) {
    console.debug(...args);
  }
}

export class DiscoLocalStrategy extends LocalStrategy {
  async findEntity(username: string, params: Params) {
    markLocalAuthenticationLookup(params);
    return super.findEntity(username, params);
  }

  async getEntity(result: unknown, params: Params) {
    // Local login's final entity lookup also needs backend-only auth metadata
    // so freshly issued tokens can be bumped past a just-written invalidation
    // marker. The authentication hook redacts the metadata before returning.
    markAuthenticationUserLookup(params);
    return super.getEntity(result, params);
  }

  async authenticate(data: Parameters<LocalStrategy['authenticate']>[0], params: Params) {
    const { passwordField, usernameField, entity, entityPasswordField } = this.configuration;
    const fields = data as Record<string, unknown>;
    const username = fields[usernameField];
    const password = fields[passwordField];
    if (typeof password !== 'string' || password.length === 0) {
      throw new NotAuthenticated('密码错误');
    }

    const { provider, ...paramsWithoutProvider } = params;
    let result: unknown;
    try {
      result = await this.findEntity(String(username ?? ''), paramsWithoutProvider);
    } catch (error) {
      if (!(error instanceof NotAuthenticated)) throw error;

      // Match the bcrypt work performed for an existing username so the new
      // user-facing distinction does not also become a cheap timing oracle.
      const dummyEntity = {
        [entityPasswordField]: '$2b$10$dvw.HmmAraFDh31ufH/YdeyjaM0rNWERYXAQksDrGQImpUlmCFliS',
      };
      try {
        await this.comparePassword(dummyEntity, password);
      } catch {
        // Expected: the supplied password should not match the dummy hash.
      }
      throw new NotAuthenticated('用户名不存在', { code: 'USERNAME_NOT_FOUND' });
    }

    try {
      await this.comparePassword(result, password);
    } catch (error) {
      if (!(error instanceof NotAuthenticated)) throw error;
      throw new NotAuthenticated('密码错误', { code: 'PASSWORD_INCORRECT' });
    }

    return {
      authentication: { strategy: this.name ?? 'local' },
      [entity]: await this.getEntity(result, { ...params, provider }),
    };
  }
}

/**
 * Extended Params with route ID parameter.
 */
export interface RouteParams extends Params {
  route?: {
    id?: string;
    messageId?: string;
    mcpId?: string;
    name?: string;
  };
  user?: User;
  /** Trusted internal callback request, populated by MCP tooling only. */
  _taskCompletionCallback?: NonNullable<TaskMetadata['completion_callback']>;
}

/** Compatibility tombstone retained for stale Claude CLI restart clients. */
export function rejectRemovedClaudeCliRestart(): never {
  throw new BadRequest(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
}

/**
 * Interface for dependencies needed by route registration.
 */
export interface RegisterRoutesContext {
  db: TenantScopeAwareDatabase;
  app: Application & { io?: import('socket.io').Server };
  config: DiscoConfig;
  jwtSecret: string;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  enforcePasswordChange: (context: HookContext) => Promise<HookContext>;
  superadminOpts: { allowSuperadmin: boolean };
  DB_PATH: string;
  DAEMON_PORT: number;
  DAEMON_VERSION: string;
  /** User-facing disco-live release version advertised by protocol surfaces. */
  DISCO_VERSION: string;
  /**
   * Resolved build info (sha + builtAt). Surfaced on /health so the UI can
   * detect FE/BE drift after a deploy. The SHA is the canonical version
   * signal for the version-sync banner — see setup/build-info.ts.
   */
  DAEMON_BUILD_INFO: import('./setup/build-info.js').BuildInfo;
  /**
   * Resolved security config (CSP/CORS after defaults+extras+override merge).
   * Used by /health to surface the effective policy to admin users.
   */
  resolvedSecurity: import('@disco/core/config').ResolvedSecurity;
  realtimeRuntime?: Pick<
    import('./realtime/redis-realtime.js').RedisRealtimeRuntime,
    'health' | 'isReady'
  >;
  distributedWorkIdentity: import('@disco/core/coordination').DistributedWorkIdentity;
  deployment: ResolvedDeploymentConfig;

  // Service instances from registerServices()
  sessionsService: SessionsServiceImpl;
  usersRepository: UsersRepository;
  sessionsRepository: SessionRepository;
  sessionMCPServersService: ReturnType<
    typeof import('./services/session-mcp-servers.js').createSessionMCPServersService
  >;
  sessionEnvSelectionsService: ReturnType<
    typeof import('./services/session-env-selections.js').createSessionEnvSelectionsService
  >;
}

export async function authorizeTaskTerminalRoute(input: {
  id: string;
  params: RouteParams;
  tasksService: Pick<TasksServiceImpl, 'get'>;
}): Promise<RouteParams> {
  const internalParams = { ...input.params, provider: undefined };
  const userId = input.params.user?.user_id as UUID | undefined;
  if (!userId) throw new NotAuthenticated('Authentication required to update tasks');
  const task = await input.tasksService.get(input.id, internalParams);
  if (task.created_by !== userId) {
    throw new Forbidden('Only the Task owner can update this Task');
  }
  return internalParams;
}

export function findMatchingUnverifiedTerminationTask(
  tasks: readonly Task[],
  expected: { taskId: string; terminationRequestedAt: string }
): Task | undefined {
  return tasks.find(
    (task) =>
      task.task_id === expected.taskId &&
      task.status === TaskStatus.STOPPING &&
      task.sdk_failure?.termination === 'unverified' &&
      task.termination_request?.requested_at === expected.terminationRequestedAt
  );
}

/** Build the required short database unit used by authenticated long-route dependencies. */
export function createRequiredTenantDatabaseRunner(db: TenantScopeAwareDatabase) {
  return <T>(work: () => Promise<T>): Promise<T> => {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for database operation');
    return runWithTenantDatabaseScope(db, tenantId, work);
  };
}

export function createUploadAuthMiddleware(input: {
  authentication: {
    create(
      data: { strategy: 'jwt'; accessToken: string },
      params: AuthenticatedParams
    ): Promise<{ user?: User; authentication?: { payload?: unknown } }>;
  };
  multiTenancy: ReturnType<typeof resolveMultiTenancyConfig>;
}) {
  // biome-ignore lint/suspicious/noExplicitAny: Express 5 middleware request augmentation
  return async (req: any, res: any, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const authParams: AuthenticatedParams = { headers: req.headers };
      const result = await input.authentication.create(
        { strategy: 'jwt', accessToken: token },
        authParams
      );
      const authenticatedParams = {
        user: result.user,
        provider: 'rest',
        authentication: result.authentication,
        headers: req.headers,
      };
      req.feathers = {
        ...authenticatedParams,
        tenant:
          authParams.tenant ??
          resolveTenantContext(input.multiTenancy, {
            params: {
              authentication: result.authentication,
              headers: req.headers,
            },
            authPayload: result.authentication?.payload,
            headers: req.headers,
          }),
      };
      next();
    } catch (error) {
      console.error('❌ [Upload Auth] Authentication failed:', error);
      res.status(401).json({ error: 'Authentication required' });
    }
  };
}

export function resolveExecutorUploadReadOwner(
  claims: Record<string, unknown> | undefined,
  uploadRef: string
): { tenantId: TenantID; sessionId: SessionID; createdBy: UUID; ref: UploadRef } | null {
  if (
    isExecutorSessionTokenPayload(claims) &&
    typeof claims.tenant_id === 'string' &&
    typeof claims.sub === 'string'
  ) {
    const sessionId = getExecutorSessionTokenSessionId(claims);
    if (!sessionId) return null;
    return {
      tenantId: claims.tenant_id as TenantID,
      sessionId: sessionId as SessionID,
      createdBy: claims.sub as UUID,
      ref: uploadRef as UploadRef,
    };
  }

  return null;
}

export function resolveUploadHttpRange(
  rangeHeader: string | undefined,
  size: number
): { offset: number; length?: number; contentRange?: string } | null {
  if (!rangeHeader) return { offset: 0 };
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    end < offset ||
    offset >= size
  ) {
    return null;
  }
  const length = Math.min(end, size - 1) - offset + 1;
  return { offset, length, contentRange: `bytes ${offset}-${offset + length - 1}/${size}` };
}

export async function authorizeForceFailRoute(input: {
  session: Pick<Session, 'session_id' | 'created_by'>;
  params: RouteParams;
  body: Record<string, unknown>;
  findTask: (taskId: string) => Promise<Task | undefined>;
}): Promise<{ task: Task; confirmation: string; terminationRequestedAt: string }> {
  const userId = input.params.user?.user_id;
  if (!userId || input.session.created_by !== userId) {
    throw new Forbidden('Only the Session owner may force-fail a Task.');
  }
  if (typeof input.body.confirmation !== 'string') {
    throw new BadRequest('Type STOP to confirm force-fail.');
  }
  if (
    typeof input.body.task_id !== 'string' ||
    typeof input.body.termination_requested_at !== 'string'
  ) {
    throw new BadRequest('Force-fail requires the exact Task termination request.');
  }
  const candidate = await input.findTask(input.body.task_id);
  const task =
    candidate?.session_id === input.session.session_id
      ? findMatchingUnverifiedTerminationTask([candidate], {
          taskId: input.body.task_id,
          terminationRequestedAt: input.body.termination_requested_at,
        })
      : undefined;
  if (!task) {
    throw new Conflict(
      'The Task termination state changed. Review the current Task before force-failing.'
    );
  }
  return {
    task,
    confirmation: input.body.confirmation,
    terminationRequestedAt: input.body.termination_requested_at,
  };
}

/**
 * Register authentication configuration and custom REST routes.
 */
export async function registerRoutes(ctx: RegisterRoutesContext): Promise<void> {
  const {
    db,
    app,
    config,
    jwtSecret,
    requireAuth,
    enforcePasswordChange,
    DB_PATH,
    DAEMON_PORT: _DAEMON_PORT,
    DAEMON_VERSION,
    DISCO_VERSION,
    DAEMON_BUILD_INFO,
    resolvedSecurity,
    realtimeRuntime,
    distributedWorkIdentity,
    deployment,
    sessionsService,
    usersRepository: _usersRepository,
    sessionsRepository,
    sessionMCPServersService,
    sessionEnvSelectionsService,
  } = ctx;

  const usersService = app.service('users');
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;
  const tenantDatabaseScopeAround = createTenantDatabaseScopeAroundHook({ db, config, jwtSecret });
  const tenantIdentityAround = createTenantDatabaseScopeAroundHook({
    db,
    config,
    jwtSecret,
    transaction: false,
  });
  const inTenantDatabaseScope = <T>(hook: (context: HookContext) => T) =>
    async function scopedHook(context: HookContext): Promise<Awaited<T>> {
      return runWithTenantDatabaseScope(db, context.params.tenant?.tenant_id, async () =>
        hook(context)
      ) as Promise<Awaited<T>>;
    };
  const inCurrentTenantDatabaseScope = createRequiredTenantDatabaseRunner(db);

  /** Schedule orchestration after commit with tenant identity but no open transaction. */
  function deferInFreshTenantScope(params: RouteParams, fn: () => Promise<void>): void {
    deferWithTenantContext(params, fn);
  }

  const registerAuthenticatedRoute: typeof registerAuthenticatedRouteBase = (
    routeApp,
    path,
    service,
    authConfig,
    routeRequireAuth,
    options = {}
  ) =>
    registerAuthenticatedRouteBase(routeApp, path, service, authConfig, routeRequireAuth, {
      ...options,
      around: [tenantDatabaseScopeAround, ...(options.around ?? [])],
    });

  const registerLongAuthenticatedRoute: typeof registerAuthenticatedRouteBase = (
    routeApp,
    path,
    service,
    authConfig,
    routeRequireAuth,
    options = {}
  ) =>
    registerAuthenticatedRouteBase(routeApp, path, service, authConfig, routeRequireAuth, {
      ...options,
      around: [tenantIdentityAround, ...(options.around ?? [])],
    });

  // Long routes carry tenant identity without holding a route-wide database
  // transaction. Bind direct repository dependencies to short units of work;
  // hooked service calls establish their own scopes.
  const stopRouteTaskRepository = bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db));

  // Get sessionTokenService from app record
  const appRecord = app as unknown as Record<string, unknown>;
  const sessionTokenService = appRecord.sessionTokenService as
    | import('./services/session-token-service.js').SessionTokenService
    | undefined;

  // ============================================================================
  // Authentication Configuration
  // ============================================================================

  const authStrategiesArray = ['api-key', 'jwt', 'local'];
  const multiTenancy = resolveMultiTenancyConfig(config);
  const tenantTokenClaim = multiTenancy.auth_claim ?? 'tenant_id';
  if (sessionTokenService) {
    authStrategiesArray.push('session-token');
  }

  // Browser tokens use one shared lifetime definition. A one-hour access
  // token is long enough to tolerate mobile browser suspension without making
  // the 30-day refresh token redundant. Automatic refresh still happens
  // before expiry; the longer TTL is a safety margin, not the refresh policy.
  const ACCESS_TOKEN_TTL = BROWSER_ACCESS_TOKEN_TTL;
  const REFRESH_TOKEN_TTL = BROWSER_REFRESH_TOKEN_TTL;

  app.set('authentication', {
    secret: jwtSecret,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: authStrategiesArray,
    jwtOptions: {
      header: { typ: 'access' },
      audience: RUNTIME_JWT_AUDIENCE,
      issuer: RUNTIME_JWT_ISSUER,
      algorithm: 'HS256',
      expiresIn: ACCESS_TOKEN_TTL,
    },
    local: {
      usernameField: 'username',
      passwordField: 'password',
    },
  });

  // Configure authentication
  const authentication = new AuthenticationService(app);

  // Import custom JWT strategy that handles service tokens
  const { ServiceJWTStrategy } = await import('./auth/service-jwt-strategy.js');

  // Register authentication strategies
  authentication.register('jwt', new ServiceJWTStrategy(sessionTokenService, tenantTokenClaim));
  authentication.register('local', new DiscoLocalStrategy());

  // Register API key authentication strategy
  const { ApiKeyStrategy } = await import('./auth/api-key-strategy.js');
  const apiKeyStrategy = new ApiKeyStrategy();
  authentication.register('api-key', apiKeyStrategy);

  // Initialize API key strategy with dependencies
  const { UserApiKeysRepository } = await import('@disco/core/db');
  const userApiKeysRepo = new UserApiKeysRepository(db);
  apiKeyStrategy.setDependencies(userApiKeysRepo, usersService);

  // SECURITY: Stack two failed-attempt limiters on authentication + refresh:
  // a tighter IP+username bucket blocks targeted password guessing, while a
  // wider IP bucket prevents one client from rotating usernames indefinitely.
  //
  // express-rate-limit gives us standardized response headers
  // (`RateLimit-Limit/Remaining/Reset`, IETF draft-7) and `Retry-After` for
  // free, plus battle-tested concurrency / clock-skew handling. The default
  // in-memory MemoryStore is fine for solo/team deployments; multi-instance
  // operators can plug in a distributed store (redis, memcached) later
  // without touching this call site.
  //
  // Both are mounted at `/authentication`, covering the Feathers login service
  // and the custom refresh endpoint. Successful requests do not consume either
  // budget; standards-based response headers expose the retry window.
  const AUTH_IDENTITY_RATE_LIMIT_MAX = 10;
  const AUTH_IP_RATE_LIMIT_MAX = 100;
  const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

  const authIpRateLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    limit: AUTH_IP_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
      name: 'TooManyRequests',
      message: '登录尝试过多，请 15 分钟后再试',
      code: 429,
      className: 'too-many-requests',
    },
  });

  const authIdentityRateLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    limit: AUTH_IDENTITY_RATE_LIMIT_MAX,
    // Modern IETF draft-7 headers (RateLimit-*) — clients can back off.
    standardHeaders: 'draft-7',
    // Drop the legacy X-RateLimit-* set; they're noisy and non-standard.
    legacyHeaders: false,
    // Composite key on (ip, username). For the refresh sub-path the body has
    // no username, so we bucket purely by IP. Trust only Express's resolved
    // `req.ip` (which respects `app.set('trust proxy', n)`) — never
    // X-Forwarded-For directly.
    // express-rate-limit can resolve Feathers' Express 4 declaration copy
    // alongside the daemon's Express 5 declarations. The runtime request is
    // the same object; infer the middleware signature and narrow at our edge.
    keyGenerator: (req): string => buildAuthRateLimitKey(req as unknown as Request),
    skipSuccessfulRequests: true,
    message: {
      name: 'TooManyRequests',
      message: '用户名或当前网络的登录失败次数过多，请 15 分钟后再试',
      code: 429,
      className: 'too-many-requests',
    },
  });

  // Mount BEFORE the auth service so the limiter intercepts first. The same
  // middleware also covers /authentication/refresh below thanks to Express
  // path-prefix matching.
  // biome-ignore lint/suspicious/noExplicitAny: Feathers Application vs Express middleware overload
  app.use('/authentication', authIpRateLimiter as any);
  // biome-ignore lint/suspicious/noExplicitAny: Feathers Application vs Express middleware overload
  app.use('/authentication', authIdentityRateLimiter as any);

  app.use('/authentication', authentication);

  // Initialize SessionTokenService with JWT secret
  if (sessionTokenService) {
    sessionTokenService.setJwtSecret(jwtSecret);
    console.log('✅ SessionTokenService initialized with JWT secret (will generate JWTs)');
  }

  // Configure docs for authentication service
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const authService = app.service('authentication') as any;
  authService.docs = {
    description: 'Authentication service for user login and token management',
    security: [],
  };

  // Hook: Issue browser access + refresh tokens with millisecond issue time.
  // Machine-token logins (executor-session / service) keep their original
  // token — see createIssueBrowserTokensHook for why.
  // Rate limiting is enforced by express-rate-limit middleware mounted on
  // `/authentication` above — by the time we reach this hook the limiter
  // has already 429'd any over-quota request.
  authService.hooks({
    after: {
      create: [
        createIssueBrowserTokensHook({
          jwtSecret,
          accessTokenTtl: ACCESS_TOKEN_TTL,
          refreshTokenTtl: REFRESH_TOKEN_TTL,
          tenantClaim: tenantTokenClaim,
          debug: authEventDebug,
        }),
      ],
    },
  });

  // ============================================================================
  // Refresh token endpoint
  // ============================================================================

  app.use(
    '/authentication/refresh',
    createRefreshTokenService({
      jwtSecret,
      accessTokenTtl: ACCESS_TOKEN_TTL,
      refreshTokenTtl: REFRESH_TOKEN_TTL,
      tenantClaim: tenantTokenClaim,
      usersService,
    })
  );

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const refreshService = app.service('authentication/refresh') as any;
  refreshService.docs = {
    description: 'Token refresh endpoint - obtain a new access token using a refresh token',
    security: [],
  };

  // ============================================================================
  // Impersonation endpoint
  // ============================================================================

  const MAX_IMPERSONATION_EXPIRY_MS = 3_600_000; // 1 hour hard cap

  app.use('/authentication/impersonate', {
    async create(data: { user_id?: string; expiry_ms?: number }, params?: Params) {
      // 1. Caller must be authenticated
      const authParams = params as AuthenticatedParams;
      if (!authParams?.user?.user_id) {
        throw new NotAuthenticated('Authentication required');
      }

      const caller = authParams.user;

      // 2. Caller must have role: superadmin
      if (!hasMinimumRole(caller.role, ROLES.SUPERADMIN)) {
        throw new Forbidden('Superadmin role required for impersonation');
      }

      // 3. Caller token must NOT be an impersonated token (block recursive impersonation)
      // biome-ignore lint/suspicious/noExplicitAny: JWT payload has dynamic fields
      const authPayload = (authParams as any).authentication?.payload;
      if (authPayload?.is_impersonated === true) {
        throw new Forbidden('Cannot impersonate from an already-impersonated token');
      }

      // 4. user_id must be provided
      if (!data?.user_id) {
        throw new BadRequest('user_id is required');
      }

      // 5. Validate expiry_ms if provided
      if (data.expiry_ms != null) {
        if (typeof data.expiry_ms !== 'number' || !Number.isFinite(data.expiry_ms)) {
          throw new BadRequest('expiry_ms must be a finite number');
        }
        if (data.expiry_ms <= 0) {
          throw new BadRequest('expiry_ms must be a positive number');
        }
      }

      // 6. Target user must exist (uses usersService for consistency with refresh endpoint)
      let targetUser: User;
      try {
        targetUser = await usersService.get(data.user_id as import('@disco/core/types').UUID);
      } catch {
        throw new NotFound(`User not found: ${data.user_id}`);
      }

      // 8. Compute expiry (default 1h, capped at 1h)
      const configuredMax =
        config.daemon?.impersonation_token_expiry_ms ?? MAX_IMPERSONATION_EXPIRY_MS;
      const maxExpiry = Math.min(configuredMax, MAX_IMPERSONATION_EXPIRY_MS);
      const requestedExpiry = data.expiry_ms ?? maxExpiry;
      const expiryMs = Math.min(requestedExpiry, maxExpiry);

      // 9. Generate token
      const jti = generateId();
      const expiresAt = new Date(Date.now() + expiryMs);

      const accessToken = issueRuntimeToken(
        {
          sub: targetUser.user_id,
          type: 'access',
          impersonated_by: caller.user_id,
          is_impersonated: true,
          jti,
          ...authTokenIssuedAtClaim(Date.now(), targetUser),
        },
        jwtSecret,
        Math.ceil(expiryMs / 1000)
      );

      // 10. Audit log
      console.log(
        `[auth] impersonation issued: caller=${caller.user_id} target=${targetUser.user_id} jti=${jti} exp=${expiresAt.toISOString()}`
      );

      return {
        accessToken,
        user: {
          user_id: targetUser.user_id,
          username: targetUser.username,
          name: targetUser.name,
          emoji: targetUser.emoji,
          role: targetUser.role,
        },
      };
    },
  });

  // Apply auth hooks to impersonation endpoint
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const impersonateService = app.service('authentication/impersonate') as any;
  impersonateService.docs = {
    description:
      'Impersonation endpoint - superadmins can issue short-lived tokens scoped to any user',
  };
  impersonateService.hooks({
    before: {
      create: [requireAuth],
    },
  });

  // ============================================================================
  // Message streaming routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/messages/streaming',
    {
      async create(
        data: {
          event: StreamingEventType;
          data: Record<string, unknown>;
        },
        params: RouteParams
      ) {
        app.service('messages').emit(data.event, data.data);
        return { success: true };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'broadcast streaming events' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/tasks/streaming',
    {
      async create(
        data: {
          event: 'tool:start' | 'tool:complete' | 'thinking:chunk';
          data: Record<string, unknown>;
        },
        params: RouteParams
      ) {
        app.service('tasks').emit(data.event, data.data);
        return { success: true };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'broadcast task streaming events' },
    },
    requireAuth
  );

  // These routes re-emit canonical events onto the `messages` / `tasks`
  // services. Their own `{ success: true }` acknowledgements must not
  // broadcast as service events.
  app.service('/messages/streaming').publish(() => []);
  app.service('/tasks/streaming').publish(() => []);

  // ============================================================================
  // Sessions custom routes (fork, spawn, genealogy, prompt, stop, queue)
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/fork',
    {
      async create(data: { prompt: string; task_id?: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        console.log(`🔀 Forking session: ${shortId(id)}`);
        const forkedSession = await sessionsService.fork(id, data, params);
        console.log(`✅ Fork created: ${shortId(forkedSession.session_id)}`);

        // fork() persists through an internal service call, so emit the
        // standard event explicitly with its tenant/auth context. A raw
        // app.io.emit would bypass Feathers publication authorization and, in
        // HA, the Redis adapter would fan it out cluster-wide.
        emitServiceEvent(app, {
          path: 'sessions',
          event: 'created',
          data: forkedSession,
          params,
          id: forkedSession.session_id,
        });

        return forkedSession;
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'fork sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/spawn',
    {
      async create(data: Partial<import('@disco/core/types').SpawnConfig>, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        console.log(`🌱 Spawning session from: ${shortId(id)}`);
        const spawnedSession = await sessionsService.spawn(id, data, params);
        console.log(`✅ Spawn created: ${shortId(spawnedSession.session_id)}`);

        emitServiceEvent(app, {
          path: 'sessions',
          event: 'created',
          data: spawnedSession,
          params,
          id: spawnedSession.session_id,
        });

        return spawnedSession;
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'spawn sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/genealogy',
    {
      async find(params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        return sessionsService.getGenealogy(id, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS route handler type mismatch with Express RouteParams
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view session genealogy' },
    },
    requireAuth
  );

  /** Serialize prompt, stop and archive decisions for one Session. */
  const sessionTurnLocks: SessionTurnLocks = new Map();

  registerLongAuthenticatedRoute(
    app,
    '/sessions/:id/archive',
    {
      async create(data: { includeChildren?: boolean } | undefined, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        const sessionsServiceWithHooks = app.service('sessions') as unknown as SessionsServiceImpl;

        return withSessionTurnLock(sessionTurnLocks, id as SessionID, async () => {
          return archiveSessionNow({
            stop: () =>
              stopSessionPreserveQueue(
                {
                  app,
                  taskRepo: stopRouteTaskRepository,
                  sessionsService: sessionsServiceWithHooks,
                  findActiveTasks: (stopApp, sessionId, stopParams) =>
                    inCurrentTenantDatabaseScope(() =>
                      findActiveTasksForSession(stopApp, sessionId, stopParams)
                    ),
                },
                id as SessionID,
                params,
                { reason: 'Archived by user.' }
              ),
            // Archiving leaves the working set immediately. A queued prompt
            // must not restart this Session after the route has returned.
            findQueuedTasks: () => stopRouteTaskRepository.findQueued(id as SessionID),
            removeQueuedTask: (taskId) => tasksService.remove(taskId, params),
            archive: () =>
              inCurrentTenantDatabaseScope(() => sessionsService.archive(id, data, params)),
          });
        });
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'archive sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/unarchive',
    {
      async create(data: { includeChildren?: boolean } | undefined, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        return sessionsService.unarchive(id, data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'unarchive sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/restart-cli',
    {
      async create() {
        return rejectRemovedClaudeCliRestart();
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'restart sessions' },
    },
    requireAuth
  );

  /**
   * Per-session local turn coalescing. This reduces redundant preparatory
   * reads and duplicate drain triggers inside one daemon; it is not a
   * correctness authority. Queue-position admission and the Session+Task
   * dispatch fence in PostgreSQL are authoritative across daemons.
   */
  /**
   * Helper: Safely patch an entity, returning false if it was deleted mid-execution
   */
  async function safePatch<T>(
    serviceName: string,
    id: string,
    data: Partial<T>,
    entityType: string,
    params?: RouteParams
  ): Promise<boolean> {
    try {
      await app.service(serviceName).patch(id, data, params || {});
      return true;
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        (error instanceof Error && error.message.includes('No record found'))
      ) {
        console.log(`⚠️  ${entityType} ${shortId(id)} was deleted mid-execution - skipping update`);
        return false;
      }
      throw error;
    }
  }

  async function reconcileSessionPromptStateIfStuck(
    session: Session,
    taskRepo: TaskRepository,
    params: RouteParams,
    options: { ignoredTaskIds?: readonly string[] } = {}
  ): Promise<Session> {
    if (session.status !== SessionStatus.FAILED || session.ready_for_prompt === true) {
      return session;
    }

    const sessionTasks = await taskRepo.findBySession(session.session_id);
    if (!shouldReconcileSessionPromptState(session, sessionTasks, options)) return session;

    console.warn(
      `🧹 [PromptState] Repairing stuck session ${shortId(session.session_id)} ` +
        `(status=${session.status}, ready_for_prompt=${session.ready_for_prompt})`
    );
    return inCurrentTenantDatabaseScope(
      async () =>
        (await app.service('sessions').patch(
          session.session_id,
          {
            status: SessionStatus.IDLE,
            ready_for_prompt: true,
          },
          params
        )) as Session
    );
  }

  /**
   * Persist the first transcript row for a Task. Scheduled/idempotent prompts
   * pass a stable message ID, so a replacement daemon can repair a kill after
   * the dispatch claim without duplicating the prompt. Ordinary prompts retain
   * the historical best-effort/random-ID behavior and executor fallback.
   */
  async function ensureInitialUserMessage(
    task: Task,
    params: RouteParams,
    input: {
      messageStartIndex: number;
      startTimestamp: string;
      messageSource?: MessageSource;
      stableMessageId?: MessageID;
    }
  ): Promise<void> {
    if (config.execution?.daemon_writes_user_message === false) return;

    const messageRepo = bindRepositoryToTenantUnitOfWork(db, new MessagesRepository(db));
    if (input.stableMessageId) {
      const existing = await messageRepo.findById(input.stableMessageId);
      if (existing) {
        if (existing.session_id !== task.session_id || existing.task_id !== task.task_id) {
          throw new Conflict(
            `Stable initial message identity ${input.stableMessageId} is already in use`
          );
        }
        return;
      }
    }

    const isCallback = task.metadata?.is_disco_callback === true;
    const messageMetadata: Message['metadata'] = {};
    if (isCallback) messageMetadata.is_disco_callback = true;
    if (input.messageSource === 'disco') {
      messageMetadata.source = input.messageSource;
    }
    const userMessage = buildInitialUserMessage({
      messageId: input.stableMessageId,
      sessionId: task.session_id,
      taskId: task.task_id,
      index: input.messageStartIndex,
      timestamp: input.startTimestamp,
      content: task.full_prompt,
      type: isCallback ? 'system' : 'user',
      metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
    });

    try {
      await app.service('messages').create(userMessage, params);
    } catch (error) {
      if (input.stableMessageId) {
        const winner = await messageRepo.findById(input.stableMessageId);
        if (winner?.session_id === task.session_id && winner.task_id === task.task_id) return;
        throw error;
      }
      // Don't fail the spawn — the executor's createUserMessage fallback
      // (with skip-if-exists) will write the row when it connects.
      console.warn(
        formatStructuredLog('[messages.initial]', {
          event: 'write_failed',
          task_id: task.task_id,
          outcome: 'executor_retry',
          error_code: structuredLogErrorCode(error),
        })
      );
    }
  }

  /** Repair one stable initial transcript row from durable Task state. */
  async function reconcileStableInitialUserMessage(
    task: Task,
    params: RouteParams,
    stableMessageId: MessageID,
    fallback: {
      messageStartIndex?: number;
      startTimestamp?: string;
      messageSource?: MessageSource;
    } = {}
  ): Promise<void> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for message reconciliation');
    const persistedStartIndex = task.message_range?.start_index;
    const hasPersistedStartIndex =
      typeof persistedStartIndex === 'number' && persistedStartIndex >= 0;
    const fallbackStartIndex =
      typeof fallback.messageStartIndex === 'number' && fallback.messageStartIndex >= 0
        ? fallback.messageStartIndex
        : undefined;
    const messageStartIndex = hasPersistedStartIndex
      ? persistedStartIndex
      : (fallbackStartIndex ??
        (await runWithTenantDatabaseScope(db, tenantId, () =>
          sessionsRepository.countMessages(task.session_id)
        )));
    const startTimestamp =
      (hasPersistedStartIndex ? task.message_range?.start_timestamp : undefined) ??
      task.started_at ??
      fallback.startTimestamp ??
      new Date().toISOString();
    const persistedSource = task.metadata?.source ?? fallback.messageSource;
    const messageSource = persistedSource === 'disco' ? persistedSource : undefined;

    await ensureInitialUserMessage(task, params, {
      messageStartIndex,
      startTimestamp,
      messageSource,
      stableMessageId,
    });
  }

  /**
   * spawnTaskExecutor — sole transition point for `tasks.status` going from
   * `created` / `queued` → `dispatching`.
   *
   * Both POST /sessions/:id/prompt's immediate queue-head attempt and the
   * queued-task drainer call this helper. Centralising the transition
   * guarantees that:
   *
   *   - `message_range.start_index`, `git_state.{ref,sha}_at_start`, and
   *     `started_at` are recomputed against fresh state right before the
   *     executor is spawned (sentinels on the stored row are only ever
   *     visible while `status='queued'`).
   *   - The initial user-message row is written by the daemon synchronously,
   *     before the executor process is forked. Without this, any crash
   *     during executor startup loses the prompt from the chat transcript
   *     even though `tasks.full_prompt` still has the text. Gated by
   *     `config.execution.daemon_writes_user_message` (kill switch — see
   *     §5.E of `docs/never-lose-prompt-design.md`).
   *   - `task.metadata.is_disco_callback` / `task.metadata.source` are
   *     re-stamped onto the new message so the UI's callback styling
   *     (`MessageBlock.tsx`) survives the queue → run transition.
   *   - Spawn failures synthesise a `type:'system'` error message so the
   *     chat surfaces *why* the assistant didn't respond, instead of silently
   *     leaving a ghost task in FAILED with no transcript trace.
   *
   * The session.tasks list is appended here too, so callers don't have to
   * remember to do it themselves.
   */
  async function spawnTaskExecutor(
    task: Task,
    options: {
      permissionMode?: import('@disco/core/types').PermissionMode;
      stream?: boolean;
      messageSource?: MessageSource;
      stableInitialMessageId?: MessageID;
    },
    params: RouteParams
  ): Promise<Task> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for task executor startup');
    const stableInitialMessageId = stableInitialMessageIdForTask(
      task,
      options.stableInitialMessageId
    );
    const persistedMessageSource = task.metadata?.source ?? options.messageSource;
    const runtimeMessageSource =
      persistedMessageSource === 'disco' ? persistedMessageSource : undefined;

    // A stable scheduled Task that has crossed the dispatch fence needs only
    // deterministic projection repair. Do not make that reconciliation depend
    // on mutable launch-time state (tool enablement, preset validity, or user
    // defaults): no new executor launch will occur on this path.
    if (shouldReconcileStableInitialMessage(task, stableInitialMessageId)) {
      await reconcileStableInitialUserMessage(task, params, stableInitialMessageId, {
        messageSource: runtimeMessageSource,
      });
      return task;
    }

    const {
      agenticToolEnabled,
      messageStartIndex,
      session: loadedSession,
    } = await runWithTenantDatabaseScope(db, tenantId, async () => {
      const session = await sessionsService.get(task.session_id, params);
      const agenticTool = requireActiveAgenticTool(session.agentic_tool);
      return {
        session,
        agenticToolEnabled: await isAgenticToolEnabledForTenant(db, tenantId, agenticTool),
        // Recompute message_range.start_index against the live message count.
        messageStartIndex: await sessionsRepository.countMessages(task.session_id),
      };
    });
    if (!agenticToolEnabled) {
      throw new Forbidden(`${loadedSession.agentic_tool} is disabled for this workspace`);
    }
    const session = await runWithTenantDatabaseScope(db, tenantId, () =>
      sessionsService.materializeAgenticToolPreset(loadedSession, params)
    );
    const startTimestamp = new Date().toISOString();

    // The daemon persists launch intent and writes required sentinel git fields
    // before executor spawn. Executors claim DISPATCHING → RUNNING after
    // authenticating.
    const gitStateAtStart = 'unknown';
    const refAtStart = 'unknown';

    const launchState = buildTaskLaunchState(
      startTimestamp,
      config.execution?.executor_command_template ? 'templated' : 'local'
    );

    if (!isTaskPendingDispatch(task)) return task;

    // Atomically claim queued/created → launch status. Process-local session
    // locks reduce contention, but this expected-state transition is the
    // cross-daemon fence that prevents duplicate executor launches.
    const dispatchClaim = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
      await assertTenantWritable(tenantDb, tenantId);
      return tasksService.claimDispatchAndProjectSession(
        task.task_id,
        task.status,
        {
          ...launchState,
          ...(launchState.executor_mode
            ? { sdk_watchdog_mode: resolveSdkWatchdogConfig(config.execution).mode }
            : {}),
          queue_position: undefined,
          message_range: {
            start_index: messageStartIndex,
            end_index: messageStartIndex + 1,
            start_timestamp: startTimestamp,
            end_timestamp: startTimestamp,
          },
          git_state: {
            ref_at_start: refAtStart,
            sha_at_start: gitStateAtStart,
          },
        },
        { ...params, provider: undefined }
      );
    });
    if (dispatchClaim.outcome !== 'claimed') {
      const workIdentity = app.get('distributedWorkIdentity');
      console.info(
        formatStructuredLog('[distributed-work.task-dispatch]', {
          event: 'claim_lost',
          instance_id: workIdentity?.instanceId,
          boot_id: workIdentity?.bootId,
          tenant_id: tenantId,
          task_id: task.task_id,
          session_id: task.session_id,
          observed_status: dispatchClaim.task.status,
        })
      );
      if (shouldReconcileStableInitialMessage(dispatchClaim.task, stableInitialMessageId)) {
        await reconcileStableInitialUserMessage(
          dispatchClaim.task,
          params,
          stableInitialMessageId,
          {
            messageStartIndex,
            startTimestamp,
            messageSource: runtimeMessageSource,
          }
        );
      }
      return dispatchClaim.task;
    }
    const updatedTask = dispatchClaim.task;

    // Alt D — write the user-message row before spawning. Gated by kill switch.
    // The executor's createUserMessage has a skip-if-exists guard so a duplicate
    // write is harmless if the daemon path is enabled.
    // Prefer task.metadata.source (set when the task was queued) over the
    // request's messageSource — the latter applies only to this drain tick.
    if (stableInitialMessageId) {
      await reconcileStableInitialUserMessage(updatedTask, params, stableInitialMessageId, {
        messageStartIndex,
        startTimestamp,
        messageSource: runtimeMessageSource,
      });
    } else {
      await ensureInitialUserMessage(task, params, {
        messageStartIndex,
        startTimestamp,
        messageSource: runtimeMessageSource,
      });
    }

    // Re-apply the Session projection through Feathers so hooks/realtime see
    // the transition. TaskRepository.claimDispatchAndProjectSession already
    // committed the same projection atomically with the Task fence; this
    // service patch is no longer correctness-critical on SQLite and is
    // intentionally idempotent.
    //
    // The session-status flip used to fall out of `TasksService.create` when
    // the IDLE path created a task with `status: RUNNING` directly. Now the
    // IDLE path creates `status: CREATED` and we patch the task here, which
    // `TasksService.patch` does NOT mirror onto the session. Without this
    // explicit patch, `session.status` stays IDLE while a task is RUNNING,
    // causing the queue gate in the prompt route to wave subsequent prompts
    // through instead of queuing them.
    await runWithTenantDatabaseScope(db, tenantId, () =>
      app.service('sessions').patch(
        task.session_id,
        {
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
          tasks: [...session.tasks, task.task_id],
        },
        params
      )
    );

    // Tag the bytes shipped to the executor with `[Prompted by: ...]` when a
    // non-owner is prompting. The prompter identity comes from `task.created_by`
    // (NOT `params.user`): every persisted Task row requires `created_by`
    // (`createPending` for the prompt/queue/callback paths and `create` for
    // pre-created tasks run via `/tasks/:id/run`), so it survives the queue
    // / hook / drain hop intact. `params.user` can drop on hook-triggered drains
    // that don't carry `queued_by_user_id` and is therefore not authoritative.
    // See `./utils/build-prompter-prefix.ts` for the helper + tests.
    const { prompt: promptForExecutor } = await buildPrompterPrefixedPrompt({
      rawPrompt: task.full_prompt,
      sessionCreatedBy: session.created_by,
      prompterUserId: task.created_by,
      usersRepo: bindRepositoryToTenantUnitOfWork(db, new UsersRepository(db)),
    });

    const useStreaming = options.stream !== false;
    const sessionId = task.session_id;
    const taskId = task.task_id;

    // Background spawn + failure handling. Returning the patched Task to the
    // caller before this resolves matches the previous behavior — the HTTP
    // response should not block on the executor process being live.
    // deferInFreshTenantScope uses a fresh DB connection and tenant RLS scope
    // instead of inheriting a stale committed transaction.
    deferInFreshTenantScope(params, async () => {
      try {
        console.log(
          `🚀 [Daemon] Routing ${session.agentic_tool} to Feathers/WebSocket executor (task ${shortId(taskId)})`
        );

        await sessionsService.executeTask(
          sessionId,
          {
            taskId,
            prompt: promptForExecutor,
            permissionMode: options.permissionMode,
            stream: useStreaming,
            messageSource: runtimeMessageSource,
          },
          params
        );

        console.log(
          `✅ [Daemon] Executor spawned for session ${shortId(sessionId)}, waiting for task completion`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `❌ [Daemon] Executor spawn failed for session=${shortId(sessionId)} task=${shortId(taskId)} agent=${session.agentic_tool} unix_username=${session.unix_username ?? 'null'}: ${errorMessage}`,
          error
        );
        await safePatch(
          'tasks',
          taskId,
          {
            status: TaskStatus.FAILED,
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
          },
          'Task',
          params
        );

        // Synthesize a system message so the chat surfaces *why* the agent
        // didn't respond. Without this the transcript shows only the user
        // prompt and silence even though the task list reads FAILED.
        try {
          // Recompute the next index instead of trusting `messageStartIndex
          // + 1` — the daemon-write user-message above is wrapped in a
          // try/catch and may have been swallowed, leaving a gap at
          // `messageStartIndex`. countMessages always reports the live row
          // count, so it lands the system error at the true tail whether
          // the user-message row exists or not (no gap, no collision).
          const errorContent = `⚠️ The agent failed to start.\n\n${errorMessage}`;
          await appendSystemMessage({
            app,
            db,
            sessionId,
            taskId,
            content: errorContent,
            role: MessageRole.ASSISTANT,
            metadata: { is_meta: true },
            params,
          });
        } catch (sysErr) {
          console.warn(
            '[Daemon] Failed to write system error message after spawn failure:',
            sysErr
          );
        }

        try {
          app.service('tasks').emit('failed', {
            task_id: taskId,
            session_id: sessionId,
            error_message: errorMessage,
          });
        } catch (emitErr) {
          console.warn('[Daemon] Failed to emit tasks:failed event:', emitErr);
        }
      }
    });

    return updatedTask;
  }

  // ============================================================================
  // Prompt endpoint
  // ============================================================================

  registerLongAuthenticatedRoute(
    app,
    '/sessions/:id/prompt',
    {
      async create(
        data: {
          prompt: string;
          permissionMode?: import('@disco/core/types').PermissionMode;
          stream?: boolean;
          steer?: boolean;
          messageSource?: MessageSource;
          /**
           * Internal-only task metadata merged onto the queued/created task.
           * Used by daemon callers (e.g. widget submissions) to stamp
           * traceability fields like `system_authored` / `widget_id`.
           * External transports are rejected, and the metadata builder also
           * strips every internal field defensively for untrusted callers.
           */
          metadata?: InternalPromptTaskMetadataInput;
          /**
           * Internal-only stable task identity for idempotent producers such
           * as the scheduler. External callers may not set this field.
           */
          idempotencyTaskId?: UUID;
        },
        params: RouteParams
      ) {
        console.log(
          `📨 [Daemon] Prompt request for session ${params.route?.id ? shortId(params.route.id) : 'unknown'}`
        );
        console.log(`   Permission mode: ${data.permissionMode || 'not specified'}`);
        console.log(`   Streaming: ${data.stream !== false}`);
        console.log(`   Message source: ${data.messageSource || 'not specified'}`);

        let id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.prompt) throw new Error('Prompt required');
        if (data.idempotencyTaskId && params.provider) {
          throw new Forbidden('idempotencyTaskId is internal-only');
        }
        if (data.metadata !== undefined && params.provider) {
          throw new Forbidden('Task metadata is internal-only');
        }
        const promptTenantId = getCurrentTenantId();
        if (!promptTenantId) throw new Error('Missing active tenant context for prompt admission');
        await runWithTenantDatabaseScope(db, promptTenantId, (tenantDb) =>
          assertTenantWritable(tenantDb, promptTenantId)
        );

        // Derive external provenance server-side. Only provider-less,
        // daemon-internal producers may preserve an explicit gateway source.
        const messageSource = normalizeMessageSource(data.messageSource, params);
        if (messageSource !== data.messageSource && data.messageSource !== undefined) {
          console.warn(
            `[Daemon] Ignored caller-supplied messageSource: ${data.messageSource}; using ${messageSource ?? 'no source'}`
          );
        }

        const requestedSessionId = id;
        let session = await runWithTenantDatabaseScope(db, promptTenantId, () =>
          sessionsService.get(requestedSessionId, params)
        );
        id = session.session_id;
        const taskRepo = bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db));

        // Admission uses direct Session ownership. Repository/Branch sharing
        // never grants one Disco user access to another user's conversation.
        const isInternalPrompt = !params.provider;
        const isPromptServiceAccount =
          (params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount === true;
        if (!isInternalPrompt && !isPromptServiceAccount) {
          assertSessionOwnedByActor(params.user, session);
        }

        const reconcileDurablyDispatchedTask = async (): Promise<Task | null> => {
          if (!data.idempotencyTaskId) return null;
          const prior = await taskRepo.findById(data.idempotencyTaskId);
          if (!prior) return null;
          if (prior.session_id !== id) {
            throw new Conflict(`Task identity ${data.idempotencyTaskId} is already in use`);
          }
          const expectedCreator = params.user?.user_id ?? session.created_by;
          if (prior.created_by !== expectedCreator || prior.full_prompt !== data.prompt) {
            throw new Conflict(`Task identity ${data.idempotencyTaskId} is already in use`);
          }
          if (isTaskPendingDispatch(prior)) return null;

          await reconcileStableInitialUserMessage(
            prior,
            params,
            prior.metadata?.initial_message_id ?? (data.idempotencyTaskId as MessageID)
          );
          return prior;
        };

        // Scheduled recovery is reconciliation, not a fresh launch admission,
        // once its stable Task has crossed the durable dispatch fence. Return
        // that Task before consulting mutable tool/preset/user configuration.
        const durableTask = await reconcileDurablyDispatchedTask();
        if (durableTask) return durableTask;

        try {
          const activeAgenticTool = requireActiveAgenticTool(session.agentic_tool);
          if (!(await isAgenticToolEnabledForTenant(db, promptTenantId, activeAgenticTool))) {
            throw new Forbidden(`${activeAgenticTool} is disabled for this workspace`);
          }
          session = await runWithTenantDatabaseScope(db, promptTenantId, () =>
            sessionsService.materializeAgenticToolPreset(session, params)
          );
          if (
            session.agentic_tool_preset_id &&
            data.permissionMode !== undefined &&
            data.permissionMode !== session.permission_config?.mode
          ) {
            throw new Forbidden('Preset-backed sessions cannot override permission mode per task');
          }
        } catch (error) {
          // Another daemon can cross the dispatch fence between the first
          // stable-Task read and launch admission. Re-check before surfacing a
          // mutable configuration failure; the winner no longer needs launch.
          const concurrentlyDurableTask = await reconcileDurablyDispatchedTask();
          if (concurrentlyDurableTask) return concurrentlyDurableTask;
          throw error;
        }

        if (data.steer) {
          if (session.agentic_tool !== 'codex') {
            throw new BadRequest('追加提示目前仅支持正在运行的 Codex 会话');
          }
          if (!params.user?.user_id) {
            throw new NotAuthenticated('Authentication required to steer a session');
          }
          const steeringUserId = params.user.user_id;

          const steeringResult = await withSessionTurnLock(
            sessionTurnLocks,
            id as SessionID,
            async () => {
              const lockedSession = await runWithTenantDatabaseScope(db, promptTenantId, () =>
                sessionsService.get(id, params)
              );
              if (lockedSession.status === SessionStatus.STOPPING) {
                throw new Conflict('当前任务正在停止，无法追加提示');
              }

              const activeTask = (
                await findActiveTasksForSession(app, id as SessionID, params)
              ).find((task) => task.status !== TaskStatus.STOPPING);
              if (!activeTask) {
                // The task may have crossed its terminal boundary after the UI
                // rendered the non-interrupting hint state but before this
                // request acquired the session lock. Treat that race as a new
                // turn instead of failing a perfectly valid user message.
                return null;
              }

              const hint = {
                hint_id: generateId(),
                message_id: generateId() as MessageID,
                prompt: data.prompt,
                created_at: new Date().toISOString(),
                created_by: steeringUserId,
              };
              let patched: Task;
              try {
                patched = (await tasksService.patch(
                  activeTask.task_id,
                  {
                    metadata: {
                      ...activeTask.metadata,
                      steering_hints: [...(activeTask.metadata?.steering_hints ?? []), hint],
                    },
                  },
                  // This route has already authenticated the user and verified
                  // prompt access. Publish the server-owned metadata mutation as
                  // an internal call so the external task-write guard continues
                  // to reject arbitrary client patches.
                  { ...params, provider: undefined }
                )) as Task;
              } catch (error) {
                // Completion does not take the process-local Session turn lock.
                // If it won between the active-task read and metadata patch,
                // fall through to ordinary prompt admission. Preserve genuine
                // patch failures while another Task still owns the turn.
                const stillActive = (
                  await findActiveTasksForSession(app, id as SessionID, params)
                ).some((task) => task.status !== TaskStatus.STOPPING);
                if (!stillActive) return null;
                throw error;
              }

              if (!isTaskExecuting(patched) || patched.status === TaskStatus.STOPPING) {
                // The terminal write won concurrently. The user text must not
                // disappear into metadata that no executor can consume; admit
                // it below as a fresh Task instead.
                return null;
              }

              emitServiceEvent(app, {
                path: 'tasks',
                event: 'steering_requested',
                data: patched,
                id: patched.task_id,
                method: 'patch',
                params,
              });

              return {
                success: true,
                taskId: patched.task_id,
                status: patched.status,
                streaming: true,
                queued: false,
                steered: true,
                messageId: hint.message_id,
              };
            },
            { waiterTimeoutMs: 30_000 }
          );
          if (steeringResult) return steeringResult;
        }

        // Auto-unarchive on prompt
        if (session.archived) {
          console.log(
            `📦 [Prompt] Auto-unarchiving session ${shortId(id)} (was archived: ${session.archived_reason || 'unknown reason'})`
          );
          session = (await runWithTenantDatabaseScope(db, promptTenantId, () =>
            sessionsService.patch(id, { archived: false, archived_reason: undefined }, params)
          )) as typeof session;
        }

        if (session.status === SessionStatus.STOPPING) {
          throw new Error('Cannot send prompt: session is currently stopping');
        }

        // Every prompt first takes one durable queue position. The subsequent
        // Session+Task database claim decides whether this Task leaves the
        // queue immediately or remains queued. This avoids a split
        // read-session/create-CREATED race: two daemons can admit concurrently,
        // but only the durable head can claim the idle Session.
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to prompt a session');
        }
        const createdBy = params.user.user_id;

        return await withSessionTurnLock(
          sessionTurnLocks,
          id as SessionID,
          async () => {
            let lockedSession = await runWithTenantDatabaseScope(db, promptTenantId, () =>
              sessionsService.get(id, params)
            );
            if (lockedSession.status === SessionStatus.STOPPING) {
              // The earlier STOPPING check was against pre-lock state — re-check
              // here so a session that entered STOPPING while we waited for our
              // turn doesn't accept a prompt.
              throw new Error('Cannot send prompt: session is currently stopping');
            }
            lockedSession = await reconcileSessionPromptStateIfStuck(
              lockedSession,
              taskRepo,
              params
            );

            const prior = data.idempotencyTaskId
              ? await taskRepo.findById(data.idempotencyTaskId)
              : null;
            if (prior && prior.session_id !== id) {
              throw new Conflict(`Task identity ${data.idempotencyTaskId} is already in use`);
            }

            const taskMetadata = buildPromptTaskMetadata(data.metadata, messageSource, createdBy, {
              trustedInternalMetadata: !params.provider,
            });
            if (data.idempotencyTaskId) {
              taskMetadata.initial_message_id = data.idempotencyTaskId as MessageID;
            }
            if (params._taskCompletionCallback) {
              taskMetadata.completion_callback = params._taskCompletionCallback;
            }
            const task = await taskRepo.createPending({
              task_id: data.idempotencyTaskId,
              session_id: id as SessionID,
              full_prompt: data.prompt,
              created_by: createdBy,
              status: TaskStatus.QUEUED,
              metadata: Object.keys(taskMetadata).length > 0 ? taskMetadata : undefined,
            });
            await tasksService.autoTitleSession(task, params);

            if (!prior) {
              // Repository admission bypasses TasksService.create. Publish the
              // entity before its possible patched/dispatch event so reactive
              // clients observe a coherent lifecycle.
              emitServiceEvent(app, {
                path: 'tasks',
                event: 'created',
                data: task,
                params,
                id: task.task_id,
              });
            }

            const admitted = await spawnTaskExecutor(
              task,
              {
                permissionMode: data.permissionMode,
                stream: data.stream !== false,
                messageSource,
                ...(data.idempotencyTaskId
                  ? { stableInitialMessageId: data.idempotencyTaskId as MessageID }
                  : {}),
              },
              params
            );

            if (admitted.status === TaskStatus.QUEUED) {
              console.log(
                `📬 [Prompt] Queued task for session ${shortId(id)} at position ${admitted.queue_position} ` +
                  `(observed session status: ${lockedSession.status})`
              );
              app.service('tasks').emit('queued', admitted);

              // Immediate triggers are a latency hint. Durable all-daemon
              // discovery remains the recovery path if this process dies or
              // another claim changes the Session after our observation.
              deferInFreshTenantScope(params, async () => {
                try {
                  await sessionsService.triggerQueueProcessing(id as SessionID, params);
                } catch (error) {
                  console.error(`❌ [Prompt] Failed to trigger queued Task processing:`, error);
                }
              });
            }

            // Uniform response: QUEUED means durable wait; DISPATCHING/RUNNING
            // means this or another daemon already won the launch claim.
            return admitted;
          },
          { waiterTimeoutMs: 30_000 }
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'execute prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // Task run endpoint
  //
  // Explicit executor trigger for an already-created task. Lets pure-REST
  // harnesses (Python, Go, shell+curl — anything without an MCP client) drive
  // the executor by POSTing a Task row first (`POST /tasks`) and then poking
  // it awake here. Wraps `spawnTaskExecutor` via `runExistingTask` (status
  // revalidation) under `withSessionTurnLock` — the same shared session-level
  // mutex that `/sessions/:id/prompt`'s idle branch and the queue drainer
  // also acquire — so the on-the-wire effect is identical to "create a task
  // and run it now."
  //
  // Only CREATED tasks on IDLE sessions are accepted. QUEUED tasks are
  // rejected with a hint to wait for the queue drainer (running them out of
  // order would violate the queue-position invariant); busy sessions are
  // rejected with a hint to use `POST /sessions/:id/prompt` (which owns the
  // atomic create-and-queue path). Splitting the two responsibilities keeps
  // this endpoint a narrow "run this thing now" trigger.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/run',
    {
      async create(
        data: {
          permissionMode?: import('@disco/core/types').PermissionMode;
          stream?: boolean;
          messageSource?: MessageSource;
        },
        params: RouteParams
      ) {
        const taskId = params.route?.id;
        if (!taskId) throw new BadRequest('Task ID required');

        const taskRepo = new TaskRepository(db);
        const task = await taskRepo.findById(taskId);
        if (!task) {
          throw new NotFound(`Task ${taskId} not found`);
        }

        // Only CREATED tasks may be triggered. QUEUED tasks must drain in
        // queue-position order via the queue processor — running them out of
        // order would violate the invariant documented in
        // `context/concepts/task-queueing.md`. Terminal/in-flight states are
        // rejected so the caller doesn't try to revive a finished task or
        // race a live executor.
        if (task.status !== TaskStatus.CREATED) {
          const hint =
            task.status === TaskStatus.QUEUED
              ? `Queued tasks drain automatically in queue-position order ` +
                `when the session becomes idle — wait for it, or stop the ` +
                `currently running task to free the queue.`
              : `Only 'created' tasks may be triggered.`;
          throw new Conflict(
            `Task ${shortId(taskId)} cannot be run: status is '${task.status}'. ${hint}`
          );
        }

        // Direct Session ownership is the execution boundary. Internal daemon
        // calls and the scoped executor service account retain their narrow
        // bypass; ordinary users may only run their own Session's tasks.
        const isInternalCall = !params.provider;
        const isServiceAccount =
          (params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount === true;
        if (task.session_id && !isInternalCall && !isServiceAccount) {
          const session = await sessionsService.get(task.session_id, params);
          assertSessionOwnedByActor(params.user, session);
        }

        // The local lock coalesces same-process contenders. The repository's
        // Session-first dispatch claim is authoritative against other daemons
        // and also refuses to jump a durable prompt queue.
        return await withSessionTurnLock(
          sessionTurnLocks,
          task.session_id,
          async () => {
            // Re-read session state inside the lock — it may have flipped to
            // RUNNING while we waited for our turn.
            const session = await reconcileSessionPromptStateIfStuck(
              await sessionsService.get(task.session_id, params),
              taskRepo,
              params,
              { ignoredTaskIds: [task.task_id] }
            );

            if (session.status === SessionStatus.STOPPING) {
              throw new BadRequest('Cannot run task: session is currently stopping');
            }
            if (!sessionCanStartTask(session.status, session.ready_for_prompt)) {
              throw new Conflict(
                `Cannot run task ${shortId(taskId)}: session is '${session.status}'. ` +
                  `To enqueue a prompt on a busy session, POST to /sessions/:id/prompt instead — ` +
                  `it creates and queues a task atomically.`
              );
            }

            const result = await runExistingTask(
              task,
              {
                permissionMode: data.permissionMode,
                stream: data.stream !== false,
                messageSource: normalizeMessageSource(data.messageSource, params),
              },
              params,
              {
                findTaskById: (id) => taskRepo.findById(id),
                spawnFn: spawnTaskExecutor,
              }
            );
            if (result.status === TaskStatus.CREATED) {
              throw new Conflict(
                `Cannot run task ${shortId(taskId)}: another Task or queued prompt owns the Session turn.`
              );
            }
            return result;
          },
          { waiterTimeoutMs: 30_000 }
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'execute prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // Spawn-subsession prompt endpoint
  //
  // Renders the bundled spawn-subsession meta-prompt server-side and forwards
  // it to /sessions/:id/prompt in a single round-trip. Clients send raw
  // `{userPrompt, config}` instead of doing the render-then-prompt dance.
  // The daemon owns the meta-prompt template, so the UI bundle stays
  // Handlebars-free.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/spawn-prompt',
    {
      async create(
        data: {
          userPrompt?: string;
          /**
           * Permission mode for the *parent* session's prompt. The spawn
           * config's `permissionMode` (child's intended mode) is rendered into
           * the meta-prompt; this field governs how the parent prompt is sent.
           */
          parentPermissionMode?: import('@disco/core/types').PermissionMode;
          // Remaining fields are spawn-subsession context (incl. the *child*
          // session's permissionMode/modelConfig/etc) — see
          // `SpawnSubsessionContext` in @disco/core for the shape.
          [key: string]: unknown;
        },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (typeof data?.userPrompt !== 'string') {
          throw new BadRequest('userPrompt (string) is required');
        }

        const { renderSpawnSubsessionPrompt } = await import(
          '@disco/core/templates/spawn-subsession-template'
        );
        // Render the meta-prompt against the child-session config (the rest
        // of `data`). `parentPermissionMode` is intentionally excluded — it's
        // the parent's send-mode, not part of the template.
        const { parentPermissionMode, ...spawnContext } = data;
        const metaPrompt = renderSpawnSubsessionPrompt(
          spawnContext as unknown as import('@disco/core/templates/spawn-subsession-template').SpawnSubsessionContext
        );

        const promptService = app.service('/sessions/:id/prompt');
        return promptService.create(
          { prompt: metaPrompt, permissionMode: parentPermissionMode, messageSource: 'disco' },
          { ...params, route: { id } }
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'send spawn-subsession prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // File upload endpoint
  // ============================================================================

  const uploadRepo = new UploadRepository(db);
  const uploadMiddleware = createUploadMiddleware(getUploadStagingStore());

  // Executor-only data plane for staged upload materialization. The scoped
  // service token stays in the Authorization header (never URL/query/logs) and
  // binds exactly one tenant + session + upload handle.
  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on FeathersJS Application type
  (app as any).get('/executor/uploads/:uploadRef/content', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const result = await app.service('authentication').create({
        strategy: 'jwt',
        accessToken: authHeader.slice(7),
      });
      const claims = result.authentication?.payload as Record<string, unknown> | undefined;
      const uploadRef = req.params.uploadRef;
      const authority = resolveExecutorUploadReadOwner(claims, uploadRef);
      if (!authority) {
        return res.status(403).json({ error: 'Upload transfer capability denied' });
      }
      const upload = await runWithTenantDatabaseScope(db, authority.tenantId, () =>
        uploadRepo.findOwned(authority.tenantId, authority.ref)
      );
      if (
        upload?.status !== 'active' ||
        upload.sessionId !== authority.sessionId ||
        upload.createdBy !== authority.createdBy
      ) {
        return res.status(403).json({ error: 'Upload transfer capability denied' });
      }
      const owner = {
        ...authority,
        agentId: upload.agentId,
      };
      const store = getUploadStagingStore();
      const metadata = await store.inspect(owner);
      const stream = await store.read(owner);
      res.status(200);
      res.setHeader('Content-Type', metadata.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', String(metadata.size));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      stream.once('error', (error) => {
        if (!res.headersSent) res.status(500);
        res.destroy(error as Error);
      });
      res.once('close', () =>
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
      );
      stream.pipe(res);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 404;
      if (!res.headersSent) res.status(status).json({ error: 'Upload transfer unavailable' });
      else res.destroy();
    }
  });

  const DEBUG_UPLOAD = process.env.NODE_ENV !== 'production';

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
  const authorizeUpload: any = async (req: any, res: any, next: any) => {
    try {
      const { sessionId } = req.params;
      const params = req.feathers as AuthenticatedParams;

      ensureMinimumRole(params, ROLES.MEMBER, 'upload files');

      const session = await runWithTenantDatabaseScope(db, params.tenant?.tenant_id, () =>
        sessionsService.get(sessionId, params)
      );
      if (!session) {
        console.error(`❌ [Upload Authz] Session not found: ${shortId(sessionId)}`);
        return res.status(404).json({ error: 'Session not found' });
      }

      if (
        !params.tenant?.tenant_id ||
        !params.user?.user_id ||
        session.created_by !== params.user.user_id
      ) {
        return res.status(403).json({ error: 'Upload ownership context unavailable' });
      }
      req._uploadOwner = {
        tenantId: params.tenant.tenant_id,
        sessionId: session.session_id,
        createdBy: params.user.user_id,
        agentId: session.agent_id ?? null,
      };
      next();
    } catch (error) {
      next(error);
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 + multer type compatibility
  const uploadHandler: any = async (req: any, res: any, next: any) => {
    try {
      if (DEBUG_UPLOAD) {
        console.log('🚀 [Upload Handler] Request received');
        console.log('   Headers:', {
          contentType: req.headers['content-type'],
          authorization: req.headers.authorization ? 'present' : 'missing',
          cookie: req.headers.cookie ? 'present' : 'missing',
        });
      }

      const { sessionId } = req.params;
      const { notifyAgent, message } = req.body;
      const files = req.files as StagedMulterFile[];

      if (DEBUG_UPLOAD) {
        console.log(
          `📎 [Upload Handler] Processing for session ${sessionId ? shortId(sessionId) : 'unknown'}`
        );
        console.log(`   Notify agent: ${notifyAgent === 'true' || notifyAgent === true}`);
        console.log(`   Files received: ${files?.length || 0}`);
      }

      const params = req.feathers as AuthenticatedParams;
      if (DEBUG_UPLOAD) {
        console.log(`   Auth params:`, {
          hasUser: !!params?.user,
          userId: params?.user?.user_id ? shortId(params.user.user_id) : undefined,
          provider: params?.provider,
        });
      }

      if (!files || files.length === 0) {
        console.error('❌ [Upload Handler] No files in request');
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const owner = req._uploadOwner as UploadOwner | undefined;
      if (!owner) {
        return res.status(403).json({ error: 'Upload ownership context unavailable' });
      }

      const uploadedFiles = files.map((staged) => ({
        ref: staged.ref,
        filename: staged.name,
        size: staged.size,
        mimeType: staged.mimeType,
        createdAt: staged.createdAt,
        expiresAt: staged.expiresAt,
      }));

      if (DEBUG_UPLOAD) {
        console.log(`   Uploaded ${uploadedFiles.length} file(s):`);
        uploadedFiles.forEach((f) => {
          console.log(`     - ${f.filename} (${(f.size / 1024).toFixed(2)} KB)`);
        });
      }

      let notificationError: string | null = null;
      if ((notifyAgent === 'true' || notifyAgent === true) && message) {
        try {
          const handles = uploadedFiles.map((f) => f.ref).join(', ');
          const promptText = message.replace(/\{filepath\}/g, handles);

          if (DEBUG_UPLOAD) {
            console.log(`   Sending prompt to agent: ${promptText.substring(0, 100)}...`);
          }

          const promptService = app.service('/sessions/:id/prompt');
          // biome-ignore lint/suspicious/noExplicitAny: Express 5 + FeathersJS type mismatch
          const promptParams: any = {
            route: { id: sessionId },
            user: params.user,
            authentication: params.authentication,
            tenant: params.tenant,
          };
          await promptService.create({ prompt: promptText }, promptParams);
        } catch (error) {
          console.error('❌ [Upload Handler] Failed to notify agent:', error);
          notificationError =
            error instanceof Error ? error.message : 'Failed to send notification to agent';
        }
      }

      res.json({
        success: true,
        files: uploadedFiles,
        ...(notificationError && { warning: notificationError }),
      });
    } catch (error) {
      next(error);
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
  const uploadLogger: any = (req: any, res: any, next: any) => {
    if (DEBUG_UPLOAD) {
      console.log('📥 [Upload Route] Request received');
      console.log('   Method:', req.method);
      console.log('   URL:', req.url);
      console.log('   Content-Type:', req.headers['content-type']);
      console.log('   Has auth header:', !!req.headers.authorization);
      console.log(
        '   Session ID param:',
        req.params.sessionId ? shortId(req.params.sessionId) : 'unknown'
      );
    }
    next();
  };

  const uploadAuthMiddleware = createUploadAuthMiddleware({
    authentication: app.service('authentication'),
    multiTenancy,
  });

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on FeathersJS Application type
  (app as any).post(
    '/sessions/:sessionId/upload',
    uploadLogger,
    uploadAuthMiddleware,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((req: any, res: any, next: any) => {
      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Route] Authentication passed');
        console.log(
          '   User:',
          req.feathers?.user?.user_id ? shortId(req.feathers.user.user_id) : 'unknown'
        );
      }
      next();
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any,
    // Cheap pre-multer Content-Length check — short-circuits before we spend
    // time writing oversize uploads to disk.
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    enforceTotalUploadSize() as any,
    authorizeUpload,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 + multer type compatibility
    uploadMiddleware.array('files', 10) as any,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((req: any, res: any, next: any) => {
      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Route] Multer processing complete');
        console.log('   Files parsed:', req.files?.length || 0);
      }
      next();
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any,
    uploadHandler,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((err: any, req: any, res: any, next: any) => {
      console.error('❌ [Upload Route] Error occurred:', err.message);
      console.error('   Stack:', err.stack);
      res.status(err.status || 500).json({
        error: err.message || 'Upload failed',
        details: err.toString(),
      });
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any
  );

  type UploadHttpRequest = Request & {
    feathers?: AuthenticatedParams;
    params: { uploadRef: string };
  };
  const uploadThumbnails = new UploadThumbnailCache();
  const loadAuthorizedUpload = async (req: UploadHttpRequest) => {
    const params = req.feathers as AuthenticatedParams;
    const tenantId = params.tenant?.tenant_id;
    const userId = params.user?.user_id as UUID | undefined;
    if (!tenantId || !userId) throw new NotAuthenticated('Authentication required');
    const ref = req.params.uploadRef as import('@disco/core/types').UploadRef;
    const upload = await runWithTenantDatabaseScope(db, tenantId, () =>
      uploadRepo.findOwned(tenantId, ref)
    );
    if (upload?.status !== 'active') throw new NotFound('Upload unavailable');
    if (upload.expiresAt && Date.parse(upload.expiresAt) <= Date.now()) {
      throw new NotFound('Upload unavailable');
    }
    if (upload.createdBy !== userId) throw new NotFound('Upload unavailable');
    return upload;
  };

  // Authorize every derivative request before consulting the cache, including
  // after deletion or expiry. Thumbnail failures never fall back to original bytes.
  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).get(
    '/uploads/:uploadRef/thumbnail',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const upload = await loadAuthorizedUpload(req);
        if (!upload.mimeType.startsWith('image/')) {
          return res.status(415).json({ message: 'Image preview unavailable' });
        }
        const key = JSON.stringify([
          upload.tenantId,
          upload.createdBy,
          upload.sessionId,
          upload.agentId,
          upload.ref,
          upload.checksum,
          upload.size,
        ]);
        let thumbnail: Buffer;
        try {
          thumbnail = await uploadThumbnails.get(key, () =>
            getUploadStagingStore().read({
              tenantId: upload.tenantId,
              createdBy: upload.createdBy,
              sessionId: upload.sessionId,
              agentId: upload.agentId,
              ref: upload.ref,
            })
          );
        } catch {
          return res.status(415).json({ message: 'Image preview unavailable' });
        }
        if (res.destroyed) return;
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Content-Length', String(thumbnail.length));
        res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
        res.setHeader('Vary', 'Authorization, Cookie');
        res.setHeader('ETag', `"${upload.ref}-${upload.size}-thumb-v1"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(thumbnail);
      } catch (error) {
        next(error);
      }
    }
  );

  // User Settings: owner-scoped logical upload inventory.
  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).get(
    '/uploads',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const params = req.feathers as AuthenticatedParams;
        if (!params.tenant?.tenant_id || !params.user?.user_id) {
          throw new NotAuthenticated('Authentication required');
        }
        const tenantId = params.tenant.tenant_id;
        const userId = params.user.user_id as UUID;
        const uploads = await runWithTenantDatabaseScope(db, tenantId, () =>
          uploadRepo.listByUploader(tenantId, userId)
        );
        res.json({ uploads });
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).get(
    '/uploads/:uploadRef/content',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const upload = await loadAuthorizedUpload(req);
        const store = getUploadStagingStore();
        const readOwner = {
          tenantId: upload.tenantId,
          sessionId: upload.sessionId,
          createdBy: upload.createdBy,
          agentId: upload.agentId,
          ref: upload.ref,
        };
        const resolvedRange = resolveUploadHttpRange(
          typeof req.headers.range === 'string' ? req.headers.range : undefined,
          upload.size
        );
        if (!resolvedRange) return res.status(416).end();
        const { offset, length, contentRange } = resolvedRange;
        if (contentRange) {
          res.status(206);
          res.setHeader('Content-Range', contentRange);
        }
        const stream = await store.read({ ...readOwner, offset, ...(length ? { length } : {}) });
        res.setHeader('Content-Type', upload.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', String(length ?? upload.size));
        res.setHeader('Accept-Ranges', 'bytes');
        // Upload objects are immutable for their lifetime. Let the authenticated
        // browser keep them on disk for a week so switching conversations does
        // not repeatedly download the same image or document. Varying on the
        // credential boundary prevents one signed-in account from reusing
        // another account's private cache entry in a shared browser profile.
        res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
        res.setHeader('Vary', 'Authorization, Cookie');
        res.setHeader('ETag', `"${upload.ref}-${upload.size}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const safeInline = new Set([
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'application/pdf',
        ]);
        res.setHeader(
          'Content-Disposition',
          `${safeInline.has(upload.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(upload.displayName)}`
        );
        stream.once('error', (error) => res.destroy(error as Error));
        res.once('close', () =>
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
        );
        stream.pipe(res);
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).delete(
    '/uploads/:uploadRef',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const upload = await loadAuthorizedUpload(req);
        const params = req.feathers as AuthenticatedParams;
        if (
          upload.createdBy !== params.user?.user_id &&
          !hasMinimumRole(params.user?.role, ROLES.ADMIN)
        ) {
          throw new NotFound('Upload unavailable');
        }
        await getUploadStagingStore().delete({
          tenantId: upload.tenantId,
          sessionId: upload.sessionId,
          createdBy: upload.createdBy,
          agentId: upload.agentId,
          ref: upload.ref,
        });
        await runWithTenantDatabaseScope(db, upload.tenantId, () =>
          uploadRepo.remove(upload.tenantId, upload.ref)
        );
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).patch(
    '/uploads/:uploadRef',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const upload = await loadAuthorizedUpload(req);
        const params = req.feathers as AuthenticatedParams;
        if (
          upload.createdBy !== params.user?.user_id &&
          !hasMinimumRole(params.user?.role, ROLES.ADMIN)
        ) {
          throw new NotFound('Upload unavailable');
        }
        const displayName =
          typeof req.body?.displayName === 'string'
            ? [...req.body.displayName]
                .filter((character: string) => {
                  const code = character.charCodeAt(0);
                  return code >= 32 && code !== 127;
                })
                .join('')
                .trim()
                .slice(0, 200)
            : '';
        if (!displayName) throw new BadRequest('displayName is required');
        const updated = await runWithTenantDatabaseScope(db, upload.tenantId, () =>
          uploadRepo.rename(upload.tenantId, upload.ref, displayName)
        );
        res.json({ upload: updated });
      } catch (error) {
        next(error);
      }
    }
  );

  // ============================================================================
  // Stop endpoint
  // ============================================================================

  // Stop coordinates durable state with an external executor and may wait for
  // its socket acknowledgement. It must not hold the route-wide tenant DB
  // transaction while waiting: emitServiceEvent correctly defers realtime
  // publication until commit, so a long transaction here would withhold the
  // Stop event until after the cooperative grace expired and containment had
  // already fallen back to SIGTERM. Internal service calls still use their
  // normal short tenant transactions.
  registerLongAuthenticatedRoute(
    app,
    '/sessions/:id/stop',
    {
      async create(data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
        const sessionsServiceWithHooks = app.service('sessions') as unknown as SessionsServiceImpl;
        const triggerPreservedQueue = () => {
          deferInFreshTenantScope(params, async () => {
            try {
              await sessionsServiceWithHooks.triggerQueueProcessing(id as SessionID, params);
            } catch (error) {
              console.error(
                `❌ [Stop] Failed to process queue after stopping session ${shortId(id)}:`,
                error
              );
            }
          });
        };
        if (body.force_unverified === true) {
          const result = await withSessionTurnLock(sessionTurnLocks, id as SessionID, async () => {
            const target = await inCurrentTenantDatabaseScope(async () => {
              const session = await app.service('sessions').get(id, params);
              return authorizeForceFailRoute({
                session,
                params,
                body,
                findTask: async (taskId) => {
                  try {
                    return await app.service('tasks').get(taskId, params);
                  } catch (error) {
                    if ((error as { code?: number }).code === 404) return undefined;
                    throw error;
                  }
                },
              });
            });
            const failedTask = await forceFailUnverifiedTask({
              app,
              taskId: target.task.task_id,
              terminationRequestedAt: target.terminationRequestedAt,
              confirmation: target.confirmation,
              params,
            });
            return {
              success: true,
              status: failedTask.status,
              stoppedTaskId: failedTask.task_id,
            };
          });
          triggerPreservedQueue();
          return result;
        }

        const stopReason = typeof body.reason === 'string' ? body.reason : undefined;
        const result = await withSessionTurnLock(sessionTurnLocks, id as SessionID, async () =>
          stopSessionPreserveQueue(
            {
              app,
              taskRepo: stopRouteTaskRepository,
              sessionsService: sessionsServiceWithHooks,
              findActiveTasks: (stopApp, sessionId, stopParams) =>
                inCurrentTenantDatabaseScope(() =>
                  findActiveTasksForSession(stopApp, sessionId, stopParams)
                ),
            },
            id as SessionID,
            params,
            { reason: stopReason }
          )
        );

        if (result.success) {
          triggerPreservedQueue();
        }

        return result;
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'stop sessions' },
    },
    requireAuth
  );

  // ============================================================================
  // Queue listing — task-centric (was message-centric pre-never-lose-prompt).
  // The queue is the set of tasks with status='queued', ranked by
  // queue_position. Each queued task carries the full prompt + metadata; on
  // drain it transitions queued → dispatching via spawnTaskExecutor.
  //
  // Enqueueing goes through `POST /sessions/:id/prompt`: every admission first
  // takes a durable position, then the database claim decides whether it may
  // leave the queue immediately and reports the actual status to the caller.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/tasks/queue',
    {
      async find(params: RouteParams) {
        const sessionId = params.route?.id;
        if (!sessionId) throw new Error('Session ID required');

        // Reuse the canonical session read so the queue cannot become a side
        // channel for another user's prompts (including for admins).
        await app.service('sessions').get(sessionId, params);

        const taskQueueRepo = new TaskRepository(db);
        const queued = await taskQueueRepo.findQueued(sessionId as SessionID);

        return {
          total: queued.length,
          data: queued,
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view queue' },
    },
    requireAuth
  );

  // Convert one durable queued prompt into non-interrupting guidance for the
  // currently running Codex turn. The queued row is removed on the server
  // first, so a page refresh or a second browser can never execute both the
  // queued turn and the steering hint. The canonical prompt route then owns
  // the completion race: if the prior turn ended in the meantime, `steer:true`
  // falls back to ordinary prompt admission and starts/queues a fresh turn.
  registerLongAuthenticatedRoute(
    app,
    '/sessions/:id/tasks/queue-steer',
    {
      async create(data: { taskId?: string }, params: RouteParams) {
        const sessionId = params.route?.id;
        if (!sessionId) throw new BadRequest('Session ID required');
        if (!data?.taskId) throw new BadRequest('Queued task ID required');
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to change a queued prompt');
        }

        const session = await sessionsService.get(sessionId, params);
        if (session.agentic_tool !== 'codex') {
          throw new BadRequest('追加提示目前仅支持 Codex 会话');
        }

        const queuedTask = (await tasksService.get(data.taskId, params)) as Task;
        if (queuedTask.session_id !== session.session_id) {
          throw new NotFound('Queued task does not belong to this session');
        }
        if (queuedTask.created_by !== params.user.user_id) {
          throw new Forbidden('You can only change your own queued prompts');
        }
        if (queuedTask.status !== TaskStatus.QUEUED) {
          throw new Conflict('这条消息已经开始执行，无法再改为追加提示');
        }

        // TaskRepository.delete has a status='queued' predicate, so a worker
        // that already won dispatch makes this remove fail instead of causing a
        // duplicate steer + new turn.
        await tasksService.remove(queuedTask.task_id, params);

        try {
          const promptRoute = app.service('/sessions/:id/prompt') as unknown as {
            create(
              promptData: { prompt: string; stream: boolean; steer: boolean },
              promptParams: RouteParams
            ): Promise<unknown>;
          };
          const result = await promptRoute.create(
            { prompt: queuedTask.full_prompt, stream: true, steer: true },
            {
              ...params,
              route: { ...params.route, id: session.session_id },
            }
          );
          return {
            success: true,
            sourceTaskId: queuedTask.task_id,
            result,
          };
        } catch (error) {
          // Preserve the user's prompt if validation/executor admission fails
          // after the queued row was removed. Recreate it with the same stable
          // identity; createPending allocates a fresh durable queue position.
          const restoreRepo = bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db));
          const restored = await restoreRepo.createPending({
            task_id: queuedTask.task_id,
            session_id: queuedTask.session_id,
            full_prompt: queuedTask.full_prompt,
            created_by: queuedTask.created_by,
            status: TaskStatus.QUEUED,
            metadata: queuedTask.metadata,
          });
          emitServiceEvent(app, {
            path: 'tasks',
            event: 'created',
            data: restored,
            params,
            id: restored.task_id,
          });
          emitServiceEvent(app, {
            path: 'tasks',
            event: 'queued',
            data: restored,
            params,
            id: restored.task_id,
            method: 'patch',
          });
          throw error;
        }
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'change queued prompts' },
    },
    requireAuth
  );

  // Queue processing implementation — task-centric. `sessionTurnLocks` and
  // `queueRetryScheduled` only coalesce duplicate work inside this daemon.
  // They may disappear on process death without losing correctness: the
  // durable queue head plus Session-first dispatch claim are authoritative,
  // and the all-daemon queue worker rediscovers missed work.
  const queueRetryScheduled = new Set<SessionID>();

  async function processNextQueuedTask(sessionId: SessionID, params: RouteParams): Promise<void> {
    await runWithSessionQueueTenantScope(
      {
        db,
        config,
        sessionId,
        params,
        label: 'processNextQueuedTask',
      },
      async (scopedParams) => processNextQueuedTaskInTenantScope(sessionId, scopedParams)
    );
  }

  async function processNextQueuedTaskInTenantScope(
    sessionId: SessionID,
    params: RouteParams
  ): Promise<void> {
    const existingLock = sessionTurnLocks.get(sessionId);
    if (existingLock) {
      console.log(`⏳ [Queue] Session turn in progress for ${shortId(sessionId)}, waiting...`);

      // Race the lock against a timeout. A half-open TCP connection can leave
      // a DB query pending forever, which holds the lock indefinitely and
      // deadlocks all subsequent prompts for this session. statement_timeout
      // (60s) handles normal cases; this is the client-side backstop.
      const LOCK_WAIT_TIMEOUT_MS = 65_000;
      const outcome = await Promise.race([
        existingLock.catch(() => undefined).then(() => 'released' as const),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), LOCK_WAIT_TIMEOUT_MS)
        ),
      ]);

      if (outcome === 'timeout') {
        console.error(
          `❌ [Queue] Session ${shortId(sessionId)}: turn lock held >${LOCK_WAIT_TIMEOUT_MS / 1000}s — ` +
            `holder may be stuck on a broken DB connection. Skipping this drain trigger; ` +
            `the next natural trigger (user prompt or task completion) will retry.`
        );
        return;
      }

      if (!queueRetryScheduled.has(sessionId)) {
        queueRetryScheduled.add(sessionId);
        deferWithSessionQueueTenantScope(
          {
            db,
            config,
            sessionId,
            params,
            label: 'processNextQueuedTask retry',
          },
          async (retryParams) => {
            queueRetryScheduled.delete(sessionId);
            try {
              await processNextQueuedTask(sessionId, retryParams);
            } catch (error) {
              console.error(`❌ [Queue] Retry failed for session ${shortId(sessionId)}:`, error);
            }
          },
          (error) => {
            queueRetryScheduled.delete(sessionId);
            console.error(`❌ [Queue] Retry failed for session ${shortId(sessionId)}:`, error);
          }
        );
      } else {
        console.log(
          `⏭️  [Queue] Retry already scheduled for session ${shortId(sessionId)}, not queueing another`
        );
      }
      return;
    }

    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    sessionTurnLocks.set(sessionId, lockPromise);

    // Race the drain against a holder timeout. A half-open TCP connection can
    // keep spawnTaskExecutor waiting indefinitely on a DB query that never
    // completes on the Node.js side (statement_timeout only fires if Postgres
    // actually received the query). Releasing the lock after 30s lets waiting
    // prompts make progress; the background drain will eventually fail and DB
    // state will be reconciled by reconcileSessionPromptStateIfStuck.
    const HOLDER_TIMEOUT_MS = 30_000;
    try {
      await Promise.race([
        processNextQueuedTaskInternal(sessionId, params),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `processNextQueuedTaskInternal timed out for ${shortId(sessionId)} after ${HOLDER_TIMEOUT_MS / 1000}s`
                )
              ),
            HOLDER_TIMEOUT_MS
          )
        ),
      ]);
    } catch (err) {
      console.error(
        `❌ [Queue] processNextQueuedTask holder error for ${shortId(sessionId)}:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      sessionTurnLocks.delete(sessionId);
      resolveLock();
    }
  }

  async function processNextQueuedTaskInternal(
    sessionId: SessionID,
    params: RouteParams
  ): Promise<void> {
    const taskRepo = bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db));
    const nextTask = await taskRepo.getNextQueued(sessionId);

    if (!nextTask) {
      taskQueueDebug(`📭 No queued tasks for session ${shortId(sessionId)}`);
      return;
    }

    // Recovery triggers carry trusted tenant routing but no request user. Restore
    // the durable enqueuer identity before entering hooked Session reads/repairs
    // so Session authorization applies exactly as it did at admission time.
    const userId = nextTask.metadata?.queued_by_user_id ?? nextTask.created_by;
    const userRepo = bindRepositoryToTenantUnitOfWork(db, new UsersRepository(db));
    const queuedByUser = userId ? await userRepo.findById(userId) : undefined;
    const taskParams: RouteParams = queuedByUser
      ? ({ ...params, user: queuedByUser } as RouteParams)
      : params;

    const queuedSession = await runWithTenantDatabaseScope(db, getCurrentTenantId(), () =>
      sessionsService.get(sessionId, taskParams)
    );
    const session = await reconcileSessionPromptStateIfStuck(queuedSession, taskRepo, taskParams);

    if (!sessionCanStartTask(session.status, session.ready_for_prompt)) {
      return;
    }

    // Re-read the task — defend against the case where it was already drained
    // by a concurrent caller, or removed by an admin via DELETE /tasks/:id.
    const stillQueued = await taskRepo.findById(nextTask.task_id);
    if (!stillQueued || stillQueued.status !== TaskStatus.QUEUED) {
      console.log(`⚠️  Queued task ${shortId(nextTask.task_id)} no longer queued, skipping`);
      return;
    }

    // spawnTaskExecutor handles the QUEUED → DISPATCHING claim (recomputes
    // message_range/git_state, writes the user-message row, appends to
    // session.tasks, spawns the executor). We pass the messageSource from
    // task.metadata so callback styling survives the queue → run hop.
    const persistedSource = nextTask.metadata?.source;
    const source = persistedSource === 'disco' ? persistedSource : undefined;
    const scheduledInitialTaskId = queuedSession.custom_context?.scheduled_run?.initial_task_id;
    const stableInitialMessageId = stableInitialMessageIdForTask(
      stillQueued,
      scheduledInitialTaskId === stillQueued.task_id
        ? (scheduledInitialTaskId as MessageID)
        : undefined
    );
    const admitted = await spawnTaskExecutor(
      stillQueued,
      {
        stream: true,
        messageSource: source,
        ...(stableInitialMessageId ? { stableInitialMessageId } : {}),
      },
      taskParams
    );
    if (admitted.status === TaskStatus.QUEUED) {
      taskQueueDebug(
        `⏸️  Queue head ${shortId(admitted.task_id)} remains queued after a lost/changed claim`
      );
      return;
    }
    console.log(
      `[task-queue] event=dispatched session_id=${JSON.stringify(sessionId)} task_id=${JSON.stringify(admitted.task_id)} status=${JSON.stringify(admitted.status)}`
    );
  }

  // Inject queue processor into sessions service.
  sessionsService.setQueueProcessor(async (sessionId: SessionID, params?: RouteParams) => {
    try {
      await processNextQueuedTask(sessionId, params || {});
    } catch (error) {
      console.error(`❌ [Sessions] Failed to process queued task:`, error);
    }
  });

  // ============================================================================
  // Permission decision endpoint
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/permission-decision',
    {
      async create(data: PermissionDecisionSubmission, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        return deliverPermissionDecision({
          app,
          sessionId: id as SessionID,
          data,
          params,
          authorization: {},
        });
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'respond to permission requests' },
    },
    requireAuth
  );

  // ============================================================================
  // Widget submission / dismissal endpoints
  //
  // See `docs/internal/in-conversation-widgets-design-2026-05-19.md`. The
  // resolver handles auth, idempotency, registry dispatch, message patching,
  // auto-resume task queueing, and the `widget:resolved` broadcast.
  // ============================================================================

  const widgetResolutionMessages = bindRepositoryToTenantUnitOfWork(db, new MessagesRepository(db));
  const widgetResolverDeps = {
    // biome-ignore lint/suspicious/noExplicitAny: Feathers Application shape
    app: app as any,
    runInTenantDatabaseScope: inCurrentTenantDatabaseScope,
    resolutionStore: new WidgetResolutionStore(widgetResolutionMessages, (message) =>
      emitServiceEvent(app, {
        path: 'messages',
        event: 'patched',
        data: message,
        id: message.message_id,
      })
    ),
    publishResolved: (payload: Record<string, unknown>) =>
      emitServiceEvent(app, {
        path: 'messages',
        event: 'widget:resolved',
        data: payload,
        method: 'patch',
        id: payload.widget_id as string,
      }),
  };

  registerLongAuthenticatedRoute(
    app,
    '/widgets/:id/submit',
    {
      async create(data: Record<string, unknown>, params: RouteParams) {
        const widgetId = params.route?.id;
        if (!widgetId) throw new Error('Widget ID required');
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to submit a widget');
        }
        return resolveWidget(
          widgetId,
          { kind: 'submit', body: data ?? {} },
          { user_id: params.user.user_id as UUID, role: params.user.role as string | undefined },
          widgetResolverDeps
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'submit widgets' },
    },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/widgets/:id/dismiss',
    {
      async create(_data: unknown, params: RouteParams) {
        const widgetId = params.route?.id;
        if (!widgetId) throw new Error('Widget ID required');
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to dismiss a widget');
        }
        return resolveWidget(
          widgetId,
          { kind: 'dismiss' },
          { user_id: params.user.user_id as UUID, role: params.user.role as string | undefined },
          widgetResolverDeps
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'dismiss widgets' },
    },
    requireAuth
  );

  // ============================================================================
  // Tasks custom routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/complete',
    {
      async create(
        data: { git_state?: { sha_at_end?: string; commit_message?: string } },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new Error('Task ID required');
        const internalParams = await authorizeTaskTerminalRoute({
          id,
          params,
          tasksService,
        });
        return tasksService.complete(id, data, internalParams);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'complete tasks' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/fail',
    {
      async create(data: { error?: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Task ID required');
        const internalParams = await authorizeTaskTerminalRoute({
          id,
          params,
          tasksService,
        });
        return tasksService.fail(id, data, internalParams);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'fail tasks' },
    },
    requireAuth
  );

  // ============================================================================
  // User API Keys routes
  // ============================================================================

  const userApiKeysService = createUserApiKeysService(userApiKeysRepo);

  registerAuthenticatedRoute(
    app,
    '/api/v1/user/api-keys',
    {
      async find(params: AuthenticatedParams) {
        return userApiKeysService.find(params);
      },
      async create(data: { name: string }, params: AuthenticatedParams) {
        return userApiKeysService.create(data, params);
      },
      async patch(id: string, data: { name?: string }, params: AuthenticatedParams) {
        if (!id) throw new BadRequest('API key ID required');
        return userApiKeysService.patch(id, data, params);
      },
      async remove(id: string, params: AuthenticatedParams) {
        if (!id) throw new BadRequest('API key ID required');
        return userApiKeysService.remove(id, params);
      },
    },
    {
      find: { role: ROLES.MEMBER, action: 'list API keys' },
      create: { role: ROLES.MEMBER, action: 'create API keys' },
      patch: { role: ROLES.MEMBER, action: 'update API keys' },
      remove: { role: ROLES.MEMBER, action: 'delete API keys' },
    },
    requireAuth
  );

  // ============================================================================
  // Run-now (canonical): manually trigger a scheduled run for a schedule.
  // ============================================================================
  // Reuses the scheduler's spawn code path so scheduled and manual triggers
  // produce indistinguishable sessions (beyond a triggered_manually marker).
  // Requires branch-level 'all' permission on the schedule's parent branch
  // (same tier as editing the schedule); see §4.4 of the design doc.
  const scheduleRepository = new ScheduleRepository(db);

  app.use('/schedules/:id/run-now', {
    async create(_data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new BadRequest('Schedule ID required');

      const scheduler = app.get('scheduler') as SchedulerService | undefined;
      if (!scheduler) {
        throw new NotFound('Scheduler service is not enabled on this instance.');
      }

      const triggeredBy = params.user?.user_id;
      if (!triggeredBy) {
        throw new NotAuthenticated('Authentication required to trigger schedule.');
      }

      try {
        const session = await scheduler.executeScheduleNow({
          scheduleId: id as ScheduleID,
          triggeredBy: triggeredBy as UUID,
        });
        return {
          session_id: session.session_id,
          schedule_id: session.schedule_id,
          scheduled_run_at: session.scheduled_run_at,
          triggered_manually: true,
        };
      } catch (err) {
        if (err instanceof ScheduleBusyError) {
          throw new Conflict(err.message, { code: err.code });
        }
        if (err instanceof ScheduleNotReadyError) {
          throw new BadRequest(err.message, { code: err.code });
        }
        throw err;
      }
    },
  });

  app.service('/schedules/:id/run-now').hooks({
    around: { all: [tenantIdentityAround] },
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'run schedule'),
        inTenantDatabaseScope(async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new BadRequest('Schedule ID required');
          const schedule = await scheduleRepository.findById(id);
          if (!schedule) throw new NotFound(`Schedule not found: ${id}`);
          context.params.schedule = schedule;
          return context;
        }),
        ensureScheduleRunsAsCaller(),
      ],
    },
  });

  // Session-scoped runtime configuration is private to the Session owner.
  const requireSessionScopedConfigOwner = async (
    sessionId: string,
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type
    params: any
  ): Promise<void> => {
    const user = params?.user;
    if (!user) {
      throw new NotAuthenticated('Authentication required');
    }
    // Fast-path for service accounts — skip the session lookup entirely.
    if (user._isServiceAccount) return;

    const session = await sessionsService.get(sessionId, { provider: undefined });
    if (!session) {
      throw new NotFound(`Session not found: ${sessionId}`);
    }
    assertSessionOwnedByActor(user, session);
  };

  // Same authorization, but returns the session. MCP routes need its
  // `created_by`: that identity, not the caller's, decides which private
  // servers the session may see, so it has to be loaded for service-account
  // callers too rather than short-circuited.
  const authorizeAndLoadSessionForMcpConfig = async (
    sessionId: string,
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type
    params: any
  ): Promise<Session> => {
    const user = params?.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    const session = (await sessionsService.get(sessionId, { provider: undefined })) as
      | Session
      | undefined;
    if (!session) throw new NotFound(`Session not found: ${sessionId}`);
    assertSessionOwnedByActor(user, session);
    return session;
  };

  // ============================================================================
  // Session MCP servers routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/mcp-servers',
    {
      async find(params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        const session = await authorizeAndLoadSessionForMcpConfig(id, params);
        const enabledOnly =
          params.query?.enabledOnly === 'true' || params.query?.enabledOnly === true;
        const includeGlobal =
          params.query?.includeGlobal === 'true' || params.query?.includeGlobal === true;
        const includeMetadata =
          params.query?.includeMetadata === 'true' || params.query?.includeMetadata === true;
        const mcpService = app.service('mcp-servers');
        const queryForUserId =
          typeof params.query?.forUserId === 'string' ? params.query.forUserId : undefined;
        const authPayloadType = (
          params as RouteParams & { authentication?: { payload?: { type?: unknown } } }
        ).authentication?.payload?.type;
        const routeUser = params.user as
          | (NonNullable<RouteParams['user']> & { _isServiceAccount?: boolean })
          | undefined;
        const userId = resolveForUserIdWithGate({
          queryForUserId,
          isServiceAccount: routeUser?._isServiceAccount,
          authPayloadType,
          callerUserId: params.user?.user_id,
        });
        const rawLookupParams = {
          ...params,
          provider: undefined,
          query: {
            ...(userId ? { forUserId: userId } : {}),
          },
        };
        if (includeMetadata) {
          const linksResult = await app.service('session-mcp-servers').find({
            ...params,
            provider: undefined,
            query: {
              session_id: id,
              ...(enabledOnly ? { enabled: true } : {}),
              $limit: 1000,
            },
          });
          const links = (Array.isArray(linksResult) ? linksResult : linksResult.data) as Array<
            SessionMCPServer & { added_at: Date | string | number }
          >;
          const withMetadata = await Promise.all(
            links.map(async (link) => {
              try {
                const server = await mcpService.get(link.mcp_server_id, rawLookupParams);
                return {
                  server,
                  added_at: new Date(link.added_at).getTime(),
                  enabled: Boolean(link.enabled),
                };
              } catch (_error) {
                return null;
              }
            })
          );
          const entries = withMetadata
            .filter(
              (entry): entry is Exclude<(typeof withMetadata)[number], null> => entry !== null
            )
            .filter((entry) => isMCPServerUsableInSession(entry.server, session));
          return shouldExposeMCPServerSecrets(params, {
            allowSessionToken: true,
            sessionId: id,
          })
            ? entries
            : entries.map((entry) => ({
                ...entry,
                server: redactMCPServerSecrets(entry.server),
              }));
        }
        const sessionServerRefs = await sessionMCPServersService.listServers(
          id as import('@disco/core/types').SessionID,
          enabledOnly,
          params
        );
        const sessionServers = await Promise.all(
          sessionServerRefs.map(async (server) => {
            try {
              return await mcpService.get(server.mcp_server_id, rawLookupParams);
            } catch (_error) {
              return server;
            }
          })
        );
        const globalQuery = {
          scope: 'global',
          ...(enabledOnly ? { enabled: true } : {}),
          ...(userId ? { forUserId: userId } : {}),
          // Global scope means "every session of everyone who may use it", not
          // "every session in the tenant": a private server belongs to its
          // owner's sessions only. Keyed on the session's creator rather than
          // the caller or the query's `forUserId`, neither of which is the
          // identity the session runs as.
          usableByUserId: session.created_by,
          $limit: 1000,
        };
        const globalResult = includeGlobal
          ? await mcpService.find({
              ...params,
              provider: undefined,
              query: globalQuery,
            })
          : [];
        const globalServers = Array.isArray(globalResult) ? globalResult : globalResult.data;
        const servers = filterMCPServersForSession(
          includeGlobal
            ? [
                ...new Map(
                  [...globalServers, ...sessionServers].map((server) => [
                    server.mcp_server_id,
                    server,
                  ])
                ).values(),
              ]
            : sessionServers,
          session
        );
        return shouldExposeMCPServerSecrets(params, {
          allowSessionToken: true,
          sessionId: id,
        })
          ? servers
          : servers.map(redactMCPServerSecrets);
      },
      async create(data: { mcpServerId: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.mcpServerId) throw new Error('MCP Server ID required');
        await authorizeAndLoadSessionForMcpConfig(id, params);

        try {
          await sessionMCPServersService.addServer(
            id as import('@disco/core/types').SessionID,
            data.mcpServerId as import('@disco/core/types').MCPServerID,
            params
          );
        } catch (error) {
          if (error instanceof MCPServerNotUsableError) {
            throw new Forbidden('That MCP server is private to another user');
          }
          throw error;
        }

        const relationship = {
          session_id: id,
          mcp_server_id: data.mcpServerId,
          enabled: true,
          added_at: new Date(),
        };
        emitServiceEvent(app, {
          path: 'session-mcp-servers',
          event: 'created',
          data: relationship,
          params,
        });

        return relationship;
      },
      async update(_id: string | null, data: { mcpServerIds?: unknown }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!Array.isArray(data?.mcpServerIds)) {
          throw new BadRequest('mcpServerIds (array) required');
        }
        if (
          !data.mcpServerIds.every((serverId): serverId is string => typeof serverId === 'string')
        ) {
          throw new BadRequest('mcpServerIds must contain strings');
        }

        await authorizeAndLoadSessionForMcpConfig(id, params);
        const serverIds = [...new Set(data.mcpServerIds)] as Array<
          import('@disco/core/types').MCPServerID
        >;
        try {
          await sessionMCPServersService.setServers(
            id as import('@disco/core/types').SessionID,
            serverIds,
            params
          );
        } catch (error) {
          if (error instanceof MCPServerNotUsableError) {
            throw new Forbidden('That MCP server is private to another user');
          }
          throw error;
        }

        const replacement = {
          session_id: id,
          mcp_server_ids: serverIds,
        };
        emitServiceEvent(app, {
          path: 'session-mcp-servers',
          event: 'patched',
          data: replacement,
          params,
        });
        return replacement;
      },
      async remove(mcpId: string, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!mcpId) throw new Error('MCP Server ID required');
        await requireSessionScopedConfigOwner(id, params);

        await sessionMCPServersService.removeServer(
          id as import('@disco/core/types').SessionID,
          mcpId as import('@disco/core/types').MCPServerID,
          params
        );

        const relationship = {
          session_id: id,
          mcp_server_id: mcpId,
        };
        emitServiceEvent(app, {
          path: 'session-mcp-servers',
          event: 'removed',
          data: relationship,
          params,
        });

        return relationship;
      },
      async patch(mcpId: string, data: { enabled: boolean }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!mcpId) throw new Error('MCP Server ID required');
        if (typeof data.enabled !== 'boolean') throw new Error('enabled field required');
        await requireSessionScopedConfigOwner(id, params);
        return sessionMCPServersService.toggleServer(
          id as import('@disco/core/types').SessionID,
          mcpId as import('@disco/core/types').MCPServerID,
          data.enabled,
          params
        );
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view session MCP servers' },
      create: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
      update: { role: ROLES.MEMBER, action: 'replace session MCP servers' },
      remove: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
      patch: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
    },
    requireAuth
  );

  // ============================================================================
  // MCP member policy
  //
  // Routes:
  //   GET   /mcp-member-policy   — the policy in force for the caller
  //   PATCH /mcp-member-policy   — set the tenant-wide value (admin)
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/mcp-member-policy',
    {
      async find(params: RouteParams): Promise<MCPMemberPolicySetting> {
        const policy = await resolveMcpMemberPolicy(db, params.user?.user_id, getCurrentTenantId());
        // The policy alone does not answer "may I add one?" — the role floor
        // beneath it does too. Answering here keeps a client from rebuilding
        // the rule out of `isAdmin` and a policy value, which is the shape that
        // loses the floor. Advisory: the write path still decides.
        return {
          policy,
          can_configure: canConfigureMcpServers(params.user?.role, policy),
        };
      },
      async patch(
        _id: unknown,
        data: { policy: MCPMemberPolicy },
        params: RouteParams
      ): Promise<MCPMemberPolicySetting> {
        if (!MCP_MEMBER_POLICIES.includes(data?.policy)) {
          throw new BadRequest(`policy must be one of: ${MCP_MEMBER_POLICIES.join(', ')}`);
        }
        await setMcpMemberPolicy(db, data.policy, getCurrentTenantId(), params.user?.user_id);
        return {
          policy: data.policy,
          can_configure: canConfigureMcpServers(params.user?.role, data.policy),
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      // Readable by any authenticated caller, because what it answers is
      // partly about the caller: `can_configure` is their own capability, and
      // the role floor means the interesting answer is the one a below-member
      // caller gets. Gating this at member would leave that answer unreachable
      // by the only people it refuses, who would then be shown a control that
      // fails instead of a reason it is off.
      find: { role: ROLES.VIEWER, action: 'read the MCP member policy' },
      patch: { role: ROLES.ADMIN, action: 'change the MCP member policy' },
    },
    requireAuth
  );

  // ============================================================================
  // MCP marketplace connect
  // ============================================================================

  // A "long" route: it probes a remote endpoint before writing anything, so it
  // carries tenant identity without holding a transaction open across the
  // network call. Every write it makes goes through a service that opens its
  // own unit of work.
  registerLongAuthenticatedRoute(
    app,
    '/mcp-catalog/connect',
    createMCPCatalogConnectService(app),
    { create: { role: ROLES.MEMBER, action: 'connect MCP catalog entries' } },
    requireAuth
  );

  // ============================================================================
  // Session env selections (v0.5 env-var-access)
  //
  // Routes:
  //   GET    /sessions/:id/env-selections           — list selected env var names
  //   POST   /sessions/:id/env-selections           — add one: { envVarName }
  //   DELETE /sessions/:id/env-selections/:name     — remove one
  //   PATCH  /sessions/:id/env-selections           — replace all: { envVarNames: [] }
  //
  // RBAC: only the session's creator or a global admin/superadmin may mutate.
  // Branch `all` permission does NOT grant access — selections expose the
  // creator's private credentials to the executor process.
  // ============================================================================

  // Validate + normalize an `envVarNames` payload: every entry must be a
  // non-empty string, with leading/trailing whitespace trimmed and duplicates
  // removed (first occurrence wins).
  const normalizeEnvVarNames = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      throw new BadRequest('envVarNames (array of strings) required');
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new BadRequest('envVarNames entries must be strings');
      }
      const trimmed = entry.trim();
      if (!trimmed) {
        throw new BadRequest('envVarNames entries must be non-empty');
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
    return out;
  };

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/env-selections',
    {
      // GET returns the selected env var names as a plain `string[]` — both
      // the comment above and the UI consumer expect names, not full rows.
      async find(params: RouteParams): Promise<string[]> {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        // Read permission: session creator OR admin (no branch tier).
        await requireSessionScopedConfigOwner(id, params);
        const rows = await sessionEnvSelectionsService.list(id as SessionID, params);
        return rows.map((r) => r.env_var_name);
      },
      async create(data: { envVarName: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (!data?.envVarName || typeof data.envVarName !== 'string') {
          throw new BadRequest('envVarName required');
        }
        const name = data.envVarName.trim();
        if (!name) throw new BadRequest('envVarName must be non-empty');
        await requireSessionScopedConfigOwner(id, params);
        await sessionEnvSelectionsService.add(id as SessionID, name, params);
        const relationship = {
          session_id: id,
          env_var_name: name,
        };
        try {
          emitServiceEvent(app, {
            path: 'session-env-selections',
            event: 'created',
            data: relationship,
            params,
          });
        } catch {
          // Event emission is non-fatal
        }
        return relationship;
      },
      async remove(name: string, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (!name) throw new BadRequest('env var name required');
        await requireSessionScopedConfigOwner(id, params);
        await sessionEnvSelectionsService.remove(id as SessionID, name, params);
        const relationship = {
          session_id: id,
          env_var_name: name,
        };
        try {
          emitServiceEvent(app, {
            path: 'session-env-selections',
            event: 'removed',
            data: relationship,
            params,
          });
        } catch {
          // Event emission is non-fatal
        }
        return relationship;
      },
      async patch(_nullId: null, data: { envVarNames: string[] }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        const envVarNames = normalizeEnvVarNames(data?.envVarNames);
        await requireSessionScopedConfigOwner(id, params);
        await sessionEnvSelectionsService.setAll(id as SessionID, envVarNames, params);
        try {
          emitServiceEvent(app, {
            path: 'session-env-selections',
            event: 'patched',
            data: { session_id: id, env_var_names: envVarNames },
            params,
          });
        } catch {
          // Event emission is non-fatal
        }
        return { session_id: id, env_var_names: envVarNames };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view session env selections' },
      create: { role: ROLES.MEMBER, action: 'modify session env selections' },
      remove: { role: ROLES.MEMBER, action: 'modify session env selections' },
      patch: { role: ROLES.MEMBER, action: 'modify session env selections' },
    },
    requireAuth
  );

  // ============================================================================
  // Health endpoint
  // ============================================================================

  app.use('/health', {
    async find(params?: AuthenticatedParams) {
      // `/health` stays 200 always (pre-login UI fetches must not throw), so the
      // DB signal rides on `status`: ok | degraded. /readyz is the one that 503s.
      // Only { ok, latencyMs } is public; the raw error is authenticated-only below.
      const dbProbe = await probeDatabase(db);
      const publicResponse = {
        service: 'disco-daemon',
        deploymentId: requireDeploymentId(config),
        // Present only for daemons detached by `disco daemon start`. The CLI
        // compares this opaque ID with its local ownership record before it
        // sends a signal, preventing a stale/recycled PID from being killed.
        managedInstanceId: process.env.DISCO_MANAGED_DAEMON_INSTANCE_ID,
        status:
          healthStatus(dbProbe) === 'ok' && (!realtimeRuntime || realtimeRuntime.isReady())
            ? 'ok'
            : 'degraded',
        db: publicHealthDb(dbProbe),
        timestamp: Date.now(),
        version: DAEMON_VERSION,
        // Build identity for the version-sync banner (apps/disco-ui ConnectionStatus).
        // SHA precedence is resolved at startup — see setup/build-info.ts.
        // Tabs capture this SHA on first connect and prompt a refresh whenever
        // a later handshake reports a different value. 'dev' disables the check.
        buildSha: DAEMON_BUILD_INFO.sha,
        builtAt: DAEMON_BUILD_INFO.builtAt,
        auth: {
          requireAuth: true,
        },
        instance: {
          label: config.daemon?.instanceLabel,
          description: config.daemon?.instanceDescription,
        },
        realtime: realtimeRuntime
          ? { required: true, ready: realtimeRuntime.isReady() }
          : { required: false, ready: true },
        features: {
          // True when the daemon runs in a multi-user Unix isolation mode
          // (sandbox). UI hides "trust everyone on this instance"
          // surfaces when true. Server-side gates (e.g. ArtifactsService.
          // grantTrust) are the source of truth and reject regardless.
          multiUser: (config.execution?.unix_user_mode ?? 'simple') !== 'simple',
          // Tenant agentic-tool settings provide the authoritative availability gate.
          cursorSdk: true,
          uploadPolicy: getUploadLimits(),
        },
      };

      const isAuthenticated = params?.user !== undefined;

      if (isAuthenticated) {
        const dialect = process.env.DISCO_DB_DIALECT === 'postgresql' ? 'postgresql' : 'sqlite';
        let databaseInfo: { dialect: string; url?: string; path?: string };

        if (dialect === 'postgresql') {
          const maskedUrl = DB_PATH.replace(/:([^:@]+)@/, ':****@');
          databaseInfo = { dialect, url: maskedUrl };
        } else {
          databaseInfo = { dialect, path: DB_PATH };
        }

        // Diagnostic only; not in the public payload, doesn't gate readiness.
        // Gated behind auth like the rest of this block (any authenticated
        // user, matching the existing `database`/`execution` fields below —
        // not admin-only).
        const migrations = await probePendingMigrations(db);

        return {
          ...publicResponse,
          // Full DB probe detail, including the raw error, is authenticated-only
          // (never in the public payload).
          db: authenticatedHealthDb(dbProbe),
          migrations: healthMigrations(migrations),
          database: databaseInfo,
          auth: {
            ...publicResponse.auth,
            user: params?.user?.username,
            role: params?.user?.role,
          },
          encryption: {
            enabled: !!process.env.DISCO_MASTER_SECRET,
            method: process.env.DISCO_MASTER_SECRET ? 'AES-256-GCM' : null,
          },
          mcp: {
            enabled: config.daemon?.mcpEnabled !== false,
          },
          // Execution mode surfaced so admins can confirm which security tier
          // the daemon booted under. Docker env overrides (DISCO_SET_RBAC_FLAG,
          // DISCO_SET_UNIX_MODE) are written into ~/.disco/config.yaml by the
          // entrypoint before boot, so `config.execution` reflects them.
          execution: {
            unixUserMode: config.execution?.unix_user_mode ?? 'simple',
          },
          deployment: {
            mode: deployment.mode,
            ...(deployment.mode === 'ha'
              ? {
                  // @disco/core's source owns these fields. The daemon package's
                  // no-build typecheck can temporarily see the previous core
                  // dist declaration while watch mode catches up.
                  supportProfile: (deployment as typeof deployment & { supportProfile: string })
                    .supportProfile,
                  capabilities: (
                    deployment as typeof deployment & {
                      capabilities: Record<string, boolean>;
                    }
                  ).capabilities,
                }
              : {}),
            instanceId: distributedWorkIdentity.instanceId,
            bootId: distributedWorkIdentity.bootId,
            realtime: realtimeRuntime?.health() ?? { required: false, ready: true },
          },
          // Resolved security posture — admins can confirm in Settings → About
          // which CSP/CORS policy the daemon booted with, without tailing logs
          // or reading response headers by hand. Keep the shape tight: the
          // full CSP header value is the one piece operators actually need
          // when debugging a blocked resource.
          security: {
            csp: {
              enabled: !resolvedSecurity.csp.disabled,
              reportOnly: resolvedSecurity.csp.reportOnly,
              reportUri: resolvedSecurity.csp.reportUri,
              header: resolvedSecurity.csp.headerValue,
            },
            cors: {
              mode: resolvedSecurity.cors.mode,
              credentials: resolvedSecurity.cors.credentials,
              originCount: resolvedSecurity.cors.origins.length,
              allowSandpack: resolvedSecurity.cors.allowSandpack,
            },
          },
        };
      }

      return publicResponse;
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const healthService = app.service('health') as any;
  healthService.docs = {
    description: 'Health check endpoint (always public)',
    security: [],
  };

  // Liveness (/livez) and readiness (/readyz) probes — see health/routes.ts.
  registerHealthProbeRoutes(app, db, [
    ...(realtimeRuntime ? [{ name: 'redis', isReady: () => realtimeRuntime.isReady() }] : []),
  ]);

  // ============================================================================
  // MCP routes
  // ============================================================================

  if (config.daemon?.mcpEnabled !== false) {
    const { setupMCPRoutes } = await import('./mcp/server.js');
    const toolSearchEnabled = config.daemon?.mcpToolSearch !== false;
    setupMCPRoutes(app, db, toolSearchEnabled, config, { serverVersion: DISCO_VERSION });
    console.log(
      `✅ MCP server enabled at POST /mcp${toolSearchEnabled ? ' (tool search mode)' : ''}`
    );
  } else {
    console.log('🔒 MCP server disabled via config (daemon.mcpEnabled=false)');
  }

  // ============================================================================
  // Global app hooks + error handler
  // ============================================================================

  app.hooks({
    before: {
      all: [enforcePasswordChange],
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS app.use expects service path, but errorHandler is Express middleware
  (app as any).use(errorHandler());
}
