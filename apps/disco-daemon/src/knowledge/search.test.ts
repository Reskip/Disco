import { createHash } from 'node:crypto';
import type { KnowledgeEntryDetail } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  fuseSearchRanks,
  isExactLookup,
  KnowledgeKeywordIndex,
  knowledgeSearchEvidence,
  searchableBody,
  searchExcerpt,
  searchTerms,
  technicalAnchors,
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
  it('anchors mixed code queries without requiring every compared symbol or treating brands as code', async () => {
    expect(technicalAnchors('如何解决 ResourceBusyError')).toEqual(['resourcebusyerror']);
    expect(technicalAnchors('如何解决 resourcebusyerror')).toEqual(['resourcebusyerror']);
    expect(technicalAnchors('node:sqlite 报错')).toEqual(['node:sqlite']);
    expect(technicalAnchors('Codex OpenAI GPU 2026 GPT-6-Astra GPT-6-Sol 对比')).toEqual([]);
    expect(technicalAnchors('Codex/ChatGPT 和 GPT-6-Sol/GPT-6-Astra 对比')).toEqual([]);
    expect(isExactLookup('Codex/ChatGPT')).toBe(false);
    expect(isExactLookup('GPT-6-Sol/GPT-6-Astra')).toBe(false);
    expect(searchTerms('Codex/ChatGPT')).toEqual(expect.arrayContaining(['codex', 'chatgpt']));
    expect(technicalAnchors('src/main.ts 启动失败')).toEqual(['src/main.ts']);
    expect(searchTerms('如何解决 ERR_MODULE_NOT_FOUND')).not.toContain('module');
    const error = document('error', '故障', '触发 ResourceBusyError，等待后可恢复。');
    const module = document('module', '内建模块', '启动时 ERR_MODULE_NOT_FOUND 来自 node:sqlite。');
    const other = document('other', '错误解决', '如何解决上传报错，记录原因。');
    const values = [error, module, other];
    const index = new KnowledgeKeywordIndex();
    const run = (query: string) =>
      index.search(
        'owner',
        values.map((v) => v.entry),
        new Set(values.map((v) => v.entry.id)),
        query,
        async (id) => values.find((v) => v.entry.id === id) ?? null,
        20
      );
    expect((await run('如何解决 ResourceBusyError')).map((hit) => hit.id)).toEqual(['error']);
    expect(
      new Set(
        (await run('ResourceBusyError 与 ERR_MODULE_NOT_FOUND 有何不同')).map((hit) => hit.id)
      )
    ).toEqual(new Set(['error', 'module']));
    expect(await run('如何解决 UnseenStorageQuotaError')).toEqual([]);
    expect(
      knowledgeSearchEvidence(
        document('prefix', '近似词', 'ResourceBusyErrorExtra'),
        '如何解决 ResourceBusyError'
      ).technical
    ).toBe(false);
  });

  it('masks only a matching automatic conversation header while preserving offsets and human material', () => {
    const text =
      '# Codex 会话 host-id\n\n来源：Codex 会话 host-id\n\n## user · 2026-10-23T00:00:00Z\n\n照片按年份存储。';
    const detail = document('host', 'Codex 会话 host-id', text);
    Object.assign(detail.entry, {
      source: 'codex',
      sourceId: 'host-id',
      kind: 'conversation',
      humanEdited: false,
    });
    expect(searchableBody(detail).length).toBe(text.length);
    expect(knowledgeSearchEvidence(detail, '上传切换会话').matched).toBe(0);
    expect(knowledgeSearchEvidence(detail, '照片').position).toBe(text.indexOf('照片'));
    const windows = { ...detail, markdown: `\uFEFF${text.replaceAll('\n', '\r\n')}` };
    expect(searchableBody(windows).length).toBe(windows.markdown.length);
    expect(knowledgeSearchEvidence(windows, '会话').matched).toBe(0);
    expect(knowledgeSearchEvidence(windows, '照片').position).toBe(
      windows.markdown.indexOf('照片')
    );
    const human = { ...detail, entry: { ...detail.entry, humanEdited: true } };
    expect(searchableBody(human)).toBe(text);
    const unrelated = { ...detail, entry: { ...detail.entry, sourceId: 'another-id' } };
    expect(searchableBody(unrelated)).toBe(text);
    const file = document(
      'image',
      '照片.jpg',
      '# 照片.jpg\n\n[原始文件：照片.jpg](original.jpg)\n原件已保存'
    );
    Object.assign(file.entry, { kind: 'document', source: 'codex', humanEdited: false });
    expect(searchableBody(file)).toBe(file.markdown);
    expect(knowledgeSearchEvidence(file, '照片.jpg').matched).toBeGreaterThan(0);
  });

  it('ranks locally concentrated Chinese evidence above scattered terms and labels metadata-only evidence', () => {
    const scattered = document(
      'scattered',
      '资料',
      `上传。${'无关正文。'.repeat(500)}切换。${'无关正文。'.repeat(500)}会话。`
    );
    const dense = document(
      'dense',
      '资料',
      `${'无关正文。'.repeat(500)}上传时切换会话，传输仍继续。`
    );
    const query = '上传切换会话';
    const good = knowledgeSearchEvidence(dense, query, 220);
    expect(good.score).toBeGreaterThan(knowledgeSearchEvidence(scattered, query, 220).score);
    expect(dense.markdown.slice(good.position, good.position! + 100)).toContain('上传时切换会话');
    const titleOnly = knowledgeSearchEvidence(
      document('title', '上传切换会话', '纯硬件内容'),
      query
    );
    expect(titleOnly.matched).toBe(0);
    expect(titleOnly.fieldMatches).toBeGreaterThan(0);
  });
  it('distinguishes exact technical identifiers from natural-language questions', () => {
    for (const query of ['ResourceBusyError', 'ERR_MODULE_NOT_FOUND', 'node:sqlite', 'C548'])
      expect(isExactLookup(query)).toBe(true);
    for (const query of ['文件上传为什么中断', 'backup', '如何解决 ResourceBusyError'])
      expect(isExactLookup(query)).toBe(false);
  });

  it('warms incrementally and shares document preparation with simultaneous searches', async () => {
    const record = document('one', '知识库', '人工笔记永久保存');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return record;
    });
    const index = new KnowledgeKeywordIndex();
    const entries = [record.entry];
    const ids = new Set(['one']);
    const warm = index.warm('owner', entries, ids, load);
    const search = index.search('owner', entries, ids, '笔记', load, 5);
    release();
    await warm;
    expect((await search)[0].id).toBe('one');
    expect(load).toHaveBeenCalledTimes(1);
    await index.warm('owner', entries, ids, load);
    expect(load).toHaveBeenCalledTimes(1);
    const next = document('one', '知识库', '修改为新结论', '2026-10-24T00:00:00Z');
    const changed = vi.fn(async () => next);
    await index.warm('owner', [next.entry], ids, changed);
    expect(await index.search('owner', [next.entry], ids, '笔记', changed, 5)).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
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
