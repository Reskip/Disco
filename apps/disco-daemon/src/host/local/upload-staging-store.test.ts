import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AgentID, SessionID, TenantID, UserID } from '@disco/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalUploadStagingStore } from './upload-staging-store.js';

const tenantA = 'tenant-a' as TenantID;
const tenantB = 'tenant-b' as TenantID;
const sessionA = '00000000-0000-0000-0000-000000000001' as SessionID;
const sessionB = '00000000-0000-0000-0000-000000000002' as SessionID;
const agentA = '00000000-0000-0000-0000-000000000003' as AgentID;
const agentB = '00000000-0000-0000-0000-000000000004' as AgentID;
const userA = '00000000-0000-0000-0000-000000000005' as UserID;
const userB = '00000000-0000-0000-0000-000000000006' as UserID;
const ownerA = {
  tenantId: tenantA,
  sessionId: sessionA,
  createdBy: userA,
  agentId: agentA,
};
let root = '';

async function setup(options: ConstructorParameters<typeof LocalUploadStagingStore>[1] = {}) {
  root = await mkdtemp(join(tmpdir(), 'disco-upload-store-'));
  return new LocalUploadStagingStore((tenant) => join(root, tenant), options);
}

async function stage(store: LocalUploadStagingStore, body = 'hello') {
  return store.stage({
    owner: ownerA,
    name: '../../unsafe<script>.txt',
    mimeType: 'text/plain',
    provenance: 'browser',
    body: Readable.from(body),
    sizeHint: Buffer.byteLength(body),
  });
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('LocalUploadStagingStore boundary B', () => {
  it('returns only an opaque ref and sanitized logical metadata', async () => {
    const stored = await stage(await setup());
    expect(stored.ref).toMatch(/^upl_[0-9a-f-]{36}$/);
    expect(stored.name).toBe('unsafe_script_.txt');
    expect(JSON.stringify(stored)).not.toContain(root);
    expect(stored.provenance).toBe('browser');
    expect(stored.expiresAt).toBeNull();
  });

  it('retains valid uploads indefinitely by default during cleanup', async () => {
    const store = await setup();
    const stored = await stage(store);

    expect(
      await store.cleanupExpired({ tenantId: tenantA }, new Date('2100-01-01T00:00:00.000Z'))
    ).toBe(0);
    await expect(store.inspect({ ...ownerA, ref: stored.ref })).resolves.toMatchObject({
      ref: stored.ref,
      expiresAt: null,
    });
  });

  it('can read a durable upload after the storage adapter is recreated', async () => {
    const store = await setup();
    const stored = await stage(store, 'survives restart');
    const restarted = new LocalUploadStagingStore((tenant) => join(root, tenant));

    await expect(restarted.inspect({ ...ownerA, ref: stored.ref })).resolves.toMatchObject({
      ref: stored.ref,
      expiresAt: null,
      size: Buffer.byteLength('survives restart'),
    });
    expect(
      await restarted.cleanupExpired({ tenantId: tenantA }, new Date('2100-01-01T00:00:00.000Z'))
    ).toBe(0);
  });

  it('denies cross-tenant and cross-session reuse without disclosing ownership', async () => {
    const store = await setup();
    const stored = await stage(store);
    await expect(store.inspect({ ...ownerA, tenantId: tenantB, ref: stored.ref })).rejects.toThrow(
      'Upload not found'
    );
    await expect(
      store.inspect({ ...ownerA, sessionId: sessionB, ref: stored.ref })
    ).rejects.toThrow('Upload not found');
    await expect(store.inspect({ ...ownerA, agentId: agentB, ref: stored.ref })).rejects.toThrow(
      'Upload not found'
    );
    await expect(store.inspect({ ...ownerA, createdBy: userB, ref: stored.ref })).rejects.toThrow(
      'Upload not found'
    );
  });

  it('enforces actual streamed bytes and removes interrupted partial files', async () => {
    const store = await setup({ maxBytes: 4 });
    await expect(stage(store, '12345')).rejects.toThrow('4-byte limit');
    expect(await store.cleanupExpired({ tenantId: tenantA })).toBe(0);
  });

  it('supports true ranged reads and idempotent one-way consume semantics', async () => {
    const store = await setup();
    const stored = await stage(store, '0123456789');
    const stream = await store.read({
      ...ownerA,
      ref: stored.ref,
      offset: 3,
      length: 4,
    });
    let value = '';
    for await (const chunk of stream) value += chunk;
    expect(value).toBe('3456');
    await store.consume({
      ...ownerA,
      ref: stored.ref,
    });
    await store.consume({
      ...ownerA,
      ref: stored.ref,
    });
    await expect(store.read({ ...ownerA, ref: stored.ref })).rejects.toThrow('Upload not found');
  });

  it('makes delete idempotent without weakening ownership', async () => {
    const store = await setup();
    const stored = await stage(store);
    await store.delete({
      ...ownerA,
      ref: stored.ref,
    });
    await store.delete({
      ...ownerA,
      ref: stored.ref,
    });
    await expect(
      store.delete({ ...ownerA, tenantId: tenantB, ref: stored.ref })
    ).resolves.toBeUndefined();
  });

  it('expires and cleans up only the owning tenant', async () => {
    const store = await setup({ ttlMs: 1 });
    const stored = await stage(store);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(store.inspect({ ...ownerA, ref: stored.ref })).rejects.toThrow('expired');
    expect(await store.cleanupExpired({ tenantId: tenantB }, new Date(Date.now() + 10_000))).toBe(
      0
    );
  });

  it('cleans stale partials, orphan data, and corrupt sidecars within one tenant root', async () => {
    const store = await setup({ ttlMs: 10 });
    const bucket = join(root, tenantA, 'objects', '00');
    await mkdir(bucket, { recursive: true });
    const files = ['write.partial', 'upl_orphan.data', 'upl_corrupt.json'];
    await Promise.all(files.map((file) => writeFile(join(bucket, file), 'x')));
    const old = new Date(Date.now() - 1000);
    await Promise.all(files.map((file) => utimes(join(bucket, file), old, old)));
    expect(await store.cleanupExpired({ tenantId: tenantA })).toBe(3);
    expect(await readdir(bucket)).toEqual([]);
  });

  it('does not scan tenant storage while staging a new upload', async () => {
    const store = await setup({ ttlMs: 1_000 });
    const bucket = join(root, tenantA, 'objects', '00');
    await mkdir(bucket, { recursive: true });
    const stale = join(bucket, 'stale.partial');
    await writeFile(stale, 'x');
    const old = new Date(Date.now() - 10_000);
    await utimes(stale, old, old);

    await stage(store);

    expect(await readdir(bucket)).toContain('stale.partial');
    expect(await store.cleanupExpired({ tenantId: tenantA })).toBe(1);
  });
});
