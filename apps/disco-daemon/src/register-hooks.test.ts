/** Focused regression tests for the active Session-owned hook surface. */

import path from 'node:path';
import { type HookContext, TaskStatus } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';

import {
  CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES,
  enrichSessionFindResultWithRemoteRelationships,
  getTrustedSessionTenantId,
  isPromptFlowPatchOnly,
  PROMPT_FLOW_PATCH_FIELDS,
  protectExternalTaskCreate,
  protectFilesystemHomeWrite,
  protectSuperadminTargetFromAdmin,
  protectServerManagedTaskWrites,
  type RegisterHooksContext,
  registerHooks,
  shouldDrainQueueAfterSessionPostTurnPatch,
  shouldRunSessionPostTurnHooks,
  TENANT_IDENTITY_ONLY_SERVICE_PATHS,
  TENANT_OWNED_SERVICE_PATHS,
} from './register-hooks';
import { canReceiveMcpTokenForSession } from './utils/mcp-token-authorization';

const makeSession = (sessionId: string): import('@disco/core/types').Session =>
  ({
    session_id: sessionId,
    created_by: 'user-1',
    working_directory: path.resolve('sessions', sessionId),
    status: 'idle',
    agentic_tool: 'codex',
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-01T00:00:00.000Z',
    tasks: [],
    genealogy: { children: [] },
    contextFiles: [],
    is_scheduled: false,
    ready_for_prompt: false,
    archived: false,
  }) as import('@disco/core/types').Session;

describe('protectFilesystemHomeWrite', () => {
  const dataHome = path.resolve('test-data', 'disco');
  const config = { paths: { data_home: dataHome } };
  const context = (
    role: string | undefined,
    filesystem_home: unknown,
    provider: string | null = 'rest'
  ) =>
    ({
      data: { filesystem_home },
      params: {
        provider,
        user: role ? { user_id: 'user-1', role } : undefined,
      },
    }) as unknown as import('@disco/core/types').HookContext;

  it('rejects a member changing their own host home path', () => {
    expect(() =>
      protectFilesystemHomeWrite(context('member', path.resolve('test-home', 'member')), config)
    ).toThrow(
      'Only admins can modify filesystem_home'
    );
  });

  it('allows an admin to set a validated absolute path', () => {
    const home = path.resolve('test-home', 'member');
    const hook = context('admin', home);
    expect(protectFilesystemHomeWrite(hook, config)).toBe(hook);
    expect(hook.data).toEqual({ filesystem_home: home });
  });

  it('validates trusted internal writes against the effective data root', () => {
    expect(() =>
      protectFilesystemHomeWrite(
        context(undefined, path.join(dataHome, 'tenants', 't1'), null),
        config
      )
    ).toThrow(/must not overlap/);
  });

  it('also rejects homes overlapping a configured external tenants base', () => {
    const tenantsBase = path.resolve('test-data', 'tenants');
    expect(() =>
      protectFilesystemHomeWrite(context('admin', path.join(tenantsBase, 'tenant-a', 'user-1')), {
        paths: { data_home: dataHome },
        multi_tenancy: {
          filesystem_isolation_enabled: true,
          tenants_base_folder: tenantsBase,
        },
      })
    ).toThrow(/must not overlap/);
  });
});

describe('protectSuperadminTargetFromAdmin', () => {
  const context = (callerRole: 'admin' | 'superadmin', provider: string | null = 'rest') =>
    ({
      id: 'superadmin-1',
      params: {
        provider,
        user: { user_id: `${callerRole}-caller`, role: callerRole },
      },
    }) as unknown as HookContext;

  const usersService = (targetRole: 'admin' | 'superadmin') => ({
    get: vi.fn(async () => ({ user_id: 'superadmin-1', role: targetRole })),
  });

  it('returns 403 when an admin attempts to mutate a superadministrator', async () => {
    await expect(
      protectSuperadminTargetFromAdmin(context('admin'), usersService('superadmin') as never)
    ).rejects.toMatchObject({ name: 'Forbidden', code: 403 });
  });

  it('allows a superadministrator to manage another superadministrator', async () => {
    const hook = context('superadmin');
    await expect(
      protectSuperadminTargetFromAdmin(hook, usersService('superadmin') as never)
    ).resolves.toBe(hook);
  });

  it('allows an administrator to manage a lower-privilege account', async () => {
    const hook = context('admin');
    await expect(
      protectSuperadminTargetFromAdmin(hook, usersService('admin') as never)
    ).resolves.toBe(hook);
  });
});

