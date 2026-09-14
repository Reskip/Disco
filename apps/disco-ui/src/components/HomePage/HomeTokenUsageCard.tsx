import { ReloadOutlined } from '@ant-design/icons';
import type { DiscoClient, LeaderboardEntry, TokenPricingPreferences } from '@disco-live/client';
import { Avatar, Button, Card, Empty, Segmented, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '../../contexts/LocaleContext';
import { useDiscoStore } from '../../store/discoStore';
import { formatTokenCount } from '../../utils/formatTokenCount';
import { estimateEntriesCostCny, formatEstimatedCny } from '../../utils/tokenPricing';
import { buildTokenWaveform, findTokenWaveformHoverIndex } from './tokenWaveform';

const { Text } = Typography;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const THIRTY_SECONDS_MS = 30_000;
const HISTORY_MAX_WEEKS = 52;
const HISTORY_MIN_WEEKS = 8;
const HEATMAP_CELL_SIZE = 12;
const HEATMAP_CELL_GAP = 3;
const REALTIME_REFRESH_MS = 30_000;

function dashboardSegmentedStyle(token: ReturnType<typeof theme.useToken>['token']) {
  return {
    minHeight: 32,
    padding: 3,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: 999,
    background: token.colorFillSecondary,
    fontSize: 12,
    fontWeight: 650,
  } satisfies React.CSSProperties;
}

interface TokenTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  taskCount: number;
}

