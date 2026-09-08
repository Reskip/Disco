import type { SessionID } from '@disco/core/types';
import { appendGitConfigParameterPairs } from '../../git/config-parameters.js';
import type { DiscoClient } from '../../services/feathers-client.js';

const DEBUG_GIT_SAFE_DIRECTORY =
  process.env.DISCO_DEBUG_GIT_SAFE_DIRECTORY === '1' ||
  process.env.DEBUG?.includes('git-safe-directory');

function gitSafeDirectoryDebug(...args: unknown[]): void {
  if (DEBUG_GIT_SAFE_DIRECTORY) {
    console.debug(...args);
  }
}

/**
 * Trust the Session working directory for every git subprocess the SDK starts.
 *
 * Interactive agents can run plain `git status` inside their sessions. A delegated
 * launcher may expose paths owned by another runtime principal, so git's ownership
 * check rejects the repo unless the process environment preconfigures them as safe.
 *
 * We use `GIT_CONFIG_PARAMETERS` instead of mutating the user's global
 * ~/.gitconfig: it is scoped to this executor process and inherited by the
 * Codex/Claude/Gemini/OpenCode child processes and their shell commands.
 */
export async function configureSessionGitSafeDirectories(
  client: DiscoClient,
  sessionId: SessionID,
  logPrefix = '[git.safe-directory]'
): Promise<string[]> {
  const paths: string[] = [];

  try {
    const session = await client.service('sessions').get(sessionId);
    if (session?.working_directory) paths.push(session.working_directory);
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to resolve session ${sessionId} safe.directory paths:`,
      error instanceof Error ? error.message : String(error)
    );
    return paths;
  }

  const uniquePaths = Array.from(new Set(paths.filter((path) => path.trim().length > 0)));
  appendGitConfigParameterPairs(uniquePaths.map((path) => `safe.directory=${path}`));

  if (uniquePaths.length > 0) {
    gitSafeDirectoryDebug(
      `${logPrefix} Added ${uniquePaths.length} safe.directory entr${uniquePaths.length === 1 ? 'y' : 'ies'} for session git commands`
    );
  }

  return uniquePaths;
}
