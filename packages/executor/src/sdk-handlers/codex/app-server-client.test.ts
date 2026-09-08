import { describe, expect, it } from 'vitest';
import {
  assertValidCodexDynamicTools,
  automaticWorkspaceApprovalResponse,
  buildCodexAppServerCapabilityCatalog,
  codexDynamicToolRuntimeCapabilities,
  CodexAppServerClient,
  executeCodexDynamicToolCall,
  resolveCodexAppServerChildEnvironment,
} from './app-server-client.js';

describe('resolveCodexAppServerChildEnvironment', () => {
  it('uses the caller-provided complete environment without merging host task variables', () => {
    const resolved = resolveCodexAppServerChildEnvironment(
      {
        CODEX_HOME: 'E:/Disco/data/codex-runtime',
        PATH: 'disco-path',
      },
      {
        CODEX_SESSION_ID: 'desktop-session',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
        PATH: 'desktop-path',
      }
    );

    expect(resolved).toEqual({
      CODEX_HOME: 'E:/Disco/data/codex-runtime',
      PATH: 'disco-path',
    });
    expect(resolved).not.toHaveProperty('CODEX_SESSION_ID');
    expect(resolved).not.toHaveProperty('CODEX_INTERNAL_ORIGINATOR_OVERRIDE');
  });

  it('inherits the process environment only when no complete environment is supplied', () => {
    expect(
      resolveCodexAppServerChildEnvironment(undefined, {
        CODEX_HOME: 'C:/Users/test/.codex',
        PATH: 'host-path',
      })
    ).toEqual({
      CODEX_HOME: 'C:/Users/test/.codex',
      PATH: 'host-path',
    });
  });
});

describe('automaticWorkspaceApprovalResponse', () => {
  const boundary = {
    userWorkspaceRoot: 'E:/Disco/data/disco/worktrees/user-reskip',
    worktreesRoot: 'E:/Disco/data/disco/worktrees',
  };

  it('accepts current app-server command and file approvals for the session', () => {
    expect(automaticWorkspaceApprovalResponse('item/commandExecution/requestApproval')).toEqual({
      decision: 'acceptForSession',
    });
    expect(automaticWorkspaceApprovalResponse('item/fileChange/requestApproval')).toEqual({
      decision: 'acceptForSession',
    });
  });

  it('uses the one-shot decision advertised by elevated Windows commands', () => {
    expect(
      automaticWorkspaceApprovalResponse('item/commandExecution/requestApproval', {
        availableDecisions: ['accept', { acceptWithExecpolicyAmendment: {} }, 'cancel'],
      })
    ).toEqual({ decision: 'accept' });
  });

  it('grants exact ordinary external paths requested by the app-server', () => {
    const permissions = {
      fileSystem: {
        entries: [
          {
            access: 'write',
            path: { type: 'path', path: 'E:/workspace/public-project' },
          },
        ],
      },
      network: { enabled: true },
    };
    expect(
      automaticWorkspaceApprovalResponse(
        'item/permissions/requestApproval',
        { cwd: boundary.userWorkspaceRoot, permissions },
        boundary
      )
    ).toEqual({ permissions, scope: 'turn', strictAutoReview: false });
  });

  it('never grants sibling-user, worktrees-root, ancestor, or glob access', () => {
    for (const requestedPath of [
      'E:/Disco/data/disco/worktrees/user-zsy',
      'E:/Disco/data/disco/worktrees',
      'E:/Disco/data/disco',
    ]) {
      expect(
        automaticWorkspaceApprovalResponse(
          'item/permissions/requestApproval',
          {
            cwd: boundary.userWorkspaceRoot,
            permissions: { fileSystem: { write: [requestedPath] } },
          },
          boundary
        )
      ).toBeUndefined();
    }
    expect(
      automaticWorkspaceApprovalResponse(
        'item/permissions/requestApproval',
        {
          cwd: boundary.userWorkspaceRoot,
          permissions: {
            fileSystem: {
              entries: [{ access: 'read', path: { type: 'glob_pattern', pattern: 'E:/Disco/**' } }],
            },
          },
        },
        boundary
      )
    ).toBeUndefined();
  });

  it('declines command/file grants that would cross into another user', () => {
    expect(
      automaticWorkspaceApprovalResponse(
        'item/commandExecution/requestApproval',
        {
          cwd: boundary.userWorkspaceRoot,
          additionalPermissions: {
            fileSystem: { read: ['E:/Disco/data/disco/worktrees/user-zsy'] },
          },
        },
        boundary
      )
    ).toEqual({ decision: 'decline' });
    expect(
      automaticWorkspaceApprovalResponse(
        'item/fileChange/requestApproval',
        { grantRoot: 'E:/Disco/data/disco/worktrees' },
        boundary
      )
    ).toEqual({ decision: 'decline' });
  });

  it('accepts legacy approval callbacks without granting unrelated permissions', () => {
    expect(automaticWorkspaceApprovalResponse('execCommandApproval')).toEqual({
      decision: 'approved_for_session',
    });
    expect(automaticWorkspaceApprovalResponse('applyPatchApproval')).toEqual({
      decision: 'approved_for_session',
    });
    expect(automaticWorkspaceApprovalResponse('item/permissions/requestApproval')).toBeUndefined();
    expect(automaticWorkspaceApprovalResponse('item/tool/requestUserInput')).toBeUndefined();
  });
});