export interface DailyTokenCell {
  date: Date;
  dateKey: string;
  tokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

export interface TokenDashboardData {
  users: LeaderboardEntry[];
  todayUsers: LeaderboardEntry[];
  weekUsers: LeaderboardEntry[];
  userModels: LeaderboardEntry[];
  todayUserModels: LeaderboardEntry[];
  weekUserModels: LeaderboardEntry[];
  self: LeaderboardEntry | null;
  today: LeaderboardEntry | null;
  week: LeaderboardEntry | null;
  daily: LeaderboardEntry[];
  activity: LeaderboardEntry[];
  allModels: LeaderboardEntry[];
  todayModels: LeaderboardEntry[];
  weekModels: LeaderboardEntry[];
}

const EMPTY_DATA: TokenDashboardData = {
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

const TOKEN_DASHBOARD_CACHE_PREFIX = 'disco:token-dashboard:v6:';
const LEGACY_TOKEN_DASHBOARD_CACHE_PREFIXES = [
  'disco:token-dashboard:v1:',
  'disco:token-dashboard:v2:',
  'disco:token-dashboard:v3:',
  'disco:token-dashboard:v4:',
  'disco:token-dashboard:v5:',
] as const;
const TOKEN_DASHBOARD_CACHE_TTL_MS = 7 * DAY_MS;
interface CachedTokenDashboardData {
  savedAt: number;
  data: TokenDashboardData;
}
const tokenDashboardMemoryCache = new Map<string, CachedTokenDashboardData>();

function tokenDashboardCacheKey(currentUserId: string): string {
  return `${TOKEN_DASHBOARD_CACHE_PREFIX}${currentUserId}`;
}

/**
 * Seven-day stale-while-revalidate cache for the dashboard. Local storage
 * makes repeat visits and conversation → Home navigation instant across tabs
 * and browser restarts. Data is isolated by user and refreshed in the
 * background as soon as the card mounts.
 */
export function readCachedTokenDashboardData(
  currentUserId: string | undefined
): TokenDashboardData | null {
  if (!currentUserId) return null;
  const memoryValue = tokenDashboardMemoryCache.get(currentUserId);
  if (memoryValue) {
    if (Date.now() - memoryValue.savedAt <= TOKEN_DASHBOARD_CACHE_TTL_MS) {
      return memoryValue.data;
    }
    tokenDashboardMemoryCache.delete(currentUserId);
  }
  if (typeof window === 'undefined') return null;
  try {
    // A cache generation is intentionally invalidated whenever the dashboard
    // accounting contract changes or usage is administratively reset. Remove
    // older per-user snapshots so deleted Token records cannot reappear while
    // the network refresh is reconnecting.
    for (const legacyPrefix of LEGACY_TOKEN_DASHBOARD_CACHE_PREFIXES) {
      window.localStorage.removeItem(`${legacyPrefix}${currentUserId}`);
    }
    const key = tokenDashboardCacheKey(currentUserId);
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedTokenDashboardData;
    if (
      !Number.isFinite(parsed.savedAt) ||
      Date.now() - parsed.savedAt > TOKEN_DASHBOARD_CACHE_TTL_MS
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    const data = parsed.data;
    if (
      !Array.isArray(data?.users) ||
      !Array.isArray(data.daily) ||
      !Array.isArray(data.activity)
    ) {
      return null;
    }
    tokenDashboardMemoryCache.set(currentUserId, parsed);
    return data;
  } catch {
    return null;
  }
}

export function writeCachedTokenDashboardData(
  currentUserId: string | undefined,
  data: TokenDashboardData
): void {
  if (!currentUserId) return;
  const cached = { savedAt: Date.now(), data };
  tokenDashboardMemoryCache.set(currentUserId, cached);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(tokenDashboardCacheKey(currentUserId), JSON.stringify(cached));
  } catch {
    // Cache storage is an optimization; quota/privacy failures must not break Home.
  }
}

export function clearTokenDashboardCacheForTests(): void {
  tokenDashboardMemoryCache.clear();
}

export function aggregateTokenUsage(entries: LeaderboardEntry[]): TokenTotals {
  return entries.reduce<TokenTotals>(
    (totals, entry) => ({
      totalTokens: totals.totalTokens + entry.totalTokens,
      inputTokens: totals.inputTokens + entry.totalInputTokens,
      outputTokens: totals.outputTokens + entry.totalOutputTokens,
      cacheTokens:
        totals.cacheTokens +
        (entry.totalCacheReadTokens ?? 0) +
        (entry.totalCacheCreationTokens ?? 0),
      taskCount: totals.taskCount + entry.taskCount,
    }),
    { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, taskCount: 0 }
  );
}

/**
 * Aggregate only the sampled rows that belong to the visible realtime window.
 * The waveform and the three counters deliberately share this boundary so a
 * 1h/1d toggle never mixes a short chart with all-time totals.
 */
export function aggregateTokenUsageInWindow(
  entries: LeaderboardEntry[],
  durationMs: number,
  now = new Date()
): TokenTotals {
  const end = now.getTime();
  const start = end - durationMs;
  return aggregateTokenUsage(
    entries.filter((entry) => {
      if (!entry.bucket) return false;
      const timestamp = new Date(entry.bucket).getTime();
      return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
    })
  );
}

function leaderboardUserKey(entry: LeaderboardEntry): string {
  return entry.userId || entry.userUsername || entry.userName || 'unknown';
}

/** Collapse user+model rows into the user rows rendered by the ranking. */
export function aggregateUserLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  const byUser = new Map<string, LeaderboardEntry>();
  for (const entry of entries) {
    const key = leaderboardUserKey(entry);
    const current = byUser.get(key);
    if (!current) {
      byUser.set(key, { ...entry, model: undefined });
      continue;
    }
    current.totalTokens += entry.totalTokens;
    current.totalInputTokens += entry.totalInputTokens;
    current.totalOutputTokens += entry.totalOutputTokens;
    current.totalCacheReadTokens += entry.totalCacheReadTokens;
    current.totalCacheCreationTokens += entry.totalCacheCreationTokens;
    current.totalCost += entry.totalCost;
    current.taskCount += entry.taskCount;
    current.sessionCount += entry.sessionCount;
    current.totalDurationMs += entry.totalDurationMs;
  }
  return Array.from(byUser.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Estimate each user's cost from its model-specific rows. */
export function estimateUserLeaderboardCostsCny(
  entries: LeaderboardEntry[],
  preferences?: TokenPricingPreferences
): ReadonlyMap<string, number> {
  const rowsByUser = new Map<string, LeaderboardEntry[]>();
  for (const entry of entries) {
    const key = leaderboardUserKey(entry);
    const rows = rowsByUser.get(key);
    if (rows) rows.push(entry);
    else rowsByUser.set(key, [entry]);
  }

  return new Map(
    Array.from(rowsByUser, ([key, rows]) => [key, estimateEntriesCostCny(rows, preferences)])
  );
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcStartOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function mondayOfUtcWeek(date: Date): Date {
  const result = utcStartOfDay(date);
  const day = result.getUTCDay();
  result.setUTCDate(result.getUTCDate() - (day === 0 ? 6 : day - 1));
  return result;
}

export function tokenIntensityLevel(value: number, maximum: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || maximum <= 0) return 0;
  const ratio = Math.sqrt(value / maximum);
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export function buildDailyTokenCells(
  entries: LeaderboardEntry[],
  weeks = HISTORY_MAX_WEEKS,
  now = new Date()
): DailyTokenCell[] {
  const totalsByDay = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.bucket) continue;
    const parsed = new Date(entry.bucket);
    if (Number.isNaN(parsed.getTime())) continue;
    const key = utcDateKey(parsed);
    totalsByDay.set(key, (totalsByDay.get(key) ?? 0) + entry.totalTokens);
  }

  const start = mondayOfUtcWeek(now);
  start.setUTCDate(start.getUTCDate() - (weeks - 1) * 7);
  const today = utcStartOfDay(now).getTime();
  const maximum = Math.max(0, ...totalsByDay.values());

  return Array.from({ length: weeks * 7 }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const tokens = totalsByDay.get(utcDateKey(date)) ?? 0;
    return {
      date,
      dateKey: utcDateKey(date),
      tokens,
      level: tokenIntensityLevel(tokens, maximum),
      future: date.getTime() > today,
    };
  });
}

export function weeksForHeatmapWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 20;
  const stride = HEATMAP_CELL_SIZE + HEATMAP_CELL_GAP;
  return Math.max(
    HISTORY_MIN_WEEKS,
    Math.min(HISTORY_MAX_WEEKS, Math.floor((width + HEATMAP_CELL_GAP) / stride))
  );
}

function buildTokenSeries(
  entries: LeaderboardEntry[],
  points: number,
  stepMs: number,
  now = new Date()
): number[] {
  const totalsByPoint = new Map<number, number>();
  for (const entry of entries) {
    if (!entry.bucket) continue;
    const parsed = new Date(entry.bucket);
    if (Number.isNaN(parsed.getTime())) continue;
    const point = Math.floor(parsed.getTime() / stepMs) * stepMs;
    totalsByPoint.set(point, (totalsByPoint.get(point) ?? 0) + entry.totalTokens);
  }
  const currentPoint = Math.floor(now.getTime() / stepMs) * stepMs;
  return Array.from({ length: points }, (_, index) => {
    const point = currentPoint - (points - 1 - index) * stepMs;
    return totalsByPoint.get(point) ?? 0;
  });
}

