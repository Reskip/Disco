import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logFirstRunAdminBootstrap, runFirstRunAdminBootstrap } from './first-run-admin.js';

// Mock the pure-DB layer so we can exercise the daemon-side factory
// without spinning up a real database. The factory is the only piece
// these tests care about.
vi.mock('@disco/core/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    assertUsableBootstrapAdminPassword:
      actual.assertUsableBootstrapAdminPassword ??
      ((password: string, label: string = 'Bootstrap admin password') => {
        if (password === 'admin') {
          throw new Error(`${label} must not be the legacy fixed default password.`);
        }
        if (password.length < 8) {
          throw new Error(`${label} must be at least 8 characters.`);
        }
      }),
    bootstrapFirstRunAdmin: vi.fn(),
    createUser: vi.fn(),
  };
});

describe('logFirstRunAdminBootstrap', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let written: string;

  beforeEach(() => {
    written = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints the credentials file path when one was written', () => {
    logFirstRunAdminBootstrap({
      createdAdmin: true,
      admin: { user_id: 'u1', email: 'admin@example.com' } as unknown as never,
      reattributedCount: 0,
      credentialsPath: '/etc/disco/admin-credentials',
    });
    expect(written).toContain('First-run admin user created');
    expect(written).toContain('generated because DISCO_ADMIN_PASSWORD was not set');
    expect(written).toContain('see /etc/disco/admin-credentials (mode 0600)');
    expect(written).toContain('set DISCO_ADMIN_PASSWORD before first startup');
    expect(written).toContain('will not reset passwords');
  });

  it('points operators at DISCO_ADMIN_PASSWORD when no file was written', () => {
    logFirstRunAdminBootstrap({
      createdAdmin: true,
      admin: { user_id: 'u1', email: 'admin@example.com' } as unknown as never,
      reattributedCount: 0,
      credentialsPath: undefined,
    });
    expect(written).toContain('First-run admin user created');
    expect(written).toContain('set via the DISCO_ADMIN_PASSWORD env var');
    // SECURITY: never echo the password back to stderr.
    expect(written).not.toMatch(/Password:\s+\S{8,}/i);
  });
});

