/**
 * Feathers Client for Disco
 *
 * Shared client library for connecting to disco-daemon from CLI and UI
 */

import type {
  Agent,
  AgentCapabilityEntry,
  AgentCapabilityPatch,
  AgenticToolPreset,
  AuthenticationResult,
  CodexSkillCatalogEntry,
  CodexSkillSettingsPatch,
  CreateAgentInput,
  CreateAgenticToolPreset,
  CreateSessionInput,
  DiscoSkillInstallInput,
  ExecutorTranscriptRequest,
  ExecutorTranscriptResponse,
  Group,
  GroupMembership,
  LeaderboardEntry,
  LeaderboardQuery,
  LeaderboardResult,
  MCPCatalogConnectData,
  MCPCatalogConnectResult,
  MCPCatalogEntry,
  MCPMemberPolicySetting,
  MCPServer,
  Message,
  MessageCreate,
  MessagePatch,
  OpenCodeModelCatalog,
  OpenCodeOAuthAttempt,
  OpenCodeOAuthAttemptPatch,
  OpenCodeOAuthConnectRequest,
  OpenCodeProviderSettings,
  PatchAgentInput,
  PatchAgenticToolPreset,
  PermissionMode,
  RuntimeTelemetryInput,
  Schedule,
  ScheduleCreateData,
  SchedulePatchData,
  SdkHealthFailureInput,
  Session,
  SessionSearchMatch,
  SessionSearchQuery,
  SessionSearchResult,
  SessionUpdate,
  Task,
  TemplateRenderRequest,
  TemplateRenderResponse,
  TenantAgenticToolSettings,
  TenantAgenticToolSettingsPatch,
  User,
  UUID,
} from '@disco/core/types';
import authentication from '@feathersjs/authentication-client';
import type { Application, Paginated, Params } from '@feathersjs/feathers';
import { feathers } from '@feathersjs/feathers';
import socketio from '@feathersjs/socketio-client';
import io, { type Socket } from 'socket.io-client';
import { DAEMON, MESSAGE_PAGINATION, PAGINATION } from '../config/constants';
import type {
  RuntimeCapabilityCatalog,
  RuntimeCapabilityDefinition,
} from '../runtime-capabilities.js';

export type {
  RuntimeCapabilityCatalog,
  RuntimeCapabilityDefinition,
} from '../runtime-capabilities.js';

/**
 * Default daemon URL for client connections
 */
const DEFAULT_DAEMON_URL = `http://${DAEMON.DEFAULT_HOST}:${DAEMON.DEFAULT_PORT}`;

/** Symbols used to mark client services after custom helpers are attached. */
const USERS_SERVICE_EXTENDED = Symbol('disco.usersServiceExtended');
const TASKS_SERVICE_EXTENDED = Symbol('disco.tasksServiceExtended');
const SERVICE_FIND_ALL_EXTENDED = Symbol('disco.serviceFindAllExtended');
const CLIENT_SERVICE_FACTORY_EXTENDED = Symbol('disco.clientServiceFactoryExtended');
const CLIENT_SESSIONS_HELPERS_EXTENDED = Symbol('disco.clientSessionsHelpersExtended');
const CLIENT_TASKS_HELPERS_EXTENDED = Symbol('disco.clientTasksHelpersExtended');

/**
 * Client-side input type helper:
 * keeps strongly typed output models branded, while accepting plain strings
 * for branded UUID fields in create/update/patch payloads.
 */
export type ClientInput<T> = T extends UUID
  ? string
  : T extends string & { readonly __brand: string }
    ? string
    : T extends readonly (infer U)[]
      ? ClientInput<U>[]
      : T extends (...args: unknown[]) => unknown
        ? T
        : T extends object
          ? { [K in keyof T]: ClientInput<T[K]> }
          : T;

export type CreatePayload<T> = Partial<ClientInput<T>>;
export type UpdatePayload<T> = ClientInput<T>;
export type PatchPayload<T> = Partial<ClientInput<T>> | null;
export type FindResult<T> = Paginated<T> | T[];

export interface SessionPromptRequest {
  prompt: string;
  permissionMode?: PermissionMode;
  stream?: boolean;
  /** Add guidance to the active Codex turn instead of creating a queued Task. */
  steer?: boolean;
}

export interface QueuedSessionPromptResult {
  success: true;
  queued: true;
  message: Message;
  queue_position: number;
}

export interface RunningSessionPromptResult {
  success: true;
  taskId: string;
  status: string;
  streaming: boolean;
  queued?: false;
  /** True when the prompt was attached to the currently running turn. */
  steered?: boolean;
  /** Disco transcript row created for the steering message. */
  messageId?: string;
}

