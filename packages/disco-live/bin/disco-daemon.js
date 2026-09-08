#!/usr/bin/env node

/**
 * Disco Daemon Entry Point (Production)
 *
 * This entry point loads the bundled daemon from dist/daemon.
 * The daemon is compiled from apps/disco-daemon and bundled during build.
 */

// Check Node.js version requirement before loading any dependencies
import { checkNodeVersion } from './version-check.js';

checkNodeVersion();

const { readFileSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { dirname: pathDirname, join: pathJoin } = await import('node:path');
const { fileURLToPath: toFilePath, pathToFileURL } = await import('node:url');
const packageRoot = pathJoin(pathDirname(toFilePath(import.meta.url)), '..');
const packageMetadata = JSON.parse(readFileSync(pathJoin(packageRoot, 'package.json'), 'utf8'));
// The installed package is the authority for its managed-integration version.
// Do not inherit a stale value when an older Disco executor upgrades the host.
process.env.DISCO_VERSION = packageMetadata.version;
process.env.DISCO_AGENTIC_TOOLS_DIR ??= pathJoin(homedir(), '.disco', 'agentic-tools');
process.env.DISCO_MANAGED_AGENTIC_TOOLS ??= '1';

// Use dynamic imports to ensure version check runs first
const path = await import('node:path');

// Get directory of this file
const dirname = path.dirname(toFilePath(import.meta.url));

// Daemon is bundled in dist/daemon relative to bin/
const daemonPath = path.resolve(dirname, '../dist/daemon/main.js');

// Import and run the daemon
await import(pathToFileURL(daemonPath).href);
