// src/types/session.ts

/**
 * Effort level controls how much reasoning a supported agent applies.
 * Runtime adapters map this shared value to their native effort option.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

import type {
  AgenticToolName,
  ClaudeCodePermissionMode,
  CodexApprovalPolicy,
  CodexPermissionMode,
  CodexSandboxMode,
  CursorPermissionMode,
  GeminiPermissionMode,
  OpenCodePermissionMode,
  PersistedAgenticToolName,
} from './agentic-tool';
import type { AgenticToolConfigurationReference } from './agentic-tool-preset';
import type { ContextFilePath } from './context';
import type { AgentID, SessionID, SessionRelationshipID, TaskID, UserID } from './id';
import type { ScheduleID } from './schedule';

export const SessionStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPING: 'stopping', // Stop requested, waiting for task to stop
  AWAITING_PERMISSION: 'awaiting_permission',
  AWAITING_INPUT: 'awaiting_input', // Legacy / pre-#1177: AskUserQuestion was disallowed at the SDK; new sessions never enter this state, kept for historical rows
  TIMED_OUT: 'timed_out', // Permission/input request timed out, executor exited — user must re-prompt
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

/**
 * Permission mode controls how agentic tools handle execution approvals
 *
 * This is a union of all native SDK permission modes. Each agent uses its own
 * subset - no mapping/translation needed at the executor level.
 *
 * Claude Code modes (Claude Agent SDK):
 * - default: Prompt for each tool use (most restrictive)
 * - acceptEdits: Auto-accept file edits, ask for other tools (recommended)
 * - bypassPermissions: Allow all operations without prompting
 * - plan: Plan mode (generate plan without executing)
 * - auto: Model classifier approves/denies prompts; unresolved ones fall through to Disco's UI
 * - dontAsk: Legacy mode for backward compatibility
 *
 * Gemini modes (Gemini CLI SDK - ApprovalMode):
 * - default: Prompt for each tool use (ApprovalMode.DEFAULT)
 * - autoEdit: Auto-approve file edits only (ApprovalMode.AUTO_EDIT)
 * - yolo: Auto-approve all operations (ApprovalMode.YOLO)
 *
 * Codex modes (OpenAI Codex SDK):
 * - ask: Require approval for every tool use (read-only/suggest mode)
 * - auto: Auto-approve safe operations, ask for dangerous ones (auto-edit mode)
 * - on-failure: Auto-approve all, ask only when commands fail
 * - allow-all: Auto-approve all operations (full-auto mode)
 */
export type PermissionMode =
  // Claude Code native modes
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  // Gemini native modes
  | 'autoEdit'
  | 'yolo'
  // Codex native modes
  | 'ask'
  | 'auto'
  | 'on-failure'
  | 'allow-all';

// Re-export permission types from agentic-tool for convenience
export type {
  ClaudeCodePermissionMode,
  CodexApprovalPolicy,
  CodexPermissionMode,
  CodexSandboxMode,
  CursorPermissionMode,
  GeminiPermissionMode,
  OpenCodePermissionMode,
};

/**
 * Get the default permission mode for a given agentic tool
 *
 * Per tool:
 * - Claude Code: 'auto' — the SDK's model classifier approves/denies each
 *   permission prompt; anything it doesn't confidently auto-resolve still
 *   falls through to Disco's permission UI via the executor's canUseTool hook
 *   (see sdk-handlers/base/permission-hooks.ts). MCP tool calls
 *   for the built-in `disco` server and any attached MCP servers are
 *   auto-approved by that same hook, so MCP-heavy sessions don't
 *   death-by-modal. Users can flip a running session to `acceptEdits` or
 *   `bypassPermissions` mid-flight from the session UI.
 * - Codex: 'allow-all' — maps to sandbox `workspace-write` + approval
 *   `never` + network-on. Codex's MCP auto-approve is wired through
 *   `default_tools_approval_mode = "approve"` on each server config
 *   (see prompt-service.ts buildMcpServersConfig), so Disco self-calls
 *   don't get silently cancelled by the elicitation prompt. Workspace
 *   sandbox still constrains shell exec.
 * - Gemini: 'autoEdit' (unchanged — pending separate audit)
 * - OpenCode: 'autoEdit' (unchanged — pending separate audit)
 * - Cursor: 'bypassPermissions' — scaffolded as autonomous until the SDK
 *   exposes/Disco wires a permission callback.
 *
 * Users / parent sessions / per-session overrides still trump these
 * defaults via resolvePermissionConfig.
 */