describe('executeCodexDynamicToolCall', () => {
  it('dispatches top-level and namespaced client tools with the original call context', async () => {
    const calls: unknown[] = [];
    const registrations = [
      {
        spec: {
          type: 'function' as const,
          name: 'echo',
          description: 'Echo text',
          inputSchema: { type: 'object' },
        },
        execute: async (call: unknown) => {
          calls.push(call);
          return { contentItems: [{ type: 'inputText' as const, text: 'ok' }], success: true };
        },
      },
      {
        spec: {
          type: 'namespace' as const,
          name: 'media',
          description: 'Media tools',
          tools: [
            {
              type: 'function' as const,
              name: 'preview',
              description: 'Preview media',
              inputSchema: { type: 'object' },
            },
          ],
        },
        execute: async () => ({
          contentItems: [{ type: 'inputImage' as const, imageUrl: 'data:image/png;base64,AA==' }],
          success: true,
        }),
      },
    ];

    await expect(
      executeCodexDynamicToolCall(registrations, {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'echo',
        arguments: { text: 'hello' },
      })
    ).resolves.toEqual({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true });
    await expect(
      executeCodexDynamicToolCall(registrations, {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-2',
        namespace: 'media',
        tool: 'preview',
        arguments: {},
      })
    ).resolves.toEqual({
      contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,AA==' }],
      success: true,
    });
    expect(calls).toEqual([
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'echo',
        arguments: { text: 'hello' },
      },
    ]);
  });

  it('returns undefined for unknown tools and a failed protocol result for handler failures', async () => {
    const registration = {
      spec: {
        type: 'function' as const,
        name: 'explode',
        description: 'Fail',
        inputSchema: { type: 'object' },
      },
      execute: async () => {
        throw new Error('boom');
      },
    };
    const base = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: null,
      arguments: {},
    };

    await expect(
      executeCodexDynamicToolCall([registration], { ...base, tool: 'missing' })
    ).resolves.toBeUndefined();
    await expect(
      executeCodexDynamicToolCall([registration], { ...base, tool: 'explode' })
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'boom' }],
      success: false,
    });
  });
});

describe('assertValidCodexDynamicTools', () => {
  const execute = async () => ({
    contentItems: [{ type: 'inputText' as const, text: 'ok' }],
    success: true,
  });

  it('rejects duplicate names and incomplete schemas before App Server starts', () => {
    const spec = {
      type: 'function' as const,
      name: 'echo',
      description: 'Echo',
      inputSchema: { type: 'object' },
    };
    expect(() => assertValidCodexDynamicTools([{ spec, execute }, { spec, execute }])).toThrow(
      'Duplicate Codex dynamic tool'
    );
    expect(() =>
      assertValidCodexDynamicTools([
        {
          spec: { ...spec, name: 'invalid', inputSchema: { type: 'string' } },
          execute,
        },
      ])
    ).toThrow('requires an object input schema');
  });
});

describe('Codex runtime capability catalog', () => {
  const execute = async () => ({
    contentItems: [{ type: 'inputText' as const, text: 'ok' }],
    success: true,
  });

  it('normalizes top-level and namespaced client tools beside native events', () => {
    const registrations = [
      {
        spec: {
          type: 'function' as const,
          name: 'open_panel',
          description: 'Open a client panel',
          inputSchema: { type: 'object', properties: {} },
        },
        execute,
      },
      {
        spec: {
          type: 'namespace' as const,
          name: 'canvas',
          description: 'Canvas operations',
          tools: [
            {
              type: 'function' as const,
              name: 'select',
              description: 'Select a canvas object',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          ],
        },
        execute,
      },
    ];

    expect(codexDynamicToolRuntimeCapabilities(registrations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'client-dynamic:open_panel', name: 'open_panel' }),
        expect.objectContaining({ id: 'client-dynamic:canvas/select', name: 'canvas.select' }),
      ])
    );
    const catalog = buildCodexAppServerCapabilityCatalog(registrations);
    expect(catalog.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(catalog.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'codex-native:image-view' }),
        expect.objectContaining({ id: 'codex-native:dynamic-tool-call' }),
        expect.objectContaining({ id: 'client-dynamic:canvas/select' }),
      ])
    );
  });

  it('exposes the validated catalog on each App Server client', () => {
    const client = new CodexAppServerClient();
    expect(client.runtimeCapabilityCatalog.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'codex-native:thread-resume' })])
    );
  });
});
