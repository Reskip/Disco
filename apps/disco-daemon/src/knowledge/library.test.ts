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
