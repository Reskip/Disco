/**
 * SQLite Schema Definition
 *
 * Uses type factory helpers for the 3 differing types (timestamp, boolean, json).
 * All other types (text, index, foreign keys) are identical to PostgreSQL schema.
 */

import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  Message,
  PermissionMode,
  Session,
  Task,
  TokenUsageSample,
} from '@disco/core/types';
import { relations, sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// SQLite-specific type helpers (inline to avoid factory pattern type issues)
const t = {
  timestamp: (name: string) => integer(name, { mode: 'timestamp_ms' }),
  bool: (name: string) => integer(name, { mode: 'boolean' }),
  json: <T>(name: string) => text(name, { mode: 'json' }).$type<T>(),
} as const;

/** Persistent Disco Agent identities. */
export const agents = sqliteTable(
  'agents',
  {
    agent_id: text('agent_id', { length: 36 }).primaryKey(),
    created_by: text('created_by', { length: 36 }).notNull(),
    display_name: text('display_name').notNull(),
    description: text('description'),
    emoji: text('emoji'),
    avatar_url: text('avatar_url'),
    workspace_path: text('workspace_path').notNull(),
    state: text('state', { enum: ['creating', 'ready', 'failed'] })
      .notNull()
      .default('creating'),
    error_message: text('error_message'),
    archived: t.bool('archived').notNull().default(false),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    ownerIdx: index('agents_owner_idx').on(table.created_by),
    ownerArchivedIdx: index('agents_owner_archived_idx').on(table.created_by, table.archived),
  })
);

/**
 * Sessions table - Core primitive for all agentic tool interactions
 *
 * Hybrid schema strategy:
 * - Materialize columns used for filtering and joins.
 * - Keep nested or rarely queried runtime data in the JSON blob.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    // Primary identity
    session_id: text('session_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull(),

    // Direct Disco runtime identity. Null means a personality-free standalone session.
    agent_id: text('agent_id', { length: 36 }).references(() => agents.agent_id, {
      onDelete: 'set null',
    }),
    // Exact execution directory stamped when the Session is created.
    working_directory: text('working_directory'),

    // Immutable execution-home key (legacy column name)
    // Set from creator's unix_username at session creation time
    // NEVER changes, even if user's unix_username changes later
    // This ensures SDK session data remains accessible in the original home directory
    unix_username: text('unix_username'),

    // Materialized for filtering/joins (cross-DB compatible)
    status: text('status', {
      enum: [
        'idle',
        'running',
        'stopping',
        'awaiting_permission',
        'awaiting_input',
        'timed_out',
        'completed',
        'failed',
      ],
    }).notNull(),
    agentic_tool: text('agentic_tool', {
      // Retain the removed identifier so historical rows remain readable.
      // Runtime creation and execution validate against AgenticToolName.
      enum: ['claude-code', 'claude-code-cli', 'codex', 'gemini', 'opencode', 'copilot', 'cursor'],
    }).notNull(),
    agentic_tool_preset_id: text('agentic_tool_preset_id', { length: 36 }).references(
      (): AnySQLiteColumn => agenticToolPresets.preset_id,
      { onDelete: 'restrict' }
    ),
    // Genealogy (materialized for tree queries)
    parent_session_id: text('parent_session_id', { length: 36 }),
    forked_from_session_id: text('forked_from_session_id', { length: 36 }),

    // Scheduler tracking (materialized for deduplication and retention cleanup)
    scheduled_run_at: integer('scheduled_run_at'), // Unix timestamp (ms) - authoritative run ID
    is_scheduled: t.bool('is_scheduled').notNull().default(false),
    // FK to schedules.schedule_id, ON DELETE SET NULL. Defined here (not
    // just in the migration) so drizzle-kit / db introspection sees the
    // constraint and so future schema diffs don't lose it.
    schedule_id: text('schedule_id', { length: 36 }).references(
      (): import('drizzle-orm/sqlite-core').AnySQLiteColumn => schedules.schedule_id,
      { onDelete: 'set null' }
    ),
    // Internal scheduler recovery marker. Existing rows are backfilled by the
    // migration; new occurrences remain NULL until initialization, retention,
    // and schedule metadata are durable.
    scheduler_init_completed_at: t.timestamp('scheduler_init_completed_at'),

    // UI state (materialized for efficient highlighting queries)
    ready_for_prompt: t.bool('ready_for_prompt').notNull().default(false),

    // Archive state
    archived: t.bool('archived').notNull().default(false),
    archived_reason: text('archived_reason', {
      enum: ['manual', 'parent_archived', 'btw_completed'],
    }),

    // JSON blob for everything else (cross-DB via json() type)
    data: t
      .json<unknown>('data')
      .$type<{
        agentic_tool_version?: string;
        sdk_session_id?: string; // SDK session ID for conversation continuity (Claude Agent SDK, Codex SDK, etc.)
        mcp_token?: string; // MCP authentication token for Disco self-access
        title?: string; // Session title (user-provided or auto-generated)
        description?: string; // Legacy field, may contain first prompt

        // Genealogy details (children array, fork/spawn points)
        genealogy: {
          fork_point_task_id?: string;
          fork_point_message_index?: number;
          spawn_point_task_id?: string;
          spawn_point_message_index?: number;
          children: string[];
        };

        // Context
        contextFiles: string[];
        tasks: string[];

        // Note: message_count was removed — computed dynamically via COUNT(*) where needed

        // Permission config (session-level permission settings)
        permission_config?: {
          mode?: PermissionMode; // For Claude/Gemini (SDK handles tool-level permissions)
          codex?: {
            sandboxMode: CodexSandboxMode;
            approvalPolicy: CodexApprovalPolicy;
          };
        } | null;

        // Model config (session-level model selection)
        model_config?: Session['model_config'];

        // Callback config (child/remote session completion notifications)
        callback_config?: Session['callback_config'];

        // Fork origin tracking (set to 'btw' for ephemeral btw forks)
        fork_origin?: 'btw';

        // Context window tracking (cumulative usage from latest task)
        current_context_usage?: number; // Tokens currently in context
        context_window_limit?: number; // Model's max context (e.g., 200K)
        last_context_update_at?: string; // ISO 8601 timestamp

        // Custom context for Handlebars templates
        // Keep scheduler/gateway/user context owned by the canonical Session type.
        custom_context?: Session['custom_context'];

        // Read-only billing metadata retained with historical sessions.
        billing_mode?: 'subscription' | 'api-key' | 'unknown';
      }>()
      .notNull(),
  },
  (table) => ({
    statusIdx: index('sessions_status_idx').on(table.status),
    statusReadyIdx: index('sessions_status_ready_idx').on(table.status, table.ready_for_prompt),
    agenticToolIdx: index('sessions_agentic_tool_idx').on(table.agentic_tool),
    agenticToolPresetIdx: index('sessions_agentic_tool_preset_idx').on(
      table.agentic_tool_preset_id
    ),
    agentIdx: index('sessions_agent_idx').on(table.agent_id),
    createdIdx: index('sessions_created_idx').on(table.created_at),
    parentIdx: index('sessions_parent_idx').on(table.parent_session_id),
    forkedIdx: index('sessions_forked_idx').on(table.forked_from_session_id),
    // Scheduler indexes — including the partial unique index below.
    scheduledIdx: index('sessions_scheduled_flag_idx').on(table.is_scheduled),
    // Partial unique index — covering for the scheduler's dedup lookup
    // AND serves as the DB-level guard against check-then-create races
    // in spawnScheduledSession (cron tick vs manual run-now, or two
    // tick async paths). Partial because schedule_id is nullable: ad-hoc
    // sessions all have schedule_id NULL and must coexist.
    scheduleRunUnique: uniqueIndex('sessions_schedule_run_unique')
      .on(table.schedule_id, table.scheduled_run_at)
      // Both columns must be non-null: the logical dedup key is
      // (schedule_id, scheduled_run_at) and is only meaningful when
      // both are set. Non-scheduled sessions (schedule_id NULL) must
      // coexist freely.
      .where(sql`${table.schedule_id} IS NOT NULL AND ${table.scheduled_run_at} IS NOT NULL`),
    schedulerInitPendingIdx: index('sessions_scheduler_init_pending_idx')
      .on(table.created_at, table.session_id)
      .where(
        sql`${table.is_scheduled} = true AND ${table.scheduled_run_at} IS NOT NULL AND ${table.scheduler_init_completed_at} IS NULL`
      ),
  })
);

/**
 * Session Relationships table
 *
 * Durable cross-session links that are not necessarily canonical genealogy.
 * Used for cross-branch remote-create provenance while keeping
 * sessions.genealogy.parent_session_id branch-local.
 */
