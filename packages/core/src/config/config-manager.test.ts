/**
 * Tests for Disco Config Manager
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetConfigCacheForTests,
  assertValidEffectiveExecutionConfig,
  createInitialConfig,
  expandHomePath,
  getDiscoHome,
  getBaseUrl,
  getConfigPath,
  getConfigValue,
  getDaemonBaseUrl,
  getDaemonUrl,
  getDataHome,
  getDefaultConfig,
  getTenantDataRoot,
  getWorktreesRoot,
  initConfig,
  loadConfig,
  loadConfigSync,
  PublicBaseUrlNotConfiguredError,
  requirePublicBaseUrl,
  resolveEffectiveConfig,
  rewriteConfigForTests,
  saveConfigForTests,
  unixUserModeRequiresExecutionHomeKey,
} from './config-manager';
import type { DiscoConfig } from './types';

/**
 * Helper: Create test config data
 */
function createConfigData(overrides?: Partial<DiscoConfig>): DiscoConfig {
  return {
    daemon: {
      port: 4000,
      host: '0.0.0.0',
    },
    ui: {
      port: 8080,
      host: '127.0.0.1',
    },
    ...overrides,
  };
}

/**
 * Helper: Create minimal config
 */
function createMinimalConfig(): DiscoConfig {
  return {
    daemon: { port: 3030 },
  };
}

describe('getDiscoHome', () => {
  it('should return ~/.disco path', () => {
    const home = getDiscoHome();
    expect(home).toBe(path.join(os.homedir(), '.disco'));
  });
});

describe('getConfigPath', () => {
  it('should return ~/.disco/config.yaml path', () => {
    const configPath = getConfigPath();
    expect(configPath).toBe(path.join(os.homedir(), '.disco', 'config.yaml'));
  });
});

describe('getDefaultConfig', () => {
  it('should return complete default config structure', () => {
    const defaults = getDefaultConfig();

    // Verify structure and key defaults
    expect(defaults.daemon?.port).toBe(3030);
    expect(defaults.daemon?.host).toBe('localhost');
    expect(defaults.ui?.port).toBe(5173);
    expect(defaults.ui?.host).toBe('localhost');
    expect(defaults.analytics?.enabled).toBe(false);
    expect(defaults.uploads?.max_age_days).toBe(0);
    expect(defaults.uploads?.max_file_size_mb).toBe(0);
  });
});

describe('resolveEffectiveConfig', () => {
  it('materializes defaults and supported environment overrides without mutating input', () => {
    const input: DiscoConfig = { daemon: { host: 'yaml-host', port: 1234 } };
    const resolved = resolveEffectiveConfig(input, {
      PORT: '4321',
      DAEMON_HOST: 'env-host',
      DISCO_UNIX_USER_MODE: 'delegated',
      INSTANCE_LABEL: 'replica-a',
    });
    expect(resolved.daemon).toMatchObject({
      host: 'env-host',
      port: 4321,
      mcpEnabled: true,
      instanceLabel: 'replica-a',
    });
    expect(resolved.execution).toMatchObject({ unix_user_mode: 'delegated' });
    expect(resolved.multi_tenancy?.mode).toBe('static');
    expect(input).toEqual({ daemon: { host: 'yaml-host', port: 1234 } });
  });

  it('projects DISCO_DATA_HOME into the effective config snapshot', () => {
    const resolved = resolveEffectiveConfig(
      { paths: { data_home: '/from-yaml' } },
      { DISCO_DATA_HOME: '/from-environment' }
    );
    expect(resolved.paths?.data_home).toBe('/from-environment');
  });

  it.each(['opportunistic', 'strict', 'insulated'])(
    'rejects removed DISCO_UNIX_USER_MODE=%s overrides with migration guidance',
    (mode) => {
      expect(() => resolveEffectiveConfig({}, { DISCO_UNIX_USER_MODE: mode })).toThrow(
        new RegExp(`${mode}.*removed in Disco 0\\.25\\.0`, 's')
      );
    }
  );

  it('rejects an unknown DISCO_UNIX_USER_MODE override', () => {
    expect(() => resolveEffectiveConfig({}, { DISCO_UNIX_USER_MODE: 'root' })).toThrow(
      /must be one of: simple, sandbox, delegated/
    );
  });

  it('treats an empty DISCO_UNIX_USER_MODE from Compose as no override', () => {
    expect(resolveEffectiveConfig({}, { DISCO_UNIX_USER_MODE: '' }).execution?.unix_user_mode).toBe(
      resolveEffectiveConfig({}, {}).execution?.unix_user_mode
    );
    expect(
      resolveEffectiveConfig(
        { execution: { unix_user_mode: 'sandbox' } },
        { DISCO_UNIX_USER_MODE: '' }
      ).execution?.unix_user_mode
    ).toBe('sandbox');
  });

  it('unix_user_mode: sandbox implies an enabled per-user sandbox that fails closed', () => {
    const resolved = resolveEffectiveConfig({ execution: { unix_user_mode: 'sandbox' } }, {});
    expect(resolved.execution?.sandbox).toMatchObject({
      enabled: true,
      home_mode: 'per_user',
      fail_if_unavailable: true,
    });
  });

  it('sandbox mode FORCES its security invariants — config/env cannot weaken them', () => {
    const resolved = resolveEffectiveConfig(
      {
        execution: {
          unix_user_mode: 'sandbox',
          // Every one of these attempts to weaken the mode and must be ignored.
          sandbox: { enabled: false, home_mode: 'shared', fail_if_unavailable: false },
        },
      },
      { DISCO_SANDBOX_HOME_MODE: 'shared' }
    );
    expect(resolved.execution?.sandbox).toMatchObject({
      enabled: true,
      home_mode: 'per_user',
      fail_if_unavailable: true,
    });
  });

  it('sandbox mode preserves non-security tunables (include/extras/protect_secrets)', () => {
    const resolved = resolveEffectiveConfig(
      {
        execution: {
          unix_user_mode: 'sandbox',
          sandbox: {
            extra_allow_write: ['/opt/cache'],
            include: { tmp: false },
            preserve_canonical_home_alias: true,
          },
        },
      },
      {}
    );
    expect(resolved.execution?.sandbox?.extra_allow_write).toEqual(['/opt/cache']);
    expect(resolved.execution?.sandbox?.include).toMatchObject({ tmp: false });
    expect(resolved.execution?.sandbox?.preserve_canonical_home_alias).toBe(true);
    expect(resolved.execution?.sandbox).toMatchObject({ enabled: true, home_mode: 'per_user' });
  });

  it('DISCO_SANDBOX_HOME_MODE env still overrides home_mode without the sandbox isolation mode', () => {
    const resolved = resolveEffectiveConfig(
      { execution: { sandbox: { enabled: true } } },
      { DISCO_SANDBOX_HOME_MODE: 'per_user' }
    );
    expect(resolved.execution?.sandbox).toMatchObject({ enabled: true, home_mode: 'per_user' });
  });
});

