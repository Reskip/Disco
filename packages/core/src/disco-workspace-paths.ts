import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

function safeDirectorySegment(value: string, label: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/gu, '').toLowerCase();
  if (!normalized) throw new Error(`${label} cannot be represented as a workspace directory`);
  return normalized;
}

/** Canonical account directory under the configured Disco worktrees root. */
export function resolveDiscoUserWorkspaceDirectory(worktreesRoot: string, userId: string): string {
  return join(normalize(worktreesRoot), `user-${safeDirectorySegment(userId, 'User ID')}`);
}

/** Canonical persistent workspace for one first-class Agent. */
export function resolveDiscoAgentWorkspaceDirectory(userRoot: string, agentId: string): string {
  return join(normalize(userRoot), 'agents', safeDirectorySegment(agentId, 'Agent ID'));
}

/** Canonical resource directory for a personality-free standalone conversation. */
export function resolveDiscoStandaloneSessionWorkingDirectory(
  userRoot: string,
  sessionId: string
): string {
  return join(normalize(userRoot), 'standalone', safeDirectorySegment(sessionId, 'Session ID'));
}

/** Canonical resource directory for a conversation with a persistent Agent. */
export function resolveDiscoAgentSessionWorkingDirectory(
  agentWorkspace: string,
  sessionId: string
): string {
  return join(normalize(agentWorkspace), 'sessions', safeDirectorySegment(sessionId, 'Session ID'));
}

/** Locate the owning `worktrees/user-*` directory from any Disco workspace. */
export function resolveDiscoUserWorkspaceRoot(workspacePath: string): string | null {
  let current = normalize(workspacePath);
  while (true) {
    if (/^user-[a-z0-9_-]+$/iu.test(basename(current))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Path-containment helper used by runtime-boundary tests and diagnostics. */
export function isPathInsideDiscoUserWorkspace(userRoot: string, candidate: string): boolean {
  const rel = relative(normalize(userRoot), normalize(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
