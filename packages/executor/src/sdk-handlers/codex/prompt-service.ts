/**
 * Codex Prompt Service
 *
 * Handles live execution of prompts against Codex sessions. Normal turns use
 * Codex app-server for true deltas and interruption; the public TypeScript SDK
 * remains available as a rollback transport and for small one-shot helpers.
 *
 * Auth: passes apiKey through CodexOptions when set; otherwise the spawned
 * Codex CLI falls back to `$CODEX_HOME/auth.json` (ChatGPT subscription auth).
 * In subscription mode (`useNativeAuth=true && !apiKey`) we override `env` and
 * scrub `OPENAI_API_KEY` / `CODEX_API_KEY` from the spawn so the CLI is
 * forced down the auth.json path.
 *
 * Per-session config (Disco session-context as `model_instructions_file`,
 * MCP server registry) is passed via `CodexOptions.config`. Disco always uses
 * its own runtime `$CODEX_HOME`; login auth and Windows sandbox support state
 * are seeded from the signed-in desktop profile. Personal config, memories,
 * plugins, skills and rollout state are excluded.
 *
 * IMPORTANT: this service caches the Codex SDK instance and only recreates
 * it when the relevant config (apiKey, baseUrl, useNativeAuth, MCP servers,
 * instructions file path) actually changes. This prevents a memory leak
 * where new Codex CLI processes would be spawned on every prompt execution
 * without cleanup. See issue #133.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DISCO_MCP_METHOD_NAMES,
  isPathInsideDiscoUserWorkspace,
  resolveDiscoUserWorkspaceRoot,
} from '@disco/core';
import {
  prepareDiscoAgentRuntimeContext,
  writeDiscoAgentPreloadFailure,
} from '@disco/core/agent-runtime';
import { loadManagedAgenticToolSdk } from '@disco/core/agentic-integrations';
import { shortId } from '@disco/core/db';
import {
  getMcpServersForSession,
  listMcpToolsWithPermission,
  PERMISSIONS_BLOCKED_WITHOUT_PROMPT,
} from '@disco/core/mcp';
import type { CodexInput, CodexOptions, Thread } from '@disco/core/sdk';
import { renderDiscoSystemPrompt } from '@disco/core/templates/session-context';
import { mergeMCPRemoteHeaders } from '@disco/core/tools/mcp/http-headers';
import { resolveMCPAuthHeaders } from '@disco/core/tools/mcp/jwt-auth';
import type {
  CodexSandboxMode,
  ContextUsageSnapshot,
  MCPServer,
  ToolImageContentBlock,
  UploadPromptAttachment,
} from '@disco/core/types';
import {
  buildUploadAttachmentPrompt,
  getDefaultPermissionMode,
  inferPublishedFileMimeType,
  parseUploadAttachmentPrompt,
} from '@disco/core/types';
import { mapToCodexPermissionConfig } from '@disco/core/utils/permission-mode-mapper';
import type * as CodexSdk from '@openai/codex-sdk';
import { materializeUploadToWorkspace } from '../../commands/upload.js';
import { getDaemonUrl } from '../../config.js';
import type {
  AgentRepository,
  MCPOAuthAuthHeadersRepository,
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
} from '../../db/feathers-repositories.js';
import { reportSdkActivity, type SdkActivityCallback } from '../../sdk-watchdog.js';
import type { TokenUsage } from '../../types/token-usage.js';
import type { PermissionMode, SessionID, TaskID, UserID } from '../../types.js';
import { resolveContextUserId } from '../base/context-user.js';
import type { TasksService } from '../base/index.js';
import { forkCodexThreadViaAppServer } from './app-server-client.js';
import {
  CodexAppServerThread,
  type CodexAppServerThreadEvent,
  type CodexAppServerThreadItem,
} from './app-server-thread.js';
import { codexCapacityUserMessage, isCodexCapacityError } from './capacity-error.js';
import { synchronizeCodexRuntimeAuth } from './codex-auth-sync.js';
import {
  type CommandPurposeClassification,
  CommandPurposeClassifier,
  type CommandPurposeModelRequest,
  resolveCommandPurposeCacheFile,
} from './command-purpose-classifier.js';
import {
  CodexFileCitationStreamFilter,
  resolveCodexFileCitations,
} from './file-citation-contract.js';
import {
  generatedArtifactPathsFromToolUses,
  publishGeneratedArtifacts,
} from './generated-artifact-publication.js';
import { buildCodexHttpsTransportConfig } from './https-transport.js';
import {
  codexSubscriptionAuthUserMessage,
  isCodexSubscriptionAuthError,
} from './provider-auth-error.js';
import {
  CodexRolloutUsageMonitor,
  extractLatestContextUsageFromRollout,
} from './rollout-usage-monitor.js';
import {
  extractCodexContextSnapshotFromEvent,
  extractCodexTokenCountUsageFromEvent,
  extractCodexTokenUsage,
  subtractCodexTokenUsage,
} from './usage.js';

type CodexSdkReasoningEffort = NonNullable<
  NonNullable<
    Parameters<InstanceType<typeof CodexSdk.Codex>['startThread']>[0]
  >['modelReasoningEffort']
>;

/**
 * Codex CLI config payload, sourced from the SDK's public `CodexOptions`
 * surface so we follow the SDK automatically. The SDK flattens nested
 * objects into `--config key.path=value` flags and TOML-quotes string
 * values for us.
 */
type CodexConfigObject = NonNullable<CodexOptions['config']>;
type CodexConfigValue = CodexConfigObject[string];

/**
 * Per-MCP-server config snippet that auto-approves all tool calls without
 * a user prompt. Codex's MCP elicitation gates tool calls behind a per-
 * server prompt that defaults to `Prompt`; in headless `exec --json`
 * (what `@openai/codex-sdk` uses), prompts resolve to "user cancelled
 * MCP tool call". Setting `default_tools_approval_mode = "approve"`
 * short-circuits that prompt and matches Disco's "trust the branch
 * sandbox, don't gate every MCP self-call" model. See
 * `codex-rs/codex-mcp/src/mcp/mod.rs::mcp_permission_prompt_is_auto_approved`
 * — without this, only `danger-full-access` (which grants full-disk-write)
 * clears the prompt.
 */
const MCP_AUTO_APPROVE: CodexConfigObject = { default_tools_approval_mode: 'approve' };

/**
 * Apply the server's `tool_permissions` to its Codex config.
 *
 * Codex's approval mode is per-server, not per-tool, so a gated tool cannot be
 * singled out for a prompt — and `exec --json` has no channel to prompt on
 * anyway (see `MCP_AUTO_APPROVE`). `disabled_tools` is the only per-tool lever
 * Codex exposes, so both `deny` and `ask` fail closed there; `allow` and
 * unlisted tools keep the server-wide auto-approve.
 */
function applyMcpToolPermissions(config: CodexConfigObject, server: MCPServer): void {
  const blocked = listMcpToolsWithPermission(server, PERMISSIONS_BLOCKED_WITHOUT_PROMPT);
  if (blocked.length === 0) return;

  config.disabled_tools = blocked as CodexConfigValue[];

  const asked = listMcpToolsWithPermission(server, ['ask']);
  console.warn(
    `   ⛔ [Codex MCP] Disabling ${blocked.length} tool(s) on "${server.name}" per tool_permissions` +
      (asked.length > 0
        ? ` (${asked.length} set to "ask"; Codex runs headless with no approval prompt, so they fail closed)`
        : '')
  );
}
const DEBUG_CODEX = process.env.DISCO_DEBUG_CODEX === '1' || process.env.DEBUG?.includes('codex');
const CODEX_ROLLOUT_USAGE_POLL_INTERVAL_MS = 1_000;
const COMMAND_PURPOSE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['label', 'confidence'],
  additionalProperties: false,
} as const;
function codexDebug(...args: unknown[]): void {
  if (DEBUG_CODEX) {
    console.debug(...args);
  }
}

export function getCodexHomeCandidates(): string[] {
  const candidates = [
    process.env.CODEX_HOME,
    process.env.DISCO_HOST_CODEX_HOME,
    path.join(os.homedir(), '.codex'),
  ];

  // The local Windows launcher intentionally redirects USERPROFILE/HOME to
  // E:\\Disco\\home so Disco data stays on E:. Codex's image-generation host,
  // however, writes media under the signed-in Windows profile. HOMEDRIVE and
  // HOMEPATH retain that native profile even when USERPROFILE is redirected.
  if (process.platform === 'win32' && process.env.HOMEDRIVE && process.env.HOMEPATH) {
    candidates.push(path.join(process.env.HOMEDRIVE, process.env.HOMEPATH, '.codex'));
  }

  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    unique.set(process.platform === 'win32' ? resolved.toLowerCase() : resolved, resolved);
  }
  return [...unique.values()];
}

export function resolveDiscoCodexRuntimeHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DISCO_CODEX_RUNTIME_HOME?.trim()) {
    return path.resolve(env.DISCO_CODEX_RUNTIME_HOME.trim());
  }
  if (env.DISCO_DATA_HOME?.trim()) {
    return path.resolve(path.dirname(env.DISCO_DATA_HOME.trim()), 'codex-runtime');
  }
  if (env.CODEX_HOME?.trim()) return path.resolve(env.CODEX_HOME.trim());
  return path.resolve(os.homedir(), '.disco', 'codex-runtime');
}

const DISCO_CODEX_CHILD_ENV_ALLOWLIST = new Set(['CODEX_HOME', 'CODEX_API_KEY']);

/**
 * Build the environment inherited by Disco-owned Codex processes.
 *
 * Ordinary OS and Disco variables are preserved. Codex-internal variables are
 * allowlisted so a daemon launched from Codex Desktop cannot accidentally pass
 * the desktop task identity, originator, permission profile, or CI marker into
 * Disco's isolated Runtime Home.
 */
export function buildDiscoCodexChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options: {
    codexHome?: string;
    useSubscription?: boolean;
    apiKey?: string;
  } = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.startsWith('CODEX_') && !DISCO_CODEX_CHILD_ENV_ALLOWLIST.has(key)) continue;
    if (options.useSubscription && (key === 'OPENAI_API_KEY' || key === 'CODEX_API_KEY')) {
      continue;
    }
    env[key] = value;
  }

  env.CODEX_HOME = options.codexHome ?? resolveDiscoCodexRuntimeHome(source);
  if (options.useSubscription) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  } else if (options.apiKey) {
    env.CODEX_API_KEY = options.apiKey;
  }
  return env;
}

export function buildDiscoRuntimeAccessBoundary(userWorkspaceRoot: string): string {
  const currentUserRoot = path.resolve(userWorkspaceRoot);
  const usersRoot = path.dirname(currentUserRoot);
  return `# Disco 用户目录边界

当前用户目录：\`${currentUserRoot}\`
用户目录根：\`${usersRoot}\`

可以访问当前用户目录内的全部内容，也可以访问其他普通本机目录。不要访问用户目录根下属于其他 Disco 用户的目录；以最终解析后的路径为准。

本规则仅用于当前运行，不要写入智能体的人格、记忆或技能。`;
}

export function buildDiscoManagedLifecycleInstruction(
  options: { agentSession: boolean } = { agentSession: true }
): string {
  return `# Disco 托管操作

安装、更新或自生成技能时，使用本次运行提供的 Disco 托管技能方法；不要直接写入技能目录或 Codex Runtime Home。${options.agentSession ? '默认目标是当前智能体。' : '默认目标是当前用户的 Disco 共享技能。'}

${options.agentSession ? '用户明确要求“记住”时，使用 Disco 托管记忆方法；不要通过 Shell 直接修改长期记忆文件。' : '独立会话不保存人格或长期记忆。'}

向用户交付本地文件时，使用 Disco 托管文件发布方法。只有该操作成功返回的文件才算已交付；仅在回复中写文件名或路径不算发送。

Windows PowerShell 读写文本时显式指定 UTF-8。

具体方法名和输入结构以当前 Disco 工具目录为准。`;
}

async function ensureDiscoCodexRuntimeHome(): Promise<string> {
  const runtimeHome = resolveDiscoCodexRuntimeHome();
  const result = await synchronizeCodexRuntimeAuth({
    runtimeHome,
    hostHomes: getCodexHomeCandidates(),
  });
  if (result.copied) {
    codexDebug(`🔐 [Codex] Updated Disco runtime auth from ${result.sourceAuthFile}`);
  }
  return runtimeHome;
}

export type CompletedToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string | Array<Record<string, unknown>>;
  status?: string;
};

function imageViewFilename(filePath: string): string {
  return filePath.replaceAll('\\', '/').split('/').at(-1)?.trim() || '图片';
}

function unavailableImageView(
  filePath: string,
  reason = '图片预览暂不可用'
): ToolImageContentBlock {
  const filename = imageViewFilename(filePath);
  return {
    type: 'image',
    filename,
    mime_type: inferPublishedFileMimeType(filename),
    available: false,
    unavailable_reason: reason,
  };
}

