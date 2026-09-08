import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { synchronizeCodexRuntimeAuth } from './codex-auth-sync.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-codex-auth-sync-'));
  temporaryRoots.push(root);
  return root;
}

async function writeAuth(home: string, refreshToken: string, lastRefresh: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, 'auth.json'),
    `${JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: refreshToken, access_token: `${refreshToken}-access` },
      last_refresh: lastRefresh,
    })}\n`,
    'utf8'
  );
}

async function refreshTokenAt(home: string): Promise<string> {
  const parsed = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'));
  return parsed.tokens.refresh_token;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('synchronizeCodexRuntimeAuth', () => {
  it('seeds a missing runtime login from the freshest trusted host login', async () => {
    const root = await temporaryRoot();
    const runtimeHome = path.join(root, 'runtime');
    const olderHost = path.join(root, 'host-old');
    const newerHost = path.join(root, 'host-new');
    await writeAuth(olderHost, 'older', '2026-08-20T00:00:00.000Z');
    await writeAuth(newerHost, 'newer', '2026-09-05T00:00:00.000Z');

    const result = await synchronizeCodexRuntimeAuth({
      runtimeHome,
      hostHomes: [olderHost, newerHost],
    });

    expect(result.copied).toBe(true);
    expect(await refreshTokenAt(runtimeHome)).toBe('newer');
  });

  it('replaces a stale runtime login but never overwrites a fresher one', async () => {
    const root = await temporaryRoot();
    const runtimeHome = path.join(root, 'runtime');
    const hostHome = path.join(root, 'host');
    await writeAuth(runtimeHome, 'runtime-old', '2026-08-20T00:00:00.000Z');
    await writeAuth(hostHome, 'host-new', '2026-09-05T00:00:00.000Z');

    await synchronizeCodexRuntimeAuth({ runtimeHome, hostHomes: [hostHome] });
    expect(await refreshTokenAt(runtimeHome)).toBe('host-new');

    await writeAuth(runtimeHome, 'runtime-newest', '2026-09-06T00:00:00.000Z');
    const result = await synchronizeCodexRuntimeAuth({ runtimeHome, hostHomes: [hostHome] });
    expect(result.copied).toBe(false);
    expect(await refreshTokenAt(runtimeHome)).toBe('runtime-newest');
  });

  it('ignores malformed or credential-free host files', async () => {
    const root = await temporaryRoot();
    const runtimeHome = path.join(root, 'runtime');
    const malformedHost = path.join(root, 'host-malformed');
    const emptyHost = path.join(root, 'host-empty');
    await writeAuth(runtimeHome, 'runtime', '2026-08-20T00:00:00.000Z');
    await fs.mkdir(malformedHost, { recursive: true });
    await fs.writeFile(path.join(malformedHost, 'auth.json'), '{broken', 'utf8');
    await fs.mkdir(emptyHost, { recursive: true });
    await fs.writeFile(
      path.join(emptyHost, 'auth.json'),
      JSON.stringify({ last_refresh: '2026-09-05T00:00:00.000Z' }),
      'utf8'
    );

    const result = await synchronizeCodexRuntimeAuth({
      runtimeHome,
      hostHomes: [malformedHost, emptyHost],
    });

    expect(result.copied).toBe(false);
    expect(await refreshTokenAt(runtimeHome)).toBe('runtime');
  });
});
