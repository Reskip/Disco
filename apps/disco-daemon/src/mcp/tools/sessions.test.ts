/**
 * MCP session-tool regression coverage. Agent-visible orchestration uses
 * `spawn` and `prompt`; UI-owned session creation is intentionally excluded
 * from the Agent MCP surface.
 */

import { AGENTIC_TOOL_NAMES } from '@disco/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../resolve-ids.js', () => ({
  resolveBoardId: async (_ctx: unknown, id: string) => id,
  resolveSessionId: async (_ctx: unknown, id: string) => id,
  resolveMcpServerId: async (_ctx: unknown, id: string) => `full-${id}`,
}));

vi.mock('../../utils/session-authorization.js', () => ({
  ensureCanPromptTargetSession: vi.fn(async () => undefined),
}));

vi.mock('@disco/core/db', () => ({
  enqueueAfterTenantDatabaseCommit: () => false,
  getCurrentTenantId: () => undefined,
  BranchRepository: class FakeBranchRepository {},
  SessionRelationshipRepository: class FakeSessionRelationshipRepository {
    create = vi.fn(async (data: Record<string, unknown>) => ({
      relationship_id: 'rel-1',
      ...data,
      created_at: new Date(0).toISOString(),
    }));
    get = vi.fn(async (relationshipId: string) => ({
      relationship_id: relationshipId,
      source_session_id: 'sess-source',
      target_session_id: 'sess-target',
      relationship_type: 'remote_create',
      created_by: 'user-1',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      callback_enabled: false,
      callback_session_id: null,
      data: null,
    }));
    setCallbackEnabled = vi.fn(async (relationshipId: string, callbackEnabled: boolean) => ({
      relationship_id: relationshipId,
      source_session_id: 'sess-source',
      target_session_id: 'sess-target',
      relationship_type: 'remote_create',
      created_by: 'user-1',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      callback_enabled: callbackEnabled,
      callback_session_id: null,
      data: null,
    }));
  },
  UserApiKeysRepository: class FakeUserApiKeysRepository {},
  shortId: (id: string) => id,
}));

