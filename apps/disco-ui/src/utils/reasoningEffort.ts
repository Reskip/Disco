import type { EffortLevel } from '@disco-live/client';

/** Product default: the second-highest level supported by the active tool. */
export function getPreferredReasoningEffort(
  levels: readonly EffortLevel[] | undefined,
  fallback?: EffortLevel
): EffortLevel | undefined {
  if (!levels?.length) return fallback;
  return levels[Math.max(0, levels.length - 2)];
}
