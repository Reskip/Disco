import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRepository, TaskRepository, UsersRepository } from '@disco/core/db';
import { TaskStatus } from '@disco/core/types';
import { afterEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { WorkspaceStorageMaintenance } from './workspace-storage-maintenance';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('@disco/core/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorktreesRoot: () => state.root,
}));
afterEach(async () => {
  vi.useRealTimers();
  if (state.root) await rm(state.root, { recursive: true, force: true });
  state.root = '';
});

dbTest(
  'background cleanup respects stored per-owner preferences and active work in any session',
  async ({ db }) => {
    state.root = await mkdtemp(join(tmpdir(), 'disco-storage-worker-'));
    const users = new UsersRepository(db);
    const active = await users.create({ username: 'active-owner', name: 'active' });
    const disabled = await users.create({
      username: 'disabled-owner',
      name: 'disabled',
      preferences: { storage: { intermediateRetentionDays: 0 } },
    });
    const files = [active, disabled].map((owner) =>
      join(state.root, `user-${owner.user_id}`, 'standalone', 'old', '.disco', 'tmp', 'preview.png')
    );
    for (const file of files) {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'intermediate');
    }
    const session = await new SessionRepository(db).create({
      created_by: active.user_id,
      agentic_tool: 'codex',
    });
    const tasks = new TaskRepository(db);
    const task = await tasks.create({
      created_by: active.user_id,
      session_id: session.session_id,
      full_prompt: 'work',
      status: TaskStatus.RUNNING,
    });
    const worker = new WorkspaceStorageMaintenance(db as never, {});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 8 * 86400_000));
    worker.start();
    try {
      await worker.runOnce();
      for (const file of files) expect(await readFile(file, 'utf8')).toBe('intermediate');
      await tasks.update(task.task_id, { status: TaskStatus.COMPLETED });
      await worker.runOnce();
      await expect(readFile(files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(files[1]!, 'utf8')).toBe('intermediate');
    } finally {
      await worker.stop();
    }
  }
);

dbTest(
  'auth-resolved tenants and remote executor templates never trigger a local filesystem sweep',
  async ({ db }) => {
    state.root = await mkdtemp(join(tmpdir(), 'disco-storage-worker-'));
    for (const config of [
      { multi_tenancy: { mode: 'required_from_auth' as const } },
      { execution: { executor_command_template: 'remote-executor' } },
    ]) {
      const worker = new WorkspaceStorageMaintenance(db as never, config);
      worker.start();
      try {
        await worker.runOnce();
      } finally {
        await worker.stop();
      }
    }
  }
);
