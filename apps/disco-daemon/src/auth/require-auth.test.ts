/** Verifies shared authentication and tenant-resolution composition. */
import type { HookContext } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createRequireAuthHook } from './require-auth';

const multiTenancy = { mode: 'static' as const, static_tenant_id: 'tenant-default' as never };

function ctxWithUser(user: unknown): HookContext {
  return { params: { provider: 'rest', user } } as unknown as HookContext;
}

describe('createRequireAuthHook composition', () => {
  it('passes a normal authenticated user through and resolves the tenant', async () => {
    const authenticatedHook = vi.fn(async (ctx: HookContext) => ctx);
    const requireAuth = createRequireAuthHook(authenticatedHook, multiTenancy);

    const result = await requireAuth(ctxWithUser({ user_id: 'u1', role: 'member' }));
    expect((result.params as { tenant?: { tenant_id: string } }).tenant?.tenant_id).toBe(
      'tenant-default'
    );
  });

  it('passes a full service account through', async () => {
    const authenticatedHook = vi.fn(async (ctx: HookContext) => ctx);
    const requireAuth = createRequireAuthHook(authenticatedHook, multiTenancy);

    await expect(
      requireAuth(
        ctxWithUser({ user_id: 'executor-service', role: 'service', _isServiceAccount: true })
      )
    ).resolves.toBeDefined();
  });
});
