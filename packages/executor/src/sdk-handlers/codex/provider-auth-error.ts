const SUBSCRIPTION_AUTH_PATTERNS = [
  /your access token could not be refreshed/i,
  /refresh token[^\n]*(?:expired|invalid|revoked|already used|reuse)/i,
  /invalid[_ -]?grant/i,
] as const;

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** True when Codex's ChatGPT subscription credential can no longer refresh. */
export function isCodexSubscriptionAuthError(value: unknown): boolean {
  const message = errorText(value);
  return SUBSCRIPTION_AUTH_PATTERNS.some((pattern) => pattern.test(message));
}

export function codexSubscriptionAuthUserMessage(): string {
  return 'Codex 登录已失效，Disco 网页登录仍然有效。请在“设置 → Codex 连接”重新连接后重试；退出再登录 Disco 无法刷新 Codex 登录。';
}
