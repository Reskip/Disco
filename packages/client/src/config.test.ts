import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultConfig, loadConfigSync } from './config';

describe('loadConfigSync', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-client-test-'));
    // homedir() reads $HOME on POSIX, so this keeps the suite off the host's
    // real ~/.disco/config.yaml.
    vi.stubEnv('HOME', tempDir);
    vi.stubEnv('DISCO_OUTER_SANDBOX', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    expect(loadConfigSync()).toEqual(getDefaultConfig());
  });

  it('fails loudly when the config file is unreadable', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    const configPath = path.join(discoDir, 'config.yaml');
    await fs.mkdir(configPath);

    expect(() => loadConfigSync()).toThrow(/Failed to load config.*EISDIR/s);
  });

  // This loader backs getDaemonUrl() for every BaseCommand-derived CLI
  // command. Inside the executor sandbox the daemon config is masked, and
  // DAEMON_URL is injected precisely so this path is never reached — so
  // arriving here means the injection is what broke. Say that instead of
  // reporting a bare EACCES against a file the caller was never meant to read.
  it('explains the sandbox when the config is unreadable', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.mkdir(path.join(discoDir, 'config.yaml'));
    vi.stubEnv('DISCO_OUTER_SANDBOX', '1');

    expect(() => loadConfigSync()).toThrow(/masked by Disco's executor sandbox/s);
  });

  // A file we read successfully is not a masked file, whatever it contains.
  it('reports malformed YAML as a parse failure even inside the sandbox', async () => {
    const discoDir = path.join(tempDir, '.disco');
    await fs.mkdir(discoDir, { recursive: true });
    await fs.writeFile(path.join(discoDir, 'config.yaml'), 'daemon: [unclosed\n', 'utf-8');
    vi.stubEnv('DISCO_OUTER_SANDBOX', '1');

    expect(() => loadConfigSync()).toThrow(/Failed to load config/);
    expect(() => loadConfigSync()).not.toThrow(/executor sandbox/);
  });
});