// Helper to build a minimal fake Feathers app. Each test supplies spies for
// the services it exercises; unknown services throw so we don't silently drop
// side-effects the assertion cares about.
type ServiceStub = Record<string, (...args: unknown[]) => unknown>;
function makeFakeApp(services: Record<string, ServiceStub>) {
  return {
    service: (name: string) => {
      const svc = services[name];
      if (!svc) {
        throw new Error(`Unexpected service call: ${name}`);
      }
      return svc;
    },
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** Cfg captured alongside the handler — includes inputSchema for tests that
 * exercise Zod validation/coercion (the fake server below bypasses the SDK's
 * automatic schema parsing). */
type CapturedTool = {
  cfg: { inputSchema?: { parse: (v: unknown) => unknown; safeParse: (v: unknown) => any } };
  cb: ToolHandler;
};

async function registerAndCaptureTools(
  ctx: {
    app: unknown;
    userId: string;
    sessionId?: string;
    baseServiceParams?: Record<string, unknown>;
  },
  toolNames: string[]
): Promise<Record<string, CapturedTool>> {
  const { registerSessionTools } = await import('./sessions.js');
  const captured: Record<string, CapturedTool> = {};
  const fakeServer = {
    registerTool: (name: string, cfg: unknown, cb: ToolHandler) => {
      if (toolNames.includes(name)) {
        captured[name] = { cfg: cfg as CapturedTool['cfg'], cb };
      }
    },
  } as unknown as McpServer;

  registerSessionTools(fakeServer, {
    app: ctx.app as any,
    db: {} as any,
    userId: ctx.userId as any,
    sessionId: ctx.sessionId as any,
    authenticatedUser: { user_id: ctx.userId, role: 'member' } as any,
    baseServiceParams: (ctx.baseServiceParams ?? {}) as any,
  });

  for (const name of toolNames) {
    if (!captured[name]) throw new Error(`Tool ${name} was not registered`);
  }
  return captured;
}

async function registerAndCaptureHandlers(
  ctx: {
    app: unknown;
    userId: string;
    sessionId?: string;
    baseServiceParams?: Record<string, unknown>;
  },
  toolNames: string[]
): Promise<Record<string, ToolHandler>> {
  const tools = await registerAndCaptureTools(ctx, toolNames);
  return Object.fromEntries(Object.entries(tools).map(([name, { cb }]) => [name, cb]));
}

describe('sessionless MCP context', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('disco_sessions_get_current returns an actionable session-context error', async () => {
    const sessionsGet = vi.fn();
    const app = makeFakeApp({
      sessions: { get: sessionsGet },
    });
    const { disco_sessions_get_current } = await registerAndCaptureHandlers(
      { app, userId: 'user-1' },
      ['disco_sessions_get_current']
    );

    const result = await disco_sessions_get_current({});
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/requires current Disco session context/i);
    expect(parsed.error).toMatch(/X-Disco-Session-Id/);
    expect(parsed.error).toMatch(/\?sessionId=/);
    expect(sessionsGet).not.toHaveBeenCalled();
  }, 30_000);

  it('disco_sessions_spawn returns an actionable session-context error', async () => {
    const spawn = vi.fn();
    const app = makeFakeApp({
      sessions: { spawn },
      '/sessions/:id/prompt': { create: vi.fn() },
    });
    const { disco_sessions_spawn } = await registerAndCaptureHandlers({ app, userId: 'user-1' }, [
      'disco_sessions_spawn',
    ]);

    const result = await disco_sessions_spawn({ prompt: 'delegate this' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/requires current Disco session context/i);
    expect(parsed.error).toMatch(/X-Disco-Session-Id/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('disco_sessions_list', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('does not expose retired branch or board filters in the callable schema', async () => {
    const app = makeFakeApp({ sessions: { find: vi.fn() } });
    const tools = await registerAndCaptureTools(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_list']
    );

    const schema = tools.disco_sessions_list.cfg.inputSchema!;
    const branchInput = schema.safeParse({ branchId: 'wt-1' });
    const boardInput = schema.safeParse({ boardId: 'board-1' });
    expect(branchInput.success).toBe(true);
    expect(boardInput.success).toBe(true);
    expect(branchInput.data).not.toHaveProperty('branchId');
    expect(boardInput.data).not.toHaveProperty('boardId');
  });

  it('ignores retired branchId input at the handler boundary and omits internal carriers', async () => {
    const findCalls: unknown[] = [];
    const app = makeFakeApp({
      branches: { get: async (id: string) => ({ branch_id: id }) },
      sessions: {
        find: async (params: unknown) => {
          findCalls.push(params);
          return {
            total: 2,
            limit: 50,
            skip: 0,
            data: [
              { session_id: 'sess-target', branch_id: 'wt-1', status: 'idle', mcp_token: 'tok1' },
              { session_id: 'sess-other', branch_id: 'wt-2', status: 'idle', mcp_token: 'tok2' },
            ],
          };
        },
      },
    });

    const { disco_sessions_list } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_list']
    );

    const result = await disco_sessions_list({ branchId: 'wt-1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(findCalls[0]).toMatchObject({ query: { archived: false } });
    expect(findCalls[0]).not.toMatchObject({ query: { branch_id: 'wt-1' } });
    expect(parsed.total).toBe(2);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].session_id).toBe('sess-target');
    expect(parsed.data[0]).not.toHaveProperty('mcp_token');
    expect(parsed.data[0]).not.toHaveProperty('branch_id');
  });

  it('ignores retired boardId input and uses ordinary pagination', async () => {
    const findCalls: unknown[] = [];
    const app = makeFakeApp({
      sessions: {
        find: async (params: unknown) => {
          findCalls.push(params);
          return {
            total: 2,
            limit: 10000,
            skip: 0,
            data: [
              {
                session_id: 'sess-on-board',
                branch_id: 'wt-1',
                branch_board_id: 'board-1',
                status: 'idle',
                mcp_token: 'tok1',
              },
              {
                session_id: 'sess-other-board',
                branch_id: 'wt-2',
                branch_board_id: 'board-2',
                status: 'idle',
                mcp_token: 'tok2',
              },
            ],
          };
        },
      },
    });

    const { disco_sessions_list } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_list']
    );

    const result = await disco_sessions_list({ boardId: 'board-1', limit: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(findCalls[0]).toMatchObject({
      query: { archived: false, $limit: 10 },
    });
    expect(findCalls[0]).not.toMatchObject({ query: { board_id: 'board-1' } });
    expect(parsed.total).toBe(2);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].session_id).toBe('sess-on-board');
    expect(parsed.data[0]).not.toHaveProperty('mcp_token');
    expect(parsed.data[0]).not.toHaveProperty('branch_board_id');
  });
});

describe('disco_sessions_get', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('redacts mcp_token from the returned session payload', async () => {
    const app = makeFakeApp({
      sessions: {
        get: async (id: string) => ({
          session_id: id,
          branch_id: 'wt-1',
          status: 'idle',
          mcp_token: 'secret-token',
        }),
      },
      'session-mcp-servers': { find: async () => ({ data: [] }) },
    });

    const { disco_sessions_get } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_get']
    );

    const result = await disco_sessions_get({ sessionId: 'sess-target' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.session_id).toBe('sess-target');
    expect(parsed).not.toHaveProperty('mcp_token');
    expect(parsed).not.toHaveProperty('branch_id');
  });
});

describe('disco_sessions_spawn', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('threads modelConfig into SpawnConfig (Bug 2)', async () => {
    const spawnCalls: Array<{ id: string; data: any }> = [];
    const app = makeFakeApp({
      sessions: {
        spawn: async (id: string, data: any) => {
          spawnCalls.push({ id, data });
          return {
            session_id: 'sess-child',
            permission_config: { mode: 'acceptEdits' },
          };
        },
      },
      '/sessions/:id/prompt': {
        // Returns a Task-shaped object — the route returns the entity directly.
        create: async () => ({ task_id: 't1', status: 'running' }),
      },
    });

    const { disco_sessions_spawn } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-parent' },
      ['disco_sessions_spawn']
    );

    await disco_sessions_spawn({
      prompt: 'do the thing',
      modelConfig: { model: 'claude-opus-4-6', effort: 'high' },
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].data.modelConfig).toEqual({
      model: 'claude-opus-4-6',
      effort: 'high',
    });
  });

  it('threads provider through SpawnConfig.modelConfig (OpenCode)', async () => {
    const spawnCalls: Array<{ id: string; data: any }> = [];
    const app = makeFakeApp({
      sessions: {
        spawn: async (id: string, data: any) => {
          spawnCalls.push({ id, data });
          return {
            session_id: 'sess-child',
            permission_config: { mode: 'acceptEdits' },
          };
        },
      },
      '/sessions/:id/prompt': {
        // Returns a Task-shaped object — the route returns the entity directly.
        create: async () => ({ task_id: 't1', status: 'running' }),
      },
    });

    const { disco_sessions_spawn } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-parent' },
      ['disco_sessions_spawn']
    );

    await disco_sessions_spawn({
      prompt: 'do the thing',
      modelConfig: { model: 'claude-sonnet-5', provider: 'anthropic' },
    });

    // Regression guard: without `provider` on SpawnConfig, Zod-validated input
    // would reach the spawn service with provider set, but the service's merge
    // would drop it (or TS would reject the field). This asserts the full
    // shape survives the MCP → service boundary.
    expect(spawnCalls[0].data.modelConfig).toEqual({
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });
  });
});

