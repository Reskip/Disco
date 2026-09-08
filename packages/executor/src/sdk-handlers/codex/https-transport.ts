import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodexOptions } from '@disco/core/sdk';
import type { CodexSkillRuntimeEntry } from '@disco/core/types';

type CodexConfigObject = NonNullable<CodexOptions['config']>;

const CODEX_HTTPS_PROVIDER_ID = 'disco_openai_https';

/**
 * Desktop-only plugins inherited from a host Codex installation.
 *
 * Disco runs Codex as a headless worker.  Loading these plugins advertises
 * browser/desktop skills backed by app-local pipes which do not exist in the
 * daemon process, causing the model to spend time attempting tools that can
 * only return "No browser is available".  Keep document/PDF and other
 * headless-safe plugins untouched.
 */
export const HEADLESS_DISABLED_CODEX_PLUGINS = [
  'browser@openai-bundled',
  'chrome@openai-bundled',
  'computer-use@openai-bundled',
  'codex-app-tools@openai-bundled',
] as const;

const HEADLESS_DISABLED_SKILL_PLUGINS = ['browser', 'chrome', 'computer-use'] as const;
const MANAGED_SKILLS_ENV = 'DISCO_CODEX_SKILLS_CONFIG';

function objectValue(value: unknown): CodexConfigObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CodexConfigObject)
    : {};
}

function directoryEntries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function collectSkillFiles(skillsDirectory: string, output: Set<string>): void {
  for (const entry of directoryEntries(skillsDirectory)) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDirectory, entry.name, 'SKILL.md');
    if (existsSync(skillFile)) output.add(skillFile.replace(/\\/g, '/'));
  }
}

/**
 * Locate desktop-control skills in the host Codex cache without pinning plugin
 * version numbers. Plugin updates create a new version directory; every
 * discovered copy is disabled so stale caches cannot become visible again.
 */
export function discoverHeadlessDisabledCodexSkillFiles(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const homes = new Set(
    [env.CODEX_HOME, env.DISCO_HOST_CODEX_HOME, path.join(os.homedir(), '.codex')]
      .filter((value): value is string => !!value)
      .map(value => path.resolve(value))
  );
  const result = new Set<string>();

  for (const codexHome of homes) {
    for (const plugin of HEADLESS_DISABLED_SKILL_PLUGINS) {
      const cachedPlugin = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', plugin);
      for (const version of directoryEntries(cachedPlugin)) {
        if (version.isDirectory()) {
          collectSkillFiles(path.join(cachedPlugin, version.name, 'skills'), result);
        }
      }

      collectSkillFiles(
        path.join(
          codexHome,
          '.tmp',
          'bundled-marketplaces',
          'openai-bundled',
          'plugins',
          plugin,
          'skills'
        ),
        result
      );
    }
  }

  return [...result].sort();
}

export function parseManagedCodexSkillEntries(
  env: NodeJS.ProcessEnv = process.env
): CodexSkillRuntimeEntry[] {
  const raw = env[MANAGED_SKILLS_ENV]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const deduplicated = new Map<string, CodexSkillRuntimeEntry>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Partial<CodexSkillRuntimeEntry>;
      if (
        typeof candidate.path !== 'string' ||
        !path.isAbsolute(candidate.path) ||
        typeof candidate.enabled !== 'boolean'
      ) {
        continue;
      }
      const resolvedPath = path.resolve(candidate.path);
      deduplicated.set(resolvedPath, { path: resolvedPath, enabled: candidate.enabled });
    }
    return [...deduplicated.values()];
  } catch {
    return [];
  }
}

function mergeManagedSkillEntries(
  managedEntries: CodexSkillRuntimeEntry[],
  disabledSkillFiles: string[]
): CodexSkillRuntimeEntry[] {
  const merged = new Map<string, CodexSkillRuntimeEntry>();
  for (const entry of managedEntries) {
    merged.set(path.resolve(entry.path), {
      path: path.resolve(entry.path),
      enabled: entry.enabled,
    });
  }
  // Headless-incompatible desktop skills remain a hard safety boundary even
  // if a stale persisted setting says otherwise.
  for (const skillFile of disabledSkillFiles) {
    const resolvedPath = path.resolve(skillFile);
    merged.set(resolvedPath, { path: resolvedPath, enabled: false });
  }
  return [...merged.values()];
}

/**
 * App-server only discovers skills below its built-in roots unless clients
 * register additional roots through `skills/extraRoots/set`. `skills.config`
 * can enable or disable a known skill, but it does not make an external
 * `SKILL.md` discoverable by itself.
 *
 * Disco stores shared and agent-owned skills outside the isolated Codex
 * Runtime Home, so derive the containing skill collection for every managed
 * file. The per-task catalog already limits agent roots to the current agent;
 * disabled files remain discoverable so Codex can apply their false toggle.
 */
