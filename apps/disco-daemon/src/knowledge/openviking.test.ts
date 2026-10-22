import { describe, expect, it, vi } from 'vitest';
import {
  OpenVikingClient,
  OpenVikingError,
  openVikingAccountId,
  provisionOpenVikingOwner,
  splitOpenVikingContent,
} from './openviking';

const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const secondOwner = { tenantId: 'tenant-a', userId: 'user-b' };
function identity(value = owner) {
  return {
    owner: value,
    accountId: openVikingAccountId(value),
    userId: 'library' as const,
    role: 'user' as const,
    apiKey: `key-${value.userId}`,
  };
}
function ok(result: unknown) {
  return new Response(JSON.stringify({ status: 'ok', result }), { status: 200 });
}
function setup(response: unknown = { vector_status: 'complete' }) {
  const responder = vi.fn<() => Response>().mockImplementation(() => ok(response));
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === '/health') {
      const scope =
        (init?.headers as Record<string, string> | undefined)?.['X-API-Key'] === 'key-user-b'
          ? secondOwner
          : owner;
      return new Response(
        JSON.stringify({
          status: 'ok',
          healthy: true,
          auth_mode: 'api_key',
          account_id: openVikingAccountId(scope),
          user_id: 'library',
          role: 'user',
        })
      );
    }
    if (target.pathname === '/api/v1/fs/ls') {
      return ok([
        { uri: `${target.searchParams.get('uri')}/content.md`, name: 'content.md', isDir: false },
      ]);
    }
    return responder();
  });
  const client = new OpenVikingClient({
    baseUrl: 'http://127.0.0.1:1933',
    resolveIdentity: identity,
    fetch: fetcher,
  });
  return { client, fetcher, responder };
}

