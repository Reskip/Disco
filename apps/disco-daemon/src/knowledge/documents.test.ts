import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeOwner } from '@disco/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractKnowledgeDocument } from './documents';
import { KnowledgeLibrary } from './library';

const owner: KnowledgeOwner = { tenantId: 'documents-tenant', userId: 'documents-owner' };

describe('knowledge document extraction', () => {
  let root: string;
  let library: KnowledgeLibrary;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'disco-kb-documents-'));
    library = new KnowledgeLibrary(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function document(name: string, bytes: Uint8Array, source: 'manual' | 'disco' = 'manual') {
    const detail = (await library.upsertSource(owner, {
      title: name,
      kind: 'document',
      source,
      sourceId: `upload:${name}`,
      markdown: '# 待解析',
      sourceUrl: '/uploads/ref/content',
      rawContent: '{"provenance":"original-upload"}\n',
    }))!;
    const attachment = (await library.putAttachment(owner, detail.entry.id, { name, bytes }))!;
    return { ...detail, attachment };
  }

  it('extracts complete UTF-8 text while retaining original bytes, identifiers and source metadata', async () => {
    const text = `# 原文\n\n${'完整资料'.repeat(280_000)}\n\n结尾也保留。`;
    const record = await document('文档.md', Buffer.from(text), 'disco');
    const result = await extractKnowledgeDocument(library, owner, record.entry.id);
    expect(result).toMatchObject({
      parsed: true,
      status: 'parsed',
      format: 'md',
      characters: text.length,
    });
    expect(result.detail?.entry).toMatchObject({
      id: record.entry.id,
      source: 'disco',
      sourceId: 'upload:文档.md',
      sourceUrl: '/uploads/ref/content',
      parseStatus: 'parsed',
    });
    expect(result.detail?.markdown).toContain(text);
    expect(result.detail?.markdown).toContain(`../${record.attachment.relativePath}`);
    expect(
      await readFile(join(library.ownerPath(owner), `sources/${record.entry.id}.jsonl`), 'utf8')
    ).toBe('{"provenance":"original-upload"}\n');
    expect(
      Buffer.from(
        (await library.getAttachment(owner, record.entry.id, record.attachment.id!))!.bytes
      ).toString()
    ).toBe(text);
  });

  it('supports manually uploaded documents without treating their initial placeholder as a human edit', async () => {
    const record = await document('uploaded.txt', Buffer.from('上传文档全文'));
    expect(record.entry.humanEdited).toBe(false);
    const parsed = await extractKnowledgeDocument(library, owner, record.entry.id);
    expect(parsed.parsed).toBe(true);
    expect(parsed.detail?.markdown).toContain('上传文档全文');
    expect(parsed.detail?.entry.humanEdited).toBe(false);
    await library.edit(owner, record.entry.id, '# 人工修订不要覆盖');
    const repeated = await extractKnowledgeDocument(library, owner, record.entry.id);
    expect(repeated.status).toBe('protected');
    expect(repeated.detail?.entry.parseStatus).toBe('parsed');
    expect(repeated.detail?.markdown).toBe('# 人工修订不要覆盖');
    expect(
      await readFile(join(library.ownerPath(owner), `sources/${record.entry.id}.md`), 'utf8')
    ).toContain('上传文档全文');
  });

  it('retains unknown and malformed files, and never claims their body was indexed', async () => {
    const binary = await document('unknown.custom', Buffer.from([0, 1, 2, 3]));
    const unsupported = await extractKnowledgeDocument(library, owner, binary.entry.id);
    expect(unsupported).toMatchObject({ parsed: false, status: 'unsupported' });
    expect(unsupported.detail?.entry.parseStatus).toBe('unsupported');
    expect(unsupported.detail?.markdown).toContain('正文尚不能检索');
    const malformed = await document('invalid.txt', Buffer.from([0xff, 0x98, 0]));
    const failure = await extractKnowledgeDocument(library, owner, malformed.entry.id);
    expect(failure).toMatchObject({ parsed: false, status: 'error' });
    expect(failure.detail?.entry.parseStatus).toBe('error');
    expect(Date.parse(failure.detail!.entry.parseRetryAt!)).toBeGreaterThan(
      Date.now() + 4 * 60_000
    );
    await library.putAttachment(owner, malformed.entry.id, {
      name: 'invalid.txt',
      bytes: Buffer.from('修复后的完整文本'),
    });
    const replaced = (await library.get(owner, malformed.entry.id))!;
    expect(replaced.entry.parseStatus).toBe('pending');
    expect(replaced.entry.parseRetryAt).toBeUndefined();
    expect((await extractKnowledgeDocument(library, owner, malformed.entry.id)).parsed).toBe(true);
    expect(
      (await library.openAttachment(owner, binary.entry.id, binary.attachment.id!))?.body.destroy()
    ).toBeDefined();
  });

  it('denies cross-user document parsing without invoking a parser or reading an attachment', async () => {
    const record = await document('secret.pdf', Buffer.from('private source'));
    const denied = await extractKnowledgeDocument(
      library,
      { tenantId: owner.tenantId, userId: 'other-user' },
      record.entry.id,
      { pythonExecutable: 'must-not-be-invoked' }
    );
    expect(denied).toMatchObject({ parsed: false, status: 'error' });
    expect(denied.detail).toBeUndefined();
    expect((await library.get(owner, record.entry.id))?.markdown).toBe('# 待解析');
  });

  it('feeds a subprocess only document bytes and the allowlisted format, then saves its complete result', async () => {
    const fixture = join(root, 'parser.cjs');
    await writeFile(
      fixture,
      `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => input += part); process.stdin.on('end', () => { if (process.argv[2] !== 'pdf' || process.argv.length !== 3) process.exit(2); process.stdout.write('解析正文\\n' + input + '\\n完整结尾'); });`
    );
    const record = await document('original.pdf', Buffer.from('original full bytes'));
    const parsed = await extractKnowledgeDocument(library, owner, record.entry.id, {
      pythonExecutable: process.execPath,
      scriptPath: fixture,
    });
    expect(parsed).toMatchObject({ parsed: true, status: 'parsed', format: 'pdf' });
    expect(parsed.detail?.markdown).toContain('解析正文\noriginal full bytes\n完整结尾');
  });

  it('reports parser startup failures while leaving the original downloadable', async () => {
    const record = await document('original.docx', Buffer.from('original bytes'));
    const result = await extractKnowledgeDocument(library, owner, record.entry.id, {
      pythonExecutable: join(root, 'missing-python.exe'),
    });
    expect(result).toMatchObject({ parsed: false, status: 'error' });
    expect(result.message).toContain('未能启动');
    expect((await new KnowledgeLibrary(root).get(owner, record.entry.id))?.entry.parseStatus).toBe(
      'error'
    );
    expect(
      Buffer.from(
        (await library.getAttachment(owner, record.entry.id, record.attachment.id!))!.bytes
      ).toString()
    ).toBe('original bytes');
  });

  it('extracts the latest attachment while retaining old originals, and records protected unsupported results correctly', async () => {
    const record = await document('latest.txt', Buffer.from('old text'));
    await extractKnowledgeDocument(library, owner, record.entry.id);
    const latest = (await library.putAttachment(owner, record.entry.id, {
      name: 'latest.txt',
      bytes: Buffer.from('new text'),
    }))!;
    const parsed = await extractKnowledgeDocument(library, owner, record.entry.id);
    expect(parsed.detail?.markdown).toContain('new text');
    expect(parsed.detail?.markdown).not.toContain('old text');
    expect(parsed.detail?.entry.attachments).toHaveLength(2);
    expect(parsed.detail?.markdown).toContain(latest.relativePath);
    await library.edit(owner, record.entry.id, '# 人工正文');
    await library.putAttachment(owner, record.entry.id, {
      name: 'unknown.binary',
      bytes: Buffer.from([0, 3, 9]),
    });
    const protectedResult = await extractKnowledgeDocument(library, owner, record.entry.id);
    expect(protectedResult.status).toBe('protected');
    expect(protectedResult.detail?.entry.parseStatus).toBe('unsupported');
    expect(protectedResult.detail?.markdown).toBe('# 人工正文');
  });
});
