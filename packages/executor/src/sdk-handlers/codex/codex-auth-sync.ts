import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type AuthFileState = {
  authFile: string;
  freshness: number;
};

export type CodexAuthSyncResult = {
  runtimeHome: string;
  copied: boolean;
  sourceAuthFile?: string;
};

async function inspectAuthFile(authFile: string): Promise<AuthFileState | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(authFile, 'utf8'), fs.stat(authFile)]);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const tokens =
      parsed.tokens && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens)
        ? (parsed.tokens as Record<string, unknown>)
        : undefined;
    const hasSubscription =
      typeof tokens?.refresh_token === 'string' && tokens.refresh_token.trim().length > 0;
    const hasApiKey =
      typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim().length > 0;
    if (!hasSubscription && !hasApiKey) return null;

    const lastRefresh =
      typeof parsed.last_refresh === 'string' ? Date.parse(parsed.last_refresh) : Number.NaN;
    return {
      authFile,
      freshness: Number.isFinite(lastRefresh) ? lastRefresh : stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * Keep Disco's isolated Codex Runtime Home on the freshest valid login from
 * the trusted host Codex homes.
 *
 * Only `auth.json` is synchronized. Desktop config, memories, sessions,
 * plugins and skills remain outside the Runtime Home boundary. Codex refreshes
 * its own runtime copy in place, so an older host file never overwrites a
 * fresher runtime credential.
 */
export async function synchronizeCodexRuntimeAuth(options: {
  runtimeHome: string;
  hostHomes: string[];
}): Promise<CodexAuthSyncResult> {
  const runtimeHome = path.resolve(options.runtimeHome);
  const runtimeAuthFile = path.join(runtimeHome, 'auth.json');
  await fs.mkdir(runtimeHome, { recursive: true, mode: 0o700 });

  const runtimeKey = process.platform === 'win32' ? runtimeAuthFile.toLowerCase() : runtimeAuthFile;
  const candidateFiles = [...new Set(options.hostHomes.map((home) => path.resolve(home)))]
    .map((home) => path.join(home, 'auth.json'))
    .filter((authFile) => {
      const key = process.platform === 'win32' ? authFile.toLowerCase() : authFile;
      return key !== runtimeKey;
    });

  const [runtimeState, ...hostStates] = await Promise.all([
    inspectAuthFile(runtimeAuthFile),
    ...candidateFiles.map(inspectAuthFile),
  ]);
  const freshestHost = hostStates
    .filter((state): state is AuthFileState => state !== null)
    .sort((a, b) => b.freshness - a.freshness)[0];

  if (!freshestHost || (runtimeState && runtimeState.freshness >= freshestHost.freshness)) {
    return { runtimeHome, copied: false };
  }

  // copyFile deliberately replaces only auth.json. A unique temporary file
  // followed by rename prevents an executor from observing a partial JSON
  // document when several sessions start together.
  const temporaryAuthFile = path.join(
    runtimeHome,
    `.auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    await fs.copyFile(freshestHost.authFile, temporaryAuthFile);
    await fs.chmod(temporaryAuthFile, 0o600).catch(() => undefined);
    await fs.rename(temporaryAuthFile, runtimeAuthFile);
  } finally {
    await fs.rm(temporaryAuthFile, { force: true }).catch(() => undefined);
  }

  return {
    runtimeHome,
    copied: true,
    sourceAuthFile: freshestHost.authFile,
  };
}
