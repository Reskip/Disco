/**
 * Daemon entrypoint — starts the server.
 *
 * index.ts is a pure library that exports startDaemon().
 * This file calls it for direct execution (pnpm dev, node dist/main.js).
 *
 * Supports DISCO_CONFIG_PATH env var for config file override
 * (set by `disco daemon start --config ...`).
 */

import { startDaemon } from './index.js';

const configPath = process.env.DISCO_CONFIG_PATH || undefined;

startDaemon(configPath ? { configPath } : undefined).catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