export function buildHourlyTokenSeries(
  entries: LeaderboardEntry[],
  hours = 24,
  now = new Date()
): number[] {
  return buildTokenSeries(entries, hours, HOUR_MS, now);
}

export function buildMinuteTokenSeries(
  entries: LeaderboardEntry[],
  minutes = 60,
  now = new Date()
): number[] {
  return buildTokenSeries(entries, minutes, 60_000, now);
}

export function buildThirtySecondTokenSeries(
  entries: LeaderboardEntry[],
  intervals = 120,
  now = new Date()
): number[] {
  return buildTokenSeries(entries, intervals, THIRTY_SECONDS_MS, now);
}

export function buildRealtimeTokenSeries(
  entries: LeaderboardEntry[],
  range: '1h' | '1d',
  now = new Date()
) {
  const values = buildThirtySecondTokenSeries(entries, range === '1h' ? 120 : 2880, now);
  return {
    values,
    startTime:
      Math.floor(now.getTime() / THIRTY_SECONDS_MS) * THIRTY_SECONDS_MS -
      (values.length - 1) * THIRTY_SECONDS_MS,
  };
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfLocalWeek(now: Date): Date {
  const start = startOfLocalDay(now);
  const day = start.getDay();
  start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  return start;
}

const MetricCard: React.FC<{
  label: string;
  value: number;
  estimatedCostCny: number;
  locale: string;
}> = ({ label, value, estimatedCostCny, locale }) => {
  const { token } = theme.useToken();
  const { t } = useLocale();
  const exact = new Intl.NumberFormat(locale).format(value);

  return (
    <div
      style={{
        minHeight: 96,
        padding: '14px 16px',
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
      }}
    >
      <Text type="secondary" style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
        {label}
      </Text>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              marginTop: 5,
              color: token.colorText,
              fontSize: 'clamp(25px, 2vw, 34px)',
              fontWeight: 720,
              letterSpacing: '-0.035em',
              lineHeight: 1.06,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            <Tooltip title={exact}>{formatTokenCount(value)}</Tooltip>
          </div>
          <Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
            Token
          </Text>
        </div>
        <div style={{ minWidth: 82, paddingBottom: 1, textAlign: 'right' }}>
          <Text
            style={{ display: 'block', color: token.colorPrimary, fontSize: 10, fontWeight: 600 }}
          >
            {t('estimatedCostCny')}
          </Text>
          <Text
            style={{
              color: token.colorPrimary,
              fontSize: 14,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatEstimatedCny(estimatedCostCny, locale)}
          </Text>
        </div>
      </div>
    </div>
  );
};

const TokenHeatmap: React.FC<{
  entries: LeaderboardEntry[];
  locale: string;
}> = ({ entries, locale }) => {
  const { token } = theme.useToken();
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(300);
  const weeks = weeksForHeatmapWidth(containerWidth);
  const cells = useMemo(() => buildDailyTokenCells(entries, weeks), [entries, weeks]);
  const gridWidth = weeks * HEATMAP_CELL_SIZE + Math.max(0, weeks - 1) * HEATMAP_CELL_GAP;
  const colors = [
    token.colorFillQuaternary,
    token.colorPrimaryBg,
    token.colorPrimaryBorder,
    token.colorPrimary,
    token.colorPrimaryActive,
  ];
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
    [locale]
  );
  const monthLabels = useMemo(
    () =>
      Array.from({ length: weeks }, (_, index) => {
        const date = cells[index * 7]?.date;
        const previousDate = index > 0 ? cells[(index - 1) * 7]?.date : undefined;
        const changed =
          !previousDate ||
          date?.getUTCMonth() !== previousDate.getUTCMonth() ||
          date?.getUTCFullYear() !== previousDate.getUTCFullYear();
        return date && changed ? { index, date, label: monthFormatter.format(date) } : null;
      }).filter((label): label is { index: number; date: Date; label: string } => Boolean(label)),
    [cells, monthFormatter, weeks]
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateWidth = () => setContainerWidth(element.clientWidth);
    updateWidth();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef}>
      <div style={{ marginBottom: 9 }}>
        <Text strong style={{ display: 'block', fontSize: 14 }}>
          {t('tokenHistory')}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('tokenHistoryHint', { weeks })}
        </Text>
      </div>
      <div style={{ overflow: 'hidden', paddingBlock: 1 }}>
        <div style={{ width: gridWidth, maxWidth: '100%', marginInline: 'auto' }}>
          <div
            aria-hidden
            style={{
              position: 'relative',
              height: 18,
              color: token.colorTextSecondary,
              fontSize: 10,
              lineHeight: '14px',
            }}
          >
            {monthLabels.map((month) => (
              <span
                key={month.date.toISOString()}
                style={{
                  position: 'absolute',
                  left: month.index * (HEATMAP_CELL_SIZE + HEATMAP_CELL_GAP),
                  whiteSpace: 'nowrap',
                }}
              >
                {month.label}
              </span>
            ))}
          </div>
          <div
            role="img"
            aria-label={t('tokenHistory')}
            style={{
              display: 'grid',
              gridAutoFlow: 'column',
              gridTemplateRows: `repeat(7, ${HEATMAP_CELL_SIZE}px)`,
              gridAutoColumns: `${HEATMAP_CELL_SIZE}px`,
              gap: HEATMAP_CELL_GAP,
            }}
          >
            {cells.map((cell) =>
              cell.future ? (
                <span
                  key={cell.dateKey}
                  aria-hidden
                  data-testid="token-heat-cell-future"
                  style={{
                    width: HEATMAP_CELL_SIZE,
                    height: HEATMAP_CELL_SIZE,
                    visibility: 'hidden',
                  }}
                />
              ) : (
                <Tooltip
                  key={cell.dateKey}
                  title={`${new Intl.DateTimeFormat(locale, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  }).format(cell.date)} 使用了 ${formatTokenCount(cell.tokens)} Token`}
                  mouseEnterDelay={0}
                  mouseLeaveDelay={0}
                  fresh
                >
                  <span
                    data-testid="token-heat-cell"
                    style={{
                      width: HEATMAP_CELL_SIZE,
                      height: HEATMAP_CELL_SIZE,
                      borderRadius: 3,
                      background: colors[cell.level],
                      cursor: 'default',
                    }}
                  />
                </Tooltip>
              )
            )}
          </div>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 5,
          width: gridWidth,
          maxWidth: '100%',
          margin: '8px auto 0',
        }}
      >
        <Text type="secondary" style={{ fontSize: 10 }}>
          {t('less')}
        </Text>
        {colors.map((color) => (
          <span
            key={color}
            aria-hidden
            style={{ width: 10, height: 10, borderRadius: 2, background: color }}
          />
        ))}
        <Text type="secondary" style={{ fontSize: 10 }}>
          {t('more')}
        </Text>
      </div>
    </div>
  );
};

