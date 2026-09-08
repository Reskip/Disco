import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmLegacyManagedDaemonStop } from './legacy-daemon-stop';

describe('confirmLegacyManagedDaemonStop', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never signals or approves a legacy PID non-interactively merely because Disco responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ service: 'disco-daemon' }),
      })
    );

    await expect(confirmLegacyManagedDaemonStop(4242, 'http://localhost:3030')).rejects.toThrow(
      'cannot be verified automatically'
    );
  });

  it('refuses when the configured endpoint is not recognizably Disco', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) })
    );

    await expect(confirmLegacyManagedDaemonStop(4242, 'http://localhost:3030')).rejects.toThrow(
      'no Disco daemon was found'
    );
  });
});
