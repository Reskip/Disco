/** Public projection of the shared host account's primary weekly quota. */
export type CodexWeeklyQuota =
  | { status: 'ready'; remainingPercent: number; resetsAt: string | null }
  | { status: 'unavailable'; remainingPercent: null; resetsAt: null };
