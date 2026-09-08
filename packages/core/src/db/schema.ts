/**
 * Schema Re-Export with Runtime Dialect Detection
 *
 * This file exports the correct schema based on the database dialect detected at module load time.
 *
 * IMPORTANT: The DISCO_DB_DIALECT environment variable must be set BEFORE any code imports this module.
 * If using PostgreSQL, ensure DISCO_DB_DIALECT=postgresql is set when the process starts.
 *
 * The dialect detection happens at module load time (when this file is first imported).
 * This is necessary because TypeScript/Drizzle requires the actual table objects, not proxies.
 */

import * as postgresSchema from './schema.postgres';
import * as sqliteSchema from './schema.sqlite';
import { getDatabaseDialect } from './schema-factory';

// Determine which schema to use based on runtime dialect
// This is evaluated once at module load time
const dialect = getDatabaseDialect();
const schema = dialect === 'postgresql' ? postgresSchema : sqliteSchema;

// Re-export all tables from the selected schema
export const sessions = schema.sessions;
export const agents = schema.agents;
export const tasks = schema.tasks;
export const taskUsageLedger = schema.taskUsageLedger;
export const executorSessionTokenAuthorities = schema.executorSessionTokenAuthorities;
export const githubInstallStates = schema.githubInstallStates;
export const messages = schema.messages;
export const groups = schema.groups;
export const groupMemberships = schema.groupMemberships;
export const schedules = schema.schedules;
export const users = schema.users;
export const appVariables = schema.appVariables;
export const agenticToolPresets = schema.agenticToolPresets;
export const mcpServers = schema.mcpServers;
export const sessionMcpServers = schema.sessionMcpServers;
export const sessionRelationships = schema.sessionRelationships;
export const sessionEnvSelections = schema.sessionEnvSelections;
export const userMcpOauthTokens = schema.userMcpOauthTokens;
export const mcpOauthPendingFlows = schema.mcpOauthPendingFlows;
export const uploads = schema.uploads;
export const userApiKeys = schema.userApiKeys;

// Re-export all types
export type * from './schema.sqlite';
