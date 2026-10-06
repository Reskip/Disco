import { dirname } from 'node:path';
import { parseCodexModelCatalog } from '@disco/core/models';
import type { CodexModelsPayload, ExecutorResult } from '../payload-types.js';
import { CodexAppServerClient } from '../sdk-handlers/codex/app-server-client.js';
import {
  buildDiscoCodexChildEnvironment,
  ensureDiscoCodexRuntimeHome,
} from '../sdk-handlers/codex/runtime-environment.js';
import { resolveCodexAuthPath } from '../user-runtime-paths.js';
import type { CommandOptions } from './index.js';

export async function handleCodexModels(
  payload: CodexModelsPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true } };
  // Shared local deployments use the isolated Disco runtime. Delegated homes
  // must never import the host's login or cache from another user.
  const codexHome = payload.params.sharedRuntime
    ? await ensureDiscoCodexRuntimeHome()
    : dirname(resolveCodexAuthPath());
  const client = new CodexAppServerClient({
    env: buildDiscoCodexChildEnvironment(process.env, {
      ...(codexHome ? { codexHome } : {}),
      useSubscription: payload.params.useNativeAuth,
      apiKey: process.env.OPENAI_API_KEY,
    }),
    timeoutMs: 8_000,
  });
  try {
    return { success: true, data: parseCodexModelCatalog(await client.listModels()) };
  } catch {
    // Do not expose CLI stderr/config/credential material in a public response.
    return {
      success: false,
      error: { code: 'CODEX_MODELS_UNAVAILABLE', message: 'Codex 模型列表暂时无法获取' },
    };
  } finally {
    await client.close();
  }
}
