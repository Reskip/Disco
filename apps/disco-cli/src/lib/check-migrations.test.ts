import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock @disco/core/db for the unit-level branching tests. The integration
// test at the bottom deliberately bypasses these mocks (it uses vi.doUnmock
// and re-imports the real module).
vi.mock('@disco/core/db', async () => {
  const actual = await vi.importActual<typeof import('@disco/core/db')>('@disco/core/db');
  return {
    ...actual,
    checkMigrationStatus: vi.fn(),
    createDatabase: vi.fn(() => ({ __fake: true })),
    getDatabaseUrl: vi.fn(() => 'file:/tmp/disco-test-default.db'),
  };
});

import { checkMigrationStatus, createDatabase, getDatabaseUrl } from '@disco/core/db';
import {
  formatPendingMigrationsMessage,
  getDaemonStartMigrationBlocker,
  getPendingMigrationsInfo,
  type PendingMigrationsInfo,
} from './check-migrations.js';

const checkMigrationStatusMock = vi.mocked(checkMigrationStatus);
const createDatabaseMock = vi.mocked(createDatabase);
const getDatabaseUrlMock = vi.mocked(getDatabaseUrl);

describe('getPendingMigrationsInfo', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when migrations are up to date', async () => {
    checkMigrationStatusMock.mockResolvedValueOnce({
      hasPending: false,
      pending: [],
      applied: ['0000_init'],
      dbAheadOfBinary: false,
    });

    await expect(getPendingMigrationsInfo()).resolves.toBeNull();
  });

  it('returns pending migration info when the database is behind', async () => {
    checkMigrationStatusMock.mockResolvedValueOnce({
      hasPending: true,
      pending: ['0005_add_widgets', '0006_add_gizmos'],
      applied: ['0000_init'],
      dbAheadOfBinary: false,
    });

    const info = await getPendingMigrationsInfo();

    // Regression guard: this helper MUST surface pending migrations so that
    // `disco daemon start` can fail fast on stderr before spawning a detached
    // daemon that would otherwise die silently to the log file.
    expect(info).not.toBeNull();
    expect(info?.pending).toEqual(['0005_add_widgets', '0006_add_gizmos']);
    expect(info?.dbUrl).toBe('file:/tmp/disco-test-default.db');
    expect(info?.dbPath).toBe('/tmp/disco-test-default.db');
  });

  it('uses an explicit dbUrl override when one is provided', async () => {
    checkMigrationStatusMock.mockResolvedValueOnce({
      hasPending: true,
      pending: ['0001_thing'],
      applied: [],
      dbAheadOfBinary: false,
    });

    const info = await getPendingMigrationsInfo('file:/tmp/disco-override.db');

    // When a dbUrl is passed explicitly we must NOT fall back to the
    // ambient getDatabaseUrl() — otherwise callers that resolve the URL
    // from a non-default config (e.g. --config) would unknowingly probe
    // the wrong database.
    expect(getDatabaseUrlMock).not.toHaveBeenCalled();
    expect(createDatabaseMock).toHaveBeenCalledWith({ url: 'file:/tmp/disco-override.db' });
    expect(info?.dbUrl).toBe('file:/tmp/disco-override.db');
    expect(info?.dbPath).toBe('/tmp/disco-override.db');
  });

  it('propagates errors from the underlying migration check', async () => {
    checkMigrationStatusMock.mockRejectedValueOnce(new Error('db unreachable'));

    await expect(getPendingMigrationsInfo()).rejects.toThrow('db unreachable');
  });
});

describe('getDaemonStartMigrationBlocker', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an actionable blocker for every daemon start path', async () => {
    checkMigrationStatusMock.mockResolvedValueOnce({
      hasPending: true,
      pending: ['0005_add_widgets'],
      applied: ['0000_init'],
      dbAheadOfBinary: false,
    });

    await expect(getDaemonStartMigrationBlocker()).resolves.toMatch(
      /Database migrations required[\s\S]*disco db migrate/
    );
  });
});

describe('formatPendingMigrationsMessage', () => {
  it('includes each pending tag and an actionable `disco db migrate` hint', () => {
    const info: PendingMigrationsInfo = {
      dbUrl: 'file:/tmp/disco-test.db',
      dbPath: '/tmp/disco-test.db',
      pending: ['0005_add_widgets', '0006_add_gizmos'],
    };

    const message = formatPendingMigrationsMessage(info);

    expect(message).toContain('Database migrations required');
    expect(message).toContain('0005_add_widgets');
    expect(message).toContain('0006_add_gizmos');
    expect(message).toContain('disco db migrate');
    // SQLite: include the backup command with the resolved db path.
    expect(message).toContain('cp /tmp/disco-test.db /tmp/disco-test.db.backup-');
  });

  it('omits the SQLite backup hint for postgres URLs', () => {
    const info: PendingMigrationsInfo = {
      dbUrl: 'postgresql://user:pass@localhost:5432/disco',
      dbPath: 'postgresql://user:pass@localhost:5432/disco',
      pending: ['0005_add_widgets'],
    };

    const message = formatPendingMigrationsMessage(info);

    expect(message).toContain('disco db migrate');
    expect(message).not.toContain('cp ');
    expect(message).not.toContain('backup-$(date');
  });
});

/**
 * Integration test against a real SQLite file.
 *
 * Regression guard beyond unit mocks: verifies that when the database exists
 * but has no `__drizzle_migrations` table (the exact shape of a fresh
 * Disco install before `disco db migrate` runs), our helper correctly
 * reports EVERY journal entry as pending — which is what drives the
 * fail-fast behavior in `disco daemon start`.
 */
describe('getPendingMigrationsInfo (integration)', () => {
  it('reports all journal entries as pending against a fresh SQLite DB', async () => {
    // Unmock @disco/core/db so we exercise the real checkMigrationStatus,
    // createDatabase, and Drizzle journal-reading code paths.
    vi.doUnmock('@disco/core/db');
    vi.resetModules();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disco-pending-migrations-'));
    const dbPath = path.join(tempDir, 'fresh.db');

    try {
      const mod = await import('./check-migrations.js');
      const info = await mod.getPendingMigrationsInfo(`file:${dbPath}`);

      expect(info).not.toBeNull();
      expect(info?.dbUrl).toBe(`file:${dbPath}`);
      expect(info?.dbPath).toBe(dbPath);
      // The repo has dozens of migrations; we assert the journal is
      // non-empty rather than pinning a specific count (which would churn
      // every time a new migration is added).
      expect(info?.pending.length).toBeGreaterThan(0);
      // First migration in the journal should always be present.
      expect(info?.pending[0]).toMatch(/^0000_/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      // Restore the mock for any subsequent describe blocks in watch mode.
      vi.doMock('@disco/core/db', async () => {
        const actual = await vi.importActual<typeof import('@disco/core/db')>('@disco/core/db');
        return {
          ...actual,
          checkMigrationStatus: vi.fn(),
          createDatabase: vi.fn(() => ({ __fake: true })),
          getDatabaseUrl: vi.fn(() => 'file:/tmp/disco-test-default.db'),
        };
      });
    }
  });
});