export function getDefaultPermissionMode(agenticTool: AgenticToolName): PermissionMode {
  switch (agenticTool) {
    case 'gemini':
      return 'autoEdit'; // Native Gemini SDK mode
    case 'codex':
      return 'allow-all'; // Maps to Codex sandbox=workspace-write + approval=never
    case 'opencode':
      return 'autoEdit'; // OpenCode auto-approves, similar to Gemini
    case 'copilot':
      return 'acceptEdits'; // Copilot uses same semantics as Claude Code
    case 'cursor':
      return 'bypassPermissions'; // Cursor SDK is experimental/autonomous until permission callbacks exist
    default:
      return 'auto'; // Claude Code: model-classifier permissions
  }
}

export interface Session {
  /** Unique session identifier (UUIDv7) */
  session_id: SessionID;

  /** Which agentic coding tool is running this session (Claude Code, Codex, Gemini) */
  agentic_tool: PersistedAgenticToolName;
  /** Live tenant preset reference. When set, atomic runtime fields are read-only. */
  agentic_tool_preset_id?: import('./agentic-tool-preset').AgenticToolPresetID | null;
  /** Agentic tool/CLI version */
  agentic_tool_version?: string;
  /** SDK session ID for maintaining conversation history (Claude Agent SDK, Codex SDK, etc.) */
  sdk_session_id?: string;
  /** MCP authentication token for Disco self-access */
  mcp_token?: string;
  status: SessionStatus;
  created_at: string;
  last_updated: string;

  /** User ID of the user who created this session */
  created_by: string;

  /** Persistent Agent identity. Null/undefined means a standalone conversation. */
  agent_id?: AgentID | null;

  /** Exact Session working directory, stamped at creation time. */
  working_directory?: string | null;

  /**
   * Immutable execution-home key for this session.
   *
   * Set once at session creation time from the creator's unix_username.
   * IMMUTABLE - never changes, even if the user's unix_username changes.
   *
   * Why immutable?
   * - SDK sessions (Claude Code, Codex) store data in user home directories
   * - Changing it would break access to existing SDK session state
   * - If the delegated home key changes or disappears, resumable state may be unreachable
   *
   * Before prompting, the creator's current key is checked against the stamp.
   */
  unix_username: string | null;

  /**
   * External/user-facing URL for viewing this session in the UI.
   *
   * Computed property added by the repository layer.
   * Format: `{baseUrl}/ui/s/{sessionShortId}/`
   * Visiting the URL opens the conversation panel directly.
   */
  url: string | null;

  // Context (context file paths relative to context/)
  contextFiles: ContextFilePath[];

  // Genealogy
  genealogy: {
    /** Session this was forked from (sibling relationship) */
    forked_from_session_id?: SessionID;
    /** Task where fork occurred */
    fork_point_task_id?: TaskID;
    /** Message index where fork occurred (count of parent's messages at fork time) */
    fork_point_message_index?: number;
    /** Parent session that spawned this one (child relationship) */
    parent_session_id?: SessionID;
    /** Task where spawn occurred */
    spawn_point_task_id?: TaskID;
    /** Message index where spawn occurred (count of parent's messages at spawn time) */
    spawn_point_message_index?: number;
    /** Child sessions spawned from this session */
    children: SessionID[];
  };

  // Tasks
  /** Task IDs in this session */
  tasks: TaskID[];

  // UI metadata
  /** Session title (user-provided or auto-generated) */
  title?: string;
  /** Session description (legacy field, may contain first prompt) */
  description?: string;

