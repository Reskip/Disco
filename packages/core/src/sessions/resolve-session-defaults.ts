/**
 * Session creation config resolution (no parent — fresh sessions).
 *
 * Single source of truth for "given a user (and optional overrides), what
 * permission_config / model_config / mcp_server_ids should this new session
 * be stamped with?" Used by:
 * - `apps/disco-daemon/src/mcp/tools/sessions.ts`   (`disco_sessions_create`)
 * - `apps/disco-daemon/src/services/zone-trigger.ts` (`fireAlwaysNewZoneTrigger`)
 * - `apps/disco-daemon/src/services/gateway.ts`     (gateway session creation)
 * - `apps/disco-daemon/src/utils/apply-session-config-defaults.ts` (the
 *   `before:create` hook for any UI/REST caller that omits config)
 *
 * Resolution order:
 *   permission_config: overrides → user default → mapped system default
 *                      (algorithm shared with the child resolver via
 *                      {@link resolvePermissionConfig})
 *   model_config:      overrides → user default → tool default (always
 *                      populated for tools with a static default; only
 *                      `undefined` for cursor/opencode whose defaults
 *                      live elsewhere)
 *   mcp_server_ids:    overrides → user default → []
 *
 * The child-session variant ({@link resolveChildSessionConfig}) layers a
 * tool-gated parent source between overrides and user defaults; both
 * resolvers share the same permission/model walk.
 */

import {
  type AgenticToolModelConfigurationPolicy,
  type ModelConfigInput,
  resolveModelConfigWithFallback,
} from '../models/resolve-config.js';
import type { AgenticToolName, Session, User } from '../types/index.js';
import {
  resolvePermissionConfig,
  type SessionRuntimeOverrides,
} from './resolve-permission-config.js';

/** Explicit per-call overrides. Each field, when defined, wins over user defaults. */
export interface SessionDefaultsOverrides extends SessionRuntimeOverrides {
  /**
   * Explicit MCP server ID list. An empty array means "no MCPs" — does NOT
   * fall through to user defaults. Pass `undefined` to fall through.
   */
  mcpServerIds?: string[];
}

export interface ResolveSessionDefaultsArgs {
  agenticTool: AgenticToolName;
  /** User whose agentic and MCP defaults provide the next-priority defaults. */
  user?: Pick<User, 'default_agentic_config' | 'default_mcp_server_ids'> | null;
  /** Child-only fallback, gated on an exact parent/child tool match. */
  parent?: Pick<Session, 'agentic_tool' | 'permission_config' | 'model_config'> | null;
  overrides?: SessionDefaultsOverrides;
  /** Override `new Date()` for deterministic tests. */
  now?: Date;
  /** Tool-owned model semantics supplied by the integration registry. */
  modelConfiguration?: AgenticToolModelConfigurationPolicy;
  /** Dynamic integration default, considered only after configured sources. */
  modelFallback?: ModelConfigInput;
}

export interface ResolveSessionMcpServerIdsArgs {
  /** Explicit per-call selection. An empty array means "no MCPs". */
  explicit?: string[];
  /** User whose MCP defaults provide the final configured fallback. */
  user?: Pick<User, 'default_mcp_server_ids'> | null;
}

export interface ResolvedSessionDefaults {
  /** Always populated — falls back to mapped `getDefaultPermissionMode(tool)`. */
  permission_config: NonNullable<Session['permission_config']>;
  /**
   * Always populated for tools with a static default (claude-code, codex,
   * gemini, copilot — falls through overrides → user default → tool
   * default). `undefined` only for cursor/opencode, whose defaults are
   * supplied by their own selectors (cursor: async daemon fetch; opencode:
   * provider + model pair).
   */
  model_config?: NonNullable<Session['model_config']>;
  /** Resolved MCP server list. Empty array means "no MCPs". */
  mcp_server_ids: string[];
}

/** Resolve MCP inheritance independently from agent/model configuration ownership. */
export function resolveSessionMcpServerIds({
  explicit,
  user,
}: ResolveSessionMcpServerIdsArgs): string[] {
  if (explicit !== undefined) return explicit;
  return user?.default_mcp_server_ids ?? [];
}

export function resolveSessionDefaults(args: ResolveSessionDefaultsArgs): ResolvedSessionDefaults {
  const { agenticTool, user, parent, overrides, now, modelConfiguration, modelFallback } = args;
  const userToolDefaults = user?.default_agentic_config?.[agenticTool];
  const sameToolParent = parent?.agentic_tool === agenticTool ? parent : undefined;
  const parentLayer = sameToolParent
    ? {
        permissionMode: sameToolParent.permission_config?.mode,
        codexSandboxMode: sameToolParent.permission_config?.codex?.sandboxMode,
        codexApprovalPolicy: sameToolParent.permission_config?.codex?.approvalPolicy,
        codexNetworkAccess: sameToolParent.permission_config?.codex?.networkAccess,
      }
    : undefined;

  const permission_config = resolvePermissionConfig({
    effectiveTool: agenticTool,
    overrides,
    userToolDefaults,
    parentLayer,
  });

  const model_config = resolveModelConfigWithFallback(
    agenticTool,
    [
      overrides?.modelConfig,
      sameToolParent?.model_config,
      userToolDefaults?.modelConfig,
      modelFallback,
    ],
    { now, policy: modelConfiguration }
  );

  const mcp_server_ids = resolveSessionMcpServerIds({
    explicit: overrides?.mcpServerIds,
    user,
  });

  return { permission_config, model_config, mcp_server_ids };
}
