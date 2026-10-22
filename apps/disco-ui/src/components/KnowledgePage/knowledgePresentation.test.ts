import { describe, expect, it } from 'vitest';
import { formatSummaryProgress } from './knowledgePresentation';

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