function parsePublicationPayload(value: unknown): UploadPromptAttachment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const payload = value as Record<string, unknown>;
  if (payload.type !== 'disco_file_publication' || payload.published !== true) return [];
  if (!Array.isArray(payload.files)) return [];
  return payload.files.flatMap(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return [];
    const candidate = file as Record<string, unknown>;
    if (
      typeof candidate.ref !== 'string' ||
      typeof candidate.filename !== 'string' ||
      typeof candidate.mimeType !== 'string' ||
      typeof candidate.size !== 'number' ||
      !Number.isFinite(candidate.size)
    ) {
      return [];
    }
    return [
      {
        ref: candidate.ref,
        filename: candidate.filename,
        mimeType: candidate.mimeType,
        size: candidate.size,
      },
    ];
  });
}

function publicationPayloadsFromOutput(output: CompletedToolUse['output']): unknown[] {
  if (typeof output === 'string') {
    try {
      return [JSON.parse(output) as unknown];
    } catch {
      return [];
    }
  }
  if (!Array.isArray(output)) return [];
  const values: unknown[] = [];
  for (const block of output) {
    if (!block || typeof block !== 'object') continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text !== 'string') continue;
    try {
      values.push(JSON.parse(text) as unknown);
    } catch {
      // Only the structured JSON marker from disco_files_publish is trusted.
    }
  }
  return values;
}

function isExplicitPublicationToolUse(toolUse: CompletedToolUse): boolean {
  const operation = toolUse.name.split('.').at(-1);
  return (
    operation === DISCO_MCP_METHOD_NAMES.filesPublish ||
    (operation === DISCO_MCP_METHOD_NAMES.execute &&
      toolUse.input.tool_name === DISCO_MCP_METHOD_NAMES.filesPublish)
  );
}

export function extractExplicitlyPublishedAttachments(
  toolUses: ReadonlyArray<CompletedToolUse>
): UploadPromptAttachment[] {
  const attachments = new Map<string, UploadPromptAttachment>();
  for (const toolUse of toolUses) {
    if (toolUse.status === 'failed' || toolUse.status === 'error') continue;
    if (!isExplicitPublicationToolUse(toolUse)) continue;
    for (const payload of publicationPayloadsFromOutput(toolUse.output)) {
      for (const attachment of parsePublicationPayload(payload)) {
        attachments.set(attachment.ref, attachment);
      }
    }
  }
  return [...attachments.values()];
}

export function countFailedExplicitPublications(toolUses: ReadonlyArray<CompletedToolUse>): number {
  let failed = 0;
  for (const toolUse of toolUses) {
    if (!isExplicitPublicationToolUse(toolUse)) continue;
    if (toolUse.status === 'started' || toolUse.status === 'in_progress') continue;
    const published = publicationPayloadsFromOutput(toolUse.output).flatMap(
      parsePublicationPayload
    );
    if (toolUse.status === 'failed' || toolUse.status === 'error' || published.length === 0) {
      failed += 1;
    }
  }
  return failed;
}

/**
 * Append the canonical authenticated attachment block for every successful
 * explicit publication. Assistant prose and local Markdown links are never
 * treated as delivery evidence and therefore cannot suppress the native
 * image/PDF/audio/video/file controls in the browser.
 */
export function appendExplicitlyPublishedOutputs(input: {
  content: Array<{ type: string; text?: string }>;
  toolUses: ReadonlyArray<CompletedToolUse>;
  excludedRefs?: ReadonlySet<string>;
}): void {
  const published = extractExplicitlyPublishedAttachments(input.toolUses).filter(
    attachment => !input.excludedRefs?.has(attachment.ref)
  );
  const failed = countFailedExplicitPublications(input.toolUses);
  if (failed > 0) {
    input.content.push({
      type: 'text',
      text: `⚠️ 文件交付未完成：${failed} 次发布调用失败或未返回有效文件。回复中提到的本地文件名不代表文件已经发送。`,
    });
  }
  if (published.length > 0) {
    input.content.push({ type: 'text', text: buildUploadAttachmentPrompt('', published) });
  }
}

function methodFailureIdentity(toolUse: CompletedToolUse): { key: string; displayName: string } {
  const operation = toolUse.name.split('.').at(-1) ?? toolUse.name;
  const nestedName =
    operation.endsWith('execute_tool') && typeof toolUse.input.tool_name === 'string'
      ? toolUse.input.tool_name
      : undefined;
  const displayName = nestedName ?? toolUse.name;
  const methodInput = nestedName ? (toolUse.input.arguments ?? {}) : toolUse.input;
  return {
    key: `${displayName}\u0000${JSON.stringify(methodInput)}`,
    displayName,
  };
}

export function unrecoveredMethodFailureNames(toolUses: ReadonlyArray<CompletedToolUse>): string[] {
  const recovered = new Set<string>();
  const failures = new Map<string, string>();
  for (let index = toolUses.length - 1; index >= 0; index -= 1) {
    const toolUse = toolUses[index]!;
    if (isExplicitPublicationToolUse(toolUse)) continue;
    // Commands and file edits have dedicated status UI. This notice covers
    // callable MCP/client methods whose success might otherwise exist only in
    // assistant prose.
    if (!toolUse.name.includes('.')) continue;
    const { key, displayName } = methodFailureIdentity(toolUse);
    if (toolUse.status === 'failed' || toolUse.status === 'error') {
      if (!recovered.has(key) && /^[\w.:-]{1,120}$/u.test(displayName)) {
        failures.set(key, displayName);
      }
      continue;
    }
    if (toolUse.status && toolUse.status !== 'started' && toolUse.status !== 'in_progress') {
      recovered.add(key);
      failures.delete(key);
    }
  }
  return [...new Set(failures.values())].sort().slice(0, 5);
}

export function appendVerifiedToolOutcomeNotices(input: {
  content: Array<{ type: string; text?: string }>;
  toolUses: ReadonlyArray<CompletedToolUse>;
  excludedAttachmentRefs?: ReadonlySet<string>;
}): void {
  appendExplicitlyPublishedOutputs({
    content: input.content,
    toolUses: input.toolUses,
    excludedRefs: input.excludedAttachmentRefs,
  });
  const failures = unrecoveredMethodFailureNames(input.toolUses);
  if (failures.length > 0) {
    input.content.push({
      type: 'text',
      text: `⚠️ 以下方法调用未完成：${failures.join('、')}。如回复声称这些操作已经成功，应以此失败状态为准。`,
    });
  }
}

export interface CodexPromptResult {
  /** Complete assistant response from Codex */
  messages: Array<{
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    toolUses?: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
  }>;
  /** Number of input tokens */
  inputTokens: number;
  /** Number of output tokens */
  outputTokens: number;
  /** Agent SDK thread ID for conversation continuity */
  threadId: string;
  /** Token usage (if provided by SDK) */
  tokenUsage?: TokenUsage;
  /** Resolved model for the turn */
  resolvedModel?: string;
}

/**
 * Streaming event types for Codex execution
 */
export type CodexStreamEvent =
  | {
      type: 'partial';
      textChunk: string;
      threadId?: string;
      resolvedModel?: string;
    }
  | {
      type: 'tool_start';
      toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
      };
      threadId?: string;
    }
  | {
      type: 'tool_complete';
      toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        output?: string | Array<Record<string, unknown>>;
        status?: string;
      };
      threadId?: string;
    }
  | {
      type: 'stopped';
      threadId?: string;
    }
  | {
      type: 'context_compacted';
      threadId?: string;
      observedAt?: string;
    }
  | {
      type: 'capacity_retry';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      threadId?: string;
    }
  | {
      type: 'capacity_recovered';
      threadId?: string;
    }
  | {
      /** Running per-task accounting snapshot derived from Codex token_count events. */
      type: 'usage_snapshot';
      usage: TokenUsage;
      /** Timestamp from the rollout token_count row, used for 30-second bucketing. */
      observedAt?: string;
      rawContextUsage?: ContextUsageSnapshot;
      threadId?: string;
      resolvedModel?: string;
    }
  | {
      type: 'complete';
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        [key: string]: unknown;
      }>;
      toolUses?: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;
      threadId: string;
      resolvedModel?: string;
      usage?: TokenUsage;
      rawSdkEvent?: import('../../types/sdk-response').CodexSdkResponse; // The actual turn.completed event from Codex SDK
      rawContextUsage?: ContextUsageSnapshot;
    };

export class CodexPromptService {
  private codex?: InstanceType<typeof CodexSdk.Codex>;
  private lastApiKey: string | null = null;
  private lastBaseUrl: string | null = null;
  private lastClientFingerprint: string | null = null;
  private stopRequested = new Map<SessionID, boolean>();
  private apiKey: string | undefined;
  private useNativeAuth: boolean;
  private instructionsFilePaths = new Map<SessionID, string>();
  private activeAppServerThreads = new Map<SessionID, CodexAppServerThread>();
  private commandPurposeClassifiers = new Map<string, CommandPurposeClassifier>();

  /**
   * App-server is the default because it preserves the same HTTPS Responses
   * transport while exposing assistant deltas and turn interruption. Keep the
   * SDK path as an operator rollback switch during the migration.
   */
  private readonly executionTransport =
    process.env.DISCO_CODEX_EXECUTION_TRANSPORT?.trim().toLowerCase() === 'sdk'
      ? 'sdk'
      : 'app-server';

  /**
   * Resolve the per-user custom OpenAI-compatible base URL.
   *
   * Sourced from `process.env.OPENAI_BASE_URL`, which the daemon populates
   * from the user's `agentic_tools.codex.OPENAI_BASE_URL` setting via
   * `createUserProcessEnvironment` (see packages/core/src/config/env-resolver.ts).
   *
   * Empty / unset → returns undefined so the Codex SDK uses its default endpoint.
   * Logged at DEBUG only (could leak internal hostnames).
   */
  private resolveBaseUrl(): string | undefined {
    const raw = process.env.OPENAI_BASE_URL?.trim();
    return raw && raw.length > 0 ? raw : undefined;
  }

  constructor(
    _messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private sessionMCPServerRepo?: SessionMCPServerRepository,
    apiKey?: string,
    private mcpServerRepo?: MCPServerRepository,
    _usersRepo?: UsersRepository,
    useNativeAuth: boolean = false,
    private tasksService?: TasksService,
    private mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository,
    private executorSessionToken?: string,
    private agentsRepo?: AgentRepository
  ) {
    // Store API key from base-executor (already resolved with proper precedence)
    this.apiKey = apiKey || '';
    this.lastApiKey = this.apiKey;
    this.useNativeAuth = useNativeAuth;
    const baseUrl = this.resolveBaseUrl();
    this.lastBaseUrl = baseUrl ?? null;

    if (this.apiKey) {
      // Source already logged by base-executor via resolveApiKeyForTask().
    } else if (this.useNativeAuth) {
      codexDebug(
        '🔓 [Codex] No API key configured — falling back to ChatGPT subscription auth from $CODEX_HOME/auth.json. ' +
          'Run `codex login` if you have not authenticated yet.'
      );
    } else {
      console.error(
        '❌ [Codex] No API key and native auth disabled — Codex requests will fail with 401. ' +
          'Configure your API key in Settings > Codex > Authentication or sign in via `codex login`.'
      );
    }

    if (baseUrl) {
      codexDebug(`🔗 [Codex] Using custom OPENAI_BASE_URL`);
    }

    // Do not construct the Codex SDK client until promptSessionStreaming has
    // resolved the session-scoped config (instructions file + MCP servers).
    // Constructing here with no MCP config and then replacing it moments later
    // makes the SDK/app-server briefly start with the wrong lifecycle, which is
    // visible as MCP disconnect/reconnect waves in gateway-driven turns.
    this.lastClientFingerprint = null;

    // Best-effort sweep of orphaned per-session instructions files in
    // tmpdir. `closeSession()` removes a session's file when called, but
    // the daemon currently has no terminal-state hook that invokes it
    // (also true for Gemini/Copilot — broader gap). This sweep self-heals
    // long-running daemons that accumulate stale `disco-codex-instructions-*`
    // across crashes / unclean shutdowns / never-fired close hooks.
    void this.sweepStaleInstructionsFiles().catch(err => {
      console.warn('⚠️  [Codex] Stale-instructions-file sweep failed:', err);
    });
  }

