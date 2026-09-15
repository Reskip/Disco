import type { Message, Task } from '@disco-live/client';
import { describe, expect, it } from 'vitest';
import {
  formatQuestionReply,
  getQuestionReply,
  isInitialQuestionReplyMessage,
  taskPromptDisplayText,
} from './questionReply';

const prefix =
  '[Disco] 用户已回答本次问题，请依据以下回答继续原任务。回答只针对对应问题，不是对其他操作的授权。\n';
const task = {
  task_id: 'task-1',
  full_prompt: '',
  metadata: { system_authored: true, widget_id: 'widget-1', initial_message_id: 'reply-1' },
  message_range: { start_index: 10 },
} as Task;

describe('question reply presentation', () => {
  it('preserves choices, free text and literal characters without exposing the continuation protocol', () => {
    const rows = [
      { question: '采用哪种方案？', selected: ['方案 B'], answer: '' },
      {
        question: '需要哪些功能？',
        selected: ['导入', '导出'],
        answer: '分阶段进行\n保留原文件 🙂',
      },
      {
        question: '还有什么要求？',
        selected: [],
        answer: '原样保留 &#x20;、<file> 和 "引号"\n第二行',
      },
    ];
    const saved = { ...task, full_prompt: prefix + JSON.stringify(rows, null, 2) };
    const original = saved.full_prompt;
    const reply = getQuestionReply(saved);
    expect(reply).toEqual({
      status: 'submitted',
      answers: rows.map(({ question, selected, answer }) => ({ question, selected, text: answer })),
    });
    const display = taskPromptDisplayText(saved);
    expect(display).toBe(
      '问题：采用哪种方案？\n回答：方案 B\n\n' +
        '问题：需要哪些功能？\n回答：导入\n导出\n分阶段进行\n保留原文件 🙂\n\n' +
        '问题：还有什么要求？\n回答：原样保留 &#x20;、<file> 和 "引号"\n第二行'
    );
    expect(display).not.toContain('[Disco]');
    expect(display).not.toContain('"selected"');
    expect(saved.full_prompt).toBe(original);
  });

  it('does not reinterpret ordinary pasted text or unknown protocol shapes', () => {
    const full_prompt = prefix + JSON.stringify([{ question: 'Q', selected: [], answer: 'A' }]);
    for (const metadata of [undefined, {}, { widget_id: 'widget-1' }, { system_authored: true }]) {
      const ordinary = { ...task, full_prompt, metadata } as Task;
      expect(getQuestionReply(ordinary)).toBeNull();
      expect(taskPromptDisplayText(ordinary)).toBe(full_prompt);
    }
    for (const payload of [
      '[invalid',
      '{}',
      '[]',
      '[null]',
      '[{"question":"Q","selected":"A","answer":""}]',
      '[{"question":"Q","selected":[1],"answer":""}]',
      '[{"question":"Q","selected":[],"answer":"A","newField":"important"}]',
    ]) {
      const unknown = { ...task, full_prompt: prefix + payload };
      expect(getQuestionReply(unknown)).toBeNull();
      expect(taskPromptDisplayText(unknown)).toBe(unknown.full_prompt);
    }
    expect(getQuestionReply({ ...task, full_prompt: 'ordinary prompt' })).toBeNull();
  });

  it('shows skipping clearly while retaining the original model instructions', () => {
    const saved = {
      ...task,
      full_prompt:
        '[Disco] 用户跳过了本次提问，没有选择任何选项，也没有提供批准。请继续可独立完成的工作；不要假定答案或立即重复提问。',
    };
    expect(getQuestionReply(saved)).toEqual({ status: 'dismissed' });
    expect(formatQuestionReply({ status: 'dismissed' })).toBe('已跳过本次提问');
    expect(saved.full_prompt).toContain('没有提供批准');
  });

  it('matches only the initial user message, including older Task-only widget metadata', () => {
    const message = {
      message_id: 'reply-1',
      task_id: task.task_id,
      role: 'user',
      index: 10,
      metadata: { source: 'disco' },
    } as Message;
    expect(isInitialQuestionReplyMessage(task, message)).toBe(true);
    expect(isInitialQuestionReplyMessage(task, { ...message, role: 'assistant' })).toBe(false);
    expect(
      isInitialQuestionReplyMessage(task, { ...message, message_id: 'steering' as never })
    ).toBe(false);
    expect(
      isInitialQuestionReplyMessage(task, { ...message, task_id: 'another-task' as never })
    ).toBe(false);
    const legacy = { ...task, metadata: { ...task.metadata, initial_message_id: undefined } };
    expect(isInitialQuestionReplyMessage(legacy, message)).toBe(true);
    expect(isInitialQuestionReplyMessage(legacy, { ...message, index: 11 })).toBe(false);
  });
});
