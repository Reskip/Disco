import type { EffortLevel } from '@disco-live/client';
import { describe, expect, it } from 'vitest';
import { getPreferredReasoningEffort } from './reasoningEffort';

describe('getPreferredReasoningEffort', () => {
  it('selects the second-highest supported level', () => {
    const levels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(getPreferredReasoningEffort(levels)).toBe('xhigh');
    expect(getPreferredReasoningEffort(['low', 'medium', 'high'])).toBe('medium');
  });
});
