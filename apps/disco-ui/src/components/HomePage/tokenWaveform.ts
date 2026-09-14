interface WavePoint {
  x: number;
  y: number;
  value: number;
}

/** Connect the measured points smoothly without adding peaks or dipping below zero. */
export function buildTokenWaveform(
  values: number[],
  width: number,
  height: number,
  padding: number
) {
  const maximum = Math.max(1, ...values);
  const bottom = height - padding;
  const points: WavePoint[] = values.map((value, index) => ({
    x: padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2),
    // A linear scale preserves the shape of a burst instead of lifting small values into a plateau.
    y: bottom - (value / maximum) * (height - padding * 2),
    value,
  }));
  if (points.length === 0) return { points, path: '', area: '' };

  const slopes = points.slice(1).map((point, index) => {
    const previous = points[index];
    return (point.y - previous.y) / (point.x - previous.x);
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0;
    if (index === points.length - 1) return slopes[index - 1];
    const before = slopes[index - 1];
    const after = slopes[index];
    // The harmonic mean keeps the shared slope bounded; only real extrema have a flat tangent.
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const controlOffset = (point.x - previous.x) / 3;
    path += ` C ${previous.x + controlOffset} ${previous.y + tangents[index - 1] * controlOffset}, ${point.x - controlOffset} ${point.y - tangents[index] * controlOffset}, ${point.x} ${point.y}`;
  }
  const last = points[points.length - 1];
  return {
    points,
    path,
    area: `${path} L ${last.x} ${bottom} L ${points[0].x} ${bottom} Z`,
  };
}
