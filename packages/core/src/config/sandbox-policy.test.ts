import { describe, expect, it } from 'vitest';
import { resolveBwrapArgs, type SandboxPathContext } from './sandbox-policy';

const USER_ROOT = '/home/disco/.disco/worktrees/user-owner';
const WORKSPACE = `${USER_ROOT}/agents/agent-a/sessions/session-1`;
const USERS_CONTAINER = '/home/disco/.disco/worktrees';
const CTX: SandboxPathContext = {
  workspacePath: WORKSPACE,
  userWorkspaceRoot: USER_ROOT,
  homeDir: '/home/disco',
  dataHome: '/home/disco/.disco',
  discoConfigPath: '/home/disco/.disco/config.yaml',
  discoDbPath: '/home/disco/.disco/disco.db',
};

function hasTriple(args: string[], flag: string, a: string, b: string): boolean {
  for (let i = 0; i + 2 < args.length; i++) {
    if (args[i] === flag && args[i + 1] === a && args[i + 2] === b) return true;
  }
  return false;
}

function hasPair(args: string[], flag: string, a: string): boolean {
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === flag && args[i + 1] === a) return true;
  }
  return false;
}

describe('resolveBwrapArgs — shared home', () => {
  it('keeps network shared and uses user + PID namespaces by default', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasTriple(args, '--ro-bind', '/', '/')).toBe(true);
    expect(args).toContain('--unshare-user');
    expect(args).toContain('--unshare-pid');
    expect(args).not.toContain('--unshare-net');
  });

  it('omits the PID namespace when the host cannot create one', () => {
    const args = resolveBwrapArgs({}, { ...CTX, pidNamespace: false });
    expect(args).toContain('--unshare-user');
    expect(args).not.toContain('--unshare-pid');
  });

  it('mounts the whole owning user workspace, not just the current Session', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasTriple(args, '--bind', USER_ROOT, USER_ROOT)).toBe(true);
    expect(hasTriple(args, '--bind', WORKSPACE, WORKSPACE)).toBe(false);
    expect(hasPair(args, '--chdir', WORKSPACE)).toBe(true);
  });

  it('hides sibling user workspaces before re-exposing the owner root', () => {
    const args = resolveBwrapArgs({}, CTX);
    const mask = args.findIndex(
      (value, index) => value === '--tmpfs' && args[index + 1] === USERS_CONTAINER
    );
    const ownerBind = args.findIndex(
      (value, index) => value === '--bind' && args[index + 1] === USER_ROOT
    );
    expect(mask).toBeGreaterThanOrEqual(0);
    expect(ownerBind).toBeGreaterThan(mask);
  });

  it('falls back to the current cwd when it is not a managed Disco workspace', () => {
    const external = '/srv/family-project';
    const args = resolveBwrapArgs({}, {
      ...CTX,
      workspacePath: external,
      userWorkspaceRoot: undefined,
    });
    expect(hasTriple(args, '--bind', external, external)).toBe(true);
    expect(hasPair(args, '--chdir', external)).toBe(true);
  });

  it('keeps both the user root and an external task cwd writable', () => {
    const external = '/srv/family-project';
    const args = resolveBwrapArgs({}, { ...CTX, workspacePath: external });
    expect(hasTriple(args, '--bind', USER_ROOT, USER_ROOT)).toBe(true);
    expect(hasTriple(args, '--bind', external, external)).toBe(true);
  });

  it('honors include.workspace=false', () => {
    const args = resolveBwrapArgs({ include: { workspace: false } }, CTX);
    expect(hasTriple(args, '--bind', USER_ROOT, USER_ROOT)).toBe(false);
  });

  it('uses task-private temp mounts and masks daemon credentials by default', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasPair(args, '--tmpfs', '/tmp')).toBe(true);
    expect(hasTriple(args, '--ro-bind', '/dev/null', CTX.discoConfigPath!)).toBe(true);
    expect(hasTriple(args, '--ro-bind', '/dev/null', CTX.discoDbPath!)).toBe(true);
    expect(hasPair(args, '--tmpfs', '/home/disco/.ssh')).toBe(true);
  });

  it('can expose home and supports explicit allow/deny escape hatches', () => {
    const args = resolveBwrapArgs(
      {
        include: { home: true },
        extra_allow_write: ['/opt/cache'],
        extra_deny_read: ['/etc/family-secret'],
      },
      CTX
    );
    expect(hasTriple(args, '--bind', '/home/disco', '/home/disco')).toBe(true);
    expect(hasTriple(args, '--bind', '/opt/cache', '/opt/cache')).toBe(true);
    expect(hasTriple(args, '--ro-bind', '/dev/null', '/etc/family-secret')).toBe(true);
  });

  it('rejects root or relative workspace grants', () => {
    expect(() => resolveBwrapArgs({}, { ...CTX, workspacePath: '/' })).toThrow(
      /workspacePath/i
    );
    expect(() => resolveBwrapArgs({}, { ...CTX, userWorkspaceRoot: 'relative/user' })).toThrow(
      /userWorkspaceRoot/i
    );
  });
});

