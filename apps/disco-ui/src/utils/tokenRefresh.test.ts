import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_KEY,
  clearTokens,
  FEATHERS_ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
} from './tokenRefresh';

describe('clearTokens', () => {
  beforeEach(() => localStorage.clear());

  it('removes Disco and Feathers token copies on logout', () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh');
    localStorage.setItem(FEATHERS_ACCESS_TOKEN_KEY, 'stale-feathers-access');

    clearTokens();

    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(FEATHERS_ACCESS_TOKEN_KEY)).toBeNull();
  });
});
