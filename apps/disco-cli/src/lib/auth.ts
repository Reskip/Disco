/**
 * Authentication utilities for CLI
 *
 * Handles JWT token storage and retrieval for daemon authentication
 */

import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DISCO_DIR = join(homedir(), '.disco');
const TOKEN_FILE = join(DISCO_DIR, 'cli-token');

export interface StoredAuth {
  version: 3;
  target: {
    url: string;
    origin: string;
    deploymentId: string;
  };
  accessToken: string;
  user: {
    user_id: string;
    username: string;
    name?: string;
    role: string;
  };
  expiresAt: number;
}

/**
 * Save authentication token to disk
 */
export async function saveToken(auth: StoredAuth): Promise<void> {
  // Ensure .disco directory exists
  await mkdir(DISCO_DIR, { recursive: true });

  // Write token file with restrictive permissions
  await writeFile(TOKEN_FILE, JSON.stringify(auth, null, 2), {
    mode: 0o600, // Owner read/write only
  });
  await chmod(TOKEN_FILE, 0o600);
}

/**
 * Load authentication token from disk
 */
export async function loadToken(): Promise<StoredAuth | null> {
  try {
    const data = await readFile(TOKEN_FILE, 'utf-8');
    const auth = JSON.parse(data) as Partial<StoredAuth>;

    // Legacy tokens were not bound to an origin or deployment and must never
    // be sent speculatively to the currently configured URL.
    if (
      auth.version !== 3 ||
      !auth.target?.url ||
      !auth.target?.origin ||
      !auth.target.deploymentId ||
      !auth.accessToken ||
      !auth.user ||
      !auth.user.username
    ) {
      return null;
    }

    // Check if token is expired
    if (auth.expiresAt && Date.now() > auth.expiresAt) {
      // Token expired, remove it
      await clearToken();
      return null;
    }

    return auth as StoredAuth;
  } catch {
    // File doesn't exist or is invalid
    return null;
  }
}

/**
 * Clear stored authentication token
 */
export async function clearToken(): Promise<void> {
  try {
    await unlink(TOKEN_FILE);
  } catch {
    // File doesn't exist, that's fine
  }
}
