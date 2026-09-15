import type { Message, QuestionAnswer, Task, UserQuestion } from '@disco-live/client';

type QuestionReplyAnswer = Pick<UserQuestion, 'question'> & QuestionAnswer;
export type QuestionReply =
  | { status: 'submitted'; answers: QuestionReplyAnswer[] }
  | { status: 'dismissed' };

// The daemon keeps this continuation prompt for the model. Project the known
// wire format into readable UI text without rewriting the transcript or making
// ordinary user-pasted JSON look like an answer submitted through a widget.
const ANSWER_PREFIX =
  '[Disco] 用户已回答本次问题，请依据以下回答继续原任务。回答只针对对应问题，不是对其他操作的授权。\n';
const DISMISSED_PROMPT =
  '[Disco] 用户跳过了本次提问，没有选择任何选项，也没有提供批准。请继续可独立完成的工作；不要假定答案或立即重复提问。';

export function getQuestionReply(
  task: Pick<Task, 'full_prompt' | 'metadata'>
): QuestionReply | null {
  if (task.metadata?.system_authored !== true || !task.metadata.widget_id) return null;
  const prompt = task.full_prompt;
  if (prompt === DISMISSED_PROMPT) return { status: 'dismissed' };
  if (!prompt?.startsWith(ANSWER_PREFIX)) return null;
  try {
    const rows: unknown = JSON.parse(prompt.slice(ANSWER_PREFIX.length));
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const answers: QuestionReplyAnswer[] = [];
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        Object.keys(row).length !== 3 ||
        typeof row.question !== 'string' ||
        !row.question.trim() ||
        typeof row.answer !== 'string' ||
        !Array.isArray(row.selected) ||
        !row.selected.every((label: unknown) => typeof label === 'string')
      ) {
        return null;
      }
      answers.push({ question: row.question, selected: row.selected, text: row.answer });
    }
    return { status: 'submitted', answers };
  } catch {
    // Unknown/malformed future formats remain visible as their original text.
    return null;
  }
}

export function questionAnswerText(answer: QuestionAnswer): string {
  return [...answer.selected, answer.text].filter(Boolean).join('\n');
}

export function formatQuestionReply(reply: QuestionReply): string {
  if (reply.status === 'dismissed') return '已跳过本次提问';
  return reply.answers
    .map((answer) => `问题：${answer.question}\n回答：${questionAnswerText(answer)}`)
    .join('\n\n');
}

export function taskPromptDisplayText(task: Pick<Task, 'full_prompt' | 'metadata'>): string {
  const reply = getQuestionReply(task);
  return reply ? formatQuestionReply(reply) : task.full_prompt || '';
}

export function isInitialQuestionReplyMessage(task: Task, message: Message): boolean {
  if (message.role !== 'user' || message.task_id !== task.task_id) return false;
  // Older deployments put the widget identity only on the Task, not the
  // initial user Message. Its persisted identity still gives an exact match.
  return task.metadata?.initial_message_id
    ? message.message_id === task.metadata.initial_message_id
    : message.index === task.message_range.start_index;
}