describe('assertValidEffectiveExecutionConfig', () => {
  it('requires delegated mode to name an external execution substrate', () => {
    expect(() =>
      assertValidEffectiveExecutionConfig({ execution: { unix_user_mode: 'delegated' } })
    ).toThrow(/requires execution\.executor_command_template/);
  });

  it.each(['{unix_user_uid}', '{unix_user_gid}'])(
    'rejects removed delegated template placeholder %s at startup',
    (placeholder) => {
      expect(() =>
        assertValidEffectiveExecutionConfig({
          execution: {
            unix_user_mode: 'delegated',
            executor_command_template: `launcher --legacy ${placeholder} -- {command}`,
          },
        })
      ).toThrow(/removed placeholder/);
    }
  );

  it('rejects sandboxing combined with an external executor template', () => {
    expect(() =>
      assertValidEffectiveExecutionConfig({
        execution: {
          unix_user_mode: 'delegated',
          executor_command_template: 'docker run {{command}}',
          sandbox: { enabled: true },
        },
      })
    ).toThrow(/executor_command_template/);
  });

  it('allows supported standalone and named sandbox configurations', () => {
    expect(() =>
      assertValidEffectiveExecutionConfig(
        resolveEffectiveConfig({ execution: { unix_user_mode: 'sandbox' } }, {})
      )
    ).not.toThrow();
    expect(() =>
      assertValidEffectiveExecutionConfig({
        execution: { unix_user_mode: 'simple', sandbox: { enabled: true } },
      })
    ).not.toThrow();
  });
});

describe('expandHomePath', () => {
  it('should return the original path when no tilde prefix is present', () => {
    expect(expandHomePath('/tmp/example')).toBe('/tmp/example');
  });

  it('should expand a tilde-prefixed path using the user home directory', () => {
    const expected = path.join(os.homedir(), 'workspace');
    expect(expandHomePath('~/workspace')).toBe(expected);
  });
});