export const sessionRelationships = sqliteTable(
  'session_relationships',
  {
    relationship_id: text('relationship_id', { length: 36 }).primaryKey(),
    source_session_id: text('source_session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    target_session_id: text('target_session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    relationship_type: text('relationship_type', { enum: ['remote_create'] }).notNull(),
    created_by: text('created_by', { length: 36 }).notNull(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
    callback_enabled: t.bool('callback_enabled').notNull().default(false),
    callback_session_id: text('callback_session_id', { length: 36 }).references(
      () => sessions.session_id,
      {
        onDelete: 'set null',
      }
    ),
    data: t.json<Record<string, unknown>>('data'),
  },
  (table) => ({
    sourceIdx: index('session_relationships_source_idx').on(table.source_session_id),
    targetIdx: index('session_relationships_target_idx').on(table.target_session_id),
    callbackIdx: index('session_relationships_callback_idx').on(table.callback_session_id),
    // Note: no tenant_source/tenant_target composite indexes here — SQLite schema
    // has no tenant column on this table (RLS is Postgres-only). The standalone
    // source/target indexes above are sufficient for SQLite.
    sourceTargetTypeUnique: uniqueIndex('session_relationships_source_target_type_unique').on(
      table.source_session_id,
      table.target_session_id,
      table.relationship_type
    ),
  })
);

/**
 * Tasks table - Granular work units within sessions
 */
export const tasks = sqliteTable(
  'tasks',
  {
    task_id: text('task_id', { length: 36 }).primaryKey(),
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    created_at: t.timestamp('created_at').notNull(),
    started_at: t.timestamp('started_at'),
    executor_connected_at: t.timestamp('executor_connected_at'),
    completed_at: t.timestamp('completed_at'),
    last_executor_heartbeat_at: t.timestamp('last_executor_heartbeat_at'),
    dispatch_timeout_observed_at: t.timestamp('dispatch_timeout_observed_at'),
    termination_coordination_token: text('termination_coordination_token'),
    termination_coordination_claimed_at: t.timestamp('termination_coordination_claimed_at'),
    termination_coordination_expires_at: t.timestamp('termination_coordination_expires_at'),
    termination_coordination_instance_id: text('termination_coordination_instance_id'),
    termination_coordination_boot_id: text('termination_coordination_boot_id'),
    termination_unverified_at: t.timestamp('termination_unverified_at'),
    status: text('status', {
      enum: [
        'queued',
        'created',
        'dispatching',
        'running',
        'stopping',
        'awaiting_permission',
        'awaiting_input',
        'timed_out',
        'completed',
        'failed',
        'stopped',
      ],
    }).notNull(),

    // Queue position (lower drains first); only populated for status='queued'
    queue_position: integer('queue_position'),

    // User attribution
    created_by: text('created_by', { length: 36 }).notNull(),

    data: t
      .json<unknown>('data')
      .$type<{
        full_prompt: string;

        message_range: Task['message_range'];
        git_state: Task['git_state'];

        /** Filled by the executor after the turn. */
        model?: string;
        tool_use_count: number;

        duration_ms?: number;
        agent_session_id?: string;

        // Populated when a task transitions to `failed` so the cause is
        // preserved instead of the session silently sitting idle.
        error_message?: string;

        // Raw SDK response - single source of truth for token accounting
        raw_sdk_response?: Task['raw_sdk_response'];

        // Normalized SDK response - computed from raw_sdk_response by executor
        // Stored so UI doesn't need SDK-specific normalization logic
        normalized_sdk_response?: Task['normalized_sdk_response'];

        // Computed context window (cumulative tokens)
        computed_context_window?: Task['computed_context_window'];

        report?: Task['report'];
        permission_request?: Task['permission_request'];

        // Generic metadata (e.g., is_disco_callback, source, child_session_id)
        metadata?: Task['metadata'];
        executor_mode?: Task['executor_mode'];
        latest_executor_pulse?: Task['latest_executor_pulse'];
        sdk_failure?: Task['sdk_failure'];
        termination_request?: Task['termination_request'];
        sdk_watchdog_mode?: Task['sdk_watchdog_mode'];
      }>()
      .notNull(),
  },
  (table) => ({
    sessionIdx: index('tasks_session_idx').on(table.session_id),
    sessionTaskIdIdx: index('tasks_session_task_id_idx').on(table.session_id, table.task_id),
    statusIdx: index('tasks_status_idx').on(table.status),
    createdIdx: index('tasks_created_idx').on(table.created_at),
    queueIdx: index('tasks_queue_idx').on(table.session_id, table.status, table.queue_position),
    runtimeDispatchIdx: index('tasks_runtime_dispatch_idx')
      .on(table.started_at, table.task_id)
      .where(
        sql`${table.status} = 'dispatching' AND ${table.executor_connected_at} IS NULL AND ${table.started_at} IS NOT NULL AND ${table.dispatch_timeout_observed_at} IS NULL`
      ),
    runtimeHeartbeatIdx: index('tasks_runtime_heartbeat_idx')
      .on(table.last_executor_heartbeat_at, table.task_id)
      .where(
        sql`${table.status} IN ('running', 'awaiting_permission', 'awaiting_input') AND ${table.last_executor_heartbeat_at} IS NOT NULL`
      ),
    runtimeTerminationIdx: index('tasks_runtime_termination_idx')
      .on(table.termination_coordination_expires_at, table.task_id)
      .where(sql`${table.status} = 'stopping' AND ${table.termination_unverified_at} IS NULL`),
    // Partial unique index — defense-in-depth for `tasks.createPending` race
    // serialization. Only QUEUED rows are constrained; CREATED/RUNNING/done
    // rows have NULL queue_position and are unaffected.
    queuedPositionUnique: uniqueIndex('tasks_queued_position_unique')
      .on(table.session_id, table.queue_position)
      .where(sql`${table.status} = 'queued'`),
    // Standalone recovery uses the same bounded Session scan without tenant
    // routing metadata.
    queueScanIdx: index('tasks_queue_scan_idx')
      .on(table.session_id, table.created_at)
      .where(sql`${table.status} = 'queued'`),
  })
);

/**
 * Immutable accounting identity for Task usage.
 *
 * Rows intentionally do not reference Sessions or Tasks: deleting conversation
 * content must never erase historical Token, cost, or duration statistics.
 * Database triggers keep each Task's single row current while the Task exists.
 */
export const taskUsageLedger = sqliteTable(
  'task_usage_ledger',
  {
    task_id: text('task_id', { length: 36 }).primaryKey(),
    session_id: text('session_id', { length: 36 }).notNull(),
    user_id: text('user_id', { length: 36 }).notNull(),
    agent_id: text('agent_id', { length: 36 }),
    agentic_tool: text('agentic_tool').notNull(),
    model: text('model'),
    task_created_at: t.timestamp('task_created_at').notNull(),
    task_completed_at: t.timestamp('task_completed_at'),
    recorded_at: t.timestamp('recorded_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    total_tokens: integer('total_tokens').notNull().default(0),
    cache_read_tokens: integer('cache_read_tokens').notNull().default(0),
    cache_creation_tokens: integer('cache_creation_tokens').notNull().default(0),
    cost_usd: real('cost_usd').notNull().default(0),
    duration_ms: integer('duration_ms').notNull().default(0),
    token_usage_samples: t.json<TokenUsageSample[]>('token_usage_samples').notNull().default([]),
  },
  (table) => ({
    createdIdx: index('task_usage_ledger_created_idx').on(table.task_created_at),
    userCreatedIdx: index('task_usage_ledger_user_created_idx').on(
      table.user_id,
      table.task_created_at
    ),
    modelIdx: index('task_usage_ledger_model_idx').on(table.model),
    toolIdx: index('task_usage_ledger_tool_idx').on(table.agentic_tool),
  })
);

/**
 * Schema mirror for PostgreSQL executor-session token authority.
 *
 * Standalone SQLite intentionally continues to use SessionTokenService's
 * process-local token Map; this table exists only to keep the dual schemas and
 * migration history compatible if a database changes dialect later.
 */
export const executorSessionTokenAuthorities = sqliteTable(
  'executor_session_token_authorities',
  {
    token_fingerprint: text('token_fingerprint', { length: 64 }).primaryKey(),
    token_type: text('token_type').notNull(),
    purpose: text('purpose').notNull(),
    session_id: text('session_id').notNull(),
    task_id: text('task_id'),
    user_id: text('user_id').notNull(),
    created_at: t.timestamp('created_at').notNull(),
    expires_at: t.timestamp('expires_at').notNull(),
    max_uses: integer('max_uses').notNull(),
    use_count: integer('use_count').notNull().default(0),
    last_used_at: t.timestamp('last_used_at'),
    revoked_at: t.timestamp('revoked_at'),
  },
  (table) => ({
    sessionIdx: index('executor_session_token_authorities_session_idx').on(table.session_id),
    expiresIdx: index('executor_session_token_authorities_expires_idx').on(table.expires_at),
    revokedIdx: index('executor_session_token_authorities_revoked_idx')
      .on(table.revoked_at)
      .where(sql`${table.revoked_at} IS NOT NULL`),
  })
);

/**
 * Schema mirror for PostgreSQL GitHub installation setup state.
 *
 * Standalone SQLite intentionally keeps the short-lived hash authority in the
 * daemon process. This unused table preserves dual-dialect migration history
 * without changing standalone behavior.
 */
export const githubInstallStates = sqliteTable(
  'github_install_states',
  {
    state_hash: text('state_hash', { length: 64 }).primaryKey(),
    user_id: text('user_id', { length: 36 }).notNull(),
    intent: text('intent').notNull(),
    created_at: t.timestamp('created_at').notNull(),
    expires_at: t.timestamp('expires_at').notNull(),
  },
  (table) => ({
    expiresIdx: index('github_install_states_expires_idx').on(table.expires_at),
  })
);

/**
 * Messages table - Conversation messages within sessions
 *
 * Stores individual messages (user, assistant, system) for full conversation replay.
 * Messages are indexed by session_id, task_id, and position (index) for efficient queries.
 */
export const messages = sqliteTable(
  'messages',
  {
    // Primary identity
    message_id: text('message_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),

    // Foreign keys (materialized for indexes)
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    task_id: text('task_id', { length: 36 }).references(() => tasks.task_id, {
      onDelete: 'set null',
    }),

    // Materialized for queries
    type: text('type', {
      enum: [
        'user',
        'assistant',
        'system',
        'file-history-snapshot',
        'permission_request',
        'input_request',
        'daemon_restart',
        'daemon_crash',
        'widget_request',
      ],
    }).notNull(),
    role: text('role', {
      enum: ['user', 'assistant', 'system'],
    }).notNull(),
    index: integer('index').notNull(), // Position in conversation (0-based)
    timestamp: t.timestamp('timestamp').notNull(),
    content_preview: text('content_preview'), // First 200 chars for list views

    // Parent tool use ID (for nested tool calls - e.g., Task tool spawning Read/Grep)
    parent_tool_use_id: text('parent_tool_use_id'),

    // NOTE: queueing moved off `messages` and onto `tasks.status='queued'` as
    // of migration sqlite/0040 (postgres/0030). The legacy `status` and
    // `queue_position` columns are gone — see `tasks.queue_position` instead.

    // Full data (JSON blob)
    data: t
      .json<unknown>('data')
      .$type<{
        content: Message['content'];
        tool_uses?: Message['tool_uses'];
        metadata?: Message['metadata'];
      }>()
      .notNull(),
  },
  (table) => ({
    // Indexes for efficient lookups
    sessionIdx: index('messages_session_id_idx').on(table.session_id),
    taskIdx: index('messages_task_id_idx').on(table.task_id),
    sessionMessageIdIdx: index('messages_session_message_id_idx').on(
      table.session_id,
      table.message_id
    ),
    taskMessageIdIdx: index('messages_task_message_id_idx').on(table.task_id, table.message_id),
    sessionIndexIdx: index('messages_session_index_idx').on(table.session_id, table.index),
    timestampIdx: index('messages_timestamp_idx').on(table.timestamp),
    sessionTimestampIdx: index('messages_session_timestamp_idx').on(
      table.session_id,
      table.timestamp
    ),
  })
);

/**
 * Schedules table - UI-managed scheduled prompts owned directly by a user.
 * A nullable Agent target determines whether each run is an Agent Session or
 * a personality-free standalone Session.
 *
 * Enums (`timezone_mode`) are validated at the app layer (no DB CHECK
 * constraint) per context/guides/creating-database-migrations.md.
 */
export const schedules = sqliteTable(
  'schedules',
  {
    schedule_id: text('schedule_id', { length: 36 }).primaryKey(),
    agent_id: text('agent_id', { length: 36 }).references(() => agents.agent_id, {
      onDelete: 'cascade',
    }),

    name: text('name').notNull(),
    description: text('description'),
    cron_expression: text('cron_expression').notNull(),
    timezone_mode: text('timezone_mode', { enum: ['local', 'utc'] })
      .notNull()
      .default('local'),
    timezone: text('timezone'), // IANA, required when timezone_mode='local'

    prompt: text('prompt').notNull(), // Handlebars template

    // jsonb on PG; stores the selected tool runtime configuration.
    agentic_tool_config: t.json<unknown>('agentic_tool_config').notNull(),
    agentic_tool_preset_id: text('agentic_tool_preset_id', { length: 36 }).references(
      (): AnySQLiteColumn => agenticToolPresets.preset_id,
      { onDelete: 'restrict' }
    ),
    mcp_server_ids: t.json<string[]>('mcp_server_ids'),

    enabled: t.bool('enabled').notNull().default(true),
    allow_concurrent_runs: t.bool('allow_concurrent_runs').notNull().default(false),
    retention: integer('retention').notNull().default(5), // 0 = keep all

    last_run_at: integer('last_run_at'), // Unix timestamp (ms)
    last_run_session_id: text('last_run_session_id', { length: 36 }).references(
      () => sessions.session_id,
      { onDelete: 'set null' }
    ),
    next_run_at: integer('next_run_at'), // Unix timestamp (ms), denormalized for scheduler

    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    created_by: text('created_by', { length: 36 })
      .notNull()
      .references(() => users.user_id),
  },
  (table) => ({
    // Scheduler hot path: WHERE enabled = true AND next_run_at <= ?
    enabledNextRunIdx: index('schedules_enabled_next_run_idx').on(table.enabled, table.next_run_at),
    agenticToolPresetIdx: index('schedules_agentic_tool_preset_idx').on(
      table.agentic_tool_preset_id
    ),
    agentIdx: index('schedules_agent_idx').on(table.agent_id),
    createdByIdx: index('schedules_created_by_idx').on(table.created_by),
  })
);

/**
 * Users table - Authentication and authorization.
 *
 * Always present. Authentication is required for every endpoint; on first
 * daemon start with an empty users table, a default admin is auto-created
 * (see `bootstrapFirstRunAdmin`).
 */
export const users = sqliteTable(
  'users',
  {
    // Primary identity
    user_id: text('user_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // Materialized for auth lookups
    username: text('username').unique().notNull(),
    password: text('password').notNull(), // bcrypt hashed

    // Basic profile (materialized for display)
    name: text('name'),
    emoji: text('emoji'),
    role: text('role', {
      enum: ['superadmin', 'admin', 'member', 'viewer'], // 'owner' is deprecated alias for 'superadmin'
    })
      .notNull()
      .default('member'),

    // Opaque execution-home key (optional, app-enforced tenant uniqueness)
    unix_username: text('unix_username'),

    // Absolute host home dir used as the per-user sandbox overlay SOURCE under
    // unix_user_mode: sandbox (home_mode: per_user). Null → canonical store
    // <data_home>/tenants/<tenant>/homes/<user_id>. See types/user.ts.
    filesystem_home: text('filesystem_home'),

    // Onboarding state
    onboarding_completed: t.bool('onboarding_completed').notNull().default(false),

    // Force password change flag (admin-settable, auto-cleared on password change)
    must_change_password: t.bool('must_change_password').notNull().default(false),

    // Auth invalidation marker. Password changes set this timestamp so any
    // previously issued browser access or refresh token is rejected.
    tokens_valid_after: t.timestamp('tokens_valid_after'),

    // JSON blob for profile/preferences
    data: t
      .json<unknown>('data')
      .$type<{
        avatar?: string;
        avatar_url?: string;
        avatar_source?: string;
        avatar_source_id?: string;
        avatar_synced_at?: string;
        preferences?: Record<string, unknown>;
        // Per-tool credentials and auth-adjacent config.
        //
        // Each entry is keyed by AgenticToolName and holds env-var-named fields
        // (e.g. `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`). All values are
        // encrypted at rest (AES-256-GCM, hex-encoded) for shape uniformity —
        // the runtime decrypts on read; the UI controls plain-vs-password
        // rendering based on per-field config.
        //
        // Field name = env var name. The session executor exports these as
        // env vars to the SDK CLI, scoped to the session's agentic_tool
        // (i.e. claude-code's keys never reach codex sessions).
        //
        // See `context/concepts/agentic-tool-config.md` (TODO).
        agentic_tools?: {
          'claude-code'?: {
            ANTHROPIC_API_KEY?: string;
            CLAUDE_CODE_OAUTH_TOKEN?: string;
            ANTHROPIC_AUTH_TOKEN?: string;
            ANTHROPIC_BASE_URL?: string;
          };
          codex?: {
            OPENAI_API_KEY?: string;
            OPENAI_BASE_URL?: string;
          };
          gemini?: {
            GEMINI_API_KEY?: string;
          };
          copilot?: {
            COPILOT_GITHUB_TOKEN?: string;
          };
          opencode?: Record<string, never>;
        };
        agentic_auth_methods?: import('../types/user').AgenticAuthMethods;
        // Encrypted environment variables with global or Session scope.
        env_vars?: Record<
          string,
          {
            value_encrypted: string;
            scope: 'global' | 'session';
            extra_config?: Record<string, unknown> | null;
          }
        >;
        // Default agentic tool configuration (prepopulates session creation forms)
        default_agentic_config?: {
          'claude-code'?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
              advisorModel?: string;
            };
            permissionMode?: string;
          };
          codex?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
              serviceTier?: 'default' | 'fast';
            };
            permissionMode?: string;
            codexSandboxMode?: string;
            codexApprovalPolicy?: string;
            codexNetworkAccess?: boolean;
          };
          gemini?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
            };
            permissionMode?: string;
          };
          opencode?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
            };
            permissionMode?: string;
            serverUrl?: string;
          };
          copilot?: {
            modelConfig?: {
              mode?: 'alias' | 'exact';
              model?: string;
              effort?: EffortLevel;
            };
            permissionMode?: string;
          };
        };
        default_mcp_server_ids?: string[];
        default_agentic_selection?: import('../types/user').UserAgenticDefaultSelections;
      }>()
      .notNull(),
  },
  (table) => ({
    usernameIdx: index('users_username_idx').on(table.username),
  })
);

