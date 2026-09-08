import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertLocalContextUnlocked,
  assertLocalContextUnlockedWhenIdentified,
} from './local-context';

vi.mock('./auth.js', () => ({ loadToken: vi.fn() }));

import { loadToken } from './auth.js';

const deploymentId = '019c1234-5678-7123-8123-123456789abc';

describe('assertLocalContextUnlocked', () => {
  it('allows the compatibility-only stop/diagnostic path before identity migration', async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    await expect(
      assertLocalContextUnlockedWhenIdentified({ daemon: { port: 3030 } })
    ).resolves.toBe(undefined);
  });

  beforeEach(() => {
    vi.mocked(loadToken).mockReset();
    vi.stubEnv('DISCO_API_KEY', '');
    vi.stubEnv('DISCO_DEPLOYMENT_ID', '');
    vi.stubEnv('DAEMON_URL', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('allows logged-out local administration', async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    await expect(
      assertLocalContextUnlocked({ daemon: { deployment_id: deploymentId } })
    ).resolves.toBeUndefined();
  });

  it('allows a login to the same deployment', async () => {
    vi.mocked(loadToken).mockResolvedValue({
      version: 3,
      target: {
        url: 'https://disco.example.com',
        origin: 'https://disco.example.com',
        deploymentId,
      },
      accessToken: 'secret',
      user: { user_id: 'u1', username: 'max', role: 'admin' },
      expiresAt: Date.now() + 1000,
    });
    await expect(
      assertLocalContextUnlocked({ daemon: { deployment_id: deploymentId } })
    ).resolves.toBeUndefined();
  });

  it('locks local administration for a different login', async () => {
    vi.mocked(loadToken).mockResolvedValue({
      version: 3,
      target: {
        url: 'https://cloud.disco.live',
        origin: 'https://cloud.disco.live',
        deploymentId: '019c9999-5678-7123-8123-123456789abc',
      },
      accessToken: 'secret',
      user: { user_id: 'u1', username: 'max', role: 'admin' },
      expiresAt: Date.now() + 1000,
    });
    await expect(
      assertLocalContextUnlocked({ daemon: { deployment_id: deploymentId } })
    ).rejects.toThrow('Local administration is locked');
  });

  it('locks local administration for a different API-key environment target', async () => {
    vi.mocked(loadToken).mockResolvedValue(null);
    vi.stubEnv('DISCO_API_KEY', 'disco_sk_test');
    vi.stubEnv('DISCO_DEPLOYMENT_ID', '019c9999-5678-7123-8123-123456789abc');
    vi.stubEnv('DAEMON_URL', 'https://cloud.disco.live');

    await expect(
      assertLocalContextUnlocked({ daemon: { deployment_id: deploymentId } })
    ).rejects.toThrow('Local administration is locked');
  });
});
