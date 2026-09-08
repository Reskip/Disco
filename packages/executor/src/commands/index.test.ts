import { describe, expect, it } from 'vitest';
import type { ExecutorPayload } from '../payload-types.js';
import {
  executeCommand,
  getRegisteredCommands,
  hasCommand,
} from './index.js';

describe('executor command registry', () => {
  it('registers only the current execution-substrate commands', () => {
    expect(getRegisteredCommands()).toEqual([
      'prompt',
      'agentic-tool.invoke',
      'workspace.files.list',
      'codex.auth-file',
      'codex.generate-title',
      'codex.lookup-token-pricing',
    ]);
  });

  it('does not register deleted architecture commands', () => {
    expect(hasCommand('git.clone')).toBe(false);
    expect(hasCommand('branch.files.browse')).toBe(false);
    expect(hasCommand('branch.artifact.publish')).toBe(false);
    expect(hasCommand('environment.lifecycle')).toBe(false);
  });

  it('dry-runs current workspace file discovery', async () => {
    const result = await executeCommand(
      {
        command: 'workspace.files.list',
        sessionToken: 'token',
        params: { workingDirectory: 'C:\\workspace', search: 'read', limit: 10 },
      },
      { dryRun: true }
    );
    expect(result).toEqual({
      success: true,
      data: {
        dryRun: true,
        command: 'workspace.files.list',
        workingDirectory: 'C:\\workspace',
        search: 'read',
        limit: 10,
      },
    });
  });

  it('returns a structured error for an unregistered command', async () => {
    const result = await executeCommand(
      { command: 'branch.files.read', params: {} } as unknown as ExecutorPayload
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_COMMAND');
  });
});
