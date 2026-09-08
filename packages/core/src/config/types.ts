/**
 * Disco Configuration Types
 */

import type { InstallableAgenticTool } from '../agentic-integrations';

/** Deployment-owned agentic-tool package selection. */
export interface DiscoAgenticToolsSettings {
  /** Integrations that must match the running Disco version exactly. */
  installed?: InstallableAgenticTool[];
}

/**
 * Type for user-provided JSON data where structure is unknown or dynamic
 *
 * Use this instead of `any` when dealing with user input or dynamic data structures.
 */
// biome-ignore lint/suspicious/noExplicitAny: Escape hatch for user-provided JSON data
export type UnknownJson = any;

/**
 * Daemon settings
 */
export interface DiscoDaemonSettings {
  /** Stable identity shared by every process belonging to this deployment. */
  deployment_id?: string;

  /** Daemon port (default: 3030) */
  port?: number;

  /** Daemon host (default: localhost) */
  host?: string;

  /**
   * IP address exposed to env command templates as `{{host.ip_address}}`.
   *
   * Useful for health-check URLs that must reach the host from inside a
   * container (e.g. Superset health probes that resolve to a host-bound
   * service). When unset, the daemon auto-detects the primary non-loopback
   * IPv4 at startup and logs the resolved value.
   *
   * Set this to override autodetection (e.g. on multi-NIC hosts or when
   * the container network differs from the advertised address).
   */
  host_ip_address?: string;

  /**
   * Public URL for executors to reach the daemon.
   *
   * In local mode, defaults to `http://localhost:{port}`.
   * In containerized (k8s) mode, should be the internal service URL.
   *
   * @example
   * ```yaml
   * daemon:
   *   public_url: http://disco-daemon.disco.svc.cluster.local:3030
   * ```
   */
  public_url?: string;

  /**
   * Browser-reachable base URL for daemon endpoints.
   *
   * Used for OAuth callbacks and artifact API grants. It is also the fallback
   * origin for browser UI links when ui.base_url is not set.
   *
   * Defaults to `http://localhost:{port}` in development.
   * Should be set to your public domain in production (e.g., https://disco.example.com).
   *
   * Note: Should NOT include trailing slash.
   *
   * @example
   * ```yaml
   * daemon:
   *   base_url: https://disco.sandbox.preset.zone
   * ```
   */
  base_url?: string;

  /** JWT secret (auto-generated if not provided) */
  jwtSecret?: string;

  /** Master secret for API key encryption (auto-generated if not provided) */
  masterSecret?: string;

  /** Enable built-in MCP server (default: true) */
  mcpEnabled?: boolean;

  /** Enable tool search mode: tools/list returns only essential tools,
   *  agents discover others via disco_search_tools (default: true) */
  mcpToolSearch?: boolean;

  /** Instance label for deployment identification (e.g., "staging", "prod-us-east").
   * Displayed as a Tag in the UI navbar when set. */
  instanceLabel?: string;

  /** Instance description (markdown supported).
   * Displayed as a popover around the instance label Tag. */
  instanceDescription?: string;

  /** Maximum expiry for impersonation tokens in ms (default: 3600000 = 1 hour, capped at 1 hour) */
  impersonation_token_expiry_ms?: number;

  /** Allow CORS from Sandpack/CodeSandbox bundler origins (default: true).
   * Enables artifacts on the hosted bundler to call the Disco API. */
  cors_allow_sandpack?: boolean;

  /** Additional allowed CORS origins.
   * Plain strings are exact matches. Wrap in /slashes/ for regex patterns.
   * @example
   * ```yaml
   * daemon:
   *   cors_origins:
   *     - https://my-dashboard.example.com
   *     - /\.internal\.example\.com$/
   * ```
   */
  cors_origins?: string[];

  /**
   * Number of reverse proxies in front of the daemon.
   *
   * Maps directly to Express's `app.set('trust proxy', n)`. When > 0, Express
   * (and rate-limit middleware that reads `req.ip`) will honour the rightmost
   * `n` entries of `X-Forwarded-For` and `X-Forwarded-Proto`. Setting this
   * higher than the actual hop count lets a client spoof their IP via
   * `X-Forwarded-For`, so leave it at 0 unless you actually have a proxy in
   * front of the daemon.
   *
   * Default: 0 (do not trust X-Forwarded-* headers).
   */
  trust_proxy_hops?: number;
}

/**
 * UI settings
 */
