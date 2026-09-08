import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from '@disco/core/db';
import type { TenantContext } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createUploadAuthMiddleware,
  resolveExecutorUploadReadOwner,
  resolveUploadHttpRange,
} from './register-routes.js';

describe('browser upload route boundary ordering', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  it('authenticates and authorizes before the multipart parser can accept bytes', () => {
    const route = source.slice(source.indexOf("'/sessions/:sessionId/upload'"));
    expect(route.indexOf('uploadAuthMiddleware')).toBeLessThan(
      route.indexOf("uploadMiddleware.array('files'")
    );
    expect(route.indexOf('authorizeUpload')).toBeLessThan(
      route.indexOf("uploadMiddleware.array('files'")
    );
  });

  it('does not expose Multer buffers or physical file paths in the response contract', () => {
    const handler = source.slice(
      source.indexOf('const uploadHandler'),
      source.indexOf('const uploadLogger')
    );
    expect(handler).not.toContain('f.buffer');
    expect(handler).not.toContain('f.path');
    expect(handler).toContain('ref: staged.ref');
    // createUploadMiddleware receives the MetadataUploadStagingStore, whose
    // stage() operation already commits the logical Upload row atomically.
    // A second insert here would collide on upload_ref after every successful
    // byte transfer.
    expect(handler).not.toContain('uploadRepo.create(owner, staged)');
  });

  it('allows private browser caching for immutable upload content', () => {
    const contentRoute = source.slice(
      source.indexOf("'/uploads/:uploadRef/content'"),
      source.indexOf("'/uploads/:uploadRef'", source.indexOf("'/uploads/:uploadRef/content'") + 1)
    );
    expect(contentRoute).toContain("'private, max-age=604800, immutable'");
    expect(contentRoute).toContain("'Vary', 'Authorization, Cookie'");
    expect(contentRoute).toContain("'ETag'");
  });

  it('serves valid byte ranges and rejects malformed or unsatisfiable ranges', () => {
    expect(resolveUploadHttpRange(undefined, 100)).toEqual({ offset: 0 });
    expect(resolveUploadHttpRange('bytes=10-19', 100)).toEqual({
      offset: 10,
      length: 10,
      contentRange: 'bytes 10-19/100',
    });
    expect(resolveUploadHttpRange('bytes=95-', 100)).toEqual({
      offset: 95,
      length: 5,
      contentRange: 'bytes 95-99/100',
    });
    expect(resolveUploadHttpRange('bytes=120-', 100)).toBeNull();
    expect(resolveUploadHttpRange('bytes=-10', 100)).toBeNull();
    expect(resolveUploadHttpRange('items=0-10', 100)).toBeNull();
  });

  it('binds executor upload reads to the signed tenant, session, and user', () => {
    expect(
      resolveExecutorUploadReadOwner(
        {
          type: 'executor-session',
          purpose: 'executor-task',
          tenant_id: 'tenant-a',
          session_id: 'session-a',
          sub: 'user-a',
          task_id: 'task-a',
        },
        'upl_00000000-0000-4000-8000-000000000001'
      )
    ).toEqual({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      createdBy: 'user-a',
      ref: 'upl_00000000-0000-4000-8000-000000000001',
    });
    expect(
      resolveExecutorUploadReadOwner(
        {
          type: 'executor-session',
          purpose: 'wrong-purpose',
          tenant_id: 'tenant-a',
          session_id: 'session-a',
          sub: 'user-a',
        },
        'upl_00000000-0000-4000-8000-000000000001'
      )
    ).toBeNull();
    expect(
      resolveExecutorUploadReadOwner(
        {
          type: 'executor-session',
          purpose: 'executor-task',
          tenant_id: 'tenant-a',
          session_id: 'session-a',
        },
        'upl_00000000-0000-4000-8000-000000000001'
      )
    ).toBeNull();
  });

  it('propagates the tenant verified by authentication on the same params object', async () => {
    const verifiedTenant = { tenant_id: 'verified-tenant', source: 'explicit' } as TenantContext;
    const rawDb = { run: vi.fn(), select: vi.fn(() => ({ user_id: 'user-1' })) };
    const guardedDb = createTenantScopedDatabaseProxy(rawDb as never, {
      requireScope: true,
      label: 'upload authentication test database',
    });
    let suppliedParams: unknown;
    const authentication = {
      create: vi.fn(async (_data, params) => {
        suppliedParams = params;
        params.tenant = verifiedTenant;
        const user = await runWithTenantDatabaseScope(guardedDb, params.tenant.tenant_id, () =>
          guardedDb.select()
        );
        return {
          user,
          authentication: { payload: { tenant_id: 'payload-tenant' } },
        };
      }),
    };
    const middleware = createUploadAuthMiddleware({
      authentication,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'static-tenant',
        auth_claim: 'tenant_id',
        trusted_header: 'x-tenant-id',
      },
    });
    const req = {
      headers: { authorization: 'Bearer token', 'x-tenant-id': 'header-tenant' },
      feathers: undefined as { tenant?: TenantContext } | undefined,
    };
    const res = {};
    const next = vi.fn();

    await middleware(req, res, next);

    const passedParams = authentication.create.mock.calls[0]?.[1];
    expect(suppliedParams).toBe(passedParams);
    expect(next).toHaveBeenCalledOnce();
    expect(req.feathers.tenant).toBe(verifiedTenant);
    expect(rawDb.select).toHaveBeenCalledOnce();
  });

  it('fails closed when hosted authentication establishes no tenant identity', async () => {
    const authentication = {
      create: vi.fn(async () => ({
        user: { user_id: 'user-1' },
        authentication: { payload: {} },
      })),
    };
    const middleware = createUploadAuthMiddleware({
      authentication,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'static-tenant',
        auth_claim: 'tenant_id',
      },
    });
    const req = {
      headers: { authorization: 'Bearer token' },
      feathers: undefined,
    };
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const next = vi.fn();

    await middleware(req, { status }, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(req.feathers).toBeUndefined();
  });

  it('carries authentication params so the JWT user lookup receives tenant scope', () => {
    const start = source.indexOf('export function createUploadAuthMiddleware');
    const middleware = source.slice(
      start,
      source.indexOf('/**\n * Register authentication', start)
    );

    expect(start).toBeGreaterThan(0);
    expect(middleware).toContain(
      'const authParams: AuthenticatedParams = { headers: req.headers }'
    );
    expect(middleware).toMatch(/authentication\.create\([\s\S]*authParams\s*\)/);
    expect(middleware).toContain('authParams.tenant ??');
  });
});
