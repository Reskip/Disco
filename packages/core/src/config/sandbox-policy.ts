/**
 * Executor sandbox policy resolver (pure)
 *
 * Turns the operator-facing {@link DiscoSandboxSettings} policy + the concrete
 * paths Disco already knows (task cwd, owning user workspace, home) into a
 * **bubblewrap** argument list. The daemon prepends `bwrap <args> --` to each
 * AGENT executor spawn (prompt tasks + web terminals) at the `spawnExecutorLocal`
 * chokepoint, so the isolation policy is uniform across all agentic tools and
 * terminals. (Daemon-internal bounded executor commands — git-state/autocomplete
 * probes, file reads, OAuth — run unwrapped as Disco's own code.)
 *
 * The sandbox unshares the **user + mount** namespaces (and the **PID**
 * namespace where the host allows it — see `pidNamespace`) but NOT the network:
 * we do NOT pass `--unshare-net`, so the executor keeps its daemon/model
 * loopback connectivity. (SRT/`srt` always unshare-nets, which severs the
 * executor↔daemon loopback — hence raw bwrap.)
 *
 * Pure — no `fs`, no `os`. The daemon supplies concrete paths from its own
 * authoritative state (Session working directory, user workspace, home) and
 * spawns `bwrap`.
 *
 * Ordering matters: bubblewrap applies binds left-to-right, and a later bind on
 * an overlapping path wins. We emit base → writable → denials so masks win.
 * See `context/explorations/executor-sandboxing.md`.
 */

import { posix } from 'node:path';
import type { DiscoSandboxSettings } from './types';

// bubblewrap only runs on Linux. Always resolve its mount paths with POSIX
// semantics, including when this pure resolver is exercised by Windows CI.
const { dirname, isAbsolute, join, relative } = posix;

/** Effective defaults for the Disco sugar layer. */
export const SANDBOX_INCLUDE_DEFAULTS = {
  workspace: true,
  tmp: true,
  home: false,
} as const;

export const SANDBOX_PROTECT_SECRETS_DEFAULT = true;
export const SANDBOX_FAIL_IF_UNAVAILABLE_DEFAULT = false;
export const SANDBOX_HOME_MODE_DEFAULT = 'shared' as const;

/** Temp roots replaced with a fresh (task-private) tmpfs when `include.tmp`. */
export const SANDBOX_TMP_DIRS = ['/tmp', '/var/tmp'] as const;

/**
 * Home-relative dirs kept writable when `include.home` is false, so agentic
 * tools can still write their own config/cache/auth state and function.
 */
export const SANDBOX_HOME_WRITABLE_SUBDIRS = [
  '.cache',
  '.config',
  '.local',
  '.npm',
  '.claude',
  '.codex',
  '.gemini',
] as const;

/** Home-relative credential FILES masked (read-as-empty) under `protect_secrets`. */
export const SANDBOX_SECRET_HOME_FILES = ['.npmrc'] as const;
/** Home-relative credential DIRS masked (hidden via empty tmpfs) under `protect_secrets`. */
export const SANDBOX_SECRET_HOME_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  join('.config', 'gcloud'),
] as const;

/** Concrete paths the resolver needs — all absolute. Supplied by the daemon. */
export interface SandboxPathContext {
  /** Session working directory (the task cwd). */
  workspacePath: string;
  /**
   * Canonical `worktrees/user-*` root for the Session owner. When supplied,
   * the whole root is exposed as one writable unit so same-user Agents and
   * standalone sessions can deliberately share files.
   */
  userWorkspaceRoot?: string;
  /**
   * Whether to unshare a PID namespace (`--unshare-pid`). Default (unset/true)
   * adds it — the secure baseline that hides the daemon/siblings from the
   * sandbox's /proc. The daemon sets this to `false` when the host cannot mount
   * proc in a nested PID namespace (common in containers), degrading to a
   * user+mount sandbox rather than failing.
   */
  pidNamespace?: boolean;
  /** The effective user's home directory (the passwd home / overlay mountpoint). */
  homeDir: string;
  /**
   * Canonical target of {@link homeDir}, when it differs because the passwd
   * home traverses symlinks. Both paths must be hidden: otherwise the same
   * files remain reachable through the canonical alias beneath the root bind.
   */
  canonicalHomeDir?: string;
  /**
   * Disco's daemon data root. In a conventional install this is under
   * {@link homeDir} and the per-user overlay hides it automatically. Hosted
   * installs may place it elsewhere (for example on a persistent volume), in
   * which case per-user mode must mask it explicitly before re-exposing the
   * owner's workspace and managed tools.
   */
  dataHome?: string;
  /** Canonical target of {@link dataHome}, for the same alias protection. */
  canonicalDataHome?: string;
  /** Additional deployment data roots (for example a custom tenants base). */
  protectedDataRoots?: string[];
  /**
   * Per-owner home store to overlay at {@link homeDir} when
   * `home_mode: per_user`. When set, it REPLACES the shared-home logic: the
   * overlay hides the daemon `.disco` tree + other homes by construction, so the
   * owner's workspace and agentic-tools are re-exposed on top. Absolute path;
   * the daemon guarantees it exists before spawn.
   */
  ownerHomeStore?: string;
  /**
   * Managed agentic-tools dir (`~/.disco/agentic-tools`) re-exposed read-only in
   * `per_user` mode (the overlay would otherwise hide it). Ignored in shared
   * mode. `--ro-bind-try`, so a source-mode install without it is fine.
   */
  agenticToolsPath?: string;
  /** Absolute path to `~/.disco/config.yaml` — masked under protect_secrets. */
  discoConfigPath?: string;
  /** Absolute path to `~/.disco/disco.db` — masked under protect_secrets. */
  discoDbPath?: string;
}