describe('loadConfig', () => {
  let tempDir: string;
  let _originalHome: string;

  beforeEach(async () => {
    // Create temp directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-test-'));

    // Mock os.homedir to use temp directory
    _originalHome = os.homedir();
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should load existing config file', async () => {
    const configData = createConfigData();
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');

    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump(configData), 'utf-8');

    const loaded = await loadConfig();
    expect(loaded).toMatchObject(configData);
  });

  it('loads the documented canonical-home sandbox compatibility setting', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      path.join(discoDir, 'config.yaml'),
      'execution:\n  unix_user_mode: sandbox\n  sandbox:\n    preserve_canonical_home_alias: true\n',
      'utf-8'
    );

    await expect(loadConfig()).resolves.toMatchObject({
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { preserve_canonical_home_alias: true },
      },
    });
  });

  it('rejects unknown sandbox keys and a non-boolean canonical-home option', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      configPath,
      'execution:\n  sandbox:\n    preserve_canonical_home_alias: true\n    surprise: true\n',
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/execution\.sandbox\.surprise/);

    await fs.writeFile(
      configPath,
      'execution:\n  sandbox:\n    preserve_canonical_home_alias: "true"\n',
      'utf-8'
    );
    __resetConfigCacheForTests();
    await expect(loadConfig()).rejects.toThrow(/preserve_canonical_home_alias must be a boolean/);
  });

  it('rejects the removed mcp_catalog config surface', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      path.join(discoDir, 'config.yaml'),
      yaml.dump({
        mcp_catalog: {
          registry_sync_enabled: true,
          sync_interval_hours: 12,
          probe_budget: 40,
          registry_url: 'https://registry.internal',
        },
      }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/unrecognized top-level key: mcp_catalog/);
  });

  it('should return default config when file does not exist', async () => {
    const loaded = await loadConfig();
    const defaults = getDefaultConfig();
    expect(loaded).toEqual(defaults);
  });

  // Manufacturing the mask's EACCES needs mode bits, which don't constrain
  // root and aren't honored off POSIX — same reason as the unreadable-file
  // test below.
  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    'should explain the sandbox rather than fabricate a config when masked',
    async () => {
      // The executor sandbox masks the daemon's config.yaml with a `--ro-bind
      // /dev/null` mount, so reads from inside fail with EACCES rather than
      // ENOENT. Falling back to defaults here would be worse than failing: the
      // defaults carry no `paths` key and disable filesystem isolation, so a
      // fabricated config resolves tenant data roots to the wrong directory.
      // Mounting needs privileges tests don't have; an unreadable file
      // produces the same EACCES the mask does.
      const discoDir = path.join(tempDir, '.disco');
      const configPath = path.join(discoDir, 'config.yaml');

      await fs.mkdir(discoDir, { recursive: true });
      await fs.writeFile(configPath, yaml.dump(createConfigData()), 'utf-8');
      await fs.chmod(configPath, 0o000);
      vi.stubEnv('DISCO_OUTER_SANDBOX', '1');

      try {
        await expect(loadConfig()).rejects.toThrow(
          /masked by Disco's executor sandbox.*payload\.resolvedConfig and DAEMON_URL/s
        );

        __resetConfigCacheForTests();
        expect(() => loadConfigSync()).toThrow(/masked by Disco's executor sandbox/s);
      } finally {
        // restoreAllMocks() does not undo stubEnv, and the marker leaking into
        // later tests would silently rewrite their expected errors.
        vi.unstubAllEnvs();
        await fs.chmod(configPath, 0o600);
      }
    }
  );

  // The masked-config diagnostic is a better message, never a different
  // outcome: outside the sandbox the same failures stay loud and unchanged.
  it('should fail loudly when the config path is a directory', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');

    await fs.mkdir(discoDir, { recursive: true });
    await fs.mkdir(configPath);

    await expect(loadConfig()).rejects.toThrow(/Failed to load config.*EISDIR/s);

    __resetConfigCacheForTests();
    expect(() => loadConfigSync()).toThrow(/Failed to load config.*EISDIR/s);
  });

  // Permission bits don't constrain root, and non-POSIX hosts don't honor
  // mode 000 at all, so this can only assert anything as an unprivileged
  // POSIX user.
  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    'should fail loudly when a regular config file is unreadable',
    async () => {
      const discoDir = path.join(tempDir, '.disco');
      const configPath = path.join(discoDir, 'config.yaml');

      await fs.mkdir(discoDir, { recursive: true });
      await fs.writeFile(configPath, yaml.dump(createConfigData()), 'utf-8');
      await fs.chmod(configPath, 0o000);

      try {
        await expect(loadConfig()).rejects.toThrow(/Failed to load config.*EACCES/s);

        __resetConfigCacheForTests();
        expect(() => loadConfigSync()).toThrow(/Failed to load config.*EACCES/s);
      } finally {
        // Restore so the afterEach cleanup can remove it.
        await fs.chmod(configPath, 0o600);
      }
    }
  );

  it('should return empty config for empty YAML file', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');

    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(configPath, '', 'utf-8');

    const loaded = await loadConfig();
    expect(loaded).toEqual({});
  });

  it('should throw error for invalid YAML', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');

    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(configPath, 'invalid: yaml: [content', 'utf-8');

    await expect(loadConfig()).rejects.toThrow('Failed to load config');
  });

  it('rejects the removed managed environment execution mode', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');

    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ execution: { managed_envs_execution_mode: 'webhook-only' } }),
      'utf-8'
    );

    await expect(loadConfig()).rejects.toThrow(/execution\.managed_envs_execution_mode/);
  });

  it.each(['resources', 'services', 'credentials', 'opencode', 'codex'])(
    'rejects the removed %s config surface',
    async (key) => {
      const discoDir = path.join(tempDir, '.disco');
      const configPath = path.join(discoDir, 'config.yaml');
      await fs.mkdir(discoDir, { recursive: true });
      await fs.writeFile(configPath, yaml.dump({ [key]: {} }), 'utf-8');

      await expect(loadConfig()).rejects.toThrow(new RegExp(`'${key}' has been removed`));
    }
  );

  it('rejects the removed execution.cursor_sdk_enabled flag', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ execution: { cursor_sdk_enabled: true } }), 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/execution\.cursor_sdk_enabled.*removed/);
  });

  it('rejects unrecognized top-level keys', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ speculative_feature: true }), 'utf-8');
    await expect(loadConfig()).rejects.toThrow(/unrecognized top-level key: speculative_feature/);
  });

  it('accepts a deployment-owned agentic tool package list', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ agentic_tools: { installed: ['claude-code', 'codex'] } }),
      'utf-8'
    );
    await expect(loadConfig()).resolves.toMatchObject({
      agentic_tools: { installed: ['claude-code', 'codex'] },
    });
  });

  it('rejects unsupported or duplicate configured agentic tools', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ agentic_tools: { installed: ['codex', 'codex'] } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/duplicate tool.*codex/);

    __resetConfigCacheForTests();
    await fs.writeFile(
      configPath,
      yaml.dump({ agentic_tools: { installed: ['future-tool'] } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/unsupported tool.*future-tool/);
  });

  it('rejects the removed proxies config surface as an unknown top-level key', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ proxies: { shortcut: { upstream: 'https://api.app.shortcut.com' } } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/unrecognized top-level key: proxies/);
  });

  it('continues to accept daemon.trust_proxy_hops for deployment reverse proxies', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ daemon: { trust_proxy_hops: 2 } }), 'utf-8');
    await expect(loadConfig()).resolves.toMatchObject({ daemon: { trust_proxy_hops: 2 } });
  });

  it('reports every unrecognized nested key at the deepest known config boundary', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({ daemon: { surprise: true }, execution: { unknown_storage: { mystery: 1 } } }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/daemon\.surprise.*execution\.unknown_storage/);
  });

  it('rejects removed top-level and nested settings instead of ignoring them', async () => {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.dump({
        daemon: { allowAnonymous: false, requireAuth: true },
        defaults: { board: 'main', agent: 'claude-code' },
        display: { shortIdLength: 12, tableStyle: 'ascii', colorOutput: false },
        execution: { managed_envs_minimum_role: 'admin' },
        branches: { others_can_default: 'view', others_fs_access_default: 'none' },
        onboarding: { teammatePending: true, frameworkRepoUrl: 'https://example.test/repo.git' },
      }),
      'utf-8'
    );
    await expect(loadConfig()).rejects.toThrow(/defaults.*display.*branches.*onboarding/);
  });

  it('should handle partial config with missing sections', async () => {
    const partialConfig: DiscoConfig = {
      daemon: { port: 4040 },
      // Missing other sections
    };

    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');

    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(configPath, yaml.dump(partialConfig), 'utf-8');

    const loaded = await loadConfig();
    expect(loaded.daemon?.port).toBe(4040);
  });

});