describe('runFirstRunAdminBootstrap — capability-driven password resolution', () => {
  let tempDir: string;
  let originalEnv: string | undefined;
  let originalAllowDevelopmentDefault: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-bootstrap-'));
    originalEnv = process.env.DISCO_ADMIN_PASSWORD;
    originalAllowDevelopmentDefault = process.env.DISCO_ALLOW_DEVELOPMENT_DEFAULT_ADMIN;
    originalNodeEnv = process.env.NODE_ENV;
    delete process.env.DISCO_ADMIN_PASSWORD;
    delete process.env.DISCO_ALLOW_DEVELOPMENT_DEFAULT_ADMIN;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.DISCO_ADMIN_PASSWORD;
    } else {
      process.env.DISCO_ADMIN_PASSWORD = originalEnv;
    }
    if (originalAllowDevelopmentDefault === undefined) {
      delete process.env.DISCO_ALLOW_DEVELOPMENT_DEFAULT_ADMIN;
    } else {
      process.env.DISCO_ALLOW_DEVELOPMENT_DEFAULT_ADMIN = originalAllowDevelopmentDefault;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    vi.clearAllMocks();
  });

  async function loadMocks() {
    const dbModule = (await import('@disco/core/db')) as unknown as {
      bootstrapFirstRunAdmin: ReturnType<typeof vi.fn>;
      createUser: ReturnType<typeof vi.fn>;
    };
    return dbModule;
  }

  it('uses DISCO_ADMIN_PASSWORD verbatim and does NOT write a credentials file', async () => {
    process.env.DISCO_ADMIN_PASSWORD = 'super-secret-from-secret-store';

    const { bootstrapFirstRunAdmin, createUser } = await loadMocks();
    // Invoke the factory so we can assert what it did.
    bootstrapFirstRunAdmin.mockImplementation(
      async (_db: unknown, factory: () => Promise<unknown>) => {
        const admin = await factory();
        return { createdAdmin: true, admin, reattributedCount: 0 };
      }
    );
    createUser.mockResolvedValue({ user_id: 'u1', email: 'admin@example.com' });

    const result = await runFirstRunAdminBootstrap({} as unknown as never, {
      credentialsBaseDir: tempDir,
    });

    // createUser was called with the env-var password verbatim.
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        password: 'super-secret-from-secret-store',
        role: 'superadmin',
        unix_username: 'admin',
      })
    );
    // No credentials file was written.
    expect(result.credentialsPath).toBeUndefined();
    const credentialsPath = path.join(tempDir, 'admin-credentials');
    await expect(fs.access(credentialsPath)).rejects.toThrow();
  });

  it('rejects the legacy fixed default password from DISCO_ADMIN_PASSWORD', async () => {
    process.env.DISCO_ADMIN_PASSWORD = 'admin';

    const { bootstrapFirstRunAdmin } = await loadMocks();
    bootstrapFirstRunAdmin.mockImplementation(
      async (_db: unknown, factory: () => Promise<unknown>) => factory()
    );

    await expect(
      runFirstRunAdminBootstrap({} as unknown as never, { credentialsBaseDir: tempDir })
    ).rejects.toThrow(/legacy fixed default password/);
  });

  it('allows the fixed default only behind the explicit development gate', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DISCO_ADMIN_PASSWORD = 'admin';
    process.env.DISCO_ALLOW_DEVELOPMENT_DEFAULT_ADMIN = 'true';

    const { bootstrapFirstRunAdmin, createUser } = await loadMocks();
    bootstrapFirstRunAdmin.mockImplementation(
      async (_db: unknown, factory: () => Promise<unknown>) => ({
        createdAdmin: true,
        admin: await factory(),
        reattributedCount: 0,
      })
    );
    createUser.mockResolvedValue({ user_id: 'u1', username: 'admin' });

    await runFirstRunAdminBootstrap({} as unknown as never, { credentialsBaseDir: tempDir });

    expect(createUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ password: 'admin', must_change_password: false })
    );
  });

  it('refuses the development-default gate in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DISCO_ADMIN_PASSWORD = 'admin';
    process.env.DISCO_ALLOW_DEVELOPMENT_DEFAULT_ADMIN = 'true';

    await expect(
      runFirstRunAdminBootstrap({} as unknown as never, { credentialsBaseDir: tempDir })
    ).rejects.toThrow(/development-only.*NODE_ENV=production/);
  });

  it('falls back to file-based generation when DISCO_ADMIN_PASSWORD is absent', async () => {
    const { bootstrapFirstRunAdmin, createUser } = await loadMocks();
    bootstrapFirstRunAdmin.mockImplementation(
      async (_db: unknown, factory: () => Promise<unknown>) => {
        const admin = await factory();
        return { createdAdmin: true, admin, reattributedCount: 0 };
      }
    );
    createUser.mockResolvedValue({ user_id: 'u1', email: 'admin@example.com' });

    const result = await runFirstRunAdminBootstrap({} as unknown as never, {
      credentialsBaseDir: tempDir,
    });

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'superadmin', unix_username: 'admin' })
    );
    expect(result.credentialsPath).toBe(path.join(tempDir, 'admin-credentials'));
    // File exists with mode 0600 on POSIX. Windows does not expose POSIX mode
    // bits reliably through stat(), even after chmod().
    const stat = await fs.stat(result.credentialsPath as string);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
  });

  it('errors with DISCO_ADMIN_PASSWORD remediation when the directory is unwritable', async () => {
    const { bootstrapFirstRunAdmin } = await loadMocks();
    bootstrapFirstRunAdmin.mockImplementation(
      async (_db: unknown, factory: () => Promise<unknown>) => factory()
    );

    // Point credentialsBaseDir at a path whose parent doesn't exist → ENOENT
    // on file create. This mirrors a read-only or absent DISCO_HOME mount.
    const unwritable = path.join(tempDir, 'does', 'not', 'exist');
    await expect(
      runFirstRunAdminBootstrap({} as unknown as never, { credentialsBaseDir: unwritable })
    ).rejects.toThrow(/DISCO_ADMIN_PASSWORD/);
  });
});
