import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { isPathInsideDiscoUserWorkspace } from '@disco/core';

const DAY_MS = 24 * 60 * 60 * 1000;
// Only generated raster/media derivatives in the explicitly temporary namespace.
// Editable documents, project files, code and unknown extensions remain protected.
const TEMPORARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.bmp',
  '.mp4',
  '.webm',
  '.wav',
  '.mp3',
  '.log',
  '.tmp',
  '.partial',
]);
const PROTECTED_DIRECTORIES = new Set(['.git', 'session-staging', 'uploads', 'datasets']);

export interface WorkspaceCacheCleanupOptions {
  userRoot: string;
  retentionDays: number;
  isIdle: () => Promise<boolean>;
  now?: Date;
  dryRun?: boolean;
  maxEntries?: number;
}

export interface WorkspaceCacheCleanupResult {
  examined: number;
  eligible: number;
  deleted: number;
  bytes: number;
  skippedActive: boolean;
  truncated: boolean;
}

/** Never infers garbage merely because a file was absent from a final answer. */
export async function cleanupWorkspaceCaches(
  options: WorkspaceCacheCleanupOptions
): Promise<WorkspaceCacheCleanupResult> {
  const result: WorkspaceCacheCleanupResult = {
    examined: 0,
    eligible: 0,
    deleted: 0,
    bytes: 0,
    skippedActive: false,
    truncated: false,
  };
  if (options.retentionDays === 0) return result;
  if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
    throw new Error('Invalid temporary-file retention');
  }
  const userRoot = resolve(options.userRoot);
  if (!/^user-[a-z0-9_-]+$/iu.test(basename(userRoot)))
    throw new Error('Not a Disco account workspace');
  const rootStat = await lstat(userRoot).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return result;
  // A junction in any ancestor must not silently redirect this account's scan.
  if (resolve(await realpath(userRoot)) !== userRoot) return result;
  const cutoff = (options.now ?? new Date()).getTime() - options.retentionDays * DAY_MS;
  const maxEntries = options.maxEntries ?? 100_000;
  const pending: Array<{ path: string; temporary: boolean; bytecode: boolean }> = [
    { path: userRoot, temporary: false, bytecode: false },
  ];

  while (pending.length > 0 && !result.skippedActive) {
    const directory = pending.pop()!;
    if (resolve(await realpath(directory.path).catch(() => '')) !== directory.path) continue;
    const entries = await readdir(directory.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++result.examined > maxEntries) {
        result.truncated = true;
        return result;
      }
      if (entry.isSymbolicLink()) continue;
      const candidate = join(directory.path, entry.name);
      if (!isPathInsideDiscoUserWorkspace(userRoot, candidate)) continue;
      if (entry.isDirectory()) {
        if (PROTECTED_DIRECTORIES.has(entry.name)) continue;
        pending.push({
          path: candidate,
          temporary:
            directory.temporary || (entry.name === 'tmp' && basename(directory.path) === '.disco'),
          bytecode: directory.bytecode || entry.name === '__pycache__',
        });
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      const cache = directory.bytecode && (extension === '.pyc' || extension === '.pyo');
      const temporary = directory.temporary && TEMPORARY_EXTENSIONS.has(extension);
      if (!entry.isFile() || (!cache && !temporary)) continue;
      const before = await lstat(candidate).catch(() => undefined);
      if (
        !before?.isFile() ||
        before.isSymbolicLink() ||
        Math.max(before.mtimeMs, before.ctimeMs) > cutoff
      )
        continue;
      // Recheck account-wide activity, since another Session can use the same
      // Agent/source files. Fail closed if the database check fails.
      if (!(await options.isIdle())) {
        result.skippedActive = true;
        break;
      }
      if (resolve(await realpath(candidate).catch(() => '')) !== candidate) continue;
      const after = await lstat(candidate).catch(() => undefined);
      if (
        !after?.isFile() ||
        after.isSymbolicLink() ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        continue;
      result.eligible++;
      if (!options.dryRun) {
        try {
          await unlink(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        result.deleted++;
      }
      result.bytes += before.size;
    }
  }
  return result;
}