export type SessionPromptResult = QueuedSessionPromptResult | RunningSessionPromptResult;

export interface SessionPromptOptions extends Omit<SessionPromptRequest, 'prompt'> {
  params?: Params;
}

export interface SessionsClientHelpers {
  prompt(
    sessionId: string,
    prompt: string,
    options?: SessionPromptOptions
  ): Promise<SessionPromptResult>;
}

/**
 * Body shape for `POST /tasks/:id/run`. Message provenance is derived by the
 * daemon from the authenticated transport rather than accepted from callers.
 */
export interface TaskRunRequest {
  permissionMode?: PermissionMode;
  stream?: boolean;
}

export interface TaskRunOptions extends TaskRunRequest {
  params?: Params;
}

export interface TasksClientHelpers {
  /**
   * Trigger executor pickup for an already-created task. Pure-REST harnesses
   * use this after `POST /tasks` to avoid needing an MCP client. Returns the
   * Task with `status: 'dispatching'`; the authenticated executor claims it
   * as `running`. Only `'created'` tasks on idle sessions are accepted —
   * `'queued'` tasks drain automatically in queue-position order, and busy
   * sessions should be prompted via `client.sessions.prompt()` (which creates
   * and queues the task atomically).
   */
  run(taskId: string, options?: TaskRunOptions): Promise<Task>;
}

/**
 * Server-side Handlebars renderer. UI sends `{template, context}` via
 * `client.service('templates').create(...)`; daemon returns `{rendered}`.
 * Used so the browser bundle doesn't need Handlebars (avoids CSP
 * `script-src 'unsafe-eval'`).
 *
 * Transport DTOs live in `@disco/core/types/template.ts` so the daemon
 * service and this client typing share one shape.
 */
export type { TemplateRenderRequest, TemplateRenderResponse };

export interface TemplatesService {
  create(data: TemplateRenderRequest, params?: Params): Promise<TemplateRenderResponse>;
}

export interface LeaderboardService {
  find(params?: { query?: LeaderboardQuery }): Promise<LeaderboardResult>;
}

/** Current-user conversation search across titles, visible transcript text and attachment names. */
export interface SessionSearchService {
  find(params?: { query?: SessionSearchQuery }): Promise<SessionSearchResult>;
}

/** Read-only snapshot generated from the daemon's live capability registry. */
export interface RuntimeCapabilitiesService {
  find(params?: Params): Promise<RuntimeCapabilityCatalog>;
}

/**
 * Service interfaces for type safety
 */
export interface ServiceTypes {
  agents: Agent;
  sessions: Session;
  tasks: Task;
  schedules: Schedule;
  users: User;
  groups: Group;
  'group-memberships': GroupMembership;
  'mcp-servers': MCPServer;
  'mcp-catalog': MCPCatalogEntry;
  'mcp-catalog/connect': MCPCatalogConnectResult;
  'mcp-member-policy': MCPMemberPolicySetting;
  templates: TemplateRenderResponse;
  'agentic-tool-settings': TenantAgenticToolSettings;
  'agentic-tool-presets': AgenticToolPreset;
  'codex-skills': CodexSkillCatalogEntry;
  'agent-capabilities': AgentCapabilityEntry;
  'runtime-capabilities': RuntimeCapabilityDefinition;
  leaderboard: LeaderboardEntry;
  'session-search': SessionSearchMatch;
  'opencode-auth': OpenCodeProviderSettings;
  'opencode-models': OpenCodeModelCatalog;
}

/**
 * Feathers service with find method properly typed and event emitter methods
 */
export interface DiscoService<
  T,
  TCreate = CreatePayload<T>,
  TUpdate = UpdatePayload<T>,
  TPatch = PatchPayload<T>,
> {
  // CRUD methods
  find(params?: Params): Promise<FindResult<T>>;
  findAll(params?: Params): Promise<T[]>;
  get(id: string, params?: Params): Promise<T>;
  create(data: TCreate, params?: Params): Promise<T>;
  update(id: string, data: TUpdate, params?: Params): Promise<T>;
  patch(id: string | null, data: TPatch, params?: Params): Promise<T>;
  remove(id: string, params?: Params): Promise<T>;

  // Event emitter methods (for real-time updates)
  // Standard CRUD events use the service entity type T
  on(event: 'created' | 'updated' | 'patched' | 'removed', handler: (data: T) => void): void;
  // Custom events (e.g. permission_resolved, queued)
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers have varied signatures
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: 'created' | 'updated' | 'patched' | 'removed', handler: (data: T) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers have varied signatures
  off(event: string, handler: (...args: any[]) => void): void;
  removeListener(
    event: 'created' | 'updated' | 'patched' | 'removed',
    handler: (data: T) => void
  ): void;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers have varied signatures
  removeListener(event: string, handler: (...args: any[]) => void): void;

  // Emit custom events to WebSocket clients (available at runtime via FeathersJS socket.io integration)
  emit(event: string, data: unknown): void;
}