  // Permission config (session-level permission settings)
  permission_config?: {
    /** Permission mode for agent tool execution (Claude/Gemini unified mode)
     *  Tool-level permissions are handled by SDK via settings.json files */
    mode?: PermissionMode;
    /** Codex-specific dual permission config (sandboxMode + approvalPolicy + networkAccess) */
    codex?: {
      /** Sandbox mode controls WHERE Codex can write (filesystem boundaries) */
      sandboxMode: CodexSandboxMode;
      /** Approval policy controls WHETHER Codex asks before executing */
      approvalPolicy: CodexApprovalPolicy;
      /** Network access controls whether outbound HTTP/HTTPS requests are allowed (workspace-write only) */
      networkAccess?: boolean;
    };
  } | null;

  // Model configuration (session-level model selection)
  model_config?: {
    /** Model selection mode: alias (e.g., 'claude-sonnet-4-5-latest') or exact (e.g., 'claude-sonnet-4-5-20250929') */
    mode: 'alias' | 'exact';
    /** Model identifier (alias or exact ID) */
    model: string;
    /** When this config was last updated */
    updated_at: string;
    /** Optional user notes about why this model was selected */
    notes?: string;
    /** Optional session override for reasoning depth; unset delegates to the runtime default. */
    effort?: EffortLevel;
    /**
     * Codex request processing tier. `default` is the normal service tier;
     * `fast` opts the session into Codex Fast mode. This is independent from
     * reasoning effort.
     */
    serviceTier?: 'default' | 'fast';
    /** Claude Code advisor model (e.g., 'opus', 'sonnet', 'fable'); unset means no session override */
    advisorModel?: string;
    /**
     * Provider ID for OpenCode sessions (e.g., 'openai', 'anthropic', 'opencode')
     * Used in combination with model to specify which provider's API to use
     * Only applicable when agentic_tool='opencode'
     */
    provider?: string;
  } | null;

  /** Historical billing metadata written by the removed integration. */
  billing_mode?: 'subscription' | 'api-key' | 'unknown';

  // Custom context for Handlebars templates
  /**
   * User-defined JSON context for Handlebars templates in zone triggers
   * Example: { "teamName": "Backend", "sprintNumber": 42 }
   * Access in templates: {{ session.context.teamName }}
   */
  custom_context?: Record<string, unknown> & {
    /**
     * Scheduled run metadata (populated by scheduler)
     *
     * Present only if this session was created by the scheduler.
     * Contains execution details and config snapshot at run time.
     */
    scheduled_run?: ScheduledRunMetadata;
  };

  // ===== Context Window Tracking =====

  /**
   * Current context window usage (cumulative tokens in context)
   *
   * Calculated as: input_tokens + cache_read_tokens + cache_creation_tokens
   * from the most recent task with usage data.
   *
   * Based on algorithm from: https://codelynx.dev/posts/calculate-claude-code-context
   *
   * Note: Each API turn returns cumulative totals, so we only need the latest task's usage.
   * We do NOT sum across tasks (that would double-count cached content).
   */
  current_context_usage?: number;

  /**
   * Context window limit for this session's model
   *
   * Examples:
   * - Claude Sonnet: 200,000 tokens
   * - Claude Opus: 200,000 tokens
   * - Extended context models: varies
   */
  context_window_limit?: number;

  /**
   * Timestamp when context was last updated (ISO 8601)
   */
  last_context_update_at?: string;

  // ===== Scheduler Tracking =====

  /**
   * Authoritative run ID for scheduled sessions (Unix timestamp in ms)
   *
   * Stores the exact scheduled time (rounded to minute), NOT when session was created.
   * Used for deduplication and retention cleanup.
   *
   * Example: Midnight run scheduled for 2025-11-03 00:00:00 UTC
   * Even if triggered at 00:00:32, we store 00:00:00 (1730592000000)
   *
   * This becomes the unique run identifier to prevent duplicate scheduling.
   */
  scheduled_run_at?: number;

  /**
   * Whether this session was created by the scheduler
   *
   * Materialized for UI filtering (show clock icon) and analytics.
   * True = created by scheduler, False = created manually by user
   */
  is_scheduled: boolean;

  /**
   * First-class schedule this session was spawned from (if any).
   *
   * Nullable: null for ad-hoc sessions. `ON DELETE SET NULL` so when a
   * schedule is removed, its sessions become orphaned runs rather
   * than cascading deletions.
   *
   * Use this as the canonical link to a run's schedule. `is_scheduled`
   * plus `scheduled_run_at` form the durable scheduler occurrence marker.
   */
  schedule_id?: ScheduleID;

