/**
 * Shared daemon-side helper for resolving the per-owner sandbox home store.
 *
 * Used by BOTH executor spawn sites (prompt tasks in register-services and web
 * terminals) so the store-path logic + `filesystem_home` validation live in one
 * place instead of drifting between call sites.
 *
 * See `context/explorations/executor-sandboxing.md`.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  type DiscoConfig,
  getDiscoHome,
  resolveDataHomeFromConfig,
  resolveTenantDataRootFromConfig,
  resolveTenantsBaseFolderFromConfig,
} from '@disco/core/config';
import type { DeepReadonly } from '@disco/core/types';

export interface SandboxStoragePaths {
  dataHome: string;
  protectedDataRoots: string[];
  worktreesRoot: string;
  ownerHomesRoot: string;
}

/** Resolve tenant-aware sandbox storage paths from the immutable config snapshot. */
export function resolveSandboxStoragePaths(
  config: DeepReadonly<DiscoConfig>,
  tenantId: string | undefined
): SandboxStoragePaths {
  const discoHome = getDiscoHome();
  const dataHome = resolveDataHomeFromConfig(config, discoHome);
  const filesystemIsolation = config.multi_tenancy?.filesystem_isolation_enabled === true;
  const tenantDataRoot = filesystemIsolation
    ? resolveTenantDataRootFromConfig(config, dataHome, discoHome, tenantId)
    : dataHome;
  const protectedDataRoots = [dataHome];
  if (filesystemIsolation) {
    protectedDataRoots.push(resolveTenantsBaseFolderFromConfig(config, discoHome));
  }
  return {
    dataHome,
    protectedDataRoots: [...new Set(protectedDataRoots)],
    worktreesRoot: join(tenantDataRoot, 'worktrees'),
    ownerHomesRoot: filesystemIsolation
      ? join(tenantDataRoot, 'homes')
      : join(
          dataHome,
          'tenants',
          tenantId ?? config.multi_tenancy?.static_tenant_id ?? 'default',
          'homes'
        ),
  };
}

/** Resolve deployment-global roots that a per-user sandbox must hide. */
export function resolveSandboxProtectedDataRoots(config: DeepReadonly<DiscoConfig>): string[] {
  const discoHome = getDiscoHome();
  const roots = [resolveDataHomeFromConfig(config, discoHome)];
  if (config.multi_tenancy?.filesystem_isolation_enabled === true) {
    roots.push(resolveTenantsBaseFolderFromConfig(config, discoHome));
  }
  return [...new Set(roots)];
}

/**
 * Validate an admin-supplied `users.filesystem_home` before it is used as a
 * writable bind source. It is a trust boundary: a bad value would expose or
 * mutate arbitrary host data from inside the sandbox. Rejects non-absolute
 * paths, `/`, and any path that overlaps the daemon data root (which would
 * re-expose `config.yaml`/`disco.db`/worktrees). Canonicalizes via `realpath`
 * when the dir already exists to blunt symlink swaps. Throws on violation.
 */
export function validateFilesystemHomeOverride(rawPath: string, dataHome: string): string {
  // Reject relative paths OUTRIGHT — do not silently `resolve()` them against
  // the daemon cwd (a value like `tmp/user` would otherwise be accepted).
  if (!isAbsolute(rawPath)) {
    throw new Error(`Invalid filesystem_home ${rawPath}: must be an absolute path`);
  }
  if (rawPath === '/') {
    throw new Error(`Invalid filesystem_home ${rawPath}: refusing to overlay the filesystem root`);
  }
  // Canonicalize BOTH sides (realpath when the dir exists) so a symlinked data
  // root or override can't sneak past the lexical prefix check below.
  const canonical = existsSync(rawPath) ? realpathSync(rawPath) : resolve(rawPath);
  const dhResolved = resolve(dataHome);
  const dh = existsSync(dhResolved) ? realpathSync(dhResolved) : dhResolved;
  // Reject the data root itself, an ancestor of it, or anything inside it — all
  // would let the overlay reach the daemon's trust root / worktrees / repos.
  const isWithin = (candidate: string, root: string) => {
    const relation = relative(root, candidate);
    return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
  };
  if (isWithin(canonical, dh) || isWithin(dh, canonical)) {
    throw new Error(
      `Invalid filesystem_home ${rawPath}: must not overlap the Disco data root (${dh})`
    );
  }
  return canonical;
}

/**
 * The per-owner home store overlaid at the passwd home under
 * `sandbox.home_mode: per_user`. The admin `filesystem_home` override wins (used
 * by the strict→sandbox migration to reuse an existing `/home/<user>` in
 * place); otherwise the canonical, tenant-scoped store — which is trusted by
 * construction and needs no validation.
 */
export function resolveOwnerHomeStore(params: {
  config: DeepReadonly<DiscoConfig>;
  tenantId: string | undefined;
  ownerUserId: string;
  filesystemHome?: string | null;
}): string {
  const storage = resolveSandboxStoragePaths(params.config, params.tenantId);
  const override = params.filesystemHome?.trim();
  if (override) {
    let validated = override;
    for (const root of storage.protectedDataRoots) {
      validated = validateFilesystemHomeOverride(validated, root);
    }
    return validated;
  }
  return join(storage.ownerHomesRoot, params.ownerUserId);
}