describe('disco_sessions_prompt (subsession mode)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('threads modelConfig into SpawnConfig when mode="subsession"', async () => {
    const spawnCalls: Array<{ id: string; data: any }> = [];
    const app = makeFakeApp({
      sessions: {
        spawn: async (id: string, data: any) => {
          spawnCalls.push({ id, data });
          return {
            session_id: 'sess-sub',
            permission_config: { mode: 'acceptEdits' },
          };
        },
      },
      '/sessions/:id/prompt': {
        // Returns a Task-shaped object — the route returns the entity directly.
        create: async () => ({ task_id: 't1', status: 'running' }),
      },
    });

    const { disco_sessions_prompt } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_prompt']
    );

    await disco_sessions_prompt({
      sessionId: 'sess-target',
      prompt: 'delegated work',
      mode: 'subsession',
      modelConfig: { model: 'claude-opus-4-6', effort: 'max', provider: 'anthropic' },
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].id).toBe('sess-target');
    expect(spawnCalls[0].data.modelConfig).toEqual({
      model: 'claude-opus-4-6',
      effort: 'max',
      provider: 'anthropic',
    });
  });
});

describe('disco_sessions_prompt task callback', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('binds callback:true to trusted calling session context', async () => {
    const promptCalls: any[] = [];
    const app = makeFakeApp({
      '/sessions/:id/prompt': {
        create: async (...args: unknown[]) => {
          promptCalls.push(args);
          return { task_id: 'task-1', status: 'queued', queue_position: 1 };
        },
      },
    });
    const { disco_sessions_prompt } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_prompt']
    );

    await disco_sessions_prompt({
      sessionId: 'sess-target',
      prompt: 'continue exactly this task',
      mode: 'continue',
      callback: true,
    });

    expect(promptCalls[0][1]).toMatchObject({
      route: { id: 'sess-target' },
      _taskCompletionCallback: {
        target_session_id: 'sess-caller',
        requested_from_session_id: 'sess-caller',
        requested_by_user_id: 'user-1',
      },
    });
    const { ensureCanPromptTargetSession } = await import('../../utils/session-authorization.js');
    expect(ensureCanPromptTargetSession).toHaveBeenCalledWith(
      'sess-caller',
      'user-1',
      app
    );
  });

  it('rejects callback:true when the caller cannot prompt its callback session', async () => {
    const { ensureCanPromptTargetSession } = await import('../../utils/session-authorization.js');
    vi.mocked(ensureCanPromptTargetSession).mockRejectedValueOnce(
      new Error('Prompt permission required')
    );
    const promptCreate = vi.fn();
    const app = makeFakeApp({ '/sessions/:id/prompt': { create: promptCreate } });
    const { disco_sessions_prompt } = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-view-only' },
      ['disco_sessions_prompt']
    );

    await expect(
      disco_sessions_prompt({
        sessionId: 'sess-target',
        prompt: 'continue',
        mode: 'continue',
        callback: true,
      })
    ).rejects.toThrow('Prompt permission required');
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('rejects callback:true without current session context', async () => {
    const promptCreate = vi.fn();
    const app = makeFakeApp({ '/sessions/:id/prompt': { create: promptCreate } });
    const { disco_sessions_prompt } = await registerAndCaptureHandlers({ app, userId: 'user-1' }, [
      'disco_sessions_prompt',
    ]);

    const result = await disco_sessions_prompt({
      sessionId: 'sess-target',
      prompt: 'continue',
      mode: 'continue',
      callback: true,
    });

    expect(result.isError).toBe(true);
    expect(promptCreate).not.toHaveBeenCalled();
  });
});

