import { execFile as execFileCallback } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { resolveMultiTenancyConfig } from '@disco/core/config';
import { getCurrentTenantId, SessionRepository } from '@disco/core/db';
import { Server as SdkServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCatalogHandlerConsistency,
  buildRegistry,
  buildServerInstructions,
  coerceJsonRecord,
  setupMCPRoutes,
} from './server.js';
import { initMcpTokens, MCP_TOKEN_AUDIENCE, MCP_TOKEN_ISSUER } from './tokens.js';
import { ToolRegistry } from './tool-registry.js';

const execFile = promisify(execFileCallback);

function testSqliteDb() {
  // Tenant scopes are transaction-free on SQLite. The MCP route tests mock the
  // repositories themselves, but still provide the backend discriminator used
  // by runWithTenantDatabaseScope.
  return { run: vi.fn() } as never;
}

describe('coerceJsonRecord', () => {
  it('passes through a plain object unchanged', () => {
    const obj = { boardId: '123', name: 'test' };
    expect(coerceJsonRecord(obj)).toBe(obj);
  });

  it('passes through undefined unchanged', () => {
    expect(coerceJsonRecord(undefined)).toBeUndefined();
  });

  it('passes through null unchanged', () => {
    expect(coerceJsonRecord(null)).toBeNull();
  });

  it('passes through a number unchanged', () => {
    expect(coerceJsonRecord(42)).toBe(42);
  });

  it('parses a JSON-stringified object back to an object', () => {
    const input = JSON.stringify({ boardId: '123', name: 'test' });
    expect(coerceJsonRecord(input)).toEqual({ boardId: '123', name: 'test' });
  });

  it('parses a complex stringified object with markdown content', () => {
    const obj = {
      branchId: 'abc-123',
      initialPrompt:
        '# Hello\n\nSome **markdown** with `backticks` and\n\n```ts\nconst x = 1;\n```',
    };
    expect(coerceJsonRecord(JSON.stringify(obj))).toEqual(obj);
  });

  it('returns "null" string parsed as null (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('null')).toBeNull();
  });

  it('returns "[]" string parsed as array (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('[]')).toEqual([]);
  });

  it('returns "42" string parsed as number (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('42')).toBe(42);
  });

  it('returns empty string unchanged (not valid JSON)', () => {
    expect(coerceJsonRecord('')).toBe('');
  });

  it('returns malformed JSON string unchanged', () => {
    expect(coerceJsonRecord('{bad json')).toBe('{bad json');
  });

  it('returns non-JSON string unchanged', () => {
    expect(coerceJsonRecord('hello world')).toBe('hello world');
  });
});

