import { createHash } from 'node:crypto';
import type { KnowledgeEntryDetail } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  fuseSearchRanks,
  KnowledgeKeywordIndex,
  searchExcerpt,
  searchTerms,
  verifiedSemanticPosition,
} from './search';

function document(
  id: string,
  title: string,
  markdown: string,
  version = '2026-10-23T00:00:00Z'
): KnowledgeEntryDetail {
  return {
    entry: {
      id,
      title,
      kind: 'note',
      source: 'manual',
      sourceId: id,
      createdAt: version,
      updatedAt: version,
      humanEdited: true,
      relativePath: `${id}.md`,
      sizeBytes: Buffer.byteLength(markdown),
      indexStatus: 'pending',
    },
    markdown,
    contentHash: createHash('sha256').update(markdown).digest('hex'),
  };
}

describe('knowledge retrieval acceptance', () => {
  it('recalls Chinese compounds and technical identifiers without depending on segmenter dictionary coverage', () => {
    expect(searchTerms('文件上传切换会话')).toEqual(
      expect.arrayContaining(['上传', '会话', '切换'])
    );
    expect(searchTerms('预览图 ERR_MODULE_NOT_FOUND node:sqlite')).toEqual(
      expect.arrayContaining(['预览', '览图', 'err_module_not_found', 'node:sqlite'])
    );
  });

  it('ranks reordered Chinese keywords and precise error codes against unrelated records', async () => {
    const values = [
      document('upload', '界面问题', '上传失败时应保留附件队列，切换会话页面不应取消。'),
      document(
        'sqlite',
        '模块解析',
        '启动报错 ERR_MODULE_NOT_FOUND，原因是 node:sqlite 前缀被移除。'
      ),
      document('travel', '上传旅行照片', '旅行照片保存到相册，不涉及网络故障。'),
    ];
    const load = vi.fn(async (id: string) => values.find((item) => item.entry.id === id) ?? null);
    const index = new KnowledgeKeywordIndex();
    const entries = values.map((item) => item.entry);
    const ids = new Set(entries.map((entry) => entry.id));
    expect(
      (await index.search('tenant-a/user-a', entries, ids, '失败 附件 上传', load, 5))[0].id
    ).toBe('upload');
    expect(
      (await index.search('tenant-a/user-a', entries, ids, 'ERR_MODULE_NOT_FOUND', load, 5))[0].id
    ).toBe('sqlite');
    expect(await index.search('tenant-a/user-a', entries, ids, '量子奶茶退火', load, 5)).toEqual(
      []
    );
    expect(
      await index.search('tenant-a/user-a', entries, ids, 'ERR_UNSEEN_MODULE', load, 5)
    ).toEqual([]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('keeps same IDs from different owners separate and refreshes a human edit', async () => {
    const index = new KnowledgeKeywordIndex();
    let first = document('same-id', '甲', '预览图永久保留');
    const second = document('same-id', '乙', '乙的独有秘密');
    const loadA = vi.fn(async () => first);
    const loadB = vi.fn(async () => second);
    const ids = new Set(['same-id']);
    expect(await index.search('tenant-a/user-a', [first.entry], ids, '秘密', loadA, 5)).toEqual([]);
    expect(
      await index.search('tenant-a/user-b', [second.entry], ids, '秘密', loadB, 5)
    ).toHaveLength(1);
    first = document(
      'same-id',
      '甲',
      '人工已删除所有预览规则，仅保留下载说明',
      '2026-10-23T01:00:00Z'
    );
    expect(await index.search('tenant-a/user-a', [first.entry], ids, '永久', loadA, 5)).toEqual([]);
    expect(
      await index.search('tenant-a/user-a', [first.entry], ids, '下载说明', loadA, 5)
    ).toHaveLength(1);
    expect(loadA).toHaveBeenCalledTimes(2);
    expect(await index.search('tenant-a/user-a', [], new Set(), '下载', loadA, 5)).toEqual([]);
  });

  it('locates semantic paraphrase queries deep in the current original instead of showing the introduction', () => {
    const text =
      '# 资料\n' +
      '这里是无关的开头。'.repeat(1000) +
      '\n附件传输由独立队列管理，页面导航不会终止传输。\n';
    const detail = document('deep', '上传行为', text);
    const content = '附件传输由独立队列管理，页面导航不会终止传输。';
    const position = verifiedSemanticPosition(text, content)!;
    const result = searchExcerpt(detail, '切换页面上传不中断', 'semantic', {
      position,
      length: content.length,
    });
    expect(position).toBeGreaterThan(5000);
    expect(result.excerpt).toContain(content);
    expect(result.excerpt).toBe(text.slice(result.match.start, result.match.end));
    expect(result.match.contentHash).toBe(detail.contentHash);
    expect(verifiedSemanticPosition(text, '伪造内容或旧版已删除的句子')).toBeUndefined();
  });

  it('chooses a dense relevant passage over a repeated generic introduction', () => {
    const text = `${'附件目录。'.repeat(1000)}\n上传失败之后，附件仍然保留，页面切换不会取消。\n`;
    const detail = document('dense', '说明', text);
    const result = searchExcerpt(detail, '附件 上传 失败 切换', 'keyword');
    expect(result.excerpt).toContain('上传失败之后');
    expect(result.match.start).toBeGreaterThan(3000);
    expect(result.excerpt).toBe(text.slice(result.match.start, result.match.end));
  });

  it('fuses independent rankings without amplifying repeated chunks from one document', () => {
    const ranked = fuseSearchRanks(
      ['semantic', 'both', 'semantic', 'semantic'],
      ['keyword', 'both']
    );
    expect(ranked[0].id).toBe('both');
    expect(ranked).toHaveLength(3);
    expect(ranked.find((value) => value.id === 'semantic')!.score).toBeCloseTo(1 / 61);
  });

  it('keeps source offsets correct when Unicode case conversion changes character count', () => {
    const detail = document('unicode', '定位', `${'İ'.repeat(3000)}\nERR_MODULE_NOT_FOUND`);
    const result = searchExcerpt(detail, 'err_module_not_found', 'keyword');
    expect(result.excerpt).toContain('ERR_MODULE_NOT_FOUND');
    expect(result.excerpt).toBe(detail.markdown.slice(result.match.start, result.match.end));
    expect(result.match.end).toBeLessThanOrEqual(detail.markdown.length);
  });
});
