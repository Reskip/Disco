import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { BROWSER_ACCESS_TOKEN_TTL, BROWSER_REFRESH_TOKEN_TTL } from './browser-token-ttl.js';
import { issueRuntimeTokenPair } from './runtime-tokens.js';

describe('browser token lifetimes', () => {
  it('issues a one-hour access token and a thirty-day refresh token', () => {
    const pair = issueRuntimeTokenPair(
      { user_id: 'user-1' },
      'test-secret',
      BROWSER_ACCESS_TOKEN_TTL,
      BROWSER_REFRESH_TOKEN_TTL
    );

    const access = jwt.decode(pair.accessToken) as jwt.JwtPayload;
    const refresh = jwt.decode(pair.refreshToken) as jwt.JwtPayload;

    expect((access.exp ?? 0) - (access.iat ?? 0)).toBe(60 * 60);
    expect((refresh.exp ?? 0) - (refresh.iat ?? 0)).toBe(30 * 24 * 60 * 60);
  });
});
