import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OpenVikingClient,
  OpenVikingError,
  type OpenVikingOptions,
  openVikingAccountId,
  provisionOpenVikingOwner,
  splitOpenVikingContent,
} from './openviking';

const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const secondOwner = { tenantId: 'tenant-a', userId: 'user-b' };
async function removeFixture(base: string): Promise<void> {
  if (!resolve(base).startsWith(resolve(tmpdir()) + sep))
    throw new Error('Unexpected fixture root');
  await rm(base, { recursive: true, force: true });
}
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
function setup(
  response: unknown = { vector_status: 'complete' },
  summary?: OpenVikingOptions['summary']
) {
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
    summary,
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
      wait: false,
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

  it('excludes a long conversation after its chunks crowd the first page to retrieve other documents', async () => {
    const { client, fetcher, responder } = setup();
    const crowded = client.documentUri(owner, 'crowded');
    responder
      .mockReturnValueOnce(
        ok({
          resources: Array.from({ length: 40 }, (_, index) => ({
            uri: crowded.replace('content.md', `part-${String(index).padStart(10, '0')}.md`),
            content: `原文片段 ${index}`,
            score: 1,
          })),
        })
      )
      .mockReturnValueOnce(
        ok({
          resources: [
            { uri: client.documentUri(owner, 'second'), content: '另一份相关原文', score: 0.8 },
            {
              uri: client.documentUri(secondOwner, 'private'),
              content: '其它用户的原文',
              score: 0.9,
            },
          ],
        })
      );
    const result = await client.search(owner, { query: '相关原文', limit: 2 });
    expect(result.map((hit) => hit.id)).toEqual(['crowded', 'second']);
    const searches = fetcher.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === '/api/v1/search/find'
    );
    expect(searches).toHaveLength(2);
    expect(JSON.parse(searches[1][1]!.body as string)).toMatchObject({
      filter: { op: 'must_not', field: 'search_tags', conds: ['disco_entry=crowded'] },
      tags: ['disco_index=active'],
    });
  });

  it('stops if a provider ignores diversity exclusions instead of looping over the same chunks', async () => {
    const { client, responder } = setup();
    responder.mockReturnValue(
      ok({
        resources: Array.from({ length: 40 }, () => ({
          uri: client.documentUri(owner, 'only'),
          content: '同一条原文',
        })),
      })
    );
    expect(await client.search(owner, { query: '原文', limit: 3 })).toHaveLength(1);
    expect(responder).toHaveBeenCalledTimes(2);
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
    const source = `# 完整会话\n\n${'中文 English 🙂\n'.repeat(4000)}\nTAIL_ONLY_9281`;
    const chunks = splitOpenVikingContent(source);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 3000)).toBe(true);
    expect(chunks.join('')).toBe(source);
    const { client, fetcher } = setup();
    await client.index(owner, { id: 'long', content: source });
    const calls = fetcher.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === '/api/v1/content/batch-write'
    );
    expect(calls.length).toBeGreaterThan(1);
    const batches = calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(batches.every((batch) => batch.operations.length <= 16 && batch.wait === false)).toBe(
      true
    );
    const writes = batches.flatMap((batch) => batch.operations);
    expect(writes.map((part: { content: string }) => part.content).join('')).toBe(source);
    expect(writes.at(-1).content).toContain('TAIL_ONLY_9281');
  });

  it('waits for each accepted vector task before committing the next batch', async () => {
    const { client, fetcher } = setup();
    const original = fetcher.getMockImplementation()!;
    let writes = 0;
    let completed = 0;
    fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/content/batch-write') {
        expect(writes).toBe(completed);
        writes += 1;
        return ok({ task_id: `task-${writes}`, vector_status: 'queued' });
      }
      if (path.startsWith('/api/v1/tasks/')) {
        completed += 1;
        return ok({ status: 'completed', result: { vector_status: 'complete' } });
      }
      return original(url, init);
    });
    await client.index(owner, { id: 'long', content: 'abc'.repeat(25000) });
    expect(writes).toBe(2);
    expect(completed).toBe(2);
  });

  it('resumes an accepted batch after a poll failure without resubmitting its contents', async () => {
    const { client, fetcher } = setup();
    const original = fetcher.getMockImplementation()!;
    let writes = 0;
    let polls = 0;
    fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/content/batch-write') {
        writes += 1;
        return ok({ task_id: 'accepted-task', vector_status: 'queued' });
      }
      if (path === '/api/v1/tasks/accepted-task') {
        polls += 1;
        if (polls === 1) throw new Error('private connection diagnostic');
        return ok({ status: 'completed', result: { vector_status: 'complete' } });
      }
      return original(url, init);
    });
    await expect(client.index(owner, { id: 'doc', content: '原文' })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await expect(client.index(owner, { id: 'doc', content: '原文' })).resolves.toHaveProperty(
      'uri'
    );
    expect(writes).toBe(1);
  });

  it('reports a failed asynchronous embedding even when the file write was accepted', async () => {
    const { client, fetcher } = setup();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/content/batch-write') return ok({ task_id: 'failed-task' });
      if (path === '/api/v1/tasks/failed-task')
        return ok({ status: 'failed', error: 'private diagnostic' });
      return original(url, init);
    });
    await expect(client.index(owner, { id: 'doc', content: '原文' })).rejects.toMatchObject({
      code: 'TASK_FAILED',
      message: '语义索引计算失败，将自动重试',
    });
  });

  it('allows direct summary requests without an index read', async () => {
    const { client, fetcher } = setup();
    await expect(
      client.summarizeContent(owner, { id: 'manual', content: '来源正文' })
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('exposes safe summary failure categories and minimum retry intervals from the helper', async () => {
    const base = await mkdtemp(join(tmpdir(), 'disco-summary-failure-'));
    const script = join(base, 'summary.cjs');
    const logger = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [code, delay] of [
        ['SUMMARY_FORMAT_INVALID', 300_000],
        ['SUMMARY_INCOMPLETE', 300_000],
        ['SUMMARY_AUTH_REQUIRED', 3_600_000],
        ['SUMMARY_RATE_LIMITED', 1_800_000],
        ['SUMMARY_NETWORK', 30_000],
      ]) {
        await writeFile(
          script,
          `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(JSON.stringify({ error: code, diagnostic: { phase: 'parse', exceptionType: 'SummaryFailure', responseCharacters: 30, jsonPosition: 29, token: 'NEVER_LOG_SECRET', message: 'NEVER_LOG_SECRET' } }))});process.exitCode=1;});`
        );
        const { client } = setup(undefined, {
          pythonExecutable: process.execPath,
          scriptPath: script,
          configPath: join(base, 'config.json'),
        });
        await expect(
          client.summarizeContent(owner, { id: 'synthetic', content: 'synthetic' })
        ).rejects.toMatchObject({ code, retryAfterMs: delay });
      }
      expect(JSON.stringify(logger.mock.calls)).not.toContain('NEVER_LOG_SECRET');
      expect(logger.mock.calls[0][1]).toEqual({
        code: 'SUMMARY_FORMAT_INVALID',
        phase: 'parse',
        exceptionType: 'SummaryFailure',
        responseCharacters: 30,
        jsonPosition: 29,
      });
      await writeFile(
        script,
        `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('{"error":"SECRET_PROVIDER_TEXT"}');process.exitCode=1;});`
      );
      const { client } = setup(undefined, {
        pythonExecutable: process.execPath,
        scriptPath: script,
        configPath: join(base, 'config.json'),
      });
      await expect(
        client.summarizeContent(owner, { id: 'synthetic', content: 'synthetic' })
      ).rejects.toMatchObject({
        code: 'SUMMARY_FAILED',
        message: '资料摘要未生成，原文与索引保持可用',
      });
    } finally {
      logger.mockRestore();
      await removeFixture(base);
    }
  });

  it('preserves explicit archive-only decisions but never coerces string values', async () => {
    const base = await mkdtemp(join(tmpdir(), 'disco-summary-disposition-'));
    const script = join(base, 'summary.cjs');
    try {
      for (const archiveOnly of [true, 'true']) {
        await writeFile(
          script,
          `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify({ abstract: '连通测试', overview: '原始记录已保留，无额外知识。', archiveOnly, reason: '仅连通测试' }))}));`
        );
        const { client } = setup(undefined, {
          pythonExecutable: process.execPath,
          scriptPath: script,
          configPath: join(base, 'config.json'),
        });
        const result = await client.summarizeContent(owner, { id: 'synthetic', content: '测试' });
        expect(result.archiveOnly).toBe(archiveOnly === true ? true : undefined);
        expect(result.overview).toBe('原始记录已保留，无额外知识。');
      }
    } finally {
      await removeFixture(base);
    }
  });

  it('passes owner-scoped typed sources and explicit synthesis intent without extra object fields', async () => {
    const base = await mkdtemp(join(tmpdir(), 'disco-summary-sources-'));
    const script = join(base, 'summary.cjs');
    try {
      await writeFile(
        script,
        `let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>body+=chunk);process.stdin.on('end',()=>{const input=JSON.parse(body);process.stdout.write(JSON.stringify({abstract:'本地概览',overview:JSON.stringify(input),summaryMode:'structured_overview'}));});`
      );
      const { client, fetcher } = setup(undefined, {
        pythonExecutable: process.execPath,
        scriptPath: script,
        configPath: join(base, 'config.json'),
      });
      const source = {
        id: 'source-a',
        title: '数据.json',
        kind: 'document' as const,
        format: 'json',
        markdown: '[{"count":1}]',
        privateField: 'DO_NOT_FORWARD',
      };
      const result = await client.summarizeContent(owner, {
        id: 'synthetic',
        content: 'legacy-compatible',
        sources: [source],
        forceSynthesis: true,
      });
      expect(result.summaryMode).toBe('structured_overview');
      expect(JSON.parse(result.overview)).toMatchObject({
        scope: openVikingAccountId(owner),
        content: 'legacy-compatible',
        forceSynthesis: true,
        sources: [
          {
            id: 'source-a',
            title: '数据.json',
            kind: 'document',
            format: 'json',
            markdown: '[{"count":1}]',
          },
        ],
      });
      expect(result.overview).not.toContain('DO_NOT_FORWARD');
      expect(fetcher).not.toHaveBeenCalled();
      await expect(
        client.summarizeContent(owner, {
          id: 'synthetic',
          content: 'legacy-compatible',
          sources: [{ ...source, id: '../another-owner' }],
        })
      ).rejects.toMatchObject({ code: 'INVALID_ENTRY_ID' });
      await expect(
        client.summarizeContent(owner, {
          id: 'synthetic',
          content: 'legacy-compatible',
          sources: [],
        })
      ).rejects.toMatchObject({ code: 'SUMMARY_CONFIGURATION' });
    } finally {
      await removeFixture(base);
    }
  });

  it('deletes only the selected derived summary cache and prevents its recreation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'disco-kb-provider-'));
    try {
      const parent = join(base, 'summary-work', openVikingAccountId(owner));
      await mkdir(join(parent, 'doc'), { recursive: true });
      await mkdir(join(parent, 'keep'), { recursive: true });
      await writeFile(join(parent, 'doc', 'summary.json'), 'synthetic derived cache');
      await writeFile(join(parent, 'keep', 'summary.json'), 'other entry');
      const { client } = setup(undefined, {
        pythonExecutable: process.execPath,
        scriptPath: join(base, 'helper.mjs'),
        configPath: join(base, 'ov.conf'),
      });
      await client.delete(owner, 'doc');
      await expect(access(join(parent, 'doc'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(parent, '.deleted', 'doc'))).resolves.toBeUndefined();
      await expect(readFile(join(parent, 'keep', 'summary.json'), 'utf8')).resolves.toBe(
        'other entry'
      );
    } finally {
      await removeFixture(base);
    }
  });

  it('does not let a bad derived cache hide provider failure or make successful deletion fail', async () => {
    const base = await mkdtemp(join(tmpdir(), 'disco-kb-provider-'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const parent = join(base, 'summary-work', openVikingAccountId(owner));
      await mkdir(parent, { recursive: true });
      // An unexpected file where a cache directory belongs is preserved safely.
      await writeFile(join(parent, 'doc'), 'unexpected file');
      const { client, responder } = setup(undefined, {
        pythonExecutable: process.execPath,
        scriptPath: join(base, 'helper.mjs'),
        configPath: join(base, 'ov.conf'),
      });
      responder.mockReturnValueOnce(
        new Response(JSON.stringify({ status: 'error', error: { code: 'UNAVAILABLE' } }), {
          status: 503,
        })
      );
      await expect(client.delete(owner, 'doc')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(client.delete(owner, 'doc')).resolves.toBeUndefined();
      await expect(readFile(join(parent, 'doc'), 'utf8')).resolves.toBe('unexpected file');
      expect(warning).toHaveBeenCalledWith('[knowledge] 已删除资料的摘要临时缓存尚未清理');
    } finally {
      warning.mockRestore();
      await removeFixture(base);
    }
  });

  it('cancels an in-flight request promptly without poisoning later worker passes', async () => {
    const { client, fetcher } = setup();
    const original = fetcher.getMockImplementation()!;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetcher.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
          started();
        })
    );
    const pending = client.index(owner, { id: 'doc', content: '原文' });
    const check = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await ready;
    client.cancelPending();
    await check;
    fetcher.mockImplementation(original);
    await expect(client.index(owner, { id: 'doc', content: '原文' })).resolves.toHaveProperty(
      'uri'
    );
  });

  it('retries provider path lock conflicts without leaking its diagnostic', async () => {
    const { client, fetcher } = setup();
    const original = fetcher.getMockImplementation()!;
    let writes = 0;
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === '/api/v1/content/batch-write' && writes++ === 0)
        return new Response(
          JSON.stringify({
            status: 'error',
            error: {
              code: 'CONFLICT',
              message: 'private diagnostic',
              details: { conflict_type: 'path_busy', retryable: true },
            },
          }),
          { status: 409 }
        );
      return original(url, init);
    });
    await expect(client.index(owner, { id: 'doc', content: '原文' })).resolves.toHaveProperty(
      'uri'
    );
    expect(writes).toBe(2);
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