  /**
   * Whether this session is ready to receive a new prompt
   *
   * Set to true when a task completes successfully, indicating the agent is ready for more work.
   * Cleared when the user opens the conversation drawer (acknowledging completion).
   * Used to highlight conversations that need attention.
   */
  ready_for_prompt: boolean;

  // ===== Callback Configuration =====

  /**
   * Callback configuration for child session completion notifications
   *
   * When a child session (spawned via subsession) completes its task,
   * Disco can automatically notify the parent session with relevant context.
   *
   * Default behavior: Callbacks enabled with default template.
   */
  callback_config?: {
    /** Enable/disable child completion callbacks (default: true for spawn, false for create) */
    enabled?: boolean;
    /** Custom Handlebars template for callback messages */
    template?: string;
    /** Whether to include last assistant message content inline (default: true) */
    include_last_message?: boolean;
    /** Whether to include original spawn prompt in callback (default: false) */
    include_original_prompt?: boolean;
    /**
     * Session ID to notify on completion (for remote session callbacks)
     *
     * When set, completion callbacks are sent to this session instead of
     * (or in addition to) the genealogy parent. This enables cross-branch
     * callbacks where a session creates another session on a different branch
     * and wants to be notified when it completes.
     *
     * Defaults to the creating session's ID when enableCallback is true
     * in disco_sessions_create.
     */
    callback_session_id?: SessionID;
    /**
     * User ID of the person who set up this callback.
     *
     * Used as queued_by_user_id when the callback is delivered, so the
     * resulting task is attributed to the callback setter, not the target
     * session owner. Execution still uses the target session's home and credentials.
     */
    callback_created_by?: string;
    /**
     * Callback firing mode:
     * - "persistent": Fire on every completion until disabled (default when omitted)
     * - "once": Fire callback on first completion, then auto-disable
     */
    callback_mode?: 'once' | 'persistent';
  };

  // ===== Fork Origin =====

  /**
   * Tracks how this session was created via fork:
   * - "btw": Ephemeral fork created via sessions.prompt mode:"btw" or UI btw button
   *
   * Undefined for regular forks, spawned sessions, or directly created sessions.
   * Sessions with fork_origin:"btw" are auto-archived after task completion.
   */
  fork_origin?: 'btw';

  // ===== Archive State =====

  /**
   * Whether this session is archived (soft deleted)
   *
   * Archived sessions are hidden from the normal conversation list while
   * preserving their transcript and usage history.
   */
  archived: boolean;

  /**
   * Reason for archiving
   *
   * - 'manual': User manually archived this session
   * - 'parent_archived': Cascaded from parent session being manually archived
   * - 'btw_completed': Ephemeral btw fork auto-archived after task completion
   */
  archived_reason?: 'manual' | 'parent_archived' | 'btw_completed';

  /**
   * Durable non-genealogy relationships involving this session.
   *
   * These are separate from genealogy.parent_session_id/forked_from_session_id.
   * For example, one Session can create another without making that operation
   * part of the canonical parent/child genealogy.
   */
  remote_relationships?: {
    as_source?: SessionRelationship[];
    as_target?: SessionRelationship[];
  };
}

/** Session data accepted before defaults and configuration references are materialized. */
export type CreateSessionInput = Omit<
  Partial<Session>,
  'agentic_tool' | 'agentic_tool_preset_id' | 'model_config'
> & {
  agentic_tool?: AgenticToolName;
  agentic_tool_preset_id?: AgenticToolConfigurationReference | null;
  model_config?: Partial<NonNullable<Session['model_config']>> | null;
};

/** Session patch semantics: omit/undefined preserves, string sets, null clears. */
export type SessionUpdate = Omit<Partial<Session>, 'sdk_session_id'> & {
  sdk_session_id?: string | null;
};

/**
 * Minimal persisted session state needed to decide whether a new task can
 * start immediately.
 *
 * `ready_for_prompt` is intentionally not equivalent to promptability: the UI
 * also uses it as an attention/acknowledgement flag (for example timed-out
 * permission requests can set it true). Use this helper instead of checking
 * either field directly at task-execution boundaries.
 */
