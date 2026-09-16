import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export function quotaChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Do not inherit a task's Codex identity or the daemon's database/API secrets.
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'COMSPEC',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
  ]);
  const env = Object.fromEntries(
    Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase()))
  );
  env.CODEX_HOME = source.DISCO_HOST_CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return env;
}

/** Read only account metadata: never create a thread or consume a reset credit. */
export async function readHostCodexRateLimits(): Promise<unknown> {
  const env = quotaChildEnvironment(process.env);
  const command = process.env.DISCO_CODEX_QUOTA_COMMAND?.trim() || 'codex';
  return new Promise((resolve, reject) => {
    // Windows deployments with a .cmd CLI shim supply the native executable
    // through DISCO_CODEX_QUOTA_COMMAND so cleanup cannot leave a shell child.
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      env,
      cwd: env.CODEX_HOME,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    let initialized = false;
    const finish = (error: Error | null, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex quota read timed out')), 15_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', () => finish(new Error('Codex quota reader could not start')));
    child.stdin.on('error', () => finish(new Error('Codex quota reader connection closed')));
    child.on('exit', () => finish(new Error('Codex quota reader exited before replying')));
    // Provider diagnostics may contain account details. Never return or log them.
    child.stderr.resume();
    lines.on('line', (line) => {
      let message: { id?: number | string; method?: string; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.method) {
        if (message.id !== undefined) {
          send({ id: message.id, error: { code: -32601, message: 'Read-only quota client' } });
        }
        return;
      }
      if (message.id === 1 && !initialized) {
        if (message.error) return finish(new Error('Codex quota initialization failed'));
        initialized = true;
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (message.id === 2 && initialized) {
        finish(message.error ? new Error('Codex quota is unavailable') : null, message.result);
      }
    });
    child.once('spawn', () =>
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'disco-quota', version: '1.0.0' } },
      })
    );
  });
}