describe('protectExternalTaskCreate', () => {
  const context = (data: unknown, provider: string | null = 'rest') =>
    ({ data, params: { provider } }) as import('@disco/core/types').HookContext;

  it('preserves the documented dormant create/run contract', () => {
    const hook = context({ session_id: 'session-1', full_prompt: 'hello' });
    expect(protectExternalTaskCreate(hook)).toBe(hook);
    expect(hook.data).toEqual({
      session_id: 'session-1',
      full_prompt: 'hello',
      status: TaskStatus.CREATED,
    });
  });

  it.each(['running', 'queued', 'completed'])('rejects externally forged status %s', (status) => {
    expect(() =>
      protectExternalTaskCreate(context({ session_id: 'session-1', full_prompt: 'hello', status }))
    ).toThrow('must use status created');
  });

  it('rejects lifecycle and identity fields outside the create contract', () => {
    expect(() =>
      protectExternalTaskCreate(
        context({ session_id: 'session-1', full_prompt: 'hello', created_by: 'forged' })
      )
    ).toThrow('not client-managed');
  });

  it('leaves trusted internal task creation unchanged', () => {
    const hook = context({ status: TaskStatus.RUNNING }, null);
    expect(protectExternalTaskCreate(hook)).toBe(hook);
    expect(hook.data).toEqual({ status: TaskStatus.RUNNING });
  });
});

describe('protectServerManagedTaskWrites', () => {
  const executorPayload = {
    type: 'executor-session',
    purpose: 'executor-task',
    session_id: 'session-1',
    task_id: 'task-1',
  };
  const externalContext = (
    method: 'patch',
    data: unknown,
    options: {
      taskId?: string;
      executorTaskId?: string;
    } = {}
  ): import('@disco/core/types').HookContext =>
    ({
      path: 'tasks',
      method,
      id: options.taskId,
      data,
      params: {
        provider: 'rest',
        ...(options.executorTaskId
          ? {
              authentication: {
                payload: { ...executorPayload, task_id: options.executorTaskId },
              },
            }
          : {}),
      },
    }) as import('@disco/core/types').HookContext;

  it('rejects every normal-user patch, including terminality', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext('patch', { status: TaskStatus.COMPLETED }, { taskId: 'task-1' })
      )
    ).rejects.toThrow('executor token scoped to this task');
  });

  it('rejects an executor token scoped to another task', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext(
          'patch',
          { status: TaskStatus.COMPLETED },
          { taskId: 'task-1', executorTaskId: 'task-2' }
        )
      )
    ).rejects.toThrow('executor token scoped to this task');
  });

  it.each(['task_id', 'session_id', 'created_by', 'queue_position', 'sdk_failure'])(
    'rejects executor patch field %s outside the result allowlist',
    async (field) => {
      await expect(
        protectServerManagedTaskWrites(
          externalContext(
            'patch',
            { [field]: 'forged' },
            {
              taskId: 'task-1',
              executorTaskId: 'task-1',
            }
          )
        )
      ).rejects.toThrow('not executor-managed');
    }
  );

  it('allows a task-scoped executor to publish bounded result fields', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext(
          'patch',
          {
            status: TaskStatus.COMPLETED,
            completed_at: '2026-07-10T20:00:00.000Z',
            model: 'test-model',
            git_state: { sha_at_end: 'abc' },
          },
          {
            taskId: 'task-1',
            executorTaskId: 'task-1',
          }
        )
      )
    ).resolves.toBeDefined();
  });

  it.each([TaskStatus.AWAITING_PERMISSION, TaskStatus.AWAITING_INPUT])(
    'allows a scoped executor to request resume from %s',
    async () => {
      const context = externalContext(
        'patch',
        { status: TaskStatus.RUNNING },
        {
          taskId: 'task-1',
          executorTaskId: 'task-1',
        }
      );

      await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
    }
  );

  it('preserves trusted internal direct-to-running task writes', async () => {
    const context = externalContext('patch', {
      status: TaskStatus.RUNNING,
    });
    context.params.provider = undefined;

    await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
  });

  it('preserves trusted internal dispatching task writes', async () => {
    const context = externalContext('patch', {
      status: TaskStatus.DISPATCHING,
    });
    context.params.provider = undefined;

    await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
  });
});