describe('MCP session input validation clarity', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('rejects missing required ids with field-specific messages', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_get']
    );

    const result = tools.disco_sessions_get.cfg.inputSchema!.safeParse({});

    expect(result.success).toBe(false);
    expect(String(result.error.message)).toMatch(/sessionId is required and must be a string/);
  });

  it('rejects empty required prompts and optional titles when provided', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_prompt']
    );

    const emptyPrompt = tools.disco_sessions_prompt.cfg.inputSchema!.safeParse({
      sessionId: 'sess-target',
      mode: 'continue',
      prompt: '',
    });
    expect(emptyPrompt.success).toBe(false);
    expect(String(emptyPrompt.error.message)).toMatch(/prompt cannot be empty/);

    const emptyTitle = tools.disco_sessions_prompt.cfg.inputSchema!.safeParse({
      sessionId: 'sess-target',
      mode: 'fork',
      prompt: 'do work',
      title: '',
    });
    expect(emptyTitle.success).toBe(false);
    expect(String(emptyTitle.error.message)).toMatch(/title cannot be empty/);
  });

  it('rejects invalid pagination limits before handlers run', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
      ['disco_sessions_list']
    );

    const result = tools.disco_sessions_list.cfg.inputSchema!.safeParse({ limit: 0 });

    expect(result.success).toBe(false);
    expect(String(result.error.message)).toMatch(/limit must be greater than 0/);
  });
});

