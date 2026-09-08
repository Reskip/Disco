import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureSessionGitSafeDirectories } from './git-safe-directory.js';

function makeClient(workingDirectory = '/worktrees/user-1/standalone/session-1') {
  return {
    service(name: string) {
      if (name === 'sessions') {
        return { get: vi.fn(async () => ({ working_directory: workingDirectory })) };
      }
      throw new Error(`unexpected service ${name}`);
    },
  } as any;
}

describe('configureSessionGitSafeDirectories', () => {
  const originalGitConfigParameters = process.env.GIT_CONFIG_PARAMETERS;

  afterEach(() => {
    if (originalGitConfigParameters === undefined) {
      delete process.env.GIT_CONFIG_PARAMETERS;
    } else {
      process.env.GIT_CONFIG_PARAMETERS = originalGitConfigParameters;
    }
    vi.restoreAllMocks();
  });

  it('appends the Session working directory to inherited git config parameters', async () => {
    process.env.GIT_CONFIG_PARAMETERS = "'transfer.credentialsInUrl=die'";

    const paths = await configureSessionGitSafeDirectories(makeClient(), 'session-1' as any);

    expect(paths).toEqual(['/worktrees/user-1/standalone/session-1']);
    expect(process.env.GIT_CONFIG_PARAMETERS).toContain("'transfer.credentialsInUrl=die'");
    expect(process.env.GIT_CONFIG_PARAMETERS).toContain(
      "'safe.directory=/worktrees/user-1/standalone/session-1'"
    );
  });

  it('does not add an empty Session working directory', async () => {
    delete process.env.GIT_CONFIG_PARAMETERS;

    const paths = await configureSessionGitSafeDirectories(makeClient(''), 'session-1' as any);

    expect(paths).toEqual([]);
    expect(process.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  });
});