  /**
   * Delete `disco-codex-instructions-*.md` files in `os.tmpdir()` (and the
   * `~/.disco/tmp` fallback dir) older than 24h. Bounds the disk leak from
   * the missing close hook described in the constructor.
   */
  private async sweepStaleInstructionsFiles(): Promise<void> {
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const candidateDirs = [os.tmpdir(), path.join(os.homedir(), '.disco', 'tmp')];

    for (const dir of candidateDirs) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      let deleted = 0;
      let failed = 0;
      const failedByCode = new Map<string, number>();
      for (const name of entries) {
        if (!name.startsWith('disco-codex-instructions-') || !name.endsWith('.md')) continue;
        const full = path.join(dir, name);
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs < cutoffMs) {
            await fs.unlink(full);
            deleted++;
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            failed++;
            failedByCode.set(code ?? 'UNKNOWN', (failedByCode.get(code ?? 'UNKNOWN') ?? 0) + 1);
          }
        }
      }
      if (deleted > 0) {
        codexDebug(`🧹 [Codex] Swept ${deleted} stale instructions file(s) from ${dir}`);
      }
      if (failed > 0) {
        const summary = [...failedByCode.entries()]
          .map(([code, count]) => `${code}=${count}`)
          .join(', ');
        codexDebug(
          `🧹 [Codex] Skipped ${failed} stale instructions file(s) in ${dir} (${summary})`
        );
      }
    }
  }

  /**
   * Build CodexOptions for `new Codex({...})`.
   *
   * Subscription mode (no apiKey + useNativeAuth) scrubs `OPENAI_API_KEY` and
   * `CODEX_API_KEY` from the spawned Codex CLI process so it falls back to
   * `$CODEX_HOME/auth.json`. The SDK does NOT inherit `process.env` when an
   * `env` object is provided, so we forward ordinary OS and Disco vars while
   * dropping Codex Desktop's task-scoped internal variables.
   */
  private buildCodexOptions(
    apiKey: string | undefined,
    baseUrl: string | undefined,
    config: CodexConfigObject | undefined
  ): ConstructorParameters<typeof CodexSdk.Codex>[0] {
    const useSubscription = this.useNativeAuth && !apiKey;
    const httpsConfig = buildCodexHttpsTransportConfig({
      config,
      apiKey,
      baseUrl,
      useNativeAuth: this.useNativeAuth,
    });

    const options: ConstructorParameters<typeof CodexSdk.Codex>[0] = {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      config: httpsConfig,
    };

    options.env = buildDiscoCodexChildEnvironment(process.env, {
      codexHome: resolveDiscoCodexRuntimeHome(),
      useSubscription,
      apiKey,
    }) as Record<string, string>;

    return options;
  }

  private buildAppServerEnvironment(): NodeJS.ProcessEnv {
    return buildDiscoCodexChildEnvironment(process.env, {
      codexHome: resolveDiscoCodexRuntimeHome(),
      useSubscription: this.useNativeAuth && !this.apiKey,
      apiKey: this.apiKey,
    });
  }

  private getCommandPurposeClassifier(scope: string): CommandPurposeClassifier {
    const existing = this.commandPurposeClassifiers.get(scope);
    if (existing) return existing;

    const modelSetting = process.env.DISCO_COMMAND_PURPOSE_MODEL?.trim().toLowerCase();
    const modelEnabled =
      modelSetting !== 'off' && (process.env.NODE_ENV !== 'test' || modelSetting === 'on');
    const classifier = new CommandPurposeClassifier({
      cacheFile: resolveCommandPurposeCacheFile(scope),
      ...(modelEnabled
        ? {
            model: (request: CommandPurposeModelRequest) =>
              this.classifyCommandPurposeWithSmallModel(request),
          }
        : {}),
    });
    this.commandPurposeClassifiers.set(scope, classifier);
    return classifier;
  }

  /**
   * Resolve only ambiguous command purposes with the fast lightweight model.
   * This thread has no network, tools, Disco instructions or workspace access;
   * it can only return a short UI label. Failures are absorbed by the local
   * classifier so command execution and streaming never depend on this helper.
   */
  private async classifyCommandPurposeWithSmallModel(
    request: CommandPurposeModelRequest
  ): Promise<{ label: string; confidence: number } | null> {
    const Codex = await loadManagedAgenticToolSdk<typeof CodexSdk>('codex');
    const client = new Codex.Codex(
      this.buildCodexOptions(this.apiKey, this.resolveBaseUrl(), {
        features: {
          memories: false,
          external_agent_memory_import: false,
          js_repl: false,
        },
      })
    );
    const thread = client.startThread({
      model: 'gpt-5.6-luna',
      modelReasoningEffort: 'low',
      sandboxMode: 'read-only',
      workingDirectory: os.tmpdir(),
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 12_000);
    try {
      const result = await thread.run(
        [
          '把下面的命令概括成一个 4 到 16 个汉字的用户可见动作短语。',
          '概括整条复合命令的主要目的，不要只写 PowerShell、Python、Get-Item 等执行器或偶然出现的子命令。',
          '不要使用“正在”“已经”“已”等状态前缀，不要输出路径、随机 ID、引号或解释。',
          `本地初步判断：${request.localLabel}`,
          request.context ? `邻近上下文：${request.context}` : '',
          `命令：${request.command}`,
        ]
          .filter(Boolean)
          .join('\n'),
        { outputSchema: COMMAND_PURPOSE_OUTPUT_SCHEMA, signal: abortController.signal }
      );
      const parsed = JSON.parse(result.finalResponse) as {
        label?: unknown;
        confidence?: unknown;
      };
      return typeof parsed.label === 'string' && typeof parsed.confidence === 'number'
        ? { label: parsed.label, confidence: parsed.confidence }
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Refresh Codex client with latest API key from config (no per-session
   * config payload). Used at session start, before we have the instructions
   * file path or MCP servers — `ensureCodexClient()` is the per-turn refresh
   * that can change config.
   *
   * IMPORTANT: Only recreates Codex instance if API key OR base URL actually
   * changed. This prevents the issue #133 memory leak where unbounded Codex
   * CLI processes accumulate when we recreate without need.
   */
  private refreshClient(currentApiKey: string): void {
    const currentBaseUrl = this.resolveBaseUrl();
    const baseUrlChanged = (this.lastBaseUrl ?? null) !== (currentBaseUrl ?? null);
    if (this.lastApiKey !== currentApiKey || baseUrlChanged) {
      console.log(
        `🔄 [Codex] ${this.lastApiKey !== currentApiKey ? 'API key' : 'Base URL'} changed, invalidating SDK client...`
      );
      this.apiKey = currentApiKey;
      this.lastApiKey = currentApiKey;
      this.lastBaseUrl = currentBaseUrl ?? null;
      this.lastClientFingerprint = null;
      console.log('✅ [Codex] SDK configuration invalidated');
    }
  }

  /**
   * Snapshot the values of every `DISCO_MCP_*` env var (set by
   * `buildMcpServersConfig` for built-in + per-server bearer tokens). Folded
   * into the client fingerprint so a token rotation invalidates the cached
   * Codex instance even when the config object's shape (server names,
   * `bearer_token_env_var` keys) is unchanged.
   *
   * Without this, both subscription mode (where we pass `env` snapshot to
   * `CodexOptions.env`) and API-key mode (where the SDK snapshots
   * `process.env` at construction time) would keep spawning the cached Codex
   * with a stale token after rotation.
   */
  private snapshotMcpEnvValues(): Record<string, string> {
    const snapshot: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DISCO_MCP_')) {
        snapshot[key] = process.env[key] ?? '';
      }
    }
    return snapshot;
  }

  /**
   * Recreate `this.codex` with the per-session `config` payload (instructions
   * file + MCP servers) only when the fingerprint changed. Prevents per-turn
   * SDK churn (issue #133) while still reflecting fresh per-session config.
   *
   * The fingerprint includes a snapshot of `DISCO_MCP_*` env values so that
   * rotated MCP bearer tokens invalidate the cache even when the config
   * shape stays the same — see `snapshotMcpEnvValues()`.
   */
  private async ensureCodexClient(config: CodexConfigObject): Promise<void> {
    const baseUrl = this.resolveBaseUrl();
    const fingerprint = JSON.stringify({
      apiKey: this.apiKey || '',
      baseUrl: baseUrl ?? '',
      useNativeAuth: this.useNativeAuth,
      config,
      mcpEnv: this.snapshotMcpEnvValues(),
    });

    if (this.lastClientFingerprint === fingerprint) {
      return;
    }

    codexDebug(
      `🔄 [Codex] Per-session config changed, reinitializing SDK (apiKey=${this.apiKey ? 'set' : 'unset'}, useNativeAuth=${this.useNativeAuth})`
    );
    await this.replaceCodexClient(this.buildCodexOptions(this.apiKey, baseUrl, config));
    this.lastApiKey = this.apiKey || null;
    this.lastBaseUrl = baseUrl ?? null;
    this.lastClientFingerprint = fingerprint;
  }

  /**
   * Best-effort close for SDK clients that expose a lifecycle method. The
   * current Codex SDK API has changed over time, so probe common method names
   * rather than depending on one concrete type. Awaiting close before replacement
   * keeps abandoned app-server/MCP transports from overlapping the new client.
   */
  private async closeCodexClient(
    client: InstanceType<typeof CodexSdk.Codex> | undefined
  ): Promise<void> {
    if (!client) return;
    const candidate = client as unknown as {
      close?: () => void | Promise<void>;
      dispose?: () => void | Promise<void>;
      shutdown?: () => void | Promise<void>;
    };
    const close = candidate.close ?? candidate.dispose ?? candidate.shutdown;
    if (!close) return;

    try {
      await Promise.resolve(close.call(candidate));
    } catch (error) {
      console.warn('⚠️  [Codex] Failed to close previous SDK client:', error);
    }
  }

  private async replaceCodexClient(
    options: ConstructorParameters<typeof CodexSdk.Codex>[0]
  ): Promise<void> {
    const previous = this.codex;
    this.codex = undefined;
    await this.closeCodexClient(previous);
    const Codex = await loadManagedAgenticToolSdk<typeof CodexSdk>('codex');
    this.codex = new Codex.Codex(options);
  }

  private getCodexClient(): InstanceType<typeof CodexSdk.Codex> {
    if (!this.codex) {
      throw new Error('Codex SDK client was not initialized before use');
    }
    return this.codex;
  }

  /**
   * Write the rendered static Disco orientation prompt to a single file under
   * `os.tmpdir()` and return its absolute path.
   *
   * Replaces the per-session CODEX_HOME directory + AGENTS.md mechanism — we
   * now point Codex at this file via the `model_instructions_file` config key
   * (loaded by Codex CLI in addition to any project AGENTS.md files).
   *
   * `~/.codex/` is NEVER touched: the user's auth.json and any user-authored
   * config.toml stay where they are.
   */
  private async ensureCodexInstructionsFile(
    sessionId: SessionID,
    options: {
      includeDiscoOrientation: boolean;
      userWorkspaceRoot?: string;
      agentRuntimeContext?: string;
      includeManagedLifecycle?: boolean;
      agentSession?: boolean;
    }
  ): Promise<string> {
    const instructions: string[] = [];
    if (options.includeDiscoOrientation) {
      instructions.push(await renderDiscoSystemPrompt());
    }
    if (options.userWorkspaceRoot) {
      instructions.push(buildDiscoRuntimeAccessBoundary(options.userWorkspaceRoot));
    }
    if (options.includeManagedLifecycle) {
      instructions.push(
        buildDiscoManagedLifecycleInstruction({ agentSession: options.agentSession === true })
      );
    }
    if (options.agentRuntimeContext) {
      instructions.push(options.agentRuntimeContext);
    }
    const instructionText = `${instructions.join('\n\n')}\n`;

    const fileName = `disco-codex-instructions-${sessionId}.md`;

    // Try /tmp first; fall back to ~/.disco/tmp if /tmp is unavailable
    // (sandboxed executors / containers without /tmp).
    let filePath = path.join(os.tmpdir(), fileName);
    const writeIfChanged = async (targetPath: string): Promise<boolean> => {
      try {
        if ((await fs.readFile(targetPath, 'utf-8')) === instructionText) {
          return false;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw readError;
        }
      }
      await fs.writeFile(targetPath, instructionText, { encoding: 'utf-8', mode: 0o600 });
      return true;
    };

    let wroteInstructions = false;
    try {
      wroteInstructions = await writeIfChanged(filePath);
    } catch (writeError) {
      const fallbackBase = path.join(os.homedir(), '.disco', 'tmp');
      console.warn(
        `⚠️  [Codex] Failed to write instructions file in ${os.tmpdir()} (${(writeError as Error).message}), falling back to ${fallbackBase}`
      );
      await fs.mkdir(fallbackBase, { recursive: true, mode: 0o700 });
      filePath = path.join(fallbackBase, fileName);
      wroteInstructions = await writeIfChanged(filePath);
    }

    this.instructionsFilePaths.set(sessionId, filePath);
    codexDebug(
      `${wroteInstructions ? '✅ [Codex] Wrote' : '♻️ [Codex] Reused'} per-session instructions file at ${filePath}`
    );
    return filePath;
  }

  /**
   * Claim a unique sanitized server name within this session's mcp_servers
   * map. Sanitization collapses non-`[a-z0-9_-]` chars to `_`, so distinct
   * input names can collide (`Foo Bar` and `foo_bar` both become `foo_bar`)
   * — without de-collision the second would silently overwrite the first.
   *
   * On collision we suffix `_2`, `_3`, ... and warn so operators can spot
   * the underlying naming clash.
   */
  private claimMcpServerName(
    rawName: string,
    claimed: Set<string>,
    reservedReason?: string
  ): string {
    let base = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (reservedReason) {
      base = `user_${base}`;
      console.warn(
        `   ⚠️  [Codex MCP] "${rawName}" ${reservedReason}, renamed to "${base}" to disambiguate`
      );
    }
    if (!claimed.has(base)) {
      claimed.add(base);
      return base;
    }
    let suffix = 2;
    while (claimed.has(`${base}_${suffix}`)) suffix++;
    const final = `${base}_${suffix}`;
    console.warn(
      `   ⚠️  [Codex MCP] sanitized name "${base}" already claimed (raw="${rawName}"), using "${final}"`
    );
    claimed.add(final);
    return final;
  }

  /**
   * Build the `mcp_servers` nested config object for `CodexOptions.config`.
   *
   * Includes the built-in Disco MCP server (when `mcpToken` is provided) plus
   * all session-scoped + global MCP servers, categorized by transport. The
   * SDK's `flattenConfigOverrides` turns this object into repeated
   * `--config mcp_servers.<name>.<field>=<value>` flags for the Codex CLI.
   *
   * Bearer tokens (whether plain bearer, JWT, or OAuth) are resolved via the
   * shared `resolveMCPAuthHeaders` (matching Claude) and injected via env
   * vars referenced by `bearer_token_env_var` (never inlined in the URL).
   *
   * `forUserId` is required for per-user OAuth token injection at the
   * scoping layer — without it, OAuth-protected MCP servers won't pick up
   * the requesting user's stored OAuth tokens.
   */
  private async buildMcpServersConfig(
    sessionId: SessionID,
    mcpToken: string | undefined,
    context: {
      forUserId?: UserID;
      sessionOwnerId: UserID;
    }
  ): Promise<{ servers: CodexConfigObject; total: number }> {
    const { forUserId, sessionOwnerId } = context;
    codexDebug(`🔍 [Codex MCP] Fetching MCP servers for session ${shortId(sessionId)}...`);
    codexDebug(`   [Codex MCP] forUserId: ${forUserId || 'NOT SET'}`);

    const serversWithSource = await getMcpServersForSession(
      sessionId,
      {
        sessionMCPRepo: this.sessionMCPServerRepo,
        mcpServerRepo: this.mcpServerRepo,
        mcpOAuthAuthHeadersRepo: this.mcpOAuthAuthHeadersRepo,
        forUserId,
        sessionOwnerId,
      },
      { toolFiltering: 'exclude' }
    );

    const mcpServers = serversWithSource.map(s => s.server);

    codexDebug(`📊 [Codex MCP] Found ${mcpServers.length} MCP server(s) for session`);
    if (mcpServers.length > 0) {
      codexDebug(`   Servers: ${mcpServers.map(s => `${s.name} (${s.transport})`).join(', ')}`);
    }

    const stdioServers = mcpServers.filter(s => s.transport === 'stdio');
    const httpServers = mcpServers.filter(s => s.transport === 'http' || s.transport === 'sse');

    codexDebug(
      `   📊 [Codex MCP] Transport breakdown: ${stdioServers.length} STDIO, ${httpServers.length} HTTP/SSE`
    );

    const result: CodexConfigObject = {};
    const claimedNames = new Set<string>();

    // Built-in Disco MCP server (streamable HTTP). Token travels via
    // bearer_token_env_var — never in the URL.
    if (mcpToken) {
      const daemonUrl = await getDaemonUrl();
      const discoBearerEnvVar = `DISCO_MCP_${shortId(sessionId)}_DISCO`;
      process.env[discoBearerEnvVar] = mcpToken;

      claimedNames.add('disco');
      result.disco = {
        url: `${daemonUrl}/mcp`,
        bearer_token_env_var: discoBearerEnvVar,
        ...MCP_AUTO_APPROVE,
      };
      codexDebug(
        `   📝 [Codex MCP] Configuring built-in Disco MCP server (HTTP) at ${daemonUrl}/mcp`
      );
    }

    for (const server of stdioServers) {
      const serverName = this.claimMcpServerName(
        server.name,
        claimedNames,
        server.name.toLowerCase() === 'disco'
          ? 'conflicts with built-in Disco MCP server'
          : undefined
      );

      const serverConfig: CodexConfigObject = { ...MCP_AUTO_APPROVE };
      applyMcpToolPermissions(serverConfig, server);
      codexDebug(`   📝 [Codex MCP] Configuring STDIO server: ${server.name} -> ${serverName}`);
      if (server.command) {
        serverConfig.command = server.command;
        codexDebug(`      command: ${server.command}`);
      }
      if (server.args && server.args.length > 0) {
        serverConfig.args = server.args as CodexConfigValue[];
        codexDebug(`      args: ${JSON.stringify(server.args)}`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        serverConfig.env = server.env as CodexConfigObject;
        codexDebug(`      env vars: ${Object.keys(server.env).length} variable(s)`);
      }

      result[serverName] = serverConfig;
    }

    for (const server of httpServers) {
      const serverName = this.claimMcpServerName(
        server.name,
        claimedNames,
        server.name.toLowerCase() === 'disco'
          ? 'conflicts with built-in Disco MCP server'
          : undefined
      );

      const serverConfig: CodexConfigObject = { ...MCP_AUTO_APPROVE };
      applyMcpToolPermissions(serverConfig, server);
      codexDebug(`   📝 [Codex MCP] Configuring HTTP server: ${server.name} -> ${serverName}`);
      if (server.url) {
        serverConfig.url = server.url;
        codexDebug(`      url: ${server.url}`);
      }

      // Resolve the Authorization header via the shared MCP auth helper —
      // covers bearer / JWT (with token-mint) / OAuth (with cached & DB
      // tokens). Codex passes the bearer through `bearer_token_env_var`,
      // while custom headers use `env_http_headers`, so secret values stay
      // out of the SDK's generated `--config` arguments. Non-bearer schemes
      // log a warning since Codex's CLI only supports bearer auth.
      try {
        const authHeaders = await resolveMCPAuthHeaders(server.auth, server.url);
        const headers = mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders });
        const authHeader = headers?.Authorization;
        const missingRequiredAuth = !!server.auth && server.auth.type !== 'none' && !authHeader;
        const customHeaders = headers ? { ...headers } : undefined;
        if (customHeaders) delete customHeaders.Authorization;
        if (customHeaders && Object.keys(customHeaders).length > 0) {
          // Codex's streamable-HTTP MCP config takes `env_http_headers`: a map
          // of header NAME -> the NAME of an env var whose value Codex reads at
          // runtime. (It will not accept literal header values here the way
          // Claude's `.mcp.json` `headers` object does — that indirection is
          // also what keeps secrets out of the SDK-generated `--config` argv.)
          // The env var name itself is arbitrary to Codex; we synthesize a
          // unique one per session + server + position so concurrent sessions
          // and multi-header servers don't clobber each other in the shared
          // process.env. The index (not the header name) keys the suffix
          // because header names like `X-API-Key` aren't valid env-var
          // identifiers.
          const envHttpHeaders: Record<string, string> = {};
          for (const [index, [headerName, headerValue]] of Object.entries(
            customHeaders
          ).entries()) {
            const envVarName = `DISCO_MCP_${shortId(sessionId)}_${serverName.toUpperCase()}_HEADER_${index + 1}`;
            process.env[envVarName] = headerValue;
            envHttpHeaders[headerName] = envVarName;
          }
          serverConfig.env_http_headers = envHttpHeaders;
          codexDebug(`      custom headers: ${Object.keys(customHeaders).length} header(s)`);
        }
        if (authHeader) {
          const bearerToken = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1];
          if (bearerToken) {
            const envVarName = `DISCO_MCP_${shortId(sessionId)}_${serverName.toUpperCase()}`;
            process.env[envVarName] = bearerToken;
            serverConfig.bearer_token_env_var = envVarName;
            codexDebug(`      auth: ${server.auth?.type ?? 'bearer'} token via ${envVarName}`);
          } else {
            console.warn(
              `      ⚠️  auth: resolved Authorization header for "${server.name}" is not a Bearer scheme (Codex CLI only supports bearer); skipping injection`
            );
          }
        } else if (missingRequiredAuth) {
          console.warn(
            `   ⚠️  [Codex MCP] Server "${server.name}" has configured auth but no valid token found.`
          );
          const action =
            server.auth?.type === 'oauth'
              ? `Start OAuth Flow for ${server.name}`
              : `check credentials for ${server.name}`;
          console.warn(`      💡 Go to Settings → MCP Servers → ${action}.`);
        }
      } catch (error) {
        console.warn(
          `   ⚠️  [Codex MCP] Failed to resolve auth headers for "${server.name}":`,
          error instanceof Error ? error.message : String(error)
        );
      }

      result[serverName] = serverConfig;
    }

    const total = stdioServers.length + httpServers.length + (mcpToken ? 1 : 0);
    if (total > 0) {
      console.info(`✅ [Codex MCP] Configured ${total} MCP server(s)`);
    }

    return { servers: result, total };
  }

  /**
   * Convert Codex todo_list items to TodoWrite-compatible payload.
   * Codex only provides completed:boolean, so we infer a single in_progress
   * item as the first remaining incomplete step for better UI parity.
   */
  private codexTodosToTodoWriteInput(
    items: Array<{ text: string; completed: boolean }>
  ): Record<string, unknown> | null {
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const firstIncompleteIndex = items.findIndex(todo => !todo.completed);

    return {
      todos: items.map((todo, index) => ({
        content: todo.text,
        activeForm: todo.text,
        status: todo.completed
          ? 'completed'
          : firstIncompleteIndex === -1
            ? 'pending'
            : index === firstIncompleteIndex
              ? 'in_progress'
              : 'pending',
      })),
    };
  }

  /**
   * Convert Codex item to ToolUse format
   * Maps different Codex item types to Disco tool use schema
   */
  private itemToToolUse(
    item: CodexAppServerThreadItem,
    status: 'started' | 'completed',
    commandPurpose?: CommandPurposeClassification
  ): {
    id: string;
    name: string;
    input: Record<string, unknown>;
    output?: string | Array<Record<string, unknown>>;
    status?: string;
  } | null {
    switch (item.type) {
      case 'command_execution':
        return {
          id: item.id,
          name: 'Bash', // Normalized to PascalCase for consistency with Claude Code
          input: {
            command: item.command,
            ...(commandPurpose
              ? {
                  title: commandPurpose.label,
                  purposeSource: commandPurpose.source,
                  purposeConfidence: commandPurpose.confidence,
                }
              : {}),
          },
          ...(status === 'completed' && {
            output: item.aggregated_output || '',
            status: item.status,
          }),
        };
      case 'file_change':
        return {
          id: item.id,
          name: 'edit_files',
          input: {
            changes: item.changes || [],
          },
          ...(status === 'completed' && {
            status: item.status,
          }),
        };
      case 'mcp_tool_call': {
        // Preserve MCP result/error payloads so the UI can render meaningful output.
        // This matches Claude's "start/end + payload" visibility model.
        let mcpOutput: string | Array<Record<string, unknown>> | undefined;
        if (status === 'completed') {
          if (Array.isArray(item.result?.content) && item.result.content.length > 0) {
            mcpOutput = item.result.content as Array<Record<string, unknown>>;
          } else if (item.result?.structured_content !== undefined) {
            mcpOutput = JSON.stringify(item.result.structured_content, null, 2);
          } else if (item.error?.message) {
            mcpOutput = item.error.message;
          }
        }
        return {
          id: item.id,
          name: `${item.server}.${item.tool}`,
          input:
            item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
              ? (item.arguments as Record<string, unknown>)
              : {},
          ...(mcpOutput !== undefined && {
            output: mcpOutput,
          }),
          ...(status === 'completed' && {
            status: item.status,
          }),
        };
      }
      case 'dynamic_tool_call': {
        const output =
          status === 'completed' && item.content_items?.length
            ? (item.content_items as Array<Record<string, unknown>>)
            : undefined;
        return {
          id: item.id,
          name: `client.${item.namespace ? `${item.namespace}.` : ''}${item.tool}`,
          input:
            item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
              ? (item.arguments as Record<string, unknown>)
              : {},
          ...(output ? { output } : {}),
          ...(status === 'completed' ? { status: item.status } : {}),
        };
      }
      case 'image_view':
        return {
          id: item.id,
          name: 'ViewImage',
          input: { filename: imageViewFilename(item.path) },
          ...(status === 'completed' ? { status: 'completed' } : {}),
        };
      case 'image_generation': {
        const output =
          item.saved_path || item.failure
            ? JSON.stringify(
                {
                  ...(item.saved_path ? { savedPath: item.saved_path } : {}),
                  ...(item.failure ? { failure: item.failure } : {}),
                },
                null,
                2
              )
            : undefined;
        return {
          id: item.id,
          name: 'image_generation',
          input: item.revised_prompt ? { prompt: item.revised_prompt } : {},
          ...(status === 'completed' && output ? { output } : {}),
          ...(status === 'completed' ? { status: item.status } : {}),
        };
      }
      case 'web_search':
        return {
          id: item.id,
          name: 'web_search',
          input: { query: item.query },
          ...(status === 'completed' && {
            // Emit a terminal marker so web_search doesn't remain stale in UI.
            status: 'completed',
          }),
        };
      case 'reasoning':
        // Don't emit tool use for reasoning (it's internal)
        return null;
      case 'todo_list': {
        const todoInput = this.codexTodosToTodoWriteInput(item.items);
        if (!todoInput) return null;
        return {
          id: item.id,
          name: 'TodoWrite',
          input: todoInput,
        };
      }
      case 'agent_message':
        // Don't emit tool use for text messages
        return null;
      default:
        return null;
    }
  }

  /**
   * Fork a Codex thread for an Disco forked session.
   *
   * The public TypeScript Codex SDK does not currently expose fork(), but the
   * local Codex App Server does expose `thread/fork`. Keep this as a tiny
   * sidecar: create the forked thread id, persist it to Disco, then continue
   * through the normal SDK `resumeThread(...).runStreamed(...)` path.
   */
  private async ensureForkedCodexThread(
    sessionId: SessionID,
    session: {
      genealogy?: { forked_from_session_id?: SessionID };
      sdk_session_id?: string | null;
    }
  ): Promise<void> {
    if (session.sdk_session_id) return;

    const parentSessionId = session.genealogy?.forked_from_session_id;
    if (!parentSessionId) return;

    const parentSession = await this.sessionsRepo.findById(parentSessionId);
    if (!parentSession?.sdk_session_id) {
      console.warn(
        `⚠️  [Codex] Fork requested from parent ${shortId(parentSessionId)}, but parent has no Codex thread id; starting fresh`
      );
      return;
    }

    console.log(
      `🍴 [Codex] Forking from parent thread ${shortId(parentSession.sdk_session_id)} via app-server thread/fork`
    );

    const appServerEnv = this.buildAppServerEnvironment();

    const forkedThreadId = await forkCodexThreadViaAppServer(parentSession.sdk_session_id, {
      env: appServerEnv,
    });
    await this.sessionsRepo.update(sessionId, { sdk_session_id: forkedThreadId });
    session.sdk_session_id = forkedThreadId;

    console.log(
      `✅ [Codex] Forked thread ${shortId(parentSession.sdk_session_id)} → ${shortId(forkedThreadId)}`
    );
  }

  private async buildTurnInput(
    sessionId: SessionID,
    prompt: string,
    workspacePath: string
  ): Promise<CodexInput> {
    const parsed = parseUploadAttachmentPrompt(prompt);
    if (parsed.attachments.length === 0) return prompt;
    if (!this.executorSessionToken) {
      throw new Error('附件读取失败：当前 Codex 执行器没有会话级文件访问凭据。');
    }

    const materialized: Array<{
      filename: string;
      mimeType: string;
      path: string;
      absolutePath: string;
    }> = [];
    for (const attachment of parsed.attachments) {
      const file = await materializeUploadToWorkspace({
        daemonUrl: await getDaemonUrl(),
        sessionToken: this.executorSessionToken,
        workspacePath,
        params: {
          sessionId,
          uploadRef: attachment.ref,
          filename: attachment.filename,
        },
      });
      materialized.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        path: file.path,
        absolutePath: file.absolutePath,
      });
    }

    const visiblePrompt = parsed.visibleText || '请处理这些附件。';
    const fileMap = materialized
      .map(
        ({ filename, mimeType, path: relativePath }) =>
          `- ${filename}: ${relativePath} (${mimeType})`
      )
      .join('\n');
    const text = `${visiblePrompt}\n\nDisco 已将本次附件放入当前工作区：\n${fileMap}`;
    const input: Exclude<CodexInput, string> = [{ type: 'text', text }];
    for (const attachment of materialized) {
      if (attachment.mimeType.toLowerCase().startsWith('image/')) {
        input.push({ type: 'local_image', path: attachment.absolutePath });
      }
    }
    return input;
  }

  /**
   * Execute prompt with streaming support
   *
   * Uses app-server's local notification protocol over an HTTPS Responses
   * provider. Yields token-level text chunks and complete messages.
   *
   * @param sessionId - Disco session ID
   * @param prompt - User prompt
   * @param taskId - Optional task ID
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   * @param abortController - Optional AbortController for cancellation support
   * @returns Async generator of streaming events
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    abortController?: AbortController,
    onActivity?: SdkActivityCallback
  ): AsyncGenerator<CodexStreamEvent> {
    // Get session to check for existing thread ID and working directory
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    await ensureDiscoCodexRuntimeHome();

    // Session creation stamps the canonical user-owned runtime directory.
    // Executor startup consumes it directly; obsolete carrier metadata is not
    // part of Disco's conversation identity or filesystem model.
    if (!session.working_directory) {
      throw new Error(`Session ${sessionId} has no working directory`);
    }
    const workingDirectory = path.resolve(session.working_directory);
    const userWorkspaceRoot = resolveDiscoUserWorkspaceRoot(workingDirectory);
    if (!userWorkspaceRoot) {
      throw new Error(`Session workspace ${workingDirectory} is not inside a user-* directory`);
    }
    const standaloneConversation = !session.agent_id;
    const isDiscoPersonalWorkspace = true;
    await fs.mkdir(workingDirectory, { recursive: true });

    let agentRuntimeContext: string | undefined;
    if (session.agent_id) {
      if (!this.agentsRepo) throw new Error('Codex Agent repository is unavailable');
      const agent = await this.agentsRepo.findById(session.agent_id);
      if (
        !agent ||
        agent.created_by !== session.created_by ||
        agent.state !== 'ready' ||
        agent.archived
      ) {
        throw new Error(`Agent ${session.agent_id} is unavailable for session ${sessionId}`);
      }
      if (
        !isPathInsideDiscoUserWorkspace(userWorkspaceRoot, agent.workspace_path) ||
        !isPathInsideDiscoUserWorkspace(agent.workspace_path, workingDirectory)
      ) {
        throw new Error(`Agent ${session.agent_id} workspace does not own session ${sessionId}`);
      }
      try {
        agentRuntimeContext = prepareDiscoAgentRuntimeContext({
          agentWorkspace: agent.workspace_path,
          sessionWorkspace: workingDirectory,
        }).content;
      } catch (error) {
        try {
          writeDiscoAgentPreloadFailure(workingDirectory, error);
        } catch {
          // Preserve the context preparation error below.
        }
        throw error;
      }
    }

    // NOTE: API key resolution is already handled by executeToolTask in base-executor
    // The API key was resolved via daemon service and passed to this constructor
    // Use the API key from constructor (this.apiKey)
    const currentApiKey = this.apiKey || '';

    // Only recreate Codex client if API key changed (prevents memory leak - issue #133)
    // This ensures hot-reload of credentials from Settings UI while avoiding process accumulation
    this.refreshClient(currentApiKey);

    codexDebug(`🔍 [Codex] Starting prompt execution for session ${shortId(sessionId)}`);
    codexDebug(`   Permission mode: ${permissionMode || 'not specified (will use default)'}`);
    codexDebug(`   Existing thread ID: ${session.sdk_session_id || 'none (will create new)'}`);

    // Codex permission settings split across two surfaces:
    // - sandboxMode, approvalPolicy, networkAccessEnabled: per-thread via ThreadOptions
    // - MCP servers + model_instructions_file: per-Codex-instance via CodexOptions.config
    // ThreadOptions are emitted AFTER `--config` flags, so for keys that overlap
    // (approval_policy, sandbox_workspace_write.network_access) ThreadOptions win.
    //
    // The daemon resolver (`resolvePermissionConfig`) always emits a full
    // codex sub-config for new sessions, so this fallback only fires for
    // legacy sessions in the DB with a partial / missing `permission_config`.
    // Derive partial-field fallbacks from the effective mode;
    // mode-less legacy sessions use the same canonical system default.
    const codexConfig = session.permission_config?.codex;
    const effectivePermissionMode =
      permissionMode ?? session.permission_config?.mode ?? getDefaultPermissionMode('codex');
    const defaults = mapToCodexPermissionConfig(effectivePermissionMode);
    // Personal Disco workspaces run in a trusted household environment. Do
    // not create per-user Windows ACL profiles: Codex's fixed sandbox accounts
    // mutate the same ACLs and make concurrent users interfere with each other.
    // The short runtime-only boundary in model_instructions_file prevents
    // accidental cross-user access without pretending to be a hard sandbox.
    const sandboxModeEnvOverride = process.env.DISCO_CODEX_SANDBOX_MODE as
      CodexSandboxMode | undefined;
    const configuredSandboxMode = codexConfig?.sandboxMode ?? defaults.sandboxMode;
    // When Disco wraps the whole executor in its own OS-level sandbox (SRT), do
    // NOT let Codex start its own nested bwrap — run full-access INSIDE Disco's
    // sandbox, which already enforces the filesystem/network boundary. One layer.
    const outerSandbox = process.env.DISCO_OUTER_SANDBOX === '1';
    const sandboxMode: CodexSandboxMode = outerSandbox
      ? 'danger-full-access'
      : isDiscoPersonalWorkspace
        ? 'danger-full-access'
        : (sandboxModeEnvOverride ?? configuredSandboxMode);
    const approvalPolicy = isDiscoPersonalWorkspace
      ? 'never'
      : (codexConfig?.approvalPolicy ?? defaults.approvalPolicy);
    const networkAccess = isDiscoPersonalWorkspace
      ? true
      : (codexConfig?.networkAccess ?? defaults.networkAccess);
    // Apps can mutate remote systems outside the filesystem sandbox. Only
    // remove their approval gate for explicit allow-all intent when no
    // per-field or environment override makes the effective policy stricter.
    const shouldAutoApproveApps =
      (isDiscoPersonalWorkspace ||
        (effectivePermissionMode === 'allow-all' && approvalPolicy === 'never')) &&
      configuredSandboxMode !== 'read-only' &&
      sandboxMode !== 'read-only' &&
      networkAccess === true;

    codexDebug(
      `   Using Codex permissions: sandboxMode=${sandboxMode}, approvalPolicy=${approvalPolicy}, networkAccess=${networkAccess}`
    );

    // Agent conversations keep Disco orientation. Standalone chats use the
    // stock Codex instructions and explicitly suppress project AGENTS.md so a
    // plain chat does not accidentally acquire workspace personality or pay
    // the cost of loading unrelated project documents.
    // Both modes run inside Disco's dedicated CODEX_HOME. Only the shared
    // auth.json is present there; desktop config, memory and personal skills do
    // not enter the worker. Browser/Chrome/Computer Use remain hard-disabled.
    const conversationConfig: CodexConfigObject = {
      ...(isDiscoPersonalWorkspace ? { project_doc_max_bytes: 0 } : {}),
      model_instructions_file: await this.ensureCodexInstructionsFile(sessionId, {
        includeDiscoOrientation: !standaloneConversation,
        includeManagedLifecycle: isDiscoPersonalWorkspace,
        agentSession: !standaloneConversation,
        ...(userWorkspaceRoot ? { userWorkspaceRoot } : {}),
        ...(agentRuntimeContext ? { agentRuntimeContext } : {}),
      }),
    };

    // Standalone chats still receive the authenticated Disco MCP lifecycle
    // surface for shared-skill installation and explicit file publication.
    // They remain personality-free because Disco orientation and agent
    // snapshots are still omitted above.
    const mcpToken = session.mcp_token;
    if (!mcpToken) {
      console.warn(
        `⚠️  No MCP token found for session ${shortId(sessionId)} - Disco MCP tools unavailable`
      );
    }

    // forUserId enables per-user OAuth token injection at the MCP scoping
    // layer — the task creator (prompter) when known, else the session owner.
    const forUserId = await resolveContextUserId({
      session,
      taskId,
      tasksService: this.tasksService,
    });
    const { servers: mcpServersConfig, total: mcpServerCount } = await this.buildMcpServersConfig(
      sessionId,
      mcpToken,
      {
        forUserId,
        sessionOwnerId: session.created_by as UserID,
      }
    );

    const codexConfigPayload: CodexConfigObject = {
      // Disco owns durable task continuation. Codex goals can automatically
      // continue after an internal answer without completing the SDK turn.
      features: {
        goals: false,
        // Disco agent workspaces are the sole durable memory authority.
        // Keeping this off also prevents a shared Runtime Home from leaking
        // inferred Codex memories between users or agents.
        memories: false,
        external_agent_memory_import: false,
        // Keep protocol support available for non-personal/custom sessions.
        // Personal Disco sessions run with no interactive approval or ACL
        // profile; their soft account boundary is injected above at runtime.
        request_permissions_tool: !isDiscoPersonalWorkspace,
        exec_permission_approvals: !isDiscoPersonalWorkspace,
      },
      include_permissions_instructions: !isDiscoPersonalWorkspace,
      ...conversationConfig,
      // Fast mode is a request processing tier, not a reasoning-effort alias.
      // Codex CLI maps this config key to the request service tier. Persist an
      // explicit normal tier so switching a live session back from Fast also
      // recreates the SDK client with deterministic config.
      service_tier: session.model_config?.serviceTier === 'fast' ? 'fast' : 'default',
      ...(Object.keys(mcpServersConfig).length > 0 ? { mcp_servers: mcpServersConfig } : {}),
      // Codex Apps (for example the GitHub connector supplied by a plugin)
      // use the separate `apps` policy namespace rather than `mcp_servers`.
      // In headless SDK sessions, an approval prompt cannot be answered and
      // is otherwise reported as "user cancelled MCP tool call". Match the
      // effective allow-all policy without broadening restrictive sessions.
      ...(shouldAutoApproveApps
        ? { apps: { _default: { default_tools_approval_mode: 'approve' } } }
        : {}),
    };

    // The SDK fallback caches its client by configuration. App-server receives
    // the same effective HTTPS provider config when the thread is started or
    // resumed, so it does not need a second dormant SDK client.
    if (this.executionTransport === 'sdk') {
      await this.ensureCodexClient(codexConfigPayload);
    }

    codexDebug(
      `   Configured: sandboxMode=${sandboxMode}, approvalPolicy=${approvalPolicy}, networkAccess=${networkAccess}, ${mcpServerCount} MCP server(s)`
    );

    codexDebug(`   Working directory: ${workingDirectory}`);
    if (userWorkspaceRoot) codexDebug(`   User workspace boundary: ${userWorkspaceRoot}`);

    await this.ensureForkedCodexThread(sessionId, session);

    // Build thread options. approvalPolicy + networkAccessEnabled flow through
    // here (not config.toml); ThreadOptions override matching `--config` keys.
    // model + modelReasoningEffort are passed through from session.model_config
    // so the UI's per-session model picker actually controls what Codex runs.
    const sessionModel = session.model_config?.model;
    const sessionEffort = session.model_config?.effort;
    const threadOptions = {
      workingDirectory,
      // Disco workspaces are ordinary directories, not Git worktrees. Codex
      // must not reject a conversation merely because no repository exists.
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      networkAccessEnabled: networkAccess,
      ...(sessionModel ? { model: sessionModel } : {}),
      // Codex CLI accepts `max`; the SDK's ModelReasoningEffort type currently lags it.
      ...(sessionEffort ? { modelReasoningEffort: sessionEffort as CodexSdkReasoningEffort } : {}),
    };

    // Check if MCP servers were added after session creation
    // Codex SDK locks in MCP configuration at thread creation time
    // If MCP servers were added later, we need to start fresh to pick them up
    let mcpServersAddedAfterCreation = false;
    if (this.sessionMCPServerRepo && session.sdk_session_id) {
      try {
        const sessionMCPServers = await this.sessionMCPServerRepo.listServersWithMetadata(
          sessionId,
          true
        );
        const sessionCreatedAt = new Date(session.created_at).getTime();
        const sessionLastUpdated = session.last_updated
          ? new Date(session.last_updated).getTime()
          : sessionCreatedAt;
        const sessionReferenceTime = Math.max(sessionCreatedAt, sessionLastUpdated);

        for (const sms of sessionMCPServers) {
          if (sms.enabled && sms.added_at > sessionReferenceTime) {
            mcpServersAddedAfterCreation = true;
            const minutesAfterReference = Math.round(
              (sms.added_at - sessionReferenceTime) / 1000 / 60
            );
            console.warn(
              `⚠️  [Codex MCP] Server "${sms.server.name}" was added ${minutesAfterReference} minute(s) after the session last updated`
            );
            break;
          }
        }
      } catch (error) {
        console.warn('⚠️  [Codex] Failed to check MCP server timestamps:', error);
      }
    }

    if (mcpServersAddedAfterCreation && session.sdk_session_id) {
      console.warn(
        `⚠️  [Codex MCP] MCP servers were added after the last SDK sync - current thread won't see them!`
      );
      console.warn(`   🔧 SOLUTION: Clearing sdk_session_id to force fresh thread start`);
      console.warn(
        `   Previous SDK thread: ${shortId(session.sdk_session_id)} (will be discarded)`
      );

      // Clear SDK session ID to force fresh start with new MCP config
      await this.sessionsRepo.update(sessionId, { sdk_session_id: null });
      // Update local session object to reflect the change
      session.sdk_session_id = undefined;
    }

    const resumeThreadId = session.sdk_session_id;
    const startedFreshThread = !resumeThreadId;

    // Check if we need to update thread settings due to approval policy change
    const previousApprovalPolicy = session.permission_config?.codex?.approvalPolicy || 'on-request';
    const approvalPolicyChanged = approvalPolicy !== previousApprovalPolicy;

    // Start or resume thread. App-server is local stdio IPC; Codex's upstream
    // model connection remains the explicitly configured HTTPS/SSE provider.
    let thread: Thread;
    let appServerThread: CodexAppServerThread | undefined;
    if (this.executionTransport === 'app-server') {
      const codexOptions = this.buildCodexOptions(
        this.apiKey,
        this.resolveBaseUrl(),
        codexConfigPayload
      );
      appServerThread = new CodexAppServerThread({
        ...(resumeThreadId ? { resumeThreadId } : {}),
        threadOptions,
        config: (codexOptions?.config ?? {}) as Record<string, unknown>,
        clientOptions: {
          env: this.buildAppServerEnvironment(),
        },
      });
      thread = appServerThread as unknown as Thread;
      this.activeAppServerThreads.set(sessionId, appServerThread);
      codexDebug(
        `🌊 [Codex] Using app-server delta protocol over HTTPS Responses (${resumeThreadId ? 'resume' : 'new thread'})`
      );
    } else if (resumeThreadId) {
      codexDebug(`🔄 [Codex] Resuming thread: ${resumeThreadId}`);

      thread = this.getCodexClient().resumeThread(resumeThreadId, threadOptions);

      // If approval policy changed, send slash command to update thread settings
      if (approvalPolicyChanged) {
        console.log(
          `⚙️  [Codex] Approval policy changed: ${previousApprovalPolicy} → ${approvalPolicy}`
        );
        console.log(`   Sending slash command to update thread settings...`);

        // Send /approvals command to change approval policy mid-conversation
        // Note: sandboxMode is already updated via ThreadOptions on resumeThread()
        const slashCommand = `/approvals ${approvalPolicy}`;
        console.log(`   Executing: ${slashCommand}`);

        try {
          // Send the slash command and consume the response
          await thread.run(slashCommand);
          console.log(`✅ [Codex] Thread settings updated successfully`);
        } catch (error) {
          console.error(`❌ [Codex] Failed to update thread settings:`, error);
          // Continue anyway - the user's prompt will still be sent
        }
      }
    } else {
      codexDebug(`🆕 [Codex] Creating new thread`);
      if (mcpServerCount > 0) {
        codexDebug(
          `✅ [Codex MCP] New thread will have ${mcpServerCount} MCP server(s) available via --config flags`
        );
      }
      thread = this.getCodexClient().startThread(threadOptions);
    }

    let receivedTerminalEvent = false;
    const clearFreshThreadResumeState = async () => {
      if (startedFreshThread) {
        await this.sessionsRepo.update(sessionId, {
          sdk_session_id: null,
        });
      }
    };

    try {
      codexDebug(
        `▶️  [Codex] Running prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`
      );

      // NOTE: User environment variables are already in process.env
      // The daemon passes them when spawning the executor via createUserProcessEnvironment()
      // No need to query the database again here!

      // Clear any stale stop flag from previous executions
      // This prevents a stop request meant for a previous prompt from affecting this one
      if (this.stopRequested.has(sessionId)) {
        console.log(
          `⚠️  Clearing stale stop flag for session ${sessionId} before starting new prompt`
        );
        this.stopRequested.delete(sessionId);
      }

      // Use streaming API with abort signal for proper cancellation support
      // The signal is passed to Codex SDK which will throw AbortError when aborted
      codexDebug(`🎬 [Codex] Starting streamed turn for session ${shortId(sessionId)}`);
      const rolloutUsageMonitor = new CodexRolloutUsageMonitor(
        getCodexHomeCandidates(),
        Date.now()
      );
      if (session.sdk_session_id) {
        // Capture the thread's lifetime total before this turn starts. Later
        // rollout snapshots can then be converted to task-local deltas.
        await rolloutUsageMonitor.primeExistingThread(session.sdk_session_id);
      }
      const codexInput = await this.buildTurnInput(sessionId, prompt, workingDirectory);
      const turnOptions = abortController ? { signal: abortController.signal } : undefined;
      const { events } = await thread.runStreamed(codexInput, turnOptions);
      if (resumeThreadId && thread.id && thread.id !== resumeThreadId) {
        console.warn(
          `⚠️  [Codex] Durable thread ${shortId(resumeThreadId)} is unavailable in the current Runtime Home; continuing as ${shortId(thread.id)}`
        );
        // Clear the stale id before CodexTool observes the first streamed event.
        // Its normal capture path will then persist thread.id as the new source
        // of continuity without treating this deliberate migration as data loss.
        await this.sessionsRepo.update(sessionId, { sdk_session_id: null });
        session.sdk_session_id = undefined;
      }
      codexDebug(`✅ [Codex] Stream initialized, starting event iteration`);

      const currentMessage: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        content?: string | Array<Record<string, unknown>>;
        is_error?: boolean;
        [key: string]: unknown;
      }> = [];
      let threadId = session.sdk_session_id || '';
      const resolvedModel: string | undefined = session.model_config?.model || undefined;
      let allToolUses: CompletedToolUse[] = [];
      let citationUploadRefs = new Set<string>();
      let citationStreamFilters = new Map<string, CodexFileCitationStreamFilter>();
      let cachedDaemonUrl: string | undefined;
      const publicationDaemonUrl = async (): Promise<string> => {
        cachedDaemonUrl ??= await getDaemonUrl().catch(() => '');
        return cachedDaemonUrl;
      };
      let imageViewPreviewCache = new Map<string, Promise<ToolImageContentBlock>>();
      const resolveImageViewPreview = (filePath: string): Promise<ToolImageContentBlock> => {
        const normalizedPath = path.normalize(filePath).replaceAll('\\', '/').toLowerCase();
        const cached = imageViewPreviewCache.get(normalizedPath);
        if (cached) return cached;

        const pending = (async (): Promise<ToolImageContentBlock> => {
          try {
            const publicationToolUses = await publishGeneratedArtifacts({
              daemonUrl: await publicationDaemonUrl(),
              sessionToken: mcpToken,
              filePaths: [filePath],
            });
            const attachment = extractExplicitlyPublishedAttachments(publicationToolUses).find(
              candidate => candidate.mimeType.toLowerCase().startsWith('image/')
            );
            if (!attachment) return unavailableImageView(filePath);
            return {
              type: 'image',
              upload_ref: attachment.ref,
              filename: attachment.filename,
              mime_type: attachment.mimeType,
              size: attachment.size,
              available: true,
            };
          } catch {
            return unavailableImageView(filePath);
          }
        })();
        imageViewPreviewCache.set(normalizedPath, pending);
        return pending;
      };
      const resolveCitationText = async (
        text: string
      ): Promise<Array<{ type: string; text?: string; [key: string]: unknown }>> => {
        const resolved = await resolveCodexFileCitations({
          text,
          workingDirectory,
          sessionId,
          daemonUrl: await publicationDaemonUrl(),
          sessionToken: mcpToken,
          priorToolUses: allToolUses,
        });
        allToolUses.push(...resolved.publicationToolUses);
        for (const citation of resolved.citations) {
          if (citation.upload_ref) citationUploadRefs.add(citation.upload_ref);
        }
        return resolved.content;
      };
      const resolveCurrentMessageCitations = async (): Promise<void> => {
        const resolvedBlocks: typeof currentMessage = [];
        for (const block of currentMessage) {
          if (block.type === 'text' && typeof block.text === 'string') {
            resolvedBlocks.push(...(await resolveCitationText(block.text)));
          } else {
            resolvedBlocks.push(block);
          }
        }
        currentMessage.splice(0, currentMessage.length, ...resolvedBlocks);
      };
      const publishHostGeneratedArtifacts = async (): Promise<void> => {
        const filePaths = generatedArtifactPathsFromToolUses(allToolUses);
        if (filePaths.length === 0) return;
        const daemonUrl = await getDaemonUrl().catch(() => '');
        const publicationToolUses = await publishGeneratedArtifacts({
          daemonUrl,
          sessionToken: mcpToken,
          filePaths,
        });
        allToolUses.push(...publicationToolUses);
      };
      let todoIdsEmittedViaUpdate = new Set<string>();
      const commandPurposeClassifier = this.getCommandPurposeClassifier(
        String(forUserId ?? session.created_by)
      );
      let commandPurposes = new Map<string, CommandPurposeClassification>();
      let completedCommandPurposeIds = new Set<string>();
      let latestContextUsage: ContextUsageSnapshot | undefined;
      let cumulativeUsageBaseline: TokenUsage | undefined;
      let hasVisibleAssistantText = false;
      let contextCompactionEmitted = false;

      const pollRolloutUsage = async (forceLocate = false) => {
        const snapshots = await rolloutUsageMonitor.poll(
          thread.id || threadId || session.sdk_session_id || undefined,
          forceLocate
        );
        for (const snapshot of snapshots) {
          latestContextUsage = snapshot.rawContextUsage ?? latestContextUsage;
        }
        return snapshots;
      };

      const ensureVisibleCompletion = () => {
        if (
          hasVisibleAssistantText ||
          currentMessage.some(
            block =>
              (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) ||
              block.type === 'file_citation'
          )
        ) {
          return;
        }
        currentMessage.push({
          type: 'text',
          text: '本次运行没有返回可展示的文字或媒体结果。会话仍可继续；这通常表示当前 Codex 运行环境没有提供请求所需的工具。',
        });
        hasVisibleAssistantText = true;
      };

      let eventCount = 0;
      let didStop = false;

      const eventIterator = events[Symbol.asyncIterator]();
      let pendingEvent = eventIterator.next();
      while (true) {
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const winner = await Promise.race([
          pendingEvent.then(result => ({ kind: 'sdk' as const, result })),
          new Promise<{ kind: 'poll' }>(resolve => {
            pollTimer = setTimeout(
              () => resolve({ kind: 'poll' }),
              CODEX_ROLLOUT_USAGE_POLL_INTERVAL_MS
            );
          }),
        ]);
        if (pollTimer) clearTimeout(pollTimer);

        // Stop must not wait for a provider event. The rollout poll wake-up is
        // also a cancellation checkpoint, and app-server maps abort to the
        // explicit `turn/interrupt` request before its process is closed.
        if (this.stopRequested.get(sessionId)) {
          console.log(`🛑 Stop requested for session ${sessionId}, interrupting Codex turn`);
          this.stopRequested.delete(sessionId);
          didStop = true;
          abortController?.abort();
          await eventIterator.return?.(undefined);
          yield {
            type: 'stopped',
            threadId: thread.id || undefined,
          };
          return;
        }

        if (winner.kind === 'poll') {
          for (const snapshot of await pollRolloutUsage()) {
            yield {
              type: 'usage_snapshot',
              usage: snapshot.usage,
              observedAt: snapshot.observedAt,
              rawContextUsage: snapshot.rawContextUsage,
              threadId: thread.id || undefined,
              resolvedModel,
            };
          }
          continue;
        }

        if (winner.result.done) break;
        const event = winner.result.value as CodexAppServerThreadEvent;
        pendingEvent = eventIterator.next();
        eventCount++;
        codexDebug(`📨 [Codex] Event ${eventCount}: ${event.type}`);

        const activityEvent = event as { type: string; payload?: { type?: string } };
        const activityPayloadType =
          activityEvent.type === 'event_msg' ? activityEvent.payload?.type : undefined;
        reportSdkActivity(
          onActivity,
          'codex',
          activityPayloadType ? `${activityEvent.type}.${activityPayloadType}` : activityEvent.type
        );

        if (event.type === 'agent_message_delta') {
          const filter =
            citationStreamFilters.get(event.itemId) ?? new CodexFileCitationStreamFilter();
          citationStreamFilters.set(event.itemId, filter);
          const visibleDelta = event.delta ? filter.push(event.delta) : '';
          if (visibleDelta) {
            hasVisibleAssistantText = true;
            yield {
              type: 'partial',
              textChunk: visibleDelta,
              threadId: thread.id || undefined,
              resolvedModel,
            };
          }
          continue;
        }

        if (event.type === 'turn.interrupted') {
          receivedTerminalEvent = true;
          didStop = true;
          yield { type: 'stopped', threadId: thread.id || undefined };
          return;
        }

        if (event.type === 'context.compacted') {
          if (!contextCompactionEmitted) {
            contextCompactionEmitted = true;
            yield {
              type: 'context_compacted',
              threadId: thread.id || undefined,
              observedAt: new Date().toISOString(),
            };
          }
          continue;
        }

        if (event.type === 'capacity.retrying') {
          yield {
            type: 'capacity_retry',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            threadId: thread.id || undefined,
          };
          continue;
        }

        if (event.type === 'capacity.recovered') {
          yield {
            type: 'capacity_recovered',
            threadId: thread.id || undefined,
          };
          continue;
        }

        if ((event as { type?: string }).type === 'event_msg') {
          const eventPayload = (event as { payload?: Record<string, unknown> }).payload;
          const payloadType = eventPayload?.type;

          if (payloadType === 'token_count') {
            // Codex emits token_count as generic event_msg payloads.
            // Capture context occupancy and expose a per-task accounting delta.
            // total_token_usage is lifetime-cumulative for the thread, so on
            // the first event of this turn derive the prior lifetime baseline
            // as cumulative - last_call. Later snapshots subtract that fixed
            // baseline and therefore never double-count previous tasks.
            const contextSnapshot = extractCodexContextSnapshotFromEvent(event);
            if (contextSnapshot) {
              latestContextUsage = contextSnapshot;
            }
            const accounting = extractCodexTokenCountUsageFromEvent(event);
            if (accounting) {
              if (!cumulativeUsageBaseline && accounting.last) {
                cumulativeUsageBaseline = subtractCodexTokenUsage(
                  accounting.cumulative,
                  accounting.last
                );
              }
              if (cumulativeUsageBaseline) {
                yield {
                  type: 'usage_snapshot',
                  usage: subtractCodexTokenUsage(accounting.cumulative, cumulativeUsageBaseline),
                  observedAt:
                    typeof (event as unknown as { timestamp?: unknown }).timestamp === 'string'
                      ? (event as unknown as { timestamp: string }).timestamp
                      : undefined,
                  rawContextUsage: contextSnapshot,
                  threadId: thread.id || undefined,
                  resolvedModel,
                };
              }
            }
            continue;
          }

          if (payloadType === 'context_compacted') {
            if (!contextCompactionEmitted) {
              contextCompactionEmitted = true;
              yield {
                type: 'context_compacted',
                threadId: thread.id || undefined,
                observedAt:
                  typeof (event as unknown as { timestamp?: unknown }).timestamp === 'string'
                    ? (event as unknown as { timestamp: string }).timestamp
                    : new Date().toISOString(),
              };
            }
            continue;
          }

          if (payloadType === 'agent_message') {
            // New Codex rollout format: final assistant text surfaces via event_msg
            // rather than an item.completed(agent_message) item.
            const text =
              typeof eventPayload?.content === 'string'
                ? eventPayload.content
                : typeof eventPayload?.text === 'string'
                  ? eventPayload.text
                  : typeof eventPayload?.message === 'string'
                    ? eventPayload.message
                    : '';
            if (text) {
              currentMessage.push({ type: 'text', text });
              hasVisibleAssistantText = true;
            }
            continue;
          }

          if (payloadType === 'task_complete' || payloadType === 'turn_complete') {
            // Terminal completion event from new Codex rollout format.
            // Treat as equivalent to turn.completed.
            receivedTerminalEvent = true;
            threadId = thread.id || '';
            for (const snapshot of await pollRolloutUsage(true)) {
              yield {
                type: 'usage_snapshot',
                usage: snapshot.usage,
                observedAt: snapshot.observedAt,
                rawContextUsage: snapshot.rawContextUsage,
                threadId: thread.id || undefined,
                resolvedModel,
              };
            }
            const taskCompleteUsage =
              rolloutUsageMonitor.getLatestUsage() ??
              extractCodexTokenUsage((eventPayload?.usage ?? eventPayload?.token_usage) as unknown);
            const contextUsage =
              latestContextUsage ??
              rolloutUsageMonitor.getLatestContextUsage() ??
              (await extractLatestContextUsageFromRollout(
                thread.id || '',
                getCodexHomeCandidates()
              ));

            // Synthesize final assistant text from last_agent_message unless
            // a preceding agent_message event already pushed the same text.
            // This preserves distinct progress/final messages without duplicating.
            const lastAgentMessage =
              typeof eventPayload?.last_agent_message === 'string'
                ? eventPayload.last_agent_message
                : '';
            const hasSameTextContent = currentMessage.some(
              block => block.type === 'text' && block.text === lastAgentMessage
            );
            if (lastAgentMessage && !hasSameTextContent) {
              currentMessage.push({ type: 'text', text: lastAgentMessage });
              hasVisibleAssistantText = true;
            }

            await resolveCurrentMessageCitations();
            await publishHostGeneratedArtifacts();
            appendVerifiedToolOutcomeNotices({
              content: currentMessage,
              toolUses: allToolUses,
              excludedAttachmentRefs: citationUploadRefs,
            });
            ensureVisibleCompletion();

            codexDebug(
              `✅ [Codex] terminal event_msg (${payloadType}) received for session ${shortId(sessionId)}`
            );

            yield {
              type: 'complete',
              content: currentMessage,
              toolUses: allToolUses.length > 0 ? allToolUses : undefined,
              threadId,
              resolvedModel,
              usage: taskCompleteUsage,
              rawContextUsage: contextUsage,
            };

            return;
          }

          // Unknown event_msg payload type — ignore silently.
          codexDebug(`[Codex] Unknown event_msg payload type: ${String(payloadType)}`);
          continue;
        }

        switch (event.type) {
          case 'turn.started':
            allToolUses = []; // Reset tool uses for new turn
            citationUploadRefs = new Set<string>();
            citationStreamFilters = new Map<string, CodexFileCitationStreamFilter>();
            imageViewPreviewCache = new Map<string, Promise<ToolImageContentBlock>>();
            todoIdsEmittedViaUpdate = new Set<string>();
            commandPurposes = new Map<string, CommandPurposeClassification>();
            completedCommandPurposeIds = new Set<string>();
            latestContextUsage = undefined;
            break;

          case 'item.started':
            // Emit tool_start events for tool items
            if (event.item) {
              let commandPurpose: CommandPurposeClassification | undefined;
              if (event.item.type === 'command_execution') {
                commandPurpose = await commandPurposeClassifier.classifyImmediate(
                  event.item.command
                );
                commandPurposes.set(event.item.id, commandPurpose);
                if (commandPurpose.needsModel) {
                  const nearbyContext = currentMessage
                    .filter(
                      block =>
                        block.type === 'text' &&
                        typeof block.text === 'string' &&
                        block.text.trim().length > 0
                    )
                    .slice(-2)
                    .map(block => block.text as string)
                    .join(' ');
                  void commandPurposeClassifier
                    .refine(event.item.command, nearbyContext)
                    .then(refined => {
                      if (!completedCommandPurposeIds.has(event.item.id)) {
                        commandPurposes.set(event.item.id, refined);
                      }
                    })
                    .catch(() => undefined);
                }
              }
              const toolUseStart = this.itemToToolUse(event.item, 'started', commandPurpose);
              if (toolUseStart) {
                yield {
                  type: 'tool_start',
                  toolUse: toolUseStart,
                  threadId: thread.id || undefined,
                };
              }
            }
            break;

          case 'item.updated':
            // Codex emits item.updated for todo_list progress updates.
            // Normalize these into TodoWrite-style tool events so the UI can
            // reuse the same sticky todo rendering as Claude Code.
            if (event.item) {
              const toolUseUpdate = this.itemToToolUse(event.item, 'completed');
              if (toolUseUpdate?.name === 'TodoWrite') {
                todoIdsEmittedViaUpdate.add(toolUseUpdate.id);
                yield {
                  type: 'tool_complete',
                  toolUse: toolUseUpdate,
                  threadId: thread.id || undefined,
                };
              }
            }
            break;

          case 'item.completed':
            // Collect completed items and emit tool_complete events
            if (event.item) {
              // Emit tool_complete for tool items
              let commandPurpose = commandPurposes.get(event.item.id);
              if (event.item.type === 'command_execution' && !commandPurpose) {
                commandPurpose = await commandPurposeClassifier.classifyImmediate(
                  event.item.command
                );
              }
              let toolUseComplete = this.itemToToolUse(event.item, 'completed', commandPurpose);
              if (toolUseComplete?.name === 'ViewImage' && event.item.type === 'image_view') {
                const preview = await resolveImageViewPreview(event.item.path);
                toolUseComplete = {
                  ...toolUseComplete,
                  input: { filename: preview.filename },
                  output: [preview as unknown as Record<string, unknown>],
                };
              }
              if (event.item.type === 'command_execution') {
                completedCommandPurposeIds.add(event.item.id);
                commandPurposes.delete(event.item.id);
              }
              if (toolUseComplete) {
                const isDuplicateTodoCompletion =
                  event.item.type === 'todo_list' &&
                  todoIdsEmittedViaUpdate.has(toolUseComplete.id);

                // Add to allToolUses for backward compatibility (tool_uses field)
                allToolUses.push({
                  id: toolUseComplete.id,
                  name: toolUseComplete.name,
                  input: toolUseComplete.input,
                  output: toolUseComplete.output,
                  status: toolUseComplete.status,
                });

                // Add tool_use block to content array (for UI rendering)
                currentMessage.push({
                  type: 'tool_use',
                  id: toolUseComplete.id,
                  name: toolUseComplete.name,
                  input: toolUseComplete.input,
                });

                // Add tool_result block if we have output OR status (for UI rendering)
                if (toolUseComplete.output !== undefined || toolUseComplete.status) {
                  const isError =
                    toolUseComplete.status === 'failed' || toolUseComplete.status === 'error';

                  // Build content: prefer output, fall back to status message
                  let content = toolUseComplete.output || '';
                  if (!content && toolUseComplete.status) {
                    content = `[${toolUseComplete.status}]`;
                  }

                  currentMessage.push({
                    type: 'tool_result',
                    tool_use_id: toolUseComplete.id,
                    content,
                    is_error: isError,
                  });
                }

                if (!isDuplicateTodoCompletion) {
                  yield {
                    type: 'tool_complete',
                    toolUse: toolUseComplete,
                    threadId: thread.id || undefined,
                  };
                }
              }

              // Emit intermediate text messages immediately (instead of batching to turn end)
              // Codex can emit multiple agent_message items per turn, interleaved with tool calls.
              // Yielding them immediately gives a "chatty" UX where users see text as it arrives.
              if ('text' in event.item && event.item.type === 'agent_message') {
                const itemText = event.item.text as string;
                citationStreamFilters.get(event.item.id)?.reset();
                citationStreamFilters.delete(event.item.id);
                const textContent = await resolveCitationText(itemText);
                if (textContent.length > 0) hasVisibleAssistantText = true;

                yield {
                  type: 'complete',
                  content: textContent,
                  threadId: thread.id || '',
                  resolvedModel,
                  // No usage data for intermediate messages - only final turn.completed has it
                };
              }

              // Surface reasoning as thinking blocks (non-streaming) so Codex reuses
              // the same ThinkingBlock UI used by Claude/OpenCode.
              if ('text' in event.item && event.item.type === 'reasoning') {
                const thinkingContent = [{ type: 'thinking', text: event.item.text as string }];
                yield {
                  type: 'complete',
                  content: thinkingContent,
                  threadId: thread.id || '',
                  resolvedModel,
                };
              }

              // Surface non-fatal item-level errors as assistant text so users can see
              // what happened instead of dropping them silently.
              if ('message' in event.item && event.item.type === 'error') {
                const errorContent = [
                  { type: 'text', text: `[Codex item error] ${event.item.message}` },
                ];
                hasVisibleAssistantText = true;
                yield {
                  type: 'complete',
                  content: errorContent,
                  threadId: thread.id || '',
                  resolvedModel,
                };
              }
            }
            break;

          case 'turn.completed': {
            // Turn complete, emit final message
            receivedTerminalEvent = true;
            threadId = thread.id || '';
            for (const snapshot of await pollRolloutUsage(true)) {
              yield {
                type: 'usage_snapshot',
                usage: snapshot.usage,
                observedAt: snapshot.observedAt,
                rawContextUsage: snapshot.rawContextUsage,
                threadId: thread.id || undefined,
                resolvedModel,
              };
            }
            // turn.completed.usage is lifetime-cumulative in the observed CLI
            // build. Prefer the rollout-derived task delta whenever available.
            const mappedUsage =
              rolloutUsageMonitor.getLatestUsage() ??
              extractCodexTokenUsage((event as { usage?: unknown }).usage);
            const contextUsage =
              latestContextUsage ??
              rolloutUsageMonitor.getLatestContextUsage() ??
              (await extractLatestContextUsageFromRollout(
                thread.id || '',
                getCodexHomeCandidates()
              ));

            await resolveCurrentMessageCitations();
            await publishHostGeneratedArtifacts();
            appendVerifiedToolOutcomeNotices({
              content: currentMessage,
              toolUses: allToolUses,
              excludedAttachmentRefs: citationUploadRefs,
            });
            ensureVisibleCompletion();

            // Yield complete message with all tool uses
            yield {
              type: 'complete',
              content: currentMessage,
              toolUses: allToolUses.length > 0 ? allToolUses : undefined,
              threadId,
              resolvedModel,
              usage: mappedUsage,
              rawSdkEvent: event, // Pass through the actual SDK event (UNMUTATED)
              rawContextUsage: contextUsage,
            };

            // Exit the event loop after turn completion
            // Codex SDK doesn't always close the stream properly, so we break manually
            return;
          }

          case 'turn.failed': {
            receivedTerminalEvent = true;
            // Classify error for better user-facing messages
            const errorMessage =
              typeof event.error === 'string' ? event.error : JSON.stringify(event.error, null, 2);

            if (isCodexCapacityError(errorMessage)) {
              console.warn(
                `⚠️  [Codex] Model capacity remained unavailable for session ${shortId(sessionId)}`
              );
              throw new Error(codexCapacityUserMessage());
            }

            if (this.useNativeAuth && !this.apiKey && isCodexSubscriptionAuthError(errorMessage)) {
              throw new Error(codexSubscriptionAuthUserMessage());
            }

            // Detect 401/auth errors and provide actionable guidance
            if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
              const hasApiKey = !!this.apiKey;
              const guidance = hasApiKey
                ? 'Your OPENAI_API_KEY may be invalid or expired. Check Settings > Codex > Authentication, or run `codex login` for ChatGPT subscription auth.'
                : this.useNativeAuth
                  ? 'No API key configured and the shared ChatGPT subscription login was rejected or missing. Reconnect Codex in Settings > Codex Connection, or add an API key there.'
                  : 'No API key configured. Add one in Settings > Codex > Authentication, or sign in via `codex login`.';
              console.error(
                `❌ [Codex] Authentication failed for session ${shortId(sessionId)}: ${guidance}`
              );
              throw new Error(`Codex authentication failed: ${guidance}`);
            }

            // Log full error details for non-auth failures
            console.error(
              `❌ [Codex] Turn failed for session ${shortId(sessionId)}:`,
              errorMessage
            );
            throw new Error(`Codex execution failed: ${errorMessage}`);
          }

          case 'error': {
            const streamErrorMessage = (event as { message?: unknown }).message;
            if (
              typeof streamErrorMessage === 'string' &&
              /^Reconnecting\.\.\.\s*\d+\s*\/\s*\d+\b/.test(streamErrorMessage)
            ) {
              console.warn(`⚠️  [Codex] ${streamErrorMessage}`);
              break;
            }

            if (isCodexCapacityError(streamErrorMessage)) {
              throw new Error(codexCapacityUserMessage());
            }

            if (
              this.useNativeAuth &&
              !this.apiKey &&
              isCodexSubscriptionAuthError(streamErrorMessage)
            ) {
              throw new Error(codexSubscriptionAuthUserMessage());
            }

            // Fatal stream-level error from Codex SDK.
            // Surface this as a task failure so users see it in the conversation.
            throw new Error(
              `Codex stream error: ${
                (event as { message?: unknown; error?: unknown }).message ||
                (event as { message?: unknown; error?: unknown }).error ||
                'unknown'
              }`
            );
          }

          default:
            // Ignore other event types silently
            break;
        }
      }

      // If we reach here without returning, the stream ended.
      // A user-requested stop is a valid early exit; anything else means Codex
      // exited without emitting a terminal event (turn.completed / task_complete / turn_complete),
      // which is the bug described in issue #1749.
      if (!didStop) {
        throw new Error(
          'Codex stream ended without a terminal completion event (turn.completed, task_complete, or turn_complete). ' +
            'The Codex process may have exited unexpectedly (check the executor logs for exit code 0 clues). ' +
            'This is usually resolved by retrying the prompt; if it persists, restart the session.'
        );
      }
    } catch (error) {
      const wasCancelled =
        abortController?.signal.aborted === true ||
        (error instanceof Error && error.name === 'AbortError');
      if (wasCancelled) {
        console.log(
          `🛑 [Stop] Codex query aborted for session ${shortId(sessionId)} - this is expected`
        );
        // Yield stopped event to signal execution was halted
        yield { type: 'stopped', threadId: thread.id || undefined };
        // Don't throw - this is a clean stop, not an error
        return;
      }

      if (!receivedTerminalEvent) {
        await clearFreshThreadResumeState();
      }

      // Don't log here — error will be logged by the caller (base-executor)
      // to avoid duplicate error output in daemon logs
      throw error;
    } finally {
      if (appServerThread && this.activeAppServerThreads.get(sessionId) === appServerThread) {
        this.activeAppServerThreads.delete(sessionId);
      }
    }
  }

  async steerTask(sessionId: SessionID, prompt: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    let thread = this.activeAppServerThreads.get(sessionId);
    while (!thread && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      thread = this.activeAppServerThreads.get(sessionId);
    }
    if (!thread) throw new Error('No active Codex turn found for this session');

    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!session.working_directory)
      throw new Error(`Session ${sessionId} has no working directory`);
    const workingDirectory = path.resolve(session.working_directory);
    await fs.mkdir(workingDirectory, { recursive: true });
    const input = await this.buildTurnInput(sessionId, prompt, workingDirectory);
    await thread.steer(input);
  }

  /**
   * Execute prompt (non-streaming version)
   *
   * Collects all streaming events and returns complete result.
   *
   * @param sessionId - Disco session ID
   * @param prompt - User prompt
   * @param taskId - Optional task ID
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   * @returns Complete prompt result
   */
  async promptSession(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode
  ): Promise<CodexPromptResult> {
    // Note: promptSessionStreaming will handle per-user API key resolution and refreshClient()
    const messages: CodexPromptResult['messages'] = [];
    let threadId = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let tokenUsage: TokenUsage | undefined;
    let resolvedModel: string | undefined;

    for await (const event of this.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      if (event.type === 'complete') {
        messages.push({
          content: event.content,
          toolUses: event.toolUses,
        });
        threadId = event.threadId;
        resolvedModel = event.resolvedModel || resolvedModel;
        if (event.usage) {
          tokenUsage = event.usage;
          inputTokens = event.usage.input_tokens ?? inputTokens;
          outputTokens = event.usage.output_tokens ?? outputTokens;
        }
      }
      // Skip partial events in non-streaming mode
    }

    return {
      messages,
      inputTokens,
      outputTokens,
      threadId,
      tokenUsage,
      resolvedModel,
    };
  }

  /**
   * Stop currently executing task
   *
   * Primary cancellation is handled via AbortController.signal. App-server
   * converts it to `turn/interrupt`; the SDK rollback throws AbortError.
   *
   * This method sets a backup flag that is checked in the event loop (for cases where
   * AbortController may not immediately interrupt the SDK's async iteration).
   *
   * @param sessionId - Session identifier
   * @returns Success status
   */
  stopTask(sessionId: SessionID): { success: boolean; reason?: string } {
    // Set stop flag as backup mechanism
    // Primary cancellation happens via AbortController.signal passed to SDK
    this.stopRequested.set(sessionId, true);
    console.log(`🛑 Stop requested for Codex session ${sessionId}`);

    return { success: true };
  }

  /**
   * Clean up session resources (e.g., on session close)
   *
   * Best-effort removal of the per-session instructions file. Both possible
   * paths (os.tmpdir + ~/.disco/tmp fallback) are attempted in case the
   * tmpdir base differs from the one we wrote to.
   *
   * NOTE: as of writing, no daemon code path actually invokes
   * `closeSession()` for any tool (Codex/Gemini/Copilot all expose it; none
   * are wired to a terminal-state hook). The constructor's
   * `sweepStaleInstructionsFiles()` self-heals leaked files so this isn't
   * load-bearing today — but the method stays in place so the fix becomes
   * a one-line wire-up the day a real lifecycle hook lands.
   */
  async closeSession(sessionId: SessionID): Promise<void> {
    const fileName = `disco-codex-instructions-${sessionId}.md`;
    const recordedPath = this.instructionsFilePaths.get(sessionId);
    const candidatePaths = new Set<string>([
      ...(recordedPath ? [recordedPath] : []),
      path.join(os.tmpdir(), fileName),
      path.join(os.homedir(), '.disco', 'tmp', fileName),
    ]);

    for (const filePath of candidatePaths) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`⚠️  Failed to remove Codex instructions file at ${filePath}:`, error);
        }
      }
    }
    this.instructionsFilePaths.delete(sessionId);

    // Clean up session-scoped MCP bearer token env vars
    const envPrefix = `DISCO_MCP_${shortId(sessionId)}_`;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(envPrefix)) {
        delete process.env[key];
      }
    }

    // Clean up stop flag
    this.stopRequested.delete(sessionId);
  }
}
