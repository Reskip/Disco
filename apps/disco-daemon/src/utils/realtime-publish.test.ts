import { REALTIME_RELAY_VERSION } from '@disco/core/realtime';
import type { User, UUID } from '@disco/core/types';
import { ROLES } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeAccessCache } from './realtime-access-cache';
import {
  configureRealtimePublish,
  executorTaskChannelName,
  leaveAllSessionStreamChannels,
  markConnectionSessionStreamsAware,
  REDIS_FEATHERS_DENIED_PATHS,
  sessionStreamChannelName,
} from './realtime-publish';

class FakeChannel {
  constructor(public connections: unknown[]) {}
  get length() {
    return this.connections.length;
  }
  filter(fn: (connection: unknown) => boolean) {
    return new FakeChannel(this.connections.filter(fn));
  }
  join(connection: unknown) {
    if (!this.connections.includes(connection)) this.connections.push(connection);
  }
  leave(connection: unknown) {
    this.connections = this.connections.filter((candidate) => candidate !== connection);
  }
}

function makeApp(
  connections: unknown[],
  services: Record<string, { get: (id: string) => Promise<unknown> }> = {},
  initialChannels: Record<string, unknown[]> = {}
) {
  let publishFn: ((data: unknown, context: any) => unknown) | undefined;
  const channels = new Map(
    Object.entries(initialChannels).map(([name, members]) => [name, new FakeChannel([...members])])
  );
  const app = {
    get channels() {
      return [...channels.keys()];
    },
    channel: vi.fn((name: string) => {
      let channel = channels.get(name);
      if (!channel) {
        channel = new FakeChannel(name === 'authenticated' ? [...connections] : []);
        channels.set(name, channel);
      }
      return channel;
    }),
    publish: vi.fn((fn) => {
      publishFn = fn;
    }),
    emit: vi.fn(),
    service: vi.fn((path: string) => {
      const service = services[path];
      if (!service) throw new Error(`Unexpected service: ${path}`);
      return service;
    }),
    async runPublish(data: unknown, context: any) {
      if (!publishFn) throw new Error('publish not configured');
      return publishFn(data, { ...context, app });
    },
  } as any;
  return app;
}

function user(id: string, role = ROLES.MEMBER): User {
  return { user_id: id, role } as User;
}

function serviceConnection() {
  return { user: { _isServiceAccount: true, role: 'service' } };
}

function ownerAccess(ownerId: string | null = 'owner') {
  const findCreatedByBySessionId = vi.fn(async () => ownerId as UUID | null);
  const accessCache = new RealtimeAccessCache({
    sessionsRepository: { findCreatedByBySessionId },
  });
  return { accessCache, findCreatedByBySessionId };
}

function configure(app: any, ownerId: string | null = 'owner', extra: Record<string, unknown> = {}) {
  const owner = ownerAccess(ownerId);
  configureRealtimePublish({
    app,
    sessionsRepository: {} as never,
    accessCache: owner.accessCache,
    ...extra,
  });
  return owner;
}

function unionConnections(result: unknown): unknown[] {
  const channels = Array.isArray(result) ? result : [result];
  return [
    ...new Set(
      channels.flatMap((channel) => ((channel as FakeChannel | undefined)?.connections ?? []))
    ),
  ];
}

