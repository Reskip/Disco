/**
 * First-run admin bootstrap (daemon-side orchestrator)
 *
 * Owns the filesystem and stderr-UX concerns that the pure-DB
 * `bootstrapFirstRunAdmin` deliberately leaves out:
 *   - Path resolution (`~/.disco/admin-credentials`)
 *   - Atomic credential-file creation (O_EXCL, mode 0600)
 *   - Rollback (unlink credentials file) if user creation fails
 *   - Pretty-print of the result to stderr so operators see the password once
 *
 * The atomicity contract: the credentials file is written *before* the
 * admin row is created. If the file write fails, no admin exists, daemon
 * exits, operator investigates. If user creation fails *after* file write,
 * we unlink the file so the next start has a clean slate.
 */

import { close, open, unlink, write } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type AdminBootstrapResult,
  assertUsableBootstrapAdminPassword,
  BOOTSTRAP_ADMIN_USERNAME,
  bootstrapFirstRunAdmin,
  createUser,
  DEVELOPMENT_DEFAULT_ADMIN_USER,
  generateAdminPassword,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';

const openP = promisify(open);
const writeP = promisify(write);
const closeP = promisify(close);
const unlinkP = promisify(unlink);

const ADMIN_CREDENTIALS_FILENAME = 'admin-credentials';
const ALLOW_DEVELOPMENT_DEFAULT_ADMIN_ENV = 'DISCO_ALLOW_DEVELOPMENT_DEFAULT_ADMIN';

/** Where the generated admin password is persisted on first run. */
export function getAdminCredentialsPath(baseDir: string = join(homedir(), '.disco')): string {
  return join(baseDir, ADMIN_CREDENTIALS_FILENAME);
}

/**
 * Atomically create the credentials file with mode 0600. Uses `O_EXCL` so we
 * refuse to clobber an existing file — an operator who already has stored
 * admin credentials elsewhere must remove the file manually before we
 * regenerate. This avoids the failure mode "credentials file existed with a
 * password we silently overwrote."
 */
async function writeCredentialsExclusive(
  path: string,
  username: string,
  password: string
): Promise<void> {
  const body = [
    '# Disco admin credentials (auto-generated on first run)',
    '#',
    '# Use these to log in at the UI. You will be prompted to change the',
    '# password on first login. This file is mode 0600 — keep it that way.',
    '',
    `username: ${username}`,
    `password: ${password}`,
    '',
  ].join('\n');

  // O_WRONLY | O_CREAT | O_EXCL — fails if the file already exists.
  // Equivalent to `wx` mode in fs.writeFile, but writeFile doesn't expose the
  // mode parameter at create time on all platforms; using `open` directly is
  // the portable way to get both O_EXCL and mode 0600 in one syscall.
  let fd: number;
  try {
    fd = (await openP(path, 'wx', 0o600)) as unknown as number;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Pre-existing credentials file with zero users in the DB is an
      // operator-recoverable but ambiguous state — we refuse to clobber
      // an existing file in case the operator already stored it elsewhere.
      throw new Error(
        [
          `Refusing to bootstrap admin: credentials file already exists at ${path}`,
          'but the users table is empty.',
          '',
          'This usually means a previous bootstrap left a credentials file behind',
          'while the database was reset. To proceed:',
          `  - If you still have the password: keep ${path} as-is and create the`,
          `    admin manually (\`disco local create-admin\`), or restore the DB.`,
          `  - If the password is lost: delete ${path} and restart the daemon`,
          '    to regenerate.',
        ].join('\n')
      );
    }
    throw err;
  }
  try {
    await writeP(fd, body);
  } finally {
    await closeP(fd);
  }
}

/** Best-effort cleanup; swallows ENOENT and logs anything else. */
async function safeUnlink(path: string): Promise<void> {
  try {
    await unlinkP(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`[bootstrap] Failed to unlink ${path}:`, err);
    }
  }
}

/**
 * Result of the daemon-side bootstrap, augmented with the path where
 * credentials landed (if any).
 */
export interface DaemonBootstrapResult extends AdminBootstrapResult {
  /** Path the credentials file was written to. Only set when `createdAdmin` is true. */
  credentialsPath?: string;
}

/**
 * Run the first-run admin bootstrap with filesystem-aware credential
 * persistence and rollback. Idempotent — safe on every daemon start.
 *
 * Password resolution — capability-driven, no deployment-mode flag:
 *   1. DISCO_ADMIN_PASSWORD env var      → use it; no file is written
 *      (caller is presumed to know the value out-of-band, e.g. a k8s
 *      Secret mounted into the daemon's env)
 *   2. Credentials file is writable     → generate + write a 0600 file
 *      with O_EXCL, then create the user (today's flow)
 *   3. Neither                          → fail-fast with a clear error
 *      naming the env var to set or the directory to make writable
 *
 * Atomicity (file path only):
 *   1. Generate the password.
 *   2. Open the credentials file with O_CREAT|O_EXCL|O_WRONLY mode 0600.
 *      Fails fast if the file already exists.
 *   3. Create the admin user with that password.
 *   4. On user-creation failure, unlink the credentials file so the next
 *      start is clean.
 *
 * The `credentialsBaseDir` option exists for tests. Production code should
 * accept the `~/.disco` default.
 */
