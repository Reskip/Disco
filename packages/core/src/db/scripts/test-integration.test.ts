/**
 * Database integration smoke tests for the current Disco model.
 *
 * Repo, Branch, Board, and Artifact were retired; this suite verifies that a
 * cold database can execute the real direct Session -> Task flow without any
 * of those carrier records.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { generateId, SHORT_ID_LENGTH, shortId } from '../../lib/ids';
import type { SessionID, Task, UUID } from '../../types';
import { SessionStatus, TaskStatus } from '../../types';
import { isSQLiteDatabase } from '../database-wrapper';
import { runMigrations, seedInitialData } from '../migrate';
import { SessionRepository, TaskRepository } from '../repositories';
import { dbTest } from '../test-helpers';

function taskData(sessionId: SessionID, overrides: Partial<Task> = {}): Partial<Task> {
  return {
    task_id: generateId(),
    session_id: sessionId,
    created_by: 'integration-user',
    full_prompt: 'exercise direct session task flow',
    status: TaskStatus.CREATED,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: new Date().toISOString(),
    },
    tool_use_count: 0,
    ...overrides,
  };
}

describe.sequential('current database integration', () => {
  describe('database cold initialization', () => {
    dbTest('creates current product tables and no retired architecture tables', async ({ db }) => {
      const result = isSQLiteDatabase(db)
        ? await db.run(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        : await db.execute(
            sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`
          );
      const rows = Array.isArray(result)
        ? (result as unknown as Array<{ name: string }>)
        : ((result as unknown as { rows?: Array<{ name: string }> }).rows ?? []);
      const names = new Set(rows.map((row) => row.name));

      for (const name of ['users', 'agents', 'sessions', 'tasks', 'messages', 'mcp_servers']) {
        expect(names.has(name), `missing current table ${name}`).toBe(true);
      }
      for (const retired of [
        'repos',
        'branches',
        'branch_owners',
        'branch_group_grants',
        'boards',
        'board_objects',
        'board_comments',
        'board_owners',
        'board_group_grants',
        'cards',
        'card_types',
        'artifacts',
        'artifact_trust_grants',
        'gateway_channels',
        'gateway_inbound_events',
        'gateway_outbound_messages',
        'thread_session_map',
        'kb_document_units',
        'kb_document_versions',
        'kb_documents',
        'kb_embedding_spaces',
        'kb_graph_edges',
        'kb_graph_nodes',
        'kb_namespace_acl',
        'kb_namespaces',
      ]) {
        expect(names.has(retired), `retired table still exists: ${retired}`).toBe(false);
      }

      const sessionColumnsResult = isSQLiteDatabase(db)
        ? await db.run(sql`PRAGMA table_info(sessions)`)
        : await db.execute(
            sql`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'sessions'`
          );
      const sessionColumnRows = Array.isArray(sessionColumnsResult)
        ? (sessionColumnsResult as unknown as Array<{ name: string }>)
        : ((sessionColumnsResult as unknown as { rows?: Array<{ name: string }> }).rows ?? []);
      const sessionColumns = new Set(sessionColumnRows.map((row) => row.name));
      expect(sessionColumns.has('agent_id')).toBe(true);
      expect(sessionColumns.has('working_directory')).toBe(true);
      expect(sessionColumns.has('branch_id')).toBe(false);
      expect(sessionColumns.has('board_id')).toBe(false);
    });

    dbTest('is idempotent and seedInitialData adds no legacy demo records', async ({ db }) => {
      await runMigrations(db);
      await runMigrations(db);
      await seedInitialData(db);
      await seedInitialData(db);

      expect(await new SessionRepository(db).count()).toBe(0);
    });
  });

  describe('identifier integration', () => {
    it('generates unique ordered UUIDv7 values and canonical short IDs', () => {
      const ids = Array.from({ length: 100 }, () => generateId());
      expect(new Set(ids).size).toBe(100);
      expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/.test(id))).toBe(true);
      for (let index = 1; index < ids.length; index += 1) {
        expect(
          ids[index - 1].replaceAll('-', '').slice(0, 12) <=
            ids[index].replaceAll('-', '').slice(0, 12)
        ).toBe(true);
      }
      expect(shortId(ids[0])).toBe(ids[0].replaceAll('-', '').slice(0, SHORT_ID_LENGTH));
    });
  });

  describe('direct Session and Task integration', () => {
    dbTest('creates, queries, updates, and deletes a standalone Session', async ({ db }) => {
      const sessions = new SessionRepository(db);
      const created = await sessions.create({
        session_id: generateId() as SessionID,
        created_by: 'integration-user' as UUID,
        agentic_tool: 'codex',
        status: SessionStatus.IDLE,
        title: 'integration session',
        working_directory: `/tmp/integration/${generateId()}`,
      });

      expect((await sessions.findById(shortId(created.session_id)))?.session_id).toBe(
        created.session_id
      );
      expect(created).not.toHaveProperty('branch_id');
      expect(created).not.toHaveProperty('board_id');

      const updated = await sessions.update(created.session_id, {
        title: 'updated integration session',
        status: SessionStatus.RUNNING,
      });
      expect(updated).toMatchObject({
        title: 'updated integration session',
        status: SessionStatus.RUNNING,
      });

      await sessions.delete(created.session_id);
      expect(await sessions.findById(created.session_id)).toBeNull();
    });

    dbTest('round-trips the Session -> Task queue relationship', async ({ db }) => {
      const sessions = new SessionRepository(db);
      const tasks = new TaskRepository(db);
      const session = await sessions.create({
        session_id: generateId() as SessionID,
        created_by: 'integration-user' as UUID,
        agentic_tool: 'codex',
        working_directory: `/tmp/integration/${generateId()}`,
      });
      const first = await tasks.create(taskData(session.session_id));
      const second = await tasks.create(
        taskData(session.session_id, { status: TaskStatus.QUEUED, queue_position: 1 })
      );

      expect((await tasks.findBySession(session.session_id)).map((task) => task.task_id)).toEqual([
        first.task_id,
        second.task_id,
      ]);
      expect((await tasks.findById(first.task_id))?.full_prompt).toBe(
        'exercise direct session task flow'
      );
      await tasks.update(first.task_id, { status: TaskStatus.COMPLETED });
      expect((await tasks.findById(first.task_id))?.status).toBe(TaskStatus.COMPLETED);
    });

    dbTest('maintains genealogy using only Session IDs', async ({ db }) => {
      const sessions = new SessionRepository(db);
      const root = await sessions.create({
        session_id: generateId() as SessionID,
        created_by: 'integration-user' as UUID,
        agentic_tool: 'codex',
        working_directory: `/tmp/integration/${generateId()}`,
      });
      const child = await sessions.create({
        session_id: generateId() as SessionID,
        created_by: 'integration-user' as UUID,
        agentic_tool: 'codex',
        working_directory: `/tmp/integration/${generateId()}`,
        genealogy: { parent_session_id: root.session_id, children: [] },
      });

      expect((await sessions.findChildren(root.session_id)).map((item) => item.session_id)).toEqual(
        [child.session_id]
      );
      expect(
        (await sessions.findAncestors(child.session_id)).map((item) => item.session_id)
      ).toEqual([root.session_id]);
    });
  });
});