/**
 * Groups - admin-managed user collections for sharing current resources.
 */
export const groups = sqliteTable(
  'groups',
  {
    group_id: text('group_id', { length: 36 }).primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    archived: t.bool('archived').notNull().default(false),
    created_by: text('created_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    slugIdx: uniqueIndex('groups_slug_idx').on(table.slug),
    archivedIdx: index('groups_archived_idx').on(table.archived),
  })
);

/**
 * Group Memberships - many-to-many users ↔ groups.
 */
export const groupMemberships = sqliteTable(
  'group_memberships',
  {
    group_id: text('group_id', { length: 36 })
      .notNull()
      .references(() => groups.group_id, { onDelete: 'cascade' }),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    added_by: text('added_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.group_id, table.user_id] }),
    userIdx: index('group_memberships_user_idx').on(table.user_id),
  })
);

/**
 * App Variables - daemon-owned application settings and secrets.
 *
 * Values can be plaintext (`value_text`) for non-secret JSON/string settings or
 * encrypted (`value_encrypted`) with DISCO_MASTER_SECRET for daemon service
 * credentials such as external integration API keys.
 */
export const appVariables = sqliteTable(
  'app_variables',
  {
    variable_id: text('variable_id', { length: 36 }).primaryKey(),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value_text: text('value_text'),
    value_encrypted: text('value_encrypted'),
    is_encrypted: t.bool('is_encrypted').notNull().default(false),
    content_type: text('content_type').notNull().default('text/plain'),
    metadata: t.json<Record<string, unknown>>('metadata'),
    updated_by: text('updated_by', { length: 36 }).references(() => users.user_id, {
      onDelete: 'set null',
    }),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    namespaceKeyIdx: uniqueIndex('app_variables_namespace_key_idx').on(table.namespace, table.key),
    namespaceIdx: index('app_variables_namespace_idx').on(table.namespace),
  })
);

