import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@disco/core/api';
import {
  EXECUTOR_TRANSCRIPT_CHUNK_BYTES,
  SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
} from '@disco/core/config';
import { feathers, feathersExpress, socketio } from '@disco/core/feathers';
import type {
  AuthenticatedParams,
  ExecutorTranscriptRequest,
  ExecutorTranscriptResponse,
  Message,
} from '@disco/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executorRuntimeScopeGuard } from '../auth/executor-runtime-scope';
import { ExecutorTranscriptsService } from './executor-transcripts';

const roots: string[] = [];
const scope = {
  session_id: '018f0000-0000-7000-8000-000000000001',
  task_id: '018f0000-0000-7000-8000-000000000002',
  user_id: 'owner',
};
const params: AuthenticatedParams = {
  provider: 'socketio',
  tenant_id: 'tenant-a',
  user: { user_id: 'owner', username: 'qa', role: 'member' },
};
const messageId = '018f0000-0000-7000-8000-000000000003';

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function transfer(data: unknown, method: 'create' | 'patch' = 'create') {
  const bytes = Buffer.from(JSON.stringify(data));
  const base = {
    transferId: randomUUID(),
    executorSessionToken: 'executor-proof',
    messageId,
    method,
    totalBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const packets: ExecutorTranscriptRequest[] = [];
  for (let offset = 0; offset < bytes.length; offset += EXECUTOR_TRANSCRIPT_CHUNK_BYTES) {
    packets.push({
      ...base,
      action: 'append',
      offset,
      chunk: bytes.subarray(offset, offset + EXECUTOR_TRANSCRIPT_CHUNK_BYTES).toString('base64'),
    });
  }
  const commit: ExecutorTranscriptRequest = { ...base, action: 'commit' };
  return { packets, commit };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'disco-transcript-test-'));
  roots.push(root);
  const rows = new Map<string, Message>();
  const messages = {
    get: vi.fn(async (id: string) => rows.get(id)!),
    find: vi.fn(async (p: AuthenticatedParams) => ({
      data: [...rows.values()].filter(
        (message) =>
          message.message_id === p.query?.message_id &&
          message.task_id === p.query?.task_id &&
          message.session_id === p.query?.session_id
      ),
      total: rows.size,
      limit: 1,
      skip: 0,
    })),
    create: vi.fn(async (data: unknown, p: AuthenticatedParams) => {
      expect(p.provider).toBe('socketio');
      expect(p.user?.user_id).toBe('owner');
      expect(p.authentication?.payload).toMatchObject({
        type: 'executor-session',
        purpose: 'executor-task',
        session_id: scope.session_id,
        task_id: scope.task_id,
      });
      const message = JSON.parse(JSON.stringify(data)) as Message;
      rows.set(message.message_id, message);
      return message;
    }),
    patch: vi.fn(async (id: string, data: unknown) => {
      const message = { ...rows.get(id), ...(data as object) } as Message;
      rows.set(id, message);
      return message;
    }),
  };
  const tokens = {
    validateToken: vi.fn(async (token, expected) =>
      token === 'executor-proof' &&
      expected?.tenantId === 'tenant-a' &&
      expected?.userId === 'owner'
        ? scope
        : null
    ),
  };
  const service = new ExecutorTranscriptsService(tokens, () => messages, root);
  return { service, root, rows, messages, tokens };
}

async function stage(service: ExecutorTranscriptsService, data: ReturnType<typeof transfer>) {
  for (const packet of data.packets) await service.create(packet, params);
}

function message(content = '文本😀\n'.repeat(150_000)) {
  return {
    message_id: messageId,
    session_id: scope.session_id,
    task_id: scope.task_id,
    type: 'assistant',
    role: 'assistant',
    timestamp: '2026-09-14T00:00:00.000Z',
    index: 1,
    content,
  };
}

