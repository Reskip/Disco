import { describe, expect, it } from 'vitest';
import { formatTokenCount } from './formatTokenCount';

describe('formatTokenCount', () => {
  it('uses K/M/B suffixes and trims unnecessary zeroes', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1_000)).toBe('1K');
    expect(formatTokenCount(54_302)).toBe('54.3K');
    expect(formatTokenCount(238_416)).toBe('238K');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
    expect(formatTokenCount(2_000_000_000)).toBe('2B');
  });

  it('renders invalid or negative input safely', () => {
    expect(formatTokenCount(Number.NaN)).toBe('0');
    expect(formatTokenCount(-12)).toBe('0');
  });
});
