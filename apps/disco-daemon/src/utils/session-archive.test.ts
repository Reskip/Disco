import type { TaskID } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import { archiveSessionNow } from './session-archive';

describe('archiveSessionNow', () => {
  it('stops first, discards every queued turn, then archives', async () => {
    const calls: string[] = [];
    const result = await archiveSessionNow({
      stop: async () => {
        calls.push('stop');
        return { success: true, stoppedTaskId: 'running-task' as TaskID };
      },
      findQueuedTasks: async () => {
        calls.push('find-queue');
        return [{ task_id: 'queued-1' as TaskID }, { task_id: 'queued-2' as TaskID }];
      },
      removeQueuedTask: async (taskId) => {
        calls.push(`remove:${taskId}`);
      },
      archive: async () => {
        calls.push('archive');
        return { count: 1 };
      },
    });

    expect(calls).toEqual(['stop', 'find-queue', 'remove:queued-1', 'remove:queued-2', 'archive']);
    expect(result).toEqual({
      count: 1,
      stoppedTaskId: 'running-task',
      discardedQueuedTasks: 2,
    });
  });

  it('does not delete queued work or archive when stopping fails', async () => {
    const removeQueuedTask = vi.fn();
    const archive = vi.fn();

    await expect(
      archiveSessionNow({
        stop: async () => ({ success: false, reason: 'executor did not stop' }),
        findQueuedTasks: async () => [{ task_id: 'queued-1' as TaskID }],
        removeQueuedTask,
        archive,
      })
    ).rejects.toThrow('executor did not stop');
    expect(removeQueuedTask).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });
});
