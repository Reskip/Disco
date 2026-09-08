/**
 * Usage analytics DTOs shared by the daemon, browser client, and UI.
 *
 * Analytics are tenant-scoped by the daemon's request database context. The
 * optional `user` dimension is an in-tenant breakdown, not a tenant boundary.
 */

export type LeaderboardDimension = 'user' | 'model' | 'tool';

export type LeaderboardStringFilter = string | string[];

export interface LeaderboardQuery {
  userId?: LeaderboardStringFilter;
  userIds?: LeaderboardStringFilter;
  model?: LeaderboardStringFilter;
  models?: LeaderboardStringFilter;
  tool?: LeaderboardStringFilter;
  tools?: LeaderboardStringFilter;
  startDate?: string;
  endDate?: string;
  groupBy?: string;
  bucket?: '30s' | 'minute' | 'hour' | 'day' | 'week' | 'month';
  /** Use task-cumulative rollout checkpoints instead of task creation time. */
  timeSource?: 'tasks' | 'samples';
  sortBy?: 'tokens' | 'cost';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface LeaderboardEntry {
  userId?: string;
  userName?: string;
  userUsername?: string;
  userEmoji?: string;
  userAvatarUrl?: string;
  model?: string;
  tool?: string;
  bucket?: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Cached input tokens reused from a provider prompt cache. */
  totalCacheReadTokens: number;
  /** Input tokens written into a provider prompt cache, when reported separately. */
  totalCacheCreationTokens: number;
  totalCost: number;
  taskCount: number;
  sessionCount: number;
  totalDurationMs: number;
}

export interface LeaderboardResult {
  data: LeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
}