/** Schedules return storage-facing rows but accept active-only public write data. */
export interface SchedulesService
  extends DiscoService<
    Schedule,
    ClientInput<ScheduleCreateData>,
    never,
    ClientInput<SchedulePatchData> | null
  > {}

export type AgenticToolSettingsService = DiscoService<
  TenantAgenticToolSettings,
  never,
  never,
  TenantAgenticToolSettingsPatch
>;

export type CodexSkillsService = DiscoService<
  CodexSkillCatalogEntry,
  DiscoSkillInstallInput,
  never,
  CodexSkillSettingsPatch
>;

export type AgentCapabilitiesService = DiscoService<
  AgentCapabilityEntry,
  DiscoSkillInstallInput,
  never,
  AgentCapabilityPatch
>;

export type AgentsService = DiscoService<Agent, CreateAgentInput, never, PatchAgentInput>;

export type AgenticToolPresetsService = DiscoService<
  AgenticToolPreset,
  CreateAgenticToolPreset,
  never,
  PatchAgenticToolPreset
>;

export interface OpenCodeAuthService {
  find(params?: Params): Promise<OpenCodeProviderSettings>;
  get(attemptId: string, params?: Params): Promise<OpenCodeOAuthAttempt>;
  create(
    data:
      | { providerId: string; apiKey: string; metadata?: Record<string, string> }
      | OpenCodeOAuthConnectRequest,
    params?: Params
  ): Promise<OpenCodeProviderSettings | OpenCodeOAuthAttempt>;
  patch(
    attemptId: string,
    data: OpenCodeOAuthAttemptPatch,
    params?: Params
  ): Promise<OpenCodeOAuthAttempt>;
  remove(providerId: string, params?: Params): Promise<OpenCodeProviderSettings>;
}

export interface OpenCodeModelsService {
  find(params?: Params): Promise<OpenCodeModelCatalog>;
}

/**
 * Marketplace connect command endpoint.
 *
 * Create-only: it installs one catalog entry and returns the session that can
 * use it. There is nothing to read back, so it exposes no find/get.
 */
export interface MCPCatalogConnectService {
  create(data: MCPCatalogConnectData, params?: Params): Promise<MCPCatalogConnectResult>;
}

/**
 * Singleton tenant-wide MCP member policy endpoint.
 *
 * Readable by members — the value explains why a write of theirs was refused —
 * and writable by admins. The daemon enforces both; this typing only describes
 * the shape.
 */
export interface MCPMemberPolicyService {
  find(params?: Params): Promise<MCPMemberPolicySetting>;
  // `can_configure` is the daemon's answer about the caller, not a field a
  // caller submits, so a write names the policy and nothing else.
  patch(
    id: null,
    data: Pick<MCPMemberPolicySetting, 'policy'>,
    params?: Params
  ): Promise<MCPMemberPolicySetting>;
}

/**
 * Sessions service with custom methods for forking, spawning, and genealogy
 */
export interface SessionsService
  extends DiscoService<
    Session,
    CreatePayload<CreateSessionInput>,
    ClientInput<SessionUpdate>,
    ClientInput<SessionUpdate>
  > {
  /**
   * Fork a session at a decision point
   * Creates a new session branching from the parent at a specific task
   */
  fork(id: string, data: { prompt: string; task_id?: string }, params?: Params): Promise<Session>;

  /**
   * Spawn a child session from a parent
   * Creates a new session with the parent's context
   */
  spawn(
    id: string,
    data: { prompt: string; agent?: string; task_id?: string },
    params?: Params
  ): Promise<Session>;

  /**
   * Get genealogy tree for a session
   * Returns the full ancestor/descendant tree
   */
  getGenealogy(id: string, params?: Params): Promise<unknown>;
}

/** Tasks service with lifecycle methods. */
export interface TasksService extends DiscoService<Task> {
  /** Claim a daemon-dispatched task after executor authentication. */
  connectExecutor(data: { task_id: string }, params?: Params): Promise<Task>;
  /** Report that a requested cooperative stop has fully quiesced SDK work. */
  reportTerminationComplete(
    data: import('../types/task').ExecutorTerminationCompleteInput,
    params?: Params
  ): Promise<Task>;
  /** Report daemon-stamped wrapper liveness and the latest coalesced SDK pulse. */
  reportRuntimeTelemetry(data: RuntimeTelemetryInput, params?: Params): Promise<Task>;
  /** Report a daemon-authorized SDK watchdog decision. */
  reportSdkHealthFailure(data: SdkHealthFailureInput, params?: Params): Promise<Task>;
  /**
   * Mark a task as completed
   */
  complete(id: string, data: { report?: unknown }, params?: Params): Promise<Task>;

