/**
 * SessionRepository tests for the direct Session ownership model.
 *
 * Sessions no longer depend on Repo, Branch, or Board carrier rows. These
 * tests deliberately build only the records that remain part of the product:
 * users, sessions, genealogy, archives, and schedules.
 */

import type { ScheduleID, Session, SessionID, UUID } from '@disco/core/types';
import { SessionStatus } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import { generateId, toShortId } from '../../lib/ids';
import type { SessionRow } from '../schema';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError, getHiddenTenantId, RepositoryError } from './base';
import { ScheduleRepository } from './schedules';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

const OWNER_A = '00000000-0000-7000-8000-0000000000a1' as UUID;
const OWNER_B = '00000000-0000-7000-8000-0000000000b2' as UUID;

function sessionData(overrides: Partial<Session> = {}): Partial<Session> {
  const sessionId = (overrides.session_id ?? generateId()) as SessionID;
  return {
    session_id: sessionId,
    agentic_tool: 'codex',
    status: SessionStatus.IDLE,
    created_by: OWNER_A,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    working_directory: `/tmp/disco-session-tests/${sessionId}`,
    ...overrides,
  };
}

type SessionRowMapper = {
  rowToSession(row: SessionRow, baseUrl?: string): Session;
};

function postgresStyleRow(overrides: Partial<SessionRow> & { tenant_id?: string } = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    tenant_id: 'tenant-session-row',
    session_id: generateId(),
    created_at: now,
    updated_at: now,
    created_by: OWNER_A,
    agent_id: null,
    working_directory: null,
    unix_username: null,
    status: SessionStatus.IDLE,
    agentic_tool: 'codex',
    agentic_tool_preset_id: null,
    parent_session_id: null,
    forked_from_session_id: null,
    scheduled_run_at: null,
    is_scheduled: false,
    schedule_id: null,
    scheduler_init_completed_at: null,
    ready_for_prompt: false,
    archived: false,
    archived_reason: null,
    data: { genealogy: { children: [] }, contextFiles: [], tasks: [] },
    ...overrides,
  } as SessionRow & { tenant_id: string };
}

function mapRow(row: SessionRow): Session {
  const repo = new SessionRepository({} as never);
  return (repo as unknown as SessionRowMapper).rowToSession(row);
}

async function createSchedule(db: any): Promise<ScheduleID> {
  const user = await new UsersRepository(db).create({
    username: `schedule-${generateId()}@example.test`,
    name: 'Schedule owner',
  });
  const schedule = await new ScheduleRepository(db).create({
    name: `schedule-${generateId()}`,
    cron_expression: '0 * * * *',
    timezone_mode: 'utc',
    prompt: 'run',
    agentic_tool_config: { agentic_tool: 'codex' },
    created_by: user.user_id as UUID,
  });
  return schedule.schedule_id;
}

describe('SessionRepository row mapping', () => {
  it('keeps tenant metadata hidden and drops retired git_state data', () => {
    const session = mapRow(
      postgresStyleRow({
        data: {
          genealogy: { children: [] },
          contextFiles: [],
          tasks: [],
          git_state: { ref: 'main', base_sha: 'retired', current_sha: 'retired' },
        } as SessionRow['data'],
      })
    );

    expect(getHiddenTenantId(session)).toBe('tenant-session-row');
    expect((session as { tenant_id?: string }).tenant_id).toBe('tenant-session-row');
    expect(Object.keys(session)).not.toContain('tenant_id');
    expect(session).not.toHaveProperty('git_state');
  });
});

