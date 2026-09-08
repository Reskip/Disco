import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.js', () => ({ loadToken: vi.fn() }));
vi.mock('@disco/core/config', () => ({
  loadConfig: vi.fn(),
  requireDeploymentId: vi.fn(),
  resolveDaemonUrl: vi.fn(),
}));

import { loadConfig, requireDeploymentId, resolveDaemonUrl } from '@disco/core/config';
import { loadToken } from './auth.js';
import {
  resolveConnectedDeploymentTarget,
  resolveLocalDeploymentTarget,
} from './deployment-target';

const deploymentId = '019c1234-5678-7123-8123-123456789abc';

describe('deployment target resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('DISCO_API_KEY', '');
    vi.stubEnv('DISCO_DEPLOYMENT_ID', '');
    vi.stubEnv('DAEMON_URL', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('uses the one stored login target', async () => {
    vi.mocked(loadToken).mockResolvedValue({
      version: 3,
      target: {
        url: 'https://disco.example.com/base',
        origin: 'https://disco.example.com',
        deploymentId,
      },
      accessToken: 'secret',
      user: { user_id: 'u1', username: 'max', role: 'admin' },
      expiresAt: Date.now() + 1000,
    });

    await expect(resolveConnectedDeploymentTarget()).resolves.toMatchObject({
      url: 'https://disco.example.com/base',
      deploymentId,
      source: 'login',
    });
  });

  it('gives a complete API-key environment target precedence and normalizes it', async () => {
    vi.stubEnv('DISCO_API_KEY', 'disco_sk_test');
    vi.stubEnv('DISCO_DEPLOYMENT_ID', deploymentId);
    vi.stubEnv('DAEMON_URL', 'https://disco.example.com/base/');

    await expect(resolveConnectedDeploymentTarget()).resolves.toEqual({
      url: 'https://disco.example.com/base',
      deploymentId,
      source: 'environment',
    });
    expect(loadToken).not.toHaveBeenCalled();
  });

  it('rejects an incomplete API-key environment instead of falling back', async () => {
    vi.stubEnv('DISCO_API_KEY', 'disco_sk_test');
    vi.stubEnv('DAEMON_URL', 'https://disco.example.com');

    await expect(resolveConnectedDeploymentTarget()).rejects.toThrow('DISCO_DEPLOYMENT_ID');
  });

  it('resolves the local target only through effective config utilities', async () => {
    const config = { daemon: { deployment_id: deploymentId } };
    vi.mocked(loadConfig).mockResolvedValue(config);
    vi.mocked(resolveDaemonUrl).mockReturnValue('http://127.0.0.1:4040');
    vi.mocked(requireDeploymentId).mockReturnValue(deploymentId);

    await expect(resolveLocalDeploymentTarget()).resolves.toEqual({
      url: 'http://127.0.0.1:4040',
      deploymentId,
      source: 'local',
    });
    expect(resolveDaemonUrl).toHaveBeenCalledWith(config);
    expect(requireDeploymentId).toHaveBeenCalledWith(config);
  });
});
