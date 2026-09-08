/**
 * Disco Config Manager
 *
 * Handles loading and saving YAML configuration file.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { type InstallableAgenticTool, isInstallableAgenticTool } from '../agentic-integrations';
import type { AgenticToolName } from '../types';
import { normalizeHttpBaseUrl } from '../utils/url';
import { getDefaultAnalyticsConfig } from './analytics-defaults.js';
import { DAEMON, MCP_TOKEN } from './constants';
import { validateRedisKeyPrefix, validateRedisUrl } from './deployment';
import {
  resolveDispatchConnectTimeoutMs,
  resolveExecutorHeartbeatConfig,
  resolveSdkWatchdogConfig,
} from './executor-heartbeat';
import { assertValidMultiTenancyConfig } from './multitenancy';
import {
  type DiscoConfig,
  type UnixUserMode,
  type UnknownJson,
} from './types';

// ---------------------------------------------------------------------------
// In-memory cache for the default-path config
//
// The daemon's hot paths call loadConfig()/loadConfigSync() per-request — 10+
// times in request and executor setup paths. Each call re-reads the YAML from disk and parses
// it. That's wasted work for a file that rarely changes.
//
// Strategy: stat-validated cache. On every call, stat() the file (a few
// microseconds on Linux) and compare (mtimeMs, size). Cache hit → return a
// fresh deep clone of the parsed config. Cache miss → read + parse + cache.
//
// Why a clone and not the cached object itself?
// Returning a clone makes the cached deployment input effectively immutable
// from callers, including the explicitly guarded CLI rewrite path.
//
// Why size in addition to mtimeMs?
// Some filesystems have coarse mtime resolution, and rapid same-tick rewrites
// can land on the same mtime. Combining mtimeMs with size catches the common
// "same instant, different bytes" case cheaply. It's not a cryptographic
// guarantee — a write that preserves size and mtime can still slip through —
// but in practice the pair is more than enough.
//
// Why not fs.watch? Atomic replacement and platform quirks are surprising,
// while stat is already cheap.
//
// Custom-path loads via loadConfigFromFile() are NOT cached — they're a
// startup-only path and adding a Map<path, entry> isn't worth the complexity.
// ---------------------------------------------------------------------------

interface CacheKey {
  /** mtimeMs from stat, or `NO_FILE` sentinel when the file doesn't exist. */
  mtimeMs: number;
  /** size in bytes, 0 when the file doesn't exist. */
  size: number;
}

interface ConfigCacheEntry {
  path: string;
  config: DiscoConfig;
  key: CacheKey;
}

/** Sentinel: file didn't exist at cache time; default config is cached. */
const NO_FILE: number = -1;
const NO_FILE_KEY: CacheKey = { mtimeMs: NO_FILE, size: 0 };

let cachedEntry: ConfigCacheEntry | null = null;

function cacheKeyMatches(a: CacheKey, b: CacheKey): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Wrap a config read/stat failure, explaining the sandbox when we're inside it.
 *
 * The executor sandbox masks the daemon config with a `/dev/null` bind mount,
 * so reads from inside fail with EACCES rather than ENOENT. That is the mask
 * working as designed. Code running in the sandbox is contractually forbidden
 * from reading the daemon config (see `packages/executor/src/contract.test.ts`)
 * and receives what it needs via `payload.resolvedConfig` and `DAEMON_URL`.
 *
 * Deliberately an error and not a fall back to `getDefaultConfig()`: the
 * defaults carry no `paths` key and disable filesystem isolation, so
 * fabricating them would silently resolve tenant data roots to the wrong
 * directory instead of failing. A wrong answer here crosses a tenant boundary;
 * a loud one does not.
 */
function configLoadError(configPath: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (process.env.DISCO_OUTER_SANDBOX === '1') {
    return new Error(
      `${configPath} is masked by Disco's executor sandbox and is intentionally out of reach. ` +
        'Code inside the sandbox must not read the daemon config — it receives configuration ' +
        'via payload.resolvedConfig and DAEMON_URL. Run this on the daemon host instead. ' +
        `See context/explorations/executor-sandboxing.md. (underlying error: ${detail})`
    );
  }
  return new Error(`Failed to load config: ${detail}`);
}

function statCacheKey(configPath: string): CacheKey | null {
  try {
    const stat = statSync(configPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NO_FILE_KEY;
    }
    // Stat failed for some non-ENOENT reason — caller should not trust cache.
    return null;
  }
}

/**
 * Return a deep clone of the cached config if (path, mtime, size) still match
 * the file on disk. Returns null on any kind of mismatch — caller should
 * re-read.
 *
 * The clone is what makes the cache safe to expose: callers mutate the result
 * before an explicit rewrite and we don't want mutations bleeding into the
 * next reader if the save fails.
 */
function readCachedConfig(configPath: string): DiscoConfig | null {
  if (cachedEntry === null || cachedEntry.path !== configPath) {
    return null;
  }
  const currentKey = statCacheKey(configPath);
  if (currentKey === null || !cacheKeyMatches(currentKey, cachedEntry.key)) {
    return null;
  }
  return structuredClone(cachedEntry.config);
}

function writeCachedConfig(configPath: string, config: DiscoConfig, key: CacheKey): void {
  // Clone on write too so a caller mutating their own copy can't reach back
  // through object identity and corrupt the cached value.
  cachedEntry = { path: configPath, config: structuredClone(config), key };
}

/**
 * Invalidate the cache after init creation or an explicit destructive rewrite.
 */
function invalidateConfigCache(): void {
  cachedEntry = null;
}

/**
 * Test-only: reset the in-memory config cache. Prefer this over poking at
 * module state directly. Production code should not need to call this.
 */
export function __resetConfigCacheForTests(): void {
  invalidateConfigCache();
}

/**
 * Parse + validate raw YAML config content. Shared by every load path so
 * `loadConfig()`, `loadConfigSync()`, and `loadConfigFromFile()` all reject
 * the same invalid inputs (e.g. deprecated `unix_user_mode: opportunistic`).
 */
function parseAndValidateConfig(content: string): DiscoConfig {
  if (content.trim() === '') {
    return {};
  }

  const parsed = yaml.load(content) as DiscoConfig | undefined | null;
  const finalConfig = parsed || {};
  validateConfig(finalConfig);
  return finalConfig;
}

/**
 * Get Disco home directory (~/.disco)
 */
export function getDiscoHome(): string {
  return path.join(os.homedir(), '.disco');
}

/**
 * Get config file path (~/.disco/config.yaml)
 */
export function getConfigPath(): string {
  return path.join(getDiscoHome(), 'config.yaml');
}

/**
 * Ensure ~/.disco directory exists
 */
async function ensureDiscoHome(): Promise<void> {
  const discoHome = getDiscoHome();
  try {
    await fs.access(discoHome);
  } catch {
    await fs.mkdir(discoHome, { recursive: true });
  }
}

