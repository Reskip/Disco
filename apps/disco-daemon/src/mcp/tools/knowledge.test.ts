import type { KnowledgeEntryDetail, KnowledgeOwner } from '@disco/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../server';
import { knowledgeOwnerFromContext, registerKnowledgeTools } from './knowledge';

vi.mock('../server.js', () => ({
  textResult: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
}));

type Handler = (
  input: Record<string, unknown>
) => Promise<{ content: Array<{ type: string; text: string }> }>;
type Captured = {
  callback: Handler;
  schema: { parse: (input: unknown) => Record<string, unknown> };
};
const own: KnowledgeOwner = { tenantId: 'tenant-a', userId: 'user-a' };
const sibling: KnowledgeOwner = { tenantId: 'tenant-a', userId: 'user-b' };
const otherTenant: KnowledgeOwner = { tenantId: 'tenant-b', userId: 'user-a' };
const key = (owner: KnowledgeOwner, id: string) =>
  JSON.stringify([owner.tenantId, owner.userId, id]);

function fixture() {
  const records = new Map<string, KnowledgeEntryDetail>();
  const runtime = {
    observe: vi.fn(),
    assertWritable: vi.fn(async () => undefined),
    search: vi.fn(async (_owner: KnowledgeOwner, _input: unknown) => ({
      results: [],
      engine: 'local',
    })),
    library: {
      get: vi.fn(async (owner: KnowledgeOwner, id: string) => records.get(key(owner, id)) ?? null),
      upsertSource: vi.fn(async (_owner: KnowledgeOwner, input: unknown) => ({ entry: input })),
    },
    remove: vi.fn(async (owner: KnowledgeOwner, id: string) => records.delete(key(owner, id))),
  };
  const ctx = {
    userId: own.userId,
    authenticatedUser: { user_id: own.userId, tenant_id: own.tenantId, role: 'member' },
    app: { get: (name: string) => (name === 'knowledgeRuntime' ? runtime : undefined) },
    baseServiceParams: {
      authenticated: true,
      provider: 'mcp',
      tenant: { tenant_id: own.tenantId, source: 'auth_claim' },
      user: { user_id: own.userId, role: 'member' },
    },
  } as unknown as McpContext;
  const captured = new Map<string, Captured>();
  registerKnowledgeTools(
    {
      registerTool: (
        name: string,
        config: { inputSchema: Captured['schema'] },
        callback: Handler
      ) => captured.set(name, { schema: config.inputSchema, callback }),
    } as unknown as McpServer,
    ctx
  );
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = captured.get(name)!;
    const response = await tool.callback(tool.schema.parse(input));
    return JSON.parse(response.content[0].text);
  };
  return { records, runtime, ctx, call };
}

function record(markdown: string): KnowledgeEntryDetail {
  return {
    entry: {
      id: 'known-id',
      title: '资料',
      source: 'disco',
      sourceId: 'session-a',
      kind: 'conversation',
      humanEdited: false,
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
      relativePath: 'conversations/known-id.md',
      sizeBytes: markdown.length,
      indexStatus: 'indexed',
    },
    markdown,
    contentHash: 'hash',
  };
}

describe('authenticated knowledge MCP tools', () => {
  it('derives ownership from authenticated context and ignores owner fields in tool input', async () => {
    const { ctx, runtime, call } = fixture();
    expect(knowledgeOwnerFromContext(ctx)).toEqual(own);
    await call('disco_knowledge_search', {
      query: '历史',
      tenantId: 'tenant-b',
      userId: 'user-b',
      owner: sibling,
    });
    expect(runtime.observe).toHaveBeenCalledWith(own);
    expect(runtime.search).toHaveBeenCalledWith(own, { query: '历史' });
  });

  it.each(['tenant', 'user', 'userId', 'conflicting-user'])(
    'rejects missing or conflicting %s context before accessing the library',
    async (kind) => {
      const { ctx, runtime, call } = fixture();
      if (kind === 'tenant') delete ctx.baseServiceParams.tenant;
      if (kind === 'user') delete ctx.baseServiceParams.user;
      if (kind === 'userId') ctx.userId = '' as McpContext['userId'];
      if (kind === 'conflicting-user')
        ctx.baseServiceParams.user!.user_id = 'user-b' as McpContext['userId'];
      await expect(call('disco_knowledge_read', { id: 'known-id' })).rejects.toThrow('已认证');
      expect(runtime.observe).not.toHaveBeenCalled();
      expect(runtime.library.get).not.toHaveBeenCalled();
    }
  );

  it.each([sibling, otherTenant])(
    'cannot read or delete a known record owned by %j',
    async (owner) => {
      const { records, runtime, call } = fixture();
      records.set(key(owner, 'known-id'), record('other owner secret'));
      await expect(call('disco_knowledge_read', { id: 'known-id' })).rejects.toThrow('不存在');
      expect(await call('disco_knowledge_delete', { id: 'known-id', owner })).toEqual({
        deleted: false,
      });
      expect(records.get(key(owner, 'known-id'))?.markdown).toBe('other owner secret');
      expect(runtime.library.get).toHaveBeenCalledWith(own, 'known-id');
      expect(runtime.remove).toHaveBeenCalledWith(own, 'known-id');
    }
  );

  it.each(['unauthenticated', 'authenticated-user-mismatch', 'authenticated-tenant-mismatch'])(
    'rejects %s trusted identity contradictions',
    async (kind) => {
      const { ctx, runtime, call } = fixture();
      if (kind === 'unauthenticated') ctx.baseServiceParams.authenticated = false;
      if (kind === 'authenticated-user-mismatch')
        ctx.authenticatedUser.user_id = 'user-b' as McpContext['userId'];
      if (kind === 'authenticated-tenant-mismatch') ctx.authenticatedUser.tenant_id = 'tenant-b';
      await expect(call('disco_knowledge_search', { query: 'private' })).rejects.toThrow('已认证');
      expect(runtime.search).not.toHaveBeenCalled();
    }
  );

  it('reads the entire long source through continuations without truncation or repeated characters', async () => {
    const { records, call } = fixture();
    const markdown = '中文🙂\n逐页原始内容\n'.repeat(70_000);
    records.set(key(own, 'known-id'), record(markdown));
    let offset: number | null = 0;
    const parts: string[] = [];
    while (offset !== null) {
      const page = await call('disco_knowledge_read', { id: 'known-id', offset, limit: 30_000 });
      expect(page.totalCharacters).toBe(markdown.length);
      expect(page.markdown.length).toBeLessThanOrEqual(30_000);
      expect(page.offset).toBe(offset);
      parts.push(page.markdown);
      offset = page.nextOffset;
    }
    expect(parts.join('')).toBe(markdown);
    expect(Buffer.byteLength(parts.join(''))).toBeGreaterThan(800_000);
  });

  it('scopes saved notes to the authenticated owner', async () => {
    const { runtime, call } = fixture();
    await call('disco_knowledge_save', {
      title: '新知识',
      markdown: '有来源的事实',
      owner: otherTenant,
    });
    expect(runtime.library.upsertSource).toHaveBeenCalledWith(
      own,
      expect.objectContaining({
        source: 'manual',
        kind: 'note',
        title: '新知识',
        markdown: '有来源的事实',
      })
    );
  });
});
