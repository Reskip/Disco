import {
  AGENTIC_TOOL_INTEGRATIONS,
  AGENTIC_TOOL_REPAIR_COMMAND,
  assertManagedAgenticToolInstallReady,
  getAgenticToolInstallDir,
  type InstallableAgenticTool,
} from '@disco/core/agentic-integrations';
import {
  assertManagedIntegrationPermissions,
  readManagedIntegrationManifest,
} from './agentic-tool-integrations.js';

export type AgenticToolDiagnostic = {
  id: InstallableAgenticTool;
  name: string;
  kind: 'managed-integration';
  status: 'ready' | 'missing' | 'unusable';
  path?: string;
  version?: string;
  detail?: string;
  docsUrl: string;
};

const DOCS_BASE = 'https://disco.live/guide/extended-install';

async function diagnoseManagedIntegration(
  tool: InstallableAgenticTool,
  discoVersion: string
): Promise<AgenticToolDiagnostic> {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  const installDir = getAgenticToolInstallDir(tool, discoVersion);
  const manifest = await readManagedIntegrationManifest(tool, discoVersion);
  if (!manifest) {
    return {
      id: tool,
      name: definition.displayName,
      kind: 'managed-integration',
      status: 'missing',
      detail: `Run: ${AGENTIC_TOOL_REPAIR_COMMAND}`,
      docsUrl: DOCS_BASE,
    };
  }

  try {
    await assertManagedIntegrationPermissions(tool, discoVersion);
    await assertManagedAgenticToolInstallReady(tool, discoVersion, installDir);
    return {
      id: tool,
      name: definition.displayName,
      kind: 'managed-integration',
      status: 'ready',
      path: installDir,
      version: manifest.packageVersion,
      docsUrl: DOCS_BASE,
    };
  } catch (error) {
    return {
      id: tool,
      name: definition.displayName,
      kind: 'managed-integration',
      status: 'unusable',
      path: installDir,
      detail: `${error instanceof Error ? error.message : String(error)}. Run: ${AGENTIC_TOOL_REPAIR_COMMAND}`,
      docsUrl: DOCS_BASE,
    };
  }
}

export async function diagnoseAgenticTools(discoVersion: string): Promise<AgenticToolDiagnostic[]> {
  return Promise.all(
    (Object.keys(AGENTIC_TOOL_INTEGRATIONS) as InstallableAgenticTool[]).map((tool) =>
      diagnoseManagedIntegration(tool, discoVersion)
    )
  );
}
