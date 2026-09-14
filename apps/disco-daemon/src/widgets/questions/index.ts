import { BadRequest } from '@disco/core/feathers';
import type { QuestionsParams, QuestionsResult } from '@disco/core/types';
import { z } from 'zod';
import { registerWidget, type WidgetRegistryEntry } from '../registry.js';

export const questionsParamsSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-zA-Z0-9_-]{1,64}$/u)
              .refine((id) => !Object.hasOwn(Object.prototype, id), 'Reserved question ID'),
            question: z.string().trim().min(1).max(2000),
            header: z.string().trim().min(1).max(40).optional(),
            options: z
              .array(
                z
                  .object({
                    label: z.string().trim().min(1).max(200),
                    description: z.string().trim().max(500).optional(),
                  })
                  .strict()
              )
              .max(6)
              .optional(),
            multiSelect: z.boolean().optional(),
          })
          .strict()
      )
      .min(1)
      .max(3),
  })
  .strict()
  .superRefine(({ questions }, ctx) => {
    if (new Set(questions.map((q) => q.id)).size !== questions.length) {
      ctx.addIssue({ code: 'custom', message: 'Question IDs must be unique' });
    }
    for (const question of questions) {
      const options = question.options ?? [];
      if (new Set(options.map((option) => option.label)).size !== options.length) {
        ctx.addIssue({ code: 'custom', message: 'Option labels must be unique' });
      }
    }
  });

export const questionsSubmitSchema = z
  .object({
    answers: z.record(
      z.string(),
      z
        .object({
          selected: z.array(z.string().max(200)).max(6),
          text: z.string().trim().max(6000),
        })
        .strict()
    ),
  })
  .strict();

export const questionsWidget: WidgetRegistryEntry<
  QuestionsParams,
  QuestionsResult,
  QuestionsResult
> = {
  type: 'questions',
  schemaVersion: 1,
  paramsSchema: questionsParamsSchema,
  submitSchema: questionsSubmitSchema,
  buildResultMeta: (result) => result,
  applySubmit: async (_ctx, result, params) => {
    const expected = new Set(params.questions.map((question) => question.id));
    if (
      Object.keys(result.answers).length !== expected.size ||
      Object.keys(result.answers).some((id) => !expected.has(id))
    ) {
      throw new BadRequest('请回答本次提出的全部问题。');
    }
    for (const question of params.questions) {
      const answer = result.answers[question.id];
      const allowed = new Set((question.options ?? []).map((option) => option.label));
      if (
        !answer ||
        (!answer.selected.length && !answer.text.trim()) ||
        (!question.multiSelect && answer.selected.length > 1) ||
        new Set(answer.selected).size !== answer.selected.length ||
        answer.selected.some((label) => !allowed.has(label))
      ) {
        throw new BadRequest('请选择有效选项或填写自己的答案。');
      }
    }
  },
  buildAutoResumePrompt: (result, params) =>
    `[Disco] 用户已回答本次问题，请依据以下回答继续原任务。回答只针对对应问题，不是对其他操作的授权。\n${JSON.stringify(
      params.questions.map((question) => ({
        question: question.question,
        selected: result.answers[question.id]?.selected ?? [],
        answer: result.answers[question.id]?.text ?? '',
      })),
      null,
      2
    )}`,
  buildDismissedPrompt: () =>
    '[Disco] 用户跳过了本次提问，没有选择任何选项，也没有提供批准。请继续可独立完成的工作；不要假定答案或立即重复提问。',
};

export function registerQuestionsWidget(): void {
  registerWidget(questionsWidget);
}
