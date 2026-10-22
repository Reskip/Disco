import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  createDatabaseAsync,
  runMigrations,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@disco/core/db';
import type { Application } from '@disco/core/feathers';
import type {
  AuthenticatedParams,
  KnowledgeEntryDetail,
  KnowledgeOwner,
  KnowledgeSourceInput,
  User,
} from '@disco/core/types';
import express, { type Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerKnowledgeRoutes } from './routes';
import type { KnowledgeRuntime } from './runtime';

// Decode the real ZIP central directory, including the ZIP64 trailer emitted by
// the production route. No external unzip executable or extra test dependency.
function unzipArchive(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  let cursor = bytes.readUInt32LE(end + 16);
  if (cursor === 0xffffffff) {
    const zip64 = Number(bytes.readBigUInt64LE(end - 12));
    cursor = Number(bytes.readBigUInt64LE(zip64 + 48));
  }
  const files = new Map<string, Buffer>();
  while (bytes.readUInt32LE(cursor) === 0x02014b50) {
    const method = bytes.readUInt16LE(cursor + 10);
    let compressedSize = bytes.readUInt32LE(cursor + 20);
    const plainSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    let localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    let extra = cursor + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra < extraEnd) {
      const type = bytes.readUInt16LE(extra);
      const size = bytes.readUInt16LE(extra + 2);
      if (type === 1) {
        let field = extra + 4 + (plainSize === 0xffffffff ? 8 : 0);
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(bytes.readBigUInt64LE(field));
          field += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(bytes.readBigUInt64LE(field));
      }
      extra += 4 + size;
    }
    expect(bytes.readUInt32LE(localOffset)).toBe(0x04034b50);
    const dataStart =
      localOffset +
      30 +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    expect([0, 8]).toContain(method);
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

describe('knowledge routes over authenticated HTTP', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let runtime: KnowledgeRuntime;
  let db: Awaited<ReturnType<typeof createDatabaseAsync>>;
  let primary: User;
  let secondary: User;
  let owner: KnowledgeOwner;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'disco-kb-http-'));
    vi.stubEnv('DISCO_HOME', root);
    vi.stubEnv('DISCO_DATA_HOME', root);
    vi.stubEnv('DISCO_KNOWLEDGE_CONFIG', join(root, 'runtime.json'));
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ enabled: false }));
    db = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    await runMigrations(db);
    const repository = new UsersRepository(db);
    primary = (await repository.create({
      username: 'kb_http_alpha',
      email: 'kb_http_alpha@example.invalid',
      name: '资料甲',
      role: 'member',
    })) as User;
    secondary = (await repository.create({
      username: 'kb_http_beta',
      email: 'kb_http_beta@example.invalid',
      name: '资料乙',
      role: 'member',
    })) as User;
    owner = { tenantId: 'default', userId: primary.user_id };
    const app = express();
    app.use(express.json());
    runtime = await registerKnowledgeRoutes({
      app: app as unknown as Application,
      db: db as unknown as TenantScopeAwareDatabase,
      config: {},
      authenticateBrowser: (req, _res, next) => {
        const token = req.headers.authorization;
        if (
          !['Bearer alpha', 'Bearer beta', 'Bearer password', 'Bearer executor'].includes(
            token || ''
          )
        ) {
          next(Object.assign(new Error('未登录'), { status: 401 }));
          return;
        }
        const user = token === 'Bearer beta' ? secondary : primary;
        (req as Request & { feathers: AuthenticatedParams }).feathers = {
          authenticated: true,
          provider: 'rest',
          tenant: { tenant_id: 'default' },
          user: { ...user, must_change_password: token === 'Bearer password' },
          authentication:
            token === 'Bearer executor'
              ? { payload: { type: 'executor-session', purpose: 'executor-task' } }
              : undefined,
        } as AuthenticatedParams;
        next();
      },
    });
    app.get('/knowledge', (_req, res) => res.send('Knowledge browser shell'));
    server = createServer(app);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
    baseUrl = `http://127.0.0.1:${address.port}/knowledge`;
  }, 30_000);

  afterAll(async () => {
    await runtime?.stop();
    if (server)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      );
    (db as unknown as { $client?: { close: () => void } })?.$client?.close();
    vi.unstubAllEnvs();
    const actual = resolve(root);
    if (!actual.startsWith(`${resolve(tmpdir())}${sep}`) || !actual.includes('disco-kb-http-'))
      throw new Error('Unsafe cleanup target');
    await rm(actual, { recursive: true, force: true });
  });

  const request = (path: string, init: RequestInit = {}, token = 'alpha') =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init.headers,
      },
    });
  const create = async (title: string, markdown: string) => {
    const response = await request('/entries', {
      method: 'POST',
      body: JSON.stringify({ title, markdown }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as KnowledgeEntryDetail;
  };

  it('filters organized notes and preserves verified source links through editing', async () => {
    const source = await create('测试来源', '# 原始资料\n实际结论');
    const arranged = await request('/organize', {
      method: 'POST',
      body: JSON.stringify({
        entryIds: [source.entry.id],
        mode: 'manual',
        title: '专题归纳',
        topic: '知识库验收',
      }),
    });
    expect(arranged.status).toBe(201);
    const note = (await arranged.json()) as KnowledgeEntryDetail;
    expect(note.entry.humanEdited).toBe(true);
    expect(note.sources?.[0]).toMatchObject({ id: source.entry.id, available: true });
    const saved = await request(`/entries/${note.entry.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: '人工专题',
        markdown: '# 结论\n保留实际证据',
        expectedUpdatedAt: note.entry.updatedAt,
        organization: {
          topic: '验收专题',
          level: 'knowledge',
          state: 'reviewed',
          sourceEntryIds: ['kb_' + '0'.repeat(64)],
        },
      }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).sources?.[0]).toMatchObject({
      id: source.entry.id,
      available: true,
    });
    const detail = (await (
      await request(`/entries/${note.entry.id}`)
    ).json()) as KnowledgeEntryDetail;
    expect(detail.sources).toEqual([
      { id: source.entry.id, title: '测试来源', kind: 'note', available: true },
    ]);
    expect(detail.entry.organization?.sourceEntryIds).toEqual([source.entry.id]);
    const list = await (
      await request('/entries?level=knowledge&topic=' + encodeURIComponent('验收专题'))
    ).json();
    expect(list.total).toBe(1);
    expect(
      (
        await request(
          '/organize',
          { method: 'POST', body: JSON.stringify({ entryIds: [source.entry.id], mode: 'manual' }) },
          'beta'
        )
      ).status
    ).toBe(404);
    const overview = await (await request('/overview')).json();
    expect(overview.topics).toContainEqual({ topic: '验收专题', count: 1 });
  });

  it('serves the browser shell but rejects anonymous, forced-password and executor API access', async () => {
    expect(await (await fetch(baseUrl)).text()).toBe('Knowledge browser shell');
    for (const path of ['/status', '/entries', '/export'])
      expect((await fetch(`${baseUrl}${path}`)).status).toBe(401);
    expect((await request('/status', {}, 'password')).status).toBe(401);
    expect((await request('/status', {}, 'executor')).status).toBe(403);
    const status = await request('/status');
    expect(status.status).toBe(200);
    expect(status.headers.get('Cache-Control')).toBe('private, no-store');
    expect(status.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects another user reading, editing, deleting or downloading an identified record', async () => {
    const detail = await create('私有记录', '仅甲可读');
    const attachment = await runtime.library.putAttachment(owner, detail.entry.id, {
      name: 'private.bin',
      bytes: Buffer.from('私有原件'),
    });
    expect(attachment?.id).toBeTruthy();
    for (const [path, init] of [
      [`/entries/${detail.entry.id}`, {}],
      [
        `/entries/${detail.entry.id}`,
        { method: 'PATCH', body: JSON.stringify({ markdown: '侵入' }) },
      ],
      [`/entries/${detail.entry.id}`, { method: 'DELETE' }],
      [`/entries/${detail.entry.id}/attachments/${attachment!.id}/content`, {}],
    ] as Array<[string, RequestInit]>)
      expect((await request(path, init, 'beta')).status).toBe(404);
    expect((await (await request('/entries?query=仅甲', {}, 'beta')).json()).entries).toEqual([]);
    expect((await runtime.library.get(owner, detail.entry.id))?.markdown).toBe('仅甲可读');
  });

  it('persists renamed titles and rejects a stale edit without losing newer content', async () => {
    const first = await create('原来标题', '原来正文');
    const saved = await request(`/entries/${first.entry.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: '修改后的标题',
        markdown: '人工修改\n第二行',
        expectedUpdatedAt: first.entry.updatedAt,
      }),
    });
    expect(saved.status).toBe(200);
    const current = (await saved.json()) as KnowledgeEntryDetail;
    expect(current.entry.title).toBe('修改后的标题');
    expect(current.entry.humanEdited).toBe(true);
    const conflict = await request(`/entries/${first.entry.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: '旧版本覆盖',
        markdown: '不能写入',
        expectedUpdatedAt: first.entry.updatedAt,
      }),
    });
    expect(conflict.status).toBe(409);
    expect((await (await request(`/entries/${first.entry.id}`)).json()).markdown).toBe(
      '人工修改\n第二行'
    );
  });

  it('uploads Chinese filenames, reads only metadata until an attachment is requested and preserves unsupported originals', async () => {
    const original = '中文正文\n第二行\n';
    const form = new FormData();
    form.append('file', new Blob([original], { type: 'text/markdown' }), '资料与计划.md');
    const response = await request('/documents', { method: 'POST', body: form });
    expect(response.status).toBe(201);
    const detail = await response.json();
    expect(detail.entry.title).toBe('资料与计划.md');
    expect(detail.parsing.status).toBe('parsed');
    expect(detail.markdown).toContain(original.trim());
    const spy = vi.spyOn(runtime.library, 'openAttachment');
    await request('/entries');
    await request(`/entries/${detail.entry.id}`);
    expect(spy).not.toHaveBeenCalled();
    const attachment = detail.entry.attachments[0];
    const downloaded = await request(
      `/entries/${detail.entry.id}/attachments/${attachment.id}/content`
    );
    expect(downloaded.status).toBe(200);
    expect(decodeURIComponent(downloaded.headers.get('Content-Disposition')!)).toContain(
      '资料与计划.md'
    );
    expect(await downloaded.text()).toBe(original);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    const binary = new FormData();
    binary.append('file', new Blob([new Uint8Array([0, 1, 2, 255])]), '原始设计.psd');
    const unsupported = await (
      await request('/documents', { method: 'POST', body: binary })
    ).json();
    expect(unsupported.parsing.status).toBe('unsupported');
    expect(unsupported.markdown).toContain('原件已完整保存');
    const body = await request(
      `/entries/${unsupported.entry.id}/attachments/${unsupported.entry.attachments[0].id}/content`
    );
    expect(Buffer.from(await body.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it('exports readable Markdown, complete source transcripts, retained original bytes and deletion records', async () => {
    const source: KnowledgeSourceInput = {
      source: 'disco',
      sourceId: 'http-export-source',
      kind: 'conversation',
      title: '导出全文',
      markdown: '# 可读原文\n\n第二行',
      rawContent: `${JSON.stringify({ text: '完整历史'.repeat(230_000) })}\n`,
    };
    const detail = (await runtime.library.upsertSource(owner, source))!;
    const attachment = (await runtime.library.putAttachment(owner, detail.entry.id, {
      name: '文件.bin',
      bytes: Buffer.from([0, 255, 17, 23]),
    }))!;
    const deleted = await create('待删笔记', '不要复活');
    expect((await request(`/entries/${deleted.entry.id}`, { method: 'DELETE' })).status).toBe(200);
    const response = await request('/export');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/zip');
    const files = unzipArchive(Buffer.from(await response.arrayBuffer()));
    expect(
      files
        .get(detail.entry.relativePath)
        ?.toString('utf8')
        .replace(/^\uFEFF/, '')
    ).toBe(source.markdown);
    expect(files.get(`sources/${detail.entry.id}.jsonl`)?.toString('utf8')).toBe(source.rawContent);
    expect(files.get(attachment.relativePath!)).toEqual(Buffer.from([0, 255, 17, 23]));
    expect(files.has(deleted.entry.relativePath)).toBe(false);
    expect(files.get('.library/tombstones.json')?.toString()).toContain(deleted.entry.id);
    expect(
      [...files.keys()].some((name) => /write\.lock|\.partial$|\.tmp$|runtime\.json/.test(name))
    ).toBe(false);
  }, 30_000);

  it('does not revive a deleted source on later synchronization and leaves the source outside the archive intact', async () => {
    const source: KnowledgeSourceInput = {
      source: 'disco',
      sourceId: 'http-deleted-source',
      kind: 'conversation',
      title: '历史会话',
      markdown: '保留原会话',
      rawContent: '{"role":"user","content":"保留原会话"}\n',
    };
    const detail = (await runtime.library.upsertSource(owner, source))!;
    const sourceFile = join(root, 'original-conversation.jsonl');
    await writeFile(sourceFile, source.rawContent!);
    expect((await request(`/entries/${detail.entry.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(
      await runtime.library.upsertSource(owner, { ...source, markdown: '更新后的原会话' })
    ).toBeNull();
    await runtime.library.reconcile(owner);
    expect((await request(`/entries/${detail.entry.id}`)).status).toBe(404);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(sourceFile, 'utf8')).toBe(source.rawContent);
  });
});