describe('configureRealtimePublish direct Session ownership', () => {
  it('delivers Session events only to the creator and service accounts', async () => {
    const owner = { user: user('owner') };
    const member = { user: user('member') };
    const admin = { user: user('admin', ROLES.ADMIN) };
    const superadmin = { user: user('superadmin', ROLES.SUPERADMIN) };
    const service = serviceConnection();
    const app = makeApp([owner, member, admin, superadmin, service]);
    configure(app);

    const result = await app.runPublish(
      { session_id: 'session-1', created_by: 'owner' },
      { path: 'sessions', method: 'patch', event: 'patched', params: {} }
    );

    expect(unionConnections(result)).toEqual([owner, service]);
  });

  it('resolves message and task events through their Session owner', async () => {
    const owner = { user: user('owner') };
    const other = { user: user('other') };
    const app = makeApp([owner, other]);
    configure(app);

    const messageResult = await app.runPublish(
      { message_id: 'message-1', session_id: 'session-1' },
      { path: 'messages', method: 'create', event: 'created', params: {} }
    );
    const taskResult = await app.runPublish(
      { task_id: 'task-1', session_id: 'session-1' },
      { path: 'tasks', method: 'patch', event: 'patched', params: {} }
    );

    expect(unionConnections(messageResult)).toEqual([owner]);
    expect(unionConnections(taskResult)).toEqual([owner]);
  });

  it('resolves indirect task and message ids without consulting Branch state', async () => {
    const owner = { user: user('owner') };
    const other = { user: user('other') };
    const app = makeApp([owner, other], {
      tasks: { get: vi.fn(async () => ({ session_id: 'session-1' })) },
      messages: { get: vi.fn(async () => ({ session_id: 'session-1' })) },
    });
    configure(app);

    const fromTask = await app.runPublish(
      { task_id: 'task-1' },
      { path: 'tasks', method: 'patch', event: 'patched', params: {} }
    );
    const fromMessage = await app.runPublish(
      { message_id: 'message-1' },
      { path: 'messages', method: 'patch', event: 'patched', params: {} }
    );

    expect(unionConnections(fromTask)).toEqual([owner]);
    expect(unionConnections(fromMessage)).toEqual([owner]);
  });

  it('fails closed to services when the Session owner is missing', async () => {
    const browser = { user: user('browser') };
    const service = serviceConnection();
    const app = makeApp([browser, service]);
    configure(app, null);

    const result = await app.runPublish(
      { message_id: 'message-1', session_id: 'missing' },
      { path: 'messages', method: 'create', event: 'created', params: {} }
    );

    expect(unionConnections(result)).toEqual([service]);
  });

  it('keeps unrelated control-plane events tenant-wide', async () => {
    const first = { user: user('first') };
    const second = { user: user('second') };
    const app = makeApp([first, second]);
    configure(app);

    const result = await app.runPublish(
      { setting_id: 'setting-1' },
      { path: 'settings', method: 'patch', event: 'patched', params: {} }
    );

    expect(unionConnections(result)).toEqual([first, second]);
  });
});

describe('configureRealtimePublish streaming scope', () => {
  const context = {
    path: 'messages',
    method: 'create',
    event: 'streaming:chunk',
    params: {},
  };

  it('filters a forged room subscription back to the Session creator', async () => {
    const owner = { user: user('owner') };
    const intruder = { user: user('intruder') };
    const app = makeApp(
      [owner, intruder],
      {},
      {
        authenticated: [owner, intruder],
        [sessionStreamChannelName('session-1')]: [owner, intruder],
      }
    );
    configure(app);

    const result = await app.runPublish(
      { session_id: 'session-1', message_id: 'message-1', chunk: 'secret' },
      context
    );

    expect(unionConnections(result)).toEqual([owner]);
  });

  it('delivers to an unsubscribed owner fallback and service account only', async () => {
    const owner = { user: user('owner') };
    const other = { user: user('other') };
    const service = serviceConnection();
    const app = makeApp([owner, other, service], {}, { authenticated: [owner, other, service] });
    configure(app);

    const result = await app.runPublish(
      { session_id: 'session-1', message_id: 'message-1', chunk: 'secret' },
      context
    );

    expect(unionConnections(result)).toEqual([service, owner]);
    expect(app.channels).not.toContain(sessionStreamChannelName('session-1'));
  });

  it('does not send idle streaming traffic to an owner that announced room awareness', async () => {
    const owner = { user: user('owner') };
    markConnectionSessionStreamsAware(owner);
    const app = makeApp([owner], {}, { authenticated: [owner] });
    configure(app);

    const result = await app.runPublish(
      { session_id: 'session-1', message_id: 'message-1', chunk: 'secret' },
      context
    );

    expect(unionConnections(result)).toEqual([]);
  });

  it('delivers once to an aware owner that subscribed to the Session room', async () => {
    const owner = { user: user('owner') };
    markConnectionSessionStreamsAware(owner);
    const app = makeApp(
      [owner],
      {},
      { authenticated: [owner], [sessionStreamChannelName('session-1')]: [owner] }
    );
    configure(app);

    const result = await app.runPublish(
      { session_id: 'session-1', message_id: 'message-1', chunk: 'secret' },
      context
    );
    const raw = (Array.isArray(result) ? result : [result]).flatMap(
      (channel) => (channel as FakeChannel).connections
    );

    expect(raw.filter((connection) => connection === owner)).toHaveLength(1);
  });

  it('caches the Session owner across repeated chunks', async () => {
    const owner = { user: user('owner') };
    const app = makeApp([owner], {}, { authenticated: [owner] });
    const access = configure(app);

    await app.runPublish({ session_id: 'session-1', chunk: 'a' }, context);
    await app.runPublish({ session_id: 'session-1', chunk: 'b' }, context);

    expect(access.findCreatedByBySessionId).toHaveBeenCalledTimes(1);
  });

  it('fails closed to service accounts when a streaming event lacks a Session id', async () => {
    const browser = { user: user('browser') };
    const service = serviceConnection();
    const app = makeApp([browser, service]);
    configure(app);

    const result = await app.runPublish({ message_id: 'message-1', chunk: 'orphan' }, context);

    expect(unionConnections(result)).toEqual([service]);
  });
});