  /**
   * Mark a task as failed
   */
  fail(id: string, data: { error: string }, params?: Params): Promise<Task>;
}

/** Public Message CRUD surface. Full replacement is daemon-internal. */
export type MessagesService = Omit<
  DiscoService<Message, ClientInput<MessageCreate>>,
  'update' | 'patch'
> & {
  patch(id: string, data: ClientInput<MessagePatch>, params?: Params): Promise<Message>;
};

/**
 * Users service with git environment support
 */
export interface UsersService extends DiscoService<User> {
  /**
   * Get the full resolved git environment for a user.
   * Auth: service-account JWTs may fetch any user's env;
   * regular users may only fetch their own.
   */
  getGitEnvironment(data: { userId: string }, params?: Params): Promise<Record<string, string>>;
}

/**
 * Disco client with socket.io connection exposed for lifecycle management
 */
export interface DiscoClient extends Omit<Application<ServiceTypes>, 'service'> {
  io: Socket;
  sessions: SessionsClientHelpers;
  tasks: TasksClientHelpers;

  // Typed service overloads for services with custom methods
  service(path: 'sessions'): SessionsService;
  service(path: 'tasks'): TasksService;
  service(path: 'messages'): MessagesService;
  service(
    path: 'executor-transcripts'
  ): Pick<DiscoService<ExecutorTranscriptResponse, ExecutorTranscriptRequest>, 'create'>;
  service(path: 'schedules'): SchedulesService;
  service(path: 'agentic-tool-settings'): AgenticToolSettingsService;
  service(path: 'agentic-tool-presets'): AgenticToolPresetsService;
  service(path: 'codex-skills'): CodexSkillsService;
  service(path: 'agent-capabilities'): AgentCapabilitiesService;
  service(path: 'runtime-capabilities'): RuntimeCapabilitiesService;
  service(path: 'agents'): AgentsService;
  service(path: 'opencode-auth'): OpenCodeAuthService;
  service(path: 'opencode-models'): OpenCodeModelsService;
  service(path: 'leaderboard'): LeaderboardService;
  service(path: 'session-search'): SessionSearchService;

  // Standard services (CRUD only)
  service(path: 'users'): UsersService;
  service(path: 'mcp-servers'): DiscoService<MCPServer>;
  service(path: 'mcp-catalog'): DiscoService<MCPCatalogEntry>;
  service(path: 'mcp-catalog/connect'): MCPCatalogConnectService;
  service(path: 'mcp-member-policy'): MCPMemberPolicyService;
  service(path: 'templates'): TemplatesService;

  // Generic fallback for custom routes and dynamic paths
  service<K extends keyof ServiceTypes>(path: K): DiscoService<ServiceTypes[K]>;
  service(path: string): DiscoService<unknown>;

  // Authentication methods (from @feathersjs/authentication-client)
  authenticate(credentials?: {
    strategy?: string;
    username?: string;
    password?: string;
    accessToken?: string;
  }): Promise<AuthenticationResult>;
  logout(): Promise<AuthenticationResult | null>;
  reAuthenticate(force?: boolean): Promise<AuthenticationResult>;
}

export function normalizeFindResult<T>(result: FindResult<T>): T[] {
  return Array.isArray(result) ? result : result.data;
}

function isPaginatedResult<T>(result: FindResult<T>): result is Paginated<T> {
  return (
    !Array.isArray(result) &&
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as Paginated<T>).data)
  );
}

function isAscendingHydrationSort(path: string, sort: unknown): boolean {
  if (sort === undefined) return true;
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) return false;
  const entries = Object.entries(sort);
  if (path === 'messages') {
    return (
      entries.length >= 1 &&
      entries.length <= 2 &&
      entries[0][0] === 'index' &&
      entries[0][1] === 1 &&
      (entries.length === 1 || (entries[1][0] === 'message_id' && entries[1][1] === 1))
    );
  }
  return (
    entries.length === 2 &&
    entries[0][0] === 'created_at' &&
    entries[0][1] === 1 &&
    entries[1][0] === 'task_id' &&
    entries[1][1] === 1
  );
}