/** Tenant-owned, live agentic-tool runtime configuration presets. */
export const agenticToolPresets = sqliteTable(
  'agentic_tool_presets',
  {
    preset_id: text('preset_id').primaryKey(),
    tool: text('tool', {
      enum: ['claude-code', 'codex', 'gemini', 'copilot', 'cursor', 'opencode'],
    }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    is_default: t.bool('is_default').notNull().default(false),
    configuration: t.json<unknown>('configuration').notNull(),
    created_by: text('created_by').notNull(),
    updated_by: text('updated_by').notNull(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
  },
  (table) => ({
    toolNameUnique: uniqueIndex('agentic_tool_presets_tool_name_unique').on(table.tool, table.name),
    tenantToolDefaultUnique: uniqueIndex('agentic_tool_presets_tenant_tool_default_unique')
      .on(table.tool)
      .where(sql`${table.is_default} = 1`),
  })
);

/**
 * User API Keys table - Personal API keys for programmatic access
 *
 * Stores bcrypt-hashed API keys with a prefix for identification.
 * The raw key is shown once at creation time and never stored.
 */
export const userApiKeys = sqliteTable(
  'user_api_keys',
  {
    id: text('id', { length: 36 }).primaryKey(),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(), // first 12 chars: 'disco_sk_XXXX' for identification
    key_hash: text('key_hash').notNull(), // bcrypt hash of full key
    created_at: t.timestamp('created_at').notNull(),
    last_used_at: t.timestamp('last_used_at'),
  },
  (table) => ({
    userIdx: index('user_api_keys_user_idx').on(table.user_id),
    prefixIdx: index('user_api_keys_prefix_idx').on(table.prefix),
  })
);

/**
 * MCP Servers table - MCP server configurations
 *
 * Stores MCP (Model Context Protocol) server configurations that can be attached to sessions.
 * Supports stdio, HTTP, and SSE transports with scoped access control.
 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    // Primary identity
    mcp_server_id: text('mcp_server_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),

    // Materialized for filtering
    name: text('name').notNull(), // e.g., "filesystem", "sentry"
    transport: text('transport', {
      enum: ['stdio', 'http', 'sse'],
    }).notNull(),
    scope: text('scope', {
      enum: ['global', 'session'],
    }).notNull(),
    enabled: t.bool('enabled').notNull().default(true),

    // Owner of a private server, NULL for a shared one. Applies to both
    // scopes: a private server is only ever resolved into, and attachable to,
    // sessions its owner created.
    owner_user_id: text('owner_user_id', { length: 36 }),

    // Source tracking (materialized for queries)
    source: text('source', {
      enum: ['user', 'imported', 'disco', 'catalog'],
    }).notNull(),

    // JSON blob for configuration and capabilities
    data: t
      .json<unknown>('data')
      .$type<{
        display_name?: string;
        description?: string;
        import_path?: string;
        // Catalog entry this server was installed from, by the registry name
        // that outlives the entry row.
        catalog_entry_name?: string;

        // Transport config
        command?: string;
        args?: string[];
        url?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;

        // Authentication config (for HTTP/SSE transports)
        auth?: {
          type: 'none' | 'bearer' | 'jwt' | 'oauth';
          // Bearer token
          token?: string;
          // JWT config
          api_url?: string;
          api_token?: string;
          api_secret?: string;
          // OAuth 2.0 config
          oauth_token_url?: string;
          oauth_client_id?: string;
          oauth_client_secret?: string;
          oauth_scope?: string;
          oauth_grant_type?: string;
          // OAuth 2.1 runtime tokens (obtained via browser flow)
          oauth_access_token?: string;
          oauth_token_expires_at?: number; // Unix timestamp in milliseconds
          oauth_refresh_token?: string;
          // OAuth mode: 'per_user' stores tokens per-user, 'shared' uses single token for all users
          oauth_mode?: 'per_user' | 'shared';
          // Common
          insecure?: boolean;
        };

        // Discovered capabilities
        tools?: Array<{
          name: string;
          description: string;
          input_schema?: Record<string, unknown>; // Optional - not all MCP servers provide schemas
        }>;
        resources?: Array<{
          uri: string;
          name: string;
          mimeType?: string;
        }>;
        prompts?: Array<{
          name: string;
          description: string;
          arguments?: Array<{
            name: string;
            description: string;
            required?: boolean;
          }>;
        }>;

        // Tool permissions configuration
        tool_permissions?: Record<string, 'ask' | 'allow' | 'deny'>;
      }>()
      .notNull(),
  },
  (table) => ({
    nameIdx: index('mcp_servers_name_idx').on(table.name),
    scopeIdx: index('mcp_servers_scope_idx').on(table.scope),
    ownerIdx: index('mcp_servers_owner_idx').on(table.owner_user_id),
    enabledIdx: index('mcp_servers_enabled_idx').on(table.enabled),
  })
);

/**
 * Session-MCP Servers relationship table
 *
 * Many-to-many relationship between sessions and MCP servers.
 * Tracks which MCP servers are enabled for each session.
 */
export const sessionMcpServers = sqliteTable(
  'session_mcp_servers',
  {
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    mcp_server_id: text('mcp_server_id', { length: 36 })
      .notNull()
      .references(() => mcpServers.mcp_server_id, { onDelete: 'cascade' }),
    enabled: t.bool('enabled').notNull().default(true),
    added_at: t.timestamp('added_at').notNull(),
  },
  (table) => ({
    // Idempotency guard for recovery and concurrent attachment.
    pk: uniqueIndex('session_mcp_servers_pk').on(table.session_id, table.mcp_server_id),
    // Indexes for queries
    sessionIdx: index('session_mcp_servers_session_idx').on(table.session_id),
    serverIdx: index('session_mcp_servers_server_idx').on(table.mcp_server_id),
    enabledIdx: index('session_mcp_servers_enabled_idx').on(table.session_id, table.enabled),
  })
);

/**
 * MCP OAuth Tokens table - OAuth 2.1 tokens for MCP servers
 *
 * Holds BOTH per-user and shared-mode tokens:
 *   - `user_id` set  → per-user token (oauth_mode: 'per_user')
 *   - `user_id` NULL → shared token for this MCP server (oauth_mode: 'shared')
 *
 * `oauth_client_id`/`oauth_client_secret` are co-located because the
 * refresh_token is bound to the client credentials that were used when
 * it was issued (often via RFC 7591 Dynamic Client Registration, which
 * generates fresh per-grant credentials on each daemon restart). Storing
 * them alongside the refresh_token keeps the refresh path correct even
 * if the server-level DCR cache is rebuilt.
 */
export const userMcpOauthTokens = sqliteTable(
  'user_mcp_oauth_tokens',
  {
    // NULL = shared-mode token (one per mcp_server_id)
    user_id: text('user_id', { length: 36 }).references(() => users.user_id, {
      onDelete: 'cascade',
    }),
    mcp_server_id: text('mcp_server_id', { length: 36 })
      .notNull()
      .references(() => mcpServers.mcp_server_id, { onDelete: 'cascade' }),
    oauth_access_token: text('oauth_access_token').notNull(),
    oauth_token_expires_at: t.timestamp('oauth_token_expires_at'), // Unix timestamp in milliseconds
    oauth_refresh_token: text('oauth_refresh_token'),
    // DCR / registered client credentials this grant was issued under.
    // Must be preserved across refreshes.
    oauth_client_id: text('oauth_client_id'),
    oauth_client_secret: text('oauth_client_secret'),
    grant_generation: integer('grant_generation').notNull().default(0),
    grant_binding_version: integer('grant_binding_version'),
    grant_binding_fingerprint: text('grant_binding_fingerprint', { length: 64 }),
    oauth_metadata_uri: text('oauth_metadata_uri'),
    oauth_resource_uri: text('oauth_resource_uri'),
    oauth_issuer: text('oauth_issuer'),
    oauth_authorization_endpoint: text('oauth_authorization_endpoint'),
    oauth_token_endpoint: text('oauth_token_endpoint'),
    oauth_redirect_uri: text('oauth_redirect_uri'),
    refresh_status: text('refresh_status').notNull().default('idle'),
    refresh_generation: integer('refresh_generation').notNull().default(0),
    refresh_success_generation: integer('refresh_success_generation').notNull().default(0),
    refresh_claim_id: text('refresh_claim_id', { length: 36 }),
    refresh_claimed_at: t.timestamp('refresh_claimed_at'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at'),
  },
  (table) => ({
    // Composite lookup indexes. Uniqueness enforced via partial unique indexes
    // created in the migration (one for per-user rows, one for the shared row).
    pk: index('user_mcp_oauth_tokens_pk').on(table.user_id, table.mcp_server_id),
    userIdx: index('user_mcp_oauth_tokens_user_idx').on(table.user_id),
    serverIdx: index('user_mcp_oauth_tokens_server_idx').on(table.mcp_server_id),
  })
);

/**
 * Schema mirror for PostgreSQL MCP OAuth pending-flow authority.
 *
 * Standalone SQLite deliberately keeps its existing process-local flow state;
 * this table is unused at runtime and exists for cross-dialect compatibility.
 */
export const mcpOauthPendingFlows = sqliteTable(
  'mcp_oauth_pending_flows',
  {
    attempt_id: text('attempt_id', { length: 36 }).primaryKey(),
    state_hash: text('state_hash', { length: 64 }).notNull(),
    user_id: text('user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),
    mcp_server_id: text('mcp_server_id', { length: 36 })
      .notNull()
      .references(() => mcpServers.mcp_server_id, { onDelete: 'cascade' }),
    oauth_mode: text('oauth_mode', { enum: ['per_user', 'shared'] }).notNull(),
    subject_user_id: text('subject_user_id', { length: 36 }),
    grant_generation: integer('grant_generation').notNull(),
    config_fingerprint_version: integer('config_fingerprint_version').notNull(),
    config_fingerprint: text('config_fingerprint', { length: 64 }).notNull(),
    envelope_version: integer('envelope_version').notNull(),
    is_current: integer('is_current', { mode: 'boolean' }).notNull().default(true),
    status: text('status', {
      enum: ['pending', 'exchanging', 'succeeded', 'failed', 'ambiguous', 'expired'],
    })
      .notNull()
      .default('pending'),
    sealed_material: text('sealed_material'),
    exchange_claim_id: text('exchange_claim_id', { length: 36 }),
    failure_code: text('failure_code'),
    created_at: t.timestamp('created_at').notNull(),
    updated_at: t.timestamp('updated_at').notNull(),
    expires_at: t.timestamp('expires_at').notNull(),
    exchange_started_at: t.timestamp('exchange_started_at'),
    finished_at: t.timestamp('finished_at'),
  },
  (table) => ({
    stateHashUnique: uniqueIndex('mcp_oauth_pending_flows_state_hash_unique').on(table.state_hash),
    userIdx: index('mcp_oauth_pending_flows_user_idx').on(table.user_id, table.created_at),
    serverIdx: index('mcp_oauth_pending_flows_server_idx').on(table.mcp_server_id),
    grantIdx: index('mcp_oauth_pending_flows_grant_idx').on(
      table.mcp_server_id,
      table.oauth_mode,
      table.subject_user_id,
      table.grant_generation
    ),
    maintenanceIdx: index('mcp_oauth_pending_flows_maintenance_idx').on(
      table.status,
      table.expires_at,
      table.exchange_started_at,
      table.finished_at
    ),
  })
);

/**
 * Upload metadata control plane. Bytes live in the configured storage adapter.
 * Session/Agent identifiers intentionally have no restrictive FK so upload
 * cleanup and historical attachment snapshots remain independent.
 */
export const uploads = sqliteTable(
  'uploads',
  {
    upload_ref: text('upload_ref').primaryKey(),
    created_by: text('created_by', { length: 36 }).notNull(),
    session_id: text('session_id', { length: 36 }).notNull(),
    agent_id: text('agent_id', { length: 36 }),
    storage_key: text('storage_key').notNull(),
    original_name: text('original_name').notNull(),
    display_name: text('display_name').notNull(),
    content_type: text('content_type').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    checksum: text('checksum'),
    status: text('status', { enum: ['pending', 'active', 'deleting'] })
      .notNull()
      .default('active'),
    provenance: text('provenance', {
      enum: ['browser', 'gateway-slack', 'mcp-slack'],
    }).notNull(),
    created_at: t.timestamp('created_at').notNull(),
    expires_at: t.timestamp('expires_at'),
  },
  (table) => ({
    ownerIdx: index('uploads_owner_idx').on(table.created_by),
    sessionIdx: index('uploads_session_idx').on(table.session_id),
    expiryIdx: index('uploads_expiry_idx').on(table.expires_at),
  })
);

/**
 * Session Env Selections - Many-to-many between sessions and session-scope env vars.
 *
 * Records which of a user's scope='session' env vars are exposed to a given session
 * at spawn time. Global-scope vars are always included; session-scope vars only
 * appear in the session's effective env when a row in this table says so.
 *
 * Environment variables are keyed by name inside `users.data.env_vars`.
 * Rows are scoped implicitly through `session.created_by`.
 *
 * See `context/explorations/env-var-access.md`.
 */
export const sessionEnvSelections = sqliteTable(
  'session_env_selections',
  {
    session_id: text('session_id', { length: 36 })
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    env_var_name: text('env_var_name').notNull(),
    created_at: t.timestamp('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.session_id, table.env_var_name] }),
    sessionIdx: index('session_env_selections_session_idx').on(table.session_id),
  })
);

/**
 * Type exports for use with Drizzle ORM
 */
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type SessionRelationshipRow = typeof sessionRelationships.$inferSelect;
export type SessionRelationshipInsert = typeof sessionRelationships.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type TaskUsageLedgerRow = typeof taskUsageLedger.$inferSelect;
export type TaskUsageLedgerInsert = typeof taskUsageLedger.$inferInsert;
export type ExecutorSessionTokenAuthorityRow = typeof executorSessionTokenAuthorities.$inferSelect;
export type ExecutorSessionTokenAuthorityInsert =
  typeof executorSessionTokenAuthorities.$inferInsert;
export type GitHubInstallStateRow = typeof githubInstallStates.$inferSelect;
export type GitHubInstallStateInsert = typeof githubInstallStates.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
export type ScheduleRow = typeof schedules.$inferSelect;
export type ScheduleInsert = typeof schedules.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type AppVariableRow = typeof appVariables.$inferSelect;
export type AppVariableInsert = typeof appVariables.$inferInsert;
export type AgenticToolPresetRow = typeof agenticToolPresets.$inferSelect;
export type AgenticToolPresetInsert = typeof agenticToolPresets.$inferInsert;
export type GroupRow = typeof groups.$inferSelect;
export type GroupInsert = typeof groups.$inferInsert;
export type GroupMembershipRow = typeof groupMemberships.$inferSelect;
export type GroupMembershipInsert = typeof groupMemberships.$inferInsert;
export type MCPServerRow = typeof mcpServers.$inferSelect;
export type MCPServerInsert = typeof mcpServers.$inferInsert;
export type SessionMCPServerRow = typeof sessionMcpServers.$inferSelect;
export type SessionMCPServerInsert = typeof sessionMcpServers.$inferInsert;
export type SessionEnvSelectionRow = typeof sessionEnvSelections.$inferSelect;
export type SessionEnvSelectionInsert = typeof sessionEnvSelections.$inferInsert;
export type UserMCPOAuthTokenRow = typeof userMcpOauthTokens.$inferSelect;
export type UserMCPOAuthTokenInsert = typeof userMcpOauthTokens.$inferInsert;
export type MCPOAuthPendingFlowRow = typeof mcpOauthPendingFlows.$inferSelect;
export type MCPOAuthPendingFlowInsert = typeof mcpOauthPendingFlows.$inferInsert;
export type UploadRow = typeof uploads.$inferSelect;
export type UploadInsert = typeof uploads.$inferInsert;

/**
 * Drizzle Relations for Relational Queries
 *
 * These enable automatic JOINs for current Session relationships.
 */

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  agent: one(agents, {
    fields: [sessions.agent_id],
    references: [agents.agent_id],
  }),
  schedule: one(schedules, {
    fields: [sessions.schedule_id],
    references: [schedules.schedule_id],
  }),
  outboundRelationships: many(sessionRelationships, { relationName: 'relationshipSource' }),
  inboundRelationships: many(sessionRelationships, { relationName: 'relationshipTarget' }),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionRelationshipsRelations = relations(sessionRelationships, ({ one }) => ({
  sourceSession: one(sessions, {
    fields: [sessionRelationships.source_session_id],
    references: [sessions.session_id],
    relationName: 'relationshipSource',
  }),
  targetSession: one(sessions, {
    fields: [sessionRelationships.target_session_id],
    references: [sessions.session_id],
    relationName: 'relationshipTarget',
  }),
  callbackSession: one(sessions, {
    fields: [sessionRelationships.callback_session_id],
    references: [sessions.session_id],
  }),
}));

export const schedulesRelations = relations(schedules, ({ one, many }) => ({
  agent: one(agents, {
    fields: [schedules.agent_id],
    references: [agents.agent_id],
  }),
  sessions: many(sessions),
}));
