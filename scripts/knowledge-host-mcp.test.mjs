import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createKnowledgeHostClient, KNOWLEDGE_TOOLS } from './knowledge-host-mcp.mjs';

test('host bridge uses a scoped bearer token and does not accept remote services', async () => {
  for (const baseUrl of [
    'https://example.com',
    'http://localhost.example.com',
    'http://token@localhost',
    'http://localhost/?token=foo',
  ]) {
    assert.throws(() => createKnowledgeHostClient({ baseUrl, token: 'secret' }));
  }
  let call;
  const client = createKnowledgeHostClient(
    { baseUrl: 'http://127.0.0.1:3030', token: 'scoped-secret' },
    async (...args) => {
      call = args;
      return new Response(JSON.stringify({ results: [], engine: 'local' }));
    }
  );
  await client.call('disco_knowledge_search', { query: '历史', entryIds: ['doc-1'] });
  assert.equal(call[0].pathname, '/knowledge/search');
  assert.equal(call[1].headers.Authorization, 'Bearer scoped-secret');
  assert.equal(call[1].redirect, 'error');
  assert.deepEqual(JSON.parse(call[1].body), { query: '历史', entryIds: ['doc-1'], limit: 8 });
});

test('read uses bounded server pages, preserves sources, and pins subsequent pages', async () => {
  const original = `# 资料\n${'中文内容🙂与原始换行\n'.repeat(5000)}`;
  const sources = [{ id: 'source-1', title: '原始来源', available: true }];
  const responseSizes = [];
  let calls = 0;
  const client = createKnowledgeHostClient({ token: 'secret' }, async (url) => {
    assert.equal(url.pathname, '/knowledge/entries/doc');
    assert.equal(url.searchParams.get('limit'), '7000');
    assert.equal(url.searchParams.get('contentHash'), calls++ ? 'version-1' : null);
    const offset = Number(url.searchParams.get('offset'));
    let end = Math.min(offset + 7000, original.length);
    if (/[\uDC00-\uDFFF]/.test(original[end] ?? '')) end++;
    const body = JSON.stringify({
      entry: { id: 'doc', updatedAt: 'v1' },
      markdown: original.slice(offset, end),
      contentHash: 'version-1',
      sources,
      page: {
        offset,
        nextOffset: end < original.length ? end : null,
        totalChars: original.length,
        hasMore: end < original.length,
      },
    });
    responseSizes.push(Buffer.byteLength(body));
    return new Response(body);
  });
  let offset = 0;
  let assembled = '';
  let contentHash;
  while (true) {
    const result = await client.call('disco_knowledge_read', {
      id: 'doc',
      offset,
      limit: 7000,
      contentHash,
    });
    assert.equal(result.contentHash, 'version-1');
    assert.deepEqual(result.sources, sources);
    assert.equal(result.totalCharacters, original.length);
    assert.equal(result.markdown.isWellFormed(), true);
    contentHash = result.contentHash;
    assembled += result.markdown;
    if (!result.hasMore) {
      assert.equal(result.nextOffset, null);
      break;
    }
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  }
  assert.equal(assembled, original);
  assert.ok(responseSizes.length > 2);
  assert.ok(responseSizes.every((size) => size < 24000));
});

test('read rejects stale content, unpaged responses and invalid requests', async () => {
  const client = createKnowledgeHostClient({ token: 'secret' }, async (url) => {
    assert.equal(url.searchParams.get('contentHash'), 'old-version');
    return new Response('private changed content', { status: 409 });
  });
  await assert.rejects(
    client.call('disco_knowledge_read', { id: 'doc', offset: 300, contentHash: 'old-version' }),
    /资料已被修改/
  );
  let calls = 0;
  const legacy = createKnowledgeHostClient({ token: 'secret' }, async () => {
    calls++;
    return new Response(JSON.stringify({ entry: { id: 'doc' }, markdown: 'whole archive' }));
  });
  await assert.rejects(legacy.call('disco_knowledge_read', { id: 'doc', limit: 3 }), /分页格式/);
  await assert.rejects(legacy.call('disco_knowledge_read', { id: 'doc', offset: -1 }), /分页参数/);
  await assert.rejects(
    legacy.call('disco_knowledge_read', { id: 'doc', contentHash: '' }),
    /内容版本/
  );
  assert.equal(calls, 1);
});

test('read preserves server-adjusted UTF-16 positions and handles the end of an archive', async () => {
  let page = { offset: 1, nextOffset: 3, totalChars: 4, hasMore: true };
  let markdown = '🙂';
  const client = createKnowledgeHostClient(
    { token: 'secret' },
    async () =>
      new Response(JSON.stringify({ entry: { id: 'doc' }, contentHash: 'v1', markdown, page }))
  );
  const emoji = await client.call('disco_knowledge_read', { id: 'doc', offset: 2, limit: 1 });
  assert.equal(emoji.offset, 1);
  assert.equal(emoji.markdown, '🙂');
  assert.equal(emoji.nextOffset, 3);
  page = { offset: 4, nextOffset: null, totalChars: 4, hasMore: false };
  markdown = '';
  const end = await client.call('disco_knowledge_read', { id: 'doc', offset: 99 });
  assert.equal(end.offset, 4);
  assert.equal(end.hasMore, false);
  assert.equal(end.nextOffset, null);
});

test('update requires a revision and identifiers cannot escape API paths', async () => {
  let called = false;
  const client = createKnowledgeHostClient({ token: 'secret' }, async () => {
    called = true;
    return new Response('{}');
  });
  await assert.rejects(
    client.call('disco_knowledge_update', { id: 'doc', markdown: 'new' }),
    /原修改时间/
  );
  await assert.rejects(client.call('disco_knowledge_delete', { id: '../users' }), /资料编号/);
  assert.equal(called, false);
});

test('provider errors never echo credentials or full server error messages', async () => {
  const client = createKnowledgeHostClient(
    { token: 'secret-token' },
    async () => new Response('secret-token private archive', { status: 500 })
  );
  await assert.rejects(
    client.call('disco_knowledge_read', { id: 'doc' }),
    (error) => !String(error).includes('secret-token') && !String(error).includes('private archive')
  );
  assert.equal(
    KNOWLEDGE_TOOLS.find((tool) => tool.name === 'disco_knowledge_delete').annotations
      .destructiveHint,
    true
  );
});

test('the actual stdio process initializes and advertises the six scoped tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'disco-knowledge-mcp-'));
  const configFile = join(directory, 'host.json');
  await writeFile(configFile, JSON.stringify({ token: 'synthetic-unused-token' }));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./knowledge-host-mcp.mjs', import.meta.url))],
    {
      env: { ...process.env, DISCO_KNOWLEDGE_HOST_CONFIG: configFile },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const result = await new Promise((resolve, reject) => {
      let pending = '';
      const timer = setTimeout(
        () => reject(new Error(`MCP initialization timeout: ${stderr}`)),
        10000
      );
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        if (code) {
          clearTimeout(timer);
          reject(new Error(stderr));
        }
      });
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const message = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (message.id === 1) {
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
            );
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`
            );
          }
          if (message.id === 2) {
            clearTimeout(timer);
            resolve(message);
          }
        }
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'disco-test', version: '1' },
          },
        })}\n`
      );
    });
    assert.equal(result.result.tools.length, 6);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