function hydrationKeysetFor(
  path: string,
  query: Record<string, unknown>
): { idField: 'message_id' | 'task_id'; pageLimit: number } | null {
  if (query.$skip !== undefined && query.$skip !== 0) return null;
  if (query.$select !== undefined) return null;
  if (!isAscendingHydrationSort(path, query.$sort)) return null;

  if (
    path === 'messages' &&
    query.message_id === undefined &&
    (typeof query.task_id === 'string' || typeof query.session_id === 'string')
  ) {
    return {
      idField: 'message_id',
      // Conversation projections omit tool payloads and can use the normal
      // list page size. Full transcripts keep their smaller transport pages.
      pageLimit:
        query.view === 'conversation' ? PAGINATION.MAX_LIMIT : MESSAGE_PAGINATION.MAX_LIMIT,
    };
  }
  if (path === 'tasks' && query.task_id === undefined && typeof query.session_id === 'string') {
    return { idField: 'task_id', pageLimit: PAGINATION.MAX_LIMIT };
  }
  return null;
}

function sortHydratedRows(path: string, rows: unknown[]): unknown[] {
  if (path === 'messages') {
    return rows.sort((left, right) => {
      const a = left as { index?: unknown; message_id?: unknown };
      const b = right as { index?: unknown; message_id?: unknown };
      const indexDiff = Number(a.index ?? 0) - Number(b.index ?? 0);
      return indexDiff || String(a.message_id).localeCompare(String(b.message_id));
    });
  }
  return rows.sort((left, right) => {
    const a = left as { created_at?: unknown; task_id?: unknown };
    const b = right as { created_at?: unknown; task_id?: unknown };
    const createdDiff =
      new Date(String(a.created_at)).getTime() - new Date(String(b.created_at)).getTime();
    return createdDiff || String(a.task_id).localeCompare(String(b.task_id));
  });
}

const MAX_HYDRATION_STABILITY_ATTEMPTS = 3;

class HydrationMembershipChangedError extends Error {}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function scanAtIdHighWater(
  service: DiscoService<unknown>,
  params: Params | undefined,
  path: string,
  idField: 'message_id' | 'task_id',
  pageLimit: number,
  idsOnly = false
): Promise<{ rows: unknown[]; ids: string[] }> {
  const originalQuery =
    params?.query && typeof params.query === 'object'
      ? ({ ...params.query } as Record<string, unknown>)
      : {};
  const baseQuery = { ...originalQuery };
  delete baseQuery.$limit;
  delete baseQuery.$skip;
  delete baseQuery.$sort;
  delete baseQuery.$select;
  delete baseQuery[idField];

  // Capture a traversal boundary. IDs are immutable but deliberately are not
  // monotonic by commit time, so the caller verifies every multi-page walk
  // against a second collection before accepting it as one stable membership
  // view.
  const boundaryResult = await service.find({
    ...(params ?? {}),
    query: {
      ...baseQuery,
      $sort: { [idField]: -1 },
      $limit: 1,
      $select: [idField],
    },
  });
  const boundaryData = normalizeFindResult(boundaryResult);
  if (boundaryData.length === 0) return { rows: [], ids: [] };
  const through = (boundaryData[0] as Record<string, unknown>)[idField];
  if (typeof through !== 'string') {
    throw new Error(`Cannot hydrate ${path}: boundary page omitted ${idField}`);
  }

  const rows: unknown[] = [];
  let after: string | undefined;
  for (;;) {
    const cursor = after ? { $gt: after, $lte: through } : { $lte: through };
    const pageResult = await service.find({
      ...(params ?? {}),
      query: {
        ...baseQuery,
        [idField]: cursor,
        $sort: { [idField]: 1 },
        $limit: pageLimit,
        ...(idsOnly ? { $select: [idField] } : {}),
      },
    });
    const page = normalizeFindResult(pageResult);
    if (page.length === 0) {
      throw new HydrationMembershipChangedError(
        `Cannot hydrate ${path}: keyset ended before ${idField} high-water mark`
      );
    }

    for (const row of page) {
      const id = (row as Record<string, unknown>)[idField];
      if (typeof id !== 'string' || (after !== undefined && id <= after) || id > through) {
        throw new HydrationMembershipChangedError(
          `Cannot hydrate ${path}: ${idField} keyset did not advance`
        );
      }
      after = id;
      rows.push(row);
    }
    // Do not infer exhaustion from the requested limit. An older/more
    // conservative daemon may clamp the page below this client's compiled-in
    // ceiling. The immutable boundary (or an actually empty page) is the only
    // version-skew-safe completion signal for this keyset walk.
    if (after === through) break;
  }

  return { rows, ids: rows.map((row) => String((row as Record<string, unknown>)[idField])) };
}

