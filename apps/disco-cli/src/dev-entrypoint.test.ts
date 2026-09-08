import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI development entrypoint', () => {
  it('runs against workspace source exports without requiring a prior core build', async () => {
    const { stdout } = await execFileAsync('pnpm', ['dev', '--version'], {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      timeout: 30_000,
    });

    expect(stdout).toMatch(/@disco\/cli\/\S+/);
  }, 35_000);

  it('keeps the workspace-root CLI entrypoint on the same source-resolving path', async () => {
    const { stdout } = await execFileAsync('pnpm', ['--workspace-root', 'disco', '--version'], {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      timeout: 30_000,
    });

    expect(stdout).toMatch(/@disco\/cli\/\S+/);
  }, 35_000);

  it('runs the version command without oclif argument-parsing warnings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'disco-cli-version-'));
    const deploymentId = '019c1234-5678-7123-8123-123456789abc';
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          service: 'disco-daemon',
          deploymentId,
          version: 'test-version',
          buildSha: 'test-build',
        })
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISCO_API_KEY: 'disco_sk_test-key',
      DISCO_DEPLOYMENT_ID: deploymentId,
      DAEMON_URL: `http://127.0.0.1:${address.port}`,
      HOME: home,
    };
    delete env.DISCO_OUTER_SANDBOX;
    try {
      const { stderr, stdout } = await execFileAsync('pnpm', ['dev', 'version'], {
        cwd: new URL('..', import.meta.url),
        env,
        timeout: 30_000,
      });

      expect(stdout).toContain('Daemon: test-version');
      expect(stderr).not.toContain('did not parse its arguments');
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 35_000);

  it('groups root help by local and connected deployment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'disco-cli-help-'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
    delete env.DISCO_OUTER_SANDBOX;
    delete env.DISCO_API_KEY;
    delete env.DISCO_DEPLOYMENT_ID;
    delete env.DAEMON_URL;
    try {
      const { stdout } = await execFileAsync('pnpm', ['dev', '--help'], {
        cwd: new URL('..', import.meta.url),
        env,
        timeout: 30_000,
      });

      expect(stdout).toContain('LOCAL DEPLOYMENT');
      expect(stdout).toContain('CONNECTED DEPLOYMENT');
      expect(stdout).toContain('Show the effective local deployment configuration');
      expect(stdout).toContain('Show the connected daemon version');
      expect(stdout).not.toContain('Permanently delete all data belonging to a single tenant');
      expect(stdout).not.toContain('TOPICS');
      expect(stdout).not.toContain('COMMANDS');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 35_000);
});
