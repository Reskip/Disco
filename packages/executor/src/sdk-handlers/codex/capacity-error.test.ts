import { describe, expect, it } from 'vitest';
import { codexCapacityUserMessage, isCodexCapacityError } from './capacity-error.js';

describe('Codex transient capacity classification', () => {
  it.each([
    'Selected model is at capacity. Please try a different model.',
    'The model is currently overloaded',
    'rate_limit_exceeded',
    'HTTP 429 Too Many Requests',
    '503 Service Unavailable',
    { error: { message: 'Bad gateway' } },
  ])('retries transient provider failures: %j', value => {
    expect(isCodexCapacityError(value)).toBe(true);
  });

  it.each([
    '401 Unauthorized',
    '403 Forbidden',
    'invalid_request_error: unknown model',
    'permission denied',
    'tool execution failed',
  ])('does not retry permanent or local failures: %s', value => {
    expect(isCodexCapacityError(value)).toBe(false);
  });

  it('returns a localized final failure without exposing the raw provider error', () => {
    const message = codexCapacityUserMessage();
    expect(message).toContain('自动重试');
    expect(message).not.toContain('Selected model is at capacity');
  });
});