export type SessionPromptState = Pick<Session, 'status' | 'ready_for_prompt'>;

export type PromptableSessionState =
  | { status: typeof SessionStatus.IDLE; ready_for_prompt: boolean }
  | {
      status: typeof SessionStatus.FAILED | typeof SessionStatus.TIMED_OUT;
      ready_for_prompt: true;
    };

export function sessionCanStartTask(status: Session['status'], readyForPrompt?: boolean): boolean {
  return (
    status === SessionStatus.IDLE ||
    ((status === SessionStatus.FAILED || status === SessionStatus.TIMED_OUT) &&
      readyForPrompt === true)
  );
}

export function isSessionPromptable<T extends SessionPromptState>(
  session: T
): session is T & PromptableSessionState {
  return sessionCanStartTask(session.status, session.ready_for_prompt);
}

export const EXECUTING_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  SessionStatus.RUNNING,
  SessionStatus.STOPPING,
  SessionStatus.AWAITING_PERMISSION,
  SessionStatus.AWAITING_INPUT,
]);

export type SessionExecutionState = Pick<Session, 'status'>;

export function isSessionExecuting(session: SessionExecutionState): boolean {
  return EXECUTING_SESSION_STATUSES.has(session.status);
}

export type SessionRelationshipType = 'remote_create';

/**
 * Durable links between sessions that are not necessarily canonical
 * branch-local genealogy. Cross-branch delegation uses this instead of
 * genealogy.parent_session_id so the local session tree, recursive delete,
 * and fork/spawn semantics remain branch-local.
 */
export interface SessionRelationship {
  relationship_id: SessionRelationshipID;
  source_session_id: SessionID;
  target_session_id: SessionID;
  relationship_type: SessionRelationshipType;
  created_by: UserID;
  created_at: string;
  updated_at?: string | null;
  callback_enabled: boolean;
  callback_session_id?: SessionID | null;
  data?: Record<string, unknown> | null;
}

/**
 * Gateway source metadata denormalized into session.custom_context.gateway_source
 *
 * Present on sessions created via messaging platform integrations (Slack, Discord, GitHub).
 * Stamped at creation time and immutable — avoids N+1 lookups on the gatewayChannels table.
 */
export interface GatewaySource {
  channel_id: string;
  channel_name: string;
  channel_type: string;
  thread_id: string;
  /** GitHub-specific: "owner/repo" format */
  github_repo?: string;
  /** GitHub-specific: PR/issue number */
  github_issue_number?: number;
  /** GitHub-specific: only post last message */
  last_message_only?: boolean;
  /** Slack-specific provenance */
  slack_team_id?: string;
  slack_channel_id?: string;
  slack_channel_name?: string;
  slack_root_ts?: string;
  slack_trigger_ts?: string;
}

/**
 * Check if a session is a gateway session (created via Slack, Discord, GitHub, etc.)
 *
 * Gateway sessions have `custom_context.gateway_source` set at creation time.
 */
export function isGatewaySession(session: Pick<Session, 'custom_context'>): boolean {
  const ctx = session.custom_context as Record<string, unknown> | undefined;
  return !!ctx?.gateway_source;
}

/**
 * Get the gateway source from a session, or null if not a gateway session.
 */
export function getGatewaySource(session: Pick<Session, 'custom_context'>): GatewaySource | null {
  const ctx = session.custom_context as Record<string, unknown> | undefined;
  const source = ctx?.gateway_source;
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  if (!s.channel_id || !s.channel_name || !s.channel_type || !s.thread_id) return null;
  return source as GatewaySource;
}

/**
 * Session type categories matching UI rendering in BranchCard
 */
export type SessionType = 'scheduled' | 'agent';

/**
 * Determine the session type category.
 */
export function getSessionType(
  session: Pick<Session, 'custom_context' | 'is_scheduled'>
): SessionType {
  if (session.is_scheduled) return 'scheduled';
  return 'agent';
}

/**
 * Metadata for sessions created by the scheduler
 *
 * Stored in session.custom_context.scheduled_run
 */
export interface ScheduledRunMetadata {
  /**
   * Rendered prompt after Handlebars template substitution
   *
   * Example:
   * Template: "Check PR {{branch.pull_request_url}}"
   * Rendered: "Check PR https://github.com/org/repo/pull/42"
   */
  rendered_prompt: string;

