import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { pendingOfflineCutoverMigrations } from './migrate';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/** Both journals, Postgres first, as the migrator reads them off disk. */
const readJournals = () =>
  Promise.all(
    [
      new URL('../../drizzle/postgres/meta/_journal.json', import.meta.url),
      new URL('../../drizzle/sqlite/meta/_journal.json', import.meta.url),
    ].map(async (url) => JSON.parse(await readFile(url, 'utf8')) as { entries: JournalEntry[] })
  );

describe('Postgres migrations', () => {
  it('requires the Knowledge claim protocol migration to be an offline existing-db cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0073_task_runtime_reconciliation'],
        pending: ['0074_knowledge_embedding_claims'],
      })
    ).toEqual(['0074_knowledge_embedding_claims']);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0074_knowledge_embedding_claims'],
      })
    ).toEqual([]);
  });

  it('enforces the structurally incompatible MCP OAuth migration as an offline cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0076_executor_session_token_session_binding'],
        pending: ['0078_mcp_oauth_pending_flows'],
      })
    ).toEqual(['0078_mcp_oauth_pending_flows']);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0078_mcp_oauth_pending_flows'],
      })
    ).toEqual([]);
  });

  it('enforces the GitHub callback authority migration as an offline cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0078_mcp_oauth_pending_flows'],
        pending: ['0082_github_install_state'],
      })
    ).toEqual(['0082_github_install_state']);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0082_github_install_state'],
      })
    ).toEqual([]);
  });

  it('enforces PostgreSQL transcript indexes as an offline existing-db cutover', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0082_github_install_state'],
        pending: ['0083_transcript_hydration_keysets'],
      })
    ).toEqual(['0083_transcript_hydration_keysets']);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0085_github_install_state'],
        pending: ['0086_transcript_hydration_keysets'],
      })
    ).toEqual([]);
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0083_transcript_hydration_keysets'],
      })
    ).toEqual([]);
  });

  it('assigns GitHub install state unique post-HA migration watermarks', async () => {
    const [postgresJournal, sqliteJournal] = await readJournals();

    for (const [journal, expectedTag, expectedIndex, hydrationTag, hydrationIndex] of [
      [postgresJournal, '0082_github_install_state', 82, '0083_transcript_hydration_keysets', 83],
      [sqliteJournal, '0085_github_install_state', 85, '0086_transcript_hydration_keysets', 86],
    ] as const) {
      const entry = journal.entries.find(({ tag }) => tag === expectedTag);
      const predecessor = journal.entries.find(({ idx }) => idx === expectedIndex - 1);
      expect(entry).toMatchObject({ idx: expectedIndex, tag: expectedTag });
      expect(entry?.when).toBeGreaterThan(predecessor?.when ?? 0);

      // Find by tag rather than assuming it is the newest entry — later
      // migrations (e.g. add_user_filesystem_home) legitimately follow it.
      const hydrationEntry = journal.entries.find(({ tag }) => tag === hydrationTag);
      expect(hydrationEntry).toMatchObject({ idx: hydrationIndex, tag: hydrationTag });
      expect(hydrationEntry?.when).toBeGreaterThan(entry?.when ?? 0);
    }
  });

  it('gives the newest migration a unique watermark that sorts it last', async () => {
    // Drizzle applies pending migrations in `when` order, so a new migration
    // that does not sort after the one before it can run out of order against a
    // database that has neither.
    //
    // Only the newest pair is checked. Early history predates the convention
    // and is not monotonic — those migrations have all long since applied
    // everywhere, and rewriting their watermarks now would change hashes that
    // deployed databases already record. What must hold is that each new
    // migration extends the sequence.
    //
    // Deliberately not pinned to a tag: naming the newest migration makes every
    // migration an edit to this test, and that edit is the moment the property
    // stops being checked.
    for (const { entries } of await readJournals()) {
      expect(entries.length).toBeGreaterThan(1);

      // `idx` is not dense — the history has a gap where a generated migration
      // was dropped before it shipped — but both keys still have to identify an
      // entry, or the journal no longer describes the directory beside it.
      expect(new Set(entries.map((entry) => entry.tag)).size).toBe(entries.length);
      expect(new Set(entries.map((entry) => entry.idx)).size).toBe(entries.length);

      const newest = entries.at(-1);
      const highestWhenBefore = Math.max(...entries.slice(0, -1).map((entry) => entry.when));
      const highestIdxBefore = Math.max(...entries.slice(0, -1).map((entry) => entry.idx));

      expect(
        newest?.when,
        `${newest?.tag} does not sort after every earlier migration`
      ).toBeGreaterThan(highestWhenBefore);
      expect(newest?.idx).toBeGreaterThan(highestIdxBefore);
    }
  });

  it('keeps Knowledge pgvector storage out of required base migrations', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0043_kb_embeddings.sql', import.meta.url),
      'utf8'
    );

    expect(migration).not.toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector/i);
    expect(migration).not.toContain('kb_unit_embeddings');
    expect(migration).not.toMatch(/\bembedding\s+vector\b/i);
    expect(migration).toContain('kb_embedding_spaces');
  });

  it('stores executor connection timestamps as UTC-safe instants', async () => {
    const [connectionMigration, heartbeatMigration] = await Promise.all([
      readFile(
        new URL('../../drizzle/postgres/0064_task_dispatching.sql', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../../drizzle/postgres/0065_executor_heartbeat_timezone.sql', import.meta.url),
        'utf8'
      ),
    ]);

    expect(connectionMigration).toMatch(
      /ADD COLUMN "executor_connected_at" timestamp with time zone/i
    );
    expect(heartbeatMigration).toMatch(
      /ALTER COLUMN "last_executor_heartbeat_at" TYPE timestamp with time zone/i
    );
    expect(heartbeatMigration).toMatch(/AT TIME ZONE 'UTC'/i);
  });

  it('persists only an executor bearer fingerprint behind forced tenant RLS', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0075_executor_session_token_authority.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"token_fingerprint" varchar(64) PRIMARY KEY NOT NULL');
    expect(migration).not.toMatch(/"(?:raw_)?token"\s/);
    expect(migration).toContain(
      'ALTER TABLE "executor_session_token_authorities" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain('"tenant_id" = COALESCE');
  });

  it('stores MCP OAuth pending flow capabilities without raw codes or tokens', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0078_mcp_oauth_pending_flows.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"state_hash" varchar(64) NOT NULL');
    expect(migration).toContain('"sealed_material" text');
    expect(migration).not.toMatch(/"(?:raw_)?state"\s/);
    expect(migration).not.toMatch(/"(?:authorization_)?code"\s/);
    expect(migration).not.toMatch(/"(?:access|refresh|bearer)_token"\s/);
    expect(migration).toContain('ALTER TABLE "mcp_oauth_pending_flows" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("SET LOCAL lock_timeout = '3s'");
    expect(migration).toContain("COALESCE(current_setting('disco.system_scope', true), '') = ''");
    expect(migration).toContain("= 'mcp_oauth_callback'");
    expect(migration).toContain('"state_hash" = current_setting(\'disco.oauth_state_hash\', true)');
    expect(migration).toContain("= 'mcp_oauth_maintenance'");
    expect(migration).toContain('DELETE FROM "user_mcp_oauth_tokens"');
    expect(migration).toContain('"grant_binding_fingerprint" varchar(64)');
    expect(migration).toContain('"refresh_generation" bigint');
    expect(migration).toContain('"refresh_success_generation" bigint');
    expect(migration).toContain('"oauth_metadata_uri" text');
    expect(migration).toContain('"user_mcp_oauth_tokens_tenant_user_fk"');
    expect(migration).toContain('"user_mcp_oauth_tokens_tenant_server_fk"');
    expect(migration).toContain('"mcp_oauth_pending_flows_current_user_grant_uq"');
    expect(migration).toContain('"mcp_oauth_pending_flows_current_shared_grant_uq"');
    expect(migration).not.toMatch(/CHECK\s*\([^)]*"status"/i);
    expect(migration).not.toMatch(/CHECK\s*\([^)]*"oauth_mode"/i);
  });

  it('persists only a GitHub install state hash behind forced tenant RLS', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0082_github_install_state.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"state_hash" varchar(64) PRIMARY KEY NOT NULL');
    expect(migration).toContain('"tenant_id" text');
    expect(migration).toContain('"user_id" varchar(36) NOT NULL');
    expect(migration).toContain('"intent" text NOT NULL');
    expect(migration).toContain('ALTER TABLE "github_install_states" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain(
      "\"tenant_id\" = NULLIF(current_setting('disco.tenant_id', true), '')"
    );
    expect(migration).not.toContain("COALESCE(NULLIF(current_setting('disco.tenant_id'");
    expect(migration).not.toContain('"tenant_id" text DEFAULT');
    expect(migration).toMatch(
      /CREATE INDEX "github_install_states_expires_idx"\s+ON "github_install_states" \("expires_at"\)/
    );
    expect(migration).not.toMatch(/["`]state["`]\s/);
    expect(migration).not.toContain('raw_state');
  });
});

describe('Schedule direct-Agent migrations', () => {
  it('rebuilds SQLite schedules without Branch state and renames the Session flag', async () => {
    const client = createClient({ url: 'file::memory:' });

    try {
      await client.execute(`
        CREATE TABLE sessions (
          session_id text PRIMARY KEY NOT NULL,
          scheduled_from_branch integer DEFAULT false NOT NULL,
          schedule_id text
        )
      `);
      await client.execute(`
        CREATE TABLE schedules (
          schedule_id text PRIMARY KEY NOT NULL,
          branch_id text NOT NULL,
          name text NOT NULL
        )
      `);
      await client.execute(
        "INSERT INTO sessions (session_id, scheduled_from_branch, schedule_id) VALUES ('s1', true, 'old')"
      );
      await client.execute(
        "INSERT INTO schedules (schedule_id, branch_id, name) VALUES ('old', 'branch-1', 'legacy')"
      );
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0101_schedule_direct_agent.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const scheduleColumns = await client.execute('PRAGMA table_info(schedules)');
      const sessionColumns = await client.execute('PRAGMA table_info(sessions)');
      const scheduleIndexes = await client.execute('PRAGMA index_list(schedules)');
      const session = await client.execute(
        "SELECT is_scheduled, schedule_id FROM sessions WHERE session_id = 's1'"
      );
      const scheduleCount = await client.execute('SELECT COUNT(*) AS count FROM schedules');

      expect(scheduleColumns.rows.map((column) => column.name)).toContain('agent_id');
      expect(scheduleColumns.rows.map((column) => column.name)).not.toContain('branch_id');
      expect(sessionColumns.rows.map((column) => column.name)).toContain('is_scheduled');
      expect(sessionColumns.rows.map((column) => column.name)).not.toContain(
        'scheduled_from_branch'
      );
      expect(session.rows).toEqual([{ is_scheduled: 1, schedule_id: null }]);
      expect(scheduleCount.rows[0]?.count).toBe(0);
      expect(scheduleIndexes.rows.map((index) => index.name)).toContain('schedules_agent_idx');
    } finally {
      client.close();
    }
  });

  it('enforces retired carrier removal as an offline PostgreSQL cutover only', () => {
    expect(
      pendingOfflineCutoverMigrations('postgresql', {
        applied: ['0098_schedule_direct_agent'],
        pending: ['0099_drop_retired_agor_architecture'],
      })
    ).toEqual(['0099_drop_retired_agor_architecture']);
    expect(
      pendingOfflineCutoverMigrations('sqlite', {
        applied: ['0101_schedule_direct_agent'],
        pending: ['0102_drop_retired_agor_architecture'],
      })
    ).toEqual([]);
  });

  it('rebuilds SQLite Sessions without retired carriers and drops their tables', async () => {
    const client = createClient({ url: 'file::memory:' });

    try {
      await client.execute('CREATE TABLE agents (agent_id text PRIMARY KEY NOT NULL)');
      await client.execute(`
        CREATE TABLE sessions (
          session_id text PRIMARY KEY NOT NULL,
          created_at integer NOT NULL,
          updated_at integer,
          created_by text NOT NULL,
          agent_id text,
          working_directory text,
          unix_username text,
          status text NOT NULL,
          agentic_tool text NOT NULL,
          agentic_tool_preset_id text,
          parent_session_id text,
          forked_from_session_id text,
          scheduled_run_at integer,
          is_scheduled integer DEFAULT false NOT NULL,
          schedule_id text,
          scheduler_init_completed_at integer,
          ready_for_prompt integer DEFAULT false NOT NULL,
          archived integer DEFAULT false NOT NULL,
          archived_reason text,
          data text NOT NULL,
          branch_id text,
          board_id text
        )
      `);
      await client.execute(`
        INSERT INTO sessions (
          session_id, created_at, created_by, working_directory, status, agentic_tool, data,
          branch_id, board_id
        ) VALUES ('s1', 1, 'u1', 'C:\\work\\s1', 'idle', 'codex', '{}', 'b1', 'board1')
      `);
      for (const table of [
        'repos',
        'branches',
        'boards',
        'cards',
        'card_types',
        'artifacts',
        'kb_documents',
        'gateway_channels',
      ]) {
        await client.execute(`CREATE TABLE ${table} (id text PRIMARY KEY)`);
      }

      const migration = await readFile(
        new URL('../../drizzle/sqlite/0102_drop_retired_agor_architecture.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const sessionColumns = await client.execute('PRAGMA table_info(sessions)');
      const session = await client.execute(
        "SELECT session_id, created_by, working_directory FROM sessions WHERE session_id = 's1'"
      );
      const remainingRetiredTables = await client.execute(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'repos', 'branches', 'boards', 'cards', 'card_types', 'artifacts',
            'kb_documents', 'gateway_channels'
          )
      `);

      expect(sessionColumns.rows.map((column) => column.name)).not.toContain('branch_id');
      expect(sessionColumns.rows.map((column) => column.name)).not.toContain('board_id');
      expect(session.rows).toEqual([
        { session_id: 's1', created_by: 'u1', working_directory: 'C:\\work\\s1' },
      ]);
      expect(remainingRetiredTables.rows).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('removes retired Session columns and carrier tables in PostgreSQL', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0099_drop_retired_agor_architecture.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('ALTER TABLE "sessions" DROP COLUMN IF EXISTS "branch_id"');
    expect(migration).toContain('ALTER TABLE "sessions" DROP COLUMN IF EXISTS "board_id"');
    for (const table of [
      'repos',
      'branches',
      'boards',
      'cards',
      'card_types',
      'artifacts',
      'kb_documents',
      'gateway_channels',
    ]) {
      expect(migration).toContain(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
  });

  it('removes the Postgres Branch foreign key and installs the Agent target', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0098_schedule_direct_agent.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('RENAME COLUMN "scheduled_from_branch" TO "is_scheduled"');
    expect(migration).toContain('DROP COLUMN "branch_id"');
    expect(migration).toContain('ADD COLUMN "agent_id" varchar(36)');
    expect(migration).toContain('REFERENCES "agents"("agent_id") ON DELETE cascade');
    expect(migration).not.toContain('ADD COLUMN "branch_id"');
  });
});

describe('Executor session token authority migrations', () => {
  it('keeps the SQLite schema compatible without enabling shared authority', async () => {
    const client = createClient({ url: 'file::memory:' });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0078_executor_session_token_authority.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(executor_session_token_authorities)');
      const columnNames = columns.rows.map((column) => column.name);

      expect(columnNames).toContain('token_fingerprint');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('token');
      expect(columnNames).not.toContain('raw_token');
    } finally {
      client.close();
    }
  });
});

