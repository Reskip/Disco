import { describe, expect, it } from 'vitest';
import {
  codexSubscriptionAuthUserMessage,
  isCodexSubscriptionAuthError,
} from './provider-auth-error.js';

describe('Codex subscription auth errors', () => {
  it.each([
    'Your access token could not be refreshed. Please log out and sign in again.',
    'refresh token expired',
    'Refresh token was already used',
    { message: 'invalid_grant: token revoked' },
  ])('recognizes an unusable subscription login', (value) => {
    expect(isCodexSubscriptionAuthError(value)).toBe(true);
  });

  it.each([
    'Selected model is at capacity',
    '401 Unauthorized',
    'stream disconnected before completion',
  ])('does not misclassify %s', (value) => {
    expect(isCodexSubscriptionAuthError(value)).toBe(false);
  });

  it('explains that Disco and Codex logins are separate', () => {
    const message = codexSubscriptionAuthUserMessage();
    expect(message).toContain('Disco 网页登录仍然有效');
    expect(message).toContain('退出再登录 Disco 无法刷新 Codex 登录');
  });
});