async function findAllAtStableIdMembership(
  service: DiscoService<unknown>,
  params: Params | undefined,
  path: string,
  idField: 'message_id' | 'task_id',
  pageLimit: number
): Promise<unknown[]> {
  const originalQuery =
    params?.query && typeof params.query === 'object'
      ? ({ ...params.query } as Record<string, unknown>)
      : {};
  const probeResult = await service.find({
    ...(params ?? {}),
    query: {
      ...originalQuery,
      $sort: { [idField]: 1 },
      $limit: pageLimit,
    },
  });
  const probe = normalizeFindResult(probeResult);
  if (!isPaginatedResult(probeResult) || probe.length < probeResult.limit) {
    return sortHydratedRows(path, probe);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_HYDRATION_STABILITY_ATTEMPTS; attempt += 1) {
    try {
      const candidate = await scanAtIdHighWater(service, params, path, idField, pageLimit);
      const verification = await scanAtIdHighWater(service, params, path, idField, pageLimit, true);
      if (sameIds(candidate.ids, verification.ids)) {
        return sortHydratedRows(path, candidate.rows);
      }
      lastError = new HydrationMembershipChangedError(
        `Cannot hydrate ${path}: membership changed while keyset pages were being read`
      );
    } catch (error) {
      if (!(error instanceof HydrationMembershipChangedError)) throw error;
      lastError = error;
    }
  }

  throw (
    lastError ??
    new HydrationMembershipChangedError(
      `Cannot hydrate ${path}: membership did not stabilize after bounded retries`
    )
  );
}

