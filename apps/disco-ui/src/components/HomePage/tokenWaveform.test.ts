import { describe, expect, it } from 'vitest';
import { buildTokenWaveform } from './tokenWaveform';

describe('token waveform geometry', () => {
  it('keeps empty, zero and single-value series finite', () => {
    expect(buildTokenWaveform([], 520, 132, 10)).toEqual({ points: [], path: '', area: '' });
    const zero = buildTokenWaveform([0, 0, 0], 520, 132, 10);
    expect(zero.points.every((point) => point.y === 122)).toBe(true);
    expect(buildTokenWaveform([5], 520, 132, 10).path).toBe('M 10 10');
    expect(zero.path).not.toMatch(/NaN|Infinity/);
  });

  it('keeps height proportional to usage without changing the supplied values', () => {
    const values = [0, 1, 10, 100];
    const { points } = buildTokenWaveform(values, 520, 132, 10);
    expect(points.map((point) => point.value)).toEqual(values);
    expect((122 - points[2].y) / (122 - points[3].y)).toBeCloseTo(0.1);
    expect(points[0].x).toBe(10);
    expect(points[3].x).toBe(510);
  });

  it('keeps every segment within its adjacent values and preserves zero gaps', () => {
    const { points, path } = buildTokenWaveform(
      [0, 2, 50, 200, 5, 0, 0, 900, 60, 10, 0],
      520,
      132,
      10
    );
    const segments = path.split(' C ').slice(1);
    for (const [index, segment] of segments.entries()) {
      const numbers = segment.split(/[ ,]+/).map(Number);
      const start = points[index];
      const end = points[index + 1];
      let previousY = start.y;
      for (let step = 1; step <= 20; step += 1) {
        const t = step / 20;
        const y =
          (1 - t) ** 3 * start.y +
          3 * (1 - t) ** 2 * t * numbers[1] +
          3 * (1 - t) * t ** 2 * numbers[3] +
          t ** 3 * end.y;
        expect(y).toBeGreaterThanOrEqual(Math.min(start.y, end.y) - 1e-9);
        expect(y).toBeLessThanOrEqual(Math.max(start.y, end.y) + 1e-9);
        expect((y - previousY) * (end.y - start.y)).toBeGreaterThanOrEqual(-1e-9);
        previousY = y;
      }
    }
  });

  it('shares a nonzero tangent between rising samples instead of flattening each join', () => {
    const { points, path } = buildTokenWaveform([0, 2, 5, 12, 20], 520, 132, 10);
    const segments = path
      .split(' C ')
      .slice(1)
      .map((segment) => segment.split(/[ ,]+/).map(Number));
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index];
      const incoming = segments[index - 1];
      const outgoing = segments[index];
      const before = (point.y - incoming[3]) / (point.x - incoming[2]);
      const after = (outgoing[1] - point.y) / (outgoing[0] - point.x);
      expect(before).toBeCloseTo(after, 10);
      expect(before).toBeLessThan(0);
    }
  });
});
