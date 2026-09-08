import { generateId, SessionRepository } from '@disco/core/db';
import type { Application } from '@disco/core/feathers';
import type { Session, UUID } from '@disco/core/types';
import { SessionStatus } from '@disco/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

const STUB_APP = {} as unknown as Application;

async function createSession(
  db: any,
  ownerId: UUID,
  overrides: Partial<Session> = {}
): Promise<Session> {
  return new SessionRepository(db).create({
    session_id: generateId(),
    agentic_tool: 'codex',
    status: SessionStatus.IDLE,
    created_by: ownerId,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
}

function rows(result: Awaited<ReturnType<SessionsService['find']>>): Session[] {
  return Array.isArray(result) ? result : result.data;
}

describe('SessionsService.find direct ownership', () => {
  dbTest('returns only Sessions directly owned by the authenticated user marker', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const ownerA = generateId() as UUID;
    const ownerB = generateId() as UUID;
    const first = await createSession(db, ownerA);
    const second = await createSession(db, ownerA);
    await createSession(db, ownerB);

    const result = await service.find({
      _discoSqlSessionOwnerUserId: ownerA,
      query: { $limit: 100 },
    });

    expect(rows(result).map((session) => session.session_id).sort()).toEqual(
      [first.session_id, second.session_id].sort()
    );
    expect(rows(result).every((session) => session.created_by === ownerA)).toBe(true);
  });

  dbTest('never exposes retired Branch or Board carrier fields', async ({ db }) => {
    const owner = generateId() as UUID;
    await createSession(db, owner);
    const service = new SessionsService(db, STUB_APP);

    const result = await service.find({
      _discoSqlSessionOwnerUserId: owner,
      query: { $limit: 100 },
    });

    expect(rows(result)).toHaveLength(1);
    expect(rows(result)[0]).not.toHaveProperty('branch_id');
    expect(rows(result)[0]).not.toHaveProperty('board_id');
    expect(rows(result)[0]).not.toHaveProperty('branch_board_id');
  });

  dbTest('keeps operator filtering inside the direct owner scope', async ({ db }) => {
    const owner = generateId() as UUID;
    const first = await createSession(db, owner);
    await createSession(db, owner);
    const third = await createSession(db, owner);
    await createSession(db, generateId() as UUID);

    const service = new SessionsService(db, STUB_APP);
    const result = await service.find({
      _discoSqlSessionOwnerUserId: owner,
      query: { session_id: { $in: [first.session_id, third.session_id] }, $limit: 100 },
    });

    expect(rows(result).map((session) => session.session_id).sort()).toEqual(
      [first.session_id, third.session_id].sort()
    );
  });
});

describe('SessionsService.find recency pagination', () => {
  const T_OLD = '2026-01-01T00:00:00.000Z';
  const T_MID = '2026-02-01T00:00:00.000Z';
  const T_NEW = '2026-03-01T00:00:00.000Z';

  dbTest('orders the owner Session list by updated_at without a Branch join', async ({ db }) => {
    const owner = generateId() as UUID;
    const old = await createSession(db, owner, { last_updated: T_OLD });
    const middle = await createSession(db, owner, { last_updated: T_MID });
    const recent = await createSession(db, owner, { last_updated: T_NEW });
    await createSession(db, generateId() as UUID, { last_updated: '2026-04-01T00:00:00.000Z' });
    const service = new SessionsService(db, STUB_APP);

    const result = await service.find({
      _discoSqlSessionOwnerUserId: owner,
      query: { archived: false, $sort: { updated_at: -1 }, $limit: 100 },
    });

    expect(rows(result).map((session) => session.session_id)).toEqual([
      recent.session_id,
      middle.session_id,
      old.session_id,
    ]);
  });

  dbTest('composes recency ordering with limit and skip', async ({ db }) => {
    const owner = generateId() as UUID;
    const old = await createSession(db, owner, { last_updated: T_OLD });
    const middle = await createSession(db, owner, { last_updated: T_MID });
    await createSession(db, owner, { last_updated: T_NEW });
    const service = new SessionsService(db, STUB_APP);

    const result = await service.find({
      _discoSqlSessionOwnerUserId: owner,
      query: { $sort: { updated_at: -1 }, $limit: 2, $skip: 1 },
    });

    expect(rows(result).map((session) => session.session_id)).toEqual([
      middle.session_id,
      old.session_id,
    ]);
    expect(Array.isArray(result) ? result.length : result.total).toBe(3);
  });
});
