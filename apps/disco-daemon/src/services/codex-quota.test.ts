import type { DiscoConfig } from '@disco/core/config';
import { describe, expect, it, vi } from 'vitest';
import { CodexQuotaService, selectPrimaryWeeklyQuota } from './codex-quota.js';

const config = { execution: { unix_user_mode: 'simple' } } as DiscoConfig;
const week = { usedPercent: 83, windowDurationMins: 10080, resetsAt: 1_800_000_000 };
const short = { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_790_000_000 };
const payload = {
  rateLimitsByLimitId: { codex: { primary: week }, 'codex-spark': { primary: short } },
};

describe('primary weekly quota projection', () => {
  it('selects only the primary bucket and accepts a week in either window', () => {
    expect(selectPrimaryWeeklyQuota(payload)).toEqual({
      status: 'ready',
      remainingPercent: 17,
      resetsAt: '2027-01-15T08:00:00.000Z',
    });
    expect(
      selectPrimaryWeeklyQuota({
        rateLimitsByLimitId: {
          codex: { primary: short, secondary: week },
        },
      }).remainingPercent
    ).toBe(17);
  });
  it('prefers the grouped result and supports the legacy primary bucket', () => {
    expect(
      selectPrimaryWeeklyQuota({ ...payload, rateLimits: { primary: { ...week, usedPercent: 0 } } })
        .remainingPercent
    ).toBe(17);
    expect(selectPrimaryWeeklyQuota({ rateLimits: { primary: week } }).remainingPercent).toBe(17);
  });
  it.each([
    {},
    { rateLimits: { primary: short } },
    { rateLimits: { limitId: 'codex-spark', primary: week } },
    { rateLimitsByLimitId: { 'codex-spark': { primary: week } }, rateLimits: { primary: week } },
    { rateLimits: { primary: { ...week, usedPercent: null } } },
    { rateLimits: { primary: { ...week, usedPercent: Number.NaN } } },
  ])('keeps absent, nonweekly, and Spark values unavailable: %j', (value) => {
    expect(selectPrimaryWeeklyQuota(value)).toEqual({
      status: 'unavailable',
      remainingPercent: null,
      resetsAt: null,
    });
  });
  it.each([
    [110, 0],
    [-5, 100],
    [100, 0],
  ])('clamps used %s to remaining %s', (usedPercent, expected) => {
    expect(
      selectPrimaryWeeklyQuota({ rateLimits: { primary: { ...week, usedPercent } } })
        .remainingPercent
    ).toBe(expected);
  });
});

describe('shared quota cache', () => {
  it('coalesces concurrent reads and caches them for one minute', async () => {
    let now = 1_700_000_000_000;
    const read = vi.fn(async () => payload);
    const service = new CodexQuotaService(config, read, () => now);
    await Promise.all([service.find(), service.find(), service.find()]);
    await service.find();
    expect(read).toHaveBeenCalledTimes(1);
    now += 60_001;
    await service.find();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('expires the old value at reset time instead of showing the previous week', async () => {
    let now = week.resetsAt * 1000 - 500;
    const read = vi.fn(async () => payload);
    const service = new CodexQuotaService(config, read, () => now);
    expect((await service.find()).status).toBe('ready');
    now += 501;
    expect((await service.find()).status).toBe('unavailable');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('backs off on failures without returning diagnostics, zero, or stale data', async () => {
    let now = 1_700_000_000_000;
    const read = vi
      .fn()
      .mockResolvedValueOnce(payload)
      .mockRejectedValue(new Error('private diagnostics'));
    const service = new CodexQuotaService(config, read, () => now);
    await service.find();
    now += 60_001;
    expect(await service.find()).toEqual({
      status: 'unavailable',
      remainingPercent: null,
      resetsAt: null,
    });
    await service.find();
    expect(read).toHaveBeenCalledTimes(2);
    now += 30_001;
    await service.find();
    expect(read).toHaveBeenCalledTimes(3);
  });
  it.each([
    { execution: { unix_user_mode: 'sandbox' } },
    { execution: { unix_user_mode: 'delegated' } },
    { multi_tenancy: { mode: 'required_from_auth' } },
  ])('never queries host credentials in a separately routed deployment', async (isolated) => {
    const read = vi.fn();
    expect((await new CodexQuotaService(isolated as DiscoConfig, read).find()).status).toBe(
      'unavailable'
    );
    expect(read).not.toHaveBeenCalled();
  });
});
