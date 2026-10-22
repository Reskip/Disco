import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { resolveDiscoUserWorkspaceDirectory } from '@disco/core';
import { getConfigPath, getWorktreesRoot } from '@disco/core/config';
import {
  createDatabaseAsync,
  insert,
  messages,
  runMigrations,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@disco/core/db';
import {
  type KnowledgeOwner,
  type MessageID,
  MessageRole,
  type Session,
  type SessionID,
  type User,
} from '@disco/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvedTranscriptCwd, KnowledgeRuntime } from './runtime';

// SQLite has no write gate. Preserve the real repositories and emulate only
// PostgreSQL's active tenant gate at its existing enforcement seam.
const { assertTenantWritable } = vi.hoisted(() => ({ assertTenantWritable: vi.fn() }));
vi.mock('@disco/core/db', async (original) => ({
  ...(await original<typeof import('@disco/core/db')>()),
  assertTenantWritable,
}));

describe('knowledge background synchronization', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof createDatabaseAsync>>;
  let runtime: KnowledgeRuntime;
  let primary: User;
  let secondary: User;
  let owner: KnowledgeOwner;
  let otherOwner: KnowledgeOwner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'disco-kb-runtime-'));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    await mkdir(join(root, '.disco'));
    vi.stubEnv('DISCO_HOME', root);
    vi.stubEnv('DISCO_DATA_HOME', root);
    vi.stubEnv('DISCO_KNOWLEDGE_CONFIG', join(root, 'knowledge', 'runtime.json'));
    vi.stubEnv('DISCO_KNOWLEDGE_PRIVATE_ROOTS', '[]');
    assertTenantWritable.mockReset().mockResolvedValue(undefined);
    db = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    await runMigrations(db);
    const users = new UsersRepository(db);
    primary = (await users.create({
      username: 'runtime_qa_alpha',
      email: 'runtime_qa_alpha@example.invalid',
      name: '甲',
      role: 'member',
    })) as User;
    secondary = (await users.create({
      username: 'runtime_qa_beta',
      email: 'runtime_qa_beta@example.invalid',
      name: '乙',
      role: 'member',
    })) as User;
    owner = { tenantId: 'default', userId: primary.user_id };
    otherOwner = { tenantId: 'default', userId: secondary.user_id };
    runtime = new KnowledgeRuntime({}, db as unknown as TenantScopeAwareDatabase, {});
    runtime.start();
    // Enter the real running state, but drive passes explicitly so the 3-second
    // startup timer cannot race an in-progress test. No provider is configured.
    clearTimeout((runtime as unknown as { timer?: ReturnType<typeof setTimeout> }).timer);
  }, 30_000);

  afterEach(async () => {
    await runtime?.stop();
    (db as unknown as { $client?: { close: () => void } })?.$client?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    const actual = resolve(root);
    if (!actual.startsWith(`${resolve(tmpdir())}${sep}`) || !actual.includes('disco-kb-runtime-'))
      throw new Error('Unsafe cleanup target');
    await rm(actual, { recursive: true, force: true });
  });

  const createSession = (user: User, title: string) =>
    new SessionRepository(db).create({
      created_by: user.user_id,
      title,
      working_directory: join(root, user.user_id, randomUUID()),
    });
  // Seed canonical rows directly. This seam tests the worker's reads, not the
  // message writer; libSQL's separate transactional connections do not share
  // :memory: state and otherwise retain Windows file handles until GC.
  const append = (session: Session, index: number, content: string) =>
    insert(db, messages)
      .values({
        message_id: randomUUID() as MessageID,
        session_id: session.session_id as SessionID,
        created_at: new Date(),
        type: 'user',
        role: MessageRole.USER,
        index,
        timestamp: new Date(),
        content_preview: content,
        data: { content },
      })
      .run();

  it('imports each user’s complete conversation into their own portable library', async () => {
    const first = await createSession(primary, '甲的会话');
    const second = await createSession(secondary, '乙的会话');
    const content = '第一行\n第二行\n完整记录';
    await append(first, 0, content);
    await append(second, 0, '仅乙的秘密');
    await runtime.runOnce();
    const a = await runtime.library.list(owner);
    const b = await runtime.library.list(otherOwner);
    expect(a.entries).toHaveLength(1);
    expect(b.entries).toHaveLength(1);
    expect(a.entries[0]).toMatchObject({
      source: 'disco',
      sourceId: first.session_id,
      title: '甲的会话',
    });
    expect(b.entries[0]).toMatchObject({ sourceId: second.session_id, title: '乙的会话' });
    expect((await runtime.library.get(owner, a.entries[0].id))?.markdown).toContain(content);
    expect(await runtime.library.get(owner, b.entries[0].id)).toBeNull();
    expect(await runtime.library.get(otherOwner, a.entries[0].id)).toBeNull();
    expect(runtime.library.ownerPath(owner)).not.toBe(runtime.library.ownerPath(otherOwner));
    expect((await runtime.status(owner)).sync?.state).toBe('idle');
  });

  it('imports appended messages even when the session updated_at value is unchanged', async () => {
    const session = await createSession(primary, '增量会话');
    await append(session, 0, '第一次消息');
    await runtime.runOnce();
    const first = (await runtime.library.list(owner)).entries[0];
    await append(session, 1, '后续消息\n继续记录');
    expect((await new SessionRepository(db).findById(session.session_id))?.last_updated).toBe(
      session.last_updated
    );
    await runtime.runOnce();
    const updated = await runtime.library.get(owner, first.id);
    expect(updated?.markdown).toContain('第一次消息');
    expect(updated?.markdown).toContain('后续消息\n继续记录');
    expect((await runtime.library.list(owner)).total).toBe(1);
  });

  it('retains the independent archive after the source session is deleted', async () => {
    const session = await createSession(primary, '删除前的会话');
    await append(session, 0, '独立保留资料');
    await runtime.runOnce();
    const entry = (await runtime.library.list(owner)).entries[0];
    await new SessionRepository(db).delete(session.session_id);
    expect(await new SessionRepository(db).findById(session.session_id)).toBeNull();
    await runtime.runOnce();
    expect((await runtime.library.get(owner, entry.id))?.markdown).toContain('独立保留资料');
  });

  it('does not perform archive or index writes while the authenticated tenant is write-gated', async () => {
    const session = await createSession(primary, '暂停写入');
    await append(session, 0, '不能归档');
    const archive = vi.spyOn(runtime.library, 'upsertSource');
    const reconcile = vi.spyOn(runtime.library, 'reconcile');
    const engine = { index: vi.fn(), summarize: vi.fn(), search: vi.fn() };
    Object.defineProperty(runtime, 'engine', { value: engine });
    assertTenantWritable.mockRejectedValue(new Error('tenant write gate active'));
    await runtime.runOnce();
    expect(assertTenantWritable).toHaveBeenCalledWith(expect.anything(), 'default');
    expect(archive).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(engine.index).not.toHaveBeenCalled();
    expect(engine.summarize).not.toHaveBeenCalled();
    expect((await runtime.status(owner)).sync?.state).toBe('error');
    expect((await runtime.library.list(owner)).total).toBe(0);
  });

  it.each(['success', 'failure'] as const)(
    'removes a late provider write when a deleted entry finishes indexing with %s',
    async (outcome) => {
      const record = (await runtime.library.upsertSource(owner, {
        source: 'manual',
        sourceId: 'delete-during-index',
        kind: 'note',
        title: '删除与索引并发',
        markdown: '删除后不应留在派生索引中的内容',
      }))!;
      const providerDocuments = new Set([record.entry.id]);
      let startIndex!: () => void;
      let resumeIndex!: () => void;
      const started = new Promise<void>((done) => {
        startIndex = done;
      });
      const resumed = new Promise<void>((done) => {
        resumeIndex = done;
      });
      const engine = {
        index: vi.fn(async (_owner: KnowledgeOwner, document: { id: string }) => {
          startIndex();
          await resumed;
          // batch-write may persist content before embedding/status handling fails.
          providerDocuments.add(document.id);
          if (outcome === 'failure') throw new Error('INDEX_NOT_READY after content commit');
        }),
        delete: vi.fn(async (_owner: KnowledgeOwner, id: string) => {
          providerDocuments.delete(id);
        }),
        summarize: vi.fn(),
      };
      Object.defineProperty(runtime, 'engine', { value: engine });
      const indexing = runtime.runOnce();
      await started;
      try {
        expect(await runtime.remove(owner, record.entry.id)).toBe(true);
        expect(providerDocuments.has(record.entry.id)).toBe(false);
        expect(engine.delete).toHaveBeenCalledTimes(1);
      } finally {
        resumeIndex();
        await indexing;
      }
      expect(providerDocuments.has(record.entry.id)).toBe(false);
      expect(engine.delete).toHaveBeenCalledTimes(2);
      expect(await runtime.library.get(owner, record.entry.id)).toBeNull();
      expect(await runtime.library.listDeletedIds(owner)).toContain(record.entry.id);
      await runtime.runOnce();
      expect(engine.index).toHaveBeenCalledTimes(1);
      expect(providerDocuments.has(record.entry.id)).toBe(false);
    }
  );

  it('treats an explicitly empty search scope as empty instead of broadening to the entire library', async () => {
    await runtime.library.upsertSource(owner, {
      source: 'manual',
      sourceId: 'scope-empty',
      kind: 'note',
      title: '范围目标',
      markdown: '范围目标',
    });
    const engine = { search: vi.fn().mockResolvedValue([]) };
    Object.defineProperty(runtime, 'engine', { value: engine });
    const listing = vi.spyOn(runtime.library, 'list');
    expect(await runtime.search(owner, { query: '范围目标', entryIds: [] })).toEqual({
      engine: 'local',
      results: [],
    });
    expect(listing).not.toHaveBeenCalled();
    expect(engine.search).not.toHaveBeenCalled();
  });

  it('rejects transcript cwd junctions into sibling accounts and service-private directories', async () => {
    const ownRoot = resolveDiscoUserWorkspaceDirectory(
      getWorktreesRoot(owner.tenantId),
      owner.userId
    );
    const sibling = resolveDiscoUserWorkspaceDirectory(
      getWorktreesRoot(otherOwner.tenantId),
      otherOwner.userId
    );
    const host = join(root, 'host-codex');
    const privateIndex = join(root, 'openviking');
    await Promise.all(
      [ownRoot, sibling, host, privateIndex].map((directory) =>
        mkdir(directory, { recursive: true })
      )
    );
    vi.stubEnv('DISCO_KNOWLEDGE_PRIVATE_ROOTS', JSON.stringify([privateIndex]));
    const siblingAlias = join(ownRoot, 'sibling-link');
    const privateAlias = join(ownRoot, 'index-link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(sibling, siblingAlias, linkType);
    await symlink(privateIndex, privateAlias, linkType);
    expect(await approvedTranscriptCwd(ownRoot, owner, host)).toBe(resolve(ownRoot));
    for (const denied of [sibling, host, privateIndex, siblingAlias, privateAlias]) {
      expect(await approvedTranscriptCwd(denied, owner, host)).toBeUndefined();
    }
  });

  it('rejects other accounts and tenants when tenant files live outside the main data home', async () => {
    const dataHome = join(root, 'main-data');
    const tenantsBase = join(root, 'separate-tenant-volume');
    vi.stubEnv('DISCO_DATA_HOME', dataHome);
    await writeFile(
      getConfigPath(),
      JSON.stringify({
        multi_tenancy: { filesystem_isolation_enabled: true, tenants_base_folder: tenantsBase },
      })
    );
    const ownRoot = resolveDiscoUserWorkspaceDirectory(
      getWorktreesRoot(owner.tenantId),
      owner.userId
    );
    const sibling = resolveDiscoUserWorkspaceDirectory(
      getWorktreesRoot(owner.tenantId),
      secondary.user_id
    );
    const foreignTenant = resolveDiscoUserWorkspaceDirectory(
      getWorktreesRoot('another-tenant'),
      primary.user_id
    );
    const host = join(root, 'host-codex');
    await Promise.all(
      [ownRoot, sibling, foreignTenant, host].map((directory) =>
        mkdir(directory, { recursive: true })
      )
    );
    expect(ownRoot.startsWith(tenantsBase)).toBe(true);
    expect(await approvedTranscriptCwd(ownRoot, owner, host)).toBe(resolve(ownRoot));
    expect(await approvedTranscriptCwd(sibling, owner, host)).toBeUndefined();
    expect(await approvedTranscriptCwd(foreignTenant, owner, host)).toBeUndefined();
  });

  it('finds an explicitly scoped older record beyond the first hundred local matches', async () => {
    const target = (await runtime.library.upsertSource(owner, {
      source: 'manual',
      sourceId: 'old-target',
      kind: 'note',
      title: '共同词 目标',
      markdown: '共同词，完整目标正文',
    }))!;
    for (let index = 0; index < 101; index++) {
      await runtime.library.upsertSource(owner, {
        source: 'manual',
        sourceId: `new-${index}`,
        kind: 'note',
        title: `共同词 ${index}`,
        markdown: '共同词，较新的资料',
      });
    }
    expect(
      (await runtime.library.list(owner, { query: '共同词', limit: 100 })).entries.map(
        (entry) => entry.id
      )
    ).not.toContain(target.entry.id);
    const engine = { search: vi.fn().mockRejectedValue(new Error('offline fixture')) };
    Object.defineProperty(runtime, 'engine', { value: engine });
    const result = await runtime.search(owner, { query: '共同词', entryIds: [target.entry.id] });
    expect(result.engine).toBe('local');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].entry.id).toBe(target.entry.id);
    expect(result.results[0].excerpt).toContain('完整目标正文');
    expect(
      (await runtime.search(otherOwner, { query: '共同词', entryIds: [target.entry.id] })).results
    ).toEqual([]);
  }, 30_000);
});