export interface DiscoUISettings {
  /**
   * Public user-facing base URL for the UI.
   *
   * Set this when the browser UI is served from a different origin than the
   * daemon, such as the two-process development setup. When omitted, browser
   * links fall back to daemon.base_url. It also remains a compatibility
   * fallback for older one-origin installations.
   */
  base_url?: string;

  /** UI dev server port (default: 5173) */
  port?: number;

  /** UI host (default: localhost) */
  host?: string;
}

/**
 * Database configuration settings
 */
export interface DiscoDatabaseSettings {
  /** Database dialect (default: 'sqlite') */
  dialect?: 'sqlite' | 'postgresql';

  /** SQLite configuration */
  sqlite?: {
    /** Database file path (default: '~/.disco/disco.db') */
    path?: string;

    /** Enable WAL mode (default: true) */
    walMode?: boolean;

    /** Busy timeout in ms (default: 5000) */
    busyTimeout?: number;
  };

  /** PostgreSQL configuration */
  postgresql?: {
    /** Connection URL (postgresql://user:pass@host:port/db) */
    url?: string;

    /** Individual connection parameters (alternative to URL) */
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;

    /** Connection pool settings */
    pool?: {
      min?: number; // Default: 2
      max?: number; // Default: 10
      idleTimeout?: number; // Default: 30000ms
    };

    /** SSL/TLS configuration */
    ssl?:
      | boolean
      | {
          rejectUnauthorized?: boolean;
          ca?: string;
          cert?: string;
          key?: string;
        };

    /** Schema name (default: 'public') */
    schema?: string;
  };
}

/**
 * Execution substrate and local filesystem-isolation mode.
 *
 * - `simple` — all processes run as the daemon user (no OS isolation)
 * - `delegated` — external launcher/substrate execution; every user MUST have
 *   a `unix_username` home key, which is passed to the execution
 *   substrate (e.g. the `{unix_user}` executor-command-template variable, which
 *   hosted deployments use to select per-user home mounts) and its absence
 *   fails loudly instead of silently sharing an identity
 * - `sandbox` — daemon-user execution with isolation enforced by the executor
 *   **filesystem sandbox** (bubblewrap): each account gets a per-owner home
 *   overlay (`sandbox.home_mode: per_user`) and its complete Disco user
 *   workspace is mounted as one writable unit. Linux only. See
 *   `context/explorations/executor-sandboxing.md`.
 */
export type UnixUserMode = 'simple' | 'delegated' | 'sandbox';

export interface DiscoExecutorHeartbeatSettings {
  /** Enable executor task heartbeats (default: true). */
  enabled?: boolean;

  /** Heartbeat interval in milliseconds (default: 10000). */
  interval_ms?: number;

  /** Stale threshold in milliseconds. Default: max(3 * interval_ms, 30000). */
  stale_after_ms?: number | null;

  /** Optional external command callback invoked on each heartbeat. */
  callback?: {
    /** Shell command to run. Receives heartbeat JSON on stdin. Disabled when null/undefined. */
    command_template?: string | null;
    /** Callback timeout in milliseconds (default: 3000). */
    timeout_ms?: number;
  };
}

/**
 * Which Disco-managed dynamic roots the sandbox should grant WRITE access to.
 * The daemon/executor resolves each `true` flag to concrete absolute paths it
 * already knows. A workspace grant covers the current account's entire
 * `worktrees/user-*` directory, so Agents and standalone sessions owned by the
 * same user remain mutually accessible.
 */
export interface DiscoSandboxIncludeSettings {
  /** Current user's Disco workspace (or the task cwd when external). Default: true. */
  workspace?: boolean;
  /** `/tmp` (+ a task-private temp). Default: true. */
  tmp?: boolean;
  /** All of `$HOME` (dangerous — secrets still denied via `protect_secrets`). Default: false. */
  home?: boolean;
}

/**
 * OS-level executor sandbox policy. Global, single-policy — deliberately NOT
 * per-session to avoid config-hell. Disabled by default; `disco init` offers a
 * one-shot opt-in.
 *
 * When enabled, Disco wraps each AGENT executor spawn (prompt tasks + web
 * terminals) in `bubblewrap` at the `spawnExecutorLocal` chokepoint, so the
 * isolation policy is uniform across tools — not per-tool. (Daemon-internal
 * bounded executor commands run unwrapped as Disco's own code.) The sandbox
 * unshares the user + mount namespaces (and PID where the host allows it) but
 * NOT the network (`--share-net`), so the executor keeps its daemon/model
 * connectivity. Network egress control, if wanted, is left to each tool's own config.
 *
 * Disco resolves `include.*` / `protect_secrets` into bubblewrap bind mounts
 * and masks using paths it already knows. See
 * `context/explorations/executor-sandboxing.md`.
 */