/**
 * Validate config and throw helpful errors for deprecated/invalid settings
 */
function assertSupportedUnixUserMode(mode: unknown): asserts mode is UnixUserMode | undefined {
  if (mode === undefined || mode === 'simple' || mode === 'sandbox' || mode === 'delegated') return;
  if (mode === 'opportunistic' || mode === 'strict' || mode === 'insulated') {
    throw new Error(
      `Config error: execution.unix_user_mode '${String(mode)}' was removed in Disco 0.25.0.\n` +
        `Migrate with the latest Disco 0.24.x release, then choose one of:\n` +
        `  - 'sandbox': fail-closed local Linux filesystem isolation (recommended)\n` +
        `  - 'simple': trusted local execution without Disco filesystem isolation\n` +
        `  - 'delegated': identity and isolation supplied by an external execution substrate`
    );
  }
  throw new Error(
    `Config error: execution.unix_user_mode must be one of: simple, sandbox, delegated (received ${JSON.stringify(mode)})`
  );
}

function validateConfig(config: DiscoConfig): void {
  const configuredAnalyticsPlugins = (config.analytics as { plugins?: unknown[] } | undefined)
    ?.plugins;
  const removedModulePluginIndex = configuredAnalyticsPlugins?.findIndex(
    (plugin) =>
      !!plugin && typeof plugin === 'object' && (plugin as { type?: unknown }).type === 'module'
  );
  if (removedModulePluginIndex !== undefined && removedModulePluginIndex >= 0) {
    throw new Error(
      `Config error: analytics.plugins[${removedModulePluginIndex}].type 'module' has been removed because loading operator-selected code in the daemon is unsafe. Use the built-in 'stdout' or 'http_batch' analytics plugin instead.`
    );
  }
  const removedConfig = config as DiscoConfig & {
    resources?: unknown;
    services?: unknown;
  };
  if (removedConfig.resources !== undefined) {
    throw new Error(
      "Config error: 'resources' has been removed. Create users, Agents, and Sessions through their typed APIs instead."
    );
  }
  if (removedConfig.services !== undefined) {
    throw new Error(
      "Config error: 'services' has been removed. Disco services are registered consistently for every tenant."
    );
  }
  const removedProviderConfig = config as DiscoConfig & {
    credentials?: unknown;
    opencode?: unknown;
    codex?: unknown;
    execution?: DiscoConfig['execution'] & { cursor_sdk_enabled?: unknown };
  };
  if (removedProviderConfig.credentials !== undefined) {
    throw new Error(
      "Config error: 'credentials' has been removed. Configure workspace agentic tools in Settings."
    );
  }
  if (removedProviderConfig.opencode !== undefined) {
    throw new Error(
      "Config error: 'opencode' has been removed. Configure OpenCode availability in workspace agentic-tool settings."
    );
  }
  // Stale since #1136 (per-session CODEX_HOME removal); flagged here so
  // upgrading installs get guidance instead of a generic unrecognized-key error.
  if (removedProviderConfig.codex !== undefined) {
    throw new Error(
      "Config error: 'codex' has been removed. Codex home directories are managed per-session automatically."
    );
  }
  if (removedProviderConfig.execution?.cursor_sdk_enabled !== undefined) {
    throw new Error(
      "Config error: 'execution.cursor_sdk_enabled' has been removed. Configure Cursor availability in workspace agentic-tool settings."
    );
  }
  const removedUnixExecution = config.execution as
    | (NonNullable<DiscoConfig['execution']> & {
        executor_unix_user?: unknown;
        sync_unix_passwords?: unknown;
      })
    | undefined;
  const removedUnixKeys = ['executor_unix_user', 'sync_unix_passwords'].filter(
    (key) => removedUnixExecution?.[key as keyof typeof removedUnixExecution] !== undefined
  );
  if (removedUnixKeys.length > 0) {
    throw new Error(
      `Config error: removed host Unix execution ${removedUnixKeys.length === 1 ? 'key' : 'keys'}: ${removedUnixKeys.map((key) => `execution.${key}`).join(', ')}. ` +
        "Remove them and choose execution.unix_user_mode 'simple', 'sandbox', or 'delegated'."
    );
  }

  const knownTopLevelKeys = new Set([
    'agentic_tools',
    'daemon',
    'deployment',
    'ui',
    'database',
    'execution',
    'security',
    'paths',
    'analytics',
    'telemetry',
    'multi_tenancy',
    'uploads',
  ]);
  const unknownTopLevelKeys = Object.keys(config).filter((key) => !knownTopLevelKeys.has(key));
  if (unknownTopLevelKeys.length > 0) {
    throw new Error(
      `Config error: unrecognized top-level key${unknownTopLevelKeys.length === 1 ? '' : 's'}: ${unknownTopLevelKeys.join(', ')}`
    );
  }

  const unknownPaths: string[] = [];
  const only = (value: unknown, path: string, allowed: readonly string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) unknownPaths.push(`${path}.${key}`);
    }
  };
  only(config.agentic_tools, 'agentic_tools', ['installed']);
  if (config.agentic_tools?.installed !== undefined) {
    if (!Array.isArray(config.agentic_tools.installed)) {
      throw new Error("Config error: 'agentic_tools.installed' must be an array");
    }
    const unknown = config.agentic_tools.installed.filter(
      (tool) => typeof tool !== 'string' || !isInstallableAgenticTool(tool)
    );
    if (unknown.length > 0) {
      throw new Error(
        `Config error: 'agentic_tools.installed' contains unsupported tool(s): ${unknown.join(', ')}`
      );
    }
    const duplicates = config.agentic_tools.installed.filter(
      (tool, index, tools) => tools.indexOf(tool) !== index
    );
    if (duplicates.length > 0) {
      throw new Error(
        `Config error: 'agentic_tools.installed' contains duplicate tool(s): ${[...new Set(duplicates)].join(', ')}`
      );
    }
  }
  only(config.deployment, 'deployment', ['mode', 'redis', 'ha']);
  only(config.deployment?.redis, 'deployment.redis', [
    'url',
    'key_prefix',
    'connect_timeout_ms',
    'startup_timeout_ms',
    'request_timeout_ms',
    'reconnect_base_delay_ms',
    'reconnect_max_delay_ms',
  ]);
  only(config.deployment?.ha, 'deployment.ha', [
    'support_profile',
    'execution_topology',
    'shared_filesystem',
    'ingress_affinity',
    'environment_health_monitor',
  ]);
  only(
    config.deployment?.ha?.environment_health_monitor,
    'deployment.ha.environment_health_monitor',
    [
      'scan_interval_ms',
      'max_idle_interval_ms',
      'startup_offset_max_ms',
      'scan_batch_size',
      'max_in_flight',
      'http_timeout_ms',
      'claim_lease_ms',
      'shutdown_drain_timeout_ms',
    ]
  );
  if (
    config.deployment?.mode !== undefined &&
    config.deployment.mode !== 'standalone' &&
    config.deployment.mode !== 'ha'
  ) {
    throw new Error('Config error: deployment.mode must be one of: standalone, ha');
  }
  if (
    config.deployment?.ha?.support_profile !== undefined &&
    config.deployment.ha.support_profile !== 'constrained-active-active'
  ) {
    throw new Error(
      'Config error: deployment.ha.support_profile must be constrained-active-active'
    );
  }
  if (
    config.deployment?.ha?.execution_topology !== undefined &&
    config.deployment.ha.execution_topology !== 'shared-local' &&
    config.deployment.ha.execution_topology !== 'external'
  ) {
    throw new Error(
      'Config error: deployment.ha.execution_topology must be shared-local or external'
    );
  }
  if (config.deployment?.redis?.url !== undefined) {
    validateRedisUrl(config.deployment.redis.url);
  }
  if (config.deployment?.redis?.key_prefix !== undefined) {
    validateRedisKeyPrefix(config.deployment.redis.key_prefix);
  }
  for (const key of [
    'connect_timeout_ms',
    'startup_timeout_ms',
    'request_timeout_ms',
    'reconnect_base_delay_ms',
    'reconnect_max_delay_ms',
  ] as const) {
    const value = config.deployment?.redis?.[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Config error: deployment.redis.${key} must be a positive integer`);
    }
  }
  for (const key of ['shared_filesystem', 'ingress_affinity'] as const) {
    const value = config.deployment?.ha?.[key];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`Config error: deployment.ha.${key} must be a boolean`);
    }
  }
  only(config.daemon, 'daemon', [
    'deployment_id',
    'port',
    'host',
    'host_ip_address',
    'public_url',
    'base_url',
    'jwtSecret',
    'masterSecret',
    'mcpEnabled',
    'mcpToolSearch',
    'instanceLabel',
    'instanceDescription',
    'impersonation_token_expiry_ms',
    'cors_allow_sandpack',
    'cors_origins',
    'trust_proxy_hops',
  ]);
  only(config.ui, 'ui', ['base_url', 'port', 'host']);
  only(config.uploads, 'uploads', ['location', 'max_age_days', 'max_file_size_mb']);
  if (config.uploads !== undefined) {
    if (
      typeof config.uploads.location !== 'undefined' &&
      (typeof config.uploads.location !== 'string' || config.uploads.location.trim() === '')
    ) {
      throw new Error("Config error: 'uploads.location' must be a non-empty path or s3:// URI");
    }
    if (
      typeof config.uploads.max_age_days !== 'undefined' &&
      (!Number.isSafeInteger(config.uploads.max_age_days) ||
        config.uploads.max_age_days < 0 ||
        !Number.isSafeInteger(config.uploads.max_age_days * 24 * 60 * 60 * 1000))
    ) {
      throw new Error("Config error: 'uploads.max_age_days' must be a non-negative integer");
    }
    if (
      typeof config.uploads.max_file_size_mb !== 'undefined' &&
      (!Number.isSafeInteger(config.uploads.max_file_size_mb) ||
        config.uploads.max_file_size_mb < 0 ||
        !Number.isSafeInteger(config.uploads.max_file_size_mb * 1024 * 1024))
    ) {
      throw new Error(
        "Config error: 'uploads.max_file_size_mb' must be a non-negative integer (0 disables the app-layer size limit)"
      );
    }
  }
  only(config.database, 'database', ['dialect', 'sqlite', 'postgresql']);
  only(config.database?.sqlite, 'database.sqlite', ['path', 'walMode', 'busyTimeout']);
  only(config.database?.postgresql, 'database.postgresql', [
    'url',
    'host',
    'port',
    'database',
    'user',
    'password',
    'pool',
    'ssl',
    'schema',
  ]);
  only(config.database?.postgresql?.pool, 'database.postgresql.pool', [
    'min',
    'max',
    'idleTimeout',
  ]);
  if (typeof config.database?.postgresql?.ssl === 'object') {
    only(config.database.postgresql.ssl, 'database.postgresql.ssl', [
      'rejectUnauthorized',
      'ca',
      'cert',
      'key',
    ]);
  }
  only(config.execution, 'execution', [
    'executor_heartbeat',
    'sdk_watchdog',
    'dispatch_connect_timeout_ms',
    'unix_user_mode',
    'allow_superadmin',
    'bootstrap_superadmin_users',
    'session_token_expiration_ms',
    'session_token_max_uses',
    'mcp_token_expiration_ms',
    'daemon_writes_user_message',
    'permission_timeout_ms',
    'executor_command_template',
    'executor_storage',
    'executor_command_nonzero_may_have_dispatched',
    'required_user_env_vars',
    'sandbox',
  ]);
  only(config.execution?.executor_heartbeat, 'execution.executor_heartbeat', [
    'enabled',
    'interval_ms',
    'stale_after_ms',
    'callback',
  ]);
  only(config.execution?.executor_heartbeat?.callback, 'execution.executor_heartbeat.callback', [
    'command_template',
    'timeout_ms',
  ]);
  only(config.execution?.sdk_watchdog, 'execution.sdk_watchdog', [
    'mode',
    'first_progress_timeout_ms',
    'abort_grace_ms',
    'claude_idle_timeout_ms',
  ]);
  if (config.execution?.sdk_watchdog) {
    resolveSdkWatchdogConfig(config.execution);
  }
  resolveDispatchConnectTimeoutMs(config.execution);
  only(config.execution?.sandbox, 'execution.sandbox', [
    'enabled',
    'include',
    'protect_secrets',
    'home_mode',
    'preserve_canonical_home_alias',
    'extra_allow_write',
    'extra_deny_read',
    'fail_if_unavailable',
  ]);
  only(config.execution?.sandbox?.include, 'execution.sandbox.include', [
    'workspace',
    'tmp',
    'home',
  ]);
  if (
    config.execution?.sandbox?.preserve_canonical_home_alias !== undefined &&
    typeof config.execution.sandbox.preserve_canonical_home_alias !== 'boolean'
  ) {
    throw new Error(
      'Config error: execution.sandbox.preserve_canonical_home_alias must be a boolean'
    );
  }
  only(config.execution?.executor_storage, 'execution.executor_storage', [
    'user_home',
    'session_workspace',
  ]);
  if (
    config.execution?.executor_storage?.user_home !== undefined &&
    !['replica-local', 'shared', 'persistent-per-user'].includes(
      config.execution.executor_storage.user_home
    )
  ) {
    throw new Error(
      'Config error: execution.executor_storage.user_home must be replica-local, shared, or persistent-per-user'
    );
  }
  if (
    config.execution?.executor_storage?.session_workspace !== undefined &&
    !['replica-local', 'shared', 'persistent-per-session'].includes(
      config.execution.executor_storage.session_workspace
    )
  ) {
    throw new Error(
      'Config error: execution.executor_storage.session_workspace must be replica-local, shared, or persistent-per-session'
    );
  }
  only(config.security, 'security', ['csp', 'cors', 'git_config_parameters']);
  only(config.security?.csp, 'security.csp', [
    'extras',
    'override',
    'report_uri',
    'report_only',
    'disabled',
  ]);
  only(config.security?.cors, 'security.cors', [
    'mode',
    'origins',
    'credentials',
    'methods',
    'allowed_headers',
    'max_age_seconds',
    'allow_sandpack',
  ]);
  only(config.security?.git_config_parameters, 'security.git_config_parameters', [
    'extras',
    'override',
  ]);
  only(config.paths, 'paths', ['data_home']);
  only(config.analytics, 'analytics', ['enabled', 'client', 'filters', 'plugins']);
  only(config.analytics?.client, 'analytics.client', ['app', 'version', 'debug']);
  only(config.analytics?.filters, 'analytics.filters', ['exclude_events']);
  for (const [index, plugin] of (config.analytics?.plugins ?? []).entries()) {
    only(plugin, `analytics.plugins[${index}]`, ['type', 'enabled', 'options']);
    switch (plugin.type) {
      case 'stdout':
        only(plugin.options, `analytics.plugins[${index}].options`, ['pretty']);
        break;
      case 'http_batch':
        only(plugin.options, `analytics.plugins[${index}].options`, [
          'url',
          'flush_interval_ms',
          'max_batch_size',
          'timeout_ms',
          'headers',
        ]);
        break;
      default: {
        const unsupported: never = plugin;
        throw new Error(
          `Config error: analytics.plugins[${index}].type '${String((unsupported as { type?: unknown }).type)}' is not supported. Use 'stdout' or 'http_batch'.`
        );
      }
    }
  }
  only(config.telemetry, 'telemetry', [
    'enabled',
    'instance_id',
    'endpoint',
    'write_key',
    'debug',
    'timeout_ms',
    'flush_interval_ms',
    'max_batch_size',
    'install_ping_sent_at',
    'last_daemon_active_day',
    'last_usage_summary_day',
    'last_reported_version',
  ]);
  only(config.multi_tenancy, 'multi_tenancy', [
    'filesystem_isolation_enabled',
    'tenants_base_folder',
    'mode',
    'static_tenant_id',
    'auth_claim',
    'trusted_header',
  ]);
  if (unknownPaths.length > 0) {
    throw new Error(
      `Config error: unrecognized ${unknownPaths.length === 1 ? 'key' : 'keys'}: ${unknownPaths.join(', ')}`
    );
  }

  assertSupportedUnixUserMode(config.execution?.unix_user_mode);

  assertValidMultiTenancyConfig(config);

}

/** Return the deployment identity after enforcing the daemon startup invariant. */
export function requireDeploymentId(config: DiscoConfig): string {
  const deploymentId = config.daemon?.deployment_id;
  if (
    typeof deploymentId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deploymentId)
  ) {
    throw new Error("Config error: 'daemon.deployment_id' is required and must be a valid UUID");
  }
  return deploymentId;
}

function validateOptionalHttpUrl(
  container: Record<string, unknown> | undefined,
  key: string,
  configPath: string
): void {
  if (!container || container[key] === undefined) return;

  const raw = container[key];
  if (typeof raw !== 'string') {
    throw new Error(`Config error: ${configPath} must be an HTTP(S) URL string`);
  }

  container[key] = validateHttpUrlString(raw, configPath);
}

function validateHttpUrlString(
  url: string,
  label: string,
  options: { stripTrailingSlash?: boolean } = {}
): string {
  const trimmed = options.stripTrailingSlash ? url.trim().replace(/\/$/, '') : url.trim();

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    throw new Error(`Invalid ${label}: "${url}". Must start with http:// or https://`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ${label} format: "${url}". Must be a valid HTTP(S) URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${label}: "${url}". Must use http:// or https://`);
  }

  return trimmed;
}

