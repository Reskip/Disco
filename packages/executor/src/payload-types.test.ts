import { describe, expect, it } from 'vitest';
import {
  CodexAuthFilePayloadSchema,
  ExecutorPayloadSchema,
  getSupportedCommands,
  isPromptPayload,
  parseExecutorPayload,
  PromptPayloadSchema,
  WorkspaceFilesListPayloadSchema,
} from './payload-types.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';

describe('executor payload governance', () => {
  it('accepts a current prompt payload', () => {
    const payload = PromptPayloadSchema.parse({
      command: 'prompt',
      sessionToken: 'token',
      params: {
        sessionId,
        taskId,
        prompt: 'hello',
        tool: 'codex',
        cwd: 'C:\\workspace',
      },
    });
    expect(isPromptPayload(payload)).toBe(true);
  });

  it('accepts the Session working-directory file-list command', () => {
    expect(
      WorkspaceFilesListPayloadSchema.parse({
        command: 'workspace.files.list',
        sessionToken: 'token',
        params: { workingDirectory: 'C:\\workspace', search: 'read', limit: 20 },
      }).params.limit
    ).toBe(20);
  });

  it('accepts narrow Codex credential operations', () => {
    expect(
      CodexAuthFilePayloadSchema.parse({
        command: 'codex.auth-file',
        params: { operation: 'inspect' },
      }).params.operation
    ).toBe('inspect');
  });

  it('rejects every removed Repo/Branch/Board/Artifact command family', () => {
    const removed = [
      'git.clone',
      'git.branch.add',
      'workspace.directory.add',
      'branch.files.browse',
      'branch.filesystem.status',
      'branch.artifact.publish',
      'branch.disco-yml.import',
      'environment.lifecycle',
      'git.repo.delete',
    ];
    for (const command of removed) {
      expect(() => ExecutorPayloadSchema.parse({ command, params: {} })).toThrow();
    }
  });

  it('reports exactly the governed executor surface', () => {
    expect(getSupportedCommands()).toEqual([
      'prompt',
      'agentic-tool.invoke',
      'workspace.files.list',
      'codex.auth-file',
      'codex.generate-title',
      'codex.lookup-token-pricing',
    ]);
  });

  it('parses JSON through the same union', () => {
    expect(
      parseExecutorPayload(
        JSON.stringify({
          command: 'codex.lookup-token-pricing',
          params: { model: 'gpt-5.3-codex' },
        })
      ).command
    ).toBe('codex.lookup-token-pricing');
  });
});