describe('loadConfig cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-cache-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    __resetConfigCacheForTests();
  });

  async function writeConfigFile(data: DiscoConfig | string): Promise<string> {
    const discoDir = path.join(tempDir, '.disco');
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(discoDir, { recursive: true });
    const body = typeof data === 'string' ? data : yaml.dump(data);
    await fs.writeFile(configPath, body, 'utf-8');
    return configPath;
  }

  it('serves repeated reads from the cache without re-parsing YAML', async () => {
    await writeConfigFile({ daemon: { port: 4000 } });

    // First call hits the disk; subsequent calls hit the cache.
    // We prove cache behavior by spying on file reads rather than relying
    // on object identity (the cache hands out clones, not the shared object
    // — see "isolated from caller mutation").
    const readFileSpy = vi.spyOn(fs, 'readFile');
    const first = await loadConfig();
    const callsAfterFirst = readFileSpy.mock.calls.length;
    const second = await loadConfig();
    const third = await loadConfig();

    expect(first.daemon?.port).toBe(4000);
    expect(second.daemon?.port).toBe(4000);
    expect(third.daemon?.port).toBe(4000);
    // No additional file reads after the first.
    expect(readFileSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('loadConfigSync shares the same cache as loadConfig', async () => {
    await writeConfigFile({ daemon: { port: 5555 } });

    const fromAsync = await loadConfig();
    const fromSync = loadConfigSync();

    expect(fromAsync.daemon?.port).toBe(5555);
    expect(fromSync.daemon?.port).toBe(5555);
    // Sync read should reuse the async-loaded cache entry.
  });

  it('isolates callers from each other: mutating a returned config does not affect later reads', async () => {
    await writeConfigFile({ daemon: { port: 4000 } });

    const first = await loadConfig();
    // A caller mutates its private clone; the cached deployment input stays unchanged.
    first.daemon ??= {};
    first.daemon.port = 9999;

    const second = await loadConfig();
    // The cache returned a clone, so the mutation didn't leak.
    expect(second.daemon?.port).toBe(4000);
  });

  it('saveConfigForTests invalidates the cache so the next read returns the new value', async () => {
    await saveConfigForTests({ daemon: { port: 4000 } } as DiscoConfig);
    const before = await loadConfig();
    expect(before.daemon?.port).toBe(4000);

    await saveConfigForTests({ daemon: { port: 9999 } } as DiscoConfig);
    const after = await loadConfig();
    expect(after.daemon?.port).toBe(9999);
  });

  it('picks up external file mutations via mtime change', async () => {
    const configPath = await writeConfigFile({ daemon: { port: 4000 } });
    expect((await loadConfig()).daemon?.port).toBe(4000);

    // Force a distinct mtime — on filesystems with millisecond resolution,
    // back-to-back writes can collide.
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(configPath, yaml.dump({ daemon: { port: 7777 } }), 'utf-8');

    expect((await loadConfig()).daemon?.port).toBe(7777);
  });

  it('returns defaults when the file is missing, then re-reads after the file is created', async () => {
    // No file yet → defaults are cached under the NO_FILE sentinel.
    const before = await loadConfig();
    expect(before).toEqual(getDefaultConfig());

    // Create the file. The cached NO_FILE sentinel no longer matches stat,
    // so the next load re-reads.
    await writeConfigFile({ daemon: { port: 6666 } });
    const after = await loadConfig();
    expect(after.daemon?.port).toBe(6666);
  });

  it('does not poison the cache on parse error', async () => {
    await writeConfigFile('invalid: yaml: [content');

    await expect(loadConfig()).rejects.toThrow('Failed to load config');

    // After fixing the file, the next call should succeed (we never cached
    // a partial / broken value).
    await new Promise((r) => setTimeout(r, 20));
    await writeConfigFile({ daemon: { port: 8888 } });
    const recovered = await loadConfig();
    expect(recovered.daemon?.port).toBe(8888);
  });

  it('validates on every load path: loadConfigSync rejects removed values too', async () => {
    // Regression guard for the shared-cache bug: if loadConfigSync had a
    // separate (un-validated) code path, calling it first could populate
    // the cache with an invalid config that a later loadConfig() would
    // silently return.
    //
    // YAML written as a raw string because `unix_user_mode: 'opportunistic'`
    // is intentionally not assignable to `DiscoConfig.execution.unix_user_mode`
    // (the value was removed from the type) — that's what
    // validateConfig() catches at runtime for users who still have the value
    // in their config.yaml.
    await writeConfigFile('execution:\n  unix_user_mode: opportunistic\n');

    expect(() => loadConfigSync()).toThrow(/opportunistic.*removed in Disco 0\.25\.0/s);
    // And async path stays consistent.
    await expect(loadConfig()).rejects.toThrow(/opportunistic.*removed in Disco 0\.25\.0/s);
  });

  it.each(['strict', 'insulated'])(
    'rejects removed %s mode with migration guidance',
    async (mode) => {
      await writeConfigFile(`execution:\n  unix_user_mode: ${mode}\n`);
      expect(() => loadConfigSync()).toThrow(
        new RegExp(`${mode}.*removed in Disco 0\\.25\\.0`, 's')
      );
      await expect(loadConfig()).rejects.toThrow(/latest Disco 0\.24\.x release/s);
    }
  );

  it.each(['executor_unix_user', 'sync_unix_passwords'])(
    'rejects removed host execution key %s',
    async (key) => {
      await writeConfigFile(`execution:\n  ${key}: legacy-value\n`);
      expect(() => loadConfigSync()).toThrow(new RegExp(`execution\\.${key}`));
      await expect(loadConfig()).rejects.toThrow(/removed host Unix execution/);
    }
  );

  it('rejects removed analytics module plugins on every load path', async () => {
    await writeConfigFile(
      'analytics:\n  enabled: false\n  plugins:\n    - type: module\n      enabled: false\n      options:\n        module_path: /opt/disco/plugin.js\n'
    );

    expect(() => loadConfigSync()).toThrow(
      /analytics\.plugins\[0\].*module.*removed.*stdout.*http_batch/s
    );
    await expect(loadConfig()).rejects.toThrow(
      /analytics\.plugins\[0\].*module.*removed.*stdout.*http_batch/s
    );
  });

});

describe('unixUserModeRequiresExecutionHomeKey', () => {
  it('requires a username only in delegated mode', () => {
    expect(unixUserModeRequiresExecutionHomeKey('simple')).toBe(false);
    expect(unixUserModeRequiresExecutionHomeKey('sandbox')).toBe(false);
    expect(unixUserModeRequiresExecutionHomeKey('delegated')).toBe(true);
  });
});

describe('base URL resolution', () => {
  let tempDir: string;
  let originalBaseUrl: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-base-url-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    originalBaseUrl = process.env.DISCO_BASE_URL;
    delete process.env.DISCO_BASE_URL;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    if (originalBaseUrl === undefined) {
      delete process.env.DISCO_BASE_URL;
    } else {
      process.env.DISCO_BASE_URL = originalBaseUrl;
    }
  });

  it('returns DISCO_BASE_URL env when set', async () => {
    process.env.DISCO_BASE_URL = 'https://disco.example.com';
    await expect(getBaseUrl()).resolves.toBe('https://disco.example.com');
    await expect(getDaemonBaseUrl()).resolves.toBe('https://disco.example.com');
    await expect(requirePublicBaseUrl()).resolves.toBe('https://disco.example.com');
  });

  it('returns daemon.base_url from config when env is unset', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      path.join(discoDir, 'config.yaml'),
      yaml.dump({ daemon: { base_url: 'https://disco.sandbox.example.com' } }),
      'utf-8'
    );

    await expect(getBaseUrl()).resolves.toBe('https://disco.sandbox.example.com');
    await expect(getDaemonBaseUrl()).resolves.toBe('https://disco.sandbox.example.com');
    await expect(requirePublicBaseUrl()).resolves.toBe('https://disco.sandbox.example.com');
  });

  it('returns ui.base_url from legacy config when daemon.base_url is unset', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      path.join(discoDir, 'config.yaml'),
      yaml.dump({ ui: { base_url: 'https://disco-ui.sandbox.example.com' } }),
      'utf-8'
    );

    await expect(getBaseUrl()).resolves.toBe('https://disco-ui.sandbox.example.com');
    await expect(getDaemonBaseUrl()).resolves.toBe('https://disco-ui.sandbox.example.com');
    await expect(requirePublicBaseUrl()).resolves.toBe('https://disco-ui.sandbox.example.com');
  });

  it('separates UI links from daemon endpoints when both base URLs are configured', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      path.join(discoDir, 'config.yaml'),
      yaml.dump({
        daemon: { base_url: 'http://[::1]:3030' },
        ui: { base_url: 'http://localhost:5173' },
      }),
      'utf-8'
    );

    await expect(getBaseUrl()).resolves.toBe('http://localhost:5173');
    await expect(getDaemonBaseUrl()).resolves.toBe('http://[::1]:3030');
    await expect(requirePublicBaseUrl()).resolves.toBe('http://[::1]:3030');
  });

  it('throws PublicBaseUrlNotConfiguredError when neither env nor config is set', async () => {
    await expect(getBaseUrl()).resolves.toBe('http://localhost:3030');
    await expect(getDaemonBaseUrl()).resolves.toBe('http://localhost:3030');
    await expect(requirePublicBaseUrl()).rejects.toBeInstanceOf(PublicBaseUrlNotConfiguredError);
  });

  it('never silently falls back to localhost (regression: OAuth callback URL bug)', async () => {
    // Even with daemon.host / daemon.port configured, requirePublicBaseUrl must NOT
    // construct an http://{host}:{port} URL — that fallback is what caused remote
    // users to receive an unreachable localhost OAuth callback URL from upstream
    // providers like Notion.
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      path.join(discoDir, 'config.yaml'),
      yaml.dump({ daemon: { host: 'localhost', port: 3030 } }),
      'utf-8'
    );

    await expect(requirePublicBaseUrl()).rejects.toBeInstanceOf(PublicBaseUrlNotConfiguredError);
  });

  it('strips a trailing slash from the configured base URL', async () => {
    process.env.DISCO_BASE_URL = 'https://disco.example.com/';
    await expect(requirePublicBaseUrl()).resolves.toBe('https://disco.example.com');
  });

  it('rejects a base URL without an http(s) scheme', async () => {
    process.env.DISCO_BASE_URL = 'disco.example.com';
    await expect(requirePublicBaseUrl()).rejects.toThrow(/must start with http/i);
  });
});

