/**
 * FeathersJS Type Declarations for Disco Daemon
 *
 * Provides proper TypeScript types for:
 * - Hook contexts with authentication
 * - Service implementations with custom methods
 * - Application instance
 */

import type { DiscoConfig } from '@disco/core/config';
import type { DistributedWorkIdentity } from '@disco/core/coordination';
import type {
  TaskDispatchClaimResult,
  TaskTerminationCoordinationClaimInput,
  TaskTerminationCoordinationClaimResult,
  TerminationClaimInput,
  TerminationClaimResult,
  TerminationSettlementInput,
  TerminationSettlementResult,
} from '@disco/core/db';
import type { ExpressApplication, Service } from '@disco/core/feathers';
import type {
  AuthenticatedParams as CoreAuthenticatedParams,
  AuthenticatedUser as CoreAuthenticatedUser,
  CreateHookContext as CoreCreateHookContext,
  HookContext as CoreHookContext,
  CreateSessionInput,
  DeepReadonly,
  Params as FeathersParams,
  Message,
  RuntimeTelemetryInput,
  SdkHealthFailureInput,
  Session,
  SessionUpdate,
  Task,
  TaskPendingDispatchStatus,
} from '@disco/core/types';
import type {
  ExecuteTaskData,
  SessionArchiveOptions,
  SessionArchiveResult,
} from './services/sessions.js';

// Re-export core types for convenience
export type AuthenticatedUser = CoreAuthenticatedUser;
export type AuthenticatedParams = CoreAuthenticatedParams;
export type CreateHookContext<T = unknown> = CoreCreateHookContext<T>;
export type HookContext<T = unknown> = CoreHookContext<T>;

/**
 * Application type for the daemon
 */
export type Application = ExpressApplication & {
  get(name: 'config'): DeepReadonly<DiscoConfig>;
  set(name: 'config', value: DeepReadonly<DiscoConfig>): ExpressApplication;
  get(name: 'distributedWorkIdentity'): DistributedWorkIdentity | undefined;
  set(name: 'distributedWorkIdentity', value: DistributedWorkIdentity): ExpressApplication;
};

/**
 * Sessions service with custom methods (server-side implementation)
 * This matches the SessionRepository methods exposed via the service adapter
 */
export interface SessionsServiceImpl
  extends Omit<
    Service<Session, CreateSessionInput, FeathersParams, SessionUpdate>,
    'patch' | 'update'
  > {
  patch(
    id: import('@disco/core/types').NullableId,
    data: SessionUpdate,
    params?: FeathersParams
  ): Promise<Session | Session[]>;
  update(id: string, data: SessionUpdate, params?: FeathersParams): Promise<Session>;
  fork(
    id: string,
    data: { prompt: string; task_id?: string },
    params?: FeathersParams
  ): Promise<Session>;
  spawn(
    id: string,
    data: Partial<import('@disco/core/types').SpawnConfig>,
    params?: FeathersParams
  ): Promise<Session>;
  getGenealogy(
    id: string,
    params?: FeathersParams
  ): Promise<{
    session: import('@disco/core/types').Session;
    ancestors: import('@disco/core/types').Session[];
    children: import('@disco/core/types').Session[];
  }>;
  archive(
    id: string,
    options?: SessionArchiveOptions,
    params?: FeathersParams
  ): Promise<SessionArchiveResult>;
  unarchive(
    id: string,
    options?: SessionArchiveOptions,
    params?: FeathersParams
  ): Promise<SessionArchiveResult>;
  enrichRemoteRelationships(
    sessionList: import('@disco/core/types').Session[]
  ): Promise<import('@disco/core/types').Session[]>;
  // Callback queue processing
  setQueueProcessor(
    processor: (
      sessionId: import('@disco/core/types').SessionID,
      params?: FeathersParams
    ) => Promise<void>
  ): void;
  triggerQueueProcessing(id: string, params?: FeathersParams): Promise<void>;
  // Feathers/WebSocket executor architecture handlers
  setExecuteHandler(
    handler: (
      sessionId: string,
      data: ExecuteTaskData,
      params?: FeathersParams
    ) => Promise<{
      success: boolean;
      taskId: string;
      status: string;
      streaming: boolean;
    }>
  ): void;
  executeTask(
    id: string,
    data: ExecuteTaskData,
    params?: FeathersParams
  ): Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }>;
  materializeAgenticToolPreset(session: Session, params?: FeathersParams): Promise<Session>;
  // Event emitter methods (FeathersJS EventEmitter interface - any[] for event args flexibility)
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers accept variable arguments
  on(event: string, handler: (...args: any[]) => void): this;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers accept variable arguments
  removeListener(event: string, handler: (...args: any[]) => void): this;
}

/**
 * Tasks service with custom methods (server-side implementation)
 */
export interface TasksServiceImpl extends Service<Task, Partial<Task>, FeathersParams> {
  claimDispatchAndProjectSession(
    taskId: string,
    expectedStatus: TaskPendingDispatchStatus,
    updates: Partial<Task>,
    params?: FeathersParams
  ): Promise<TaskDispatchClaimResult>;
  connectExecutor(data: { task_id: string }, params?: FeathersParams): Promise<Task>;
  reportTerminationComplete(
    data: import('@disco/core/types').ExecutorTerminationCompleteInput,
    params?: FeathersParams
  ): Promise<Task>;
  recordExecutorStartupWarning(
    taskId: string,
    warning: string,
    params?: FeathersParams
  ): Promise<Task | null>;
  reportRuntimeTelemetry(data: RuntimeTelemetryInput, params?: FeathersParams): Promise<Task>;
  reportSdkHealthFailure(data: SdkHealthFailureInput, params?: FeathersParams): Promise<Task>;
  autoTitleSession(task: Task, params?: FeathersParams): Promise<void>;
  complete(
    id: string,
    data: { git_state?: { sha_at_end?: string; commit_message?: string } },
    params?: FeathersParams
  ): Promise<Task>;
  fail(id: string, data: { error?: string }, params?: FeathersParams): Promise<Task>;
  getOrphaned(params?: FeathersParams): Promise<Task[]>;
  getActiveWithExecutorHeartbeat(params?: FeathersParams): Promise<Task[]>;
  claimTermination(
    input: TerminationClaimInput,
    params?: FeathersParams
  ): Promise<TerminationClaimResult>;
  claimTerminationCoordination(
    input: TaskTerminationCoordinationClaimInput,
    params?: FeathersParams
  ): Promise<TaskTerminationCoordinationClaimResult>;
  settleTermination(
    input: TerminationSettlementInput,
    params?: FeathersParams
  ): Promise<TerminationSettlementResult>;
}

/**
 * Messages service with custom methods (server-side implementation)
 */
export interface MessagesServiceImpl
  extends Service<
    Message,
    import('@disco/core/types').MessageCreate,
    FeathersParams,
    import('@disco/core/types').MessagePatch
  > {
  findByIdForScopeCheck(messageId: import('@disco/core/types').MessageID): Promise<Message | null>;
}