describe('tenant-owned service registration', () => {
  type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;
  type RegisteredHooks = {
    before?: Partial<Record<'all' | 'create', RegisteredHook[]>>;
  };

  const captureScheduleRegistrations = (): RegisteredHooks[] => {
    const registrations: RegisteredHooks[] = [];
    const app = {
      service(path: string) {
        return {
          hooks(hooks: RegisteredHooks) {
            if (path.replace(/^\//, '') === 'schedules') registrations.push(hooks);
          },
        };
      },
      use() {},
      publish() {},
    };

    registerHooks({
      db: {} as RegisterHooksContext['db'],
      app: app as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
      } as RegisterHooksContext['config'],
      jwtSecret: 'registration-test-secret',
      requireAuth: async (context) => context,
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });

    return registrations;
  };

  const runRegisteredScheduleCreateBeforeHooks = async (
    registrations: RegisteredHooks[]
  ): Promise<HookContext> => {
    const context = {
      path: 'schedules',
      method: 'create',
      data: {
        name: 'Nightly',
        cron_expression: '0 0 * * *',
        timezone_mode: 'utc',
        prompt: 'Run',
        agentic_tool_config: { agentic_tool: 'codex' },
      },
      params: {
        provider: 'rest',
        user: { user_id: 'registration-test-user', role: 'member' },
      },
    } as HookContext;

    for (const registration of registrations) {
      for (const hook of registration.before?.all ?? []) {
        await hook(context);
      }
    }

    for (const registration of registrations) {
      for (const hook of registration.before?.create ?? []) {
        await hook(context);
      }
    }

    return context;
  };

  it('keeps schedule create DTOs valid through the registered tenant hook', async () => {
    const context = await runRegisteredScheduleCreateBeforeHooks(captureScheduleRegistrations());

    expect(context.params.tenant?.tenant_id).toBe('registration-test');
    expect(context.data).toMatchObject({
      created_by: 'registration-test-user',
      next_run_at: expect.any(Number),
    });
    expect(context.data).not.toHaveProperty('tenant_id');
  });

  it('wraps MCP OAuth/session database helpers in tenant scope without holding network I/O open', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toEqual(
      expect.arrayContaining([
        'sessions/:id/mcp-servers',
        'mcp-servers/oauth-attempt-status',
        'mcp-servers/oauth-disconnect',
        'mcp-servers/oauth-status',
      ])
    );
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toEqual(
      expect.arrayContaining(['mcp-servers/oauth-auth-headers', 'mcp-servers/oauth-refresh'])
    );
  });

  it('fails closed for discovery that can enter the process-local MCP OAuth flow in HA', () => {
    expect(CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES).toContainEqual([
      'mcp-servers/discover',
      'mcpOAuth',
    ]);
  });

});

describe('shouldRunSessionPostTurnHooks', () => {
  it('runs for idle sessions, preserving stop-route gateway finalization behavior', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'idle', ready_for_prompt: false })).toBe(true);
  });

  it('runs for failed sessions only once they are promptable', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'failed', ready_for_prompt: true })).toBe(true);
    expect(shouldRunSessionPostTurnHooks({ status: 'failed', ready_for_prompt: false })).toBe(
      false
    );
  });

  it('does not run for busy sessions', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'running', ready_for_prompt: false })).toBe(
      false
    );
  });
});

describe('getTrustedSessionTenantId', () => {
  it('reads non-enumerable tenant metadata from session DTOs without requiring JSON exposure', () => {
    const session = makeSession('session-1');
    Object.defineProperty(session, 'tenant_id', {
      value: 'tenant-from-row',
      enumerable: false,
    });

    expect(getTrustedSessionTenantId(session)).toBe('tenant-from-row');
    expect(Object.keys(session)).not.toContain('tenant_id');
    expect(JSON.stringify(session)).not.toContain('tenant_id');
  });

  it('ignores absent or empty tenant metadata', () => {
    expect(getTrustedSessionTenantId(makeSession('session-1'))).toBeUndefined();
    expect(getTrustedSessionTenantId({ tenant_id: '' })).toBeUndefined();
  });
});

