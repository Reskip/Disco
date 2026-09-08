import type { LeaderboardEntry } from '@disco-live/client';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRankingFlipAnimation } from './HomeTokenUsageCard';

function entry(userId: string): LeaderboardEntry {
  return {
    userId,
    userName: userId,
    totalTokens: 1,
    totalInputTokens: 1,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCost: 0,
    taskCount: 0,
    sessionCount: 0,
    totalDurationMs: 0,
  };
}

function Harness({ ids, range }: { ids: string[]; range: 'today' | 'week' | 'all' }) {
  const entries = ids.map(entry);
  const setElement = useRankingFlipAnimation(entries, range);
  return (
    <div>
      {ids.map(id => (
        <div
          key={id}
          data-testid={`row-${id}`}
          ref={element => {
            setElement(id, element);
          }}
        >
          {id}
        </div>
      ))}
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('user ranking FLIP animation', () => {
  it('animates stable rows from their old position after the range reorders them', () => {
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const index = this.dataset.testid?.startsWith('row-')
        ? [...(this.parentElement?.children ?? [])].indexOf(this)
        : 0;
      return DOMRect.fromRect({ y: index * 40, height: 34, width: 200 });
    });

    try {
      const view = render(<Harness ids={['alice', 'bob', 'carol']} range="today" />);
      animate.mockClear();

      view.rerender(<Harness ids={['carol', 'alice', 'bob']} range="week" />);

      expect(animate).toHaveBeenCalledTimes(3);
      expect(animate.mock.calls.map(call => call[0])).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ transform: 'translateY(80px)' }),
          ]),
          expect.arrayContaining([
            expect.objectContaining({ transform: 'translateY(-40px)' }),
          ]),
        ])
      );

      animate.mockClear();
      view.rerender(<Harness ids={['carol', 'alice', 'bob']} range="all" />);
      expect(animate).not.toHaveBeenCalled();
    } finally {
      if (originalAnimate) {
        Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'animate');
      }
    }
  });

  it('does not animate an unchanged ranking after the page scrolls', () => {
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    let viewportScroll = 0;
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const index = this.dataset.testid?.startsWith('row-')
        ? [...(this.parentElement?.children ?? [])].indexOf(this)
        : 0;
      return DOMRect.fromRect({ y: index * 40 - viewportScroll, height: 34, width: 200 });
    });

    try {
      const view = render(<Harness ids={['alice', 'bob', 'carol']} range="today" />);
      animate.mockClear();

      viewportScroll = 160;
      view.rerender(<Harness ids={['alice', 'bob', 'carol']} range="week" />);

      expect(animate).not.toHaveBeenCalled();
    } finally {
      if (originalAnimate) {
        Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'animate');
      }
    }
  });

  it('animates only rows whose rank actually changes', () => {
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const index = this.dataset.testid?.startsWith('row-')
        ? [...(this.parentElement?.children ?? [])].indexOf(this)
        : 0;
      return DOMRect.fromRect({ y: index * 40, height: 34, width: 200 });
    });

    try {
      const view = render(<Harness ids={['alice', 'bob', 'carol']} range="today" />);
      animate.mockClear();

      view.rerender(<Harness ids={['alice', 'carol', 'bob']} range="week" />);

      expect(animate).toHaveBeenCalledTimes(2);
    } finally {
      if (originalAnimate) {
        Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'animate');
      }
    }
  });
});
