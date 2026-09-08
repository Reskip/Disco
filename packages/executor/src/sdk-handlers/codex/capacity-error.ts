const CAPACITY_PATTERNS = [
  /selected model is at capacity/i,
  /model (?:is )?(?:currently )?(?:at capacity|overloaded)/i,
  /rate[_ -]?limit(?:ed| exceeded)?/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /(?:^|\D)429(?:\D|$)/,
  /(?:http(?: status)?\s*)?50[234](?:\D|$)/i,
  /所选模型当前繁忙/u,
  /远端模型服务持续繁忙/u,
];

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isCodexCapacityError(value: unknown): boolean {
  const message = errorText(value);
  return CAPACITY_PATTERNS.some((pattern) => pattern.test(message));
}

export function codexCapacityUserMessage(): string {
  return '远端模型服务持续繁忙，Disco 已完成自动重试但仍未恢复。请立即重试，或切换其他模型。';
}