describe('shouldDrainQueueAfterSessionPostTurnPatch', () => {
  it('drains for promptable ready sessions by default', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'failed', ready_for_prompt: true })
    ).toBe(true);
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'idle', ready_for_prompt: true })
    ).toBe(true);
  });

  it('does not drain when terminal queue processing is explicitly suppressed', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch(
        { status: 'failed', ready_for_prompt: true },
        { suppressTerminalQueueProcessing: true }
      )
    ).toBe(false);
  });

  it('does not drain for promptable-but-not-ready acknowledgement states', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'idle', ready_for_prompt: false })
    ).toBe(false);
  });
});

describe('enrichSessionFindResultWithRemoteRelationships', () => {
  it('enriches paginated results produced by before.find RBAC scoping', async () => {
    const session = makeSession('session-1');
    const relationship = {
      relationship_id: 'relationship-1',
      source_session_id: 'session-1',
      target_session_id: 'session-2',
      relationship_type: 'remote_create',
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      callback_enabled: false,
      callback_session_id: null,
      data: null,
    } as const;
    let calls = 0;
    const service = {
      async enrichRemoteRelationships(sessions: import('@disco/core/types').Session[]) {
        calls += 1;
        return sessions.map((item) =>
          item.session_id === session.session_id
            ? { ...item, remote_relationships: { as_source: [relationship], as_target: [] } }
            : item
        );
      },
    };

    const result = await enrichSessionFindResultWithRemoteRelationships(
      { total: 1, limit: 10, skip: 0, data: [session] },
      service
    );

    expect(calls).toBe(1);
    expect(Array.isArray(result)).toBe(false);
    expect(Array.isArray(result) ? null : result.data[0].remote_relationships?.as_source?.[0]).toBe(
      relationship
    );
  });

  it('does not enrich a result that the sessions service already enriched', async () => {
    const session = makeSession('session-1');
    let calls = 0;
    const service = {
      async enrichRemoteRelationships(sessions: import('@disco/core/types').Session[]) {
        calls += 1;
        return sessions.map((item) => ({ ...item, title: 'enriched twice' }));
      },
    };

    const once = await enrichSessionFindResultWithRemoteRelationships([session], service);
    const twice = await enrichSessionFindResultWithRemoteRelationships(once, service);

    expect(twice).toBe(once);
    expect(calls).toBe(1);
    expect((twice as import('@disco/core/types').Session[])[0].title).toBe('enriched twice');
  });
});