/**
 * Load config from ~/.disco/config.yaml
 *
 * Returns default config if file doesn't exist.
 *
 * Stat-validated cache: subsequent calls with an unchanged file return a
 * fresh clone of the parsed result without re-reading or re-parsing YAML.
 * Callers can mutate the result freely without affecting other readers.
 */
export async function loadConfig(): Promise<DiscoConfig> {
  const configPath = getConfigPath();

  const cached = readCachedConfig(configPath);
  if (cached !== null) {
    return cached;
  }

  // Stat-read-stat: if the file changes mid-read, the two stats won't match
  // and we skip caching this read entirely (returning the freshly parsed
  // value but leaving the cache empty so the next call re-reads).
  let beforeKey: CacheKey | null;
  let content: string;
  let afterKey: CacheKey | null;
  try {
    beforeKey = statCacheKey(configPath);
    if (beforeKey?.mtimeMs === NO_FILE) {
      const defaults = getDefaultConfig();
      writeCachedConfig(configPath, defaults, NO_FILE_KEY);
      return defaults;
    }
    content = await fs.readFile(configPath, 'utf-8');
    afterKey = statCacheKey(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const defaults = getDefaultConfig();
      writeCachedConfig(configPath, defaults, NO_FILE_KEY);
      return defaults;
    }
    throw configLoadError(configPath, error);
  }

  let finalConfig: DiscoConfig;
  try {
    finalConfig = parseAndValidateConfig(content);
  } catch (error) {
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (beforeKey !== null && afterKey !== null && cacheKeyMatches(beforeKey, afterKey)) {
    writeCachedConfig(configPath, finalConfig, beforeKey);
  }
  return finalConfig;
}

/**
 * Load config from a specific file path.
 *
 * Unlike loadConfig(), this does NOT fall back to defaults if the file is missing.
 * Throws on missing file or parse error.
 */
export async function loadConfigFromFile(filePath: string): Promise<DiscoConfig> {
  const content = await fs.readFile(filePath, 'utf-8');
  return parseAndValidateConfig(content);
}

/**
 * Explicit upgrade escape hatch for configs created before deployment identity
 * became mandatory. This is deliberately not a relaxed config loader: the
 * returned value is validated only after the generated identity is inserted.
 */
export async function migrateConfigDeploymentId(
  filePath = getConfigPath(),
  deploymentId = randomUUID()
): Promise<{ config: DiscoConfig; deploymentId: string; backupPath: string }> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = (yaml.load(content) ?? {}) as DiscoConfig;
  if (parsed.daemon?.deployment_id) {
    validateConfig(parsed);
    try {
      requireDeploymentId(parsed);
      return { config: parsed, deploymentId: parsed.daemon.deployment_id, backupPath: filePath };
    } catch {
      // The explicitly-confirmed migration also repairs malformed legacy IDs.
    }
  }
  parsed.daemon = { ...parsed.daemon, deployment_id: deploymentId };
  validateConfig(parsed);
  requireDeploymentId(parsed);

  const backupPath = `${filePath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  const stat = await fs.stat(filePath);
  const tempPath = `${filePath}.rewrite-${process.pid}-${randomUUID()}`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', stat.mode & 0o7777);
    await handle.writeFile(yaml.dump(parsed, { indent: 2, lineWidth: 120, noRefs: true }), 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
  } finally {
    await handle?.close();
    await fs.rm(tempPath, { force: true });
  }
  invalidateConfigCache();
  return { config: parsed, deploymentId, backupPath };
}

/**
 * Save config to ~/.disco/config.yaml
 *
 * Invalidates the in-memory cache so the next load reflects the fresh value.
 */
export async function createInitialConfig(config: DiscoConfig = getDefaultConfig()): Promise<void> {
  validateConfig(config);
  await ensureDiscoHome();
  const configPath = getConfigPath();
  const content = [
    '# Disco operator configuration',
    '#',
    '# This file is deployment-owned immutable runtime input. Disco will not',
    '# rewrite it after initialization. Edit it (or its IaC source) explicitly',
    '# and restart the daemon. Environment overrides take precedence where',
    '# documented: https://disco.live/guide/config-yaml',
    '#',
    yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true }),
  ].join('\n');

  let handle: fs.FileHandle | undefined;
  try {
    // `wx` is the important part of the config ownership contract: two initializers
    // may race, but neither can replace a file created by the other (or by an
    // operator/config-management system).
    handle = await fs.open(configPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing config: ${configPath}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  invalidateConfigCache();
}

/**
 * Destructively rewrite config.yaml.
 *
 * This deliberately awkward API is reserved for the explicitly-confirmed CLI
 * escape hatch. Runtime, daemon, service, API, MCP, upgrade, and UI code must
 * never call it. Atomic replacement avoids partial YAML and preserves the
 * existing file's permission bits.
 */
async function rewriteConfigFile(
  config: DiscoConfig,
  options: { acknowledgedFormattingLoss: true }
): Promise<void> {
  if (options.acknowledgedFormattingLoss !== true) {
    throw new Error('Destructive config rewrite was not explicitly acknowledged');
  }
  validateConfig(config);
  const configPath = getConfigPath();
  const stat = await fs.stat(configPath);
  const tempPath = `${configPath}.rewrite-${process.pid}-${randomUUID()}`;
  const content = yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true });
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', stat.mode & 0o7777);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, configPath);
  } finally {
    await handle?.close();
    await fs.rm(tempPath, { force: true });
  }
  invalidateConfigCache();
}

/** Test-only coverage for atomic replacement semantics. */
export async function rewriteConfigForTests(config: DiscoConfig): Promise<void> {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('rewriteConfigForTests is unavailable outside tests');
  await rewriteConfigFile(config, { acknowledgedFormattingLoss: true });
}

/** Test-fixture helper. Production code must use createInitialConfig or the guarded CLI. */
export async function saveConfigForTests(config: DiscoConfig): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('saveConfigForTests is unavailable outside tests');
  }
  try {
    await createInitialConfig(config);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Refusing to overwrite'))
      throw error;
    await rewriteConfigFile(config, { acknowledgedFormattingLoss: true });
  }
}

/**
 * Get default config
 */
export function getDefaultConfig(): DiscoConfig {
  return {
    daemon: {
      port: DAEMON.DEFAULT_PORT,
      host: DAEMON.DEFAULT_HOST,
      mcpEnabled: true, // Default: Enable built-in MCP server
    },
    ui: {
      port: 5173,
      host: 'localhost',
    },
    execution: {
      session_token_expiration_ms: 86400000, // 24 hours
      session_token_max_uses: 1, // Single-use tokens
      mcp_token_expiration_ms: MCP_TOKEN.DEFAULT_EXPIRATION_MS,
      executor_heartbeat: resolveExecutorHeartbeatConfig(),
    },
    analytics: getDefaultAnalyticsConfig(),
    telemetry: {},
    multi_tenancy: {
      filesystem_isolation_enabled: false,
      tenants_base_folder: '~/.disco/tenants',
      mode: 'static',
      static_tenant_id: 'default',
    },
    uploads: {
      location: '~/.disco',
      max_age_days: 0,
      max_file_size_mb: 0,
    },
  };
}

/**
 * Materialize YAML plus supported deployment-environment overrides into one
 * effective snapshot. This is read-only: callers may display/export the
 * result, but Disco never writes it back automatically.
 */
export function resolveEffectiveConfig(
  config: DiscoConfig,
  env: NodeJS.ProcessEnv = process.env
): DiscoConfig {
  const defaults = getDefaultConfig();
  const port = env.PORT ? Number.parseInt(env.PORT, 10) : undefined;

  // Resolve the effective Unix isolation mode (env override wins) so the
  // `sandbox` mode can imply the rest of its machinery.
  // Compose exports an empty string when DISCO_UNIX_USER_MODE is unset. Treat
  // that as no override, matching the conditional merge below.
  const configuredUnixMode = env.DISCO_UNIX_USER_MODE || config.execution?.unix_user_mode;
  assertSupportedUnixUserMode(configuredUnixMode);
  const effectiveUnixMode = configuredUnixMode ?? 'simple';
  const sandboxIsolation = effectiveUnixMode === 'sandbox';

  // Fold config file + env vars + `sandbox`-mode implications into ONE sandbox
  // settings object (a single `sandbox:` key below).
  //
  // `unix_user_mode: sandbox` is a NAMED SECURITY MODE, so its core invariants
  // are NON-NEGOTIABLE: the sandbox is on, the home is per-owner, and it fails
  // closed. Operator config/env may NOT weaken these (a "sandbox" that silently
  // runs with a shared daemon home or spawns unsandboxed would violate the
  // contract). Other tunables (include/protect_secrets/extras) are still
  // honored. If you want a tunable standalone sandbox, use `unix_user_mode` !=
  // `sandbox` with `sandbox.enabled: true` and set home_mode/fail explicitly.
  const envSandboxEnabled = env.DISCO_SANDBOX_ENABLED === 'true';
  // env home_mode override applies ONLY outside sandbox mode (in sandbox mode it
  // is forced to per_user). env wins over the config file, matching other
  // DISCO_* overrides.
  const envHomeMode =
    env.DISCO_SANDBOX_HOME_MODE === 'per_user' || env.DISCO_SANDBOX_HOME_MODE === 'shared'
      ? env.DISCO_SANDBOX_HOME_MODE
      : undefined;
  let resolvedSandbox = config.execution?.sandbox;
  if (sandboxIsolation) {
    resolvedSandbox = {
      ...config.execution?.sandbox,
      // forced — cannot be weakened by config or env in sandbox mode
      enabled: true,
      home_mode: 'per_user',
      fail_if_unavailable: true,
    };
  } else if (envSandboxEnabled || envHomeMode) {
    resolvedSandbox = {
      ...config.execution?.sandbox,
      ...(envSandboxEnabled ? { enabled: true } : {}),
      ...(envHomeMode ? { home_mode: envHomeMode } : {}),
    };
  }

  return {
    ...defaults,
    ...config,
    daemon: {
      ...defaults.daemon,
      ...config.daemon,
      ...(Number.isSafeInteger(port) ? { port } : {}),
      ...(env.DAEMON_HOST ? { host: env.DAEMON_HOST } : {}),
      ...(env.DISCO_JWT_SECRET ? { jwtSecret: env.DISCO_JWT_SECRET } : {}),
      ...(env.DISCO_MASTER_SECRET ? { masterSecret: env.DISCO_MASTER_SECRET } : {}),
      ...(env.INSTANCE_LABEL ? { instanceLabel: env.INSTANCE_LABEL } : {}),
    },
    ui: { ...defaults.ui, ...config.ui },
    execution: {
      ...defaults.execution,
      ...config.execution,
      ...(env.DISCO_UNIX_USER_MODE
        ? {
            unix_user_mode: env.DISCO_UNIX_USER_MODE as NonNullable<
              DiscoConfig['execution']
            >['unix_user_mode'],
          }
        : {}),
      // Folded sandbox settings (config file + DISCO_SANDBOX_* env + `sandbox`
      // isolation-mode implications). Computed above. DISCO_SANDBOX_ENABLED /
      // DISCO_SANDBOX_HOME_MODE are used by the `sandbox` .disco.yml env variants.
      ...(resolvedSandbox ? { sandbox: resolvedSandbox } : {}),
    },
    paths: {
      ...defaults.paths,
      ...config.paths,
      // Project the deployment override into the immutable effective snapshot.
      // Runtime services must consume this value instead of consulting the
      // environment or re-reading config.yaml on each request.
      ...(env.DISCO_DATA_HOME ? { data_home: expandHomePath(env.DISCO_DATA_HOME) } : {}),
    },
    analytics: { ...defaults.analytics, ...config.analytics },
    telemetry: {
      ...defaults.telemetry,
      ...config.telemetry,
      ...(env.DISCO_TELEMETRY === '1' ? { enabled: true } : {}),
      ...(env.DISCO_TELEMETRY === '0' || env.DO_NOT_TRACK === '1' ? { enabled: false } : {}),
      ...(env.DISCO_TELEMETRY_ENDPOINT ? { endpoint: env.DISCO_TELEMETRY_ENDPOINT } : {}),
      ...(env.DISCO_TELEMETRY_WRITE_KEY ? { write_key: env.DISCO_TELEMETRY_WRITE_KEY } : {}),
    },
    uploads: { ...defaults.uploads, ...config.uploads },
    multi_tenancy: { ...defaults.multi_tenancy, ...config.multi_tenancy },
  };
}

/**
 * Reject execution combinations that the local filesystem sandbox cannot
 * enforce. Call this on the resolved effective config so environment-derived
 * settings are covered as well as YAML settings.
 */
export function assertValidEffectiveExecutionConfig(config: DiscoConfig): void {
  const execution = config.execution;
  if (!execution) return;

  if (execution.unix_user_mode === 'delegated' && !execution.executor_command_template) {
    throw new Error(
      "execution.unix_user_mode 'delegated' requires execution.executor_command_template so execution is actually delegated to an external substrate."
    );
  }

  const retiredPlaceholders = execution.executor_command_template?.match(
    /\{(?:unix_user_uid|unix_user_gid)\}/g
  );
  if (retiredPlaceholders?.length) {
    throw new Error(
      `execution.executor_command_template uses removed placeholder(s): ${[...new Set(retiredPlaceholders)].join(', ')}. ` +
        'Use {unix_user} as the opaque delegated execution-home key instead.'
    );
  }

  if (execution.sandbox?.enabled !== true) return;

  if (execution.executor_command_template) {
    throw new Error(
      'execution.sandbox.enabled is incompatible with execution.executor_command_template because ' +
        'templated executors run outside the daemon local sandbox. Enforce isolation in the external substrate instead.'
    );
  }
}

export function formatConfigYaml(config: DiscoConfig): string {
  return yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true });
}

export interface DeploymentAgenticToolPolicy {
  managed: boolean;
  installed: ReadonlySet<InstallableAgenticTool>;
}

/** Capture the instance-global package policy once during daemon startup. */
export function resolveDeploymentAgenticToolPolicy(
  config: DiscoConfig,
  env: NodeJS.ProcessEnv = process.env
): DeploymentAgenticToolPolicy {
  return {
    managed: env.DISCO_MANAGED_AGENTIC_TOOLS === '1',
    installed: new Set(config.agentic_tools?.installed ?? []),
  };
}

/** Instance-global package gate; tenant settings may narrow but never expand it. */
export function isDeploymentAgenticToolAvailable(
  tool: AgenticToolName,
  policy: DeploymentAgenticToolPolicy
): boolean {
  if (!policy.managed) return true;
  if (!isInstallableAgenticTool(tool)) return false;
  return policy.installed.has(tool);
}

/**
 * Expand a path that may start with ~/
 */
export function expandHomePath(input: string): string {
  if (!input) {
    return input;
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Initialize config file with defaults if it doesn't exist
 */
export async function initConfig(): Promise<void> {
  const configPath = getConfigPath();

  try {
    await fs.access(configPath);
    // File exists, don't overwrite
  } catch {
    // File doesn't exist, create with defaults
    await createInitialConfig(getDefaultConfig());
  }
}

/**
 * Get a nested config value using dot notation
 *
 * Merges with default config to return effective values.
 *
 * @param key - Config key (e.g., "daemon.port")
 * @returns Value or undefined if not set
 */
export async function getConfigValue(key: string): Promise<string | boolean | number | undefined> {
  const config = await loadConfig();
  const defaults = getDefaultConfig();

  // Merge config with defaults (deep merge for sections)
  const merged = {
    ...defaults,
    ...config,
    daemon: { ...defaults.daemon, ...config.daemon },
    ui: { ...defaults.ui, ...config.ui },
    execution: { ...defaults.execution, ...config.execution },
    paths: { ...defaults.paths, ...config.paths },
    analytics: { ...defaults.analytics, ...config.analytics },
    telemetry: { ...defaults.telemetry, ...config.telemetry },
    uploads: { ...defaults.uploads, ...config.uploads },
  };

  const parts = key.split('.');

  let value: UnknownJson = merged;
  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return undefined;
    }
  }

  return value;
}

/**
 * Get daemon URL from config
 *
 * Returns internal daemon URL for backend-to-backend communication.
 * Always returns localhost-based URL since all backend components (daemon, CLI, SDKs)
 * run in the same environment.
 *
 * For external access (browser UI), use frontend's getDaemonUrl() which detects
 * the appropriate public URL via window.location.
 *
 * @returns Daemon URL (e.g., "http://localhost:3030")
 */
export async function getDaemonUrl(): Promise<string> {
  return resolveDaemonUrl(await loadConfig());
}

/** Resolve the internal daemon URL from an already processed config snapshot. */
export function resolveDaemonUrl(config: DiscoConfig): string {
  return process.env.DAEMON_URL
    ? normalizeHttpBaseUrl(process.env.DAEMON_URL, 'DAEMON_URL')
    : constructDaemonLocalUrl(config);
}

/**
 * Validate and normalize a base URL
 *
 * @param url - URL to validate
 * @returns Normalized URL without trailing slash
 * @throws Error if URL is invalid or uses unsupported scheme
 */
function validateBaseUrl(url: string): string {
  return validateHttpUrlString(url, 'base URL', { stripTrailingSlash: true });
}

/** Construct `http://{host}:{port}` from daemon config + env overrides. */
function constructDaemonLocalUrl(config: DiscoConfig): string {
  const defaults = getDefaultConfig();
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const port = envPort || config.daemon?.port || defaults.daemon?.port || DAEMON.DEFAULT_PORT;
  const host = config.daemon?.host || defaults.daemon?.host || DAEMON.DEFAULT_HOST;
  return `http://${host}:${port}`;
}

/**
 * Shared base URL resolver for browser-reachable URLs.
 *
 * All three public resolvers ({@link getBaseUrl}, {@link getDaemonBaseUrl},
 * {@link requirePublicBaseUrl}) differ only in which config key they prefer
 * and whether a missing explicit URL should throw.
 *
 * @param prefer - `'ui'` checks `ui.base_url` first (for browser entity links),
 *   `'daemon'` checks `daemon.base_url` first (for API endpoints / OAuth).
 * @param requireExplicit - When true, throws instead of falling back to localhost.
 */
function resolveBaseUrl(
  config: DiscoConfig,
  prefer: 'ui' | 'daemon',
  requireExplicit?: boolean
): string {
  const first = prefer === 'ui' ? config.ui?.base_url : config.daemon?.base_url;
  const second = prefer === 'ui' ? config.daemon?.base_url : config.ui?.base_url;

  if (first) return validateBaseUrl(first);
  if (second) return validateBaseUrl(second);

  if (requireExplicit) {
    throw new PublicBaseUrlNotConfiguredError(
      'No public base URL configured. Set the DISCO_BASE_URL environment variable ' +
        'or `daemon.base_url` (preferred) / `ui.base_url` (legacy) in ~/.disco/config.yaml ' +
        "to the daemon's " +
        'browser-reachable URL (e.g. https://disco.example.com). This is required ' +
        'so OAuth providers can redirect users back to a URL their browser can reach — ' +
        'the localhost fallback only works for browsers on the daemon machine.'
    );
  }

  return constructDaemonLocalUrl(config);
}

/**
 * Get the daemon base URL for browser-reachable API endpoints
 * (e.g. artifact `DISCO_API_URL` grants).
 *
 * Distinct from {@link getDaemonUrl}, which uses `DAEMON_URL` for internal
 * backend-to-backend communication.
 *
 * Resolution order:
 * 1. DISCO_BASE_URL environment variable (highest priority)
 * 2. daemon.base_url from config.yaml
 * 3. ui.base_url from legacy one-origin configs
 * 4. Default daemon host and port
 */
export async function getDaemonBaseUrl(): Promise<string> {
  if (process.env.DISCO_BASE_URL) {
    return validateBaseUrl(process.env.DISCO_BASE_URL);
  }
  return resolveBaseUrl(await loadConfig(), 'daemon');
}

/**
 * Get base URL for external/user-facing UI links.
 *
 * Used to generate clickable URLs to sessions, boards, and other resources
 * that are sent to external platforms like Slack, email, etc.
 *
 * Resolution order:
 * 1. DISCO_BASE_URL environment variable (highest priority)
 * 2. ui.base_url from config.yaml
 * 3. daemon.base_url from config.yaml
 * 4. Default: http://localhost:{port} (constructed from daemon port)
 *
 * @returns Base URL without trailing slash (e.g., "https://disco.sandbox.preset.zone")
 */
export async function getBaseUrl(): Promise<string> {
  if (process.env.DISCO_BASE_URL) {
    return validateBaseUrl(process.env.DISCO_BASE_URL);
  }
  return resolveBaseUrl(await loadConfig(), 'ui');
}

/**
 * Error thrown by {@link requirePublicBaseUrl} when no public base URL is configured.
 *
 * Carries a stable `code` so callers (e.g. OAuth start endpoint) can distinguish a
 * missing-config failure from other unexpected errors and surface a clean,
 * actionable message to the UI.
 */
export class PublicBaseUrlNotConfiguredError extends Error {
  readonly code = 'PUBLIC_BASE_URL_NOT_CONFIGURED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PublicBaseUrlNotConfiguredError';
  }
}

