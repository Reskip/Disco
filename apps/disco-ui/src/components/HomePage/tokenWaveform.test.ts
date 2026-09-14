import { describe, expect, it } from 'vitest';
import { buildTokenWaveform, findTokenWaveformHoverIndex } from './tokenWaveform';

function samplePath(path: string) {
  let previous = { x: 0, y: 0 };
  const samples: Array<{ x: number; y: number }> = [];
  for (const match of path.matchAll(/([MLC])\s+([^MLC]+)/g)) {
    const coordinates = match[2].trim().split(/[ ,]+/).map(Number);
    if (match[1] === 'M') {
      previous = { x: coordinates[0], y: coordinates[1] };
      samples.push(previous);
      continue;
    }
    const end = { x: coordinates.at(-2) ?? 0, y: coordinates.at(-1) ?? 0 };
    for (let step = 1; step <= 40; step += 1) {
      const t = step / 40;
      const point =
        match[1] === 'L'
          ? {
              x: previous.x + (end.x - previous.x) * t,
              y: previous.y + (end.y - previous.y) * t,
            }
          : {
              x:
                (1 - t) ** 3 * previous.x +
                3 * (1 - t) ** 2 * t * coordinates[0] +
                3 * (1 - t) * t ** 2 * coordinates[2] +
                t ** 3 * end.x,
              y:
                (1 - t) ** 3 * previous.y +
                3 * (1 - t) ** 2 * t * coordinates[1] +
                3 * (1 - t) * t ** 2 * coordinates[3] +
                t ** 3 * end.y,
            };
      samples.push(point);
    }
    previous = end;
  }
  return samples;
}

describe('token waveform geometry', () => {
  it('makes a subpixel daily peak selectable without snapping across an idle interval', () => {
    const values = Array<number>(2880).fill(0);
    values[1000] = 300;
    const { points } = buildTokenWaveform(values, 520, 132, 10);
    expect(findTokenWaveformHoverIndex(points, points[1000].x + 0.5, 1)).toBe(1000);
    expect(findTokenWaveformHoverIndex(points, points[1020].x, 1)).toBe(1020);
    expect(findTokenWaveformHoverIndex([], 0, 1)).toBeNull();
  });
  it('keeps empty, zero, single-value and constant series finite', () => {
    expect(buildTokenWaveform([], 520, 132, 10)).toEqual({
      points: [],
      path: '',
      area: '',
    });
    for (const values of [[0, 0, 0], [5], [5, 5, 5]]) {
      const result = buildTokenWaveform(values, 520, 132, 10);
      expect(result.path).not.toMatch(/NaN|Infinity/);
      for (const sample of samplePath(result.path))
        expect(sample.y).toBeCloseTo(values[0] === 0 ? 122 : 10);
    }
  });

  it('keeps raw values and their bucket centers for hover and peak heights', () => {
    const values = [0, 1, 10, 100];
    const { points, path } = buildTokenWaveform(values, 520, 132, 10);
    expect(points.map((point) => point.value)).toEqual(values);
    expect((122 - points[2].y) / (122 - points[3].y)).toBeCloseTo(0.1);
    expect(points[0].x).toBe(72.5);
    expect(points[3].x).toBe(447.5);
    const samples = samplePath(path);
    for (const point of points.filter((point) => point.value > 0)) {
      expect(
        samples.some(
          (sample) => Math.abs(sample.x - point.x) < 1e-8 && Math.abs(sample.y - point.y) < 1e-8
        )
      ).toBe(true);
    }
  });

  it.each([120, 2880])('never draws activity in a zero bucket at %i-sample resolution', (count) => {
    const values = Array<number>(count).fill(0);
    values[20] = 120;
    values[21] = 300;
    values[23] = 450;
    values[count - 2] = 90;
    const { path } = buildTokenWaveform(values, 520, 132, 10);
    const bucketWidth = 500 / count;
    let activeSamples = 0;
    for (const sample of samplePath(path)) {
      expect(sample.y).toBeGreaterThanOrEqual(10 - 1e-8);
      expect(sample.y).toBeLessThanOrEqual(122 + 1e-8);
      if (sample.y < 122 - 1e-8) {
        const index = Math.max(0, Math.min(count - 1, Math.floor((sample.x - 10) / bucketWidth)));
        expect(values[index]).toBeGreaterThan(0);
        activeSamples += 1;
      }
    }
    expect(activeSamples).toBeGreaterThan(0);
  });

  it('rounds a short peak and meets its idle boundaries with horizontal tangents', () => {
    const { path } = buildTokenWaveform([0, 200, 0], 520, 132, 10);
    const curves = Array.from(path.matchAll(/C\s+([^MLC]+)/g), (match) =>
      match[1].trim().split(/[ ,]+/).map(Number)
    );
    expect(curves).toHaveLength(2);
    expect(curves[0][1]).toBe(122);
    expect(curves[0][3]).toBe(10);
    expect(curves[1][1]).toBe(10);
    expect(curves[1][3]).toBe(122);
    expect(curves[1][5]).toBe(122);
  });
});
