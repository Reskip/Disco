import type { KnowledgeEntry } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import { knowledgeExportGuide } from './export-catalog';

const entry = (
  id: string,
  title: string,
  changes: Partial<KnowledgeEntry> = {}
): KnowledgeEntry => ({
  id,
  title,
  kind: 'note',
  source: 'manual',
  sourceId: id,
  createdAt: '2026-10-23T00:00:00Z',
  updatedAt: '2026-10-23T00:00:00Z',
  relativePath: `notes/${id}.md`,
  sizeBytes: 30,
  humanEdited: true,
  indexStatus: 'indexed',
  ...changes,
});

describe('portable knowledge export guide', () => {
  it('organizes notes by topic and originals by format with local provenance and attachment links', () => {
    const original = entry('source', '索引排障记录', {
      kind: 'conversation',
      source: 'codex',
      relativePath: 'conversations/source.md',
      attachments: [
        { id: 'asset', name: '原始记录.txt', relativePath: 'assets/source/record.txt' },
      ],
    });
    const note = entry('note', '稳定索引的方法', {
      organization: {
        topic: '软件与系统',
        level: 'knowledge',
        state: 'reviewed',
        sourceEntryIds: ['source'],
      },
      sourceReferences: [
        { id: 'source', title: original.title, contentHash: 'baseline' },
        { id: 'deleted', title: '已撤回的旧资料', contentHash: 'old' },
      ],
    });
    const image = entry('image', '示意图.png', {
      kind: 'document',
      relativePath: 'documents/image.md',
      parseStatus: 'unsupported',
      attachments: [
        {
          id: 'image-file',
          name: '示意图.png',
          mimeType: 'image/png',
          relativePath: 'assets/image/image.png',
        },
      ],
    });
    const historical = entry('old', '旧归档', { historical: true });
    const files = new Set([
      original.relativePath,
      note.relativePath,
      image.relativePath,
      historical.relativePath,
      'assets/source/record.txt',
      'assets/image/image.png',
    ]);
    const before = JSON.stringify([original, note, image, historical]);
    const guides = knowledgeExportGuide(
      [original, note, image, historical],
      files,
      '2026-10-23T00:00:00Z'
    );
    const catalog = guides.find((guide) => guide.path === '资料目录.md')!.markdown;
    expect(catalog).toContain('1 篇知识笔记、2 份原始资料和 1 份历史归档版本');
    expect(catalog).toContain('### 软件与系统');
    expect(catalog).toContain('[稳定索引的方法](notes/note.md) · 知识 · 人工维护 · 已确认');
    expect(catalog).toContain('整理来源：[索引排障记录](conversations/source.md)');
    expect(catalog).toContain('整理来源：已撤回的旧资料（已删除）');
    expect(catalog).toContain('原件：[原始记录.txt](assets/source/record.txt)');
    expect(catalog).toContain('## 图片（1）');
    expect(catalog).toContain('仅文件信息可检索');
    expect(catalog.indexOf('[旧归档]')).toBeGreaterThan(catalog.indexOf('## 历史归档版本'));
    expect(guides[0].markdown).toContain('`.library/`');
    expect(JSON.stringify([original, note, image, historical])).toBe(before);
  });

  it('escapes untrusted Markdown labels and URI punctuation without producing external links', () => {
    const malicious = entry('special', '[点击](javascript:alert(1)) <img>\n## 注入', {
      relativePath: 'notes/a(b)#c?.md',
      organization: { topic: '标题\n## 第二级', level: 'knowledge', state: 'draft' },
      attachments: [
        { id: 'unsafe', name: '[危险](https://example.invalid)', relativePath: '../outside.md' },
      ],
    });
    const catalog = knowledgeExportGuide(
      [malicious],
      new Set([malicious.relativePath, '../outside.md']),
      'now'
    )[1].markdown;
    expect(catalog).toContain('(notes/a%28b%29%23c%3F.md)');
    expect(catalog).toContain('\\[点击\\](javascript:alert(1)) \\<img\\> \\#\\# 注入');
    expect(catalog).not.toContain('\n## 第二级');
    expect(catalog).not.toContain('](../outside.md)');
    expect(catalog).not.toContain('[危险](https://example.invalid)');
  });

  it('does not create broken links for absent Markdown or attachments', () => {
    const missing = entry('missing', '文件仍有元数据', {
      attachments: [{ id: 'gone', name: '已丢失.pdf', relativePath: 'assets/missing/gone.pdf' }],
    });
    const catalog = knowledgeExportGuide([missing], new Set(), 'now')[1].markdown;
    expect(catalog).toContain('Markdown 归档文件缺失');
    expect(catalog).toContain('原件：已丢失.pdf（文件缺失）');
    expect(catalog).not.toContain('](notes/');
    expect(catalog).not.toContain('](assets/');
  });
});
