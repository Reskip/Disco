/** Format token counts with stable K/M/B suffixes while keeping small values exact. */
export function formatTokenCount(value: number, maximumFractionDigits = 1): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ] as const;

  const unit = units.find(({ threshold }) => safeValue >= threshold);
  if (!unit) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(safeValue);

  const scaled = safeValue / unit.threshold;
  const digits =
    scaled >= 100 ? 0 : scaled >= 10 ? Math.min(1, maximumFractionDigits) : maximumFractionDigits;
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(scaled)}${unit.suffix}`;
}
