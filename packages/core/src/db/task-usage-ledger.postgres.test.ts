import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { TaskStatus } from '../types/task';
import { createDatabase, type Database } from './client';
import { deleteFrom, select } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { SessionRepository } from './repositories/sessions';
import { TaskRepository } from './repositories/tasks';
import { sessions, tasks, taskUsageLedger } from './schema';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.DISCO_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.DISCO_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)('Task usage ledger PostgreSQL', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('keeps one usage row after its Session and Task content are deleted', async () => {
    await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
      const userId = generateId();
      const session = await new SessionRepository(scoped).create({
        session_id: generateId(),
        agentic_tool: 'codex',
        created_by: userId,
        working_directory: `/tmp/usage-ledger/${generateId()}`,
      });
      const repository = new TaskRepository(scoped);
      const task = await repository.create({
        task_id: generateId(),
        session_id: session.session_id,
        created_by: userId,
        full_prompt: 'permanent accounting regression',
        status: TaskStatus.COMPLETED,
        message_range: {
          start_index: 0,
          end_index: 0,
          start_timestamp: new Date().toISOString(),
        },
        git_state: { ref_at_start: 'none', sha_at_start: 'none' },
        model: 'gpt-5.6-sol',
        tool_use_count: 0,
        normalized_sdk_response: {
          tokenUsage: {
            inputTokens: 4_000,
            outputTokens: 500,
            totalTokens: 4_500,
            cacheReadTokens: 250,
          },
          costUsd: 0.42,
          durationMs: 9_876,
        },
      });

      await repository.update(task.task_id, {
        normalized_sdk_response: {
          ...task.normalized_sdk_response!,
          tokenUsage: {
            ...task.normalized_sdk_response!.tokenUsage,
            inputTokens: 4_500,
            totalTokens: 5_000,
          },
        },
      });

      const beforeDelete = await select(scoped)
        .from(taskUsageLedger)
        .where(eq(taskUsageLedger.task_id, task.task_id))
        .all();
      expect(beforeDelete).toHaveLength(1);
      expect(beforeDelete[0]).toMatchObject({
        user_id: userId,
        session_id: session.session_id,
        agentic_tool: 'codex',
        model: 'gpt-5.6-sol',
        input_tokens: 4_500,
        output_tokens: 500,
        total_tokens: 5_000,
        cost_usd: 0.42,
        duration_ms: 9_876,
      });

      await deleteFrom(scoped, sessions).where(eq(sessions.session_id, session.session_id)).run();

      expect(
        await select(scoped).from(tasks).where(eq(tasks.task_id, task.task_id)).all()
      ).toHaveLength(0);
      expect(
        await select(scoped)
          .from(taskUsageLedger)
          .where(eq(taskUsageLedger.task_id, task.task_id))
          .all()
      ).toEqual(beforeDelete);
    });
  });
});
