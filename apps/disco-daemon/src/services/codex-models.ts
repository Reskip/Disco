import { createHash } from 'node:crypto';
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

const CACHE_TTL_MS = 30 * 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_CACHED_CATALOGS = 256;

interface CachedCatalog {
  catalog: CodexModelCatalog;
  expiresAt: number;
  retryAt: number;
}

/** Successful discoveries are cached per tenant, user and resolved credential. */
export function createCodexModelsService(app: AppLike, db: TenantScopeAwareDatabase) {
  const cache = new Map<string, CachedCatalog>();
  const inflight = new Map<string, Promise<CodexModelCatalog | undefined>>();

  const discover = (
    key: string,
    run: () => Promise<CodexModelCatalog | undefined>
  ): Promise<CodexModelCatalog | undefined> => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const request = Promise.resolve()
      .then(run)
      .then((catalog) => {
        if (catalog?.source !== 'dynamic' || !catalog.models?.length) return undefined;
        cache.delete(key);
        cache.set(key, {
          catalog,
          expiresAt: Date.now() + CACHE_TTL_MS,
          retryAt: 0,
        });
        if (cache.size > MAX_CACHED_CATALOGS) cache.delete(cache.keys().next().value!);
        return catalog;
      })
      .catch(() => undefined)
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  };

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
        const sharedRuntime = usesServerSharedCodexAuth(config);
        // Hash secrets into the key; never retain or log credential material.
        const key = createHash('sha256')
          .update(
            JSON.stringify({
              tenantId,
              userId,
              home: childEnv.CODEX_HOME,
              hostHome: childEnv.DISCO_HOST_CODEX_HOME,
              delegatedHomeKey: route.delegatedHomeKey,
              sharedRuntime,
              useNativeAuth: resolution.useNativeAuth,
              apiKey: resolution.apiKey,
              connection: resolution.connection,
            })
          )
          .digest('hex');
        const run = async (): Promise<CodexModelCatalog | undefined> => {
          const result = await runExecutorCommand(
            {
              command: 'codex.models',
              params: {
                useNativeAuth: resolution.useNativeAuth && !resolution.apiKey,
                sharedRuntime,
              },
            },
            {
              env: childEnv,
              delegatedHomeKey: route.delegatedHomeKey ?? undefined,
              templateVariables: {
                user_id: userId,
                unix_user: route.delegatedHomeKey ?? undefined,
              },
              sensitiveOutput: true,
              timeoutMs: 25_000,
              logPrefix: '[CodexModels]',
            }
          );
          return result.success ? (result.data as CodexModelCatalog | undefined) : undefined;
        };
        const cached = cache.get(key);
        if (cached) {
          // Serve the last successful catalog immediately while refreshing it in
          // the background. A failed refresh leaves that catalog intact.
          cache.delete(key);
          cache.set(key, cached);
          if (Date.now() >= cached.expiresAt && Date.now() >= cached.retryAt) {
            cached.retryAt = Date.now() + RETRY_MS;
            void discover(key, run);
          }
          return cached.catalog;
        }
        const catalog = await discover(key, run);
        if (catalog) return catalog;
      } catch {
        // Discovery failures must not invalidate or overwrite persisted choices.
      }
      return fallbackCodexModelCatalog();
    },
  };
}