describe('MCP OAuth pending-flow migrations', () => {
  it('keeps SQLite schema-compatible while standalone flow authority stays local', async () => {
    const client = createClient({ url: 'file::memory:' });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0081_mcp_oauth_pending_flows.sql', import.meta.url),
        'utf8'
      );
      await client.execute('PRAGMA foreign_keys = OFF');
      await client.execute(`
        CREATE TABLE user_mcp_oauth_tokens (
          user_id text,
          mcp_server_id text NOT NULL,
          oauth_access_token text NOT NULL,
          oauth_token_expires_at integer,
          oauth_refresh_token text,
          oauth_client_id text,
          oauth_client_secret text,
          created_at integer NOT NULL,
          updated_at integer
        )
      `);
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(mcp_oauth_pending_flows)');
      const columnNames = columns.rows.map((column) => column.name);
      expect(columnNames).toContain('state_hash');
      expect(columnNames).toContain('sealed_material');
      expect(columnNames).toContain('grant_generation');
      expect(columnNames).toContain('config_fingerprint');
      expect(columnNames).toContain('is_current');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('state');
      expect(columnNames).not.toContain('code');
      expect(columnNames).not.toContain('access_token');
      expect(columnNames).not.toContain('refresh_token');

      const tokenColumns = await client.execute('PRAGMA table_info(user_mcp_oauth_tokens)');
      const tokenColumnNames = tokenColumns.rows.map((column) => column.name);
      expect(tokenColumnNames).toContain('grant_binding_fingerprint');
      expect(tokenColumnNames).toContain('oauth_metadata_uri');
      expect(tokenColumnNames).toContain('refresh_generation');
      expect(tokenColumnNames).toContain('refresh_success_generation');

      const tableSql = await client.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mcp_oauth_pending_flows'"
      );
      expect(String(tableSql.rows[0]?.sql)).not.toMatch(/CHECK\s*\(/i);
    } finally {
      client.close();
    }
  });
});