/**
 * Resolve an {@link DiscoSandboxSettings} policy + paths into a bubblewrap
 * argument list (everything before the trailing `-- <command>`). Pure. Assumes
 * the caller already checked `sandbox.enabled`.
 */
export function resolveBwrapArgs(sandbox: DiscoSandboxSettings, ctx: SandboxPathContext): string[] {
  const include = { ...SANDBOX_INCLUDE_DEFAULTS, ...(sandbox.include ?? {}) };
  const protectSecrets = sandbox.protect_secrets ?? SANDBOX_PROTECT_SECRETS_DEFAULT;
  const homeMode = sandbox.home_mode ?? SANDBOX_HOME_MODE_DEFAULT;
  // FAIL CLOSED: `per_user` MUST have a resolved owner store. Silently falling
  // back to the shared daemon home would defeat the whole point of the mode
  // (the caller asked for per-user isolation and would instead get the daemon's
  // home). The daemon is responsible for resolving/creating the store before
  // calling; a missing store is a programming error, not a soft downgrade.
  if (homeMode === 'per_user' && !ctx.ownerHomeStore) {
    throw new Error(
      'sandbox home_mode=per_user requires an owner home store, but none was resolved. ' +
        'Refusing to fall back to a shared home (fail closed).'
    );
  }
  const perUser = homeMode === 'per_user';
  const preserveCanonicalHomeAlias =
    perUser &&
    sandbox.preserve_canonical_home_alias === true &&
    !!ctx.canonicalHomeDir &&
    ctx.canonicalHomeDir !== ctx.homeDir;
  if (preserveCanonicalHomeAlias) {
    if (!isAbsolute(ctx.canonicalHomeDir as string) || ctx.canonicalHomeDir === '/') {
      throw new Error(
        `Invalid canonical sandbox home ${ctx.canonicalHomeDir}: expected an absolute path below /`
      );
    }
  }
  validateWorkspacePath(ctx.workspacePath, 'workspacePath');
  if (ctx.userWorkspaceRoot) validateWorkspacePath(ctx.userWorkspaceRoot, 'userWorkspaceRoot');

  const args: string[] = [
    '--die-with-parent', // bwrap exits when the daemon kills the process group
    '--unshare-user', // unprivileged mount namespace (host uid preserved)
  ];
  // Fresh PID namespace: the sandbox's /proc shows ONLY its own processes, so a
  // same-uid executor cannot reach the daemon's or a sibling's
  // /proc/<pid>/{environ,root,fd,...} — closing the process-side route around
  // the filesystem masks (independent of host ptrace_scope/hidepid). bwrap
  // becomes PID 1 and reaps; verified compatible with Disco's pgid-based Stop
  // (SIGTERM to the executor's process group tears down the whole tree, and the
  // kernel kills the namespace when bwrap exits). BEST-EFFORT: many container
  // runtimes block mounting proc in a nested PID namespace, so the daemon sets
  // `pidNamespace: false` when the host can't do it and we fall back to a
  // user+mount sandbox (in a container the container itself is the boundary).
  // NOT --unshare-net: the network stays shared for daemon/model loopback.
  if (ctx.pidNamespace !== false) args.push('--unshare-pid');
  args.push(
    '--ro-bind',
    '/',
    '/', // everything readable, nothing writable by default
    '--dev',
    '/dev',
    '--proc',
    '/proc'
  );

  if (perUser) {
    // ── per-user home overlay ──────────────────────────────────────────────
    // First wipe the homes PARENT dir (e.g. /home) with an empty tmpfs, so
    // sibling homes are not readable via the `--ro-bind / /` above. This is the
    // cross-user leak fix: without it, once per-user homes live at /home/<user>
    // (the migration layout via `filesystem_home`), one owner's session could
    // read another owner's ~/.codex/auth.json. The overlay below only replaces
    // OUR passwd home, not its siblings. Skip if the parent is `/` (e.g. a
    // /root home) — tmpfs-ing `/` would be catastrophic and root has no sibling
    // homes under a homes dir anyway.
    const hiddenRoots = new Set<string>();
    const homeDirs = [ctx.homeDir, ctx.canonicalHomeDir].filter((path): path is string => !!path);
    for (const homeDir of homeDirs) {
      if (!isAbsolute(homeDir)) {
        throw new Error(`Invalid sandbox home path ${homeDir}: expected an absolute path`);
      }
      const homesParent = dirname(homeDir);
      if (homesParent && homesParent !== '/' && homesParent !== '.') hiddenRoots.add(homesParent);
    }
    // The home overlay only hides data stored below the passwd home. A hosted
    // deployment may keep DISCO_DATA_HOME on a persistent volume elsewhere; the
    // read-only root bind would otherwise leave sibling user workspaces and daemon
    // files visible. Mask that root, then re-expose only the authorized paths
    // below. Bubblewrap resolves bind sources before applying these mounts, so
    // owner stores/workspaces beneath the masked root remain valid sources.
    const dataHomes = [
      ctx.dataHome,
      ctx.canonicalDataHome,
      ...(ctx.protectedDataRoots ?? []),
    ].filter((path): path is string => !!path);
    for (const dataHome of dataHomes) {
      if (!isAbsolute(dataHome) || dataHome === '/') {
        throw new Error(`Invalid sandbox data root ${dataHome}: expected an absolute path below /`);
      }
      if (!homeDirs.some((homeDir) => isPathWithin(dataHome, homeDir))) {
        hiddenRoots.add(dataHome);
      }
    }
    // Keep only outermost masks. Applying a tmpfs to a parent removes nested
    // mountpoints, so emitting another tmpfs for a child could make bwrap fail
    // even though the broader parent mask already provides the protection.
    for (const root of [...hiddenRoots]) {
      if ([...hiddenRoots].some((parent) => parent !== root && isPathWithin(root, parent))) {
        hiddenRoots.delete(root);
      }
    }
    for (const root of hiddenRoots) args.push('--tmpfs', root);
    // Bind the owner's private store OVER the passwd home. This single mount:
    //   • makes `~` a persistent, per-owner home (passwd home + $HOME + tilde
    //     all agree — no `$HOME`-vs-passwd split);
    //   • hides the ENTIRE daemon `.disco` tree (config.yaml, disco.db,
    //     worktrees) by construction — so daemon data is not inherited from
    //     the shared home.
    // The bind SOURCE is resolved from the host root (before the tmpfs above),
    // so a `filesystem_home` under the same parent still binds correctly.
    // We then re-expose exactly what the task needs ON TOP of the overlay.
    args.push('--bind', ctx.ownerHomeStore as string, ctx.homeDir);
    if (preserveCanonicalHomeAlias) {
      args.push('--bind', ctx.ownerHomeStore as string, ctx.canonicalHomeDir as string);
    }

    if (include.tmp) {
      // /tmp lives in the user's OWN home (on disk, per-user, persists across
      // turns) — NOT a RAM tmpfs (which can OOM on big builds) and NOT a shared
      // host /tmp (leaky). Bind <store>/tmp over /tmp; the daemon guarantees the
      // dir exists. It is the SAME underlying dir as ~/tmp (the overlay maps the
      // store to the home), so `/tmp` and `~/tmp` are one place. /var/tmp stays
      // a small ephemeral tmpfs. TMPDIR is pinned below so tools agree.
      args.push('--bind', join(ctx.ownerHomeStore as string, 'tmp'), '/tmp');
      args.push('--tmpfs', '/var/tmp');
    }
    // Re-expose the owner's complete Disco workspace as one writable unit.
    // This intentionally does NOT isolate Agent A from Agent B or an Agent
    // from the owner's standalone sessions. If the task cwd is external to
    // Disco's managed user root, expose that cwd as well.
    if (include.workspace) {
      for (const source of writableWorkspaceRoots(ctx)) {
        for (const destination of homeAliasPaths(source, ctx, preserveCanonicalHomeAlias)) {
          args.push('--bind', source, destination);
        }
      }
    }
    // Re-expose managed tool binaries (hidden by the overlay); ro, tolerant of
    // a source-mode install that has no such dir.
    if (ctx.agenticToolsPath) {
      for (const destination of homeAliasPaths(
        ctx.agenticToolsPath,
        ctx,
        preserveCanonicalHomeAlias
      )) {
        args.push('--ro-bind-try', ctx.agenticToolsPath, destination);
      }
    }
    for (const p of sandbox.extra_allow_write ?? []) args.push('--bind', p, p);
    for (const p of sandbox.extra_deny_read ?? []) args.push('--ro-bind', '/dev/null', p);

    // Daemon trust-root masks — UNCONDITIONAL (not gated on protect_secrets).
    // Redundant when DISCO_DATA_HOME lives under the overlaid home (already
    // hidden by the overlay), but ESSENTIAL when it's OUTSIDE the home: the
    // overlay wouldn't cover it and `--ro-bind / /` would otherwise expose the
    // daemon's config.yaml / disco.db to a sandboxed executor.
    for (const file of [ctx.discoConfigPath, ctx.discoDbPath]) {
      if (!file) continue;
      for (const destination of homeAliasPaths(file, ctx, preserveCanonicalHomeAlias)) {
        args.push('--ro-bind', '/dev/null', destination);
      }
    }

    args.push('--setenv', 'HOME', ctx.homeDir);
    if (include.tmp) args.push('--setenv', 'TMPDIR', '/tmp');
    args.push('--chdir', canonicalHomePath(ctx.workspacePath, ctx, preserveCanonicalHomeAlias));
    return args;
  }

  // ── shared home (default) ─────────────────────────────────────────────────
  // ── task-private tmp (fresh empty tmpfs) ──
  if (include.tmp) {
    for (const dir of SANDBOX_TMP_DIRS) args.push('--tmpfs', dir);
  }

  // ── writable roots ───────────────────────────────────────────────────────
  // Hide the container of all `user-*` workspaces, then re-expose only this
  // owner. The bind source is resolved from the host namespace before the
  // tmpfs is applied. This is a user boundary, not Agent/Session isolation.
  if (ctx.userWorkspaceRoot) {
    const usersContainer = dirname(ctx.userWorkspaceRoot);
    if (usersContainer !== '/' && usersContainer !== '.') args.push('--tmpfs', usersContainer);
  }
  // Same-user Agents and sessions share one writable user workspace.
  if (include.workspace) {
    for (const source of writableWorkspaceRoots(ctx)) {
      args.push('--bind', source, source);
    }
  }
  if (include.home) {
    args.push('--bind', ctx.homeDir, ctx.homeDir);
  } else {
    // Keep tool state/cache dirs writable so agents can actually run.
    for (const sub of SANDBOX_HOME_WRITABLE_SUBDIRS) {
      args.push('--bind-try', join(ctx.homeDir, sub), join(ctx.homeDir, sub));
    }
  }
  for (const p of sandbox.extra_allow_write ?? []) args.push('--bind', p, p);

  // ── denials LAST so they win over any writable/home bind above ──
  if (protectSecrets) {
    for (const file of [ctx.discoConfigPath, ctx.discoDbPath]) {
      if (file) args.push('--ro-bind', '/dev/null', file); // mask file → reads empty
    }
    for (const sub of SANDBOX_SECRET_HOME_FILES) {
      args.push('--ro-bind-try', '/dev/null', join(ctx.homeDir, sub));
    }
    for (const sub of SANDBOX_SECRET_HOME_DIRS) {
      args.push('--tmpfs', join(ctx.homeDir, sub)); // hide dir contents
    }
  }
  for (const p of sandbox.extra_deny_read ?? []) args.push('--ro-bind', '/dev/null', p);

  // Run in the Session working directory.
  args.push('--chdir', ctx.workspacePath);

  return args;
}

