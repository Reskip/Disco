import { exportHostSqliteThread, hostSqliteThreads } from './sources-sqlite.js';

type Request =
  | { method: 'catalog'; home: string }
  | { method: 'export'; home: string; id: string; archivePath: string };

// A fixed executable entrypoint used only by the daemon's child-process client.
// SQLite scans and large JSON parsing must not block HTTP/realtime on the parent.
process.once('disconnect', () => process.exit(1));
process.once('message', async (message: unknown) => {
  try {
    const request = message as Request;
    if (!request || typeof request.home !== 'string') throw new Error('无效的历史同步请求');
    let value: unknown;
    if (request.method === 'catalog') value = await hostSqliteThreads(request.home);
    else if (
      request.method === 'export' &&
      typeof request.id === 'string' &&
      typeof request.archivePath === 'string'
    )
      value = await exportHostSqliteThread(request.home, request.id, request.archivePath);
    else throw new Error('无效的历史同步操作');
    process.send?.({ ok: true, value }, () => process.exit(0));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    process.send?.(
      {
        ok: false,
        error: { message: failure.message || 'Codex 历史读取失败', code: failure.code },
      },
      () => process.exit(1)
    );
  }
});