const ModelUsageList: React.FC<{
  entries: LeaderboardEntry[];
  locale: string;
  tokenPricing?: TokenPricingPreferences;
}> = ({ entries, locale, tokenPricing }) => {
  const { token } = theme.useToken();
  const { t } = useLocale();
  const rankedEntries = useMemo(
    () =>
      entries
        .filter((entry) => Boolean(entry.model?.trim()) && entry.totalTokens > 0)
        .sort((left, right) => {
          const tokenDifference = right.totalTokens - left.totalTokens;
          if (tokenDifference !== 0) return tokenDifference;
          return (left.model || '').localeCompare(right.model || '', locale);
        }),
    [entries, locale]
  );
  const maxModelTokens = rankedEntries.reduce(
    (maximum, entry) => Math.max(maximum, entry.totalTokens),
    0
  );

  return (
    <div
      data-testid="token-model-usage"
      style={{ display: 'flex', minHeight: 0, height: '100%', flexDirection: 'column' }}
    >
      <div style={{ marginBottom: 12 }}>
        <Text strong style={{ display: 'block', fontSize: 14 }}>
          {t('tokenUsageByModel')}
        </Text>
      </div>
      {rankedEntries.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('noActivity')} />
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 5,
            minHeight: 0,
            maxHeight: 170,
            paddingRight: rankedEntries.length > 5 ? 5 : 0,
            overflowY: rankedEntries.length > 5 ? 'auto' : 'visible',
          }}
        >
          {rankedEntries.map((entry, index) => {
            const model = entry.model || '—';
            const estimatedCost = estimateEntriesCostCny([entry], tokenPricing);
            const percent = maxModelTokens > 0 ? (entry.totalTokens / maxModelTokens) * 100 : 0;
            return (
              <div
                key={model}
                className="disco-token-model-row"
                data-testid="token-model-row"
                data-model-key={model}
                style={{
                  display: 'grid',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 34,
                  padding: '3px 5px',
                  borderRadius: 8,
                }}
              >
                <Text
                  className="disco-token-model-rank"
                  type="secondary"
                  style={{ fontSize: 11, textAlign: 'center' }}
                >
                  {index + 1}
                </Text>
                <Text
                  className="disco-token-model-name"
                  ellipsis
                  style={{ minWidth: 0, fontSize: 12 }}
                  title={model}
                >
                  {model}
                </Text>
                <div
                  className="disco-token-model-bar"
                  style={{
                    height: 5,
                    overflow: 'hidden',
                    borderRadius: 999,
                    background: token.colorFillSecondary,
                  }}
                >
                  <div
                    data-testid="token-model-bar-fill"
                    style={{
                      width: entry.totalTokens > 0 ? `max(3px, ${percent}%)` : 0,
                      height: '100%',
                      borderRadius: 999,
                      background: token.colorPrimary,
                    }}
                  />
                </div>
                <div
                  className="disco-token-model-metrics"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'baseline',
                    justifyContent: 'flex-end',
                    gap: 6,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <Tooltip
                    title={`${new Intl.NumberFormat(locale).format(entry.totalTokens)} Token`}
                    mouseEnterDelay={0}
                  >
                    <Text strong style={{ fontSize: 11 }}>
                      {formatTokenCount(entry.totalTokens)}
                    </Text>
                  </Tooltip>
                  <Text style={{ color: token.colorPrimaryText, fontSize: 10, fontWeight: 600 }}>
                    {formatEstimatedCny(estimatedCost, locale)}
                  </Text>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const RealtimeWaveform: React.FC<{
  entries: LeaderboardEntry[];
  locale: string;
}> = ({ entries, locale }) => {
  const { token } = theme.useToken();
  const { t } = useLocale();
  const [range, setRange] = useState<'1h' | '1d'>('1h');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const durationMs = range === '1h' ? HOUR_MS : 24 * HOUR_MS;
  const totals = useMemo(
    () => aggregateTokenUsageInWindow(entries, durationMs),
    [durationMs, entries]
  );
  const { values, startTime } = useMemo(
    () => buildRealtimeTokenSeries(entries, range),
    [entries, range]
  );
  const width = 520;
  const height = 132;
  const padding = 10;
  const { points, path, area } = useMemo(
    () => buildTokenWaveform(values, width, height, padding),
    [values]
  );
  const active = values.some((value) => value > 0);
  const hoverPoint = hoverIndex === null ? undefined : points[hoverIndex];
  const hoverTime =
    hoverIndex === null ? undefined : new Date(startTime + hoverIndex * THIRTY_SECONDS_MS);
  const hoverRatio = hoverPoint ? hoverPoint.x / width : 0;
  const hoverTransform =
    hoverRatio < 0.2
      ? 'translateX(6px)'
      : hoverRatio > 0.8
        ? 'translateX(calc(-100% - 6px))'
        : 'translateX(-50%)';
  const gradientId = 'disco-token-wave-gradient';

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <Text strong style={{ display: 'block', fontSize: 14 }}>
            {t('realtimeActivity')}
          </Text>
          <Segmented
            size="middle"
            shape="round"
            value={range}
            onChange={(value) => setRange(value as '1h' | '1d')}
            options={[
              {
                label: <span style={{ display: 'inline-block', minWidth: 28 }}>1h</span>,
                value: '1h',
              },
              {
                label: <span style={{ display: 'inline-block', minWidth: 28 }}>1d</span>,
                value: '1d',
              },
            ]}
            style={dashboardSegmentedStyle(token)}
          />
        </div>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {range === '1h' ? t('realtimeHourHint') : t('realtimeActivityHint')}
        </Text>
      </div>
      <div
        style={{
          position: 'relative',
          height: 132,
          overflow: 'hidden',
          borderRadius: token.borderRadiusLG,
          background: token.colorFillQuaternary,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <svg
          role="img"
          aria-label={t('realtimeActivity')}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            cursor: 'crosshair',
          }}
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - bounds.left) / bounds.width) * width;
            setHoverIndex(findTokenWaveformHoverIndex(points, x, width / bounds.width));
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={token.colorPrimary} stopOpacity="0.2" />
              <stop offset="100%" stopColor={token.colorPrimary} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line
              key={ratio}
              x1="0"
              x2={width}
              y1={height * ratio}
              y2={height * ratio}
              stroke={token.colorBorderSecondary}
              strokeWidth="1"
              strokeDasharray="3 6"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={area} fill={`url(#${gradientId})`} />
          <path
            d={path}
            fill="none"
            stroke={token.colorPrimary}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {hoverPoint && (
            <g>
              <line
                x1={hoverPoint.x}
                x2={hoverPoint.x}
                y1="0"
                y2={height}
                stroke={token.colorTextSecondary}
                strokeWidth="1"
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={hoverPoint.x}
                cy={hoverPoint.y}
                r="4"
                fill={token.colorBgContainer}
                stroke={token.colorPrimary}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}
        </svg>
        {!active && (
          <Text
            type="secondary"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              pointerEvents: 'none',
            }}
          >
            {t('noActivity')}
          </Text>
        )}
        {hoverPoint && hoverTime && (
          <div
            style={{
              position: 'absolute',
              zIndex: 2,
              top: 8,
              left: `${hoverRatio * 100}%`,
              transform: hoverTransform,
              minWidth: 112,
              padding: '7px 9px',
              borderRadius: 8,
              border: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgElevated,
              boxShadow: token.boxShadowSecondary,
              color: token.colorText,
              fontSize: 11,
              lineHeight: 1.45,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            <div style={{ color: token.colorTextSecondary }}>
              {new Intl.DateTimeFormat(locale, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }).format(hoverTime)}
            </div>
            <strong>{formatTokenCount(hoverPoint.value)} Token</strong>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', marginTop: 5 }}>
        <Text type="secondary" style={{ fontSize: 10 }}>
          {new Intl.DateTimeFormat(locale, {
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(startTime))}
        </Text>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          marginTop: 10,
          paddingTop: 10,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {[
          [t('inputTokens'), totals.inputTokens],
          [t('outputTokens'), totals.outputTokens],
          [t('cacheTokens'), totals.cacheTokens],
        ].map(([label, value]) => (
          <div key={String(label)} style={{ minWidth: 0, textAlign: 'center' }}>
            <Tooltip title={new Intl.NumberFormat(locale).format(Number(value))}>
              <Text strong style={{ display: 'block', fontSize: 13 }}>
                {formatTokenCount(Number(value))}
              </Text>
            </Tooltip>
            <Text type="secondary" style={{ fontSize: 10 }}>
              {label}
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
};

type UserRankingRange = 'today' | 'week' | 'all';

export function rankingFlipKeyframes(deltaY: number): Keyframe[] {
  return Math.abs(deltaY) > 0.5
    ? [
        { transform: `translateY(${deltaY}px)`, opacity: 0.82 },
        { transform: 'translateY(0)', opacity: 1 },
      ]
    : [];
}

function rankingRowTop(element: HTMLDivElement): number {
  const container = element.parentElement;
  if (!container) return element.getBoundingClientRect().top;
  return (
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
}

export function useRankingFlipAnimation(
  entries: LeaderboardEntry[],
  range: UserRankingRange
): (key: string, element: HTMLDivElement | null) => void {
  const elements = useRef(new Map<string, HTMLDivElement>());
  const previousTop = useRef(new Map<string, number>());
  const previousOrder = useRef(new Map<string, number>());
  const previousRange = useRef<UserRankingRange>(range);
  const animations = useRef(new Map<string, Animation>());

  const setElement = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) elements.current.set(key, element);
    else elements.current.delete(key);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new entries change rendered row positions, so refresh the DOM measurements before the next range transition.
  useLayoutEffect(() => {
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();

    const currentTop = new Map<string, number>();
    for (const [key, element] of elements.current) {
      currentTop.set(key, rankingRowTop(element));
    }
    const currentOrder = new Map(
      [...currentTop.entries()]
        .sort((left, right) => left[1] - right[1])
        .map(([key], index) => [key, index])
    );

    const rangeChanged = previousRange.current !== range;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (rangeChanged && !reduceMotion) {
      for (const [key, element] of elements.current) {
        if (previousOrder.current.get(key) === currentOrder.get(key)) continue;
        const oldTop = previousTop.current.get(key);
        const newTop = currentTop.get(key);
        if (typeof element.animate !== 'function' || oldTop === undefined || newTop === undefined)
          continue;
        const keyframes = rankingFlipKeyframes(oldTop - newTop);
        if (keyframes.length === 0) continue;
        const animation = element.animate(keyframes, {
          duration: 240,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
        animations.current.set(key, animation);
      }
    }

    previousTop.current = currentTop;
    previousOrder.current = currentOrder;
    previousRange.current = range;
  }, [entries, range]);

  useEffect(
    () => () => {
      for (const animation of animations.current.values()) animation.cancel();
      animations.current.clear();
    },
    []
  );

  return setElement;
}

const UserRanking: React.FC<{
  entries: LeaderboardEntry[];
  estimatedCosts: ReadonlyMap<string, number>;
  locale: string;
  range: UserRankingRange;
  onRangeChange: (range: UserRankingRange) => void;
}> = ({ entries, estimatedCosts, locale, range, onRangeChange }) => {
  const { token } = theme.useToken();
  const { t } = useLocale();
  const setRankingElement = useRankingFlipAnimation(entries, range);
  const maxUserTokens = entries.reduce((maximum, entry) => Math.max(maximum, entry.totalTokens), 0);

  return (
    <div style={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <div>
          <Text strong style={{ display: 'block', fontSize: 14 }}>
            {t('byUser')}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('userRankingHint')}
          </Text>
        </div>
        <Segmented<UserRankingRange>
          size="middle"
          shape="round"
          value={range}
          options={[
            { label: t('todayTokens'), value: 'today' },
            { label: t('weekTokens'), value: 'week' },
            { label: t('all'), value: 'all' },
          ]}
          onChange={onRangeChange}
          style={dashboardSegmentedStyle(token)}
        />
      </div>
      {entries.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('noActivity')} />
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 5,
            minHeight: 0,
            maxHeight: 204,
            paddingRight: entries.length > 6 ? 5 : 0,
            overflowY: entries.length > 6 ? 'auto' : 'visible',
          }}
        >
          {entries.map((entry, index) => {
            const name = entry.userName || entry.userUsername || t('unknownUser');
            const entryKey = entry.userId || entry.userUsername || `unknown-${name}`;
            const percent = maxUserTokens > 0 ? (entry.totalTokens / maxUserTokens) * 100 : 0;
            const estimatedCost = estimatedCosts.get(leaderboardUserKey(entry)) ?? 0;
            return (
              <div
                key={entryKey}
                ref={(element) => setRankingElement(entryKey, element)}
                className="disco-token-user-row"
                data-testid="token-user-row"
                data-user-key={entryKey}
                style={{
                  display: 'grid',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 34,
                  padding: '3px 5px',
                  borderRadius: 8,
                }}
              >
                <Text
                  className="disco-token-user-rank"
                  type="secondary"
                  style={{ fontSize: 11, textAlign: 'center' }}
                >
                  {index + 1}
                </Text>
                <Avatar
                  className="disco-token-user-avatar"
                  size={28}
                  src={entry.userAvatarUrl || undefined}
                  style={{ background: token.colorFillSecondary, color: token.colorText }}
                >
                  {!entry.userAvatarUrl && (entry.userEmoji || name.slice(0, 1).toUpperCase())}
                </Avatar>
                <Text className="disco-token-user-name" ellipsis style={{ fontSize: 12 }}>
                  {name}
                </Text>
                <div
                  className="disco-token-user-bar"
                  style={{
                    height: 5,
                    overflow: 'hidden',
                    borderRadius: 999,
                    background: token.colorFillSecondary,
                  }}
                >
                  <div
                    style={{
                      width: entry.totalTokens > 0 ? `max(3px, ${percent}%)` : 0,
                      height: '100%',
                      borderRadius: 999,
                      background: token.colorPrimary,
                      transition: 'width 240ms cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                  />
                </div>
                <div
                  className="disco-token-user-metrics"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'baseline',
                    justifyContent: 'flex-end',
                    gap: 6,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <Tooltip
                    title={`${new Intl.NumberFormat(locale).format(entry.totalTokens)} Token`}
                    mouseEnterDelay={0}
                  >
                    <Text strong style={{ fontSize: 11 }}>
                      {formatTokenCount(entry.totalTokens)}
                    </Text>
                  </Tooltip>
                  <Text style={{ color: token.colorPrimaryText, fontSize: 10, fontWeight: 600 }}>
                    {formatEstimatedCny(estimatedCost, locale)}
                  </Text>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const HomeTokenUsageCard: React.FC<{
  client: DiscoClient | null;
  connected?: boolean;
  currentUserId?: string;
}> = ({ client, connected, currentUserId }) => {
  const { token } = theme.useToken();
  const { locale, t } = useLocale();
  const currentUser = useDiscoStore((state) =>
    currentUserId ? state.userById.get(currentUserId) : undefined
  );
  const tokenPricing = currentUser?.preferences?.tokenPricing as
    | TokenPricingPreferences
    | undefined;
  const [data, setData] = useState<TokenDashboardData>(
    () => readCachedTokenDashboardData(currentUserId) ?? EMPTY_DATA
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rankingRange, setRankingRange] = useState<UserRankingRange>('today');

  const loadUsage = useCallback(async () => {
    if (!client || !connected) return;
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const todayStart = startOfLocalDay(now);
      const weekStart = startOfLocalWeek(now);
      const historyStart = mondayOfUtcWeek(now);
      historyStart.setUTCDate(historyStart.getUTCDate() - (HISTORY_MAX_WEEKS - 1) * 7);
      const activityStart = new Date(now.getTime() - 24 * HOUR_MS);
      const service = client.service('leaderboard');
      const [
        allUserModels,
        todayUserModels,
        weekUserModels,
        self,
        today,
        week,
        daily,
        activity,
        allModels,
        todayModels,
        weekModels,
      ] = await Promise.allSettled([
        service.find({
          query: {
            groupBy: 'user,model',
            sortBy: 'tokens',
            sortOrder: 'desc',
            limit: 10_000,
          },
        }),
        service.find({
          query: {
            groupBy: 'user,model',
            startDate: todayStart.toISOString(),
            sortBy: 'tokens',
            sortOrder: 'desc',
            limit: 10_000,
          },
        }),
        service.find({
          query: {
            groupBy: 'user,model',
            startDate: weekStart.toISOString(),
            sortBy: 'tokens',
            sortOrder: 'desc',
            limit: 10_000,
          },
        }),
        service.find({
          query: {
            groupBy: '',
            ...(currentUserId ? { userId: currentUserId } : {}),
            sortBy: 'tokens',
            limit: 1,
          },
        }),
        service.find({
          query: {
            groupBy: '',
            ...(currentUserId ? { userId: currentUserId } : {}),
            startDate: todayStart.toISOString(),
            sortBy: 'tokens',
            limit: 1,
          },
        }),
        service.find({
          query: {
            groupBy: '',
            ...(currentUserId ? { userId: currentUserId } : {}),
            startDate: weekStart.toISOString(),
            sortBy: 'tokens',
            limit: 1,
          },
        }),
        service.find({
          query: {
            groupBy: '',
            ...(currentUserId ? { userId: currentUserId } : {}),
            bucket: 'day',
            timeSource: 'samples',
            startDate: historyStart.toISOString(),
            sortBy: 'tokens',
            sortOrder: 'asc',
            limit: HISTORY_MAX_WEEKS * 7 + 7,
          },
        }),
        service.find({
          query: {
            groupBy: '',
            ...(currentUserId ? { userId: currentUserId } : {}),
            bucket: '30s',
            timeSource: 'samples',
            startDate: activityStart.toISOString(),
            sortBy: 'tokens',
            sortOrder: 'asc',
            limit: 3000,
          },
        }),
        service.find({
          query: {
            groupBy: 'model',
            ...(currentUserId ? { userId: currentUserId } : {}),
            sortBy: 'tokens',
            sortOrder: 'desc',
            limit: 1000,
          },
        }),
        service.find({
          query: {
            groupBy: 'model',
            ...(currentUserId ? { userId: currentUserId } : {}),
            startDate: todayStart.toISOString(),
            sortBy: 'tokens',
            sortOrder: 'desc',
            limit: 1000,
          },
        }),
        service.find({
          query: {
            groupBy: 'model',
            ...(currentUserId ? { userId: currentUserId } : {}),
            startDate: weekStart.toISOString(),
            sortBy: 'tokens',
            sortOrder: 'desc',
            limit: 1000,
          },
        }),
      ]);
      const results = [
        allUserModels,
        todayUserModels,
        weekUserModels,
        self,
        today,
        week,
        daily,
        activity,
        allModels,
        todayModels,
        weekModels,
      ];
      if (results.every((result) => result.status === 'rejected')) {
        throw allUserModels.status === 'rejected'
          ? allUserModels.reason
          : new Error('Token data unavailable');
      }
      setData((previous) => {
        const nextAllUserModels =
          allUserModels.status === 'fulfilled' ? allUserModels.value.data : previous.userModels;
        const nextTodayUserModels =
          todayUserModels.status === 'fulfilled'
            ? todayUserModels.value.data
            : previous.todayUserModels;
        const nextWeekUserModels =
          weekUserModels.status === 'fulfilled'
            ? weekUserModels.value.data
            : previous.weekUserModels;
        const next = {
          users:
            allUserModels.status === 'fulfilled'
              ? aggregateUserLeaderboard(nextAllUserModels)
              : previous.users,
          todayUsers:
            todayUserModels.status === 'fulfilled'
              ? aggregateUserLeaderboard(nextTodayUserModels)
              : previous.todayUsers,
          weekUsers:
            weekUserModels.status === 'fulfilled'
              ? aggregateUserLeaderboard(nextWeekUserModels)
              : previous.weekUsers,
          userModels: nextAllUserModels,
          todayUserModels: nextTodayUserModels,
          weekUserModels: nextWeekUserModels,
          self: self.status === 'fulfilled' ? (self.value.data[0] ?? null) : previous.self,
          today: today.status === 'fulfilled' ? (today.value.data[0] ?? null) : previous.today,
          week: week.status === 'fulfilled' ? (week.value.data[0] ?? null) : previous.week,
          daily: daily.status === 'fulfilled' ? daily.value.data : previous.daily,
          activity: activity.status === 'fulfilled' ? activity.value.data : previous.activity,
          allModels: allModels.status === 'fulfilled' ? allModels.value.data : previous.allModels,
          todayModels:
            todayModels.status === 'fulfilled' ? todayModels.value.data : previous.todayModels,
          weekModels:
            weekModels.status === 'fulfilled' ? weekModels.value.data : previous.weekModels,
        };
        writeCachedTokenDashboardData(currentUserId, next);
        return next;
      });
      if (results.some((result) => result.status === 'rejected')) {
        setError(t('tokenUsageLoadFailed'));
      }
    } catch {
      setError(t('tokenUsageLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [client, connected, currentUserId, t]);

  useEffect(() => {
    setData(readCachedTokenDashboardData(currentUserId) ?? EMPTY_DATA);
  }, [currentUserId]);

  useEffect(() => {
    void loadUsage();
    if (!client || !connected) return;
    const timer = window.setInterval(() => void loadUsage(), REALTIME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [client, connected, loadUsage]);

  const rankingEntries =
    rankingRange === 'today'
      ? data.todayUsers
      : rankingRange === 'week'
        ? data.weekUsers
        : data.users;
  const rankingModelEntries =
    rankingRange === 'today'
      ? data.todayUserModels
      : rankingRange === 'week'
        ? data.weekUserModels
        : data.userModels;
  const rankingEstimatedCosts = useMemo(
    () => estimateUserLeaderboardCostsCny(rankingModelEntries, tokenPricing),
    [rankingModelEntries, tokenPricing]
  );
  const estimatedCosts = useMemo(
    () => ({
      today: estimateEntriesCostCny(
        data.todayModels.length > 0 ? data.todayModels : data.today ? [data.today] : [],
        tokenPricing
      ),
      week: estimateEntriesCostCny(
        data.weekModels.length > 0 ? data.weekModels : data.week ? [data.week] : [],
        tokenPricing
      ),
      all: estimateEntriesCostCny(
        data.allModels.length > 0 ? data.allModels : data.self ? [data.self] : [],
        tokenPricing
      ),
    }),
    [data, tokenPricing]
  );
  const hasAnyData =
    (data.self?.totalTokens ?? 0) > 0 || data.daily.length > 0 || data.activity.length > 0;
  return (
    <Card
      style={{
        marginBottom: 18,
        overflow: 'hidden',
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 14,
        background: token.colorBgElevated,
        boxShadow: 'none',
      }}
      styles={{ body: { padding: 'clamp(15px, 1.8vw, 20px)' } }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text strong style={{ fontSize: 14 }}>
              {t('tokenUsage')}
            </Text>
          </div>
        </div>
        <Tooltip title={t('refresh')}>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined spin={loading} />}
            aria-label={t('refresh')}
            onClick={() => void loadUsage()}
            disabled={!client || !connected || loading}
          />
        </Tooltip>
      </div>

      {error && !hasAnyData ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error} />
      ) : (
        <>
          <div
            className="disco-token-metric-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
              gap: 8,
              marginBottom: 12,
            }}
          >
            <MetricCard
              label={t('todayTokens')}
              value={data.today?.totalTokens ?? 0}
              estimatedCostCny={estimatedCosts.today}
              locale={locale}
            />
            <MetricCard
              label={t('weekTokens')}
              value={data.week?.totalTokens ?? 0}
              estimatedCostCny={estimatedCosts.week}
              locale={locale}
            />
            <MetricCard
              label={t('allTimeTokens')}
              value={data.self?.totalTokens ?? 0}
              estimatedCostCny={estimatedCosts.all}
              locale={locale}
            />
          </div>

          <div className="disco-token-history-model-grid">
            <section
              data-testid="token-history-card"
              style={{
                minWidth: 0,
                padding: '14px clamp(12px, 1.8vw, 18px)',
                borderRadius: token.borderRadiusLG,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              <TokenHeatmap entries={data.daily} locale={locale} />
            </section>
            <section
              data-testid="token-model-card"
              style={{
                minWidth: 0,
                padding: '14px clamp(12px, 1.8vw, 18px)',
                borderRadius: token.borderRadiusLG,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              <ModelUsageList
                entries={data.allModels}
                locale={locale}
                tokenPricing={tokenPricing}
              />
            </section>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 390px), 1fr))',
              alignItems: 'stretch',
              gap: 12,
            }}
          >
            <div
              data-testid="token-user-ranking-card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 280,
                padding: 15,
                borderRadius: token.borderRadiusLG,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              <UserRanking
                entries={rankingEntries}
                estimatedCosts={rankingEstimatedCosts}
                locale={locale}
                range={rankingRange}
                onRangeChange={setRankingRange}
              />
            </div>

            <div
              data-testid="token-realtime-card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 280,
                padding: 15,
                borderRadius: token.borderRadiusLG,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              <RealtimeWaveform entries={data.activity} locale={locale} />
            </div>
          </div>
        </>
      )}
    </Card>
  );
};