describe('configureRealtimePublish executor and tenant boundaries', () => {
  it('routes termination only to the private tenant Task room', async () => {
    const browser = { user: user('browser') };
    const executor = serviceConnection();
    const room = executorTaskChannelName('tenant-a', 'task-1');
    const app = makeApp([browser, executor], {}, { [room]: [executor] });
    configure(app, 'owner', {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' },
    });

    const result = await app.runPublish(
      { task_id: 'task-1', status: 'stopping' },
      { path: 'tasks', method: 'patch', event: 'termination_requested', params: {} }
    );

    expect(unionConnections(result)).toEqual([executor]);
  });

  it('does not materialize an executor room that has no connected executor', async () => {
    const app = makeApp([]);
    configure(app, 'owner', {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' },
    });

    const result = await app.runPublish(
      { task_id: 'task-1', status: 'stopping' },
      { path: 'tasks', method: 'patch', event: 'termination_requested', params: {} }
    );

    expect(result).toEqual([]);
    expect(app.channels).not.toContain(executorTaskChannelName('tenant-a', 'task-1'));
  });

  it('fails closed when required tenant context is absent', async () => {
    const browser = { user: user('browser') };
    const service = serviceConnection();
    const app = makeApp([browser, service]);
    configure(app, 'owner', {
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused',
        auth_claim: 'tenant_id',
      },
    });

    const result = await app.runPublish(
      { session_id: 'session-1', created_by: 'owner' },
      { path: 'sessions', method: 'patch', event: 'patched', params: {} }
    );

    expect(unionConnections(result)).toEqual([service]);
  });
});

describe('HA publication relay', () => {
  it('re-authorizes a relayed Session event against the local owner', async () => {
    const owner = { user: user('owner') };
    const other = { user: user('other') };
    let receive: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        receive = handler;
      }),
    };
    const app = makeApp(
      [owner, other],
      {},
      { 'tenant:tenant-a': [owner, other], authenticated: [owner, other] }
    );
    configure(app, 'owner', {
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused',
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
    });

    await receive?.({
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'sessions',
      event: 'patched',
      method: 'patch',
      id: 'session-1',
      data: { session_id: 'session-1', created_by: 'owner' },
    });

    expect(app.emit).toHaveBeenCalledOnce();
    expect((app.emit.mock.calls[0]?.[2] as FakeChannel).connections).toEqual([owner]);
  });

  it('does not relay credential or authentication services', async () => {
    const relay = { relay: vi.fn(), setRelayHandler: vi.fn() };
    const app = makeApp([], {}, { 'tenant:tenant-a': [] });
    configure(app, 'owner', {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' },
      realtimeRelay: relay,
    });

    await app.runPublish(
      { accessToken: 'secret' },
      { path: 'authentication', method: 'create', event: 'created', params: {} }
    );

    expect(REDIS_FEATHERS_DENIED_PATHS.has('authentication')).toBe(true);
    expect(relay.relay).not.toHaveBeenCalled();
  });
});

describe('session stream room cleanup', () => {
  it('leaves every Session stream room and no unrelated room', () => {
    const connection = { user: user('owner') };
    const app = makeApp(
      [connection],
      {},
      {
        [sessionStreamChannelName('session-1')]: [connection],
        [sessionStreamChannelName('session-2')]: [connection],
        authenticated: [connection],
      }
    );

    leaveAllSessionStreamChannels(app, connection);

    expect(app.channel(sessionStreamChannelName('session-1')).connections).toEqual([]);
    expect(app.channel(sessionStreamChannelName('session-2')).connections).toEqual([]);
    expect(app.channel('authenticated').connections).toEqual([connection]);
  });
});
