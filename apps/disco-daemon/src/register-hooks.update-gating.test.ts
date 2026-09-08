import { feathers, feathersExpress, rest } from '@disco/core/feathers';
import type { HookContext } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks';
import { SCHEDULES_SERVICE_TRANSPORT_METHODS } from './services/schedules';
import { TASKS_SERVICE_TRANSPORT_METHODS } from './services/tasks';
import { USERS_SERVICE_TRANSPORT_METHODS } from './services/users';

type RegisteredHook = (context: HookContext) => unknown;
type CapturedHooks = { before: Record<string, RegisteredHook[]> };

function captureRegisteredHooks(): Map<string, CapturedHooks> {
  const captured = new Map<string, CapturedHooks>();
  const app = {
    service(path: string) {
      return {
        hooks(hooks: { before?: Record<string, RegisteredHook[]> }) {
          const key = path.replace(/^\//, '');
          const entry = captured.get(key) ?? { before: {} };
          for (const [method, chain] of Object.entries(hooks.before ?? {})) {
            entry.before[method] = [...(entry.before[method] ?? []), ...(chain ?? [])];
          }
          captured.set(key, entry);
        },
      };
    },
    use() {},
    publish() {},
  };

  registerHooks({
    db: {} as RegisterHooksContext['db'],
    app: app as unknown as RegisterHooksContext['app'],
    config: {
      database: { dialect: 'postgresql' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'update-gating-test' },
      execution: { branch_rbac: false },
    } as RegisterHooksContext['config'],
    jwtSecret: 'update-gating-test-secret',
    deployment: { mode: 'standalone' },
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });

  return captured;
}

const WRITE_METHODS = ['create', 'patch', 'remove'] as const;
const UPDATE_NOT_ROUTED: Record<string, string | readonly string[]> = {
  'agentic-tool-presets': 'custom service has no update method',
  'agentic-tool-settings': 'custom service has no update method',
  schedules: SCHEDULES_SERVICE_TRANSPORT_METHODS,
  tasks: TASKS_SERVICE_TRANSPORT_METHODS,
  users: USERS_SERVICE_TRANSPORT_METHODS,
};

function findUngated(captured: Map<string, CapturedHooks>): string[] {
  const ungated: string[] = [];
  for (const [path, hooks] of captured) {
    const gatedSiblings = WRITE_METHODS.filter((method) => hooks.before[method]?.length);
    if (gatedSiblings.length === 0 || hooks.before.update?.length || path in UPDATE_NOT_ROUTED) {
      continue;
    }
    ungated.push(`${path} (gates ${gatedSiblings.join('/')})`);
  }
  return ungated;
}

describe('current service update gating', () => {
  const captured = captureRegisteredHooks();

  it('does not register retired architecture services', () => {
    for (const path of [
      'repos',
      'branches',
      'boards',
      'cards',
      'card-types',
      'artifacts',
      'board-comments',
    ]) {
      expect(captured.has(path), `${path} must stay retired`).toBe(false);
    }
  });

  it('gates update wherever a current service gates sibling writes', () => {
    expect(findUngated(captured)).toEqual([]);
  });

  it('keeps every explicit no-update exemption attached to a current service', () => {
    for (const [path, reason] of Object.entries(UPDATE_NOT_ROUTED)) {
      expect(captured.has(path), `${path} no longer registers hooks; remove ${String(reason)}`).toBe(
        true
      );
      expect(captured.get(path)?.before.update ?? []).toEqual([]);
    }
  });

  it('holds sessions.update to the same authorization chain as sessions.patch', () => {
    const sessions = captured.get('sessions');
    expect(sessions?.before.update).not.toBe(sessions?.before.patch);
    expect(sessions?.before.update).toEqual(sessions?.before.patch);
    expect(sessions?.before.update?.length).toBeGreaterThan(0);
  });

  it.each(
    Object.entries(UPDATE_NOT_ROUTED).filter(
      (entry): entry is [string, readonly string[]] => Array.isArray(entry[1])
    )
  )('%s transport omits update', (_path, methods) => {
    expect(methods).not.toContain('update');
  });
});

describe('Feathers method-list enforcement', () => {
  it('refuses PUT when the exposed methods omit update', async () => {
    const service = {
      async get(id: string) {
        return { id };
      },
      async update(id: string, data: Record<string, unknown>) {
        return { id, ...data };
      },
    };
    const app = feathersExpress(feathers());
    app.configure(rest());
    app.use('/narrowed', service, { methods: ['get'] });
    app.use('/wide', service);
    const server = await app.listen(0);
    const { port } = server.address() as { port: number };
    const put = (path: string) =>
      fetch(`http://127.0.0.1:${port}/${path}/1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    try {
      expect((await put('narrowed')).status).toBe(405);
      expect((await put('wide')).status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
