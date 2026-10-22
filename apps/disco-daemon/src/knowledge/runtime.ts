import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveDiscoUserWorkspaceDirectory } from '@disco/core';
import {
  type DiscoConfig,
  getDataHome,
  getWorktreesRoot,
  loadConfigSync,
  resolveMultiTenancyConfig,
  resolveTenantsBaseFolderFromConfig,
} from '@disco/core/config';
import {
  and,
  asc,
  assertTenantWritable,
  eq,
  gt,
  MessagesRepository,
  runWithTenantDatabaseScope,
  type SessionRow,
  select,
  sessions,
  type TenantScopeAwareDatabase,
  UploadRepository,
  users,
} from '@disco/core/db';
import type {
  KnowledgeEntry,
  KnowledgeLibraryStatus,
  KnowledgeOwner,
  KnowledgeSource,
  Message,
  SessionID,
  TenantID,
  Upload,
  UserID,
} from '@disco/core/types';
import { getUploadStagingStore } from '../utils/upload-staging.js';
import { extractKnowledgeDocument } from './documents.js';
import { KnowledgeLibrary } from './library.js';
import {
  OpenVikingClient,
  type OpenVikingIdentity,
  type OpenVikingOptions,
  provisionOpenVikingOwner,
} from './openviking.js';
import {
  compareHostRolloutSource,
  discoConversationSource,
  type HostAttachmentResolution,
  hostAttachmentProvenance,
  hostRolloutFiles,
  hostRolloutIdentity,
  readHostRollout,
  resolveHostAttachment,
} from './sources.js';

export interface KnowledgeRuntimeConfig {
  enabled?: boolean;
  libraryRoot?: string;
  host?: {
    tenantId: string;
    userId: string;
    codexHome: string;
    token: string;
    attachmentRoots?: string[];
  };
  openviking?: {
    baseUrl: string;
    identities: OpenVikingIdentity[];
    provisioningKey?: string;
    summary?: OpenVikingOptions['summary'];
  };
  documents?: { pythonExecutable?: string; scriptPath?: string };
}
export interface KnowledgeSearchResult {
  results: Array<{ entry: KnowledgeEntry; excerpt: string; score?: number }>;
  engine: 'openviking' | 'local';
}

export function knowledgeConfigPath(): string {
  return resolve(
    process.env.DISCO_KNOWLEDGE_CONFIG || join(getDataHome(), 'knowledge', 'runtime.json')
  );
}

/** Operator configuration is outside the published source and never returned to browsers. */
export async function readKnowledgeConfig(): Promise<KnowledgeRuntimeConfig> {
  try {
    const value = JSON.parse(
      (await readFile(knowledgeConfigPath(), 'utf8')).replace(/^\uFEFF/, '')
    );
    if (!value || typeof value !== 'object') throw new Error('知识库配置无效');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('无法读取知识库运行配置');
  }
}

const ownerKey = (owner: KnowledgeOwner) => JSON.stringify([owner.tenantId, owner.userId]);

/** One local worker. All database work re-enters a short trusted tenant scope. */
export class KnowledgeRuntime {
  readonly library: KnowledgeLibrary;
  readonly engine?: OpenVikingClient;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;
  private states = new Map<string, NonNullable<KnowledgeLibraryStatus['sync']>>();
  private engineStates = new Map<string, NonNullable<KnowledgeLibraryStatus['engine']>>();
  private checkpoints = new Map<string, string>();
  private hostAttachmentCheckpoints = new Map<string, number>();
  private transcriptCheckpoints = new Map<string, { signature: string; scannedAt: number }>();
  private knownOwners = new Map<string, KnowledgeOwner>();
  private lastSummaryAt = 0;
  private summaryOwnerCursor = 0;
  private provisioning = new Map<string, Promise<OpenVikingIdentity | undefined>>();
  private configurationWrite: Promise<void> = Promise.resolve();
  private purged = new Set<string>();
  private sourceFailures = new Map<string, Set<string>>();