/**
 * Get the daemon's public, browser-reachable base URL.
 *
 * Strict variant of {@link getDaemonBaseUrl} — required for any URL that will be handed
 * to a remote system (e.g. an OAuth `redirect_uri` registered with an upstream
 * provider) and then loaded by an end-user's browser.
 *
 * Resolution:
 * 1. `DISCO_BASE_URL` environment variable
 * 2. `daemon.base_url` from `~/.disco/config.yaml`
 * 3. Legacy `ui.base_url` fallback
 * 4. **Throws** {@link PublicBaseUrlNotConfiguredError}
 *
 * Unlike {@link getBaseUrl}, this never silently falls back to
 * `http://localhost:{port}` — that fallback is broken for any browser not on
 * the daemon's host (e.g. a remote user of a deployed Disco instance), and
 * results in OAuth providers redirecting to an unreachable URL.
 *
 * @returns Base URL without trailing slash (e.g., "https://disco.sandbox.preset.zone")
 * @throws {PublicBaseUrlNotConfiguredError} if neither source is set
 */
export async function requirePublicBaseUrl(): Promise<string> {
  if (process.env.DISCO_BASE_URL) {
    return validateBaseUrl(process.env.DISCO_BASE_URL);
  }
  return resolveBaseUrl(await loadConfig(), 'daemon', true);
}