describe('SessionRepository direct CRUD', () => {
  dbTest('creates a standalone session with current fields and defaults', async ({ db }) => {
    const repo = new SessionRepository(db);
    const created = await repo.create(
      sessionData({
        agentic_tool: undefined,
        status: undefined,
        title: 'Direct session',
        description: 'No repository carrier',
        agent_id: null,
      })
    );

    expect(created.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.agentic_tool).toBe('codex');
    expect(created.status).toBe(SessionStatus.IDLE);
    expect(created.title).toBe('Direct session');
    expect(created.working_directory).toContain('/tmp/disco-session-tests/');
    expect(created).not.toHaveProperty('branch_id');
    expect(created).not.toHaveProperty('board_id');
  });

  dbTest('rejects a session without a direct owner', async ({ db }) => {
    const repo = new SessionRepository(db);
    const data = sessionData();
    delete data.created_by;
    await expect(repo.create(data)).rejects.toThrow(/created_by/);
  });

  dbTest('round-trips optional runtime and context fields', async ({ db }) => {
    const repo = new SessionRepository(db);
    const created = await repo.create(
      sessionData({
        sdk_session_id: 'thread-123',
        permission_config: { mode: 'acceptEdits' },
        model_config: {
          mode: 'exact',
          model: 'gpt-5.6-sol',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        custom_context: { source: 'test' },
        current_context_usage: 1234,
        context_window_limit: 100_000,
        billing_mode: 'api-key',
      })
    );
    const found = await repo.findById(created.session_id);

    expect(found).toMatchObject({
      sdk_session_id: 'thread-123',
      permission_config: { mode: 'acceptEdits' },
      model_config: {
        mode: 'exact',
        model: 'gpt-5.6-sol',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      custom_context: { source: 'test' },
      current_context_usage: 1234,
      context_window_limit: 100_000,
      billing_mode: 'api-key',
    });
  });

  dbTest('resolves full and short IDs and detects ambiguity', async ({ db }) => {
    const repo = new SessionRepository(db);
    const firstId = '018f1234-0000-7000-8000-000000000001' as SessionID;
    const secondId = '018f1234-1111-7000-8000-000000000002' as SessionID;
    await repo.create(sessionData({ session_id: firstId }));
    await repo.create(sessionData({ session_id: secondId }));

    expect((await repo.findById(firstId))?.session_id).toBe(firstId);
    await expect(repo.findById('018f1234')).rejects.toBeInstanceOf(AmbiguousIdError);
    expect((await repo.findById(toShortId(firstId, 12)))?.session_id).toBe(firstId);
    await expect(repo.findById('ffffffff')).resolves.toBeNull();
  });

  dbTest('filters listings by the direct Session owner', async ({ db }) => {
    const repo = new SessionRepository(db);
    await repo.create(sessionData({ created_by: OWNER_A, title: 'A' }));
    await repo.create(sessionData({ created_by: OWNER_B, title: 'B' }));

    expect((await repo.findAll({ ownerUserId: OWNER_A })).map((s) => s.title)).toEqual(['A']);
    expect((await repo.findAll({ visibleToUserId: OWNER_B })).map((s) => s.title)).toEqual(['B']);
    expect(await repo.findAccessibleSessions(OWNER_A)).toHaveLength(1);
  });

  dbTest('supports status queries, updates, counts, and deletion', async ({ db }) => {
    const repo = new SessionRepository(db);
    const running = await repo.create(sessionData({ status: SessionStatus.RUNNING }));
    const idle = await repo.create(sessionData({ status: SessionStatus.IDLE }));

    expect((await repo.findRunning()).map((s) => s.session_id)).toEqual([running.session_id]);
    expect(await repo.count()).toBe(2);

    const updated = await repo.update(toShortId(idle.session_id, 12), {
      title: 'updated',
      status: SessionStatus.COMPLETED,
      sdk_session_id: 'resumed-thread',
    });
    expect(updated).toMatchObject({
      title: 'updated',
      status: SessionStatus.COMPLETED,
      sdk_session_id: 'resumed-thread',
    });

    await repo.delete(running.session_id);
    expect(await repo.count()).toBe(1);
    await expect(repo.delete(running.session_id)).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  dbTest('keeps ready_for_prompt acknowledgement timestamp-neutral', async ({ db }) => {
    const repo = new SessionRepository(db);
    const created = await repo.create(
      sessionData({ last_updated: '2026-01-01T00:00:00.000Z', ready_for_prompt: true })
    );
    const updated = await repo.update(created.session_id, { ready_for_prompt: false });
    expect(updated.last_updated).toBe(created.last_updated);
  });

  dbTest('updates archive state atomically for a Session set', async ({ db }) => {
    const repo = new SessionRepository(db);
    const a = await repo.create(sessionData());
    const b = await repo.create(sessionData());

    const archived = await repo.updateArchiveStateForIds(
      [a.session_id, b.session_id],
      true,
      'manual'
    );
    expect(archived).toHaveLength(2);
    expect(archived.every((session) => session.archived)).toBe(true);
    expect(archived.every((session) => session.archived_reason === 'manual')).toBe(true);
  });
});

describe('SessionRepository genealogy', () => {
  dbTest('finds children, ancestors, and owner-scoped descendants', async ({ db }) => {
    const repo = new SessionRepository(db);
    const root = await repo.create(sessionData({ created_by: OWNER_A }));
    const child = await repo.create(
      sessionData({
        created_by: OWNER_A,
        genealogy: { parent_session_id: root.session_id, children: [] },
      })
    );
    const grandchild = await repo.create(
      sessionData({
        created_by: OWNER_A,
        genealogy: { forked_from_session_id: child.session_id, children: [] },
      })
    );
    await repo.create(
      sessionData({
        created_by: OWNER_B,
        genealogy: { parent_session_id: root.session_id, children: [] },
      })
    );

    expect((await repo.findChildren(root.session_id)).map((s) => s.session_id)).toContain(
      child.session_id
    );
    expect((await repo.findAncestors(grandchild.session_id)).map((s) => s.session_id)).toEqual([
      child.session_id,
      root.session_id,
    ]);
    expect(
      (await repo.findOwnerDescendants(root.session_id, OWNER_A)).map((s) => s.session_id)
    ).toEqual([child.session_id, grandchild.session_id]);
  });
});

describe('SessionRepository schedule links', () => {
  dbTest(
    'deduplicates, lists, and completes scheduled runs without a Branch carrier',
    async ({ db }) => {
      const repo = new SessionRepository(db);
      const scheduleId = await createSchedule(db);
      const runAt = 1_700_000_000_000;
      const created = await repo.create(
        sessionData({
          schedule_id: scheduleId,
          scheduled_run_at: runAt,
          is_scheduled: true,
        })
      );

      expect((await repo.findScheduleRun(scheduleId, runAt))?.session_id).toBe(created.session_id);
      expect(await repo.countByScheduleId(scheduleId)).toBe(1);
      expect(await repo.existsInScheduleWithStatuses(scheduleId, [SessionStatus.IDLE])).toBe(true);
      expect((await repo.findByScheduleId(scheduleId)).map((s) => s.session_id)).toEqual([
        created.session_id,
      ]);
      expect((await repo.findIncompleteScheduledRefs(10)).map((r) => r.session_id)).toContain(
        created.session_id
      );
      expect(await repo.markScheduledInitializationComplete(created.session_id)).toBe(true);
      expect(await repo.markScheduledInitializationComplete(created.session_id)).toBe(false);
      expect(await repo.isScheduledInitializationComplete(created.session_id)).toBe(true);

      await expect(
        repo.create(
          sessionData({
            schedule_id: scheduleId,
            scheduled_run_at: runAt,
            is_scheduled: true,
          })
        )
      ).rejects.toBeInstanceOf(RepositoryError);
    }
  );

  dbTest('keeps pending run recovery metadata after its Schedule is deleted', async ({ db }) => {
    const repo = new SessionRepository(db);
    const scheduleId = await createSchedule(db);
    const created = await repo.create(
      sessionData({
        schedule_id: scheduleId,
        scheduled_run_at: 1_700_000_060_000,
        is_scheduled: true,
      })
    );

    await new ScheduleRepository(db).delete(scheduleId);
    expect((await repo.findById(created.session_id))?.schedule_id).toBeUndefined();
    expect((await repo.findIncompleteScheduledRefs(10)).map((r) => r.session_id)).toContain(
      created.session_id
    );
  });
});
