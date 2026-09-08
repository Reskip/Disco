import { resolvePackagedOpenCodeBinary } from '@disco/agentic-tool-opencode/runtime/binary';
import type { DiscoConfig } from '@disco/core/config';
import type { TenantScopeAwareDatabase } from '@disco/core/db';
import { BadRequest } from '@disco/core/feathers';
import type { AuthenticatedParams, DeepReadonly, OpenCodeModelCatalog } from '@disco/core/types';
import type { ExecutorCommandResult } from '../../utils/spawn-executor.js';
import { resolveAuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import { blockOpenCodeNativeStateNamespace } from './native-state-coordinator.js';

const MODEL_CATALOG_FAILURE = 'OpenCode model catalog could not be loaded. Try again.';

async function readModelCatalog(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<DiscoConfig>,
  params?: AuthenticatedParams
): Promise<OpenCodeModelCatalog> {
  const context = await resolveAuthenticatedOpenCodeSubjectContext(db, config, params);
  let result: ExecutorCommandResult;
  try {
    await resolvePackagedOpenCodeBinary();
    const handle = startOpenCodeExecutorInvocation(
      context.dataHome,
      { operation: 'read-model-catalog' },
      {
        env: context.executorEnv,
        logPrefix: '[OpenCode Models]',
      }
    );
    result = await handle.result;
    if (result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
      await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
    }
  } catch {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  if (!result.success || !result.data) {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  return result.data as OpenCodeModelCatalog;
}

export class OpenCodeModelsService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<DiscoConfig>
  ) {}

  async find(params?: AuthenticatedParams): Promise<OpenCodeModelCatalog> {
    if (Object.keys(params?.query ?? {}).length > 0) {
      throw new BadRequest('OpenCode model catalog does not accept query parameters.');
    }
    return readModelCatalog(this.db, this.config, params);
  }
}

export function createOpenCodeModelsService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<DiscoConfig>
) {
  return new OpenCodeModelsService(db, config);
}