  constructor(
    readonly settings: KnowledgeRuntimeConfig,
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DiscoConfig
  ) {
    this.library = new KnowledgeLibrary(
      resolve(settings.libraryRoot || join(getDataHome(), 'knowledge', 'library')),
      {
        ownerRoot: (owner) =>
          join(
            resolveDiscoUserWorkspaceDirectory(getWorktreesRoot(owner.tenantId), owner.userId),
            '.disco',
            'knowledge',
            'library'
          ),
      }
    );
    if (settings.openviking) {
      this.engine = new OpenVikingClient({
        baseUrl: settings.openviking.baseUrl,
        summary: settings.openviking.summary,
        resolveIdentity: (owner) => this.resolveIndexIdentity(owner),
      });
    }
  }

  private async resolveIndexIdentity(
    owner: KnowledgeOwner
  ): Promise<OpenVikingIdentity | undefined> {
    const config = this.settings.openviking;
    if (!config) return undefined;
    const found = config.identities.find(
      (identity) => ownerKey(identity.owner) === ownerKey(owner)
    );
    if (found) return found;
    if (!config.provisioningKey) return undefined;
    const key = ownerKey(owner);
    const inflight = this.provisioning.get(key);
    if (inflight) return inflight;
    const work = (async () => {
      const identity = await provisionOpenVikingOwner(
        config.baseUrl,
        config.provisioningKey!,
        owner
      );
      config.identities.push(identity);
      this.configurationWrite = this.configurationWrite
        .catch(() => undefined)
        .then(async () => {
          const path = knowledgeConfigPath();
          await mkdir(dirname(path), { recursive: true });
          const temporary = `${path}.partial`;
          await writeFile(temporary, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
          await rename(temporary, path);
        });
      await this.configurationWrite;
      return identity;
    })();
    this.provisioning.set(key, work);
    try {
      return await work;
    } finally {
      this.provisioning.delete(key);
    }
  }

  observe(owner: KnowledgeOwner): void {
    this.knownOwners.set(ownerKey(owner), owner);
  }

  async assertWritable(owner: KnowledgeOwner): Promise<void> {
    await runWithTenantDatabaseScope(this.db, owner.tenantId, async (db) => {
      const user = await select(db, { id: users.user_id })
        .from(users)
        .where(eq(users.user_id, owner.userId))
        .one();
      if (!user) throw new Error('知识库用户不存在');
      await assertTenantWritable(db, owner.tenantId);
    });
  }

  async status(owner: KnowledgeOwner): Promise<KnowledgeLibraryStatus> {
    this.observe(owner);
    const sync = this.states.get(ownerKey(owner)) || {
      state: 'idle' as const,
      message: '等待后台同步',
    };
    const failures = this.sourceFailures.get(ownerKey(owner))?.size ?? 0;
    return {
      ...(await this.library.status(owner)),
      sync: failures
        ? { ...sync, message: `${sync.message}；${failures} 项暂无法读取，将自动重试` }
        : sync,
      engine: this.engineStates.get(ownerKey(owner)) || {
        status: this.engine ? 'unavailable' : 'disabled',
        message: this.engine
          ? '语义索引正在连接，本地文字检索可用'
          : '本地文字检索可用，语义索引尚未配置',
      },
    };
  }

  async search(
    owner: KnowledgeOwner,
    input: {
      query: string;
      source?: KnowledgeSource;
      entryIds?: string[];
      limit?: number;
    }
  ): Promise<KnowledgeSearchResult> {
    this.observe(owner);
    const limit = Math.max(1, Math.min(20, input.limit ?? 8));
    if (!input.query.trim() || (input.entryIds && input.entryIds.length === 0))
      return { results: [], engine: 'local' };
    if (this.engine) {
      try {
        const hits = await this.engine.search(owner, {
          query: input.query,
          limit: 40,
          documentIds: input.entryIds,
        });
        const results: KnowledgeSearchResult['results'] = [];
        for (const hit of hits) {
          const detail = await this.library.get(owner, hit.id);
          // Local deletion and latest human edits always outrank stale derived index copies.
          if (!detail || (input.source && detail.entry.source !== input.source)) continue;
          if (input.entryIds?.length && !input.entryIds.includes(hit.id)) continue;
          results.push({
            entry: detail.entry,
            excerpt: excerpt(detail.markdown, input.query),
            score: hit.score,
          });
          if (results.length >= limit) break;
        }
        this.engineStates.set(ownerKey(owner), { status: 'ready' });
        if (results.length) return { results, engine: 'openviking' };
      } catch {
        this.engineStates.set(ownerKey(owner), {
          status: 'unavailable',
          message: '语义检索暂不可用，已使用本地文字检索',
        });
      }
    }
    const entries: KnowledgeEntry[] = [];
    if (input.entryIds) {
      for (const id of input.entryIds) {
        const detail = await this.library.get(owner, id);
        if (
          detail &&
          (!input.source || detail.entry.source === input.source) &&
          `${detail.entry.title}\n${detail.markdown}`
            .toLocaleLowerCase()
            .includes(input.query.toLocaleLowerCase())
        )
          entries.push(detail.entry);
        if (entries.length >= limit) break;
      }
    } else {
      entries.push(
        ...(await this.library.list(owner, { query: input.query, source: input.source, limit }))
          .entries
      );
    }
    const results = [];
    for (const entry of entries) {
      const detail = await this.library.get(owner, entry.id);
      if (detail)
        results.push({ entry: detail.entry, excerpt: excerpt(detail.markdown, input.query) });
    }
    return { results, engine: 'local' };
  }

  async remove(owner: KnowledgeOwner, id: string): Promise<boolean> {
    const removed = await this.library.remove(owner, id);
    if (removed) {
      await this.purgeDeleted(owner);
    }
    return removed;
  }

  private async purgeDeleted(owner: KnowledgeOwner): Promise<void> {
    const deleted = new Set(await this.library.listDeletedIds(owner));
    for (const entry of await this.library.snapshot(owner)) {
      if (entry.derivedFrom && deleted.has(entry.derivedFrom.entryId) && !entry.humanEdited) {
        await this.library.remove(owner, entry.id);
        deleted.add(entry.id);
      }
    }
    if (!this.engine) return;
    for (const id of deleted) {
      const key = `${ownerKey(owner)}:${id}`;
      if (this.purged.has(key)) continue;
      try {
        await this.engine.delete(owner, id);
        this.purged.add(key);
      } catch {
        return;
      }
    }
  }

  start(): void {
    if (!this.stopped || this.settings.enabled === false) return;
    this.stopped = false;
    this.schedule(3000);
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.running = this.runOnce()
        .catch(() => {
          console.warn('[knowledge] 后台同步暂不可用，将自动重试');
        })
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(30_000);
        });
    }, delay);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  async runOnce(): Promise<void> {
    const tenancy = resolveMultiTenancyConfig(this.config);
    if (tenancy.mode === 'static') {
      const owners = (await runWithTenantDatabaseScope(this.db, tenancy.static_tenant_id, (db) =>
        select(db, { id: users.user_id }).from(users).all()
      )) as Array<{ id: string }>;
      for (const owner of owners)
        this.observe({ tenantId: tenancy.static_tenant_id, userId: owner.id });
    }
    // required_from_auth mode discovers owners only through authenticated requests.
    for (const owner of this.knownOwners.values()) {
      if (this.stopped) break;
      const state: NonNullable<KnowledgeLibraryStatus['sync']> = {
        state: 'running',
        message: '正在同步会话与资料',
        processed: 0,
      };
      this.states.set(ownerKey(owner), state);
      this.sourceFailures.set(ownerKey(owner), new Set());
      try {
        const exists = await runWithTenantDatabaseScope(this.db, owner.tenantId, (db) =>
          select(db, { id: users.user_id }).from(users).where(eq(users.user_id, owner.userId)).one()
        );
        if (!exists) {
          this.knownOwners.delete(ownerKey(owner));
          continue;
        }
        await this.assertWritable(owner);
        await this.library.reconcile(owner);
        await this.purgeDeleted(owner);
        const existing = new Map(
          (await this.library.snapshot(owner)).map((entry) => [
            `${entry.source}:${entry.sourceId}`,
            entry,
          ])
        );
        await this.importDisco(owner, existing, state);
        if (this.settings.host && ownerKey(this.settings.host) === ownerKey(owner)) {
          await this.importHost(owner, this.settings.host, existing, state);
        }
        // Durable pending/error status resumes parsing after a process exit,
        // including host attachments whose transcript itself has not changed.
        const unparsed = (await this.library.snapshot(owner)).filter(
          (entry) =>
            entry.kind === 'document' &&
            entry.attachments?.some((attachment) => attachment.id) &&
            (!entry.parseStatus || entry.parseStatus === 'pending' || entry.parseStatus === 'error')
        );
        for (const entry of unparsed.slice(0, 10)) {
          if (this.stopped) break;
          await extractKnowledgeDocument(
            this.library,
            owner,
            entry.id,
            this.settings.documents
          ).catch(() => this.sourceFailures.get(ownerKey(owner))?.add(`parse:${entry.id}`));
        }
        if (!this.stopped)
          this.states.set(ownerKey(owner), {
            state: 'idle',
            message: '会话与资料已同步',
            processed: state.processed,
            lastCompletedAt: new Date().toISOString(),
          });
      } catch {
        this.states.set(ownerKey(owner), {
          state: 'error',
          message: '部分资料尚未同步，后台将继续重试',
          processed: state.processed,
        });
      }
    }
    // Finish all users' archive pass before doing the slower derived processing.
    for (const owner of this.knownOwners.values()) {
      if (this.stopped) break;
      const state = this.states.get(ownerKey(owner));
      if (!state || state.state === 'error') continue;
      await this.indexOwner(owner, state, false).catch(() => undefined);
    }
    // Summarization starts only after every discovered owner's archive and index pass is complete.
    if (!this.engine || [...this.states.values()].some((state) => state.state === 'error')) return;
    for (const owner of this.knownOwners.values()) {
      if ((await this.library.snapshot(owner)).some((entry) => entry.indexStatus !== 'indexed'))
        return;
    }
    const summaryOwners = [...this.knownOwners.values()];
    for (let offset = 0; offset < summaryOwners.length; offset++) {
      const owner = summaryOwners[(this.summaryOwnerCursor + offset) % summaryOwners.length];
      if (this.stopped) break;
      const state = this.states.get(ownerKey(owner));
      if (state) await this.indexOwner(owner, state, true).catch(() => undefined);
    }
    this.summaryOwnerCursor = (this.summaryOwnerCursor + 1) % Math.max(1, summaryOwners.length);
  }

  private async importDisco(
    owner: KnowledgeOwner,
    existing: Map<string, KnowledgeEntry>,
    state: NonNullable<KnowledgeLibraryStatus['sync']>
  ): Promise<void> {
    let cursor = '';
    while (!this.stopped) {
      const page = (await runWithTenantDatabaseScope(this.db, owner.tenantId, (db) =>
        select(db)
          .from(sessions)
          .where(
            and(
              eq(sessions.created_by, owner.userId),
              ...(cursor ? [gt(sessions.session_id, cursor)] : [])
            )
          )
          .orderBy(asc(sessions.session_id))
          .limit(40)
          .all()
      )) as SessionRow[];
      if (!page.length) break;
      for (const session of page) {
        if (this.stopped) return;
        cursor = session.session_id;
        try {
          const updatedAt = new Date(session.updated_at ?? session.created_at).toISOString();
          const tail = await runWithTenantDatabaseScope(this.db, owner.tenantId, (db) =>
            new MessagesRepository(db).findPage({
              sessionId: session.session_id as SessionID,
              ownerSessionUserId: owner.userId as UserID,
              limit: 1,
              sort: { index: -1 },
            })
          );
          const checkpointKey = `${ownerKey(owner)}:${session.session_id}`;
          const signature = JSON.stringify([updatedAt, tail.total, tail.data[0]]);
          const checkpoint = this.transcriptCheckpoints.get(checkpointKey);
          // The tail detects streaming changes even when the session row is unchanged;
          // periodic full reconciliation also catches edits to earlier messages.
          if (checkpoint?.signature === signature && Date.now() - checkpoint.scannedAt < 600_000)
            continue;
          const messages: Message[] = [];
          for (let skip = 0; ; skip += 100) {
            const result = await runWithTenantDatabaseScope(this.db, owner.tenantId, (db) =>
              new MessagesRepository(db).findPage({
                sessionId: session.session_id as SessionID,
                ownerSessionUserId: owner.userId as UserID,
                limit: 100,
                skip,
                sort: { index: 1 },
              })
            );
            messages.push(...(result.data as Message[]));
            if (skip + result.data.length >= result.total) break;
          }
          const saved = await this.library.upsertSource(
            owner,
            discoConversationSource({
              id: session.session_id,
              title: session.data.title || session.data.description || '未命名会话',
              updatedAt,
              messages,
            })
          );
          if (saved) existing.set(`disco:${session.session_id}`, saved.entry);
          this.transcriptCheckpoints.set(checkpointKey, { signature, scannedAt: Date.now() });
          state.processed = (state.processed ?? 0) + 1;
        } catch {
          this.sourceFailures.get(ownerKey(owner))?.add(`session:${session.session_id}`);
        }
      }
    }
    const uploads = await runWithTenantDatabaseScope(this.db, owner.tenantId, (db) =>
      new UploadRepository(db).listByUploader(owner.tenantId as TenantID, owner.userId as UserID)
    );
    for (const upload of uploads) {
      if (this.stopped) return;
      if (upload.status !== 'active') continue;
      const previous = existing.get(`disco:upload:${upload.ref}`);
      try {
        if (previous?.attachments?.some((attachment) => attachment.id)) {
          if (
            !previous.parseStatus ||
            previous.parseStatus === 'pending' ||
            previous.parseStatus === 'error'
          ) {
            await extractKnowledgeDocument(
              this.library,
              owner,
              previous.id,
              this.settings.documents
            );
          }
          continue;
        }
        await this.importUpload(owner, upload);
        state.processed = (state.processed ?? 0) + 1;
      } catch {
        this.sourceFailures.get(ownerKey(owner))?.add(`upload:${upload.ref}`);
      }
    }
  }

  private async importUpload(owner: KnowledgeOwner, upload: Upload): Promise<void> {
    const name = upload.displayName || upload.originalName;
    const detail = await this.library.upsertSource(owner, {
      source: 'disco',
      sourceId: `upload:${upload.ref}`,
      title: name,
      kind: 'document',
      sourceUpdatedAt: upload.createdAt,
      sourceUrl: `/uploads/${upload.ref}/content`,
      markdown: `# ${name}\n\n来源：Disco 附件，原文件保留在归档附件中。\n\n关联会话：${upload.sessionId}`,
      rawContent: `${JSON.stringify(upload)}\n`,
    });
    if (!detail) return;
    const stream = await getUploadStagingStore().read({
      tenantId: owner.tenantId as TenantID,
      createdBy: owner.userId as UserID,
      sessionId: upload.sessionId,
      agentId: upload.agentId,
      ref: upload.ref,
    });
    await this.library.putAttachment(owner, detail.entry.id, {
      name,
      stream: stream as AsyncIterable<Uint8Array>,
      mimeType: upload.mimeType,
      sourceUrl: `/uploads/${upload.ref}/content`,
    });
    await extractKnowledgeDocument(this.library, owner, detail.entry.id, this.settings.documents);
  }

  private async importHost(
    owner: KnowledgeOwner,
    host: NonNullable<KnowledgeRuntimeConfig['host']>,
    existing: Map<string, KnowledgeEntry>,
    state: NonNullable<KnowledgeLibraryStatus['sync']>
  ): Promise<void> {
    state.message = '正在归档宿主机 Codex 历史';
    const roots = host.attachmentRoots ?? [join(host.codexHome, 'attachments')];
    for await (const path of hostRolloutFiles(host.codexHome)) {
      if (this.stopped) return;
      try {
        const info = await stat(path);
        const signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        if (
          this.checkpoints.get(path) === signature &&
          Date.now() - (this.hostAttachmentCheckpoints.get(path) ?? 0) < 600_000
        )
          continue;
        const id = await hostRolloutIdentity(path);
        const old = id ? existing.get(`codex:${id}`) : undefined;
        const source = await readHostRollout(path);
        if (!source) continue;
        const comparison = compareHostRolloutSource(source, old);
        if (comparison === 'older') {
          this.checkpoints.set(path, signature);
          this.hostAttachmentCheckpoints.set(path, Date.now());
          continue;
        }
        if (comparison === 'conflict') {
          source.sourceId = `${source.sourceId}:variant:${source.sourceVersion!.sha256}`;
          source.title = `${source.title}（保留的历史副本）`;
        }
        const references = hostAttachmentProvenance(source.rawContent ?? '');
        const attachments: HostAttachmentResolution[] = [];
        for (const reference of references) {
          const cwd = await approvedTranscriptCwd(
            reference.cwd ?? source.sessionCwd,
            owner,
            host.codexHome
          );
          const resolution = await resolveHostAttachment(
            reference,
            cwd ? [...roots, cwd] : roots,
            cwd
          );
          if (
            !attachments.some(
              (item) => item.reference === resolution.reference && item.cwd === resolution.cwd
            )
          )
            attachments.push(resolution);
        }
        const unavailable = attachments.filter((attachment) => attachment.status !== 'available');
        if (unavailable.length)
          source.markdown += `\n\n## 附件归档说明\n\n${unavailable.map((item) => `- ${item.reference}：${item.reason}`).join('\n')}\n`;
        const detail = await this.library.upsertSource(owner, source);
        if (detail) {
          existing.set(`codex:${source.sourceId}`, detail.entry);
          for (const attachment of attachments) {
            if (!attachment.path || attachment.status !== 'available') continue;
            const sourceId = `attachment:${source.sourceId}:${createHash('sha256').update(attachment.path).digest('hex')}`;
            const fileInfo = await stat(attachment.path);
            const sourceUpdatedAt = fileInfo.mtime.toISOString();
            const previous = existing.get(`codex:${sourceId}`);
            if (
              previous?.sourceUpdatedAt === sourceUpdatedAt &&
              previous.attachments?.some((file) => file.id && file.sizeBytes === fileInfo.size)
            ) {
              if (
                !previous.parseStatus ||
                previous.parseStatus === 'pending' ||
                previous.parseStatus === 'error'
              )
                await extractKnowledgeDocument(
                  this.library,
                  owner,
                  previous.id,
                  this.settings.documents
                );
              continue;
            }
            const document = await this.library.upsertSource(owner, {
              source: 'codex',
              sourceId,
              kind: 'document',
              title: basename(attachment.path),
              sourceUpdatedAt,
              sourceUrl: source.sourceUrl,
              markdown: `# ${basename(attachment.path)}\n\n来源：[${source.title}](/knowledge?entry=${detail.entry.id})。\n\n原件：${attachment.reference}`,
              rawContent: `${JSON.stringify({ ...attachment, sessionId: source.sourceId })}\n`,
            });
            if (!document) continue;
            await this.library.putAttachment(owner, document.entry.id, {
              name: basename(attachment.path),
              stream: createReadStream(attachment.path),
              sourceUrl: attachment.reference,
            });
            await extractKnowledgeDocument(
              this.library,
              owner,
              document.entry.id,
              this.settings.documents
            );
            const current = await this.library.get(owner, document.entry.id);
            if (current) existing.set(`codex:${sourceId}`, current.entry);
          }
        }
        this.checkpoints.set(path, signature);
        this.hostAttachmentCheckpoints.set(path, Date.now());
        state.processed = (state.processed ?? 0) + 1;
      } catch {
        this.sourceFailures.get(ownerKey(owner))?.add(`host:${path}`);
      }
    }
  }

  private async finishIndexAttempt(
    owner: KnowledgeOwner,
    id: string,
    contentHash: string,
    error?: string
  ): Promise<boolean> {
    const marked = await this.library.markIndexed(owner, id, contentHash, error);
    if (!marked) {
      // A provider may commit content after deletion, even when embedding then
      // fails. Both outcomes must invalidate the earlier successful purge.
      this.purged.delete(`${ownerKey(owner)}:${id}`);
      if (!(await this.library.get(owner, id))) await this.purgeDeleted(owner);
    }
    return marked;
  }

  private async indexOwner(
    owner: KnowledgeOwner,
    state: NonNullable<KnowledgeLibraryStatus['sync']>,
    allowSummary: boolean
  ): Promise<void> {
    if (!this.engine) return;
    const entries = await this.library.snapshot(owner);
    const pending = entries.filter((entry) => entry.indexStatus !== 'indexed');
    state.state = 'running';
    state.message = `正在建立本地语义索引，剩余 ${pending.length} 条`;
    // Small scheduling batches keep new archives and other owners moving during backfill.
    for (const entry of pending.slice(0, 20)) {
      if (this.stopped) return;
      const detail = await this.library.get(owner, entry.id);
      if (!detail) continue;
      try {
        await this.engine.index(owner, { id: entry.id, content: detail.markdown });
        if (!(await this.finishIndexAttempt(owner, entry.id, detail.contentHash))) continue;
        this.engineStates.set(ownerKey(owner), { status: 'ready' });
      } catch {
        await this.finishIndexAttempt(owner, entry.id, detail.contentHash, '语义索引待重试');
        this.engineStates.set(ownerKey(owner), {
          status: 'unavailable',
          message: '语义索引待重试，资料已完整归档',
        });
        return; // Back off an unavailable provider; do not hammer it for every historical entry.
      }
    }
    if (pending.length) return;
    state.state = 'idle';
    state.message = '归档与索引已同步';
    if (!allowSummary) return;
    if (Date.now() - this.lastSummaryAt < 60_000) return;
    const unfinished = entries.filter((entry) => !entry.derivedFrom && entry.kind !== 'note');
    for (const entry of unfinished) {
      if (this.stopped) return;
      const detail = await this.library.get(owner, entry.id);
      if (
        detail?.entry.indexStatus !== 'indexed' ||
        entry.summaryContentHash === detail.contentHash
      )
        continue;
      this.lastSummaryAt = Date.now();
      state.state = 'running';
      state.message = '正在低速整理知识摘要';
      try {
        const summary = await this.engine.summarize(owner, entry.id);
        const current = await this.library.get(owner, entry.id);
        if (!current || current.contentHash !== detail.contentHash) return;
        await this.library.upsertSource(owner, {
          source: entry.source,
          sourceId: `summary:${entry.id}`,
          kind: 'note',
          title: `摘要 · ${entry.title}`,
          derivedFrom: { entryId: entry.id, contentHash: detail.contentHash },
          sourceUrl: `/knowledge?entry=${entry.id}`,
          sourceUpdatedAt: entry.updatedAt,
          markdown: `# ${entry.title}\n\n> 自动整理，需结合原文核实。来源：[${entry.title}](/knowledge?entry=${entry.id})；资料版本：${detail.contentHash}。\n\n${summary.abstract}\n\n${summary.overview}`,
          rawContent: `${JSON.stringify({ sourceEntry: entry.id, sourceHash: detail.contentHash, generatedAt: new Date().toISOString(), ...summary })}\n`,
        });
        await this.library.markSummarized(owner, entry.id, detail.contentHash);
        state.state = 'idle';
        state.message = '已整理一条摘要，后台将继续处理';
      } catch {
        state.state = 'idle';
        state.message = '摘要暂未完成，归档与检索可用，稍后自动重试';
      }
      return;
    }
  }
}

