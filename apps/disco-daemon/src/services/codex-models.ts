import {
  createUserProcessEnvironment,
  isTenantAgenticToolEnabled,
  resolveApiKey,
  stripProviderCredentialEnvironment,
} from '@disco/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@disco/core/db';
import { BadRequest, NotAuthenticated } from '@disco/core/feathers';
import { fallbackCodexModelCatalog } from '@disco/core/models';
import type { AuthenticatedParams, CodexModelCatalog, UserID } from '@disco/core/types';
import { runExecutorCommand } from '../utils/spawn-executor.js';
import {
  type AppLike,
  resolveCodexCredentialRoute,
  usesServerSharedCodexAuth,
} from './codex-auth-shared.js';

/** No server-wide catalog cache: identity, login and provider changes take effect on the next read. */
export function createCodexModelsService(app: AppLike, db: TenantScopeAwareDatabase) {
  return {
    async find(params?: AuthenticatedParams): Promise<CodexModelCatalog> {
      const userId = params?.user?.user_id as UserID | undefined;
      if (!userId) throw new NotAuthenticated('请先登录。');
      const tenantId = getCurrentTenantId();
      if (!tenantId) throw new Error('Missing tenant context for Codex models');
      const withDb = <T>(work: (db: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);
      if (!(await withDb((db) => isTenantAgenticToolEnabled('codex', db))))
        throw new BadRequest('Codex is disabled for this workspace');
      const config = app.get('config');
      const route = await resolveCodexCredentialRoute(userId, withDb, config);
      if (!route.ok) return fallbackCodexModelCatalog();
      try {
        const { env, resolution } = await withDb(async (db) => ({
          env: await createUserProcessEnvironment(userId, db, undefined, undefined, 'codex'),
          resolution: await resolveApiKey('OPENAI_API_KEY', { userId, db, tool: 'codex' }),
        }));
        if (resolution.decryptionFailed) return fallbackCodexModelCatalog();
        const childEnv = stripProviderCredentialEnvironment(env, 'codex');
        if (!usesServerSharedCodexAuth(config)) {
          delete childEnv.CODEX_HOME;
          delete childEnv.DISCO_HOST_CODEX_HOME;
        }
        for (const [key, value] of Object.entries(resolution.connection ?? {})) {
          if (value?.trim()) childEnv[key] = value;
        }
        if (route.codexHome) childEnv.CODEX_HOME = route.codexHome;
        const result = await runExecutorCommand(
          {
            command: 'codex.models',
            params: {
              useNativeAuth: resolution.useNativeAuth && !resolution.apiKey,
              sharedRuntime: usesServerSharedCodexAuth(config),
            },
          },
          {
            env: childEnv,
            delegatedHomeKey: route.delegatedHomeKey ?? undefined,
            templateVariables: { user_id: userId, unix_user: route.delegatedHomeKey ?? undefined },
            sensitiveOutput: true,
            timeoutMs: 25_000,
            logPrefix: '[CodexModels]',
          }
        );
        if (result.success && result.data) return result.data as CodexModelCatalog;
      } catch {
        // Discovery failures must not invalidate or overwrite persisted choices.
      }
      return fallbackCodexModelCatalog();
    },
  };
}