export interface DiscoSandboxSettings {
  /** Master switch. Default: false (open filesystem; tool approval flows still apply). */
  enabled?: boolean;
  /** Dynamic write roots Disco grants (workspace/tmp/home). */
  include?: DiscoSandboxIncludeSettings;
  /**
   * Deny reads of the daemon trust-root + common credential dirs
   * (`~/.disco/config.yaml`, `disco.db`, `~/.ssh`, `~/.gnupg`, `~/.aws`,
   * `~/.config/gcloud`, `~/.npmrc`). Applied even when `include.home` is true.
   * Default: true.
   */
  protect_secrets?: boolean;
  /**
   * How the executor's `$HOME` is presented inside the sandbox:
   *  - `shared` (default): the daemon user's real home, with tool state/cache
   *    dirs writable and the daemon trust-root + credential dirs masked.
   *  - `per_user`: overlay a **per-owner home store**
   *    (`<data_home>/tenants/<tenant>/homes/<owner_id>`) at the passwd home, so
   *    `~` is a private, persistent home per session owner. The overlay hides
   *    the entire daemon `.disco` tree (config, db, worktrees) and every
   *    other user's home by construction. When the data root lives outside the
   *    passwd home, Disco masks that root explicitly. Symlink aliases of the
   *    home and data root are masked as well. The current user's complete
   *    workspace and managed agentic-tools are re-exposed on top. This keeps
   *    users isolated without separating an owner's Agents and sessions.
   *    Default: `shared`.
   */
  home_mode?: 'shared' | 'per_user';
  /**
   * Preserve a symlinked daemon home's canonical alias inside a per-user
   * sandbox. The owner store and authorized dynamic paths are exposed at both
   * the passwd-home path and its daemon-resolved canonical path, and the
   * canonical workspace path becomes the executor cwd. This keeps path-keyed SDK
   * state resumable on non-standard hosts without exposing the canonical homes
   * parent. Default: false.
   */
  preserve_canonical_home_alias?: boolean;
  /** Extra writable paths added to the `include.*` roots (escape hatch). */
  extra_allow_write?: string[];
  /** Extra denied-read paths added to `protect_secrets` (escape hatch). */
  extra_deny_read?: string[];
  /**
   * Hard-fail a task if the sandbox cannot start (missing `bwrap` / unsupported
   * platform) instead of running unsandboxed. Recommended `true` for
   * production security gates. Default: false.
   */
  fail_if_unavailable?: boolean;
}

/**
 * Execution settings
 */
export interface DiscoExecutionSettings {
  /**
   * Lightweight heartbeat settings for long-running executor tasks.
   *
   * The executor reports `tasks.last_executor_heartbeat_at` immediately and
   * then every `interval_ms` while a task is active. After `stale_after_ms`,
   * the daemon requests containment and fails the task only after verified absence.
   * Optional callbacks are shell commands that receive a small JSON payload on
   * stdin; keep secrets out of the command argv.
   */
  executor_heartbeat?: DiscoExecutorHeartbeatSettings;
  sdk_watchdog?: {
    mode?: 'disabled' | 'observe' | 'enforce';
    first_progress_timeout_ms?: number;
    abort_grace_ms?: number;
    claude_idle_timeout_ms?: number | null;
  };

  dispatch_connect_timeout_ms?: number | null;

  /** Execution mode: trusted local, delegated external, or local Linux sandbox. */
  unix_user_mode?: UnixUserMode;

  /** Allow the superadmin role (default: false). Opt-in for self-hosted deployments. */
  allow_superadmin?: boolean;

  /**
   * User IDs to promote to superadmin at daemon startup (promote-only, no demotion).
   *
   * - Applied only when allow_superadmin is true
   * - Intended for bootstrap/recovery in self-hosted deployments
   * - Uses stable user IDs (UUIDv7), not emails
   */
  bootstrap_superadmin_users?: string[];

  /** Session token expiration in ms (default: 86400000 = 24 hours) */
  session_token_expiration_ms?: number;

  /** Maximum session token uses (default: 1 = single-use, -1 = unlimited) */
  session_token_max_uses?: number;