describe('modelConfig schema (string shorthand coercion)', () => {
  it.each(['disco_sessions_spawn', 'disco_sessions_prompt'] as const)(
    '%s accepts string and structured modelConfig values',
    async (toolName) => {
      const tools = await registerAndCaptureTools(
        { app: {}, userId: 'user-1', sessionId: 'sess-caller' },
        [toolName]
      );
      const schema = tools[toolName].cfg.inputSchema!;
      const base =
        toolName === 'disco_sessions_spawn'
          ? { prompt: 'delegate' }
          : { sessionId: 'sess-target', prompt: 'delegate', mode: 'subsession' };

      expect(schema.parse({ ...base, modelConfig: 'claude-opus-4-6' })).toMatchObject({
        modelConfig: 'claude-opus-4-6',
      });
      expect(
        schema.parse({
          ...base,
          modelConfig: { mode: 'alias', model: 'claude-sonnet-5', effort: 'high' },
        })
      ).toMatchObject({
        modelConfig: { mode: 'alias', model: 'claude-sonnet-5', effort: 'high' },
      });
      expect(() => schema.parse({ ...base, modelConfig: '' })).toThrow();
    }
  );
});

describe('disco_models_list', () => {
  it('returns model registries grouped by agenticTool', async () => {
    const { disco_models_list } = await registerAndCaptureHandlers(
      { app: {}, userId: 'user-1', sessionId: 'sess-1' },
      ['disco_models_list']
    );

    const result = await disco_models_list({});
    const parsed = JSON.parse(result.content[0].text);

    expect(Object.keys(parsed)).toEqual(AGENTIC_TOOL_NAMES);

    expect(parsed['claude-code'].default).toBe('claude-sonnet-5');
    expect(Array.isArray(parsed['claude-code'].models)).toBe(true);
    expect(parsed['claude-code'].models[0]).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
    });

    // Sanity: the canonical aliases an agent would want to pin should be discoverable
    const claudeIds = parsed['claude-code'].models.map((m: { id: string }) => m.id);
    expect(claudeIds).toContain('claude-opus-4-6');
    expect(claudeIds).toContain('claude-sonnet-5');
    expect(parsed.opencode).toMatchObject({
      default: null,
      models: [],
      note: expect.stringContaining('provider-specific'),
    });
  });

  it('filters to a single agenticTool when requested', async () => {
    const { disco_models_list } = await registerAndCaptureHandlers(
      { app: {}, userId: 'user-1', sessionId: 'sess-1' },
      ['disco_models_list']
    );

    const result = await disco_models_list({ agenticTool: 'codex' });
    const parsed = JSON.parse(result.content[0].text);

    expect(Object.keys(parsed)).toEqual(['codex']);
    expect(parsed.codex.models.length).toBeGreaterThan(0);
    expect(parsed.codex.models[0]).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
      description: expect.any(String),
    });
    expect(parsed.codex.note).toContain('omit modelConfig');

    const codexIds = parsed.codex.models.map((m: { id: string }) => m.id);
    expect(codexIds.slice(0, 3)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    expect(codexIds).toContain('gpt-5.5');
    expect(codexIds).toContain('gpt-5.4-mini');
    expect(codexIds).toContain('gpt-5.4');
    expect(codexIds).not.toContain('gpt-5-codex');
    expect(
      parsed.codex.models.find((model: { id: string }) => model.id === 'gpt-5.5')
    ).toMatchObject({
      status: 'known',
      availability: 'provider-dependent',
    });
  });
});