describe('MCP tool registry', () => {
  it('keeps representative tool detail schemas from degrading to bare object schemas', () => {
    const registry = buildRegistry();
    const expectedPropertiesByTool: Record<string, string[]> = {
      disco_sessions_prompt: ['sessionId', 'prompt', 'mode'],
      disco_skills_install: ['name', 'skillMarkdown', 'targetAgentId'],
      disco_agent_memory_save: ['topic', 'content'],
      disco_execute_tool: ['tool_name', 'arguments'],
      disco_files_publish: ['files'],
    };

    for (const [toolName, expectedProperties] of Object.entries(expectedPropertiesByTool)) {
      const schema = registry.get(toolName)?.inputSchema;
      expect(schema, `${toolName} should be registered`).toBeDefined();
      expect(schema, `${toolName} should not degrade to { type: "object" }`).toMatchObject({
        type: 'object',
        properties: expect.any(Object),
      });

      for (const property of expectedProperties) {
        expect(
          (schema?.properties as Record<string, unknown> | undefined)?.[property],
          `${toolName} should expose ${property} in JSON schema`
        ).toBeDefined();
      }
    }
  });

  it('publishes complete governance metadata and a deterministic catalog fingerprint', () => {
    const first = buildRegistry();
    const second = buildRegistry();
    const files = first.get('disco_files_publish');

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.runtimeCatalog.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.runtimeCatalog).toEqual(first.runtimeCatalog);
    expect(first.runtimeCatalog.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'codex-native:image-generation',
          provider: 'codex-native',
          exposure: 'runtime-event',
        }),
        expect.objectContaining({
          id: 'disco-mcp:disco_files_publish',
          provider: 'disco-mcp',
          exposure: 'agent-callable',
        }),
        expect.objectContaining({
          id: 'ui-only:schedules',
          provider: 'ui-only',
          exposure: 'ui-only',
        }),
        expect.objectContaining({
          id: 'ui-only:analytics',
          provider: 'ui-only',
          exposure: 'ui-only',
        }),
      ])
    );
    expect(files?.governance).toMatchObject({
      provider: 'disco-mcp',
      audiences: ['standalone', 'agent'],
      ownership: 'current-session',
      outputKinds: ['file', 'image', 'pdf', 'audio', 'video'],
      lifecycle: 'managed',
    });
    expect(first.listDomains().find(({ domain }) => domain === 'files')).toMatchObject({
      provider: 'disco-mcp',
      ownership: 'current-session',
      count: 1,
    });
  });

  it('keeps request-handler expectations aligned with audience-filtered metadata', () => {
    const registry = buildRegistry();
    const agentNames = registry.listDispatchableNames(['agent']);
    const standaloneNames = registry.listDispatchableNames(['standalone']);

    expect(agentNames).toContain('disco_agent_memory_save');
    expect(standaloneNames).not.toContain('disco_agent_memory_save');
    expect(agentNames).toContain('disco_files_publish');
    expect(standaloneNames).toContain('disco_files_publish');
    expect(agentNames).not.toContain('disco_search_tools');
    expect(new Set(agentNames).size).toBe(agentNames.length);
  });

  it('generates progressive discovery instructions from registered metadata', () => {
    const registry = buildRegistry();
    const instructions = buildServerInstructions(registry);

    for (const name of ['disco_search_tools', 'disco_get_tool_details', 'disco_execute_tool']) {
      const entry = registry.get(name);
      expect(entry).toBeDefined();
      expect(instructions).toContain(`${name}: ${entry!.description}`);
    }
    expect(instructions).not.toContain('disco_upload_materialize');
  });

  it('fails immediately when instructions or executable handlers drift from metadata', () => {
    expect(() => buildServerInstructions(new ToolRegistry())).toThrow(
      /instructions reference an unregistered method/u
    );

    const registry = buildRegistry();
    const validHandlers = registry.listDispatchableNames(['agent']);
    expect(() =>
      assertCatalogHandlerConsistency(
        registry,
        validHandlers.filter((name) => name !== 'disco_files_publish'),
        ['agent'],
        'startup'
      )
    ).toThrow(/missing handlers: disco_files_publish/u);
    expect(() =>
      assertCatalogHandlerConsistency(
        registry,
        [...validHandlers, 'disco_ghost_method'],
        ['agent'],
        'startup'
      )
    ).toThrow(/missing metadata: disco_ghost_method/u);
  });

  it('does not advertise retired Agor, UI-only, or proxy methods', () => {
    const registry = buildRegistry();
    const retiredDomains = [
      'repos',
      'branches',
      'boards',
      'cards',
      'artifacts',
      'schedules',
      'analytics',
    ];
    const retiredSessionMethods = [
      'disco_sessions_get_current_context',
      'disco_sessions_create',
      'disco_sessions_bulk_archive',
    ];
    const domains = registry.listDomains().map(({ domain }) => domain);

    expect(domains).not.toContain('proxies');
    for (const domain of retiredDomains) expect(domains).not.toContain(domain);
    expect(
      registry
        .search(undefined, { maxResults: Number.MAX_SAFE_INTEGER })
        .some(
          ({ name }) =>
            name.startsWith('disco_proxies_') ||
            /^disco_(?:repos|branches|boards|cards|card_types|artifacts|schedules)_/u.test(name)
        )
    ).toBe(false);
    for (const method of retiredSessionMethods) expect(registry.get(method)).toBeUndefined();
    expect(registry.get('disco_upload_materialize')).toBeUndefined();
  });

  it('filters method discovery by authenticated request audience', () => {
    const registry = buildRegistry();

    expect(registry.get('disco_agent_memory_save', ['agent'])).toBeDefined();
    expect(registry.get('disco_agent_memory_save', ['standalone'])).toBeUndefined();
    expect(registry.get('disco_users_list', ['agent'])).toBeUndefined();
    expect(registry.get('disco_users_list', ['admin'])).toBeDefined();
    expect(registry.get('disco_users_get_current', ['agent'])).toBeDefined();
    expect(registry.listDomains(['agent']).map(({ domain }) => domain)).not.toContain(
      'environment'
    );
  });
});

/**
 * Capture the Express handler registered by setupMCPRoutes so the
 * token-source validation branches can be tested without spinning up
 * the full FeathersJS stack.
 */
function captureMcpHandler(
  config: Parameters<typeof setupMCPRoutes>[3] = { multi_tenancy: undefined }
) {
  let handler: ((req: Request, res: Response) => Promise<unknown> | unknown) | null = null;
  const register = (_path: string, fn: typeof handler) => {
    handler = fn;
  };
  const app = {
    settings: { authentication: { secret: 'mcp-server-test-secret' } },
    post: register,
    get: register,
    delete: register,
    service: (name: string) => {
      if (name !== 'users' && name !== 'sessions') {
        throw new Error(`Unexpected service lookup: ${name}`);
      }
      return {
        get: vi.fn(async () => {
          throw new Error(`Unexpected ${name}.get call`);
        }),
      };
    },
  } as unknown as Parameters<typeof setupMCPRoutes>[0];
  setupMCPRoutes(app, testSqliteDb(), /* toolSearchEnabled */ false, config);
  if (!handler) throw new Error('MCP handler was not registered');
  return handler;
}

function buildRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    on(_event: string, _cb: () => void) {
      return this;
    },
  };
  return res;
}