  /**
   * MCP session token expiration in ms (default: 86400000 = 24 hours).
   *
   * Applies to the internal MCP tokens minted for each Disco session
   * (aud: `disco:mcp:internal`). Every issued token now carries an `exp`
   * claim; this value controls the lifetime.
   *
   * Does NOT affect the (separate) executor-side `session_token_*` settings,
   * which gate the short-lived JWT issued to spawned subprocesses.
   */
  mcp_token_expiration_ms?: number;

  /**
   * When true (default), the daemon writes the initial user-message row inside
   * `POST /sessions/:id/prompt`, immediately after the task is created. This
   * guarantees the chat transcript reflects what the user typed even if the
   * executor crashes during startup ("never lose a prompt").
   *
   * Set to false to revert to the legacy behavior where the executor is the
   * sole writer of the user-message row. The legacy behavior is racy: any
   * crash before the executor connects back via Feathers leaves the prompt
   * visible only on `tasks.full_prompt`, not in the chat transcript.
   *
   * Kill switch only — intended for emergency rollback. The executor's
   * `createUserMessage` path always honors a "skip if user-message row already
   * exists for this task" guard, so toggling this flag is safe at runtime.
   */
  daemon_writes_user_message?: boolean;

  /** Permission request timeout in ms (default: 600000 = 10 minutes). When a permission request is not resolved within this time, the agent is notified and can continue. */
  permission_timeout_ms?: number;

  /**
   * Executor command template for remote/containerized execution.
   *
   * When null/undefined (default), executors are spawned as local subprocesses.
   * When set, the template is used to spawn executors in containers/pods.
   *
   * Template variables (substituted at spawn time):
   * - {task_id} - Unique task identifier (for pod naming)
   * - {command} - Executor command (prompt, git.clone, etc.)
   * - {unix_user} - Compatibility delegated home key
   * - {session_id} - Session ID (if available)
   * - {user_id} - Trusted authenticated Disco user UUID (if available)
   * - {tenant_id} - Trusted ambient tenant ID (shell-escaped; fails if unavailable)
   *
   * The template command receives JSON payload via stdin and should pipe it
   * to `disco-executor --stdin`.
   *
   * @example Kubernetes execution
   * ```yaml
   * executor_command_template: |
   *   kubectl run executor-{task_id} \
   *     --image=ghcr.io/preset-io/disco-executor:latest \
   *     --rm -i --restart=Never \
   *     --labels="disco-tenant={tenant_id},disco-user={user_id}" \
   *     -- disco-executor --stdin
   * ```
   *
   * @example Docker execution
   * ```yaml
   * executor_command_template: |
   *   docker run --rm -i \
   *     --label disco.tenant={tenant_id} --label disco.user={user_id} \
   *     -v /data/disco:/data/disco \
   *     ghcr.io/preset-io/disco-executor:latest \
   *     disco-executor --stdin
   * ```
   */
  executor_command_template?: string;

  /**
   * Filesystem guarantees provided to every executor invocation.
   *
   * This is an operator assertion about the execution substrate, not a mount
   * instruction interpreted by the daemon. It applies to templated executors
   * even when the daemon itself is standalone; HA consumes it to fail unsafe
   * topology combinations at startup.
   */
  executor_storage?: DiscoExecutorStorageSettings;

  /** A nonzero template launcher may still have submitted remote work. Default: false. */
  executor_command_nonzero_may_have_dispatched?: boolean;

  /**
   * Required user environment variables.
   * When set, prompts are blocked if any listed var is missing from the user's resolved environment.
   * Users are directed to Settings → Environment Variables to configure them.
   * Default: unset (no enforcement)
   *
   * @example Require git identity for proper commit attribution
   * ```yaml
   * execution:
   *   required_user_env_vars:
   *     - GIT_AUTHOR_NAME
   *     - GIT_AUTHOR_EMAIL
   *     - GIT_COMMITTER_NAME
   *     - GIT_COMMITTER_EMAIL
   * ```
   */
  required_user_env_vars?: string[];

  /**
   * OS-level executor sandbox policy (SRT: bubblewrap / Seatbelt). Disabled by
   * default. Global, single-policy. See `context/explorations/executor-sandboxing.md`.
   */
  sandbox?: DiscoSandboxSettings;
}

/** Consistency of the effective user's home across executor invocations. */
export type DiscoExecutorUserHomeStorage = 'replica-local' | 'shared' | 'persistent-per-user';

/** Consistency and isolation of Session working directories across executors. */
export type DiscoExecutorSessionWorkspaceStorage =
  | 'replica-local'
  | 'shared'
  | 'persistent-per-session';