describe('resolveBwrapArgs — home_mode: per_user', () => {
  const STORE = '/home/disco/.disco/tenants/default/homes/owner-123';
  const PER_USER_CTX: SandboxPathContext = {
    ...CTX,
    ownerHomeStore: STORE,
    agenticToolsPath: '/home/disco/.disco/agentic-tools',
  };

  it('overlays the owner home and then exposes the complete owner workspace', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, PER_USER_CTX);
    const overlay = args.findIndex(
      (value, index) => value === '--bind' && args[index + 1] === STORE
    );
    const workspace = args.findIndex(
      (value, index) => value === '--bind' && args[index + 1] === USER_ROOT
    );
    expect(overlay).toBeGreaterThanOrEqual(0);
    expect(workspace).toBeGreaterThan(overlay);
    expect(hasTriple(args, '--setenv', 'HOME', '/home/disco')).toBe(true);
  });

  it('hides an external data root, then re-exposes only the current user root', () => {
    const dataHome = '/var/lib/disco/data';
    const userRoot = `${dataHome}/worktrees/user-owner`;
    const workspace = `${userRoot}/standalone/session-1`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user' },
      {
        ...PER_USER_CTX,
        dataHome,
        userWorkspaceRoot: userRoot,
        workspacePath: workspace,
        agenticToolsPath: `${dataHome}/agentic-tools`,
        discoConfigPath: `${dataHome}/config.yaml`,
        discoDbPath: `${dataHome}/disco.db`,
      }
    );
    const mask = args.findIndex(
      (value, index) => value === '--tmpfs' && args[index + 1] === dataHome
    );
    const ownerBind = args.findIndex(
      (value, index) => value === '--bind' && args[index + 1] === userRoot
    );
    expect(mask).toBeGreaterThanOrEqual(0);
    expect(ownerBind).toBeGreaterThan(mask);
    expect(args.join(' ')).not.toContain(`${dataHome}/worktrees/user-other`);
  });

  it('preserves canonical home aliases for workspace and cwd when requested', () => {
    const canonicalHome = '/var/lib/disco/home/disco';
    const canonicalUserRoot = `${canonicalHome}/.disco/worktrees/user-owner`;
    const canonicalWorkspace = `${canonicalUserRoot}/agents/agent-a/sessions/session-1`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user', preserve_canonical_home_alias: true },
      { ...PER_USER_CTX, canonicalHomeDir: canonicalHome }
    );
    expect(hasTriple(args, '--bind', STORE, canonicalHome)).toBe(true);
    expect(hasTriple(args, '--bind', USER_ROOT, canonicalUserRoot)).toBe(true);
    expect(hasPair(args, '--chdir', canonicalWorkspace)).toBe(true);
  });

  it('keeps per-user tmp on disk and managed tools read-only', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, PER_USER_CTX);
    expect(hasTriple(args, '--bind', `${STORE}/tmp`, '/tmp')).toBe(true);
    expect(hasPair(args, '--tmpfs', '/var/tmp')).toBe(true);
    expect(hasTriple(args, '--setenv', 'TMPDIR', '/tmp')).toBe(true);
    expect(
      hasTriple(
        args,
        '--ro-bind-try',
        PER_USER_CTX.agenticToolsPath!,
        PER_USER_CTX.agenticToolsPath!
      )
    ).toBe(true);
  });

  it('fails closed without an owner store or with a filesystem-root data path', () => {
    expect(() => resolveBwrapArgs({ home_mode: 'per_user' }, CTX)).toThrow(/fail closed/i);
    expect(() =>
      resolveBwrapArgs({ home_mode: 'per_user' }, { ...PER_USER_CTX, dataHome: '/' })
    ).toThrow(/invalid sandbox data root/i);
  });
});