describe('saveConfigForTests', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should save config to file', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    const configPath = path.join(tempDir, '.disco', 'config.yaml');
    const content = await fs.readFile(configPath, 'utf-8');
    const loaded = yaml.load(content) as DiscoConfig;

    expect(loaded).toMatchObject(config);
  });

  it('should create .disco directory if it does not exist', async () => {
    const config = createMinimalConfig();
    await saveConfigForTests(config);

    const discoDir = path.join(tempDir, '.disco');
    const stat = await fs.stat(discoDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should overwrite existing config file', async () => {
    const config1 = createConfigData({ daemon: { port: 3030 } });
    const config2 = createConfigData({ daemon: { port: 4040 } });

    await saveConfigForTests(config1);
    await saveConfigForTests(config2);

    const loaded = await loadConfig();
    expect(loaded.daemon?.port).toBe(4040);
  });

  it('should save empty config', async () => {
    await saveConfigForTests({});

    const loaded = await loadConfig();
    expect(loaded).toEqual({});
  });

  it('should format YAML with proper indentation', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    const configPath = path.join(tempDir, '.disco', 'config.yaml');
    const content = await fs.readFile(configPath, 'utf-8');

    // Check that content is properly indented (2 spaces)
    expect(content).toContain('daemon:');
    expect(content).toContain('  port: ');
    expect(content).not.toContain('    '); // No 4-space indents (we use 2)
  });
});

