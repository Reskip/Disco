import type { LeaderboardEntry } from '@disco-live/client';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateTokenUsage,
  aggregateTokenUsageInWindow,
  aggregateUserLeaderboard,
  buildDailyTokenCells,
  buildHourlyTokenSeries,
  buildMinuteTokenSeries,
  buildThirtySecondTokenSeries,
  clearTokenDashboardCacheForTests,
  estimateUserLeaderboardCostsCny,
  readCachedTokenDashboardData,
  rankingFlipKeyframes,
  resampleTokenSeries,
  smoothTokenSeries,
  tokenIntensityLevel,
  weeksForHeatmapWidth,
  writeCachedTokenDashboardData,
} from './HomeTokenUsageCard';

beforeEach(() => {
  clearTokenDashboardCacheForTests();
  window.localStorage.clear();
});

describe('aggregateTokenUsage', () => {
  it('sums workspace and per-user token metrics without dropping zero rows', () => {
    const rows: LeaderboardEntry[] = [
      {
        userId: 'alice',
        totalTokens: 150,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCacheReadTokens: 40,
        totalCacheCreationTokens: 0,
        totalCost: 0,
        taskCount: 2,
        sessionCount: 1,
        totalDurationMs: 1000,
      },
      {
        userId: 'bob',
        totalTokens: 25,
        totalInputTokens: 20,
        totalOutputTokens: 5,
        totalCacheReadTokens: 5,
        totalCacheCreationTokens: 2,
        totalCost: 0,
        taskCount: 1,
        sessionCount: 1,
        totalDurationMs: 200,
      },
    ];

    expect(aggregateTokenUsage(rows)).toEqual({
      totalTokens: 175,
      inputTokens: 120,
      outputTokens: 55,
      cacheTokens: 47,
      taskCount: 3,
    });
  });
});

describe('user leaderboard ranges and pricing', () => {
  const row = (
    userId: string,
    model: string,
    totalInputTokens: number,
    totalOutputTokens: number
  ): LeaderboardEntry => ({
    userId,
    userName: userId,
    model,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCost: 0,
    taskCount: 1,
    sessionCount: 1,
    totalDurationMs: 0,
  });

  it('collapses model rows into one ranked row per user', () => {
    const aggregated = aggregateUserLeaderboard([
      row('alice', 'gpt-5.6-sol', 100, 20),
      row('alice', 'gpt-5.6-luna', 30, 5),
      row('bob', 'gpt-5.6-sol', 50, 10),
    ]);

    expect(aggregated.map(({ userId, totalTokens }) => ({ userId, totalTokens }))).toEqual([
      { userId: 'alice', totalTokens: 155 },
      { userId: 'bob', totalTokens: 60 },
    ]);
  });

  it('keeps cost estimates isolated per user', () => {
    const costs = estimateUserLeaderboardCostsCny([
      row('alice', 'gpt-5.6-sol', 1_000_000, 0),
      row('bob', 'gpt-5.6-sol', 0, 1_000_000),
    ]);

    expect(costs.get('alice')).toBeGreaterThan(0);
    expect(costs.get('bob')).toBeGreaterThan(costs.get('alice') ?? 0);
  });

  it('moves a reordered row from its previous visual position without changing layout', () => {
    expect(rankingFlipKeyframes(68)).toEqual([
      { transform: 'translateY(68px)', opacity: 0.82 },
      { transform: 'translateY(0)', opacity: 1 },
    ]);
    expect(rankingFlipKeyframes(0)).toEqual([]);
  });
});