/**
 * Declarative execution-substrate storage contract.
 *
 * `persistent-per-user` is keyed by trusted tenant/user identity and is the
 * only mode suitable for user credential homes in a multi-tenant external
 * executor fleet. `persistent-per-session` similarly means any invocation for
 * a Session sees the same durable working directory at the DB-recorded path.
 */
export interface DiscoExecutorStorageSettings {
  user_home?: DiscoExecutorUserHomeStorage;
  session_workspace?: DiscoExecutorSessionWorkspaceStorage;
}

/**
 * Security headers & CORS settings.
 *
 * Makes the daemon's Content-Security-Policy and CORS policy tunable from
 * `~/.disco/config.yaml` without code changes. See `context/concepts/security.md`
 * for the full model and the rationale behind the two-tier CSP shape.
 */

/**
 * Per-directive CSP source lists, keyed by the standard directive names.
 *
 * Keys must be lowercase-hyphenated directive names (e.g. `script-src`,
 * `frame-src`, `connect-src`). Values are arrays of CSP source expressions
 * (`'self'`, `'unsafe-inline'`, URLs, schemes, nonces, etc.). The loader
 * rejects unknown directive names with a friendly error.
 */
export type DiscoCspDirectives = Record<string, string[]>;

/**
 * CSP configuration.
 *
 * Two-tier model:
 *   - `extras`: append to built-in defaults (append-only, 95% case)
 *   - `override`: fully replace a directive's source list (escape hatch)
 *
 * Setting a directive in `override` causes defaults AND extras for that
 * directive to be ignored — `override` is authoritative per-directive.
 *
 * Examples:
 * ```yaml
 * security:
 *   csp:
 *     extras:
 *       script-src: ["https://plausible.io"]
 *       frame-src: ["https://my-sandbox.example.com"]
 *     override:
 *       img-src: ["'self'", "data:"]
 * ```
 */
export interface DiscoCspSettings {
  /**
   * Per-directive APPEND to built-in defaults. This is the 95% case.
   * Entries are merged and de-duplicated with the built-in default sources.
   */
  extras?: DiscoCspDirectives;

  /**
   * Full replacement of a directive's source list. Escape hatch — rarely needed.
   * Setting a directive here ignores defaults AND extras for that directive.
   */
  override?: DiscoCspDirectives;

  /**
   * Path (or absolute URL) that receives CSP violation reports. When set:
   *   - emits the `report-uri` directive on the CSP header (deprecated but
   *     still supported by all browsers)
   *   - emits a `Report-To` header pointing at the same path (modern browsers)
   *   - the daemon hosts a rate-limited endpoint at this path that logs
   *     incoming reports at `warn` level.
   * @example "/api/csp-report"
   */
  report_uri?: string;

  /**
   * Emit as `Content-Security-Policy-Report-Only` instead of enforcing.
   * Useful for iterating on policy without breaking the app.
   * Default: false.
   */
  report_only?: boolean;

  /**
   * Fully disable the CSP header. Dev/debug only — the daemon emits a loud
   * startup warning when this is true. Default: false.
   */
  disabled?: boolean;
}

/**
 * How CORS origins are resolved.
 *
 * - `list` (default): only origins in `origins` are allowed (plus built-ins:
 *   localhost, Sandpack if enabled).
 * - `wildcard`: reflect ANY origin. Forces `credentials: false`. Dangerous
 *   outside of local dev; the daemon refuses to boot in hardened deployment
 *   modes when this is set.
 * - `reflect`: echo the request's `Origin` header back as the allowed origin.
 *   Less permissive than wildcard for caches (Vary: Origin), but still permits
 *   any caller — treat it like wildcard for threat-model purposes.
 * - `null-origin`: allow the literal `Origin: null` header (sandboxed iframes,
 *   file:// documents). Rarely needed.
 */
export type DiscoCorsMode = 'list' | 'wildcard' | 'reflect' | 'null-origin';

/**
 * CORS configuration.
 *
 * Supersedes the legacy `daemon.cors_origins` and `daemon.cors_allow_sandpack`
 * keys. Those still work for backwards compatibility — their values are merged
 * in when `security.cors.origins` is absent — but they emit a deprecation
 * warning at startup. The `CORS_ORIGIN` env var continues to win over all
 * config sources to keep existing deployments working.
 */
export interface DiscoCorsSettings {
  /**
   * Origin resolution strategy. Defaults to `list`.
   */
  mode?: DiscoCorsMode;

