import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENTIC_TOOL_INTEGRATIONS = {
  'claude-code': {
    packageName: '@disco-live/claude',
    vendorPackage: '@anthropic-ai/claude-agent-sdk',
    displayName: 'Claude Code',
  },
  codex: {
    packageName: '@disco-live/codex',
    vendorPackage: '@openai/codex-sdk',
    displayName: 'Codex',
  },
  copilot: {
    packageName: '@disco-live/copilot',
    vendorPackage: '@github/copilot-sdk',
    displayName: 'GitHub Copilot',
  },
  gemini: {
    packageName: '@disco-live/gemini',
    vendorPackage: '@google/gemini-cli-core',
    displayName: 'Gemini',
  },
  opencode: {
    packageName: '@disco-live/opencode',
    vendorPackage: '@opencode-ai/sdk',
    displayName: 'OpenCode',
  },
  cursor: { packageName: '@disco-live/cursor', vendorPackage: '@cursor/sdk', displayName: 'Cursor' },
} as const;

export type InstallableAgenticTool = keyof typeof AGENTIC_TOOL_INTEGRATIONS;

export function resolveManagedAgenticToolVersion(
  fallback?: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env.DISCO_VERSION ?? env.DISCO_INTEGRATION_VERSION ?? fallback;
}

export function isInstallableAgenticTool(value: string): value is InstallableAgenticTool {
  return Object.hasOwn(AGENTIC_TOOL_INTEGRATIONS, value);
}

export function getAgenticToolsRoot(): string {
  return process.env.DISCO_AGENTIC_TOOLS_DIR ?? join(homedir(), '.disco', 'agentic-tools');
}

export const AGENTIC_TOOL_SELECTION_MANIFEST = 'selection.json';
export const AGENTIC_TOOL_REPAIR_COMMAND = 'disco install --sync';

export type AgenticToolSelectionPolicy =
  | { mode: 'declarative'; selected: InstallableAgenticTool[]; source: 'config.yaml' }
  | { mode: 'local-managed'; selected: InstallableAgenticTool[]; source: 'manifest' }
  | { mode: 'local-managed'; selected: []; source: 'missing-manifest' };

export type AgenticToolSelectionManifest = {
  schemaVersion: 1;
  installed: InstallableAgenticTool[];
};

export class InvalidAgenticToolSelectionManifestError extends Error {
  constructor(detail: string) {
    super(
      `The local agentic-tool selection manifest is invalid or unreadable: ${detail}. Run interactive \`disco install\` to replace it.`
    );
    this.name = 'InvalidAgenticToolSelectionManifestError';
  }
}

export function getAgenticToolSelectionManifestPath(): string {
  return join(getAgenticToolsRoot(), AGENTIC_TOOL_SELECTION_MANIFEST);
}

export async function readAgenticToolSelectionManifest(): Promise<
  AgenticToolSelectionManifest | undefined