describe('POST /mcp token source', () => {
  afterEach(() => {
    // Restore any spies installed per-test (e.g. console.warn) so later
    // suites start from a clean slate.
    vi.restoreAllMocks();
  });

  it('rejects requests with ?sessionToken= query param (400)', async () => {
    const handler = captureMcpHandler();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'POST',
      query: { sessionToken: 'leaky-token-value' },
      headers: {},
      body: { id: 7 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();
    await handler(req, res as unknown as Response);
    expect(res.statusCode).toBe(400);
    const body = res.body as { error?: { message?: string }; id?: number };
    expect(body?.error?.message).toMatch(/no longer accepted/i);
    expect(body?.id).toBe(7);
    // The deprecation log must never include the token value.
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('leaky-token-value');
    warn.mockRestore();
  });

  it('rejects requests with no Authorization header (401)', async () => {
    const handler = captureMcpHandler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'POST',
      query: {},
      headers: {},
      body: { id: 8 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();
    await handler(req, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    const body = res.body as { error?: { message?: string } };
    expect(body?.error?.message).toMatch(/authorization: bearer/i);
  });

  it('rejects an invalid personal API key from X-API-Key (401)', async () => {
    const { UserApiKeysRepository } = await import('@disco/core/db');
    vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey').mockResolvedValue(null);
    const handler = captureMcpHandler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'POST',
      query: {},
      headers: { 'x-api-key': 'disco_sk_invalid' },
      body: { id: 10 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();
    await handler(req, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    const body = res.body as { error?: { message?: string }; id?: number };
    expect(body.id).toBe(10);
    expect(body.error?.message).toMatch(/invalid personal api key/i);
  });

  it('rejects an internal MCP token replayed under a conflicting trusted tenant', async () => {
    initMcpTokens({
      db: testSqliteDb(),
      multiTenancy: resolveMultiTenancyConfig({}),
    });
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: 'session-shared-looking',
        uid: 'user-shared-looking',
        tid: 'tenant-a',
        aud: MCP_TOKEN_AUDIENCE,
        iss: MCP_TOKEN_ISSUER,
        iat: now,
        exp: now + 60,
        jti: 'token-jti',
      },
      'mcp-server-test-secret',
      { algorithm: 'HS256' }
    );
    const handler = captureMcpHandler({
      multi_tenancy: {
        mode: 'required_from_auth',
        trusted_header: 'x-disco-tenant-id',
      },
    });
    const req = {
      method: 'POST',
      query: {},
      headers: {
        authorization: `Bearer ${token}`,
        'x-disco-tenant-id': 'tenant-b',
      },
      body: { id: 11 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(403);
    const body = res.body as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/tenant identity mismatch/i);
  });

  it('rejects even when query has both ?sessionToken= and an Authorization header (query wins → 400)', async () => {
    const handler = captureMcpHandler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'POST',
      query: { sessionToken: 'qp' },
      headers: { authorization: 'Bearer header-token' },
      body: { id: 9 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();
    await handler(req, res as unknown as Response);
    expect(res.statusCode).toBe(400);
  });

  it('logs the deprecation warning at most once per caller IP', async () => {
    const handler = captureMcpHandler();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Use a unique IP so the module-level Set isn't already populated for it.
    const uniqueIp = `10.9.8.${Math.floor(Math.random() * 255)}`;
    const makeReq = () =>
      ({
        method: 'POST',
        query: { sessionToken: 'x' },
        headers: {},
        body: { id: 1 },
        ip: uniqueIp,
        socket: { remoteAddress: uniqueIp },
      }) as unknown as Request;

    await handler(makeReq(), buildRes() as unknown as Response);
    const firstCount = warn.mock.calls.length;
    await handler(makeReq(), buildRes() as unknown as Response);
    await handler(makeReq(), buildRes() as unknown as Response);
    // Second and third calls from the same IP must not emit another warn.
    expect(warn.mock.calls.length).toBe(firstCount);

    // A different IP still warns.
    const otherIp = `10.9.7.${Math.floor(Math.random() * 255)}`;
    const otherReq = {
      method: 'POST',
      query: { sessionToken: 'x' },
      headers: {},
      body: { id: 2 },
      ip: otherIp,
      socket: { remoteAddress: otherIp },
    } as unknown as Request;
    await handler(otherReq, buildRes() as unknown as Response);
    expect(warn.mock.calls.length).toBe(firstCount + 1);
    warn.mockRestore();
  });
});

describe('POST /mcp with personal API keys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockPersonalApiKeyUser(userId = 'user-1') {
    const keyRows = {
      disco_sk_valid: {
        id: 'key-1',
        user_id: userId,
        name: 'orchestrator',
        prefix: 'disco_sk_123',
        key_hash: 'hash',
        created_at: new Date(),
        last_used_at: null,
      },
      disco_sk_other: {
        id: 'key-2',
        user_id: 'user-2',
        name: 'other',
        prefix: 'disco_sk_456',
        key_hash: 'hash',
        created_at: new Date(),
        last_used_at: null,
      },
    };
    return import('@disco/core/db').then(({ UserApiKeysRepository }) => {
      vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey').mockImplementation(async (key) => {
        return keyRows[key as keyof typeof keyRows] ?? null;
      });
      vi.spyOn(UserApiKeysRepository.prototype, 'updateLastUsed').mockResolvedValue();
    });
  }

  async function withMcpServer(
    services: Record<string, unknown>,
    fn: (baseUrl: string) => Promise<void>,
    config: Parameters<typeof setupMCPRoutes>[3] = { multi_tenancy: undefined },
    toolSearchEnabled = false,
    serverVersion = 'test-product-version'
  ) {
    const webApp = express();
    webApp.use(express.json());
    webApp.set('authentication', { secret: 'mcp-server-test-secret' });
    (webApp as unknown as { service: (name: string) => unknown }).service = (name: string) => {
      const svc = services[name];
      if (!svc) throw new Error(`Unexpected service lookup: ${name}`);
      return svc;
    };

    setupMCPRoutes(webApp as never, testSqliteDb(), toolSearchEnabled, config, { serverVersion });

    const httpServer = webApp.listen(0);
    try {
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('no listen address');
      await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  function parseMcpResponse(text: string) {
    const dataLine = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    return JSON.parse(dataLine ?? text) as {
      result?: { content?: Array<{ text: string }> };
      error?: { message: string };
    };
  }

  it('can call a non-session-scoped tool without X-Disco-Session-Id / ?sessionId', async () => {
    const { UserApiKeysRepository } = await import('@disco/core/db');
    vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey').mockResolvedValue({
      id: 'key-1',
      user_id: 'user-1',
      name: 'orchestrator',
      prefix: 'disco_sk_123',
      key_hash: 'hash',
      created_at: new Date(),
      last_used_at: null,
    });
    vi.spyOn(UserApiKeysRepository.prototype, 'updateLastUsed').mockResolvedValue();

    const webApp = express();
    webApp.use(express.json());
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    (webApp as unknown as { service: (name: string) => unknown }).service = (name: string) => {
      if (name !== 'users') throw new Error(`Unexpected service lookup: ${name}`);
      return { get: getUser };
    };

    setupMCPRoutes(webApp as never, testSqliteDb(), /* toolSearchEnabled */ false);

    const httpServer = webApp.listen(0);
    try {
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('no listen address');
      const resp = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-API-Key': 'disco_sk_valid',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'disco_users_get_current', arguments: {} },
        }),
      });

      expect(resp.status).toBe(200);
      // The v2 SDK's stateless legacy adapter keeps the 2025 wire contract:
      // one bounded, request-scoped SSE response, with no retained session.
      expect(resp.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(resp.headers.get('mcp-session-id')).toBeNull();
      const responseText = await resp.text();
      const body = parseMcpResponse(responseText);
      expect(body.error).toBeUndefined();
      const result = JSON.parse(body.result!.content[0].text);
      expect(result.user_id).toBe('user-1');
      expect(getUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          tenant: { tenant_id: 'default', source: 'static' },
        })
      );
      expect(UserApiKeysRepository.prototype.updateLastUsed).toHaveBeenCalledWith('key-1');
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('accepts a valid personal API key session context from X-Disco-Session-Id', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    const getSession = vi.fn(async () => ({ session_id: 'session-full-id' }));

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'disco_sk_valid',
            'X-Disco-Session-Id': 'session-short',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'disco_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(200);
        expect(parseMcpResponse(await resp.text()).error).toBeUndefined();
        expect(getSession).toHaveBeenCalledWith(
          'session-short',
          expect.objectContaining({
            authenticated: true,
            provider: 'mcp',
            user: expect.objectContaining({ user_id: 'user-1', role: 'member' }),
          })
        );
      }
    );
  });

  it('carries authenticated user tenant into service params for MCP tool calls and session validation', async () => {
    await mockPersonalApiKeyUser();
    const seenTenantIds: Array<string | undefined> = [];
    const getUser = vi.fn(async () => {
      seenTenantIds.push(getCurrentTenantId() as string | undefined);
      return {
        user_id: 'user-1',
        email: 'alice@example.com',
        role: 'member',
        tenant_id: 'tenant-a',
      };
    });
    const getSession = vi.fn(async () => ({ session_id: 'session-full-id' }));

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'disco_sk_valid',
            'X-Disco-Tenant-Id': 'tenant-a',
            'X-Disco-Session-Id': 'session-short',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 22,
            method: 'tools/call',
            params: { name: 'disco_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(200);
        expect(parseMcpResponse(await resp.text()).error).toBeUndefined();
        expect(getSession).toHaveBeenCalledWith(
          'session-short',
          expect.objectContaining({
            authenticated: true,
            provider: 'mcp',
            tenant: { tenant_id: 'tenant-a', source: 'trusted_header' },
          })
        );
        expect(getUser).toHaveBeenCalledWith(
          'user-1',
          expect.objectContaining({
            authenticated: true,
            provider: 'mcp',
            tenant: { tenant_id: 'tenant-a', source: 'trusted_header' },
          })
        );
        expect(seenTenantIds.every((tenantId) => tenantId === 'tenant-a')).toBe(true);
      },
      {
        multi_tenancy: {
          mode: 'required_from_auth',
          trusted_header: 'x-disco-tenant-id',
        },
      }
    );
  });

  it('fails before personal API-key lookup when required tenant identity is missing', async () => {
    const { UserApiKeysRepository } = await import('@disco/core/db');
    const verifyKey = vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey');

    await withMcpServer(
      {},
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'disco_sk_valid',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 23,
            method: 'tools/call',
            params: { name: 'disco_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(401);
        expect(verifyKey).not.toHaveBeenCalled();
      },
      {
        multi_tenancy: {
          mode: 'required_from_auth',
          auth_claim: 'tenant_id',
        },
      }
    );
  });

  it.each([
    {
      label: 'conflicting',
      tenantHeaders: ['tenant-a', 'tenant-b'],
      errorMessage: 'Conflicting tenant identities',
    },
    {
      label: 'identical',
      tenantHeaders: ['tenant-a', 'tenant-a'],
      errorMessage: 'Invalid trusted tenant header x-disco-tenant-id',
    },
  ])(
    'rejects $label duplicate on-wire trusted tenant headers before API-key lookup',
    async ({ tenantHeaders, errorMessage }) => {
      const { UserApiKeysRepository } = await import('@disco/core/db');
      const verifyKey = vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey');

      await withMcpServer(
        {},
        async (baseUrl) => {
          const requestBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 24,
            method: 'tools/call',
            params: { name: 'disco_users_get_current', arguments: {} },
          });
          const response = await new Promise<{ status: number | undefined; body: string }>(
            (resolve, reject) => {
              const req = httpRequest(
                `${baseUrl}/mcp`,
                {
                  method: 'POST',
                  headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    'X-API-Key': 'disco_sk_valid',
                    'X-Disco-Tenant-Id': tenantHeaders,
                  },
                },
                (res) => {
                  let body = '';
                  res.setEncoding('utf8');
                  res.on('data', (chunk: string) => {
                    body += chunk;
                  });
                  res.on('end', () => resolve({ status: res.statusCode, body }));
                }
              );
              req.on('error', reject);
              req.end(requestBody);
            }
          );

          expect(response.status, response.body).toBe(401);
          expect(JSON.parse(response.body)).toMatchObject({
            error: { message: errorMessage },
          });
          expect(verifyKey).not.toHaveBeenCalled();
        },
        {
          multi_tenancy: {
            mode: 'required_from_auth',
            trusted_header: 'x-disco-tenant-id',
          },
        }
      );
    }
  );

  it('accepts a valid personal API key session context from ?sessionId=', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    const getSession = vi.fn(async () => ({ session_id: 'session-full-id' }));

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp?sessionId=session-query`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'disco_sk_valid',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'disco_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(200);
        expect(parseMcpResponse(await resp.text()).error).toBeUndefined();
        expect(getSession).toHaveBeenCalledWith('session-query', expect.any(Object));
      }
    );
  });

  it('rejects inaccessible personal API key session context', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    const getSession = vi.fn(async () => {
      throw new Error('no access');
    });

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'disco_sk_valid',
            'X-Disco-Session-Id': 'forbidden-session',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'disco_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(403);
        const body = (await resp.json()) as { error?: { message?: string } };
        expect(body.error?.message).toMatch(/not accessible/i);
      }
    );
  });

  it('initializes legacy clients with a bounded response, no transport session, and immutable tool capabilities', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-API-Key': 'disco_sk_valid',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '1.0.0' },
          },
        }),
      });

      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(resp.headers.get('mcp-session-id')).toBeNull();
      const body = parseMcpResponse(await resp.text()) as {
        result?: {
          capabilities?: { tools?: { listChanged?: boolean }; logging?: unknown };
          serverInfo?: { name?: string; version?: string };
        };
      };
      expect(body.result?.capabilities).toEqual({ tools: { listChanged: false } });
      expect(body.result?.serverInfo).toMatchObject({
        name: 'disco',
        version: 'test-product-version',
      });
    });
  });

  it('supports the sessionless Streamable HTTP client initialize/list contract', async () => {
    await mockPersonalApiKeyUser();
    const closeSpy = vi.spyOn(SdkServer.prototype, 'close');
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const headers = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-API-Key': 'disco_sk_valid',
      };
      const initialize = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'disco-contract-test', version: '1.0.0' },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      expect(initialize.headers.get('mcp-session-id')).toBeNull();
      parseMcpResponse(await initialize.text());

      const initialized = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...headers, 'MCP-Protocol-Version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(initialized.status).toBe(202);
      await initialized.text();

      // Current clients may optimistically try the optional standalone SSE
      // stream. A stateless server declines it and the client continues.
      const stream = await fetch(`${baseUrl}/mcp`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
          'X-API-Key': 'disco_sk_valid',
        },
      });
      expect(stream.status).toBe(405);
      await stream.text();

      const list = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...headers, 'MCP-Protocol-Version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const result = parseMcpResponse(await list.text()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(result.result.tools.some(({ name }) => name === 'disco_users_get_current')).toBe(true);

      // Initialize, initialized, and list are separate stateless exchanges.
      // The SDK must close every request-local server once each response is
      // consumed rather than retaining initialization-era transport state.
      await vi.waitFor(() => expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(3));
    });
  });

  it('interoperates end-to-end with the installed legacy TypeScript Streamable HTTP client', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));

    await withMcpServer(
      { users: { get: getUser } },
      async (baseUrl) => {
        // Run the installed SDK client under plain Node rather than Vitest's
        // development export conditions (which select eventsource-parser's TS
        // source build). This is still an end-to-end wire contract against the
        // real Express route and fails the test on any client error.
        const probe = `
        import { Client } from '@modelcontextprotocol/sdk/client/index.js';
        import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
        const transport = new StreamableHTTPClientTransport(new URL(process.argv[1] + '/mcp'), {
          requestInit: { headers: { 'X-API-Key': 'disco_sk_valid' } },
        });
        const client = new Client({ name: 'disco-sdk-contract-test', version: '1.0.0' });
        try {
          await client.connect(transport);
          const listed = await client.listTools();
          const called = await client.callTool({ name: 'disco_users_get_current', arguments: {} });
          console.log(JSON.stringify({ sessionId: transport.sessionId, listed, called }));
        } finally {
          await client.close();
        }
      `;
        const { stdout } = await execFile(
          process.execPath,
          ['--input-type=module', '--eval', probe, baseUrl],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 }
        );
        const result = JSON.parse(stdout.trim()) as {
          sessionId?: string;
          listed: { tools: Array<{ name: string }> };
          called: { content: Array<{ type: string; text?: string }> };
        };

        expect(result.sessionId).toBeUndefined();
        expect(result.listed.tools.map(({ name }) => name).sort()).toEqual([
          'disco_execute_tool',
          'disco_get_tool_details',
          'disco_search_tools',
        ]);
        expect(JSON.parse(result.called.content[0].text ?? '{}')).toMatchObject({
          user_id: 'user-1',
        });
      },
      { multi_tenancy: undefined },
      /* toolSearchEnabled */ true
    );
  });

  it('interoperates end-to-end with the v2 TypeScript client in modern auto-negotiation mode', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));

    await withMcpServer(
      { users: { get: getUser } },
      async (baseUrl) => {
        const probe = `
          import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
          const exchanges = [];
          const tracedFetch = async (input, init) => {
            const request = new Request(input, init);
            let rpcMethod;
            if (request.method === 'POST') {
              try { rpcMethod = (await request.clone().json()).method; } catch {}
            }
            const response = await fetch(input, init);
            exchanges.push({
              httpMethod: request.method,
              rpcMethod,
              protocolVersion: request.headers.get('mcp-protocol-version'),
              mcpMethod: request.headers.get('mcp-method'),
              mcpName: request.headers.get('mcp-name'),
              status: response.status,
              contentType: response.headers.get('content-type'),
              sessionId: response.headers.get('mcp-session-id'),
            });
            return response;
          };
          const transport = new StreamableHTTPClientTransport(new URL(process.argv[1] + '/mcp'), {
            fetch: tracedFetch,
            requestInit: { headers: {
              'X-API-Key': 'disco_sk_valid',
              // A rolling-deployment remnant must not select transport state.
              'Mcp-Session-Id': 'stale-pre-upgrade-session',
            } },
          });
          const client = new Client(
            { name: 'disco-v2-contract-test', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto' } },
          );
          try {
            await client.connect(transport);
            const listed = await client.listTools();
            const called = await client.callTool({
              name: 'disco_execute_tool',
              arguments: { tool_name: 'disco_users_get_current', arguments: {} },
            });
            console.log(JSON.stringify({
              era: client.getProtocolEra(),
              version: client.getNegotiatedProtocolVersion(),
              discover: client.getDiscoverResult(),
              sessionId: transport.sessionId,
              exchanges,
              listed,
              called,
            }));
          } finally {
            await client.close();
          }
        `;
        const { stdout } = await execFile(
          process.execPath,
          ['--input-type=module', '--eval', probe, baseUrl],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 }
        );
        const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
          era?: string;
          version?: string;
          discover?: {
            capabilities?: { tools?: { listChanged?: boolean } };
            ttlMs?: number;
            cacheScope?: string;
          };
          sessionId?: string;
          exchanges: Array<{
            httpMethod: string;
            rpcMethod?: string;
            protocolVersion?: string;
            mcpMethod?: string;
            mcpName?: string;
            status: number;
            contentType?: string;
            sessionId?: string;
          }>;
          listed: {
            tools: Array<{ name: string }>;
            ttlMs?: number;
            cacheScope?: string;
          };
          called: { content: Array<{ type: string; text?: string }> };
        };

        expect(result.era).toBe('modern');
        expect(result.version).toBe('2026-07-28');
        expect(result.sessionId).toBeUndefined();
        expect(result.discover?.capabilities).toEqual({ tools: { listChanged: false } });
        expect(result.discover).toMatchObject({ ttlMs: 60_000, cacheScope: 'private' });
        expect(result.listed).toMatchObject({ ttlMs: 60_000, cacheScope: 'private' });
        expect(result.exchanges.map(({ rpcMethod }) => rpcMethod)).toEqual([
          'server/discover',
          'tools/list',
          'tools/call',
        ]);
        expect(result.exchanges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              rpcMethod: 'server/discover',
              protocolVersion: '2026-07-28',
              mcpMethod: 'server/discover',
              status: 200,
            }),
            expect.objectContaining({
              rpcMethod: 'tools/call',
              protocolVersion: '2026-07-28',
              mcpMethod: 'tools/call',
              mcpName: 'disco_execute_tool',
              status: 200,
            }),
          ])
        );
        for (const exchange of result.exchanges) {
          expect(exchange.httpMethod).toBe('POST');
          expect(exchange.contentType).toMatch(/^application\/json/);
          expect(exchange.sessionId).toBeNull();
        }
        expect(result.listed.tools.map(({ name }) => name).sort()).toEqual([
          'disco_execute_tool',
          'disco_get_tool_details',
          'disco_search_tools',
        ]);
        expect(JSON.parse(result.called.content[0].text ?? '{}')).toMatchObject({
          user_id: 'user-1',
        });
      },
      { multi_tenancy: undefined },
      /* toolSearchEnabled */ true
    );
  });

  it('rejects a modern request that omits the required per-request metadata envelope', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
          'X-API-Key': 'disco_sk_valid',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' }),
      });

      expect(resp.status).toBe(400);
      expect(await resp.text()).toMatch(/invalid params|_meta/i);
    });
  });

  it.each(['GET', 'DELETE'])(
    'authenticates but rejects %s lifecycle requests with 405',
    async (method) => {
      await mockPersonalApiKeyUser();
      const getUser = vi.fn(async () => ({
        user_id: 'user-1',
        email: 'alice@example.com',
        role: 'member',
      }));

      await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp`, {
          method,
          headers: {
            Accept: 'text/event-stream',
            'X-API-Key': 'disco_sk_valid',
            'Mcp-Session-Id': 'legacy-session',
          },
        });

        expect(resp.status).toBe(405);
        expect(resp.headers.get('allow')).toBe('POST');
        expect(getUser).toHaveBeenCalled();
        expect((await resp.json()) as unknown).toMatchObject({
          error: { message: expect.stringMatching(/not allowed/) },
        });
      });
    }
  );

  it('ignores a valid legacy Mcp-Session-Id on POST without treating it as authority', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-API-Key': 'disco_sk_valid',
          'Mcp-Session-Id': 'unknown-from-before-upgrade',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: { name: 'disco_users_get_current', arguments: {} },
        }),
      });

      expect(resp.status).toBe(200);
      expect(resp.headers.get('mcp-session-id')).toBeNull();
      const parsed = parseMcpResponse(await resp.text());
      expect(parsed.error).toBeUndefined();
      expect(JSON.parse(parsed.result!.content![0].text)).toMatchObject({ user_id: 'user-1' });
    });
  });

  it('re-authenticates credentials and reloads user data on every POST', async () => {
    const { UserApiKeysRepository } = await import('@disco/core/db');
    let keyEnabled = true;
    vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey').mockImplementation(async () =>
      keyEnabled
        ? {
            id: 'key-1',
            user_id: 'user-1',
            name: 'orchestrator',
            prefix: 'disco_sk_123',
            key_hash: 'hash',
            created_at: new Date(),
            last_used_at: null,
          }
        : null
    );
    vi.spyOn(UserApiKeysRepository.prototype, 'updateLastUsed').mockResolvedValue();
    let role = 'member';
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role,
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const call = async (id: number) =>
        fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'disco_sk_valid',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'disco_users_get_current', arguments: {} },
          }),
        });

      const first = await call(120);
      expect(first.status).toBe(200);
      const firstBody = parseMcpResponse(await first.text());
      expect(JSON.parse(firstBody.result!.content![0].text).role).toBe('member');

      role = 'admin';
      const second = await call(121);
      expect(second.status).toBe(200);
      const secondBody = parseMcpResponse(await second.text());
      expect(JSON.parse(secondBody.result!.content![0].text).role).toBe('admin');

      keyEnabled = false;
      const revoked = await call(122);
      expect(revoked.status).toBe(401);
      expect(getUser).toHaveBeenCalledTimes(4); // auth + tool for each successful request
    });
  });

  it('rejects ambiguous credential carriers before key lookup', async () => {
    const { UserApiKeysRepository } = await import('@disco/core/db');
    const verifyKey = vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey');

    await withMcpServer({}, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer disco_sk_valid',
          'Content-Type': 'application/json',
          'X-API-Key': 'disco_sk_other',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' }),
      });

      expect(resp.status).toBe(400);
      expect(verifyKey).not.toHaveBeenCalled();
      expect((await resp.json()) as unknown).toMatchObject({
        error: { message: expect.stringMatching(/exactly one credential/) },
      });
    });
  });

  it.each([
    {
      label: 'conflicting header and query Session IDs',
      path: '/mcp?sessionId=session-query',
      headers: { 'X-Disco-Session-Id': 'session-header' },
      message: /must match/,
    },
    {
      label: 'duplicate Session query parameters',
      path: '/mcp?sessionId=session-a&sessionId=session-b',
      headers: {},
      message: /single non-empty string/,
    },
    {
      label: 'malformed legacy transport Session ID',
      path: '/mcp',
      headers: { 'Mcp-Session-Id': 'contains space' },
      message: /visible ASCII/,
    },
    {
      label: 'empty credential header',
      path: '/mcp',
      headers: { 'X-API-Key': '' },
      message: /non-empty string/,
    },
  ])('rejects $label before key lookup', async ({ path, headers, message }) => {
    const { UserApiKeysRepository } = await import('@disco/core/db');
    const verifyKey = vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey');

    await withMcpServer({}, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...(!Object.hasOwn(headers, 'X-API-Key') ? { 'X-API-Key': 'disco_sk_valid' } : {}),
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 152, method: 'tools/list' }),
      });

      expect(resp.status).toBe(400);
      expect((await resp.json()) as unknown).toMatchObject({
        error: { message: expect.stringMatching(message) },
      });
      expect(verifyKey).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: 'Authorization', values: ['Bearer first', 'Bearer second'] },
    { name: 'X-API-Key', values: ['disco_sk_valid', 'disco_sk_other'] },
    { name: 'X-Disco-Session-Id', values: ['session-a', 'session-b'] },
    { name: 'Mcp-Session-Id', values: ['transport-a', 'transport-b'] },
  ])('rejects duplicate on-wire $name headers before key lookup', async ({ name, values }) => {
    const { UserApiKeysRepository } = await import('@disco/core/db');
    const verifyKey = vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey');

    await withMcpServer({}, async (baseUrl) => {
      const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 103, method: 'tools/list' });
      const response = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            `${baseUrl}/mcp`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'X-API-Key': name === 'X-API-Key' ? values : 'disco_sk_valid',
                [name]: values,
              },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => {
                body += chunk;
              });
              res.on('end', () => resolve({ status: res.statusCode, body }));
            }
          );
          req.on('error', reject);
          req.end(requestBody);
        }
      );

      expect(response.status, response.body).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { message: expect.stringMatching(/must be sent at most once/) },
      });
      expect(verifyKey).not.toHaveBeenCalled();
    });
  });

  it('rejects cross-tenant Disco session context on a fresh stateless request', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async (_userId: string, params: { tenant: { tenant_id: string } }) => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
      tenant_id: params.tenant.tenant_id,
    }));
    const getSession = vi.fn(
      async (sessionId: string, params: { tenant: { tenant_id: string } }) => {
        if (sessionId !== `${params.tenant.tenant_id}-session`) throw new Error('not found');
        return { session_id: sessionId };
      }
    );

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'disco_sk_valid',
            'X-Disco-Tenant-Id': 'tenant-b',
            'X-Disco-Session-Id': 'tenant-a-session',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 104, method: 'tools/list' }),
        });

        expect(resp.status).toBe(403);
        expect(getSession).toHaveBeenCalledWith(
          'tenant-a-session',
          expect.objectContaining({ tenant: { tenant_id: 'tenant-b', source: 'trusted_header' } })
        );
      },
      {
        multi_tenancy: {
          mode: 'required_from_auth',
          trusted_header: 'x-disco-tenant-id',
        },
      }
    );
  });

  it('re-authorizes a signed token Session binding on every stateless POST', async () => {
    initMcpTokens({
      db: testSqliteDb(),
      multiTenancy: resolveMultiTenancyConfig({}),
    });
    vi.spyOn(SessionRepository.prototype, 'exists').mockResolvedValue(true);

    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: 'session-signed',
        uid: 'user-1',
        tid: 'default',
        aud: MCP_TOKEN_AUDIENCE,
        iss: MCP_TOKEN_ISSUER,
        iat: now,
        exp: now + 60,
        jti: 'fresh-session-access-test',
      },
      'mcp-server-test-secret',
      { algorithm: 'HS256' }
    );
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    let accessible = true;
    const getSession = vi.fn(async (sessionId: string) => {
      if (sessionId !== 'session-signed') throw new Error('untrusted Session override used');
      if (!accessible) throw new Error('branch access revoked');
      return { session_id: 'session-signed' };
    });

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const call = () =>
          fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              Accept: 'application/json, text/event-stream',
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              // An internal token's signed Session binding wins over this
              // caller-controlled header.
              'X-Disco-Session-Id': 'attacker-session',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 150, method: 'tools/list' }),
          });

        const first = await call();
        expect(first.status).toBe(200);
        await first.text();

        accessible = false;
        const revoked = await call();
        expect(revoked.status).toBe(403);
        expect((await revoked.json()) as unknown).toMatchObject({
          error: { message: expect.stringMatching(/no longer accessible/) },
        });
        expect(getSession).toHaveBeenCalledTimes(2);
        expect(getSession).toHaveBeenNthCalledWith(1, 'session-signed', expect.any(Object));
        expect(getSession).toHaveBeenNthCalledWith(2, 'session-signed', expect.any(Object));
      }
    );
  });

  it('keeps authenticated user, tenant, and Disco session context isolated under concurrency', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async (userId: string, params: { tenant: { tenant_id: string } }) => ({
      user_id: userId,
      email: `${userId}@example.com`,
      role: 'member',
      tenant_id: params.tenant.tenant_id,
    }));
    const getSession = vi.fn(
      async (sessionId: string, params: { tenant: { tenant_id: string } }) => {
        const delayMs = Number(sessionId.slice(-1)) % 4;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!sessionId.startsWith(`${params.tenant.tenant_id}-`)) throw new Error('not found');
        return { session_id: sessionId };
      }
    );

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const expected = Array.from({ length: 16 }, (_, index) => ({
          tenantId: index % 2 === 0 ? 'tenant-a' : 'tenant-b',
          apiKey: index % 3 === 0 ? 'disco_sk_other' : 'disco_sk_valid',
          userId: index % 3 === 0 ? 'user-2' : 'user-1',
          sessionId: `${index % 2 === 0 ? 'tenant-a' : 'tenant-b'}-session-${index}`,
        }));

        const results = await Promise.all(
          expected.map(async ({ tenantId, apiKey, sessionId }, index) => {
            const resp = await fetch(`${baseUrl}/mcp`, {
              method: 'POST',
              headers: {
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
                'X-API-Key': apiKey,
                'X-Disco-Tenant-Id': tenantId,
                'X-Disco-Session-Id': sessionId,
                'Mcp-Session-Id': `ignored-legacy-${index}`,
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 200 + index,
                method: 'tools/call',
                params: { name: 'disco_users_get_current', arguments: {} },
              }),
            });
            const parsed = parseMcpResponse(await resp.text());
            return { status: resp.status, value: JSON.parse(parsed.result!.content![0].text) };
          })
        );

        results.forEach(({ status, value }, index) => {
          expect(status).toBe(200);
          expect(value).toMatchObject({
            user_id: expected[index].userId,
            tenant_id: expected[index].tenantId,
          });
        });
        expect(getSession).toHaveBeenCalledTimes(expected.length);
      },
      {
        multi_tenancy: {
          mode: 'required_from_auth',
          trusted_header: 'x-disco-tenant-id',
        },
      }
    );
  });
});
