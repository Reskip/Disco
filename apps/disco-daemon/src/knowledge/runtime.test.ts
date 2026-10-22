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
import { OpenVikingError } from './openviking';
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

  it('archives new messages while a separate indexing job is waiting', async () => {
    const session = await createSession(primary, '独立后台任务');
    await append(session, 0, '初始内容');
    await runtime.runOnce(false);
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(runtime, 'engine', {
      value: {
        index: vi.fn(async () => {
          began();
          await barrier;
        }),
        delete: vi.fn(),
      },
    });
    const indexing = runtime.runIndexOnce();
    await started;
    try {
      await append(session, 1, '索引期间新增消息');
      await runtime.runOnce(false);
      const source = (await runtime.library.list(owner)).entries[0];
      expect((await runtime.library.get(owner, source.id))?.markdown).toContain('索引期间新增消息');
    } finally {
      release();
      await indexing;
    }
  });

  it('creates categorized summaries without waiting for another failed document', async () => {
    const session = await createSession(primary, '原始较长的会话标题');
    await append(session, 0, '确定用本地模型建立索引，原件长期保留。');
    await runtime.runOnce(false);
    const source = (await runtime.library.list(owner)).entries[0];
    await runtime.library.markIndexed(owner, source.id);
    await runtime.library.upsertSource(otherOwner, {
      source: 'manual',
      sourceId: 'failed',
      kind: 'document',
      title: '待索引',
      markdown: '其它用户尚未索引',
    });
    Object.defineProperty(runtime, 'engine', {
      value: {
        summarizeContent: vi.fn().mockResolvedValue({
          title: '本地知识库保留规则',
          topic: '软件与系统',
          tags: ['知识库'],
          abstract: '使用本地索引，原件保留。',
          overview: '## 结论\n原件长期保存。',
        }),
      },
    });
    await runtime.runSummaryOnce();
    const summaries = await runtime.library.list(owner, { level: 'summary' });
    expect(summaries.total).toBe(1);
    expect(summaries.entries[0]).toMatchObject({
      title: '本地知识库保留规则',
      humanEdited: false,
      organization: { topic: '软件与系统', state: 'draft' },
    });
    expect((await runtime.library.get(owner, summaries.entries[0].id))?.sources?.[0].id).toBe(
      source.id
    );
    expect((await runtime.library.get(owner, source.id))?.entry.organization?.topic).toBe(
      '软件与系统'
    );
  });

  it('keeps trivial exchanges fully archived without manufacturing a knowledge note', async () => {
    const session = await createSession(primary, '连通测试');
    await append(session, 0, '测试');
    await runtime.runOnce(false);
    const source = (await runtime.library.list(owner)).entries[0];
    await runtime.library.markIndexed(owner, source.id);
    Object.defineProperty(runtime, 'engine', {
      value: {
        summarizeContent: vi.fn().mockResolvedValue({
          abstract: '仅一次连通测试',
          overview: '收到回复，无其他结论。',
          archiveOnly: true,
          reason: '没有可复用知识。',
        }),
      },
    });
    await runtime.runSummaryOnce();
    expect((await runtime.library.list(owner, { kind: 'note' })).total).toBe(0);
    const kept = await runtime.library.get(owner, source.id);
    expect(kept?.markdown).toContain('测试');
    expect(kept?.entry.summaryDisposition).toBe('archive_only');
    expect((await runtime.status(owner)).processing?.summary).toMatchObject({
      completed: 1,
      archivedOnly: 1,
      pending: 0,
    });
  });

  it('batches local file inventories without spending the model cooldown and preserves synthesis provenance', async () => {
    const session = await createSession(primary, '知识库决定');
    await append(session, 0, '人工编辑不得被覆盖。');
    await runtime.runOnce(false);
    for (const title of ['stations.json', 'tracks.csv']) {
      const detail = (await runtime.library.upsertSource(owner, {
        source: 'manual',
        sourceId: title,
        title,
        kind: 'document',
        markdown: '原件完整数据',
      }))!;
      await runtime.library.markParsed(owner, detail.entry.id, 'parsed');
    }
    for (const entry of (await runtime.library.list(owner)).entries)
      await runtime.library.markIndexed(owner, entry.id);
    const summarizeContent = vi.fn(async (_owner, input) => ({
      title: `${input.sources[0].title}概览`,
      abstract: '真实来源的说明',
      overview: '## 可核实内容\n字段与记录完整统计。',
      summaryMode: input.sources[0].kind === 'document' ? 'structured_overview' : 'model',
    }));
    Object.defineProperty(runtime, 'engine', { value: { summarizeContent } });
    await runtime.runSummaryOnce();
    expect(summarizeContent).toHaveBeenCalledTimes(3);
    expect(
      summarizeContent.mock.calls
        .slice(0, 2)
        .every((call) => call[1].sources[0].kind === 'document')
    ).toBe(true);
    expect(summarizeContent.mock.calls[0][1].forceSynthesis).toBe(false);
    const notes = await runtime.library.list(owner, { kind: 'note' });
    expect(
      notes.entries.filter((entry) => entry.summaryMode === 'structured_overview')
    ).toHaveLength(2);
    const overview = notes.entries.find((entry) => entry.summaryMode === 'structured_overview')!;
    expect((await runtime.library.get(owner, overview.id))?.markdown).toContain('不代表逐条解读');
    await runtime.runSummaryOnce();
    expect(summarizeContent).toHaveBeenCalledTimes(3);
  });

  it('prioritizes explicit synthesis across owners before unattended historical summaries', async () => {
    const session = await createSession(primary, '后台历史');
    await append(session, 0, '后台需要整理的资料');
    await runtime.runOnce(false);
    const archived = (await runtime.library.list(owner)).entries[0];
    await runtime.library.markIndexed(owner, archived.id);
    const source = (await runtime.library.upsertSource(otherOwner, {
      source: 'manual',
      sourceId: 'requested-source',
      kind: 'note',
      title: '主动选择的资料',
      markdown: '用户现在希望整理这些结论',
    }))!;
    const summarizeContent = vi.fn().mockResolvedValue({
      abstract: '主动任务完成',
      overview: '用户选择的来源结论',
      archiveOnly: true,
    });
    Object.defineProperty(runtime, 'engine', { value: { summarizeContent } });
    const draft = await runtime.organize(otherOwner, {
      entryIds: [source.entry.id],
      mode: 'automatic',
    });
    await runtime.runSummaryOnce();
    expect(summarizeContent).toHaveBeenCalledTimes(1);
    expect(summarizeContent.mock.calls[0][0]).toEqual(otherOwner);
    expect((await runtime.library.get(otherOwner, draft.entry.id))?.entry.generation?.state).toBe(
      'complete'
    );
    expect((await runtime.library.list(owner, { kind: 'note' })).total).toBe(0);
    await runtime.runSummaryOnce();
    expect(summarizeContent).toHaveBeenCalledTimes(1);
  });

  it('resumes partial summaries without failures and gives untouched sources their turn', async () => {
    for (const title of ['甲资料', '乙资料']) {
      const session = await createSession(primary, title);
      await append(session, 0, `${title}的长期保留规则。`);
    }
    await runtime.runOnce(false);
    for (const entry of (await runtime.library.list(owner)).entries)
      await runtime.library.markIndexed(owner, entry.id);
    const summarizeContent = vi.fn(async (_owner, input) => {
      input.onProgress({ phase: 'waiting_model', stage: 'map', completed: 0, total: 4 });
      expect((await runtime.status(owner)).processing?.summary.progress).toMatchObject({
        phase: 'waiting_model',
        completed: 0,
        total: 4,
      });
      return { pending: true, progress: { phase: 'queued', stage: 'map', completed: 2, total: 4 } };
    });
    Object.defineProperty(runtime, 'engine', { value: { summarizeContent } });
    await runtime.runSummaryOnce();
    const firstId = summarizeContent.mock.calls[0][1].id;
    const first = (await runtime.library.get(owner, firstId))!;
    expect(first.entry.summaryProgress).toMatchObject({ phase: 'queued', completed: 2, total: 4 });
    expect(first.entry.summaryAttempts).toBeUndefined();
    expect(first.entry.summaryMessage).toBeUndefined();
    expect(first.entry.summaryContentHash).toBeUndefined();
    expect((await runtime.status(owner)).processing?.summary).toMatchObject({
      pending: 2,
      failed: 0,
    });
    expect((await runtime.status(owner)).processing?.summary.progress).toBeUndefined();
    (runtime as unknown as { lastSummaryAt: number }).lastSummaryAt = 0;
    await runtime.runSummaryOnce();
    expect(summarizeContent.mock.calls[1][1].id).not.toBe(firstId);
  });

  it('persists explicit partial work as queued and fairly rotates requested drafts', async () => {
    await runtime.runOnce(false);
    const source = (await runtime.library.upsertSource(owner, {
      source: 'manual',
      sourceId: 'partial-source',
      kind: 'note',
      title: '来源',
      markdown: '完整来源',
    }))!;
    const summarizeContent = vi.fn().mockResolvedValue({
      pending: true,
      progress: { phase: 'queued', stage: 'reduce', completed: 1, total: 3, stageLevel: 1 },
    });
    Object.defineProperty(runtime, 'engine', { value: { summarizeContent } });
    const drafts = await Promise.all(
      ['专题甲', '专题乙'].map((title) =>
        runtime.organize(owner, { entryIds: [source.entry.id], mode: 'automatic', title })
      )
    );
    await runtime.runSummaryOnce();
    const firstId = summarizeContent.mock.calls[0][1].id;
    const first = (await runtime.library.get(owner, firstId))!;
    expect(first.entry.generation).toMatchObject({
      state: 'queued',
      progress: { stage: 'reduce', completed: 1, total: 3 },
    });
    expect(first.entry.generation?.attempts).toBeUndefined();
    expect(first.entry.generation?.retryAt).toBeUndefined();
    (runtime as unknown as { lastSummaryAt: number }).lastSummaryAt = 0;
    await runtime.runSummaryOnce();
    expect(summarizeContent.mock.calls[1][1].id).toBe(
      drafts.find((item) => item.entry.id !== firstId)!.entry.id
    );
  });

  it('stops background synthesis without marking a graceful pause as a failure', async () => {
    const session = await createSession(primary, '可恢复任务');
    await append(session, 0, '保存资料，后台逐步整理。');
    await runtime.runOnce(false);
    const source = (await runtime.library.list(owner)).entries[0];
    await runtime.library.markIndexed(owner, source.id);
    let cancel!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const engine = {
      summarizeContent: vi.fn(async (_owner, input) => {
        input.onProgress({ phase: 'waiting_model', stage: 'map', completed: 2, total: 5 });
        return new Promise((_, reject) => {
          cancel = () => reject(new OpenVikingError('暂停', 'CANCELLED'));
          began();
        });
      }),
      cancelPending: vi.fn(async () => cancel?.()),
    };
    Object.defineProperty(runtime, 'engine', { value: engine });
    const work = runtime.runSummaryOnce();
    await started;
    await runtime.stop();
    await work;
    const result = (await runtime.library.get(owner, source.id))!;
    expect(result.entry.summaryProgress).toMatchObject({ phase: 'queued', completed: 2 });
    expect(result.entry.summaryAttempts).toBeUndefined();
    expect(result.entry.summaryMessage).toBeUndefined();
  });

  it('clears the active label when initial progress persistence fails', async () => {
    const session = await createSession(primary, '进度写入失败');
    await append(session, 0, '仍需重试，不能留下永远运行的标记。');
    await runtime.runOnce(false);
    const source = (await runtime.library.list(owner)).entries[0];
    await runtime.library.markIndexed(owner, source.id);
    const engine = { summarizeContent: vi.fn() };
    Object.defineProperty(runtime, 'engine', { value: engine });
    vi.spyOn(runtime.library, 'markSummaryProgress').mockRejectedValueOnce(
      new Error('synthetic write error')
    );
    await runtime.runSummaryOnce();
    expect(engine.summarizeContent).not.toHaveBeenCalled();
    expect((await runtime.status(owner)).processing?.summary.active).toBeUndefined();
  });

  it('does not start a model after shutdown during source preparation', async () => {
    const session = await createSession(primary, '准备期间停止');
    await append(session, 0, '应停止发出新的请求。');
    await runtime.runOnce(false);
    const source = (await runtime.library.list(owner)).entries[0];
    await runtime.library.markIndexed(owner, source.id);
    const engine = { summarizeContent: vi.fn(), cancelPending: vi.fn() };
    Object.defineProperty(runtime, 'engine', { value: engine });
    vi.spyOn(runtime.library, 'markSummaryProgress').mockImplementationOnce(async () => {
      await runtime.stop();
      return true;
    });
    await runtime.runSummaryOnce();
    expect(engine.summarizeContent).not.toHaveBeenCalled();
  });

  it('keeps manual takeover when a queued automatic draft finishes late', async () => {
    const source = (await runtime.library.upsertSource(owner, {
      source: 'manual',
      sourceId: 'source',
      kind: 'document',
      title: '来源',
      markdown: '可用原文',
    }))!;
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    Object.defineProperty(runtime, 'engine', {
      value: {
        summarizeContent: vi.fn(async () => {
          began();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { abstract: '自动结果', overview: '不能覆盖人工结果' };
        }),
      },
    });
    const draft = await runtime.organize(owner, {
      entryIds: [source.entry.id],
      mode: 'automatic',
      title: '我的专题',
    });
    runtime.observe(owner);
    const work = (
      runtime as unknown as { summarizeOwner(owner: KnowledgeOwner): Promise<void> }
    ).summarizeOwner(owner);
    await started;
    await runtime.library.edit(
      owner,
      draft.entry.id,
      '# 我的人工总结\n保留我的分析',
      draft.entry.updatedAt,
      '我的标题'
    );
    finish();
    await work;
    const result = await runtime.library.get(owner, draft.entry.id);
    expect(result?.markdown).toContain('保留我的分析');
    expect(result?.entry.title).toBe('我的标题');
    expect(result?.entry.generation?.state).toBe('complete');
  });

  it('rejects cross-user source selection for manual synthesis', async () => {
    const privateSource = (await runtime.library.upsertSource(otherOwner, {
      source: 'manual',
      sourceId: 'secret',
      kind: 'note',
      title: '乙的资料',
      markdown: '秘密',
    }))!;
    await expect(
      runtime.organize(owner, { entryIds: [privateSource.entry.id], mode: 'manual' })
    ).rejects.toThrow('不存在');
  });

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
