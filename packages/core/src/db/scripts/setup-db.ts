#!/usr/bin/env node

/**
 * Database Setup Script
 *
 * Initializes the Disco database with tables and seed data.
 * Run this once to set up a new database or reset an existing one.
 *
 * Usage:
 *   npm run db:setup                    # Use default path (~/.disco/sessions.db)
 *   npm run db:setup -- --path ./test.db # Use custom path
 *   npm run db:setup -- --reset          # Drop and recreate tables
 */

import { sql } from 'drizzle-orm';
import { createDatabase, DEFAULT_DB_PATH } from '../client';
import { isSQLiteDatabase } from '../database-wrapper';
import { runMigrations, seedInitialData } from '../migrate';
import { sanitizeDbError } from '../sanitize-error';

interface SetupOptions {
  path?: string;
  reset?: boolean;
}

async function parseArgs(): Promise<SetupOptions> {
  const args = process.argv.slice(2);
  const options: SetupOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--path' && i + 1 < args.length) {
      options.path = args[i + 1];
      i++;
    } else if (arg === '--reset') {
      options.reset = true;
    }
  }

  return options;
}

async function dropTables(db: ReturnType<typeof createDatabase>): Promise<void> {
  console.log('Dropping existing tables...');

  // Execute raw SQL based on database type
  if (isSQLiteDatabase(db)) {
    await db.run(sql`DROP TABLE IF EXISTS session_env_selections`);
    await db.run(sql`DROP TABLE IF EXISTS session_mcp_servers`);
    await db.run(sql`DROP TABLE IF EXISTS user_mcp_oauth_tokens`);
    await db.run(sql`DROP TABLE IF EXISTS mcp_oauth_pending_flows`);
    await db.run(sql`DROP TABLE IF EXISTS messages`);
    await db.run(sql`DROP TABLE IF EXISTS tasks`);
    await db.run(sql`DROP TABLE IF EXISTS session_relationships`);
    await db.run(sql`DROP TABLE IF EXISTS schedules`);
    await db.run(sql`DROP TABLE IF EXISTS uploads`);
    await db.run(sql`DROP TABLE IF EXISTS executor_session_token_authorities`);
    await db.run(sql`DROP TABLE IF EXISTS github_install_states`);
    await db.run(sql`DROP TABLE IF EXISTS sessions`);
    await db.run(sql`DROP TABLE IF EXISTS agents`);
    await db.run(sql`DROP TABLE IF EXISTS user_api_keys`);
    await db.run(sql`DROP TABLE IF EXISTS group_memberships`);
    await db.run(sql`DROP TABLE IF EXISTS groups`);
    await db.run(sql`DROP TABLE IF EXISTS app_variables`);
    await db.run(sql`DROP TABLE IF EXISTS agentic_tool_presets`);
    await db.run(sql`DROP TABLE IF EXISTS mcp_servers`);
    await db.run(sql`DROP TABLE IF EXISTS users`);
    await db.run(sql`DROP TABLE IF EXISTS __drizzle_migrations`);
  } else {
    await db.execute(sql`DROP TABLE IF EXISTS session_env_selections CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS session_mcp_servers CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS user_mcp_oauth_tokens CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS mcp_oauth_pending_flows CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS messages CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS tasks CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS session_relationships CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS schedules CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS uploads CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS executor_session_token_authorities CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS github_install_states CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS sessions CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS agents CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS user_api_keys CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS group_memberships CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS groups CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS app_variables CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS agentic_tool_presets CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS mcp_servers CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS users CASCADE`);
    await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  }

  console.log('Tables dropped');
}

async function main() {
  try {
    const options = await parseArgs();
    const dbPath = options.path ?? DEFAULT_DB_PATH;

    console.log(`Setting up database at: ${dbPath}`);
    console.log('');

    // Create database connection
    const db = createDatabase({ url: dbPath });

    // Reset if requested
    if (options.reset) {
      await dropTables(db);
      console.log('');
    }

    // Initialize schema
    await runMigrations(db, { allowOfflineCutover: true });
    console.log('');

    // Seed initial data
    await seedInitialData(db);
    console.log('');

    console.log('✅ Database setup complete!');
    console.log('');
    console.log('Next steps:');
    console.log('  - Run `npm run db:studio` to open Drizzle Studio');
    console.log('  - Import repositories from @disco/core/db');
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error('❌ Setup failed:', sanitizeDbError(error));
    process.exit(1);
  }
}

main();