describe('initConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should create config file with defaults if not exists', async () => {
    await initConfig();

    const configPath = path.join(tempDir, '.disco', 'config.yaml');
    const exists = await fs
      .access(configPath)
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);

    const loaded = await loadConfig();
    expect(loaded).toEqual(getDefaultConfig());
  });

  it('should not overwrite existing config file', async () => {
    const customConfig = createConfigData();
    await saveConfigForTests(customConfig);

    await initConfig();

    const loaded = await loadConfig();
    expect(loaded).toMatchObject(customConfig);
    expect(loaded.daemon?.port).toBe(4000); // Custom value preserved
  });

  it('uses exclusive creation so concurrent initializers cannot race to overwrite', async () => {
    const results = await Promise.allSettled([
      createInitialConfig({ daemon: { port: 3001 } }),
      createInitialConfig({ daemon: { port: 3002 } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect([3001, 3002]).toContain((await loadConfig()).daemon?.port);
  });

  it('preserves existing permission bits during an explicit atomic rewrite', async () => {
    if (process.platform === 'win32') return;
    await createInitialConfig({ daemon: { port: 3001 } });
    const configPath = getConfigPath();
    await fs.chmod(configPath, 0o640);
    await rewriteConfigForTests({ daemon: { port: 3002 } });
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o640);
    expect((await loadConfig()).daemon?.port).toBe(3002);
  });
});

describe('getConfigValue', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should get nested config value', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    const value = await getConfigValue('daemon.port');
    expect(value).toBe(4000);
  });

  it('should return default value when not set in user config', async () => {
    await saveConfigForTests({}); // Empty config

    const value = await getConfigValue('daemon.port');
    expect(value).toBe(3030); // Default value
  });

  it('should merge user config with defaults', async () => {
    const partialConfig: DiscoConfig = {
      daemon: { port: 9999 }, // Custom port
      // Other sections use defaults
    };
    await saveConfigForTests(partialConfig);

    const customValue = await getConfigValue('daemon.port');
    expect(customValue).toBe(9999);
    expect(await getConfigValue('display.tableStyle')).toBeUndefined();
  });

  it('should return undefined for non-existent keys', async () => {
    await saveConfigForTests({});

    const value = await getConfigValue('nonexistent.key');
    expect(value).toBeUndefined();
  });

  it('should handle number values', async () => {
    const config = createConfigData({
      ui: { port: 9090, host: 'localhost' },
    });
    await saveConfigForTests(config);

    const port = await getConfigValue('ui.port');
    expect(port).toBe(9090);
  });
});