  /**
   * Exact origins or `/regex/` patterns to allow (used when `mode: list`).
   * Plain strings are exact matches; wrap in `/slashes/` for regex.
   */
  origins?: string[];

  /**
   * Whether to emit `Access-Control-Allow-Credentials: true`. Default: true.
   * Rejected at config load when combined with `mode: wildcard` or `reflect`
   * (the CORS spec forbids credentialed wildcard reflection).
   */
  credentials?: boolean;

  /**
   * Allowed methods. Defaults to the `cors` package's default set.
   */
  methods?: string[];

  /**
   * Allowed request headers. When omitted, the `cors` package reflects
   * `Access-Control-Request-Headers` (its default behaviour).
   */
  allowed_headers?: string[];

  /**
   * Value for the `Access-Control-Max-Age` preflight cache header, in seconds.
   * Default: unset (leaves it to the `cors` package default, usually 5s).
   */
  max_age_seconds?: number;

  /**
   * Allow Sandpack/CodeSandbox bundler origins (`https://*.codesandbox.io`).
   * Defaults to true so first-party artifacts work out of the box.
   */
  allow_sandpack?: boolean;
}

/**
 * `security.git_config_parameters` shape. Mirrors `security.csp`: `extras`
 * appends to safe defaults, `override` replaces them. Mutually exclusive.
 *
 * Defaults + rationale: `docs/internal/credential-leak-defenses-2026-05-11.md`.
 * Don't bake credential-bearing values (e.g. `http.proxy=http://user:pass@…`)
 * here — the daemon redacts them from logs but the env var itself isn't
 * routed through the encrypted env-file path.
 */
export interface DiscoGitConfigParametersSettings {
  extras?: string[];
  override?: string[];
}

/**
 * Top-level security config block.
 */
export interface DiscoSecuritySettings {
  /** Content-Security-Policy configuration (extras/override/report-only/disabled). */
  csp?: DiscoCspSettings;

  /** CORS configuration (origins, credentials, methods, headers, max-age). */
  cors?: DiscoCorsSettings;

  /** Git config hardening — see {@link DiscoGitConfigParametersSettings}. */
  git_config_parameters?: DiscoGitConfigParametersSettings;
}

/**
 * Path configuration settings
 *
 * Allows separation of daemon operating files from user workspaces and other
 * durable Disco data. This enables different storage backends for runtime and
 * user-owned content.
 *
 * @see context/explorations/executor-expansion.md
 */
export interface DiscoPathSettings {
  /**
   * Durable Disco data directory
   *
   * When set, user workspaces, uploads and managed runtime data are stored here
   * instead of under disco_home. Useful when durable data needs shared storage.
   *
   * Default: same as disco_home (~/.disco)
   *
   * Environment variable: DISCO_DATA_HOME (takes precedence over config)
   *
   * @example
   * ```yaml
   * paths:
   *   data_home: /data/disco
   * ```
   */
  data_home?: string;
}

/**
 * Public community telemetry settings.
 *
 * This is intentionally separate from `analytics`: `analytics` is for
 * operator-configured instance analytics, while `telemetry` is Disco's
 * lightweight opt-in community install and aggregate usage telemetry.
 */
export interface DiscoTelemetrySettings {
  /** Ongoing telemetry opt-in. Undefined means the user has not answered yet. */
  enabled?: boolean;

  /** Random anonymous install identifier. Never derived from host/user data. */
  instance_id?: string;

  /** Advanced override for the Segment-compatible batch endpoint. Usually omitted. */
  endpoint?: string | null;

  /** Advanced override for direct Segment/RudderStack delivery. Usually omitted. */
  write_key?: string | null;

  /** Debug delivery without dumping payloads by default. */
  debug?: boolean;

  /** Delivery timeout. Defaults to 3000ms. */
  timeout_ms?: number;

  /** Batch flush interval. Defaults to 1000ms. */
  flush_interval_ms?: number;

  /** Maximum events per batch. Defaults to 10. */
  max_batch_size?: number;

  /** Last one-time install/result telemetry event sent by disco init. */
  install_ping_sent_at?: string;

  /** Last daemon active heartbeat day (YYYY-MM-DD). */
  last_daemon_active_day?: string;

  /** Last aggregate usage summary day (YYYY-MM-DD). */
  last_usage_summary_day?: string;

  /** Last daemon version that emitted daemon.upgraded. */
  last_reported_version?: string;
}