function isPathWithin(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function validateWorkspacePath(path: string, label: string): void {
  if (!isAbsolute(path) || path === '/') {
    throw new Error(`Invalid sandbox ${label} ${path}: expected an absolute path below /`);
  }
}

function writableWorkspaceRoots(ctx: SandboxPathContext): string[] {
  if (!ctx.userWorkspaceRoot) return [ctx.workspacePath];
  if (isPathWithin(ctx.workspacePath, ctx.userWorkspaceRoot)) return [ctx.userWorkspaceRoot];
  return [ctx.userWorkspaceRoot, ctx.workspacePath];
}

function homeAliasPaths(
  candidate: string,
  ctx: SandboxPathContext,
  preserveCanonicalHomeAlias: boolean
): string[] {
  if (!preserveCanonicalHomeAlias || !ctx.canonicalHomeDir) return [candidate];

  const alias = isPathWithin(candidate, ctx.homeDir)
    ? join(ctx.canonicalHomeDir, relative(ctx.homeDir, candidate))
    : isPathWithin(candidate, ctx.canonicalHomeDir)
      ? join(ctx.homeDir, relative(ctx.canonicalHomeDir, candidate))
      : undefined;
  return alias && alias !== candidate ? [candidate, alias] : [candidate];
}

function canonicalHomePath(
  candidate: string,
  ctx: SandboxPathContext,
  preserveCanonicalHomeAlias: boolean
): string {
  if (preserveCanonicalHomeAlias && ctx.canonicalHomeDir && isPathWithin(candidate, ctx.homeDir)) {
    return join(ctx.canonicalHomeDir, relative(ctx.homeDir, candidate));
  }
  return candidate;
}
