import type { QuestionsParams } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import type { WidgetSubmitCtx } from '../registry.js';
import { questionsParamsSchema, questionsSubmitSchema, questionsWidget } from './index.js';

const params: QuestionsParams = {
  questions: [
    { id: 'mode', question: '采用哪种方案？', options: [{ label: '方案 A' }, { label: '方案 B' }] },
    { id: 'notes', question: '有哪些要求？' },
  ],
};
const ctx = {} as WidgetSubmitCtx;

describe('ordinary question answers', () => {
  it('returns the exact selected option and free text to the continuation', async () => {
    const result = questionsSubmitSchema.parse({
      answers: {
        mode: { selected: ['方案 B'], text: '' },
        notes: { selected: [], text: '保留原文件' },
      },
    });
    await questionsWidget.applySubmit(ctx, result, params);
    const prompt = questionsWidget.buildAutoResumePrompt(
      questionsWidget.buildResultMeta(result),
      params
    );
    expect(prompt).toContain('方案 B');
    expect(prompt).toContain('保留原文件');
    expect(prompt).toContain('不是对其他操作的授权');
  });

  it('validates against the saved questions instead of trusting submitted keys and choices', async () => {
    const good = {
      mode: { selected: ['方案 A'], text: '' },
      notes: { selected: [], text: '说明' },
    };
    for (const answers of [
      { mode: good.mode },
      { ...good, injected: good.mode },
      { ...good, mode: { selected: ['伪造选项'], text: '' } },
      { ...good, mode: { selected: ['方案 A', '方案 B'], text: '' } },
      { ...good, notes: { selected: [], text: '   ' } },
    ]) {
      await expect(questionsWidget.applySubmit(ctx, { answers }, params)).rejects.toThrow();
    }
  });

  it('allows multiple choices and a custom answer without selecting an option', async () => {
    await expect(
      questionsWidget.applySubmit(
        ctx,
        { answers: { mode: { selected: ['方案 A', '方案 B'], text: '分阶段' } } },
        { questions: [{ ...params.questions[0]!, multiSelect: true }] }
      )
    ).resolves.toBeUndefined();
    await expect(
      questionsWidget.applySubmit(
        ctx,
        { answers: { mode: { selected: [], text: '自己的方案' } } },
        { questions: [params.questions[0]!] }
      )
    ).resolves.toBeUndefined();
  });

  it('rejects ambiguous IDs and duplicate option labels, and never treats skipping as approval', () => {
    expect(
      questionsParamsSchema.safeParse({ questions: [params.questions[0], params.questions[0]] })
        .success
    ).toBe(false);
    expect(
      questionsParamsSchema.safeParse({
        questions: [{ id: 'x', question: 'Q', options: [{ label: 'A' }, { label: 'A' }] }],
      }).success
    ).toBe(false);
    expect(questionsParamsSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(
      questionsParamsSchema.safeParse({ questions: [{ id: 'constructor', question: 'Q' }] }).success
    ).toBe(false);
    expect(questionsWidget.buildDismissedPrompt(params)).toContain(
      '没有选择任何选项，也没有提供批准'
    );
  });
});
