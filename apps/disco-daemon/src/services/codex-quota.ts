import type { DiscoConfig } from '@disco/core/config';
import type { CodexWeeklyQuota, DeepReadonly } from '@disco/core/types';
import { readHostCodexRateLimits } from '../utils/codex-quota-reader.js';
import { usesServerSharedCodexAuth } from './codex-auth-shared.js';

const UNAVAILABLE: CodexWeeklyQuota = {
  status: 'unavailable',
  remainingPercent: null,
  resetsAt: null,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function selectPrimaryWeeklyQuota(value: unknown): CodexWeeklyQuota {
  const response = record(value);
  const groups = record(response?.rateLimitsByLimitId);
  const bucket = record(groups && Object.keys(groups).length ? groups.codex : response?.rateLimits);
  if (!bucket || (bucket.limitId != null && bucket.limitId !== 'codex')) return UNAVAILABLE;
  // primary/secondary denote positions, not durations. The week can be either.
  const week = [record(bucket.primary), record(bucket.secondary)].find(
    (window) => window?.windowDurationMins === 7 * 24 * 60
  );
  if (!week || typeof week.usedPercent !== 'number' || !Number.isFinite(week.usedPercent)) {
    return UNAVAILABLE;
  }
  const reset =
    typeof week.resetsAt === 'number' && Number.isFinite(week.resetsAt)
      ? new Date(week.resetsAt * 1000)
      : null;
  return {
    status: 'ready',
    remainingPercent: Math.max(0, Math.min(100, 100 - week.usedPercent)),
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
  };
}

export class CodexQuotaService {
  private cached: CodexWeeklyQuota = UNAVAILABLE;
  private expiresAt = 0;
  private pending?: Promise<CodexWeeklyQuota>;

  constructor(
    private readonly config: DeepReadonly<DiscoConfig>,
    private readonly read: () => Promise<unknown> = readHostCodexRateLimits,
    private readonly now: () => number = Date.now
  ) {}

  async find(): Promise<CodexWeeklyQuota> {
    // Host-wide quota is meaningful only in Disco's explicitly shared local
    // credential mode. Never expose it to independently routed hosted tenants.
    if (!usesServerSharedCodexAuth(this.config)) return UNAVAILABLE;
    if (this.now() < this.expiresAt) return this.cached;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        this.cached = selectPrimaryWeeklyQuota(await this.read());
      } catch {
        this.cached = UNAVAILABLE;
      }
      const now = this.now();
      this.expiresAt = now + (this.cached.status === 'ready' ? 60_000 : 30_000);
      if (this.cached.resetsAt) {
        const resetAt = Date.parse(this.cached.resetsAt);
        if (resetAt <= now) this.cached = UNAVAILABLE;
        else this.expiresAt = Math.min(this.expiresAt, resetAt);
      }
      return this.cached;
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
}
