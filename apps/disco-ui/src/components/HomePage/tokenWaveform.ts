interface WavePoint {
  x: number;
  y: number;
  value: number;
}

export function findTokenWaveformHoverIndex(points: WavePoint[], x: number, tolerance = 0) {
  if (points.length === 0) return null;
  if (points.length === 1) return 0;
  const step = points[1].x - points[0].x;
  const nearest = Math.max(0, Math.min(points.length - 1, Math.round((x - points[0].x) / step)));
  if (points[nearest].value > 0 || tolerance <= 0) return nearest;
  // In the daily view multiple samples share a screen pixel. Snap only within
  // that pixel to a measured peak, and keep its actual timestamp and value.
  const radius = Math.ceil(tolerance / step);
  let selected = nearest;
  let distance = tolerance;
  for (
    let index = Math.max(0, nearest - radius);
    index <= Math.min(points.length - 1, nearest + radius);
    index += 1
  ) {
    const candidateDistance = Math.abs(points[index].x - x);
    if (points[index].value > 0 && candidateDistance <= distance) {
      selected = index;
      distance = candidateDistance;
    }
  }
  return selected;
}

/** Round the line inside active buckets without moving usage into idle time. */
export function buildTokenWaveform(
  values: number[],
  width: number,
  height: number,
  padding: number
) {
  const maximum = Math.max(1, ...values);
  const bottom = height - padding;
  const right = width - padding;
  const bucketWidth = (width - padding * 2) / Math.max(1, values.length);
  const points: WavePoint[] = values.map((value, index) => ({
    x: padding + (index + 0.5) * bucketWidth,
    // A linear scale preserves the shape of a burst instead of lifting small values into a plateau.
    y: bottom - (value / maximum) * (height - padding * 2),
    value,
  }));
  if (points.length === 0) return { points, path: '', area: '' };

  let path = `M ${padding} ${points[0].value > 0 ? points[0].y : bottom}`;
  let index = 0;
  while (index < points.length) {
    if (points[index].value <= 0) {
      index += 1;
      continue;
    }
    const first = index;
    while (index + 1 < points.length && points[index + 1].value > 0) index += 1;
    const last = index;
    const start = {
      x: padding + first * bucketWidth,
      y: first === 0 ? points[first].y : bottom,
    };
    const end = {
      x: padding + (last + 1) * bucketWidth,
      y: last === points.length - 1 ? points[last].y : bottom,
    };
    // Zero-valued buckets are horizontal for their full duration. Ramps begin
    // and end at the active run's boundaries, never at neighboring idle centers.
    if (first > 0) path += ` L ${start.x} ${bottom}`;
    const run = [start, ...points.slice(first, last + 1), end];
    const slopes = run.slice(1).map((point, position) => {
      const previous = run[position];
      return (point.y - previous.y) / (point.x - previous.x);
    });
    const tangents = run.map((_, position) => {
      if (position === 0 || position === run.length - 1) return 0;
      const before = slopes[position - 1];
      const after = slopes[position];
      return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
    });
    for (let position = 1; position < run.length; position += 1) {
      const previous = run[position - 1];
      const point = run[position];
      const controlOffset = (point.x - previous.x) / 3;
      path += ` C ${previous.x + controlOffset} ${previous.y + tangents[position - 1] * controlOffset}, ${point.x - controlOffset} ${point.y - tangents[position] * controlOffset}, ${point.x} ${point.y}`;
    }
    index += 1;
  }
  if (points[points.length - 1].value <= 0) path += ` L ${right} ${bottom}`;
  return {
    points,
    path,
    area: `${path} L ${right} ${bottom} L ${padding} ${bottom} Z`,
  };
}
