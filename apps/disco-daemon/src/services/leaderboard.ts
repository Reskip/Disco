/**
 * Leaderboard Service
 *
 * Provides usage analytics endpoint for token and cost tracking.
 * Allows breakdown by user, model, and agentic tool, with
 * optional time bucketing (30s/minute/hour/day/week/month) and flexible filtering.
 */

import {
  and,
  asc,
  type DateBucket,
  dateTruncUtc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  jsonExtract,
  lte,
  or,
  type SQL,
  sql,
  type TenantScopeAwareDatabase,
  taskUsageLedger,
  users,
} from '@disco/core/db';
import type {
  LeaderboardDimension,
  LeaderboardEntry,
  LeaderboardQuery,
  LeaderboardResult,
  TokenUsageSample,
} from '@disco/core/types';

interface Params {
  query?: Record<string, unknown>;
}

/**
 * Supported groupBy dimensions. Callers can combine these in a comma-separated string,
 * e.g. `'user,model'` or `'tool,branch,repo'`.
 */
const ALL_DIMENSIONS: LeaderboardDimension[] = ['user', 'model', 'tool'];

const VALID_BUCKETS = new Set<DateBucket>(['30s', 'minute', 'hour', 'day', 'week', 'month']);
const MAX_LIMIT = 10_000;

function sampledBucketStart(date: Date, bucket: NonNullable<LeaderboardQuery['bucket']>): string {
  const milliseconds = date.getTime();
  if (bucket === '30s') {
    return new Date(Math.floor(milliseconds / 30_000) * 30_000).toISOString();
  }
  const result = new Date(milliseconds);
  if (bucket === 'minute') {
    result.setUTCSeconds(0, 0);
  } else if (bucket === 'hour') {
    result.setUTCMinutes(0, 0, 0);
  } else if (bucket === 'day') {
    result.setUTCHours(0, 0, 0, 0);
  } else if (bucket === 'week') {
    result.setUTCHours(0, 0, 0, 0);
    const day = result.getUTCDay();
    result.setUTCDate(result.getUTCDate() - (day === 0 ? 6 : day - 1));
  } else {
    result.setUTCDate(1);
    result.setUTCHours(0, 0, 0, 0);
  }
  return result.toISOString();
}