describe('executor transcript staging', () => {
  it('restores UTF-8 split across packets and commits once after reconnect/restart', async () => {
    const f = await fixture();
    const data = message();
    const request = transfer(data);
    await f.service.create(request.packets[0], params);
    await f.service.create(request.packets[0], params);
    expect(f.messages.create).not.toHaveBeenCalled();
    const restarted = new ExecutorTranscriptsService(f.tokens, () => f.messages, f.root);
    for (const packet of request.packets.slice(1)) await restarted.create(packet, params);
    expect((await restarted.create(request.commit, params)).message).toEqual(data);
    expect((await restarted.create(request.commit, params)).message).toEqual(data);
    expect(f.messages.create).toHaveBeenCalledTimes(1);
    const [directory] = await readdir(f.root);
    expect(await readdir(path.join(f.root, directory))).toEqual(['state.json']);
    expect(await readFile(path.join(f.root, directory, 'state.json'), 'utf8')).not.toContain(
      'executor-proof'
    );
  });

  it('does not reapply an acknowledged patch after a newer patch', async () => {
    const f = await fixture();
    f.rows.set(messageId, message() as Message);
    const request = transfer({ content: '新内容'.repeat(500_000) }, 'patch');
    await stage(f.service, request);
    await f.service.create(request.commit, params);
    f.rows.set(messageId, { ...f.rows.get(messageId)!, content: 'later content' });
    expect((await f.service.create(request.commit, params)).message?.content).toBe('later content');
    expect(f.messages.patch).toHaveBeenCalledTimes(1);
  });

  it('recovers a create committed before a lost receipt without duplicating it', async () => {
    const f = await fixture();
    const data = message();
    const request = transfer(data);
    await stage(f.service, request);
    f.rows.set(messageId, data as Message);
    expect((await f.service.create(request.commit, params)).message).toEqual(data);
    expect(f.messages.create).not.toHaveBeenCalled();
  });

  it.each(['identity', 'tenant', 'token', 'path', 'session', 'task'] as const)(
    'rejects invalid %s without a message write',
    async (kind) => {
      const f = await fixture();
      const data = message();
      if (kind === 'session') data.session_id = randomUUID();
      if (kind === 'task') data.task_id = randomUUID();
      const request = transfer(data);
      const p = {
        ...params,
        ...(kind === 'identity' ? { user: { ...params.user!, user_id: 'outsider' } } : {}),
        ...(kind === 'tenant' ? { tenant_id: 'tenant-b' } : {}),
      };
      if (kind === 'token') request.packets[0].executorSessionToken = 'user-login-token';
      if (kind === 'path') request.packets[0].transferId = '../../outside';
      if (kind === 'session' || kind === 'task') {
        await stage(f.service, request);
        await expect(f.service.create(request.commit, p)).rejects.toThrow(/scope/);
      } else {
        await expect(f.service.create(request.packets[0], p)).rejects.toThrow();
        expect(await readdir(f.root)).toEqual([]);
      }
      expect(f.messages.create).not.toHaveBeenCalled();
    }
  );

  it('rejects out of order, conflicting retries, incomplete and corrupted data', async () => {
    const f = await fixture();
    const request = transfer(message());
    await expect(f.service.create(request.packets[1], params)).rejects.toThrow(/offset zero/);
    await f.service.create(request.packets[0], params);
    await expect(f.service.create(request.commit, params)).rejects.toThrow(/integrity/);
    const first = request.packets[0];
    if (first.action !== 'append') throw new Error('expected chunk');
    await expect(
      f.service.create(
        { ...first, chunk: Buffer.alloc(EXECUTOR_TRANSCRIPT_CHUNK_BYTES, 120).toString('base64') },
        params
      )
    ).rejects.toThrow(/changed/);
    const corrupted = transfer(message());
    for (const packet of [...corrupted.packets, corrupted.commit])
      if (packet.action !== 'abort') packet.sha256 = '0'.repeat(64);
    await stage(f.service, corrupted);
    await expect(f.service.create(corrupted.commit, params)).rejects.toThrow(/integrity/);
    expect(f.messages.create).not.toHaveBeenCalled();
  });

  it('expires abandoned staging and receipts and removes an aborted transfer', async () => {
    const f = await fixture();
    const request = transfer(message());
    await f.service.create(request.packets[0], params);
    await f.service.create(
      {
        action: 'abort',
        transferId: request.commit.transferId,
        executorSessionToken: 'executor-proof',
      },
      params
    );
    expect(await readdir(f.root)).toEqual([]);
    await stage(f.service, request);
    const [directory] = await readdir(f.root);
    await utimes(path.join(f.root, directory, 'state.json'), new Date(0), new Date(0));
    await f.service.cleanupExpired();
    expect(await readdir(f.root)).toEqual([]);
  });

  it('passes a message larger than 10 MB through an actual 1 MB Socket.IO connection', async () => {
    const f = await fixture();
    const app = feathersExpress(feathers());
    app.configure(socketio({ maxHttpBufferSize: SOCKET_IO_MAX_BUFFER_SIZE_BYTES }));
    app.use('executor-transcripts', f.service, { methods: ['create'] });
    app.service('executor-transcripts').hooks({
      before: {
        all: [
          async (context) => {
            Object.assign(context.params, params);
            return context;
          },
        ],
      },
    });
    app.service('executor-transcripts').publish(() => []);
    const server = await app.listen(0, '127.0.0.1');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP address missing');
    const client = createClient(`http://127.0.0.1:${address.port}`, true, { ackTimeout: 5000 });
    try {
      const data = message('完整记录😀\n'.repeat(650_000));
      const request = transfer(data);
      expect(request.commit.action !== 'abort' && request.commit.totalBytes).toBeGreaterThan(
        10 * 1024 * 1024
      );
      for (const packet of request.packets)
        await client.service('executor-transcripts').create(packet);
      const response: ExecutorTranscriptResponse = await client
        .service('executor-transcripts')
        .create(request.commit);
      expect(response.message).toEqual(data);
      expect(client.io.connected).toBe(true);
    } finally {
      client.io.disconnect();
      await app.teardown();
    }
  }, 30_000);

  it('only exposes the create transport method to scoped executor tokens', async () => {
    const context = {
      path: 'executor-transcripts',
      method: 'create',
      params: {
        ...params,
        authentication: {
          payload: { type: 'executor-session', purpose: 'executor-task', ...scope },
        },
      },
    };
    await expect(executorRuntimeScopeGuard()(context as never)).resolves.toBe(context);
    await expect(
      executorRuntimeScopeGuard()({ ...context, method: 'find' } as never)
    ).rejects.toThrow(/not valid/);
  });
});