describe('getDaemonUrl', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);

    // Save original env
    originalEnv = { ...process.env };

    // Clear env vars that getDaemonUrl() consults so tests are isolated
    // from the developer's actual dev environment (e.g. when running tests
    // while the daemon is up on a non-default port).
    delete process.env.DAEMON_URL;
    delete process.env.PORT;
    delete process.env.DISCO_DAEMON_URL;
    delete process.env.DISCO_DAEMON_HOST;
    delete process.env.DISCO_DAEMON_PORT;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();

    // Restore env
    process.env = originalEnv;
  });

  it('should construct URL from config', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://0.0.0.0:4000');
  });

  it('should use defaults when config is empty', async () => {
    await saveConfigForTests({});

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:3030');
  });

  it('should prioritize PORT env var over config', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    process.env.PORT = '9999';

    const url = await getDaemonUrl();
    expect(url).toBe('http://0.0.0.0:9999'); // Port from env, host from config
  });

  it('should parse PORT env var as number', async () => {
    await saveConfigForTests({});
    process.env.PORT = '8080';

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:8080');
  });

  it('should handle partial config with missing daemon section', async () => {
    const config: DiscoConfig = {};
    await saveConfigForTests(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:3030'); // Fallback to defaults
  });

  it('should handle config with only custom port', async () => {
    const config: DiscoConfig = {
      daemon: { port: 5000 },
      // No host specified
    };
    await saveConfigForTests(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://localhost:5000');
  });

  it('should handle config with only custom host', async () => {
    const config: DiscoConfig = {
      daemon: { host: '192.168.1.1' },
      // No port specified
    };
    await saveConfigForTests(config);

    const url = await getDaemonUrl();
    expect(url).toBe('http://192.168.1.1:3030');
  });

  it('should prioritize DAEMON_URL env var over everything', async () => {
    const config = createConfigData();
    await saveConfigForTests(config);

    process.env.DAEMON_URL = 'https://custom-daemon.example.com:8443';

    const url = await getDaemonUrl();
    expect(url).toBe('https://custom-daemon.example.com:8443');
  });

  it('normalizes DAEMON_URL before any config consumer receives it', async () => {
    process.env.DAEMON_URL = ' HTTPS://Example.com:443/disco/// ';
    await expect(getDaemonUrl()).resolves.toBe('https://example.com/disco');
  });

  it.each([
    'https://user:secret@example.com',
    'https://example.com/?target=other',
    'https://example.com/#other',
  ])('rejects an unsafe DAEMON_URL override: %s', async (value) => {
    process.env.DAEMON_URL = value;
    await expect(getDaemonUrl()).rejects.toThrow('DAEMON_URL must not include');
  });
});

// =============================================================================
// Data Home Path Resolution Tests
// =============================================================================