function parseOptionalDate(
  value: string | undefined,
  name: 'startDate' | 'endDate'
): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${name}: "${value}". Expected ISO 8601 format.`);
  }
  return parsed;
}

function parseIntegerParam(
  value: unknown,
  fallback: number,
  { min, max }: { min: number; max: number }
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeStringFilterValues(...values: unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'string') return;
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  };

  for (const value of values) visit(value);
  return normalized;
}

function stringFilter(column: unknown, values: string[]): SQL | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return eq(column as never, values[0]);
  return inArray(column as never, values);
}

/**
 * Parse the comma-separated groupBy string into a set of known dimensions.
 * Throws on unknown values so typos surface loudly rather than silently
 * collapsing the result set to an unexpected grouping. Matches the strict
 * validation we do for `bucket`.
 */
function parseGroupBy(groupBy: string): Set<LeaderboardDimension> {
  const dims = new Set<LeaderboardDimension>();
  for (const raw of groupBy.split(',')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (!ALL_DIMENSIONS.includes(trimmed as LeaderboardDimension)) {
      throw new Error(
        `Invalid groupBy dimension: "${trimmed}". Expected one of: ${ALL_DIMENSIONS.join(', ')}.`
      );
    }
    dims.add(trimmed as LeaderboardDimension);
  }
  return dims;
}

/**
 * Leaderboard service
 *
 * Custom service that doesn't use DrizzleService adapter since we need
 * custom aggregation queries.
 */
export class LeaderboardService {
  private db: TenantScopeAwareDatabase;

  constructor(db: TenantScopeAwareDatabase) {
    this.db = db;
  }

  private async findSampledTimeline(
    query: LeaderboardQuery,
    bucket: NonNullable<LeaderboardQuery['bucket']>,
    limit: number,
    offset: number
  ): Promise<LeaderboardResult> {
    const start = parseOptionalDate(query.startDate, 'startDate');
    const end = parseOptionalDate(query.endDate, 'endDate');
    const conditions: SQL[] = [];
    const userFilter = stringFilter(
      taskUsageLedger.user_id,
      normalizeStringFilterValues(query.userId, query.userIds)
    );
    if (userFilter) conditions.push(userFilter);
    // Include tasks that overlap the requested window. Individual samples are
    // filtered below by observedAt, so a long task can contribute after it began.
    if (end) conditions.push(lte(taskUsageLedger.task_created_at, end));
    if (start) {
      const overlapsStart = or(
        isNull(taskUsageLedger.task_completed_at),
        gte(taskUsageLedger.task_completed_at, start)
      );
      if (overlapsStart) conditions.push(overlapsStart);
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // biome-ignore lint/suspicious/noExplicitAny: Database union cannot expose a shared dynamic select type.
    let rowsQuery = (this.db as any)
      .select({
        taskId: taskUsageLedger.task_id,
        sessionId: taskUsageLedger.session_id,
        createdAt: taskUsageLedger.task_created_at,
        completedAt: taskUsageLedger.task_completed_at,
        inputTokens: taskUsageLedger.input_tokens,
        outputTokens: taskUsageLedger.output_tokens,
        totalTokens: taskUsageLedger.total_tokens,
        cacheReadTokens: taskUsageLedger.cache_read_tokens,
        cacheCreationTokens: taskUsageLedger.cache_creation_tokens,
        tokenUsageSamples: taskUsageLedger.token_usage_samples,
      })
      .from(taskUsageLedger);
    if (whereClause) rowsQuery = rowsQuery.where(whereClause);
    const rows = (await rowsQuery) as Array<{
      taskId: string;
      sessionId: string;
      createdAt: Date;
      completedAt: Date | null;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      tokenUsageSamples: TokenUsageSample[];
    }>;

    interface BucketAccumulator {
      input: number;
      output: number;
      total: number;
      cacheRead: number;
      cacheCreation: number;
      taskIds: Set<string>;
      sessionIds: Set<string>;
    }
    const buckets = new Map<string, BucketAccumulator>();
    const addDelta = (
      row: (typeof rows)[number],
      observedAt: Date,
      input: number,
      output: number,
      total: number,
      cacheRead: number,
      cacheCreation: number
    ) => {
      if (start && observedAt < start) return;
      if (end && observedAt > end) return;
      if (input <= 0 && output <= 0 && total <= 0 && cacheRead <= 0 && cacheCreation <= 0) return;
      const key = sampledBucketStart(observedAt, bucket);
      const accumulator = buckets.get(key) ?? {
        input: 0,
        output: 0,
        total: 0,
        cacheRead: 0,
        cacheCreation: 0,
        taskIds: new Set<string>(),
        sessionIds: new Set<string>(),
      };
      accumulator.input += Math.max(0, input);
      accumulator.output += Math.max(0, output);
      accumulator.total += Math.max(0, total);
      accumulator.cacheRead += Math.max(0, cacheRead);
      accumulator.cacheCreation += Math.max(0, cacheCreation);
      accumulator.taskIds.add(row.taskId);
      accumulator.sessionIds.add(row.sessionId);
      buckets.set(key, accumulator);
    };

    for (const row of rows) {
      const samples = [...(row.tokenUsageSamples ?? [])]
        .filter((sample) => Number.isFinite(Date.parse(sample.observedAt)))
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));

      let previousInput = 0;
      let previousOutput = 0;
      let previousTotal = 0;
      let previousCacheRead = 0;
      let previousCacheCreation = 0;
      for (const sample of samples) {
        const input = Math.max(0, sample.inputTokens - previousInput);
        const output = Math.max(0, sample.outputTokens - previousOutput);
        const total = Math.max(0, sample.totalTokens - previousTotal);
        const cacheRead = Math.max(0, (sample.cacheReadTokens ?? 0) - previousCacheRead);
        const cacheCreation = Math.max(
          0,
          (sample.cacheCreationTokens ?? 0) - previousCacheCreation
        );
        previousInput = Math.max(previousInput, sample.inputTokens);
        previousOutput = Math.max(previousOutput, sample.outputTokens);
        previousTotal = Math.max(previousTotal, sample.totalTokens);
        previousCacheRead = Math.max(previousCacheRead, sample.cacheReadTokens ?? 0);
        previousCacheCreation = Math.max(previousCacheCreation, sample.cacheCreationTokens ?? 0);
        addDelta(row, new Date(sample.observedAt), input, output, total, cacheRead, cacheCreation);
      }

      // Legacy tasks have no samples. Partially sampled tasks can also finish
      // with a small unreported tail; put only that residual in the final bucket.
      const remainingInput = Math.max(0, row.inputTokens - previousInput);
      const remainingOutput = Math.max(0, row.outputTokens - previousOutput);
      const remainingTotal = Math.max(0, row.totalTokens - previousTotal);
      const remainingCacheRead = Math.max(0, row.cacheReadTokens - previousCacheRead);
      const remainingCacheCreation = Math.max(0, row.cacheCreationTokens - previousCacheCreation);
      const fallbackTimestamp = row.completedAt ?? row.createdAt;
      addDelta(
        row,
        fallbackTimestamp,
        remainingInput,
        remainingOutput,
        remainingTotal,
        remainingCacheRead,
        remainingCacheCreation
      );
    }

    const allData: LeaderboardEntry[] = [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucketKey, accumulator]) => ({
        bucket: bucketKey,
        totalTokens: accumulator.total,
        totalInputTokens: accumulator.input,
        totalOutputTokens: accumulator.output,
        totalCacheReadTokens: accumulator.cacheRead,
        totalCacheCreationTokens: accumulator.cacheCreation,
        totalCost: 0,
        taskCount: accumulator.taskIds.size,
        sessionCount: accumulator.sessionIds.size,
        totalDurationMs: 0,
      }));

    return {
      data: allData.slice(offset, offset + limit),
      total: allData.length,
      limit,
      offset,
    };
  }

  /**
   * Find leaderboard entries with filters and sorting
   */
  async find(params?: Params): Promise<LeaderboardResult> {
    const query = (params?.query || {}) as LeaderboardQuery;

    // Extract query params
    const {
      userId,
      userIds: userIdsQuery,
      model,
      models,
      tool,
      tools,
      startDate,
      endDate,
      groupBy = 'user',
      bucket,
      timeSource = 'tasks',
      sortBy = 'cost',
      sortOrder = 'desc',
    } = query;

    const limit = parseIntegerParam(query.limit, 50, { min: 1, max: MAX_LIMIT });
    const offset = parseIntegerParam(query.offset, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });

    if (bucket !== undefined && !VALID_BUCKETS.has(bucket)) {
      throw new Error(
        `Invalid bucket: "${bucket}". Expected one of: 30s, minute, hour, day, week, month.`
      );
    }
    if (timeSource !== 'tasks' && timeSource !== 'samples') {
      throw new Error(`Invalid timeSource: "${String(timeSource)}". Expected tasks or samples.`);
    }

    // Parse groupBy dimensions
    const dims = parseGroupBy(groupBy);
    const includeUser = dims.has('user');
    const includeModel = dims.has('model');
    const includeTool = dims.has('tool');

    if (timeSource === 'samples') {
      if (!bucket) throw new Error('timeSource=samples requires a bucket.');
      if (dims.size > 0) {
        throw new Error('timeSource=samples currently supports groupBy="" only.');
      }
      if (
        normalizeStringFilterValues(model, models).length > 0 ||
        normalizeStringFilterValues(tool, tools).length > 0
      ) {
        throw new Error('timeSource=samples supports user and date filters only.');
      }
      if (sortBy === 'cost') {
        throw new Error('timeSource=samples supports sortBy=tokens only.');
      }
      return this.findSampledTimeline(query, bucket, limit, offset);
    }

    // Build WHERE conditions
    const conditions: SQL[] = [];

    const userFilter = stringFilter(
      taskUsageLedger.user_id,
      normalizeStringFilterValues(userId, userIdsQuery)
    );
    if (userFilter) conditions.push(userFilter);

    const modelFilter = stringFilter(
      taskUsageLedger.model,
      normalizeStringFilterValues(model, models)
    );
    if (modelFilter) conditions.push(modelFilter);

    const toolFilter = stringFilter(
      taskUsageLedger.agentic_tool,
      normalizeStringFilterValues(tool, tools)
    );
    if (toolFilter) conditions.push(toolFilter);

    // Use gte/lte so drizzle encodes the bound via the column's timestamp mapper
    // (integer ms on SQLite, timestamp-with-tz on Postgres). Passing an ISO string
    // through `sql` compared SQLite ms-epoch integers against text and excluded
    // everything.
    if (startDate) {
      const parsed = new Date(startDate);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid startDate: "${startDate}". Expected ISO 8601 format.`);
      }
      conditions.push(gte(taskUsageLedger.task_created_at, parsed));
    }

    if (endDate) {
      const parsed = new Date(endDate);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid endDate: "${endDate}". Expected ISO 8601 format.`);
      }
      conditions.push(lte(taskUsageLedger.task_created_at, parsed));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // biome-ignore lint/suspicious/noExplicitAny: Dynamic SQL fields require any
    const selectFields: Record<string, any> = {
      totalInputTokens: sql<number>`COALESCE(SUM(${taskUsageLedger.input_tokens}), 0)`.as(
        'total_input_tokens'
      ),
      totalOutputTokens: sql<number>`COALESCE(SUM(${taskUsageLedger.output_tokens}), 0)`.as(
        'total_output_tokens'
      ),
      totalTokens: sql<number>`COALESCE(SUM(${taskUsageLedger.total_tokens}), 0)`.as(
        'total_tokens'
      ),
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${taskUsageLedger.cache_read_tokens}), 0)`.as(
        'total_cache_read_tokens'
      ),
      totalCacheCreationTokens:
        sql<number>`COALESCE(SUM(${taskUsageLedger.cache_creation_tokens}), 0)`.as(
          'total_cache_creation_tokens'
        ),
      totalCost: sql<number>`COALESCE(SUM(${taskUsageLedger.cost_usd}), 0.0)`.as('total_cost'),
      taskCount: sql<number>`COUNT(DISTINCT ${taskUsageLedger.task_id})`.as('task_count'),
      sessionCount: sql<number>`COUNT(DISTINCT ${taskUsageLedger.session_id})`.as('session_count'),
      totalDurationMs: sql<number>`COALESCE(SUM(${taskUsageLedger.duration_ms}), 0)`.as(
        'total_duration_ms'
      ),
    };

    if (includeUser) {
      selectFields.userId = taskUsageLedger.user_id;
      selectFields.userName = users.name;
      selectFields.userUsername = users.username;
      selectFields.userEmoji = users.emoji;
      selectFields.userAvatarUrl = sql<string>`MAX(COALESCE(
        ${jsonExtract(this.db, users.data, 'avatar_url')},
        ${jsonExtract(this.db, users.data, 'avatar')}
      ))`.as('user_avatar_url');
    }
    if (includeModel) {
      selectFields.model = taskUsageLedger.model;
    }
    if (includeTool) {
      selectFields.tool = taskUsageLedger.agentic_tool;
    }

    // Bucketing: compute a UTC-truncated ISO timestamp string.
    const bucketExpr = bucket
      ? dateTruncUtc(this.db, taskUsageLedger.task_created_at, bucket)
      : undefined;
    if (bucketExpr) {
      selectFields.bucket = sql<string>`${bucketExpr}`.as('bucket');
    }

    // Build dynamic GROUP BY clause
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic SQL fields require any
    const groupByFields: any[] = [];
    if (includeUser) {
      groupByFields.push(taskUsageLedger.user_id);
      groupByFields.push(users.name);
      groupByFields.push(users.username);
      groupByFields.push(users.emoji);
    }
    if (includeModel) groupByFields.push(taskUsageLedger.model);
    if (includeTool) groupByFields.push(taskUsageLedger.agentic_tool);
    if (bucketExpr) groupByFields.push(sql`${bucketExpr}`);

    // Build sorting. When bucketing, order by bucket ASC first so the caller receives
    // chronologically-ordered time series, then by the requested metric within each bucket.
    const sortField = sortBy === 'tokens' ? sql`total_tokens` : sql`total_cost`;
    const metricOrder = sortOrder === 'desc' ? desc(sortField) : asc(sortField);
    const orderClauses = bucketExpr ? [asc(sql`bucket`), metricOrder] : [metricOrder];

    // Execute aggregation query. Optionally LEFT JOIN users for display info.
    // Cast required: Database is a LibSQL|Postgres union; TypeScript cannot narrow the union
    // for dynamic-field SELECT queries even though both dialects share identical .select() API.
    // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
    let qb = (this.db as any).select(selectFields).from(taskUsageLedger);

    if (includeUser) {
      qb = qb.leftJoin(users, eq(taskUsageLedger.user_id, users.user_id));
    }

    const results = await qb
      .where(whereClause)
      .groupBy(...groupByFields)
      .orderBy(...orderClauses)
      .limit(limit)
      .offset(offset);

    // Build distinct count for pagination. We wrap the aggregation query (without
    // ordering/limits) as a subquery and COUNT its groups. This is exact — no NULL
    // collisions and no dependence on a separator character — and always matches
    // the GROUP BY used for the paginated query above.
    let total: number;
    if (groupByFields.length === 0) {
      // No grouping: the main query returns a single aggregate row.
      total = results.length;
    } else if (offset === 0 && results.length < limit) {
      // If the first page is not full, the data query already proved the exact
      // number of groups. Avoid repeating the same expensive aggregation just to
      // COUNT it; leaderboard metrics extract/cast JSON on every matching task.
      total = results.length;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
      let countInner = (this.db as any).select({ one: sql`1` }).from(taskUsageLedger);

      if (includeUser) {
        countInner = countInner.leftJoin(users, eq(taskUsageLedger.user_id, users.user_id));
      }

      const groupedSubquery = countInner
        .where(whereClause)
        .groupBy(...groupByFields)
        .as('g');

      // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
      const countResult = await (this.db as any)
        .select({ count: sql<number>`COUNT(*)` })
        .from(groupedSubquery);

      total = Number(countResult[0]?.count) || 0;
    }

    // Define result row type based on selected fields
    interface ResultRow {
      userId?: string;
      userName?: string | null;
      userUsername?: string | null;
      userEmoji?: string | null;
      userAvatarUrl?: string | null;
      model?: string | null;
      tool?: string | null;
      bucket?: string | null;
      totalTokens: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCost: number;
      taskCount: number;
      sessionCount: number;
      totalDurationMs: number;
    }

    // Transform results to match our interface
    const data: LeaderboardEntry[] = results.map((row: unknown) => {
      const r = row as ResultRow;
      return {
        ...(includeUser && {
          userId: r.userId as string,
          userName: r.userName || undefined,
          userUsername: r.userUsername || undefined,
          userEmoji: r.userEmoji || undefined,
          userAvatarUrl: r.userAvatarUrl || undefined,
        }),
        ...(includeModel && { model: r.model || undefined }),
        ...(includeTool && { tool: r.tool || undefined }),
        ...(bucketExpr && { bucket: r.bucket || undefined }),
        totalTokens: Number(r.totalTokens) || 0,
        totalInputTokens: Number(r.totalInputTokens) || 0,
        totalOutputTokens: Number(r.totalOutputTokens) || 0,
        totalCacheReadTokens: Number(r.totalCacheReadTokens) || 0,
        totalCacheCreationTokens: Number(r.totalCacheCreationTokens) || 0,
        totalCost: Number(r.totalCost) || 0,
        taskCount: Number(r.taskCount) || 0,
        sessionCount: Number(r.sessionCount) || 0,
        totalDurationMs: Number(r.totalDurationMs) || 0,
      };
    });

    return {
      data,
      total,
      limit,
      offset,
    };
  }

  /**
   * Setup hooks for the service
   */
  async setup(_app: unknown, _path: string): Promise<void> {
    // No setup needed for now
  }
}

/**
 * Service factory function
 */
export function createLeaderboardService(db: TenantScopeAwareDatabase): LeaderboardService {
  return new LeaderboardService(db);
}
