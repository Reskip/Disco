import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { probeDiscoDaemon } from './daemon-probe.js';

describe('probeDiscoDaemon', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  async function serve(body: unknown): Promise<string> {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    return `http://127.0.0.1:${address.port}`;
  }

  it('recognizes the explicit Disco health identity', async () => {
    const url = await serve({
      service: 'disco-daemon',
      status: 'ok',
      deploymentId: '019c1234-5678-7123-8123-123456789abc',
      managedInstanceId: 'owned-instance',
    });
    await expect(probeDiscoDaemon(url)).resolves.toEqual({
      running: true,
      deploymentId: '019c1234-5678-7123-8123-123456789abc',
      managedInstanceId: 'owned-instance',
    });
  });

  it('does not mistake an unrelated healthy HTTP service for Disco', async () => {
    const url = await serve({ status: 'ok' });
    await expect(probeDiscoDaemon(url)).resolves.toEqual({ running: false });
  });

  it('recognizes the legacy health shape during a package reinstall', async () => {
    const url = await serve({
      status: 'ok',
      version: '0.23.0',
      timestamp: Date.now(),
      db: { ok: true },
      auth: { requireAuth: true },
    });
    await expect(probeDiscoDaemon(url)).resolves.toEqual({ running: true });
  });
});
