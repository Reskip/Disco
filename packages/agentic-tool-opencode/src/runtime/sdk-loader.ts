import {
  loadManagedAgenticToolSdk,
  resolveManagedAgenticToolIntegration,
} from '@disco/core/agentic-integrations';

export type OpenCodeSdk = typeof import('@opencode-ai/sdk');
export type OpenCodeSdkV2 = typeof import('@opencode-ai/sdk/v2');

export async function loadOpenCodeSdk(): Promise<OpenCodeSdk> {
  // Source checkouts install the SDK in this package's dependency scope. Keep
  // the import here so pnpm/Node resolve it from agentic-tool-opencode rather
  // than from @disco/core, which intentionally does not ship vendor runtimes.
  if (process.env.DISCO_MANAGED_AGENTIC_TOOLS !== '1') return import('@opencode-ai/sdk');
  return loadManagedAgenticToolSdk<OpenCodeSdk>('opencode');
}

export async function loadOpenCodeSdkV2(): Promise<OpenCodeSdkV2> {
  if (process.env.DISCO_MANAGED_AGENTIC_TOOLS !== '1') return import('@opencode-ai/sdk/v2');
  const discoVersion = process.env.DISCO_VERSION;
  if (!discoVersion) throw new Error('DISCO_VERSION is missing from the packaged Disco runtime');
  const integration = await resolveManagedAgenticToolIntegration<OpenCodeSdk>(
    'opencode',
    discoVersion
  );
  if (integration.DISCO_INTEGRATION_VERSION !== discoVersion || !integration.sdkV2) {
    throw new Error(`OpenCode support does not match Disco ${discoVersion}. Run: disco install`);
  }
  return integration.sdkV2 as OpenCodeSdkV2;
}
