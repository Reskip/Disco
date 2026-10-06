import * as os from 'node:os';
import * as path from 'node:path';
import { synchronizeCodexRuntimeAuth } from './codex-auth-sync.js';

export function getCodexHomeCandidates(): string[] {
  const candidates = [
    process.env.CODEX_HOME,
    process.env.DISCO_HOST_CODEX_HOME,
    path.join(os.homedir(), '.codex'),
  ];

  // The local Windows launcher intentionally redirects USERPROFILE/HOME to
  // E:\\Disco\\home so Disco data stays on E:. Codex's image-generation host,
  // however, writes media under the signed-in Windows profile. HOMEDRIVE and
  // HOMEPATH retain that native profile even when USERPROFILE is redirected.
  if (process.platform === 'win32' && process.env.HOMEDRIVE && process.env.HOMEPATH) {
    candidates.push(path.join(process.env.HOMEDRIVE, process.env.HOMEPATH, '.codex'));
  }

  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    unique.set(process.platform === 'win32' ? resolved.toLowerCase() : resolved, resolved);
  }
  return [...unique.values()];
}

export function resolveDiscoCodexRuntimeHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DISCO_CODEX_RUNTIME_HOME?.trim()) {
    return path.resolve(env.DISCO_CODEX_RUNTIME_HOME.trim());
  }
  if (env.DISCO_DATA_HOME?.trim()) {
    return path.resolve(path.dirname(env.DISCO_DATA_HOME.trim()), 'codex-runtime');
  }
  if (env.CODEX_HOME?.trim()) return path.resolve(env.CODEX_HOME.trim());
  return path.resolve(os.homedir(), '.disco', 'codex-runtime');
}

const DISCO_CODEX_CHILD_ENV_ALLOWLIST = new Set(['CODEX_HOME', 'CODEX_API_KEY']);

/**
 * Build the environment inherited by Disco-owned Codex processes.
 *
 * Ordinary OS and Disco variables are preserved. Codex-internal variables are
 * allowlisted so a daemon launched from Codex Desktop cannot accidentally pass
 * the desktop task identity, originator, permission profile, or CI marker into
 * Disco's isolated Runtime Home.
 */
export function buildDiscoCodexChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options: {
    codexHome?: string;
    useSubscription?: boolean;
    apiKey?: string;
  } = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.startsWith('CODEX_') && !DISCO_CODEX_CHILD_ENV_ALLOWLIST.has(key)) continue;
    if (options.useSubscription && (key === 'OPENAI_API_KEY' || key === 'CODEX_API_KEY')) {
      continue;
    }
    env[key] = value;
  }

  env.CODEX_HOME = options.codexHome ?? resolveDiscoCodexRuntimeHome(source);
  if (options.useSubscription) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  } else if (options.apiKey) {
    env.CODEX_API_KEY = options.apiKey;
  }
  return env;
}

export async function ensureDiscoCodexRuntimeHome(): Promise<string> {
  const runtimeHome = resolveDiscoCodexRuntimeHome();
  // Only auth.json is synchronized; desktop settings and tasks stay isolated.
  await synchronizeCodexRuntimeAuth({
    runtimeHome,
    hostHomes: getCodexHomeCandidates(),
  });
  return runtimeHome;
}
