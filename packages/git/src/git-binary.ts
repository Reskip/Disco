import { accessSync, constants } from 'node:fs';
import { posix, win32 } from 'node:path';

const COMMON_GIT_PATHS = [
  '/opt/homebrew/bin/git', // Homebrew on Apple Silicon
  '/usr/local/bin/git', // Homebrew on Intel
  '/usr/bin/git', // System git (Docker and Linux)
] as const;

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer the standard 8.3 alias for Git under Program Files when Windows
 * exposes it. simple-git deliberately warns for custom binary paths that
 * contain spaces, even when the caller explicitly opts into the trusted path.
 * We probe the alias before using it and otherwise retain the resolved path.
 */
function preferWindowsExecutableAlias(
  path: string,
  isExecutable: (path: string) => boolean
): string {
  const aliases = [
    path.replace(/^([a-z]:\\)Program Files \(x86\)(\\)/i, '$1PROGRA~2$2'),
    path.replace(/^([a-z]:\\)Program Files(\\)/i, '$1PROGRA~1$2'),
  ];

  return aliases.find((alias) => alias !== path && isExecutable(alias)) ?? path;
}

/** Resolve the Git executable without spawning a shell. */
export function resolveGitBinary(
  options: {
    path?: string;
    platform?: NodeJS.Platform;
    isExecutable?: (path: string) => boolean;
    commonPaths?: readonly string[];
  } = {}
): string {
  const isExecutable = options.isExecutable ?? canExecute;
  const commonPaths = options.commonPaths ?? COMMON_GIT_PATHS;
  const platform = options.platform ?? process.platform;

  for (const path of commonPaths) {
    if (isExecutable(path)) {
      return platform === 'win32' ? preferWindowsExecutableAlias(path, isExecutable) : path;
    }
  }

  const pathApi = platform === 'win32' ? win32 : posix;
  const names = platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat', 'git'] : ['git'];
  for (const directory of (options.path ?? process.env.PATH ?? '').split(pathApi.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (isExecutable(candidate)) {
        return platform === 'win32'
          ? preferWindowsExecutableAlias(candidate, isExecutable)
          : candidate;
      }
    }
  }

  throw new Error(
    'Git executable is unavailable. Install Git, ensure it is executable on PATH, ' +
      'and verify `git --version` before retrying.'
  );
}