describe('getDataHome', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);

    // Save original env
    originalEnv = { ...process.env };
    // Clear relevant env vars
    delete process.env.DISCO_DATA_HOME;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();

    // Restore env
    process.env = originalEnv;
  });

  it('should default to DISCO_HOME (~/.disco) when no config or env var set', () => {
    const dataHome = getDataHome();
    expect(dataHome).toBe(path.join(tempDir, '.disco'));
  });

  it('should use paths.data_home from config when set', async () => {
    const config: DiscoConfig = {
      paths: { data_home: '/data/disco' },
    };
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(path.join(discoDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const dataHome = getDataHome();
    expect(dataHome).toBe('/data/disco');
  });

  it('should expand tilde in paths.data_home', async () => {
    const config: DiscoConfig = {
      paths: { data_home: '~/custom-data' },
    };
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(path.join(discoDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const dataHome = getDataHome();
    expect(dataHome).toBe(path.join(tempDir, 'custom-data'));
  });

  it('should prioritize DISCO_DATA_HOME env var over config', async () => {
    const config: DiscoConfig = {
      paths: { data_home: '/config-path' },
    };
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(path.join(discoDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    process.env.DISCO_DATA_HOME = '/env-path';

    const dataHome = getDataHome();
    expect(dataHome).toBe('/env-path');
  });

  it('should expand tilde in DISCO_DATA_HOME env var', () => {
    process.env.DISCO_DATA_HOME = '~/env-data';

    const dataHome = getDataHome();
    expect(dataHome).toBe(path.join(tempDir, 'env-data'));
  });
});

describe('getTenantDataRoot', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-tenant-path-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    delete process.env.DISCO_DATA_HOME;
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    __resetConfigCacheForTests();
  });

  async function writeConfig(multi_tenancy: NonNullable<DiscoConfig['multi_tenancy']>) {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(path.join(discoDir, 'config.yaml'), yaml.dump({ multi_tenancy }), 'utf-8');
    __resetConfigCacheForTests();
  }

  it('preserves the flat data root when multi-tenancy is disabled', () => {
    expect(getTenantDataRoot()).toBe(path.join(tempDir, '.disco'));
  });

  it('uses the default tenant base folder when enabled', async () => {
    await writeConfig({ filesystem_isolation_enabled: true });

    expect(getTenantDataRoot('tenant-a')).toBe(path.join(tempDir, '.disco', 'tenants', 'tenant-a'));
    expect(getWorktreesRoot('tenant-a')).toBe(
      path.join(tempDir, '.disco', 'tenants', 'tenant-a', 'worktrees')
    );
  });

  it('resolves relative tenant base folders from the daemon home', async () => {
    await writeConfig({
      filesystem_isolation_enabled: true,
      tenants_base_folder: 'tenant-volume',
    });

    expect(getTenantDataRoot('tenant-b')).toBe(
      path.join(tempDir, '.disco', 'tenant-volume', 'tenant-b')
    );
  });

  it('supports absolute and home-relative tenant base folders', async () => {
    await writeConfig({
      filesystem_isolation_enabled: true,
      tenants_base_folder: '/data/disco-tenants',
    });
    expect(getTenantDataRoot('tenant-c')).toBe(path.join('/data/disco-tenants', 'tenant-c'));

    await writeConfig({
      filesystem_isolation_enabled: true,
      tenants_base_folder: '~/mounted-tenants',
    });
    expect(getTenantDataRoot('tenant-c')).toBe(path.join(tempDir, 'mounted-tenants', 'tenant-c'));
  });

  it('requires a safe tenant id when enabled', async () => {
    await writeConfig({ filesystem_isolation_enabled: true });

    expect(() => getTenantDataRoot()).toThrow(/valid tenant id/i);
    expect(() => getTenantDataRoot('../escape')).toThrow(/valid tenant id/i);
  });

  it('fails closed instead of falling back to shared storage when config is invalid', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(
      path.join(discoDir, 'config.yaml'),
      yaml.dump({
        multi_tenancy: { filesystem_isolation_enabled: true, unsupported_option: true },
      }),
      'utf-8'
    );
    __resetConfigCacheForTests();

    expect(() => getTenantDataRoot('tenant-a')).toThrow(/unrecognized/i);
  });
});

describe('getWorktreesRoot', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    originalEnv = { ...process.env };
    delete process.env.DISCO_DATA_HOME;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('should return the workspace root under data home', () => {
    const worktreesRoot = getWorktreesRoot();
    expect(worktreesRoot).toBe(path.join(tempDir, '.disco', 'worktrees'));
  });

  it('should use custom data_home for the workspace root', async () => {
    const config: DiscoConfig = {
      paths: { data_home: '/custom/data' },
    };
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(path.join(discoDir, 'config.yaml'), yaml.dump(config), 'utf-8');

    const worktreesRoot = getWorktreesRoot();
    expect(worktreesRoot).toBe(path.join('/custom/data', 'worktrees'));
  });

  it('should use DISCO_DATA_HOME env var for the workspace root', () => {
    process.env.DISCO_DATA_HOME = '/env/data';

    const worktreesRoot = getWorktreesRoot();
    expect(worktreesRoot).toBe(path.join('/env/data', 'worktrees'));
  });
});

