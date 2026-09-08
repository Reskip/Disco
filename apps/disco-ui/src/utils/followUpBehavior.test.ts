import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLLOW_UP_BEHAVIOR_CHANGED_EVENT,
  getFollowUpBehavior,
  saveFollowUpBehavior,
} from './followUpBehavior';

describe('follow-up behavior preference', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to steering and stays isolated per user', () => {
    const listener = vi.fn();
    window.addEventListener(FOLLOW_UP_BEHAVIOR_CHANGED_EVENT, listener);
    expect(getFollowUpBehavior('user-a')).toBe('steer');
    expect(saveFollowUpBehavior('user-a', 'queue')).toBe('queue');
    expect(getFollowUpBehavior('user-a')).toBe('queue');
    expect(getFollowUpBehavior('user-b')).toBe('steer');
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(FOLLOW_UP_BEHAVIOR_CHANGED_EVENT, listener);
  });
});
