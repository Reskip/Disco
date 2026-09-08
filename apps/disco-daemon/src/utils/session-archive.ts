import { Conflict } from '@disco/core/feathers';
export interface ArchiveStopResult {
  success: boolean;
  reason?: string;
  stoppedTaskId?: string;
}

export async function archiveSessionNow<TResult extends object>(options: {
  stop: () => Promise<ArchiveStopResult>;
  findQueuedTasks: () => Promise<Array<{ task_id: string }>>;
  removeQueuedTask: (taskId: string) => Promise<unknown>;
  archive: () => Promise<TResult>;
}): Promise<TResult & { stoppedTaskId?: string; discardedQueuedTasks: number }> {
  const stopResult = await options.stop();
  if (!stopResult.success) {
    throw new Conflict(stopResult.reason ?? 'The running task could not be stopped.');
  }

  const queuedTasks = await options.findQueuedTasks();
  for (const queuedTask of queuedTasks) {
    await options.removeQueuedTask(queuedTask.task_id);
  }

  return {
    ...(await options.archive()),
    stoppedTaskId: stopResult.stoppedTaskId,
    discardedQueuedTasks: queuedTasks.length,
  };
}
