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

test('read pagination reconstructs the whole archived document', async () => {
  const original = `# 资料\n${'中文内容与原始换行\n'.repeat(5000)}`;
  const client = createKnowledgeHostClient(
    { token: 'secret' },
    async () =>
      new Response(JSON.stringify({ entry: { id: 'doc', updatedAt: 'v1' }, markdown: original }))
  );
  let offset = 0;
  let assembled = '';
  while (true) {
    const result = await client.call('disco_knowledge_read', { id: 'doc', offset, limit: 7000 });
    assembled += result.markdown;
    if (!result.hasMore) break;
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  }
  assert.equal(assembled, original);
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
