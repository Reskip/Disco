import { describe, expect, it } from 'vitest';
import {
  formatFileCitationLocator,
  parseCodexFileCitations,
  replaceCodexFileCitations,
} from './file-citation';

describe('Codex file citation contract', () => {
  it('parses PDF, workbook, presentation, and document locators', () => {
    const text = [
      ':codex-file-citation{path="C:\\\\work\\\\source.pdf" purpose="source" artifact_kind="pdf" page_number="4"}',
      ':codex-file-citation{path="C:\\\\work\\\\book.xlsx" purpose="source" artifact_kind="workbook" sheet="Revenue Model" range="C27"}',
      ':codex-file-citation{path="C:\\\\work\\\\deck.pptx" purpose="source" artifact_kind="presentation" slide_number="3" slide_id="sl/one" object_id="ch/two" label="ARR chart"}',
      ':codex-file-citation{path="C:\\\\work\\\\result.docx" purpose="output" artifact_kind="document"}',
    ].join('\n');

    const parsed = parseCodexFileCitations(text);

    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({
      path: 'C:\\work\\source.pdf',
      purpose: 'source',
      locator: { artifactKind: 'pdf', pageNumber: 4 },
    });
    expect(parsed[1]?.locator).toMatchObject({ sheet: 'Revenue Model', range: 'C27' });
    expect(parsed[2]?.locator).toMatchObject({
      slideNumber: 3,
      slideId: 'sl/one',
      objectId: 'ch/two',
      label: 'ARR chart',
    });
    expect(parsed[3]).toMatchObject({ purpose: 'output' });
    expect(formatFileCitationLocator(parsed[2]?.locator)).toBe(
      'ARR chart · 第 3 页幻灯片 · ch/two'
    );
  });

  it('removes protocol syntax while preserving prose and a readable replacement', () => {
    const input =
      '已创建 :codex-file-citation{path="E:/out/report.pdf" purpose="output"}，请查收。';

    expect(replaceCodexFileCitations(input, () => 'report.pdf')).toBe(
      '已创建 report.pdf，请查收。'
    );
  });

  it('scrubs malformed completed directives instead of exposing protocol text', () => {
    const input = '结果 :codex-file-citation{path="E:/out/report.pdf" purpose="wrong"}。';

    expect(parseCodexFileCitations(input)).toEqual([]);
    expect(replaceCodexFileCitations(input, () => '')).toBe('结果 （文件引用无法解析）。');
  });

  it('parses Codex visualize directives as output citations with presentation metadata', () => {
    const input =
      '路线如下：visualize{"path":"E:/out/run-route-map.html","title":"湖滨 5K 跑步轨迹","mode":"wide"} 请查看。';

    const parsed = parseCodexFileCitations(input);

    expect(parsed).toEqual([
      expect.objectContaining({
        path: 'E:/out/run-route-map.html',
        purpose: 'output',
        locator: { artifactKind: 'visualization', label: '湖滨 5K 跑步轨迹' },
        presentation: {
          type: 'visualization',
          mode: 'wide',
          title: '湖滨 5K 跑步轨迹',
        },
      }),
    ]);
    expect(replaceCodexFileCitations(input, (citation) => citation.presentation?.title ?? '')).toBe(
      '路线如下：湖滨 5K 跑步轨迹 请查看。'
    );
  });

  it('preserves source order when normal file and visualization directives are mixed', () => {
    const input = [
      ':codex-file-citation{path="E:/out/report.pdf" purpose="output"}',
      '中间',
      'visualize{"path":"E:/out/chart.html","title":"趋势图"}',
    ].join(' ');

    const parsed = parseCodexFileCitations(input);

    expect(parsed.map((item) => item.path)).toEqual(['E:/out/report.pdf', 'E:/out/chart.html']);
    expect(parsed[1]?.presentation).toMatchObject({ type: 'visualization', mode: 'normal' });
  });

  it('scrubs invalid visualization directives instead of leaking local paths', () => {
    const input = '结果 visualize{"path":"E:/private/map.html","mode":"invalid"}。';

    expect(parseCodexFileCitations(input)).toEqual([]);
    const visible = replaceCodexFileCitations(input, () => '');
    expect(visible).toBe('结果 （可视化无法解析）。');
    expect(visible).not.toContain('E:/private');
  });
});
