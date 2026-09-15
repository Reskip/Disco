import type { DiscoClient, Session, Task } from '@disco-live/client';
import { getQuestionReply } from '../../utils/questionReply';

/** The answer is already durable before this optional, non-interrupting handoff. */
export async function continueQuestionReply(
  client: DiscoClient,
  sessionId: string,
  widgetId: string
): Promise<void> {
  const session = (await client.service('sessions').get(sessionId)) as Session;
  if (session.agentic_tool !== 'codex' || session.status !== 'running') return;
  const queue = (await client.service(`/sessions/${sessionId}/tasks/queue`).find()) as {
    data: Task[];
  };
  const reply = queue.data.find(
    (task) =>
      task.session_id === sessionId &&
      task.status === 'queued' &&
      task.metadata?.widget_id === widgetId &&
      getQuestionReply(task)
  );
  if (!reply) return; // Admission/another tab may already have continued the task.
  // This existing route atomically claims the queued row before steering, and
  // handles a task completing concurrently. Never send a second copy of the text.
  await client
    .service(`/sessions/${sessionId}/tasks/queue-steer`)
    .create({ taskId: reply.task_id });
}