> {
  try {
    const value = JSON.parse(
      await readFile(getAgenticToolSelectionManifestPath(), 'utf8')
    ) as Partial<AgenticToolSelectionManifest>;
    if (
      value.schemaVersion !== 1 ||
      !Array.isArray(value.installed) ||
      !value.installed.every((tool) => typeof tool === 'string' && isInstallableAgenticTool(tool))
    )
      throw new InvalidAgenticToolSelectionManifestError('unsupported schema or tool selection');
    return {
      schemaVersion: 1,
      installed: [...new Set(value.installed)] as InstallableAgenticTool[],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof InvalidAgenticToolSelectionManifestError) throw error;
    throw new InvalidAgenticToolSelectionManifestError(
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Single deployment policy resolver used by CLI, daemon, and service gates. */
export async function resolveAgenticToolSelectionPolicy(config: {
  agentic_tools?: { installed?: InstallableAgenticTool[] };
}): Promise<AgenticToolSelectionPolicy> {
  if (config.agentic_tools?.installed !== undefined) {
    return { mode: 'declarative', selected: config.agentic_tools.installed, source: 'config.yaml' };
  }
  const manifest = await readAgenticToolSelectionManifest();
  return manifest
    ? { mode: 'local-managed', selected: manifest.installed, source: 'manifest' }
    : { mode: 'local-managed', selected: [], source: 'missing-manifest' };
}

export function getAgenticToolInstallDir(
  tool: InstallableAgenticTool,
  discoVersion: string
): string {
  return join(getAgenticToolsRoot(), discoVersion, tool);
}

/** Minimal root manifest for Disco-owned, project-scoped npm installs. */
export function createManagedAgenticToolInstallManifest(
  tool: InstallableAgenticTool,
  discoVersion: string
): {
  name: string;
  version: string;
  private: true;
  dependencies: Record<string, string>;
} {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  return {
    name: `disco-managed-${tool}`,
    version: '0.0.0',
    private: true,
    dependencies: { [definition.packageName]: discoVersion },
  };
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return !(
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    isAbsolute(relativePath)
  );
}

export type ManagedAgenticToolIntegration<T = unknown> = {
  DISCO_INTEGRATION_VERSION?: string;
  sdk?: T;
  sdkV2?: unknown;
};

export type ManagedAgenticToolAlignment = {
  tool: InstallableAgenticTool;
  displayName: string;
  expectedVersion: string;
  status: 'ready' | 'missing-or-invalid';
  detail?: string;
};

async function findInstalledPackageDirectory(
  fromEntry: string,
  packageName: string,
  installRoot: string
): Promise<string> {
  const packageSegments = packageName.split('/');
  for (let directory = dirname(fromEntry); isContainedPath(installRoot, directory); ) {
    try {
      return await realpath(join(directory, 'node_modules', ...packageSegments));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`${packageName} is missing from the managed integration tree`);
}

/** Locate one package dependency and prove its canonical path stays in the managed tool root. */
export async function resolveManagedAgenticToolPackageDirectory(
  tool: InstallableAgenticTool,
  discoVersion: string,
  packageName: string
): Promise<string> {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  const installDir = getAgenticToolInstallDir(tool, discoVersion);
  const require = createRequire(join(installDir, 'package.json'));
  const realInstallDir = await realpath(installDir);
  const integrationEntry = await realpath(require.resolve(definition.packageName));
  if (!isContainedPath(realInstallDir, integrationEntry)) {
    throw new Error('integration wrapper resolved outside the managed directory');
  }
  const packageDirectory = await findInstalledPackageDirectory(
    integrationEntry,
    packageName,
    realInstallDir
  );
  if (!isContainedPath(realInstallDir, packageDirectory)) {
    throw new Error(`${packageName} resolved outside the managed directory`);
  }
  return packageDirectory;
}

/** Resolve a wrapper and its primary SDK from one explicitly owned install tree. */
async function resolveManagedAgenticToolIntegrationAt<T>(
  tool: InstallableAgenticTool,
  installDir: string
): Promise<ManagedAgenticToolIntegration<T>> {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  const require = createRequire(join(installDir, 'package.json'));
  const realInstallDir = await realpath(installDir);
  const integrationEntry = await realpath(require.resolve(definition.packageName));
  if (!isContainedPath(realInstallDir, integrationEntry)) {
    throw new Error('integration wrapper resolved outside the managed directory');
  }
  const vendorDirectory = await findInstalledPackageDirectory(
    integrationEntry,
    definition.vendorPackage,
    realInstallDir
  );
  if (!isContainedPath(realInstallDir, vendorDirectory)) {
    throw new Error(`${definition.vendorPackage} resolved outside the managed directory`);
  }
  return import(pathToFileURL(integrationEntry).href) as Promise<ManagedAgenticToolIntegration<T>>;
}

/** Resolve and validate both wrapper and vendor code inside one managed tree. */
export async function resolveManagedAgenticToolIntegration<T>(
  tool: InstallableAgenticTool,
  discoVersion: string
): Promise<ManagedAgenticToolIntegration<T>> {
  return resolveManagedAgenticToolIntegrationAt(tool, getAgenticToolInstallDir(tool, discoVersion));
}

/** Prove a staged package tree contains the aligned wrapper and vendor SDK. */
export async function assertManagedAgenticToolInstallReady(
  tool: InstallableAgenticTool,
  discoVersion: string,
  installDir = getAgenticToolInstallDir(tool, discoVersion)
): Promise<void> {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  const integration = await resolveManagedAgenticToolIntegrationAt(tool, installDir);
  if (integration.DISCO_INTEGRATION_VERSION !== discoVersion || !integration.sdk) {
    throw new Error(
      `${definition.displayName} integration ${integration.DISCO_INTEGRATION_VERSION ?? 'has no version'} does not match Disco ${discoVersion}`
    );
  }
}

/** Inspect the deployment-configured integrations without mutating disk. */
export async function inspectManagedAgenticToolAlignment(
  tools: readonly InstallableAgenticTool[],
  discoVersion: string
): Promise<ManagedAgenticToolAlignment[]> {
  return Promise.all(
    tools.map(async (tool) => {
      const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
      try {
        const integration = await resolveManagedAgenticToolIntegration(tool, discoVersion);
        if (integration.DISCO_INTEGRATION_VERSION !== discoVersion || !integration.sdk) {
          throw new Error(
            `integration reports ${integration.DISCO_INTEGRATION_VERSION ?? 'no version'}`
          );
        }
        return {
          tool,
          displayName: definition.displayName,
          expectedVersion: discoVersion,
          status: 'ready' as const,
        };
      } catch (error) {
        return {
          tool,
          displayName: definition.displayName,
          expectedVersion: discoVersion,
          status: 'missing-or-invalid' as const,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}

/**
 * Fail before a packaged daemon starts when its deployment-owned tool policy
 * is implicit or its selected package set is not ready for this exact Disco version.
 */
export async function assertConfiguredAgenticToolsReady(
  config: { agentic_tools?: { installed?: InstallableAgenticTool[] } },
  env: NodeJS.ProcessEnv = process.env
): Promise<readonly InstallableAgenticTool[] | undefined> {
  if (env.DISCO_MANAGED_AGENTIC_TOOLS !== '1') return undefined;

  const discoVersion = resolveManagedAgenticToolVersion(undefined, env);
  if (!discoVersion) {
    throw new Error(
      'Managed agentic tools are enabled, but DISCO_VERSION is unavailable. Reinstall the disco-live package.'
    );
  }

  const policy = await resolveAgenticToolSelectionPolicy(config);
  if (policy.source === 'missing-manifest') {
    throw new Error(
      [
        'No agentic tools have been selected for this installation.',
        'Run `disco install` to select at least one tool before starting the daemon.',
        'For an intentionally tool-free headless deployment, set `agentic_tools.installed: []` in config.yaml.',
      ].join('\n')
    );
  }

  const configured = policy.selected;
  const state = await inspectManagedAgenticToolAlignment(configured, discoVersion);
  const invalid = state.filter((item) => item.status !== 'ready');
  if (invalid.length === 0) return configured;

  const lines = invalid.map(
    (item) =>
      `  - ${item.displayName}: missing or invalid (expected ${item.expectedVersion})${item.detail ? `; ${item.detail}` : ''}`
  );
  throw new Error(
    [
      `Configured agentic tool packages are not aligned with Disco ${discoVersion}:`,
      ...lines,
      '',
      `Run \`${AGENTIC_TOOL_REPAIR_COMMAND}\` as the daemon user.`,
      'Inspect without changing anything with `disco doctor`.',
    ].join('\n')
  );
}

/**
 * Load an SDK from Disco's isolated, version-aligned integration tree.
 * Source checkouts use workspace dependencies unless managed mode is explicitly enabled.
 */
export async function loadManagedAgenticToolSdk<T>(tool: InstallableAgenticTool): Promise<T> {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  if (process.env.DISCO_MANAGED_AGENTIC_TOOLS !== '1') {
    return import(definition.vendorPackage) as Promise<T>;
  }

  const discoVersion = process.env.DISCO_VERSION;
  if (!discoVersion) throw new Error('DISCO_VERSION is missing from the packaged Disco runtime');
  let integration: ManagedAgenticToolIntegration<T>;
  try {
    integration = await resolveManagedAgenticToolIntegration<T>(tool, discoVersion);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `${definition.displayName} support is not installed for Disco ${discoVersion}${detail}. Run: ${AGENTIC_TOOL_REPAIR_COMMAND}`,
      { cause: error }
    );
  }
  if (integration.DISCO_INTEGRATION_VERSION !== discoVersion || !integration.sdk) {
    throw new Error(
      `${definition.displayName} support does not match Disco ${discoVersion}. Run: ${AGENTIC_TOOL_REPAIR_COMMAND}`
    );
  }
  return integration.sdk;
}