/** Transcript cwd authorizes only explicitly linked files, never a directory crawl. */
export async function approvedTranscriptCwd(
  cwd: string | undefined,
  owner: KnowledgeOwner,
  codexHome: string
): Promise<string | undefined> {
  if (!cwd || !isAbsolute(cwd) || dirname(resolve(cwd)) === resolve(cwd)) return undefined;
  const canonical = await realpath(cwd).catch(() => undefined);
  if (
    !canonical ||
    (process.platform === 'win32'
      ? canonical.toLowerCase() !== resolve(cwd).toLowerCase()
      : canonical !== resolve(cwd))
  )
    return undefined;
  const inside = (root: string, target: string) => {
    const child = relative(resolve(root), resolve(target));
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  };
  const userRoot = resolveDiscoUserWorkspaceDirectory(
    getWorktreesRoot(owner.tenantId),
    owner.userId
  );
  // Private provider state and sibling Disco accounts never become import roots.
  const managedRoots = [
    getDataHome(),
    getWorktreesRoot(owner.tenantId),
    resolveTenantsBaseFolderFromConfig(loadConfigSync()),
  ];
  if (managedRoots.some((root) => inside(root, cwd) || inside(cwd, root)) && !inside(userRoot, cwd))
    return undefined;
  const privateRoots = [
    codexHome,
    dirname(knowledgeConfigPath()),
    ...(JSON.parse(process.env.DISCO_KNOWLEDGE_PRIVATE_ROOTS || '[]') as string[]),
  ];
  if (privateRoots.some((root) => inside(root, cwd) || inside(cwd, root))) return undefined;
  return resolve(cwd);
}

export function excerpt(text: string, query: string): string {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const positions = terms
    .map((term) => text.toLocaleLowerCase().indexOf(term))
    .filter((index) => index >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 100);
  return `${start ? '…' : ''}${text.slice(start, start + 1800)}${start + 1800 < text.length ? '…' : ''}`;
}