export async function runFirstRunAdminBootstrap(
  db: TenantScopeAwareDatabase,
  options: { credentialsBaseDir?: string } = {}
): Promise<DaemonBootstrapResult> {
  const credentialsPath = getAdminCredentialsPath(options.credentialsBaseDir);
  const envPassword = process.env.DISCO_ADMIN_PASSWORD;
  const allowDevelopmentDefault = process.env[ALLOW_DEVELOPMENT_DEFAULT_ADMIN_ENV] === 'true';
  let credentialsWritten = false;

  if (allowDevelopmentDefault && process.env.NODE_ENV === 'production') {
    throw new Error(
      `${ALLOW_DEVELOPMENT_DEFAULT_ADMIN_ENV}=true is development-only and is refused when NODE_ENV=production.`
    );
  }

  const result = await bootstrapFirstRunAdmin(db, async () => {
    // 1) Env-var path: use the operator-provided password verbatim. No file
    // touch, no rollback to worry about.
    if (envPassword && envPassword.length > 0) {
      const useDevelopmentDefault =
        allowDevelopmentDefault && envPassword === DEVELOPMENT_DEFAULT_ADMIN_USER.password;
      if (!useDevelopmentDefault) {
        assertUsableBootstrapAdminPassword(envPassword, 'DISCO_ADMIN_PASSWORD');
      }
      return await createUser(db, {
        username: BOOTSTRAP_ADMIN_USERNAME,
        password: envPassword,
        name: 'Admin',
        role: 'superadmin',
        unix_username: 'admin',
        must_change_password: !useDevelopmentDefault,
      });
    }

    // 2) File path: generate + write 0600 with O_EXCL.
    const password = generateAdminPassword();
    try {
      await writeCredentialsExclusive(credentialsPath, BOOTSTRAP_ADMIN_USERNAME, password);
    } catch (err) {
      // 3) EEXIST is operator-recoverable and surfaced by writeCredentialsExclusive
      // with its own clear message. For any other write failure (e.g. read-only
      // mount, missing parent directory), point operators at the env-var escape
      // hatch so they don't have to spelunk the credential file.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw err;
      throw new Error(
        [
          `Failed to write admin credentials file at ${credentialsPath}.`,
          '',
          'Set the DISCO_ADMIN_PASSWORD environment variable to skip the',
          'credentials file entirely (the password you provide is used to',
          'create the bootstrap admin), or make the parent directory',
          'writable so the daemon can persist a generated password.',
          '',
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        ].join('\n')
      );
    }
    credentialsWritten = true;
    try {
      return await createUser(db, {
        username: BOOTSTRAP_ADMIN_USERNAME,
        password,
        name: 'Admin',
        role: 'superadmin',
        unix_username: 'admin',
        // Forces the operator to set their own password after first login.
        // Without this the printed/persisted cleartext stays valid forever.
        must_change_password: true,
      });
    } catch (err) {
      // Roll back the credentials file — otherwise the next start would
      // refuse to bootstrap (O_EXCL) even though no admin exists.
      await safeUnlink(credentialsPath);
      credentialsWritten = false;
      throw err;
    }
  });

  return {
    ...result,
    credentialsPath: credentialsWritten ? credentialsPath : undefined,
  };
}

/**
 * Pretty-print the bootstrap result to stderr. Centralized so the daemon
 * always renders the same message.
 */
export function logFirstRunAdminBootstrap(result: DaemonBootstrapResult): void {
  if (result.createdAdmin && result.admin) {
    process.stderr.write('\n');
    process.stderr.write('================================================================\n');
    process.stderr.write('🔐  First-run admin user created\n');
    process.stderr.write('----------------------------------------------------------------\n');
    process.stderr.write(`    Username:  ${result.admin.username}\n`);
    if (result.credentialsPath) {
      process.stderr.write('    Password:  generated because DISCO_ADMIN_PASSWORD was not set\n');
      process.stderr.write(`               see ${result.credentialsPath} (mode 0600)\n`);
      process.stderr.write('\n');
      process.stderr.write(
        '    WARNING: Read that file to complete first login, then change the password.\n'
      );
      process.stderr.write(
        '    For future fresh deployments, set DISCO_ADMIN_PASSWORD before first startup.\n'
      );
      process.stderr.write(
        '    Setting DISCO_ADMIN_PASSWORD after users exist will not reset passwords.\n'
      );
    } else {
      // Env-var path (DISCO_ADMIN_PASSWORD). Don't print the password — the
      // operator set it themselves; logging it would unnecessarily duplicate
      // a secret into capture systems (k8s logs, journald, etc.).
      process.stderr.write('    Password:  set via the DISCO_ADMIN_PASSWORD env var\n');
    }
    process.stderr.write('\n');
    process.stderr.write('    You will be prompted to change the password on first login.\n');
    process.stderr.write('================================================================\n');
    process.stderr.write('\n');
  }
  if (result.reattributedCount > 0 && result.admin) {
    process.stderr.write(
      `🧹 Re-attributed ${result.reattributedCount} legacy anonymous row(s) → ${result.admin.username}\n`
    );
  }
}

