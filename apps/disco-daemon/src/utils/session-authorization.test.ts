import { describe, expect, it, vi } from 'vitest';
import { assertSessionOwnedByActor, ensureCanPromptTargetSession } from './session-authorization.js';

function session(createdBy: string) {
  return {
    session_id: 'session-1',
    created_by: createdBy,
  } as import('@disco/core/types').Session;
}

describe('direct Session authorization', () => {
  it('allows the creating user', () => {
    expect(() => assertSessionOwnedByActor({ user_id: 'user-1' }, session('user-1'))).not.toThrow();
  });

  it('rejects a different Disco user even when the actor is otherwise authenticated', () => {
    expect(() => assertSessionOwnedByActor({ user_id: 'user-2' }, session('user-1'))).toThrow(
      /owned by another Disco user/
    );
  });

  it('requires authentication', () => {
    expect(() => assertSessionOwnedByActor(undefined, session('user-1'))).toThrow(
      /Authentication required/
    );
  });

  it('loads callback targets internally and enforces direct ownership', async () => {
    const get = vi.fn(async () => session('user-1'));
    const app = { service: () => ({ get }) };

    await expect(ensureCanPromptTargetSession('session-1', 'user-1', app)).resolves.toMatchObject({
      session_id: 'session-1',
    });
    expect(get).toHaveBeenCalledWith('session-1', { provider: undefined });

    await expect(ensureCanPromptTargetSession('session-1', 'user-2', app)).rejects.toThrow(
      /owned by another Disco user/
    );
  });

  it('does not reveal whether an inaccessible callback target exists', async () => {
    const app = {
      service: () => ({
        get: vi.fn(async () => {
          throw new Error('missing');
        }),
      }),
    };

    await expect(ensureCanPromptTargetSession('missing-session', 'user-1', app)).rejects.toThrow(
      /Invalid callback target/
    );
  });
});
