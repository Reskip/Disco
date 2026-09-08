/**
 * @disco/core - Shared core functionality for Disco
 *
 * Consolidates types, database, git operations, config, and API client
 */

export * from './api/index.js';
export * from './agent-profile.js';
export * from './config/index.js';
export * from './coordination/index.js';
export * from './db/index.js';
export * from './disco-workspace-paths.js';
export * from './mcp/index.js';
export * from './runtime-capabilities.js';
export * from './search/index.js';
export * from './sessions/index.js';
// Re-export everything from submodules
export * from './types/index.js';
export * from './unix/index.js';
export * from './utils/logger.js';
