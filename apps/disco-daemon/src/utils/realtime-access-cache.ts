import type { UserID, UUID } from '@disco/core/types';

export type RealtimeAccessSessionRepository = {
  findCreatedByBySessionId(sessionId: string): Promise<UUID | null>;
};

type SessionOwnerCacheEntry = {
  ownerId: UserID | null;
  expiresAt: number;
};

export interface RealtimeAccessCacheOptions {
  sessionsRepository: RealtimeAccessSessionRepository;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_SESSION_OWNER_TTL_MS = 60 * 60_000;

/**
 * Daemon-local owner cache for realtime delivery. Disco Session events are
 * private to their creating user; repository/Branch ACL state is deliberately
 * absent from this path.
 */
export class RealtimeAccessCache {
  private readonly sessionOwners = new Map<string, SessionOwnerCacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: RealtimeAccessCacheOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_OWNER_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async getSessionOwnerId(sessionId: string): Promise<UserID | null> {
    const cached = this.sessionOwners.get(sessionId);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.ownerId;

    const ownerId =
      ((await this.options.sessionsRepository.findCreatedByBySessionId(
        sessionId
      )) as UserID | null) ?? null;
    this.sessionOwners.set(sessionId, { ownerId, expiresAt: now + this.ttlMs });
    return ownerId;
  }

  invalidateSession(sessionId: string): void {
    this.sessionOwners.delete(sessionId);
  }

  clearAll(): void {
    this.sessionOwners.clear();
  }
}