describe('isPromptFlowPatchOnly', () => {
  describe('accepts whitelisted-only patches', () => {
    it.each(PROMPT_FLOW_PATCH_FIELDS.map((f) => [f]))(
      'accepts single whitelisted field: %s',
      (field) => {
        expect(isPromptFlowPatchOnly({ [field]: 'any-value' })).toBe(true);
      }
    );

    it('accepts the prompt-route task-append shape', () => {
      // register-routes.ts: /sessions/:id/prompt appends task_id to session.tasks
      expect(isPromptFlowPatchOnly({ tasks: ['task-1', 'task-2'] })).toBe(true);
    });

    it('accepts the prompt-route auto-unarchive shape', () => {
      // register-routes.ts: /sessions/:id/prompt auto-unarchives before sending
      expect(isPromptFlowPatchOnly({ archived: false, archived_reason: undefined })).toBe(true);
    });

    it('accepts the stop-route idle shape', () => {
      // register-routes.ts: /sessions/:id/stop sets status + ready_for_prompt
      // (ready_for_prompt: true so the post-patch hook drains any QUEUED tasks)
      expect(isPromptFlowPatchOnly({ status: 'idle', ready_for_prompt: true })).toBe(true);
    });

    it('accepts the executor opencode init shape', () => {
      // packages/executor/src/handlers/sdk/opencode.ts patches the SDK session handle
      expect(isPromptFlowPatchOnly({ sdk_session_id: 'opencode-sess-123' })).toBe(true);
    });
  });

  describe('rejects mixed or metadata patches', () => {
    it('rejects a patch that mixes whitelist + metadata field', () => {
      // Prevents partial-trust escalation: if `tasks` is allowed at session-tier,
      // a caller must NOT be able to piggyback `name` (metadata) onto the same patch.
      expect(isPromptFlowPatchOnly({ tasks: ['t'], name: 'evil' })).toBe(false);
    });

    it.each([
      ['name', 'metadata'],
      ['model_config', { model: 'x' }],
      ['permission_config', { mode: 'bypass' }],
      ['callback_config', { callback_session_id: 'sid' }],
      ['created_by', 'other-user'],
      ['agent_id', 'agent-evil'],
      ['working_directory', '/other-user'],
    ])('rejects pure-metadata patch on field: %s', (field, value) => {
      expect(isPromptFlowPatchOnly({ [field]: value })).toBe(false);
    });
  });

  describe('rejects non-object inputs', () => {
    it('rejects null', () => {
      expect(isPromptFlowPatchOnly(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isPromptFlowPatchOnly(undefined)).toBe(false);
    });

    it('rejects empty object (nothing to patch = cannot be a prompt-flow patch)', () => {
      expect(isPromptFlowPatchOnly({})).toBe(false);
    });

    it('rejects primitives', () => {
      expect(isPromptFlowPatchOnly('string')).toBe(false);
      expect(isPromptFlowPatchOnly(42)).toBe(false);
      expect(isPromptFlowPatchOnly(true)).toBe(false);
    });
  });
});

/**
 * Guards the fix for CVE-class issue: `after: get` on /sessions was minting
 * an MCP token (with `uid = session.created_by`) for any `member+` caller
 * with `view` permission on the branch, letting them impersonate the
 * creator on the MCP channel. Only the creator, a superadmin, or the
 * executor's service identity may receive the token.
 */
describe('canReceiveMcpTokenForSession', () => {
  const CREATOR = 'user-creator';
  const OTHER = 'user-other';

  it('allows any authenticated member+ caller to receive a caller-scoped MCP token', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'member',
      })
    ).toBe(true);
  });

  it('allows a superadmin even if not the creator', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'superadmin',
      })
    ).toBe(true);
  });

  it('allows the executor service identity (role=service)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: 'executor-service',
        callerRole: 'service',
      })
    ).toBe(true);
  });

  it('denies a creator who has been demoted to viewer', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: CREATOR,
        callerRole: 'viewer',
      })
    ).toBe(false);
  });

  it('denies anonymous callers (no user_id, no role)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: undefined,
        callerRole: undefined,
      })
    ).toBe(false);
  });

  it('denies callers with user_id but no explicit role', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: CREATOR,
        callerRole: undefined,
      })
    ).toBe(false);
  });

  it('denies empty-string caller user_id even with member role', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: '',
        callerRole: 'member',
      })
    ).toBe(false);
  });
});

describe('TENANT_IDENTITY_ONLY_SERVICE_PATHS', () => {
  it('keeps the current published-files service identity-only', () => {
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain('files');
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).not.toContain('file');
    expect(TENANT_OWNED_SERVICE_PATHS).not.toContain('files');
  });

  it('keeps every first-class Agent resource inside the canonical tenant database boundary', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toEqual(
      expect.arrayContaining(['agents', 'sessions', 'codex-skills', 'agent-capabilities'])
    );
  });

  // Regression: the codex-auth endpoints do network/process work after a short
  // tenant DB read, then call getCurrentTenantId() to open their own units of
  // work — so they must carry ambient tenant identity via the identity-only
  // around hook. codex-auth/logout was missing here, so `Remove login` ran with
  // no active tenant scope and threw "Missing active tenant context for Codex
  // auth logout" — the delete-only logout never worked end-to-end.
  it.each(['codex-auth/device', 'codex-auth/import', 'codex-auth/logout'])(
    'grants ambient tenant identity to %s',
    (path) => {
      expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain(path);
    }
  );

  it('keeps the codex-auth endpoints grouped together', () => {
    const codexPaths = TENANT_IDENTITY_ONLY_SERVICE_PATHS.filter((path) =>
      path.startsWith('codex-auth/')
    );
    expect(codexPaths).toEqual(['codex-auth/device', 'codex-auth/import', 'codex-auth/logout']);
  });

  it.each([
    'mcp-servers/discover',
    'mcp-servers/oauth-complete',
    'mcp-servers/oauth-start',
    'mcp-servers/test-oauth',
  ])('keeps provider/waiting endpoint %s out of an HTTP-long transaction', (path) => {
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain(path);
    expect(TENANT_OWNED_SERVICE_PATHS).not.toContain(path);
  });
});