describe('inputSchema → JSON Schema conversion (MCP discovery)', () => {
  it('accepts every active orchestration tool and rejects historical agentic tool names', async () => {
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-1' },
      ['disco_sessions_spawn', 'disco_sessions_prompt', 'disco_models_list']
    );

    for (const agenticTool of AGENTIC_TOOL_NAMES) {
      expect(
        tools.disco_sessions_spawn.cfg.inputSchema!.safeParse({
          prompt: 'delegate',
          agenticTool,
        }).success
      ).toBe(true);
      expect(
        tools.disco_sessions_prompt.cfg.inputSchema!.safeParse({
          sessionId: 'session-1',
          prompt: 'delegate',
          mode: 'subsession',
          agenticTool,
        }).success
      ).toBe(true);
      expect(
        tools.disco_models_list.cfg.inputSchema!.safeParse({
          agenticTool,
        }).success
      ).toBe(true);
    }

    for (const tool of Object.values(tools)) {
      expect(
        tool.cfg.inputSchema!.safeParse({
          branchId: 'branch-1',
          sessionId: 'session-1',
          prompt: 'delegate',
          mode: 'subsession',
          agenticTool: 'claude-code-cli',
        }).success
      ).toBe(false);
    }
    expect(
      tools.disco_models_list.cfg.inputSchema!.safeParse({
        agenticTool: 'claude-code-cli',
      }).success
    ).toBe(false);
  });

  // Regression: a Zod `.transform()` on `modelConfig` made `toJSONSchema` throw
  // ("Transforms cannot be represented in JSON Schema"). The catch in
  // `mcp/server.ts` then degraded the *entire* containing tool's schema to
  // `{ type: 'object' }`, hiding every parameter from MCP clients calling
  // `disco_get_tool_details`. Keep this test green to ensure the
  // string-or-object union stays JSON-Schema-representable.
  it('produces a non-empty JSON Schema for tools that accept modelConfig', async () => {
    const { toJSONSchema } = await import('zod/v4-mini');
    const tools = await registerAndCaptureTools(
      { app: {}, userId: 'user-1', sessionId: 'sess-1' },
      ['disco_sessions_spawn', 'disco_sessions_prompt']
    );

    for (const name of ['disco_sessions_spawn', 'disco_sessions_prompt']) {
      const schema = tools[name].cfg.inputSchema!;
      const jsonSchema = toJSONSchema(schema as Parameters<typeof toJSONSchema>[0]) as Record<
        string,
        any
      >;

      // Sanity: real param surface, not the `{ type: 'object' }` fallback
      expect(jsonSchema.type).toBe('object');
      expect(jsonSchema.properties).toBeDefined();
      expect(Object.keys(jsonSchema.properties).length).toBeGreaterThan(1);

      // The modelConfig union should be expressed as anyOf (string | object)
      const mc = jsonSchema.properties.modelConfig;
      expect(mc).toBeDefined();
      expect(Array.isArray(mc.anyOf)).toBe(true);
    }
  });
});