describe('GitHub install state migrations', () => {
  it('keeps standalone SQLite schema-compatible without a raw state column', async () => {
    const client = createClient({ url: 'file::memory:' });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0085_github_install_state.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(github_install_states)');
      const columnNames = columns.rows.map((column) => column.name);
      expect(columnNames).toContain('state_hash');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('state');
      expect(columnNames).not.toContain('raw_state');
    } finally {
      client.close();
    }
  });
});

describe('SDK session storage retirement migrations', () => {
  it('discards SQLite snapshot payloads while preserving task data', async () => {
    const client = createClient({ url: 'file::memory:' });

    try {
      await client.execute(`
        CREATE TABLE tasks (
          task_id text PRIMARY KEY NOT NULL,
          session_md5 text,
          data text NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE serialized_sessions (
          id text PRIMARY KEY NOT NULL,
          payload blob
        )
      `);
      await client.execute(
        `INSERT INTO tasks (task_id, session_md5, data)
         VALUES ('task-1', 'legacy-hash', '{"preserved":true}')`
      );
      await client.execute(
        `INSERT INTO serialized_sessions (id, payload)
         VALUES ('snapshot-1', X'1F8B0800')`
      );

      const migration = await readFile(
        new URL('../../drizzle/sqlite/0072_drop_serialized_sessions.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const legacyTable = await client.execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'serialized_sessions'`
      );
      const taskColumns = await client.execute('PRAGMA table_info(tasks)');
      const task = await client.execute('SELECT task_id, data FROM tasks');

      expect(legacyTable.rows).toHaveLength(0);
      expect(taskColumns.rows.map((column) => column.name)).not.toContain('session_md5');
      expect(task.rows).toEqual([{ task_id: 'task-1', data: '{"preserved":true}' }]);
    } finally {
      client.close();
    }
  });

  it('explicitly drops the legacy table and task hash column in Postgres', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0067_drop_serialized_sessions.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('DROP TABLE "serialized_sessions"');
    expect(migration).toContain('ALTER TABLE "tasks" DROP COLUMN "session_md5"');
    expect(migration).toContain('payloads are intentionally discarded');
  });
});