export function resolveHeadlessCodexSkillExtraRoots(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const entries = mergeManagedSkillEntries(
    parseManagedCodexSkillEntries(env),
    discoverHeadlessDisabledCodexSkillFiles(env)
  );
  const roots = new Set<string>();
  for (const entry of entries) {
    const skillPath = path.resolve(entry.path);
    const skillDirectory =
      path.basename(skillPath).toLowerCase() === 'skill.md' ? path.dirname(skillPath) : skillPath;
    roots.add(path.dirname(skillDirectory));
  }
  return [...roots].sort();
}

/** CLI overrides applied before `app-server` reads the host config.toml. */
export function buildHeadlessCodexCliConfigArgs(
  disabledSkillFiles = discoverHeadlessDisabledCodexSkillFiles(),
  managedEntries = parseManagedCodexSkillEntries()
): string[] {
  const skillEntries = mergeManagedSkillEntries(managedEntries, disabledSkillFiles);
  return [
    ...HEADLESS_DISABLED_CODEX_PLUGINS.flatMap(plugin => [
      '-c',
      `plugins.${JSON.stringify(plugin)}.enabled=false`,
    ]),
    '-c',
    'features.js_repl=false',
    // Disco owns the only durable agent-memory store. A shared headless
    // Runtime Home must not create a second cross-user Codex memory layer.
    '-c',
    'features.memories=false',
    '-c',
    'features.external_agent_memory_import=false',
    // Desktop Codex config can contain a turn-ended notifier owned by the
    // desktop app. Headless Disco turns must not launch it (or flash a console
    // window) after every response.
    '-c',
    'notify=[]',
    ...(skillEntries.length > 0
      ? [
          '-c',
          `skills.config=[${skillEntries
            .map(
              entry =>
                `{path=${JSON.stringify(entry.path.replace(/\\/g, '/'))},enabled=${entry.enabled}}`
            )
            .join(',')}]`,
        ]
      : []),
  ];
}

/**
 * Pin Codex's upstream Responses transport to HTTPS/SSE.
 *
 * This is intentionally scoped to Disco's spawned Codex clients instead of the
 * user's global config.toml.  `supports_websockets: false` is the current
 * Codex provider-level switch; the legacy responses_websockets feature flags
 * have been removed from Codex CLI 0.149.
 */
export function buildCodexHttpsTransportConfig(input: {
  config?: CodexConfigObject;
  apiKey?: string;
  baseUrl?: string;
  useNativeAuth: boolean;
}): CodexConfigObject {
  const existingProviders = input.config?.model_providers;
  const modelProviders =
    existingProviders && typeof existingProviders === 'object' && !Array.isArray(existingProviders)
      ? (existingProviders as CodexConfigObject)
      : {};
  const existingPlugins = objectValue(input.config?.plugins);
  const headlessPlugins = Object.fromEntries(
    HEADLESS_DISABLED_CODEX_PLUGINS.map(plugin => [
      plugin,
      { ...objectValue(existingPlugins[plugin]), enabled: false },
    ])
  );
  const existingFeatures = objectValue(input.config?.features);
  const existingSkills = objectValue(input.config?.skills);
  const existingSkillConfig = Array.isArray(existingSkills.config) ? existingSkills.config : [];
  const disabledSkillFiles = discoverHeadlessDisabledCodexSkillFiles();
  const managedSkillEntries = mergeManagedSkillEntries(
    parseManagedCodexSkillEntries(),
    disabledSkillFiles
  );
  const subscription = input.useNativeAuth && !input.apiKey;
  const provider: CodexConfigObject = subscription
    ? {
        name: 'OpenAI HTTPS',
        base_url: input.baseUrl ?? 'https://chatgpt.com/backend-api/codex',
        wire_api: 'responses',
        requires_openai_auth: true,
        supports_websockets: false,
      }
    : {
        name: 'OpenAI HTTPS',
        base_url: input.baseUrl ?? 'https://api.openai.com/v1',
        env_key: 'CODEX_API_KEY',
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
      };

  return {
    ...(input.config ?? {}),
    features: {
      ...existingFeatures,
      // The JS REPL is the transport used by the desktop browser plugins.
      js_repl: false,
      // Agent memory is canonical under each Disco agent workspace. Disable
      // Codex's own shared Runtime Home memory and desktop-memory import.
      memories: false,
      external_agent_memory_import: false,
    },
    plugins: {
      ...existingPlugins,
      ...headlessPlugins,
    },
    ...(managedSkillEntries.length > 0
      ? {
          skills: {
            ...existingSkills,
            config: [
              ...existingSkillConfig,
              ...managedSkillEntries.map(entry => ({
                path: entry.path.replace(/\\/g, '/'),
                enabled: entry.enabled,
              })),
            ],
          },
        }
      : {}),
    model_provider: CODEX_HTTPS_PROVIDER_ID,
    model_providers: {
      ...modelProviders,
      [CODEX_HTTPS_PROVIDER_ID]: provider,
    },
  };
}