describe('attached_mcp_servers in session-info tools', () => {
  // The catalog (`disco_mcp_servers_list`) and the per-session attachment view
  // are now distinct: catalog = "what could I attach", attached = "what IS
  // attached to this session". This test pins the attachment view onto
  // `disco_sessions_get_current` and `disco_sessions_get`, since previously the
  // only way to read it was a session-biased version of `disco_mcp_servers_list`.
  it('disco_sessions_get_current returns attached_mcp_servers from the junction', async () => {
    const app = makeFakeApp({
      sessions: {
        get: async (id: string) => ({
          session_id: id,
          branch_id: null, // skip branch denormalization for brevity
        }),
      },
      'session-mcp-servers': {
        find: async () => ({ data: [{ mcp_server_id: 'srv-1' }, { mcp_server_id: 'srv-2' }] }),
      },
      'mcp-servers': {
        get: async (id: string) => ({
          mcp_server_id: id,
          name: `name-${id}`,
          display_name: `Display ${id}`,
          transport: 'http',
          enabled: true,
          auth: { type: 'none' },
        }),
      },
    });

    const tools = await registerAndCaptureTools(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      ['disco_sessions_get_current']
    );
    const result = await tools.disco_sessions_get_current.cb({});
    const payload = JSON.parse(result.content[0].text);

    expect(Array.isArray(payload.attached_mcp_servers)).toBe(true);
    expect(payload.attached_mcp_servers).toHaveLength(2);
    expect(payload.attached_mcp_servers[0]).toMatchObject({
      mcp_server_id: 'srv-1',
      name: 'name-srv-1',
      transport: 'http',
      auth_type: 'none',
      oauth_authenticated: true,
      enabled: true,
    });
  });

  it('disco_sessions_get returns attached_mcp_servers for the requested session', async () => {
    const app = makeFakeApp({
      sessions: {
        get: async (id: string) => ({ session_id: id }),
      },
      'session-mcp-servers': {
        find: async (params: { query?: { session_id?: string } }) => ({
          data: params?.query?.session_id === 'sess-other' ? [{ mcp_server_id: 'srv-x' }] : [],
        }),
      },
      'mcp-servers': {
        get: async (id: string) => ({
          mcp_server_id: id,
          name: `name-${id}`,
          transport: 'stdio',
          enabled: true,
          auth: { type: 'none' },
        }),
      },
    });

    const tools = await registerAndCaptureTools(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      ['disco_sessions_get']
    );
    const result = await tools.disco_sessions_get.cb({ sessionId: 'sess-other' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.attached_mcp_servers).toEqual([
      expect.objectContaining({ mcp_server_id: 'srv-x', auth_type: 'none' }),
    ]);
  });
});

describe('disco_sessions_archive tools', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('delegates archive and unarchive to the shared sessions service operations', async () => {
    const archive = vi.fn(async () => ({ count: 3 }));
    const unarchive = vi.fn(async () => ({ count: 2 }));
    const app = makeFakeApp({
      sessions: { archive, unarchive },
    });

    const tools = await registerAndCaptureHandlers(
      { app, userId: 'user-1', sessionId: 'sess-current', baseServiceParams: { provider: 'mcp' } },
      ['disco_sessions_archive', 'disco_sessions_unarchive']
    );

    const archiveResult = await tools.disco_sessions_archive({
      sessionId: 'sess-parent',
      includeChildren: true,
    });
    const unarchiveResult = await tools.disco_sessions_unarchive({
      sessionId: 'sess-parent',
      includeChildren: false,
    });

    expect(archive).toHaveBeenCalledWith(
      'sess-parent',
      { includeChildren: true },
      { provider: 'mcp' }
    );
    expect(unarchive).toHaveBeenCalledWith(
      'sess-parent',
      { includeChildren: false },
      { provider: 'mcp' }
    );
    expect(JSON.parse(archiveResult.content[0].text)).toMatchObject({ archivedCount: 3 });
    expect(JSON.parse(unarchiveResult.content[0].text)).toMatchObject({ unarchivedCount: 2 });
  });
});
