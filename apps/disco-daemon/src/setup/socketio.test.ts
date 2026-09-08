import { SOCKET_IO_MAX_BUFFER_SIZE_BYTES } from '@disco/core/config';
import type { Application } from '@disco/core/feathers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueRuntimeToken } from '../auth/runtime-tokens';
import { tenantChannelName, tenantUserChannelName } from '../realtime/routing';
import { executorTaskChannelName } from '../utils/realtime-publish';
import {
  configureChannels,
  createSocketIOConfig,
  getSocketAuthState,
  type SocketIOOptions,
} from './socketio';

type Handler = (...args: any[]) => any;

function makeSocket(id = 'socket-a') {
  const handlers = new Map<string, Handler>();
  const joined = new Set<string>();
  return {
    id,
    data: {} as Record<string, any>,
    feathers: undefined as any,
    tenant: undefined as any,
    handshake: { auth: {} as Record<string, string>, headers: {} as Record<string, string> },
    rooms: joined,
    connected: true,
    received: [] as Array<{ event: string; payload: unknown }>,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit(event: string, payload: unknown) {
      this.received.push({ event, payload });
    },
    join: vi.fn((room: string) => joined.add(room)),
    leave: vi.fn((room: string) => joined.delete(room)),
    handlers,
  };
}

function makeIO() {
  let connectionHandler: Handler | undefined;
  const middlewares: Handler[] = [];
  let closeHandler: (() => void) | undefined;
  return {
    sockets: { sockets: new Map<string, ReturnType<typeof makeSocket>>() },
    engine: {
      once: (event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      },
    },
    use: (handler: Handler) => middlewares.push(handler),
    on: (event: string, handler: Handler) => {
      if (event === 'connection') connectionHandler = handler;
    },
    middlewares,
    connect(socket: ReturnType<typeof makeSocket>) {
      this.sockets.sockets.set(socket.id, socket);
      connectionHandler?.(socket);
    },
    close: () => closeHandler?.(),
  };
}

function makeApp() {
  const handlers = new Map<string, Handler>();
  const channelMap = new Map<
    string,
    { join: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> }
  >();
  const app = {
    service: vi.fn(() => ({
      get: vi.fn(async (id: string) => ({
        user_id: id,
        username: `user-${id}`,
        role: 'member',
      })),
    })),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    channel: (name: string) => {
      let channel = channelMap.get(name);
      if (!channel) {
        channel = { join: vi.fn(), leave: vi.fn() };
        channelMap.set(name, channel);
      }
      return channel;
    },
    handlers,
    channelMap,
    get channels() {
      return [...channelMap.keys()];
    },
  };
  return app;
}

const staticTenancy = {
  mode: 'static' as const,
  static_tenant_id: 'tenant-a' as never,
};
const openIO = new Set<ReturnType<typeof makeIO>>();

function buildHarness(options: Partial<SocketIOOptions> = {}) {
  const app = makeApp();
  const io = makeIO();
  const config = createSocketIOConfig(app as unknown as Application, {
    corsOrigin: '*',
    jwtSecret: 'test-secret',
    credentialsAllowed: false,
    multiTenancy: staticTenancy,
    ...options,
  });
  config.callback(io as never);
  openIO.add(io);
  return { app, io, config };
}

afterEach(() => {
  for (const io of openIO) io.close();
  openIO.clear();
});