/**
 * Load config from ~/.disco/config.yaml (synchronous)
 *
 * Returns default config if file doesn't exist.
 * Use for hot paths where async is not possible.
 *
 * Shares the same stat-validated cache and the same parse+validate code as
 * {@link loadConfig}, so the sync entry point cannot poison the cache with
 * an invalid config that a later async caller would silently return.
 */
export function loadConfigSync(): DiscoConfig {
  const configPath = getConfigPath();

  const cached = readCachedConfig(configPath);
  if (cached !== null) {
    return cached;
  }

  let beforeKey: CacheKey | null;
  let content: string;
  let afterKey: CacheKey | null;
  try {
    beforeKey = statCacheKey(configPath);
    if (beforeKey?.mtimeMs === NO_FILE) {
      const defaults = getDefaultConfig();
      writeCachedConfig(configPath, defaults, NO_FILE_KEY);
      return defaults;
    }
    content = readFileSync(configPath, 'utf-8');
    afterKey = statCacheKey(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const defaults = getDefaultConfig();
      writeCachedConfig(configPath, defaults, NO_FILE_KEY);
      return defaults;
    }
    throw configLoadError(configPath, error);
  }

  let finalConfig: DiscoConfig;
  try {
    finalConfig = parseAndValidateConfig(content);
  } catch (error) {
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (beforeKey !== null && afterKey !== null && cacheKeyMatches(beforeKey, afterKey)) {
    writeCachedConfig(configPath, finalConfig, beforeKey);
  }
  return finalConfig;
}

/**
 * Whether an execution mode requires the transitional `unix_username`
 * execution-home key. Shared by config resolution and launch call sites.
 */
export function unixUserModeRequiresExecutionHomeKey(
  mode: import('./types').UnixUserMode
): boolean {
  return mode === 'delegated';
}

// =============================================================================
// Data Home Path Resolution
// =============================================================================
//
// DISCO_HOME vs DISCO_DATA_HOME:
//
// DISCO_HOME (~/.disco by default):
//   - Daemon operating files: config.yaml, disco.db, logs/
//   - Fast local storage (SSD)
//
// DISCO_DATA_HOME (defaults to DISCO_HOME):
//   - Per-user Agent and Session workspaces under worktrees/
//   - Can be shared storage for multi-process deployments
//
// Priority (highest to lowest):
//   1. DISCO_DATA_HOME environment variable
//   2. paths.data_home in config.yaml
//   3. DISCO_HOME (backward compatible default)
//
// @see context/explorations/executor-expansion.md
// =============================================================================

/**
 * Get Disco data home directory
 *
 * This is where user-owned Agent and Session workspaces are stored.
 * Defaults to DISCO_HOME.
 *
 * Resolution order:
 * 1. DISCO_DATA_HOME environment variable (highest priority)
 * 2. paths.data_home from config.yaml
 * 3. DISCO_HOME (same as getDiscoHome(), backward compatible)
 *
 * @returns Absolute path to data home directory
 *
 * @example
 * ```ts
 * // Default (no config): ~/.disco
 * // With DISCO_DATA_HOME=/data/disco: /data/disco
 * // With paths.data_home: /mnt/efs/disco
 * const dataHome = getDataHome();
 * ```
 */
export function getDataHome(): string {
  // 1. Environment variable takes highest priority
  if (process.env.DISCO_DATA_HOME) {
    return expandHomePath(process.env.DISCO_DATA_HOME);
  }

  // 2. Check config file
  try {
    return resolveDataHomeFromConfig(loadConfigSync());
  } catch {
    // Config load failed, fall through to default
  }

  // 3. Default to DISCO_HOME (backward compatible)
  return getDiscoHome();
}

/** Resolve the data root from an already-loaded config snapshot. */
export function resolveDataHomeFromConfig(
  config: { readonly paths?: { readonly data_home?: string } },
  discoHome = getDiscoHome()
): string {
  return config.paths?.data_home ? expandHomePath(config.paths.data_home) : discoHome;
}

/**
 * Pure tenant-data-root policy shared by sync and async config loaders.
 */
export function resolveTenantDataRootFromConfig(
  config: {
    readonly multi_tenancy?: {
      readonly filesystem_isolation_enabled?: boolean;
      readonly tenants_base_folder?: string;
    };
  },
  dataHome: string,
  discoHome: string,
  tenantId?: string
): string {
  if (config.multi_tenancy?.filesystem_isolation_enabled !== true) {
    return dataHome;
  }

  const normalizedTenantId = tenantId?.trim();
  if (
    !normalizedTenantId ||
    normalizedTenantId === '.' ||
    normalizedTenantId === '..' ||
    normalizedTenantId.includes('/') ||
    normalizedTenantId.includes('\\')
  ) {
    throw new Error(
      'A valid tenant id is required when multi_tenancy.filesystem_isolation_enabled is true'
    );
  }

  const tenantsBase = resolveTenantsBaseFolderFromConfig(config, discoHome);
  return path.join(tenantsBase, normalizedTenantId);
}

/** Resolve the configured parent of all filesystem-isolated tenant roots. */
export function resolveTenantsBaseFolderFromConfig(
  config: { readonly multi_tenancy?: { readonly tenants_base_folder?: string } },
  discoHome = getDiscoHome()
): string {
  const configuredBase = config.multi_tenancy?.tenants_base_folder || '~/.disco/tenants';
  const expandedBase = expandHomePath(configuredBase);
  return path.isAbsolute(expandedBase) ? expandedBase : path.resolve(discoHome, expandedBase);
}

/**
 * Resolve the root containing tenant-owned filesystem data.
 *
 * Single-tenant installs retain the historical data home. When filesystem
 * multi-tenancy is enabled, a tenant id is required and the result is
 * `<tenants_base_folder>/<tenantId>`.
 */
export function getTenantDataRoot(tenantId?: string): string {
  return resolveTenantDataRootFromConfig(loadConfigSync(), getDataHome(), getDiscoHome(), tenantId);
}

/**
 * Get the root containing every Disco user's workspaces.
 *
 * Returns: $DISCO_DATA_HOME/worktrees
 */
export function getWorktreesRoot(tenantId?: string): string {
  return path.join(getTenantDataRoot(tenantId), 'worktrees');
}

/**
 * Get data home directory (async version)
 *
 * Same as getDataHome() but loads config asynchronously.
 * Prefer this in async contexts to avoid blocking.
 *
 * @returns Absolute path to data home directory
 */
export async function getDataHomeAsync(): Promise<string> {
  // 1. Environment variable takes highest priority
  if (process.env.DISCO_DATA_HOME) {
    return expandHomePath(process.env.DISCO_DATA_HOME);
  }

  // 2. Check config file
  try {
    const config = await loadConfig();
    if (config.paths?.data_home) {
      return expandHomePath(config.paths.data_home);
    }
  } catch {
    // Config load failed, fall through to default
  }

  // 3. Default to DISCO_HOME (backward compatible)
  return getDiscoHome();
}

/** Async counterpart to {@link getTenantDataRoot}. */
export async function getTenantDataRootAsync(tenantId?: string): Promise<string> {
  const [config, dataHome] = await Promise.all([loadConfig(), getDataHomeAsync()]);
  return resolveTenantDataRootFromConfig(config, dataHome, getDiscoHome(), tenantId);
}