/**
 * Backend analytics settings.
 *
 * Disabled by default. When enabled, daemon/server code sends curated
 * lifecycle events through a central analytics client. Plugin configuration is
 * resolved by type at daemon startup. Events emitted inside a trusted tenant
 * scope automatically include that tenant as `context.tenant_id`.
 */
export interface DiscoAnalyticsSettings {
  /** Master kill-switch. Defaults to false. */
  enabled?: boolean;

  /** Static client options passed to the underlying analytics package. */
  client?: {
    app?: string;
    version?: string | number;
    debug?: boolean;
  };

  /** Simple event-name filters. */
  filters?: {
    /** Exact names or simple `*` globs to exclude before delivery. */
    exclude_events?: string[];
  };

  /** Analytics delivery plugins. */
  plugins?: DiscoAnalyticsPluginSettings[];
}

export type DiscoAnalyticsPluginSettings =
  | DiscoAnalyticsStdoutPluginSettings
  | DiscoAnalyticsHttpBatchPluginSettings;

export interface DiscoAnalyticsStdoutPluginSettings {
  type: 'stdout';
  enabled?: boolean;
  options?: {
    /** Pretty-print JSON instead of emitting JSON lines. Defaults to false. */
    pretty?: boolean;
  };
}

export interface DiscoAnalyticsHttpBatchPluginSettings {
  type: 'http_batch';
  enabled?: boolean;
  options?: {
    /** Destination URL. Required when this plugin is enabled. */
    url?: string | null;
    flush_interval_ms?: number;
    max_batch_size?: number;
    timeout_ms?: number;
    /** Static headers only. */
    headers?: Record<string, string>;
  };
}

/**
 * App-level multi-tenancy settings.
 *
 * `static` preserves today's single-tenant behavior: every request belongs to
 * one configured tenant id. `required_from_auth` is Postgres-only hosted/cloud
 * mode and must resolve a tenant from trusted authentication or request
 * context; missing tenant context should fail closed before tenant-owned data is
 * accessed.
 */
export interface DiscoMultiTenancySettings {
  /** Store tenant-owned filesystem data below a tenant-specific root. Defaults to false. */
  filesystem_isolation_enabled?: boolean;

  /**
   * Parent directory for tenant data. Absolute paths and paths relative to
   * `~/.disco` are supported. Defaults to `~/.disco/tenants`.
   */
  tenants_base_folder?: string;

  /** Multi-tenancy mode. Defaults to `static`. */
  mode?: 'static' | 'required_from_auth';

  /** Static tenant id for self-hosted/single-instance mode. Defaults to `default`. */
  static_tenant_id?: string;

  /** JWT/user claim name to read in `required_from_auth` mode, e.g. `tenant_id`. */
  auth_claim?: string;

  /** Optional trusted HTTP header set by an auth/edge layer, e.g. `x-disco-tenant-id`. */
  trusted_header?: string;
}

/** Canonical upload storage and lifecycle settings. */
export interface DiscoUploadSettings {
  /**
   * Base local directory or S3 URI. Defaults to `~/.disco`.
   * Disco manages the tenant and feature namespaces below this base.
   * Credentials are resolved out-of-band and must not be embedded in this URI.
   */
  location?: string;

  /** Maximum age from creation in days. Zero disables automatic expiry. */
  max_age_days?: number;

  /** Maximum bytes accepted for one file, expressed in MiB. */
  max_file_size_mb?: number;
}

/** Explicit daemon deployment topology. HA is never inferred from Redis. */
export type DiscoDeploymentMode = 'standalone' | 'ha';

/**
 * Deliberately constrained first active-active support envelope. This is an
 * operator acknowledgement, not a claim that every Disco surface is movable.
 */
export type DiscoHaSupportProfile = 'constrained-active-active';

/** How tenant workspace operations reach their filesystem authority in HA. */
export type DiscoHaExecutionTopology = 'shared-local' | 'external';

/** Redis fanout settings used only when {@link DiscoDeploymentSettings.mode} is `ha`. */
export interface DiscoRedisSettings {
  /** redis:// or rediss:// URL. Prefer an environment override for credentials. */
  url?: string;
  /** Deployment-unique operational namespace (not an authorization boundary). */
  key_prefix?: string;
  /** TCP/TLS connect timeout. Default: 5000. */
  connect_timeout_ms?: number;
  /** Total startup window for both pub/sub clients. Default: 15000. */
  startup_timeout_ms?: number;
  /** Socket.IO adapter inter-server request timeout. Default: 5000. */
  request_timeout_ms?: number;
  /** Initial reconnect delay. Default: 100. */
  reconnect_base_delay_ms?: number;
  /** Maximum reconnect delay. Default: 2000. */
  reconnect_max_delay_ms?: number;
}