describe('OpenViking derived index isolation', () => {
  it('uses distinct account names and ordinary user keys for each authenticated owner', async () => {
    const { client, fetcher } = setup();
    await client.index(owner, { id: 'entry-1', content: '# 原件\n完整内容' });
    await client.index(secondOwner, { id: 'entry-1', content: '# 另一个用户' });
    const writes = fetcher.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === '/api/v1/content/batch-write'
    );
    const first = writes[0][1]!;
    const second = writes[1][1]!;
    expect(first.headers).toEqual({
      'X-API-Key': 'key-user-a',
      'Content-Type': 'application/json',
    });
    expect(second.headers).toEqual({
      'X-API-Key': 'key-user-b',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(first.body as string)).toMatchObject({
      operations: [{ content: '# 原件\n完整内容', mode: 'replace' }],
      processing_mode: 'vectors_only',
      wait: true,
    });
    expect(JSON.parse(first.body as string).operations[0].uri).not.toBe(
      JSON.parse(second.body as string).operations[0].uri
    );
    expect(first.redirect).toBe('error');
  });

  it('rejects missing, cross-owner or elevated credentials before sending content', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const resolveIdentity of [
      () => undefined,
      () => identity(secondOwner),
      () => ({ ...identity(), role: 'admin' as 'user' }),
    ]) {
      const client = new OpenVikingClient({
        baseUrl: 'http://localhost:1933',
        resolveIdentity,
        fetch: fetcher,
      });
      await expect(client.index(owner, { id: 'id', content: 'private' })).rejects.toBeInstanceOf(
        OpenVikingError
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects non-local and credential-bearing base URLs', () => {
    for (const baseUrl of [
      'https://example.com',
      'http://localhost.evil',
      'http://key@127.0.0.1:1933',
      'file:///tmp/a',
      'http://localhost:1933/?token=a',
    ]) {
      expect(() => new OpenVikingClient({ baseUrl, resolveIdentity: identity })).toThrow();
    }
  });

  it('verifies the real server identity and rejects dev mode or a misbound key', async () => {
    for (const health of [
      {
        auth_mode: 'dev',
        account_id: openVikingAccountId(owner),
        user_id: 'library',
        role: 'root',
      },
      {
        auth_mode: 'api_key',
        account_id: openVikingAccountId(secondOwner),
        user_id: 'library',
        role: 'user',
      },
    ]) {
      const { client, fetcher } = setup();
      fetcher.mockResolvedValue(new Response(JSON.stringify({ status: 'ok', ...health })));
      await expect(client.index(owner, { id: 'doc', content: 'private' })).rejects.toMatchObject({
        code: 'IDENTITY_MISMATCH',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe('/health');
    }
  });

  it('rejects path traversal IDs without fetching', async () => {
    const { client, fetcher } = setup();
    for (const id of ['../sibling', 'a/b', 'a\\b', '%2e%2e', '.abstract', '']) {
      await expect(client.delete(owner, id)).rejects.toThrow('资料编号无效');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('enforces requested scope again when parsing provider results', async () => {
    const { client, fetcher, responder } = setup();
    const wanted = client.documentUri(owner, 'wanted');
    responder.mockReturnValue(
      ok({
        resources: [
          { uri: client.documentUri(secondOwner, 'other'), abstract: 'private' },
          { uri: client.documentUri(owner, 'excluded'), abstract: 'outside selected scope' },
          {
            uri: wanted.replace('wanted/content.md', '../leaked/content.md'),
            abstract: 'traversal',
          },
          { uri: wanted, abstract: '摘要', score: 1.8 },
          { uri: wanted, abstract: 'duplicate' },
        ],
      })
    );
    await expect(client.search(owner, { query: '资料', documentIds: ['wanted'] })).resolves.toEqual(
      [{ id: 'wanted', uri: wanted, excerpt: '摘要', score: 1.8 }]
    );
    const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
    expect(body).toMatchObject({
      target_uri: [wanted.replace('/content.md', '')],
      level: 2,
      read_content: true,
    });
  });

  it('does not broaden an explicit empty selection', async () => {
    const { client, fetcher } = setup();
    await expect(client.search(owner, { query: '资料', documentIds: [] })).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('updates an existing directory and clears obsolete chunks without triggering the provider delete summarizer', async () => {
    const { client, fetcher } = setup();
    const original = fetcher.getMockImplementation()!;
    const root = client.documentUri(owner, 'doc').replace('/content.md', '');
    fetcher.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/v1/fs/mkdir')
        return new Response(JSON.stringify({ status: 'error', error: { code: 'CONFLICT' } }), {
          status: 409,
        });
      if (target.pathname === '/api/v1/fs/ls')
        return ok([
          { uri: `${root}/content.md`, isDir: false },
          { uri: `${root}/part-0000000002.md`, isDir: false },
        ]);
      return original(url, init);
    });
    await expect(client.index(owner, { id: 'doc', content: 'shorter' })).resolves.toEqual({
      uri: `${root}/content.md`,
    });
    const removals = fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(removals).toHaveLength(0);
    const write = fetcher.mock.calls.find(
      ([url]) => new URL(String(url)).pathname === '/api/v1/content/batch-write'
    );
    expect(JSON.parse(write![1]!.body as string)).toMatchObject({
      processing_mode: 'vectors_only',
      operations: [
        { content: 'shorter' },
        {
          uri: `${root}/part-0000000002.md`,
          content: '',
          tags: ['disco_entry=doc', 'disco_index=inactive'],
        },
      ],
    });
  });

  it('keeps indexing pending after partial embedding and sanitizes upstream failures', async () => {
    const { client, responder } = setup({ vector_status: 'queued' });
    await expect(client.index(owner, { id: 'doc', content: 'source' })).rejects.toMatchObject({
      code: 'INDEX_NOT_READY',
    });
    responder.mockReturnValue(
      new Response(
        JSON.stringify({
          status: 'error',
          error: { code: 'UNAVAILABLE', message: 'secret key-private full content' },
        }),
        { status: 500 }
      )
    );
    const failure = await client.read(owner, 'doc').catch((error) => error);
    expect(failure).toMatchObject({ code: 'UNAVAILABLE', httpStatus: 500 });
    expect(String(failure)).not.toMatch(/secret|key-private|full content/);
  });

  it('reads complete content and deletes only the selected derived file', async () => {
    const { client, fetcher, responder } = setup('# 完整资料');
    await expect(client.read(owner, 'doc')).resolves.toBe('# 完整资料');
    responder.mockReturnValue(ok({}));
    await client.delete(owner, 'doc');
    const [url, init] = fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')!;
    expect(new URL(String(url)).searchParams.get('uri')).toBe(
      client.documentUri(owner, 'doc').replace('/content.md', '')
    );
    expect(new URL(String(url)).searchParams.get('recursive')).toBe('true');
    expect(init?.method).toBe('DELETE');
  });

  it('keeps administrative credentials on provisioning endpoints and recovers interrupted creation', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: JSON.parse(init!.body as string) });
      expect(init?.headers).toMatchObject({ 'X-API-Key': 'test-root-secret' });
      if (!path.endsWith('/key'))
        return new Response(
          JSON.stringify({ status: 'error', error: { code: 'ALREADY_EXISTS' } }),
          { status: 409 }
        );
      return ok({ user_key: 'ordinary-user-key' });
    });
    const result = await provisionOpenVikingOwner(
      'http://localhost:1933',
      'test-root-secret',
      owner,
      fetcher
    );
    expect(result).toEqual({ ...identity(), apiKey: 'ordinary-user-key' });
    expect(calls.every((call) => call.path.startsWith('/api/v1/admin/accounts'))).toBe(true);
    expect(calls[1].body).toMatchObject({ user_id: 'library', role: 'user' });
    expect(calls[1].body.seed).toBe(calls[2].body.seed);
    expect(calls[1].body.seed).not.toBe('test-root-secret');
  });

  it('confirms asynchronous deletion completion instead of treating an accepted task as deleted', async () => {
    const { client, responder, fetcher } = setup();
    responder
      .mockReturnValueOnce(ok({ task_id: 'cleanup-task' }))
      .mockReturnValueOnce(ok({ status: 'completed' }));
    await client.delete(owner, 'doc');
    expect(
      fetcher.mock.calls.some(
        ([url]) => new URL(String(url)).pathname === '/api/v1/tasks/cleanup-task'
      )
    ).toBe(true);
    responder
      .mockReturnValueOnce(ok({ task_id: 'cleanup-task' }))
      .mockReturnValueOnce(ok({ status: 'failed', error: 'private provider diagnostic' }));
    await expect(client.delete(owner, 'doc')).rejects.toMatchObject({ code: 'TASK_FAILED' });
  });

  it('requires a separate summary provider and never starts the provider per-chunk semantic queue', async () => {
    const { client, fetcher, responder } = setup();
    responder.mockReturnValueOnce(ok('# archived source'));
    await expect(client.summarize(owner, 'doc')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('accepts the provider idempotent no-op when every vector is already current', async () => {
    const { client } = setup({ vector_status: 'skipped' });
    await expect(
      client.index(owner, { id: 'doc', content: 'already indexed' })
    ).resolves.toHaveProperty('uri');
  });

  it('indexes every character of long multilingual archives in bounded chunks', async () => {
    const source = `# 完整会话\n\n${'中文 English 🙂\n'.repeat(1600)}\nTAIL_ONLY_9281`;
    const chunks = splitOpenVikingContent(source);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 3000)).toBe(true);
    expect(chunks.join('')).toBe(source);
    const { client, fetcher } = setup();
    await client.index(owner, { id: 'long', content: source });
    const call = fetcher.mock.calls.find(
      ([url]) => new URL(String(url)).pathname === '/api/v1/content/batch-write'
    );
    const writes = JSON.parse(call![1]!.body as string).operations;
    expect(writes.map((part: { content: string }) => part.content).join('')).toBe(source);
    expect(writes.at(-1).content).toContain('TAIL_ONLY_9281');
  });

  it('reads all paginated parts in order and accepts a selected entry tail hit', async () => {
    const { client, fetcher, responder } = setup();
    const original = fetcher.getMockImplementation()!;
    const root = client.documentUri(owner, 'doc').replace('/content.md', '');
    fetcher.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/v1/fs/ls') {
        const second = target.searchParams.get('offset') === '1';
        return new Response(
          JSON.stringify({
            status: 'ok',
            result: [
              { uri: `${root}/${second ? 'part-0000000002.md' : 'content.md'}`, isDir: false },
            ],
            has_more: !second,
          })
        );
      }
      if (target.pathname === '/api/v1/content/read')
        return ok(target.searchParams.get('uri')?.endsWith('content.md') ? '起始\n' : '末尾');
      return original(url, init);
    });
    await expect(client.read(owner, 'doc')).resolves.toBe('起始\n末尾');
    responder.mockReturnValue(
      ok({
        resources: [{ uri: `${root}/part-0000000002.md`, content: '末尾', abstract: '旧摘要' }],
      })
    );
    await expect(client.search(owner, { query: '末尾', documentIds: ['doc'] })).resolves.toEqual([
      { id: 'doc', uri: `${root}/part-0000000002.md`, excerpt: '末尾' },
    ]);
  });
});
