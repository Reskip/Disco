import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { TenantScopeAwareDatabase } from '@disco/core/db';
import type { KnowledgeOwner, KnowledgeSourceInput } from '@disco/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeLibrary } from './library';
import { KnowledgeRuntime } from './runtime';

const owner: KnowledgeOwner = { tenantId: 'tenant-a', userId: 'user-a' };
const sibling: KnowledgeOwner = { tenantId: 'tenant-a', userId: 'user-b' };
const foreign: KnowledgeOwner = { tenantId: 'tenant-b', userId: 'user-a' };

describe('knowledge runtime retrieval evidence and scope', () => {
  let root: string;
  let runtime: KnowledgeRuntime;
  let library: KnowledgeLibrary;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'disco-retrieval-'));
    library = new KnowledgeLibrary(root);
    // Search uses authenticated owner storage only; no application DB or running timers are needed.
    runtime = new KnowledgeRuntime({ libraryRoot: root }, {} as TenantScopeAwareDatabase, {});
    Object.defineProperty(runtime, 'library', { value: library });
  });
  afterEach(async () => {
    await runtime.stop();
    vi.restoreAllMocks();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected fixture root');
    await rm(root, { recursive: true, force: true });
  });
  const save = (
    sourceId: string,
    markdown: string,
    extra: Partial<KnowledgeSourceInput> = {},
    account = owner
  ) =>
    library.upsertSource(account, {
      source: 'manual',
      sourceId,
      kind: 'note',
      title: sourceId,
      markdown,
      ...extra,
    });
  const provider = (implementation: (...args: unknown[]) => Promise<unknown[]>) => {
    const search = vi.fn(implementation);
    Object.defineProperty(runtime, 'engine', { value: { search } });
    return search;
  };

  it('returns the exact deep source passage for a semantic query and rechecks provider ownership', async () => {
    const sentence = '文件传输由后台队列持有，离开会话页面不会取消传输。';
    const current = (await save(
      '上传处理',
      `# 无关开头\n${'旧讨论内容。'.repeat(1000)}\n${sentence}`
    ))!;
    const secret = (await save('其它用户', 'PRIVATE-SIBLING-TEXT', {}, sibling))!;
    provider(async () => [
      { id: secret.entry.id, excerpt: 'PRIVATE-SIBLING-TEXT', score: 2 },
      { id: current.entry.id, excerpt: sentence, score: 1 },
    ]);
    const result = await runtime.search(owner, { query: '导航切换后附件继续发送' });
    expect(result.results).toHaveLength(1);
    const hit = result.results[0];
    expect(hit.entry.id).toBe(current.entry.id);
    expect(hit.excerpt).toContain(sentence);
    expect(hit.excerpt).not.toContain('# 无关开头');
    expect(hit.excerpt).toBe(current.markdown.slice(hit.match!.start, hit.match!.end));
    expect(hit.match!.contentHash).toBe(current.contentHash);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SIBLING-TEXT');
    expect(
      (await runtime.search(foreign, { query: '传输', entryIds: [current.entry.id] })).results
    ).toEqual([]);
  });

  it('rejects a stale semantic passage after human editing and finds the current text with keywords', async () => {
    const original = (await save('保留策略', '预览图七日清理。'))!;
    provider(async () => [{ id: original.entry.id, excerpt: '预览图七日清理。', score: 1 }]);
    await runtime.search(owner, { query: '七日清理' });
    const updated = (await library.edit(
      owner,
      original.entry.id,
      '人工决定：所有预览图和下载文件永久保存。'
    ))!;
    expect((await runtime.search(owner, { query: '七日清理' })).results).toEqual([]);
    const result = await runtime.search(owner, { query: '文件 永久 保存 预览图' });
    expect(result.engine).toBe('local');
    expect(result.results[0].excerpt).toContain('人工决定');
    expect(result.results[0].match).toMatchObject({
      method: 'keyword',
      contentHash: updated.contentHash,
    });
    expect(JSON.stringify(result)).not.toContain('七日清理');
  });

  it('pushes source/ID intersections down and fuses keyword matches when vectors miss', async () => {
    const manual = (await save(
      '本地手记',
      '启动报错 ERR_MODULE_NOT_FOUND，内建模块 node:sqlite。'
    ))!;
    const codex = (await save(
      '宿主记录',
      '启动报错 ERR_MODULE_NOT_FOUND，必须保留 node:sqlite 前缀。',
      { source: 'codex' }
    ))!;
    const search = provider(async () => [
      { id: manual.entry.id, excerpt: manual.markdown, score: 1 },
    ]);
    const result = await runtime.search(owner, {
      query: '启动报错',
      source: 'codex',
      entryIds: [manual.entry.id, codex.entry.id],
    });
    expect(search).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ documentIds: [codex.entry.id] })
    );
    expect(result.results.map((item) => item.entry.id)).toEqual([codex.entry.id]);
    expect(result.results[0].match!.method).toBe('keyword');
    const count = search.mock.calls.length;
    expect((await runtime.search(owner, { query: '启动', entryIds: [] })).results).toEqual([]);
    expect(search).toHaveBeenCalledTimes(count);
  });

  it('does not substitute semantic approximations for an exact technical identifier', async () => {
    const unrelated = (await save('地图页面', 'source_position_retained_low_quality'))!;
    const search = provider(async () => [{ id: unrelated.entry.id, excerpt: unrelated.markdown }]);
    expect((await runtime.search(owner, { query: 'ResourceBusyError' })).results).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    const relevant = (await save(
      '索引故障',
      '批次重复写入触发 ResourceBusyError，应等待写入结束。'
    ))!;
    const result = await runtime.search(owner, { query: 'ResourceBusyError' });
    expect(result.results.map((hit) => hit.entry.id)).toEqual([relevant.entry.id]);
    expect(result.results[0].match?.method).toBe('keyword');
    const mixed = await runtime.search(owner, { query: '如何解决 ResourceBusyError' });
    expect(mixed.results.map((hit) => hit.entry.id)).toEqual([relevant.entry.id]);
    expect(mixed.results[0].excerpt).toContain('ResourceBusyError');
    expect(
      (await runtime.search(owner, { query: '如何解决 UnseenStorageQuotaError' })).results
    ).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('does not treat the metadata of an unparsed attachment as semantic content evidence', async () => {
    const image = (await save('image', '# 旅行照片.jpg\n原件已保存，正文暂不能检索。', {
      kind: 'document',
      title: '旅行照片.jpg',
    }))!;
    await library.markParsed(owner, image.entry.id, 'unsupported');
    provider(async () => [{ id: image.entry.id, excerpt: image.markdown }]);
    expect((await runtime.search(owner, { query: '重试连接' })).results).toEqual([]);
    expect((await runtime.search(owner, { query: '旅行照片' })).results[0].entry.id).toBe(
      image.entry.id
    );
  });

  it('does not quote an archive wrapper or a title-only match as evidence from conversation contents', async () => {
    const wrapper = '# Codex 会话 host-id\n\n来源：Codex 会话 host-id\n\n';
    const archived = (await save('placeholder', `${wrapper}照片按年份存储。`, {
      source: 'codex',
      sourceId: 'host-id',
      kind: 'conversation',
      title: 'Codex 会话 host-id',
    }))!;
    provider(async () => [{ id: archived.entry.id, excerpt: wrapper }]);
    expect((await runtime.search(owner, { query: '上传切换会话' })).results).toEqual([]);
    await save('misleading-title', '正文仅讨论照片备份。', {
      source: 'codex',
      kind: 'conversation',
      title: '如何解决 ResourceBusyError',
    });
    expect((await runtime.search(owner, { query: '如何解决 ResourceBusyError' })).results).toEqual(
      []
    );
  });

  it('does not return a document deleted while semantic retrieval is in flight', async () => {
    const record = (await save('临时资料', '独特的检索证据'))!;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let began!: () => void;
    const started = new Promise<void>((done) => {
      began = done;
    });
    provider(async () => {
      began();
      await gate;
      return [{ id: record.entry.id, excerpt: record.markdown }];
    });
    const pending = runtime.search(owner, { query: '检索证据' });
    await started;
    await library.remove(owner, record.entry.id);
    release();
    expect((await pending).results).toEqual([]);
  });
});