describe('token dashboard time series', () => {
  const entry = (bucket: string, totalTokens: number): LeaderboardEntry => ({
    bucket,
    totalTokens,
    totalInputTokens: totalTokens,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCost: 0,
    taskCount: 1,
    sessionCount: 1,
    totalDurationMs: 0,
  });

  it('builds a Monday-aligned contribution grid and fills missing days', () => {
    const now = new Date('2026-08-23T12:00:00.000Z');
    const cells = buildDailyTokenCells(
      [entry('2026-08-17T00:00:00.000Z', 100), entry('2026-08-23T00:00:00.000Z', 400)],
      2,
      now
    );

    expect(cells).toHaveLength(14);
    expect(cells[0].dateKey).toBe('2026-08-10');
    expect(cells[7]).toMatchObject({ dateKey: '2026-08-17', tokens: 100 });
    expect(cells[13]).toMatchObject({ dateKey: '2026-08-23', tokens: 400, level: 4 });
  });

  it('marks the remainder of the current week as future so it can stay visually empty', () => {
    const monday = new Date('2026-08-24T12:00:00.000Z');
    const cells = buildDailyTokenCells([], 2, monday);

    expect(cells.slice(-7).map((cell) => cell.future)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('fills a fixed 24-hour waveform and aggregates duplicate buckets', () => {
    const now = new Date('2026-08-23T12:42:00.000Z');
    const values = buildHourlyTokenSeries(
      [
        entry('2026-08-23T11:00:00.000Z', 10),
        entry('2026-08-23T11:00:00.000Z', 15),
        entry('2026-08-23T12:00:00.000Z', 7),
      ],
      24,
      now
    );

    expect(values).toHaveLength(24);
    expect(values.at(-2)).toBe(25);
    expect(values.at(-1)).toBe(7);
  });

  it('builds the default one-hour waveform from minute buckets', () => {
    const now = new Date('2026-08-23T12:42:30.000Z');
    const values = buildMinuteTokenSeries(
      [entry('2026-08-23T12:41:00.000Z', 4), entry('2026-08-23T12:42:00.000Z', 9)],
      60,
      now
    );

    expect(values).toHaveLength(60);
    expect(values.at(-2)).toBe(4);
    expect(values.at(-1)).toBe(9);
  });

  it('uses 120 thirty-second buckets for the default one-hour view', () => {
    const now = new Date('2026-08-23T12:42:45.000Z');
    const values = buildThirtySecondTokenSeries(
      [entry('2026-08-23T12:42:00.000Z', 3), entry('2026-08-23T12:42:30.000Z', 8)],
      120,
      now
    );

    expect(values).toHaveLength(120);
    expect(values.at(-2)).toBe(3);
    expect(values.at(-1)).toBe(8);
  });

  it('keeps realtime counters on the same 1h/1d boundary as the waveform', () => {
    const now = new Date('2026-08-23T12:00:00.000Z');
    const recent = entry('2026-08-23T11:30:00.000Z', 30);
    recent.totalInputTokens = 20;
    recent.totalOutputTokens = 10;
    recent.totalCacheReadTokens = 7;
    const older = entry('2026-08-23T06:00:00.000Z', 70);
    older.totalInputTokens = 50;
    older.totalOutputTokens = 20;
    older.totalCacheCreationTokens = 9;

    expect(aggregateTokenUsageInWindow([recent, older], 60 * 60 * 1000, now)).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      cacheTokens: 7,
    });
    expect(
      aggregateTokenUsageInWindow([recent, older], 24 * 60 * 60 * 1000, now)
    ).toMatchObject({ inputTokens: 70, outputTokens: 30, cacheTokens: 16 });
  });

  it('reduces a full day to a render-efficient curve without dropping usage', () => {
    const raw = Array.from({ length: 2880 }, (_, index) => (index % 20 === 0 ? 5 : 0));
    const sampled = resampleTokenSeries(raw, 144);
    const smoothed = smoothTokenSeries(sampled, 2);

    expect(sampled).toHaveLength(144);
    expect(sampled.reduce((sum, value) => sum + value, 0)).toBe(
      raw.reduce((sum, value) => sum + value, 0)
    );
    expect(smoothed).toHaveLength(144);
  });

  it('uses four non-zero intensity bands', () => {
    expect([0, 1, 25, 50, 100].map((value) => tokenIntensityLevel(value, 100))).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('adapts the visible history to the available width', () => {
    expect(weeksForHeatmapWidth(120)).toBe(8);
    expect(weeksForHeatmapWidth(600)).toBe(40);
    expect(weeksForHeatmapWidth(2000)).toBe(52);
  });
});

describe('token dashboard cache', () => {
  it('restores cached usage per user after the in-memory layer is cleared', () => {
    const cached = {
      users: [],
      todayUsers: [],
      weekUsers: [],
      userModels: [],
      todayUserModels: [],
      weekUserModels: [],
      self: null,
      today: null,
      week: null,
      daily: [],
      activity: [],
      allModels: [],
      todayModels: [],
      weekModels: [],
    };

    writeCachedTokenDashboardData('user-a', cached);
    clearTokenDashboardCacheForTests();

    expect(readCachedTokenDashboardData('user-a')).toEqual(cached);
    expect(readCachedTokenDashboardData('user-b')).toBeNull();
  });

  it('removes the previous cache generation after an accounting reset', () => {
    const legacyKey = 'disco:token-dashboard:v5:user-a';
    window.localStorage.setItem(
      legacyKey,
      JSON.stringify({ savedAt: Date.now(), data: { users: [{ totalTokens: 999 }] } })
    );

    expect(readCachedTokenDashboardData('user-a')).toBeNull();
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });
});