  /**
   * Run number for this schedule (1st, 2nd, 3rd, ...)
   *
   * Increments with each run. Useful for tracking execution history.
   */
  run_index: number;

  /**
   * Stable identity of the occurrence's initial task. The scheduler persists
   * this with the session before creating the task so recovery can reconcile
   * the same prompt after a daemon crash without creating a second task.
   */
  initial_task_id?: TaskID;

  /**
   * Whether this run was triggered manually via execute-now (vs. cron tick).
   */
  triggered_manually?: boolean;

  /**
   * User ID that manually triggered this run. Only set when
   * `triggered_manually` is true.
   */
  triggered_by?: string;

  /**
   * Snapshot of schedule config at execution time.
   *
   * Preserves configuration even if the schedule is later modified or
   * deleted. Useful for debugging and understanding past runs.
   *
   * `schedule_id` was added when schedules became first-class — it lets
   * "open the schedule" links resolve even after the live schedule has
   * been deleted (the FK on `sessions.schedule_id` is SET NULL on
   * delete, but the snapshot still carries the ID for forensics).
   */
  schedule_config_snapshot?: {
    /** Optional first-class schedule ID; nullable for pre-#1253 rows. */
    schedule_id?: string;
    /** Cron expression that triggered this run */
    cron: string;
    /** Timezone for cron evaluation */
    timezone: string;
    /** Retention policy at run time */
    retention: number;
    /** Concurrency policy at run time (applies to both cron and manual paths) */
    allow_concurrent_runs?: boolean;
    /** Effective MCP attachment snapshot used by crash recovery. */
    mcp_server_ids?: string[];
  };
}

/**
 * Configuration for spawning a child session
 *
 * Provides fine-grained control over spawned session settings,
 * overriding defaults from parent session or user preferences.
 */
export interface SpawnConfig {
  /** Prompt for the spawned session (required) */
  prompt: string;

  /** Optional title for the spawned session */
  title?: string;

  /** Agentic tool to use (defaults to parent's tool) */
  agent?: AgenticToolName;

  /** Configuration source. Same-tool children inherit the parent's preset by default. */
  presetId?: AgenticToolConfigurationReference;

  /** Permission mode override (defaults based on config preset) */
  permissionMode?: PermissionMode;

  /** Model configuration override */
  modelConfig?: {
    mode?: 'alias' | 'exact';
    model?: string;
    effort?: EffortLevel;
    /** Codex processing tier; independent from reasoning effort. */
    serviceTier?: 'default' | 'fast';
    /** Claude Code advisor model (e.g., 'opus', 'sonnet', 'fable'); ignored for non-Claude tools. */
    advisorModel?: string;
    /**
     * Provider ID (OpenCode only, e.g. 'anthropic', 'openai', 'opencode').
     * Persisted on session.model_config.provider. Ignored for non-OpenCode tools.
     */
    provider?: string;
  };

  /** Codex sandbox mode (codex only) */
  codexSandboxMode?: CodexSandboxMode;

  /** Codex approval policy (codex only) */
  codexApprovalPolicy?: CodexApprovalPolicy;

  /** Codex network access (codex only) */
  codexNetworkAccess?: boolean;

  /** MCP server IDs to attach to spawned session */
  mcpServerIds?: string[];

  /** Enable callback to parent on completion (default: true) */
  enableCallback?: boolean;

  /** Callback mode: "once" (default) fires once then auto-disables, "persistent" fires every time */
  callbackMode?: 'once' | 'persistent';

  /** Include child's final result in callback (default: true) */
  includeLastMessage?: boolean;

  /** Include original spawn prompt in callback (default: false) */
  includeOriginalPrompt?: boolean;

  /** Extra instructions appended to spawn prompt */
  extraInstructions?: string;

  /** Task ID to link as spawn point */
  task_id?: string;

  /**
   * Session-scope env var names (from the spawner / session creator) to
   * expose in the spawned session's executor process. Only the session's
   * creator or an admin/superadmin can set this — otherwise it is ignored.
   */
  envVarNames?: string[];
}
