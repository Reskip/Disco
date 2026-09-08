export type FollowUpBehavior = 'steer' | 'queue';

const STORAGE_PREFIX = 'disco:follow-up-behavior';
export const FOLLOW_UP_BEHAVIOR_CHANGED_EVENT = 'disco:follow-up-behavior-changed';

function storageKey(userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}:${userId || 'anonymous'}`;
}

export function getFollowUpBehavior(userId: string | null | undefined): FollowUpBehavior {
  return localStorage.getItem(storageKey(userId)) === 'queue' ? 'queue' : 'steer';
}

export function saveFollowUpBehavior(
  userId: string | null | undefined,
  behavior: FollowUpBehavior
): FollowUpBehavior {
  localStorage.setItem(storageKey(userId), behavior);
  window.dispatchEvent(
    new CustomEvent(FOLLOW_UP_BEHAVIOR_CHANGED_EVENT, {
      detail: { userId: userId || null, behavior },
    })
  );
  return behavior;
}

