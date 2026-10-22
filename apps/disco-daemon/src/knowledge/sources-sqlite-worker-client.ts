import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HostSqliteArchive, HostSqliteThread } from './sources-sqlite.js';

interface WorkerOptions {
  signal?: AbortSignal;
}
type WorkerRequest =
  | { method: 'catalog'; home: string }
  | { method: 'export'; home: string; id: string; archivePath: string };

async function workerEntry(): Promise<{ path: string; execArgv: string[] }> {
  const here = dirname(fileURLToPath(import.meta.url));
  // tsup emits both bundled dist/main.js and standalone dist/knowledge/*.js.
  // Development uses the adjacent TS entry with the project's known tsx loader.
  for (const extension of ['js', 'ts']) {
    for (const directory of [here, join(here, 'knowledge')]) {
      const path = join(directory, `sources-sqlite-worker.${extension}`);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      return {
        path,
        execArgv:
          extension === 'ts'
            ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href]
            : [],
      };
    }
  }
  throw new Error('Codex 历史同步程序缺失，请检查服务构建文件。');
}

function cancelled(): Error {
  return Object.assign(new Error('历史同步已停止'), { name: 'AbortError' });
}

async function invoke<T>(request: WorkerRequest, options: WorkerOptions = {}): Promise<T> {
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  const entry = await workerEntry();
  if (signal?.aborted) throw cancelled();
  return new Promise<T>((resolve, reject) => {
    const child = spawn(process.execPath, [...entry.execArgv, entry.path], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    let settled = false;
    let aborting = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => {
      aborting = true;
      // Wait for exit before rejecting, so the caller can safely remove staging
      // files on Windows after all child file handles have been released.
      child.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => finish(aborting ? cancelled() : error));
    child.once('message', (value: unknown) => {
      if (aborting) return;
      const response = value as {
        ok?: boolean;
        value?: T;
        error?: { message?: string; code?: string };
      };
      if (response.ok) finish(undefined, response.value);
      else
        finish(
          Object.assign(new Error(response.error?.message ?? 'Codex 历史读取失败'), {
            code: response.error?.code,
          })
        );
    });
    child.once('exit', (code) =>
      finish(aborting ? cancelled() : new Error(`Codex 历史同步进程提前退出（${code ?? '未知'}）`))
    );
    if (signal?.aborted) abort();
    else
      child.send(request, (error) => {
        if (error) {
          child.kill();
          finish(error);
        }
      });
  });
}

export function hostSqliteThreads(
  home: string,
  options?: WorkerOptions
): Promise<HostSqliteThread[]> {
  return invoke({ method: 'catalog', home }, options);
}

export function exportHostSqliteThread(
  home: string,
  id: string,
  archivePath: string,
  options?: WorkerOptions
): Promise<HostSqliteArchive | null> {
  return invoke({ method: 'export', home, id, archivePath }, options);
}