describe('current Socket.IO transport', () => {
  it('advertises the configured CORS policy and shared buffer ceiling', () => {
    const { config } = buildHarness();
    expect(config.serverOptions).toMatchObject({
      cors: { origin: '*', credentials: false },
      maxHttpBufferSize: SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
    });
  });

  it('allows an anonymous connection only so the login flow can run', async () => {
    const { io } = buildHarness();
    const socket = makeSocket();
    const next = vi.fn();
    await io.middlewares[0]?.(socket, next);
    expect(next).toHaveBeenCalledWith();
    expect(getSocketAuthState(socket as never)).toEqual({ userId: null, isService: false });
  });

  it('authenticates a user token, resolves its tenant, and joins only current rooms', async () => {
    const { io } = buildHarness({
      buildInfo: { sha: 'abc123', builtAt: '2026-08-29T00:00:00.000Z' },
    });
    const socket = makeSocket();
    socket.handshake.auth.token = issueRuntimeToken(
      { sub: 'user-a', type: 'access' },
      'test-secret',
      '5m'
    );
    const next = vi.fn();
    await io.middlewares[0]?.(socket, next);
    expect(next).toHaveBeenCalledWith();
    expect(getSocketAuthState(socket as never)).toMatchObject({
      userId: 'user-a',
      isService: false,
      tenant: { tenant_id: 'tenant-a' },
    });

    io.connect(socket);
    expect(socket.join).toHaveBeenCalledWith(tenantChannelName('tenant-a'));
    expect(socket.join).toHaveBeenCalledWith(tenantUserChannelName('tenant-a', 'user-a'));
    expect(socket.received).toContainEqual({
      event: 'server-info',
      payload: { buildSha: 'abc123', builtAt: '2026-08-29T00:00:00.000Z' },
    });
    expect([...socket.handlers.keys()].sort()).toEqual(['disconnect', 'error']);
  });

  it('authenticates executor service tokens without joining user rooms', async () => {
    const { io } = buildHarness();
    const socket = makeSocket();
    socket.handshake.auth.token = issueRuntimeToken(
      { sub: 'executor-service', type: 'service', purpose: 'executor-service' },
      'test-secret',
      '5m'
    );
    const next = vi.fn();
    await io.middlewares[0]?.(socket, next);
    io.connect(socket);
    expect(next).toHaveBeenCalledWith();
    expect(getSocketAuthState(socket as never)).toMatchObject({
      userId: null,
      isService: true,
      tenant: { tenant_id: 'tenant-a' },
    });
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('rejects an invalid runtime token', async () => {
    const { io } = buildHarness();
    const socket = makeSocket();
    socket.handshake.auth.token = 'not-a-token';
    const next = vi.fn();
    await io.middlewares[0]?.(socket, next);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('replaces raw tenant rooms on login and clears them on logout', async () => {
    const { app, io } = buildHarness();
    const socket = makeSocket();
    const connection = {};
    socket.feathers = connection;
    socket.rooms.add('tenant:old');
    io.connect(socket);

    app.handlers.get('login')?.(
      { user: { user_id: 'user-a', role: 'member' } },
      { connection, params: { tenant: { tenant_id: 'tenant-a' } } }
    );
    expect(socket.leave).toHaveBeenCalledWith('tenant:old');
    expect(socket.join).toHaveBeenCalledWith(tenantChannelName('tenant-a'));
    expect(socket.join).toHaveBeenCalledWith(tenantUserChannelName('tenant-a', 'user-a'));

    app.handlers.get('logout')?.({}, { connection });
    expect(socket.rooms.has(tenantChannelName('tenant-a'))).toBe(false);
    expect(socket.rooms.has(tenantUserChannelName('tenant-a', 'user-a'))).toBe(false);
  });
});

describe('Feathers publication channels', () => {
  it('joins authenticated tenant/user channels and the signed task control room', () => {
    const app = makeApp();
    configureChannels(app as unknown as Application, { multiTenancy: staticTenancy });
    const connection = { data: {} };
    const taskId = '019fe5bc-65cf-7095-b160-454363604446';
    app.handlers.get('login')?.(
      {
        user: { user_id: 'user-a' },
        task_id: taskId,
        authentication: {
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            task_id: taskId,
          },
        },
      },
      { connection, params: { tenant: { tenant_id: 'tenant-a' } } }
    );

    expect(app.channelMap.get('authenticated')?.join).toHaveBeenCalledWith(connection);
    expect(app.channelMap.get(tenantChannelName('tenant-a'))?.join).toHaveBeenCalledWith(connection);
    expect(app.channelMap.get(tenantUserChannelName('tenant-a', 'user-a'))?.join).toHaveBeenCalledWith(
      connection
    );
    expect(app.channelMap.get(executorTaskChannelName('tenant-a', taskId))?.join).toHaveBeenCalledWith(
      connection
    );
  });

  it('removes every current channel family on logout', () => {
    const app = makeApp();
    configureChannels(app as unknown as Application, { multiTenancy: staticTenancy });
    const connection = { data: { tenant: { tenant_id: 'tenant-a' } } };
    app.handlers.get('logout')?.({}, { connection });
    expect(app.channelMap.get('authenticated')?.leave).toHaveBeenCalledWith(connection);
    expect(connection.data.tenant).toBeUndefined();
  });
});