function extendFindAllOnService(service: DiscoService<unknown>, rawPath: string): void {
  const findAllService = service as DiscoService<unknown> & {
    [SERVICE_FIND_ALL_EXTENDED]?: boolean;
  };

  if (findAllService[SERVICE_FIND_ALL_EXTENDED]) {
    return;
  }

  findAllService.findAll = async (params?: Params) => {
    const path = rawPath.replace(/^\//, '');
    const query =
      params?.query && typeof params.query === 'object'
        ? (params.query as Record<string, unknown>)
        : {};
    const keyset = hydrationKeysetFor(path, query);
    if (keyset) {
      return findAllAtStableIdMembership(service, params, path, keyset.idField, keyset.pageLimit);
    }

    const firstResult = await service.find(params);
    if (!isPaginatedResult(firstResult)) {
      return firstResult;
    }

    const allData = [...firstResult.data];
    const total = firstResult.total;
    // Feathers `total` describes the whole matching query, not the tail that
    // begins at `$skip`. Preserve the caller's offset semantics while still
    // validating that every continuation page belongs to one stable walk.
    const initialSkip = firstResult.skip;
    const expectedRows = Math.max(0, total - initialSkip);
    let nextSkip = firstResult.skip + firstResult.data.length;
    const pageLimit =
      typeof firstResult.limit === 'number' && firstResult.limit > 0
        ? firstResult.limit
        : firstResult.data.length;

    if (!Number.isFinite(total) || pageLimit <= 0) {
      return allData;
    }

    const baseQuery =
      params?.query && typeof params.query === 'object' ? { ...params.query } : undefined;

    while (allData.length < expectedRows) {
      const nextParams: Params = {
        ...(params ?? {}),
        query: {
          ...(baseQuery ?? {}),
          $skip: nextSkip,
          $limit: pageLimit,
        },
      };

      const nextResult = await service.find(nextParams);
      if (!isPaginatedResult(nextResult)) {
        throw new Error('Paginated findAll() received a non-paginated continuation page');
      }

      if (nextResult.total !== total || nextResult.skip !== nextSkip) {
        throw new Error('Paginated findAll() changed while pages were being read');
      }
      if (nextResult.data.length === 0) {
        throw new Error('Paginated findAll() ended before the advertised total');
      }

      allData.push(...nextResult.data);
      nextSkip = nextResult.skip + nextResult.data.length;
    }

    if (allData.length !== expectedRows) {
      throw new Error('Paginated findAll() did not return the advertised total');
    }

    return allData;
  };

  findAllService[SERVICE_FIND_ALL_EXTENDED] = true;
}

/**
 * Wire client-side custom methods for services that expose RPCs beyond the
 * standard Feathers CRUD interface. The Socket.io client only wires the
 * default methods at construction time, so each path that has custom methods
 * on the server must call `service.methods(...)` here too — otherwise calling
 * them on the client proxy throws "client.service(...).<method> is not a
 * function". Keep these in sync with the `methods:` arrays in
 * `apps/disco-daemon/src/register-services.ts`.
 */
function extendUsersService(client: DiscoClient): void {
  const usersService = client.service('users') as DiscoService<User> & {
    [USERS_SERVICE_EXTENDED]?: boolean;
    methods?: (...names: string[]) => unknown;
  };
  if (usersService[USERS_SERVICE_EXTENDED]) return;
  if (typeof usersService.methods === 'function') {
    usersService.methods('getGitEnvironment');
  }
  usersService[USERS_SERVICE_EXTENDED] = true;
}

function extendTasksService(client: DiscoClient): void {
  const tasksService = client.service('tasks') as DiscoService<Task> & {
    [TASKS_SERVICE_EXTENDED]?: boolean;
    methods?: (...names: string[]) => unknown;
  };
  if (tasksService[TASKS_SERVICE_EXTENDED]) return;
  if (typeof tasksService.methods === 'function') {
    tasksService.methods(
      'connectExecutor',
      'reportTerminationComplete',
      'reportRuntimeTelemetry',
      'reportSdkHealthFailure'
    );
  }
  tasksService[TASKS_SERVICE_EXTENDED] = true;
}

function extendServiceFactory(client: DiscoClient): void {
  const augmentedClient = client as DiscoClient & {
    [CLIENT_SERVICE_FACTORY_EXTENDED]?: boolean;
  };

  if (augmentedClient[CLIENT_SERVICE_FACTORY_EXTENDED]) {
    return;
  }

  const rawService = client.service.bind(client) as (path: string) => DiscoService<unknown>;

  augmentedClient.service = ((path: string) => {
    const service = rawService(path);
    extendFindAllOnService(service, path);
    return service;
  }) as DiscoClient['service'];

  augmentedClient[CLIENT_SERVICE_FACTORY_EXTENDED] = true;
}

function extendSessionsHelpers(client: DiscoClient): void {
  const augmentedClient = client as DiscoClient & {
    [CLIENT_SESSIONS_HELPERS_EXTENDED]?: boolean;
  };

  if (augmentedClient[CLIENT_SESSIONS_HELPERS_EXTENDED]) {
    return;
  }

  client.sessions = {
    prompt: async (sessionId: string, prompt: string, options?: SessionPromptOptions) => {
      const { params, ...requestOptions } = options ?? {};
      const response = await client
        .service(`sessions/${sessionId}/prompt`)
        .create({ prompt, ...requestOptions } as SessionPromptRequest, params);
      return response as SessionPromptResult;
    },
  };

  augmentedClient[CLIENT_SESSIONS_HELPERS_EXTENDED] = true;
}

function extendTasksHelpers(client: DiscoClient): void {
  const augmentedClient = client as DiscoClient & {
    [CLIENT_TASKS_HELPERS_EXTENDED]?: boolean;
  };

  if (augmentedClient[CLIENT_TASKS_HELPERS_EXTENDED]) {
    return;
  }

  client.tasks = {
    run: async (taskId: string, options?: TaskRunOptions) => {
      const { params, ...requestOptions } = options ?? {};
      const response = await client
        .service(`tasks/${taskId}/run`)
        .create(requestOptions as TaskRunRequest, params);
      return response as Task;
    },
  };

  augmentedClient[CLIENT_TASKS_HELPERS_EXTENDED] = true;
}

/**
 * Create Feathers client connected to disco-daemon
 *
 * @param url - Daemon URL
 * @param autoConnect - Auto-connect socket (default: true for CLI, false for React)
 * @param options - Additional options
 * @returns Feathers client instance with socket exposed
 */
/**
 * Check if an DISCO_API_KEY environment variable is set.
 * Returns the key if valid format, null otherwise.
 */
export function getApiKeyFromEnv(): string | null {
  const key = typeof process !== 'undefined' ? process.env?.DISCO_API_KEY : null;
  if (key?.startsWith('disco_sk_')) {
    return key;
  }
  return null;
}

/**
 * Create REST-only Feathers client for CLI (prevents hanging processes)
 *
 * Uses REST transport instead of WebSocket to avoid keeping Node.js processes alive.
 * Only use this in CLI commands - UI should use createClient() with WebSocket.
 *
 * @param url - Daemon URL
 * @param apiKey - Optional API key to use for authentication (sets Authorization header on all requests)
 */
export async function createRestClient(
  url: string = DEFAULT_DAEMON_URL,
  apiKey?: string
): Promise<DiscoClient> {
  const client = feathers<ServiceTypes>() as DiscoClient;
  const fetchImpl = globalThis.fetch.bind(globalThis);

  // Lazy-load REST client (only imported when needed, not in browser bundles)
  const { default: rest } = await import('@feathersjs/rest-client');

  // When an API key is provided, wrap fetch to inject the Authorization header
  const fetchFn = apiKey
    ? (input: string | URL | globalThis.Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${apiKey}`);
        return fetchImpl(input, { ...init, headers });
      }
    : fetchImpl;

  // Configure REST transport
  client.configure(rest(url).fetch(fetchFn));

  // Configure authentication with no storage (CLI will manage tokens separately)
  client.configure(authentication({ storage: undefined }));

  // Create a dummy socket object to satisfy the interface
  client.io = {
    close: () => {},
    removeAllListeners: () => {},
    io: { opts: {} },
  } as unknown as Socket;

  extendServiceFactory(client);
  extendUsersService(client);
  extendTasksService(client);
  extendSessionsHelpers(client);
  extendTasksHelpers(client);

  return client;
}

export function createClient(
  url: string = DEFAULT_DAEMON_URL,
  autoConnect: boolean = true,
  options?: {
    /** Show connection status logs (useful for CLI) */
    verbose?: boolean;
    /** Limit reconnection attempts (useful for CLI to avoid hanging) */
    reconnectionAttempts?: number;
    /** Reject acknowledged service calls when Socket.IO does not receive an acknowledgement. */
    ackTimeout?: number;
    /** Explicit authentication storage for non-browser clients. */
    authStorage?: {
      getItem(key: string): string | null | Promise<string | null>;
      setItem(key: string, value: string): void | Promise<void>;
      removeItem(key: string): void | Promise<void>;
    };
  }
): DiscoClient {
  // Detect if running in browser vs Node.js (CLI)
  // Use 'in' operator to avoid TypeScript index signature errors during DTS build
  const isBrowser = typeof globalThis !== 'undefined' && 'window' in globalThis;

  // Configure socket.io with better defaults for React StrictMode and reconnection
  const socket = io(url, {
    // Auto-connect by default for CLI, manual control for React hooks
    autoConnect,
    // Reconnection settings
    reconnection: true,
    reconnectionDelay: 1000, // Wait 1s before first reconnect attempt
    reconnectionDelayMax: 5000, // Max 5s between attempts
    // Browser: keep trying indefinitely, CLI: fail fast (2 attempts)
    reconnectionAttempts:
      options?.reconnectionAttempts ?? (isBrowser ? Number.POSITIVE_INFINITY : 2),
    // Timeout settings
    timeout: 20000, // 20s timeout for initial connection
    ...(options?.ackTimeout === undefined ? {} : { ackTimeout: options.ackTimeout }),
    // Transports (WebSocket preferred, fallback to polling)
    transports: ['websocket', 'polling'],
    // Connection lifecycle settings
    closeOnBeforeunload: true, // Close socket when page unloads
  });

  // Add connection monitoring if verbose mode enabled
  if (options?.verbose) {
    let attemptCount = 0;
    const maxAttempts = options?.reconnectionAttempts ?? (isBrowser ? Infinity : 2);

    socket.on('connect_error', (error: Error) => {
      attemptCount++;
      if (attemptCount === 1) {
        console.error(`✗ Daemon not running at ${url}`);
        console.error(`  Retrying connection (${attemptCount}/${maxAttempts})...`);
      } else {
        console.error(`  Retry ${attemptCount}/${maxAttempts} failed`);
      }
    });

    socket.on('connect', () => {
      if (attemptCount > 0) {
        console.log('✓ Connected to daemon');
      }
    });
  }

  const client = feathers<ServiceTypes>() as DiscoClient;

  client.configure(socketio(socket));

  // Configure authentication with localStorage if available (browser only).
  // Node 25 exposes a `localStorage` global that is NOT a working Storage —
  // it has no `setItem` method, so the Feathers auth client throws
  // `_a.setItem is not a function` on first authenticate(). Guard against
  // that by also requiring a callable setItem before treating it as Storage.
  const _ls = (globalThis as { localStorage?: unknown }).localStorage as
    | (Storage & { setItem?: unknown })
    | undefined;
  const storage =
    options?.authStorage ??
    (_ls && typeof _ls.setItem === 'function' ? (_ls as Storage) : undefined);

  client.configure(authentication({ storage }));
  client.io = socket;

  extendServiceFactory(client);
  extendUsersService(client);
  extendTasksService(client);
  extendSessionsHelpers(client);
  extendTasksHelpers(client);

  return client;
}

/**
 * Check if daemon is running
 *
 * @param url - Daemon URL
 * @returns true if daemon is reachable
 */
export async function isDaemonRunning(url: string = DEFAULT_DAEMON_URL): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Re-export Feathers authentication client for use in executor
 * This allows the executor to import authentication client through @disco/core
 * instead of having it as a direct dependency
 */
export { default as authenticationClient } from '@feathersjs/authentication-client';
