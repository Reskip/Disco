import type { UUID } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeAccessCache,
  type RealtimeAccessSessionRepository,
} from './realtime-access-cache';

function repository(owner: string | null = 'owner-1'): RealtimeAccessSessionRepository {
  return {
    findCreatedByBySessionId: vi.fn(async () => owner as UUID | null),
  };
}

describe('RealtimeAccessCache', () => {
  it('caches a Session owner until the ttl expires', async () => {
    let now = 1_000;
    const sessionsRepository = repository();
    const cache = new RealtimeAccessCache({
      sessionsRepository,
      ttlMs: 60_000,
      now: () => now,
    });

    await expect(cache.getSessionOwnerId('session-1')).resolves.toBe('owner-1');
    await expect(cache.getSessionOwnerId('session-1')).resolves.toBe('owner-1');
    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(1);

    now += 60_001;
    await expect(cache.getSessionOwnerId('session-1')).resolves.toBe('owner-1');
    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the requested Session', async () => {
    const sessionsRepository = repository();
    const cache = new RealtimeAccessCache({ sessionsRepository });

    await cache.getSessionOwnerId('session-1');
    await cache.getSessionOwnerId('session-2');
    cache.invalidateSession('session-1');
    await cache.getSessionOwnerId('session-1');
    await cache.getSessionOwnerId('session-2');

    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(3);
  });

  it('caches a missing owner as a fail-closed null result', async () => {
    const sessionsRepository = repository(null);
    const cache = new RealtimeAccessCache({ sessionsRepository });

    await expect(cache.getSessionOwnerId('missing')).resolves.toBeNull();
    await expect(cache.getSessionOwnerId('missing')).resolves.toBeNull();
    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(1);
  });

  it('clearAll forces every Session owner to be resolved again', async () => {
    const sessionsRepository = repository();
    const cache = new RealtimeAccessCache({ sessionsRepository });

    await cache.getSessionOwnerId('session-1');
    await cache.getSessionOwnerId('session-2');
    cache.clearAll();
    await cache.getSessionOwnerId('session-1');
    await cache.getSessionOwnerId('session-2');

    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(4);
  });
});
