import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeOwner, KnowledgeSourceInput } from '@disco/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeConflictError, KnowledgeLibrary } from './library';

const owner: KnowledgeOwner = { tenantId: 'tenant-a', userId: 'user-a' };
const otherUser: KnowledgeOwner = { tenantId: 'tenant-a', userId: 'user-b' };
const otherTenant: KnowledgeOwner = { tenantId: 'tenant-b', userId: 'user-a' };
const source: KnowledgeSourceInput = {
  source: 'disco',
  sourceId: 'session-1',
  kind: 'conversation',
  title: '检索与归档',
  markdown: '# 检索与归档\n\n原始说明。',
  rawContent: '{"role":"user","content":"完整原文"}\n',
};

describe('portable knowledge library', () => {
  let root: string;
  let library: KnowledgeLibrary;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'disco-kb-unit-'));
    library = new KnowledgeLibrary(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('classifies file formats and separates archived history from the catalog', async () => {
    const image = (await library.upsertSource(owner, {
      ...source,
      sourceId: 'image',
      kind: 'document',
      title: '旅行.jpg',
    }))!;
    await library.upsertSource(owner, {
      ...source,
      sourceId: 'doc',
      kind: 'document',
      title: '说明.pdf',
    });
    await library.upsertSource(owner, {
      ...source,
      sourceId: 'file',
      kind: 'document',
      title: '项目.zip',
    });
    expect(
      (await library.list(owner, { materialType: 'image' })).entries.map((item) => item.id)
    ).toEqual([image.entry.id]);
    await library.markHistorical(owner, image.entry.id);
    expect((await library.list(owner)).total).toBe(2);
    expect((await library.list(owner, { includeHistory: true })).total).toBe(3);
    expect(await library.get(owner, image.entry.id)).not.toBeNull();
  });

  it('filters all note categories before pagination and prioritizes maintained knowledge', async () => {
    const knowledge = (await library.upsertSource(owner, {
      ...source,
      sourceId: 'knowledge',
      kind: 'note',
      source: 'manual',
      title: '人工维护的专题',
      markdown: '人工确认的可靠规则',
      organization: { topic: '软件', level: 'knowledge', state: 'reviewed' },
    }))!;
    const summary = (await library.upsertSource(owner, {
      ...source,
      sourceId: 'summary',
      kind: 'note',
      automated: true,
      title: '自动摘要',
      markdown: '保存缓存的具体规则',
      summaryMode: 'model',
      organization: { topic: '软件', level: 'summary', state: 'draft' },
    }))!;
    const overview = (await library.upsertSource(owner, {
      ...source,
      sourceId: 'overview',
      kind: 'note',
      automated: true,
      title: '文件结构概览',
      summaryMode: 'structured_overview',
      organization: { topic: '数据', level: 'summary', state: 'draft' },
    }))!;
    await library.upsertSource(owner, { ...source, sourceId: 'unclassified-raw' });
    for (const [type, expected] of [
      ['knowledge', knowledge],
      ['summary', summary],
      ['overview', overview],
    ] as const) {
      const found = await library.list(owner, { noteType: type, limit: 1 });
      expect(found.total).toBe(1);
      expect(found.entries[0].id).toBe(expected.entry.id);
    }
    expect(
      (await library.list(owner, { kind: 'note', sort: 'curated', limit: 1 })).entries[0].id
    ).toBe(knowledge.entry.id);
    expect(
      (await library.list(owner, { kind: 'note', sort: 'curated', query: '保存缓存' })).entries[0]
        .id
    ).toBe(summary.entry.id);
    const facets = await library.overview(owner);
    expect(facets.noteTopics).toEqual([
      { topic: '软件', count: 2 },
      { topic: '数据', count: 1 },
    ]);
    expect(facets.topics).toContainEqual({ topic: '未分类', count: 1 });
    await library.edit(owner, overview.entry.id, '经过人工核实的结论', undefined, undefined, {
      topic: '数据',
      level: 'knowledge',
      state: 'reviewed',
    });
    expect((await library.list(owner, { noteType: 'overview' })).total).toBe(0);
    expect((await library.list(owner, { noteType: 'knowledge' })).total).toBe(2);
  });

  it('repairs imported display titles without touching raw records, content, or completed summaries', async () => {
    const imported = (await library.upsertSource(owner, {
      ...source,
      source: 'codex',
      title: 'Codex 会话 session-1',
    }))!;
    await library.markSummarized(owner, imported.entry.id, imported.contentHash);
    const rawPath = join(library.ownerPath(owner), 'sources', `${imported.entry.id}.jsonl`);
    const raw = await readFile(rawPath);
    expect(
      await library.repairImportedTitle(
        owner,
        imported.entry.id,
        imported.contentHash,
        imported.entry.title,
        '清理缓存并保留原件'
      )
    ).toBe(true);
    const fixed = (await library.get(owner, imported.entry.id))!;
    expect(fixed.entry.title).toBe('清理缓存并保留原件');
    expect(fixed.entry.titleProjectionVersion).toBe(1);
    expect(fixed.contentHash).toBe(imported.contentHash);
    expect(fixed.markdown).toBe(imported.markdown);
    expect(fixed.entry.updatedAt).toBe(imported.entry.updatedAt);
    expect(fixed.entry.summaryContentHash).toBe(imported.contentHash);
    expect(await readFile(rawPath)).toEqual(raw);
    const another = (await library.upsertSource(owner, {
      ...source,
      source: 'codex',
      sourceId: 'manual-takeover',
      title: '恢复归档 · x',
    }))!;
    await writeFile(
      join(library.ownerPath(owner), another.entry.relativePath),
      '# 人工标题\n保留人工正文'
    );
    expect(
      await library.repairImportedTitle(
        owner,
        another.entry.id,
        another.contentHash,
        another.entry.title,
        '后台旧题'
      )
    ).toBe(false);
    expect((await library.get(owner, another.entry.id))?.entry.title).toBe('人工标题');
  });

  it('ranks multi-term Chinese catalog matches without requiring the entire question verbatim', async () => {
    const relevant = (await library.upsertSource(owner, {
      ...source,
      sourceId: 'upload-life',
      title: '上传生命周期',
      markdown: '# 上传生命周期\n上传时可以切换会话，上传在后台继续。',
    }))!;
    await library.upsertSource(owner, {
      ...source,
      sourceId: 'upload-image',
      title: '图片文件',
      markdown: '上传图片后可以下载。',
    });
    await library.upsertSource(otherUser, {
      ...source,
      sourceId: 'private',
      title: '切换会话 上传',
      markdown: '另一个用户的资料',
    });
    const catalog = await library.catalog(owner, { query: '切换会话 上传' });
    expect(catalog.entries[0].id).toBe(relevant.entry.id);
    expect(catalog.entries[0].snippet).toContain('后台继续');
    expect(catalog.status.total).toBe(2);
    expect((await library.catalog(owner, { query: 'ERR_MODULE_NOT_FOUND' })).entries).toEqual([]);
  });

  it('streams and validates raw archives without losing the old revision', async () => {
    const entry = (await library.upsertSource(owner, source))!;
    await library.preserveRawRevision(owner, entry.entry.id);
    const bytes = Buffer.from('完整的新原始归档\n'.repeat(1000));
    const hash = createHash('sha256').update(bytes).digest('hex');
    async function* chunks() {
      yield bytes.subarray(0, 321);
      yield bytes.subarray(321);
    }
    await library.putRawSource(owner, entry.entry.id, { stream: chunks(), sha256: hash });
    expect(await library.hasRawSource(owner, entry.entry.id, hash)).toBe(true);
    expect(
      await readFile(join(library.ownerPath(owner), `sources/${entry.entry.id}.jsonl`))
    ).toEqual(bytes);
    await expect(
      library.putRawSource(owner, entry.entry.id, { stream: chunks(), sha256: 'wrong' })
    ).rejects.toThrow('校验失败');
    expect(await library.hasRawSource(owner, entry.entry.id, hash)).toBe(true);
    const revisions = await readdir(join(library.ownerPath(owner), 'revisions', entry.entry.id));
    expect(revisions.some((file) => file.endsWith('.jsonl'))).toBe(true);
  });

  it('protects a directly edited draft title, category, and generation state', async () => {
    const draft = (await library.upsertSource(owner, {
      ...source,
      source: 'manual',
      sourceId: 'draft',
      kind: 'note',
      automated: true,
      generation: { state: 'queued' },
    }))!;
    await library.markIndexed(owner, draft.entry.id, draft.contentHash, '失败');
    await writeFile(
      join(library.ownerPath(owner), draft.entry.relativePath),
      '# 人工新标题\n我的结论'
    );
    const updated = await library.get(owner, draft.entry.id);
    expect(updated?.entry).toMatchObject({
      title: '人工新标题',
      humanEdited: true,
      generation: { state: 'complete' },
    });
    expect(updated?.entry.indexRetryAt).toBeUndefined();
    await library.upsertSource(owner, {
      ...source,
      source: 'manual',
      sourceId: 'draft',
      kind: 'note',
      title: '自动旧标题',
      markdown: '自动旧结果',
      automated: true,
    });
    expect((await library.get(owner, draft.entry.id))?.entry.title).toBe('人工新标题');
  });

  it('honors provider retry cooldowns and removes stale indexing errors after a human edit', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const before = Date.now();
    await library.markSummaryFailed(
      owner,
      record.entry.id,
      record.contentHash,
      '额度不足',
      3_600_000
    );
    const failed = (await library.get(owner, record.entry.id))!;
    expect(Date.parse(failed.entry.summaryRetryAt!) - before).toBeGreaterThanOrEqual(3_600_000);
    await library.markIndexed(owner, record.entry.id, record.contentHash, '旧索引失败');
    const edited = (await library.edit(owner, record.entry.id, '人工修正后的内容'))!;
    expect(edited.entry.indexStatus).toBe('pending');
    expect(edited.entry.indexMessage).toBeUndefined();
    expect(edited.entry.indexRetryAt).toBeUndefined();
  });

  it('persists resumable progress without editing the source and rejects stale or deleted progress', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const progress = {
      phase: 'waiting_model' as const,
      stage: 'map' as const,
      completed: 2,
      total: 5,
      requestStartedAt: new Date().toISOString(),
    };
    await library.markSummaryFailed(owner, record.entry.id, record.contentHash, '旧失败');
    expect(
      await library.markSummaryProgress(
        owner,
        record.entry.id,
        record.contentHash,
        progress,
        new Date().toISOString()
      )
    ).toBe(true);
    const running = (await library.get(owner, record.entry.id))!;
    expect(running.markdown).toBe(record.markdown);
    expect(running.entry.updatedAt).toBe(record.entry.updatedAt);
    expect(running.entry.summaryMessage).toBeUndefined();
    await library.recoverSummaryProgress(owner);
    expect((await library.get(owner, record.entry.id))?.entry.summaryProgress).toMatchObject({
      phase: 'queued',
      completed: 2,
      total: 5,
    });
    await library.edit(owner, record.entry.id, '# 人工新的内容');
    expect(
      await library.markSummaryProgress(
        owner,
        record.entry.id,
        record.contentHash,
        progress,
        new Date().toISOString()
      )
    ).toBe(false);
    expect((await library.get(owner, record.entry.id))?.entry.summaryProgress).toBeUndefined();
    await library.remove(owner, record.entry.id);
    expect(
      await library.markSummaryProgress(
        owner,
        record.entry.id,
        record.contentHash,
        progress,
        new Date().toISOString()
      )
    ).toBe(false);
    expect(
      await library.markGeneration(owner, record.entry.id, { state: 'running', progress })
    ).toBe(false);
  });

  it('atomically rejects a synthesized note after its source changes or disappears', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const summary = {
      source: 'manual' as const,
      sourceId: 'guarded-summary',
      kind: 'note' as const,
      title: '受版本保护的摘要',
      markdown: '旧来源的结论',
      automated: true,
      expectedSources: [{ id: record.entry.id, contentHash: record.contentHash }],
    };
    await library.edit(owner, record.entry.id, '更新后的来源');
    expect(await library.upsertSource(owner, summary)).toBeNull();
    expect((await library.list(owner, { kind: 'note' })).total).toBe(0);
    const current = (await library.get(owner, record.entry.id))!;
    summary.expectedSources[0].contentHash = current.contentHash;
    expect(await library.upsertSource(owner, summary)).not.toBeNull();
    await library.remove(owner, record.entry.id);
    expect(
      await library.upsertSource(owner, { ...summary, markdown: '删除来源后不应提交' })
    ).toBeNull();
    expect((await library.list(owner, { kind: 'note' })).total).toBe(1);
  });

  it('preserves full raw records and readable Markdown with deterministic, per-owner IDs', async () => {
    const rawContent = `${JSON.stringify({ content: '原文'.repeat(600_000) })}\n`;
    const first = (await library.upsertSource(owner, { ...source, rawContent }))!;
    const second = (await library.upsertSource(owner, { ...source, rawContent }))!;
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.updatedAt).toBe(first.entry.updatedAt);
    expect((await library.list(owner)).total).toBe(1);
    const base = library.ownerPath(owner);
    expect(await readFile(join(base, `sources/${first.entry.id}.jsonl`), 'utf8')).toBe(rawContent);
    expect(await readFile(join(base, first.entry.relativePath), 'utf8')).toBe(
      `\uFEFF${source.markdown}`
    );
    expect(first.entry.relativePath).not.toContain(root);
    expect(first.entry.humanEdited).toBe(false);
  });

  it('rejects cross-user and cross-tenant read, edit, removal and attachment access using a known ID', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const asset = (await library.putAttachment(owner, record.entry.id, {
      name: '原件.bin',
      bytes: Buffer.from('private'),
    }))!;
    for (const outsider of [otherUser, otherTenant]) {
      expect(await library.get(outsider, record.entry.id)).toBeNull();
      expect(await library.edit(outsider, record.entry.id, '改写')).toBeNull();
      expect(await library.remove(outsider, record.entry.id)).toBe(false);
      expect(await library.getAttachment(outsider, record.entry.id, asset.id!)).toBeNull();
      expect(
        await library.putAttachment(outsider, record.entry.id, {
          name: 'x',
          bytes: Buffer.from('x'),
        })
      ).toBeNull();
      expect(await library.markIndexed(outsider, record.entry.id)).toBe(false);
      expect(await library.markParsed(outsider, record.entry.id, 'parsed')).toBe(false);
      expect((await library.list(outsider, { query: '原始' })).total).toBe(0);
      const own = (await library.upsertSource(outsider, source))!;
      expect(own.entry.id).not.toBe(record.entry.id);
    }
    expect((await library.get(owner, record.entry.id))?.markdown).toBe(source.markdown);
    expect(
      Buffer.from(
        (await library.getAttachment(owner, record.entry.id, asset.id!))!.bytes
      ).toString()
    ).toBe('private');
  });

  it('recognizes direct editing before an importer can overwrite it, while still updating original records', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const base = library.ownerPath(owner);
    const edited = '# 人工修订\n\n这段必须保留。';
    await writeFile(join(base, record.entry.relativePath), edited);
    const updated = (await library.upsertSource(owner, {
      ...source,
      markdown: '# 自动生成的新总结',
      rawContent: '{"new":true}\n',
    }))!;
    expect(updated.markdown).toBe(edited);
    expect(updated.entry.humanEdited).toBe(true);
    expect(await readFile(join(base, `sources/${record.entry.id}.jsonl`), 'utf8')).toBe(
      '{"new":true}\n'
    );
    expect(await readFile(join(base, `sources/${record.entry.id}.md`), 'utf8')).toContain(
      '自动生成的新总结'
    );
    const revisions = await readdir(join(base, `revisions/${record.entry.id}`));
    expect(revisions).toHaveLength(2);
    const history = await Promise.all(
      revisions.map((file) => readFile(join(base, `revisions/${record.entry.id}`, file), 'utf8'))
    );
    expect(history).toContain(`\uFEFF${source.markdown}`);
    expect(history).toContain(`\uFEFF${edited}`);
  });

  it('prevents stale browser saves and stale indexing jobs after external edits', async () => {
    const record = (await library.upsertSource(owner, source))!;
    await writeFile(join(library.ownerPath(owner), record.entry.relativePath), '# 外部编辑');
    await expect(
      library.edit(owner, record.entry.id, '旧草稿', record.entry.updatedAt)
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    expect(await library.markIndexed(owner, record.entry.id, record.contentHash)).toBe(false);
    const latest = (await library.get(owner, record.entry.id))!;
    const saved = (await library.edit(
      owner,
      record.entry.id,
      '合并后的人工内容',
      latest.entry.updatedAt
    ))!;
    expect(saved.markdown).toBe('合并后的人工内容');
    expect(saved.entry.humanEdited).toBe(true);
    expect(await library.markIndexed(owner, record.entry.id, saved.contentHash)).toBe(true);
    expect((await library.get(owner, record.entry.id))?.entry.indexStatus).toBe('indexed');
  });

  it('atomically saves a trimmed title with Markdown and rejects empty or stale title edits', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const renamed = (await library.edit(
      owner,
      record.entry.id,
      '# 正文已修改',
      record.entry.updatedAt,
      '  新标题  '
    ))!;
    expect(renamed.entry).toMatchObject({ title: '新标题', humanEdited: true });
    expect(renamed.markdown).toBe('# 正文已修改');
    await expect(
      library.edit(owner, record.entry.id, '# 陈旧正文', record.entry.updatedAt, '旧草稿标题')
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    await expect(
      library.edit(owner, record.entry.id, '# 空标题', renamed.entry.updatedAt, '  ')
    ).rejects.toThrow('标题不能为空');
    expect((await library.get(owner, record.entry.id))?.entry.title).toBe('新标题');
  });

  it('scans new ordinary Markdown and searches its body, then suppresses direct deletions durably', async () => {
    await library.status(owner);
    const base = library.ownerPath(owner);
    await mkdir(join(base, 'notes', '项目'), { recursive: true });
    await writeFile(join(base, 'notes', '项目', '记录.md'), '# 新知识\n\n精确检索关键字。');
    const status = await library.reconcile(owner);
    expect(status).toMatchObject({ total: 1, notes: 1, humanEdited: 1 });
    const result = await library.list(owner, { query: '精确检索' });
    expect(result.total).toBe(1);
    expect(result.entries[0]).toMatchObject({
      title: '新知识',
      source: 'manual',
      humanEdited: true,
    });
    expect(result.entries[0]?.snippet).toContain('精确检索');
    await unlink(join(base, result.entries[0]!.relativePath));
    expect((await library.reconcile(owner)).deleted).toBe(1);
    // A copied-back file is not re-imported and disappears on the next reconciliation.
    await writeFile(join(base, 'notes', '项目', '记录.md'), '# 恢复旧文件');
    library = new KnowledgeLibrary(root);
    expect((await library.reconcile(owner)).total).toBe(0);
    expect((await library.list(owner)).total).toBe(0);
  });

  it('does not resurrect API-deleted or externally deleted sources on replay/restart', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const attachment = (await library.putAttachment(owner, record.entry.id, {
      name: '附件',
      bytes: Buffer.from('original'),
    }))!;
    expect(await library.remove(owner, record.entry.id)).toBe(true);
    expect(await library.getAttachment(owner, record.entry.id, attachment.id!)).toBeNull();
    await expect(
      readFile(join(library.ownerPath(owner), `sources/${record.entry.id}.jsonl`))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    library = new KnowledgeLibrary(root);
    expect(
      await library.upsertSource(owner, {
        ...source,
        markdown: '再导入',
        rawContent: '{"changed":true}',
      })
    ).toBeNull();
    expect((await library.reconcile(owner)).total).toBe(0);
    const second = (await library.upsertSource(owner, { ...source, sourceId: 'session-2' }))!;
    await unlink(join(library.ownerPath(owner), second.entry.relativePath));
    // Even without a prior background scan, importing does not recreate the deleted file.
    expect(await library.upsertSource(owner, { ...source, sourceId: 'session-2' })).toBeNull();
    expect((await library.status(owner)).deleted).toBe(2);
  });

  it('backs up by copying the directory and restores without a database or vector index', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const attachment = (await library.putAttachment(owner, record.entry.id, {
      name: '附件.pdf',
      bytes: Buffer.from('%PDF-data'),
      mimeType: 'application/pdf',
    }))!;
    await library.edit(owner, record.entry.id, '# 人工知识\n\n跨机器保留。');
    await library.upsertSource(owner, { ...source, sourceId: 'deleted' });
    const removed = (await library.list(owner)).entries.find(
      (item) => item.sourceId === 'deleted'
    )!;
    await library.remove(owner, removed.id);
    const copyRoot = join(root, 'restored');
    await mkdir(copyRoot);
    await cp(join(root, 'tenants'), join(copyRoot, 'tenants'), { recursive: true });
    const restored = new KnowledgeLibrary(copyRoot);
    expect((await restored.get(owner, record.entry.id))?.markdown).toContain('跨机器保留');
    expect(
      Buffer.from(
        (await restored.getAttachment(owner, record.entry.id, attachment.id!))!.bytes
      ).toString()
    ).toBe('%PDF-data');
    expect(await restored.upsertSource(owner, { ...source, sourceId: 'deleted' })).toBeNull();
    expect(await restored.reconcile(owner)).toMatchObject({ total: 1, humanEdited: 1, deleted: 1 });
  });

  it('serializes imports and optimistic edits across library instances', async () => {
    const second = new KnowledgeLibrary(root);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? second : library).upsertSource(owner, source)
      )
    );
    expect((await library.list(owner)).total).toBe(1);
    const original = (await library.list(owner)).entries[0]!;
    const results = await Promise.allSettled([
      library.edit(owner, original.id, '编辑 A', original.updatedAt),
      second.edit(owner, original.id, '编辑 B', original.updatedAt),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
  });

  it('recovers an interrupted metadata commit without misclassifying its Markdown as a human edit', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const base = library.ownerPath(owner);
    const meta = JSON.parse(
      await readFile(join(base, `.library/entries/${record.entry.id}.json`), 'utf8')
    );
    const body = '# 已写入但尚未提交的新内容';
    meta.contentHash = createHash('sha256').update(body).digest('hex');
    meta.sourceHash = meta.contentHash;
    meta.sizeBytes = Buffer.byteLength(body);
    await mkdir(join(base, '.library/pending'), { recursive: true });
    await writeFile(join(base, `.library/pending/${record.entry.id}.json`), JSON.stringify(meta));
    await writeFile(join(base, record.entry.relativePath), `\uFEFF${body}`);
    library = new KnowledgeLibrary(root);
    const recovered = (await library.get(owner, record.entry.id))!;
    expect(recovered.markdown).toBe(body);
    expect(recovered.entry.humanEdited).toBe(false);
    expect(await readdir(join(base, '.library/pending'))).toHaveLength(0);
  });

  it('fails closed for traversal IDs, missing owners, tampered metadata and junction escapes', async () => {
    const record = (await library.upsertSource(owner, source))!;
    expect(await library.get(owner, '../another-owner')).toBeNull();
    expect(() => library.ownerPath({ tenantId: '', userId: 'x' })).toThrow();
    const base = library.ownerPath(owner);
    const metaPath = join(base, `.library/entries/${record.entry.id}.json`);
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    await writeFile(metaPath, JSON.stringify({ ...meta, relativePath: 'notes/../../outside.md' }));
    await expect(library.get(owner, record.entry.id)).rejects.toThrow('路径');
    await writeFile(metaPath, JSON.stringify(meta));
    const outside = join(root, 'unowned');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.md'), '另一个用户的内容');
    await symlink(outside, join(base, 'notes'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(library.reconcile(owner)).rejects.toThrow('联接');
    expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('另一个用户的内容');
    await unlink(join(base, 'notes'));
    await rm(join(base, 'conversations'), { recursive: true });
    await symlink(
      outside,
      join(base, 'conversations'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(library.edit(owner, record.entry.id, '覆盖')).rejects.toThrow('联接');
    await unlink(join(base, 'conversations'));
  });

  it('streams original attachments with their extension, keeps copied references on source updates and deduplicates content', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    async function* chunks() {
      for (let count = 0; count < 16; count++) yield chunk;
    }
    const attachment = (await library.putAttachment(owner, record.entry.id, {
      name: '原始文档.PDF',
      stream: chunks(),
      sourceUrl: '/uploads/document/content',
    }))!;
    expect(attachment.relativePath).toMatch(/\.PDF$/);
    expect(attachment.sizeBytes).toBe(4 * 1024 * 1024);
    const duplicate = (await library.putAttachment(owner, record.entry.id, {
      name: '另一个名字.pdf',
      stream: chunks(),
      sourceUrl: '/uploads/document/content',
    }))!;
    expect(duplicate.id).toBe(attachment.id);
    expect(duplicate.relativePath).toBe(attachment.relativePath);
    await library.upsertSource(owner, {
      ...source,
      markdown: '# 后续消息',
      attachments: [{ name: '原始文档.PDF', sourceUrl: '/uploads/document/content' }],
    });
    const updated = (await library.get(owner, record.entry.id))!;
    expect(updated.entry.attachments).toHaveLength(1);
    expect(updated.entry.attachments?.[0]?.id).toBe(attachment.id);
    const stream = (await library.openAttachment(owner, record.entry.id, attachment.id!))!;
    let bytesRead = 0;
    const hash = createHash('sha256');
    for await (const bytes of stream.body) {
      bytesRead += bytes.length;
      hash.update(bytes);
    }
    expect(bytesRead).toBe(attachment.sizeBytes);
    expect(hash.digest('hex')).toBe(attachment.id);
    expect(await readdir(join(library.ownerPath(owner), `assets/${record.entry.id}`))).toHaveLength(
      1
    );
  });

  it('exports a complete streaming portable library while excluding operational locks and partial files', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const asset = (await library.putAttachment(owner, record.entry.id, {
      name: 'original.txt',
      bytes: Buffer.from('file bytes'),
    }))!;
    await library.edit(owner, record.entry.id, '# 导出的人工版本');
    await library.upsertSource(owner, { ...source, sourceId: 'removed' });
    const removed = (await library.list(owner)).entries.find(
      (item) => item.sourceId === 'removed'
    )!;
    await library.remove(owner, removed.id);
    await writeFile(join(library.ownerPath(owner), 'sources', 'incomplete.partial'), 'partial');
    const archive = new Map<string, Buffer>();
    for await (const file of library.exportFiles(owner)) {
      const chunks: Buffer[] = [];
      for await (const chunk of file.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBe(file.size);
      archive.set(file.path, bytes);
    }
    expect(archive.get(record.entry.relativePath)?.toString()).toContain('导出的人工版本');
    expect(archive.get(`sources/${record.entry.id}.jsonl`)?.toString()).toBe(source.rawContent);
    expect(archive.get(asset.relativePath!)?.toString()).toBe('file bytes');
    expect(archive.has(`.library/entries/${record.entry.id}.json`)).toBe(true);
    expect(archive.has('.library/owner.json')).toBe(true);
    expect(archive.get('.library/tombstones.json')?.toString()).toContain(removed.id);
    expect(
      [...archive.keys()].some(
        (path) => path.endsWith('.lock') || path.endsWith('.partial') || path.includes('/pending/')
      )
    ).toBe(false);
    const copied = new KnowledgeLibrary(join(root, 'export-restored'));
    const destination = copied.ownerPath(owner);
    for (const [path, bytes] of archive) {
      await mkdir(join(destination, path, '..'), { recursive: true });
      await writeFile(join(destination, path), bytes);
    }
    expect((await copied.get(owner, record.entry.id))?.markdown).toBe('# 导出的人工版本');
    expect(await copied.upsertSource(owner, { ...source, sourceId: 'removed' })).toBeNull();
  });

  it('releases the export lock if the HTTP consumer cancels without reading the current file', async () => {
    await library.upsertSource(owner, source);
    const controller = new AbortController();
    const iterator = library.exportFiles(owner, controller.signal);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    controller.abort();
    await iterator.return();
    expect((await library.status(owner)).total).toBe(1);
  });

  it('checks Markdown again at commit time when an external editor changes it during an import', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const internal = library as unknown as {
      atomicWrite: (
        base: string,
        file: string,
        content: string | Uint8Array,
        hash?: string | null
      ) => Promise<void>;
    };
    const original = internal.atomicWrite.bind(library);
    let edited = false;
    vi.spyOn(internal, 'atomicWrite').mockImplementation(async (base, file, content, hash) => {
      if (!edited && file.endsWith('.jsonl')) {
        edited = true;
        await writeFile(join(base, record.entry.relativePath), '# 同时发生的人工编辑');
      }
      await original(base, file, content, hash);
    });
    await expect(
      library.upsertSource(owner, {
        ...source,
        markdown: '# 自动新内容',
        rawContent: '{"new":true}',
      })
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    expect((await library.get(owner, record.entry.id))?.markdown).toBe('# 同时发生的人工编辑');
    expect((await library.get(owner, record.entry.id))?.entry.humanEdited).toBe(true);
  });

  it('supports a trusted owner resolver inside the existing workspace boundary and rejects conflicting ownership', async () => {
    const workspace = join(root, 'workspaces');
    const resolved = new KnowledgeLibrary(join(root, 'operator-config'), {
      ownerRoot: (identity) =>
        join(
          workspace,
          identity.tenantId,
          `user-${identity.userId}`,
          '.disco',
          'knowledge',
          'library'
        ),
    });
    const record = (await resolved.upsertSource(owner, source))!;
    expect(resolved.ownerPath(owner)).toContain(
      join('user-user-a', '.disco', 'knowledge', 'library')
    );
    expect((await resolved.get(owner, record.entry.id))?.markdown).toBe(source.markdown);
    expect(await resolved.get(otherUser, record.entry.id)).toBeNull();
    expect(await resolved.get(otherTenant, record.entry.id)).toBeNull();
    expect(() => resolved.ownerPath({ tenantId: 'tenant-a', userId: '../../user-b' })).toThrow();
    const conflicting = new KnowledgeLibrary(root, { ownerRoot: () => resolved.ownerPath(owner) });
    await expect(conflicting.get(otherUser, record.entry.id)).rejects.toThrow('归属不匹配');
    const relativeResolver = new KnowledgeLibrary(root, { ownerRoot: () => 'relative/path' });
    expect(() => relativeResolver.ownerPath(owner)).toThrow('绝对路径');
  });

  it('takes one metadata snapshot without loading any Markdown, raw record or attachment bytes', async () => {
    const record = (await library.upsertSource(owner, source))!;
    await library.putAttachment(owner, record.entry.id, {
      name: 'binary.dat',
      bytes: Buffer.alloc(1024),
    });
    const internal = library as unknown as {
      read: (base: string, file: string) => Promise<Buffer | null>;
    };
    const spy = vi.spyOn(internal, 'read');
    const snapshot = await library.snapshot(owner);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.id).toBe(record.entry.id);
    expect(spy.mock.calls.every(([, file]) => file.startsWith('.library/'))).toBe(true);
  });

  it('persists derived provenance and summary versions without blessing stale summaries or reviving deleted notes', async () => {
    const record = (await library.upsertSource(owner, source))!;
    const summaryInput = {
      source: 'manual' as const,
      sourceId: `summary:${record.entry.id}`,
      kind: 'note' as const,
      title: '自动提取的经验',
      markdown: '# 初始总结',
      derivedFrom: { entryId: record.entry.id, contentHash: record.contentHash },
    };
    const summary = (await library.upsertSource(owner, summaryInput))!;
    expect(summary.entry).toMatchObject({
      humanEdited: false,
      derivedFrom: summaryInput.derivedFrom,
    });
    expect(await library.markSummarized(owner, record.entry.id, record.contentHash)).toBe(true);
    const changed = (await library.upsertSource(owner, { ...source, markdown: '# 新的来源内容' }))!;
    expect(changed.entry.summaryContentHash).toBe(record.contentHash);
    expect(await library.markSummarized(owner, record.entry.id, record.contentHash)).toBe(false);
    expect(await library.markSummarized(owner, record.entry.id, changed.contentHash)).toBe(true);
    const updatedSummary = (await library.upsertSource(owner, {
      ...summaryInput,
      derivedFrom: { entryId: record.entry.id, contentHash: changed.contentHash },
    }))!;
    expect(updatedSummary.entry.derivedFrom?.contentHash).toBe(changed.contentHash);
    await library.edit(owner, summary.entry.id, '# 人工修订的经验');
    const protectedSummary = (await library.upsertSource(owner, {
      ...summaryInput,
      markdown: '# 自动替换尝试',
    }))!;
    expect(protectedSummary.markdown).toBe('# 人工修订的经验');
    expect(protectedSummary.entry.derivedFrom?.contentHash).toBe(changed.contentHash);
    await library.remove(owner, summary.entry.id);
    expect(await library.listDeletedIds(owner)).toContain(summary.entry.id);
    expect(await library.upsertSource(owner, summaryInput)).toBeNull();
  });

  it('skips unchanged Markdown during later scans but notices same-length edits even if mtime is restored', async () => {
    const record = (await library.upsertSource(owner, { ...source, markdown: 'AAAA' }))!;
    await library.reconcile(owner);
    const internal = library as unknown as {
      read: (base: string, file: string) => Promise<Buffer | null>;
    };
    const spy = vi.spyOn(internal, 'read');
    await library.reconcile(owner);
    expect(spy.mock.calls.some(([, file]) => file === record.entry.relativePath)).toBe(false);
    const path = join(library.ownerPath(owner), record.entry.relativePath);
    const before = await stat(path);
    await writeFile(path, '\uFEFFBBBB');
    await utimes(path, before.atime, before.mtime);
    spy.mockClear();
    await library.reconcile(owner);
    expect(spy.mock.calls.some(([, file]) => file === record.entry.relativePath)).toBe(true);
    const edited = await library.get(owner, record.entry.id);
    expect(edited?.markdown).toBe('BBBB');
    expect(edited?.entry.humanEdited).toBe(true);
  });

  it('recovers an abandoned process lock after restart', async () => {
    await library.upsertSource(owner, source);
    const pid = 2_147_483_647;
    expect(() => process.kill(pid, 0)).toThrow();
    await writeFile(
      join(library.ownerPath(owner), '.library/write.lock'),
      JSON.stringify({ pid, nonce: 'abandoned' })
    );
    const restarted = new KnowledgeLibrary(root);
    expect((await restarted.status(owner)).total).toBe(1);
    await expect(
      readFile(join(library.ownerPath(owner), '.library/write.lock'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists parsing progress across restarts and source refreshes without changing human edits', async () => {
    const input = { ...source, kind: 'document' as const };
    const record = (await library.upsertSource(owner, input))!;
    await library.putAttachment(owner, record.entry.id, {
      name: 'original.txt',
      bytes: Buffer.from('v1'),
    });
    expect((await library.get(owner, record.entry.id))?.entry.parseStatus).toBe('pending');
    await library.edit(owner, record.entry.id, '# 我的修订');
    expect(await library.markParsed(owner, record.entry.id, 'error', '解析器待恢复')).toBe(true);
    const restarted = new KnowledgeLibrary(root);
    expect((await restarted.get(owner, record.entry.id))?.entry).toMatchObject({
      parseStatus: 'error',
      parseMessage: '解析器待恢复',
      humanEdited: true,
    });
    expect(
      (await restarted.upsertSource(owner, { ...input, markdown: '# 来源变动' }))?.entry.parseStatus
    ).toBe('error');
    await restarted.markParsed(owner, record.entry.id, 'parsed');
    await restarted.putAttachment(owner, record.entry.id, {
      name: 'original.txt',
      bytes: Buffer.from('v1'),
    });
    expect((await restarted.get(owner, record.entry.id))?.entry.parseStatus).toBe('parsed');
    await restarted.putAttachment(owner, record.entry.id, {
      name: 'original.txt',
      bytes: Buffer.from('v2'),
    });
    const changed = await restarted.get(owner, record.entry.id);
    expect(changed?.entry).toMatchObject({ parseStatus: 'pending', humanEdited: true });
    expect(changed?.entry.parseMessage).toBeUndefined();
    expect(changed?.markdown).toBe('# 我的修订');
    await restarted.remove(owner, record.entry.id);
    expect(await restarted.markParsed(owner, record.entry.id, 'parsed')).toBe(false);
  });
});