/** Operator assertions required for the first supported HA topology. */
export interface DiscoHaTopologySettings {
  /** Required explicit acknowledgement of the constrained initial HA surface. */
  support_profile?: DiscoHaSupportProfile;
  /**
   * `shared-local` runs executor commands beside each daemon and therefore
   * requires identical workspace paths. `external` routes them through an
   * explicitly configured executor command template and requires no tenant
   * filesystem mount in daemon pods.
   */
  execution_topology?: DiscoHaExecutionTopology;
  /** Required only for `shared-local`; not a general HA/Cloud requirement. */
  shared_filesystem?: boolean;
  /** The ingress keeps Engine.IO polling requests on one daemon. */
  ingress_affinity?: boolean;

  /** PostgreSQL-coordinated managed-environment health observation worker. */
  environment_health_monitor?: DiscoHaEnvironmentHealthMonitorSettings;
}

export interface DiscoHaEnvironmentHealthMonitorSettings {
  /** Delay between active scans before idle backoff. Default: 5000. */
  scan_interval_ms?: number;
  /** Maximum idle discovery backoff. Default: 30000. */
  max_idle_interval_ms?: number;
  /** Per-replica randomized startup offset ceiling. Default: 3000. */
  startup_offset_max_ms?: number;
  /** Maximum routing references returned by one discovery page. Default: 32. */
  scan_batch_size?: number;
  /** Maximum concurrent HTTP observations on one daemon. Default: 8. */
  max_in_flight?: number;
  /** Per-request health endpoint timeout. Default: 1000. */
  http_timeout_ms?: number;
  /** One-observation database lease. Must exceed HTTP timeout by 5000ms. Default: 15000. */
  claim_lease_ms?: number;
  /** Graceful shutdown drain bound. Default: 5000. */
  shutdown_drain_timeout_ms?: number;
}

export interface DiscoDeploymentSettings {
  /** Defaults to standalone. REDIS_URL alone never changes this value. */
  mode?: DiscoDeploymentMode;
  redis?: DiscoRedisSettings;
  ha?: DiscoHaTopologySettings;
}

/**
 * Complete Disco configuration
 */
export interface DiscoConfig {
  /** Deployment-owned agentic-tool package selection. */
  agentic_tools?: DiscoAgenticToolsSettings;

  /** Explicit standalone or multi-daemon topology. */
  deployment?: DiscoDeploymentSettings;

  /** Daemon settings */
  daemon?: DiscoDaemonSettings;

  /** UI settings */
  ui?: DiscoUISettings;

  /** Database configuration */
  database?: DiscoDatabaseSettings;

  /** Execution isolation settings */
  execution?: DiscoExecutionSettings;

  /** Security headers & CORS (CSP extras/override, CORS mode/origins, etc.) */
  security?: DiscoSecuritySettings;

  /** Path configuration for durable user workspaces and managed data. */
  paths?: DiscoPathSettings;

  /** Backend analytics settings. Disabled by default. */
  analytics?: DiscoAnalyticsSettings;

  /** Public community telemetry settings. */
  telemetry?: DiscoTelemetrySettings;

  /** App-level multi-tenancy settings. Defaults to static/default tenant. */
  multi_tenancy?: DiscoMultiTenancySettings;

  /** Upload storage and lifecycle policy. */
  uploads?: DiscoUploadSettings;
}

/**
 * Valid config keys (includes nested keys with dot notation)
 */
export type ConfigKey =
  | `agentic_tools.${keyof DiscoAgenticToolsSettings}`
  | `deployment.${keyof DiscoDeploymentSettings}`
  | `daemon.${keyof DiscoDaemonSettings}`
  | `ui.${keyof DiscoUISettings}`
  | `database.${keyof DiscoDatabaseSettings}`
  | `execution.${keyof DiscoExecutionSettings}`
  | `security.${keyof DiscoSecuritySettings}`
  | `paths.${keyof DiscoPathSettings}`
  | `analytics.${keyof DiscoAnalyticsSettings}`
  | `telemetry.${keyof DiscoTelemetrySettings}`
  | `multi_tenancy.${keyof DiscoMultiTenancySettings}`
  | `uploads.${keyof DiscoUploadSettings}`;
