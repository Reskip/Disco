import type { KnowledgeEntryDetail } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import {
  entrySnippetText,
  formatSummaryProgress,
  sourceReadingText,
} from './knowledgePresentation';

describe('server-attested source reading', () => {
  const marker = `<!-- disco-geospatial-projection:${JSON.stringify({ version: 1, format: 'gpx', sha256: 'a'.repeat(64), counts: { gpx: 1 } })} -->`;
  const detail: KnowledgeEntryDetail = {
    entry: {
      id: 'map-a',
      title: '地图资料',
      kind: 'document',
      source: 'manual',
      sourceId: 'map-a',
      createdAt: '',
      updatedAt: '',
      humanEdited: false,
      relativePath: 'documents/map-a.md',
      sizeBytes: 100,
      indexStatus: 'indexed',
      parseProjection: { kind: 'geospatial', version: 1, contentHash: 'full-hash' },
    },
    contentHash: 'full-hash',
    markdown: `# 原件\n\n${marker}\r\n## 地图概览\n描述`,
    page: { offset: 0, totalChars: 900, nextOffset: 400, hasMore: true },
  };

  it('hides only a complete attested marker without changing source text, offsets or hash', () => {
    expect(sourceReadingText(detail)).toBe('# 原件\n\n## 地图概览\n描述');
    expect(detail.markdown).toContain(marker);
    expect(detail.contentHash).toBe('full-hash');
    expect(detail.page?.nextOffset).toBe(400);
  });

  it('preserves missing or outdated attestations and human-maintained content', () => {
    expect(sourceReadingText({ ...detail, contentHash: 'new-hash' })).toBe(detail.markdown);
    expect(sourceReadingText({ ...detail, entry: { ...detail.entry, humanEdited: true } })).toBe(
      detail.markdown
    );
    expect(
      sourceReadingText({ ...detail, entry: { ...detail.entry, parseProjection: undefined } })
    ).toBe(detail.markdown);
  });

  it.each([
    marker.slice(0, -3),
    `${marker} 用户文字`,
    '<!-- disco-geospatial-projection:{invalid} -->',
    '<!-- 用户的注释 -->',
  ])('preserves partial, malformed and user-authored lines: %s', (markdown) => {
    expect(sourceReadingText({ ...detail, markdown })).toBe(markdown);
  });

  it('removes complete machine comments from previews while preserving normal surrounding text and comments', () => {
    const snippet = `正常前文\n${marker}\n<!-- 用户注释 -->\n正常后文`;
    const entry = {
      ...detail.entry,
      snippet,
      searchMatch: { offset: 200, contentHash: 'full-hash' },
    };
    expect(entrySnippetText(entry)).toBe('正常前文\n\n<!-- 用户注释 -->\n正常后文');
    expect(entry.snippet).toBe(snippet);
    expect(entry.searchMatch).toEqual({ offset: 200, contentHash: 'full-hash' });
  });

  it('hides a machine comment cut at the preview end and gives marker-only previews useful text', () => {
    const partial = marker.slice(0, 110);
    expect(entrySnippetText({ ...detail.entry, snippet: `# 原件\n${partial}` })).toBe('# 原件\n');
    expect(entrySnippetText({ ...detail.entry, snippet: partial })).toBe(
      '地图与轨迹资料，打开查看名称、描述和结构概览。'
    );
  });

  it('does not hide untrusted, human-edited, changed-version or unrelated preview content', () => {
    const entry = { ...detail.entry, snippet: marker };
    expect(entrySnippetText({ ...entry, parseProjection: undefined })).toBe(marker);
    expect(entrySnippetText({ ...entry, humanEdited: true })).toBe(marker);
    expect(entrySnippetText({ ...entry, searchMatch: { offset: 0, contentHash: 'changed' } })).toBe(
      marker
    );
    for (const snippet of [
      '普通用户文字',
      '<!-- 用户注释 -->',
      marker.slice(90),
      '<!-- disco-geospatial-projection:{invalid} -->',
      `${marker.slice(0, 110)}\n后续用户文字`,
    ]) {
      expect(entrySnippetText({ ...entry, snippet })).toBe(snippet);
    }
  });
});

describe('knowledge summary phase descriptions', () => {
  it('does not claim output exists while waiting for the first model response', () => {
    expect(
      formatSummaryProgress({ phase: 'waiting_model', stage: 'map', completed: 0, total: 1 })
    ).toBe('等待模型响应');
    expect(formatSummaryProgress({ phase: 'queued', stage: 'map', completed: 0, total: 1 })).toBe(
      '等待后台处理'
    );
  });

  it('keeps completed chunks distinct from the model response currently in flight', () => {
    expect(
      formatSummaryProgress({ phase: 'waiting_model', stage: 'map', completed: 3, total: 8 })
    ).toBe('已完成 3/8 段 · 等待模型响应');
    expect(
      formatSummaryProgress({ phase: 'processing', stage: 'map', completed: 0, total: 8 })
    ).toBe('正在准备资料 · 共 8 段');
  });

  it('identifies reduction as merging prior results rather than additional source chunks', () => {
    expect(
      formatSummaryProgress({ phase: 'waiting_model', stage: 'reduce', completed: 1, total: 2 })
    ).toBe('归并整理阶段 · 已完成 1/2 组归并 · 等待模型响应');
    expect(
      formatSummaryProgress({ phase: 'queued', stage: 'reduce', completed: 0, total: 1 })
    ).toBe('归并整理阶段 · 等待后台处理');
  });
});
