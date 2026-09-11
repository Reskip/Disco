import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_GREETINGS } from './homeGreetings';
import {
  formatHomeGreeting,
  getLocalCalendarDay,
  selectDailyHomeGreeting,
  useDailyHomeGreeting,
} from './useDailyHomeGreeting';

describe('daily home copy', () => {
  it('contains exactly 300 distinct, complete pairs with only the name placeholder', () => {
    expect(HOME_GREETINGS).toHaveLength(300);
    expect(new Set(HOME_GREETINGS.map(([title]) => title)).size).toBe(300);
    expect(new Set(HOME_GREETINGS.map(([, subtitle]) => subtitle)).size).toBe(300);
    for (const pair of HOME_GREETINGS) {
      for (const text of pair) {
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toMatch(/reskip|reski|undefined/i);
        expect(text.replaceAll('{name}', '')).not.toMatch(/[{}]/);
      }
    }
  });

  it('keeps each user stable for the local date and visits every pair before repeating', () => {
    const firstDay = getLocalCalendarDay(new Date(2026, 8, 11));
    const sequences = ['account-a', 'account-b'].map((userId) =>
      Array.from({ length: 300 }, (_, offset) => selectDailyHomeGreeting(userId, firstDay + offset))
    );
    for (const sequence of sequences) expect(new Set(sequence).size).toBe(300);
    expect(sequences[0]).not.toEqual(sequences[1]);
    expect(selectDailyHomeGreeting('account-a', firstDay)).toBe(sequences[0][0]);
    expect(selectDailyHomeGreeting('account-a', firstDay + 300)).toBe(sequences[0][0]);
    expect(selectDailyHomeGreeting('account-a', firstDay + 299)).not.toBe(sequences[0][0]);
    expect(getLocalCalendarDay(new Date(2026, 8, 11, 23, 59, 59))).toBe(firstDay);
    expect(getLocalCalendarDay(new Date(2026, 8, 12))).toBe(firstDay + 1);
    expect(getLocalCalendarDay(new Date(2027, 0, 1))).toBe(
      getLocalCalendarDay(new Date(2026, 11, 31)) + 1
    );
  });

  it('advances by one calendar day through spring and autumn daylight-saving boundaries', () => {
    expect(
      getLocalCalendarDay(new Date(2026, 2, 9)) - getLocalCalendarDay(new Date(2026, 2, 8))
    ).toBe(1);
    expect(
      getLocalCalendarDay(new Date(2026, 10, 2)) - getLocalCalendarDay(new Date(2026, 10, 1))
    ).toBe(1);
  });

  it('substitutes names literally in both lines without mutating the shared library', () => {
    const template = ['你好，{name}！{name}', '{name}，来聊聊。'] as const;
    expect(formatHomeGreeting(template, '$&<星河>')).toEqual([
      '你好，$&<星河>！$&<星河>',
      '$&<星河>，来聊聊。',
    ]);
    expect(formatHomeGreeting(template, '山海')[0]).toBe('你好，山海！山海');
    expect(template[0]).toBe('你好，{name}！{name}');
  });
});

describe('daily home greeting lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 11, 12));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the pair through rerenders and remounts, and refreshes at local midnight', () => {
    vi.setSystemTime(new Date(2026, 8, 11, 23, 59, 59));
    const { result, rerender, unmount } = renderHook(() => useDailyHomeGreeting('user-a', '星河'));
    const initial = result.current;
    rerender();
    expect(result.current).toEqual(initial);
    unmount();
    const restored = renderHook(() => useDailyHomeGreeting('user-a', '星河'));
    expect(restored.result.current).toEqual(initial);
    act(() => vi.advanceTimersByTime(1000));
    expect(restored.result.current).not.toEqual(initial);
    expect(restored.result.current).toEqual(
      formatHomeGreeting(selectDailyHomeGreeting('user-a', getLocalCalendarDay()), '星河')
    );
  });

  it('catches up after sleep when focus or visibility returns', () => {
    const { result } = renderHook(() => useDailyHomeGreeting('user-a', '星河'));
    const initial = result.current;
    act(() => {
      vi.setSystemTime(new Date(2026, 8, 13, 9));
      window.dispatchEvent(new Event('focus'));
    });
    expect(result.current).not.toEqual(initial);
    const focused = result.current;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => {
      vi.setSystemTime(new Date(2026, 8, 14, 9));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).not.toEqual(focused);
  });

  it('uses the current account and display name immediately, including profile edits', () => {
    const day = getLocalCalendarDay();
    const userId = Array.from({ length: 100 }, (_, index) => `named-user-${index}`).find((id) =>
      selectDailyHomeGreeting(id, day)[0].includes('{name}')
    );
    expect(userId).toBeDefined();
    const { result, rerender } = renderHook(({ id, name }) => useDailyHomeGreeting(id, name), {
      initialProps: { id: userId!, name: '星河' },
    });
    const initialTitle = result.current[0];
    expect(initialTitle).toContain('星河');
    rerender({ id: userId!, name: '山海' });
    expect(result.current[0]).toBe(initialTitle.replace('星河', '山海'));
    rerender({ id: 'another-account', name: '新用户' });
    expect(result.current).toEqual(
      formatHomeGreeting(selectDailyHomeGreeting('another-account', day), '新用户')
    );
    expect(result.current.join('')).not.toContain('星河');
    expect(result.current.join('')).not.toContain('山海');
  });

  it('removes its timer and listeners when leaving the home page', () => {
    const { unmount } = renderHook(() => useDailyHomeGreeting('user-a', '星河'));
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
