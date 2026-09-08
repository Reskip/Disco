import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPathInsideDiscoUserWorkspace,
  resolveDiscoAgentSessionWorkingDirectory,
  resolveDiscoAgentWorkspaceDirectory,
  resolveDiscoStandaloneSessionWorkingDirectory,
  resolveDiscoUserWorkspaceDirectory,
  resolveDiscoUserWorkspaceRoot,
} from './disco-workspace-paths';

describe('Disco session workspace paths', () => {
  const worktrees = join('E:', 'Disco', 'data', 'disco', 'worktrees');
  const userRoot = resolveDiscoUserWorkspaceDirectory(worktrees, '01a02b01');

  it('places every standalone session in its own directory', () => {
    expect(resolveDiscoStandaloneSessionWorkingDirectory(userRoot, 'session-a')).toBe(
      join(userRoot, 'standalone', 'session-a')
    );
    expect(resolveDiscoStandaloneSessionWorkingDirectory(userRoot, 'session-b')).toBe(
      join(userRoot, 'standalone', 'session-b')
    );
  });

  it('keeps session resources separate while allowing same-user cross-session reads', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'disco-session-layout-'));
    try {
      const temporaryUserRoot = resolveDiscoUserWorkspaceDirectory(
        join(temporaryRoot, 'worktrees'),
        'test'
      );
      const standaloneA = resolveDiscoStandaloneSessionWorkingDirectory(
        temporaryUserRoot,
        'session-a'
      );
      const standaloneB = resolveDiscoStandaloneSessionWorkingDirectory(
        temporaryUserRoot,
        'session-b'
      );
      mkdirSync(standaloneA, { recursive: true });
      mkdirSync(standaloneB, { recursive: true });
      writeFileSync(join(standaloneA, 'a.txt'), 'from-a', 'utf8');
      writeFileSync(join(standaloneB, 'b.txt'), 'from-b', 'utf8');

      expect(standaloneA).not.toBe(standaloneB);
      expect(readFileSync(join(standaloneB, '..', 'session-a', 'a.txt'), 'utf8')).toBe('from-a');

      const agentWorkspace = resolveDiscoAgentWorkspaceDirectory(
        temporaryUserRoot,
        'agent-research'
      );
      const agentSession = resolveDiscoAgentSessionWorkingDirectory(agentWorkspace, 'session-c');
      mkdirSync(agentSession, { recursive: true });
      writeFileSync(join(agentSession, 'result.txt'), 'agent-session', 'utf8');
      expect(agentSession).toBe(join(agentWorkspace, 'sessions', 'session-c'));
      expect(readFileSync(join(agentSession, 'result.txt'), 'utf8')).toBe('agent-session');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('retains one user boundary for every Agent and Session owned by that user', () => {
    const agentWorkspace = resolveDiscoAgentWorkspaceDirectory(userRoot, 'agent-research');
    const sessionPath = resolveDiscoAgentSessionWorkingDirectory(agentWorkspace, 'session-a');

    expect(resolveDiscoUserWorkspaceRoot(sessionPath)).toBe(userRoot);
    expect(isPathInsideDiscoUserWorkspace(userRoot, sessionPath)).toBe(true);
    expect(
      isPathInsideDiscoUserWorkspace(
        userRoot,
        resolveDiscoAgentWorkspaceDirectory(userRoot, 'agent-other')
      )
    ).toBe(true);
  });

  it('does not treat another account workspace as part of the current user boundary', () => {
    const otherUser = resolveDiscoUserWorkspaceDirectory(worktrees, '01a09999');
    const otherSession = resolveDiscoStandaloneSessionWorkingDirectory(otherUser, 'session-z');
    expect(isPathInsideDiscoUserWorkspace(userRoot, otherSession)).toBe(false);
  });

  it('does not classify ordinary machine directories as Disco user workspaces', () => {
    expect(resolveDiscoUserWorkspaceRoot(join('E:', 'external-project'))).toBeNull();
  });
});
