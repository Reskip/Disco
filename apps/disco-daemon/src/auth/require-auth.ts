/**
 * The shared `requireAuth` hook factory — the single REST/Feathers auth
 * chokepoint. Composes the authentication strategy hook with tenant
 * resolution so every authenticated service uses the same tenant boundary.
 */

import {
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@disco/core/config';
import { NotAuthenticated } from '@disco/core/feathers';
import type { HookContext } from '@disco/core/types';

export type AuthHook = (context: HookContext) => Promise<HookContext>;

export function createRequireAuthHook(
  authenticatedHook: AuthHook,
  multiTenancy: ResolvedMultiTenancyConfig
): AuthHook {
  return async (context: HookContext): Promise<HookContext> => {
    const authed = await authenticatedHook(context);
    try {
      authed.params.tenant = resolveTenantContext(multiTenancy, { params: authed.params });
      return authed;
    } catch (error) {
      if (error instanceof TenantResolutionError) {
        throw new NotAuthenticated(error.message);
      }
      throw error;
    }
  };
}
