#!/usr/bin/env node

/**
 * Disco CLI Entry Point (Production)
 *
 * This entry point loads the bundled CLI from dist/cli.
 * The CLI commands are compiled from apps/disco-cli and bundled during build.
 */

// Check Node.js version requirement before loading any dependencies
import { checkNodeVersion } from './version-check.js';

checkNodeVersion();

const { readFileSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { dirname: pathDirname, join: pathJoin } = await import('node:path');
const { fileURLToPath: toFilePath } = await import('node:url');
const packageRoot = pathJoin(pathDirname(toFilePath(import.meta.url)), '..');
const packageMetadata = JSON.parse(readFileSync(pathJoin(packageRoot, 'package.json'), 'utf8'));
// The installed package is the authority for its managed-integration version.
// Do not inherit a stale value when an older Disco executor upgrades the host.
process.env.DISCO_VERSION = packageMetadata.version;
process.env.DISCO_AGENTIC_TOOLS_DIR ??= pathJoin(homedir(), '.disco', 'agentic-tools');
process.env.DISCO_MANAGED_AGENTIC_TOOLS ??= '1';

// Use dynamic import to ensure version check runs first
const { execute } = await import('@oclif/core');

// oclif will resolve commands relative to this file
// Commands are at ../dist/cli/commands (configured in package.json)
await execute({ development: false, dir: import.meta.url });
