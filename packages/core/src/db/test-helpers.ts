/**
 * Database Test Helpers
 *
 * Shared test utilities used ACROSS multiple test files.
 *
 * Add helpers here ONLY if multiple test files need them:
 * - Shared fixtures (like dbTest below)
 * - Common assertions used by many tests
 * - Seeded database fixtures for integration tests
 *
 * For helpers used within a single test file, keep them inline in that file.
 * Don't add single-use utilities here - keep this file lean.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createDatabase, type Database } from './client';
import { runMigrations } from './migrate';

/**
 * Test fixture providing a fresh temporary database for each test.
 *
 * Each test gets an isolated SQLite database with the full current schema.
 * Cleanup happens automatically after each test.
 *
 * @example
 * ```typescript
 * import { dbTest } from '../test-helpers';
 * import { SessionRepository } from './repositories/sessions';
 *
 * dbTest('should list sessions', async ({ db }) => {
 *   const sessions = new SessionRepository(db);
 *   expect(await sessions.find({})).toEqual([]);
 * });
 * ```
 */
export const dbTest = test.extend<{ db: Database }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright test fixture pattern requires empty destructure
  db: async ({}, use) => {
    // Use a per-test temp file instead of :memory:.
    // Rationale: the libsql client opens a fresh connection for each
    // transaction, and `:memory:` databases are isolated per-connection,
    // which breaks any code under test that starts a transaction after
    // creating schema on the initial connection. A unique file path per
    // test gives us identical isolation with a single shared DB.
    const dir = mkdtempSync(join(tmpdir(), 'disco-core-test-'));
    const dbPath = join(dir, 'test.db');
    const db = createDatabase({ url: `file:${dbPath}` });

    // Initialize schema (creates all tables, indexes, etc.)
    await runMigrations(db);

    try {
      // Provide database to test
      await use(db);
    } finally {
      // Best-effort cleanup of the temp dir (ignore errors on Windows)
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // noop
      }
    }
  },
});
