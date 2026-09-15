import type {
  Message,
  QuestionAnswer,
  QuestionsParams,
  QuestionsResult,
  Task,
  UserQuestion,
} from '@disco-live/client';

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
  task: Pick<Task, 'full_prompt' | 'metadata'> & Partial<Pick<Task, 'session_id'>>,
  questionWidgets: Message[] = []
): QuestionReply | null {
  const reply = parseQuestionReply(task.full_prompt);
  if (!reply) return null;
  if (task.metadata?.system_authored === true && task.metadata.widget_id) return reply;
  // queue-steer can fall back to a new task if the original task just ended.
  // Older daemons drop widget metadata in that path; verify the entire answer
  // against its persisted card before projecting that task's prompt.
  return task.metadata?.source === 'disco' &&
    reply.status === 'submitted' &&
    matchesSubmittedQuestionWidget(reply, task.session_id, questionWidgets)
    ? reply
    : null;
}

function parseQuestionReply(prompt: string | undefined): QuestionReply | null {
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

function matchesSubmittedQuestionWidget(
  reply: Extract<QuestionReply, { status: 'submitted' }>,
  sessionId: string | undefined,
  questionWidgets: Message[]
): boolean {
  if (!sessionId) return false;
  return questionWidgets.some((candidate) => {
    const widget = candidate.metadata?.widget;
    if (
      candidate.type !== 'widget_request' ||
      candidate.session_id !== sessionId ||
      widget?.widget_type !== 'questions' ||
      widget.status !== 'submitted'
    )
      return false;
    const params = widget.params as QuestionsParams;
    const result = widget.result_meta as QuestionsResult | undefined;
    return (
      Array.isArray(params?.questions) &&
      params.questions.length === reply.answers.length &&
      params.questions.every((question, index) => {
        const saved = result?.answers?.[question.id];
        const answer = reply.answers[index]!;
        return (
          saved &&
          answer.question === question.question &&
          answer.text === saved.text &&
          JSON.stringify(answer.selected) === JSON.stringify(saved.selected)
        );
      })
    );
  });
}

/** Match older queue-to-steer messages against the saved card, not the prefix alone. */
export function isQuestionReplyRepresentedByWidget(
  message: Message,
  questionWidgets: Message[]
): boolean {
  if (
    message.role !== 'user' ||
    message.metadata?.source !== 'disco' ||
    message.metadata.steering_failed ||
    typeof message.content !== 'string'
  )
    return false;
  const reply = parseQuestionReply(message.content);
  if (!reply) return false;
  if (reply.status === 'submitted') {
    return matchesSubmittedQuestionWidget(reply, message.session_id, questionWidgets);
  }
  // Skips have identical text, so require steering provenance and a dismissed
  // card in this same task instead of matching an arbitrary older card.
  return (
    message.metadata.is_steering_hint === true &&
    questionWidgets.some((candidate) => {
      const widget = candidate.metadata?.widget;
      return (
        candidate.type === 'widget_request' &&
        candidate.session_id === message.session_id &&
        candidate.task_id === message.task_id &&
        widget?.widget_type === 'questions' &&
        widget.status === 'dismissed'
      );
    })
  );
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
    : message.index === task.message_range?.start_index;
}
