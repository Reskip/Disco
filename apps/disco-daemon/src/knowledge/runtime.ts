import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  KnowledgeEntryDetail,
  KnowledgeLibraryStatus,
  KnowledgeOwner,
  KnowledgeSource,
  KnowledgeSummaryProgress,
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
  OpenVikingError,
  type OpenVikingIdentity,
  type OpenVikingOptions,
  provisionOpenVikingOwner,
} from './openviking.js';
import { canSummarize, organization, retryDate } from './organization.js';
import {
  fuseSearchRanks,
  isExactLookup,
  KnowledgeKeywordIndex,
  type KnowledgeMatch,
  knowledgeSearchEvidence,
  searchableBody,
  searchExcerpt,
  technicalAnchors,
  verifiedSemanticPosition,
} from './search.js';
import {
  compareHostRolloutSource,
  discoConversationSource,
  type HostAttachmentReference,
  type HostAttachmentResolution,
  type HostRolloutSource,
  hostArchiveDisplayTitle,
  hostAttachmentProvenance,
  hostRolloutFiles,
  hostRolloutIdentity,
  needsHostTitleRepair,
  readHostRollout,
  resolveHostAttachment,
} from './sources.js';
import { exportHostSqliteThread, hostSqliteThreads } from './sources-sqlite-worker-client.js';

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
  results: Array<{
    entry: KnowledgeEntry;
    excerpt: string;
    score?: number;
    match?: KnowledgeMatch;
  }>;
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
  private readonly keywordIndex = new KnowledgeKeywordIndex();
  readonly engine?: OpenVikingClient;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private indexTimer?: ReturnType<typeof setTimeout>;
  private summaryTimer?: ReturnType<typeof setTimeout>;
  private indexing?: Promise<void>;
  private summarizing?: Promise<void>;
  private archiveReady = new Set<string>();
  private recoveredSummaryOwners = new Set<string>();
  private activeIndex = new Map<string, string>();
  private activeSummary = new Map<string, string>();
  private activeSummaryProgress = new Map<string, KnowledgeSummaryProgress>();
  private keywordWarmups = new Map<string, Promise<void>>();
  private keywordWarmedAt = new Map<string, number>();
  private stopped = true;
  private archiveAbort = new AbortController();
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
    this.warmKeywords(owner);
  }

  private warmKeywords(owner: KnowledgeOwner): void {
    const key = ownerKey(owner);
    if (
      this.stopped ||
      this.keywordWarmups.has(key) ||
      Date.now() - (this.keywordWarmedAt.get(key) ?? 0) < 30_000
    )
      return;
    const work = (async () => {
      const entries = (await this.library.snapshot(owner)).filter((entry) => !entry.historical);
      await this.keywordIndex.warm(
        key,
        entries,
        new Set(entries.map((entry) => entry.id)),
        (id) => this.library.get(owner, id),
        () => !this.stopped
      );
      this.keywordWarmedAt.set(key, Date.now());
    })()
      .catch(() => undefined)
      .finally(() => this.keywordWarmups.delete(key));
    this.keywordWarmups.set(key, work);
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

  async status(
    owner: KnowledgeOwner,
    snapshot?: KnowledgeLibraryStatus
  ): Promise<KnowledgeLibraryStatus> {
    this.observe(owner);
    const sync = this.states.get(ownerKey(owner)) || {
      state: 'idle' as const,
      message: '等待后台同步',
    };
    const failures = this.sourceFailures.get(ownerKey(owner))?.size ?? 0;
    const status = snapshot ?? (await this.library.status(owner));
    if (status.processing) {
      status.processing.index.active = this.activeIndex.get(ownerKey(owner));
      status.processing.summary.active = this.activeSummary.get(ownerKey(owner));
      status.processing.summary.progress = this.activeSummaryProgress.get(ownerKey(owner));
      status.processing.summary.message = this.archiveReady.has(ownerKey(owner))
        ? '已建立索引的资料会分批整理，失败项单独重试'
        : '首次归档尚未完成，自动整理将在归档完成后开始';
    }
    return {
      ...status,
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
    const allEntries = (await this.library.snapshot(owner)).filter((entry) => !entry.historical);
    const selected = input.entryIds ? new Set(input.entryIds) : undefined;
    const entries = allEntries.filter(
      (entry) =>
        (!selected || selected.has(entry.id)) && (!input.source || entry.source === input.source)
    );
    if (!entries.length) return { results: [], engine: 'local' };
    const allowed = new Set(entries.map((entry) => entry.id));
    const exact = isExactLookup(input.query) || technicalAnchors(input.query).length > 0;
    const keywordWork = this.keywordIndex.search(
      ownerKey(owner),
      entries,
      new Set(allEntries.map((entry) => entry.id)),
      input.query,
      (id) => this.library.get(owner, id),
      40
    );
    const semanticWork = (async () => {
      if (!this.engine || exact) return [];
      try {
        const hits = await this.engine.search(owner, {
          query: input.query,
          limit: 40,
          // Apply source and explicit ID scopes before vector retrieval, so
          // out-of-scope chunks cannot crowd out all relevant candidates.
          documentIds: selected || input.source ? [...allowed] : undefined,
        });
        this.engineStates.set(ownerKey(owner), { status: 'ready' });
        return hits.filter((hit) => allowed.has(hit.id));
      } catch {
        this.engineStates.set(ownerKey(owner), {
          status: 'unavailable',
          message: '语义检索暂不可用，已使用本地文字检索',
        });
        return [];
      }
    })();
    const [semantic, keyword] = await Promise.all([semanticWork, keywordWork]);
    const semanticById = new Map(semantic.map((hit) => [hit.id, hit]));
    const keywordIds = new Set(keyword.map((hit) => hit.id));
    const candidates = new Map<string, KnowledgeSearchResult['results'][number]>();
    const validSemantic = new Set<string>();
    const validKeyword = new Set<string>();
    const keywordWeights = new Map<string, number>();
    for (const id of new Set([...semanticById.keys(), ...keywordIds])) {
      const detail = await this.library.get(owner, id);
      if (
        !detail ||
        detail.entry.historical ||
        (input.source && detail.entry.source !== input.source)
      )
        continue;
      const evidence = knowledgeSearchEvidence(detail, input.query);
      if (!evidence.technical) continue;
      const hit = semanticById.get(id);
      let position = hit ? verifiedSemanticPosition(detail.markdown, hit.excerpt) : undefined;
      if (
        position !== undefined &&
        !searchableBody(detail)
          .slice(position, position + hit!.excerpt.length)
          .trim()
      )
        position = undefined;
      const lexical = keywordIds.has(id) && evidence.matched > 0;
      // An unparsed image/archive has only filename metadata; it cannot provide
      // semantic evidence about its actual contents.
      if (detail.entry.kind === 'document' && detail.entry.parseStatus !== 'parsed' && !lexical)
        continue;
      // Stale or fabricated provider text never becomes a quoted source. A
      // changed human note can still be returned by current keyword evidence.
      if (position === undefined && !lexical) continue;
      if (position !== undefined) validSemantic.add(id);
      if (lexical) {
        validKeyword.add(id);
        keywordWeights.set(id, evidence.keywordWeight);
      }
      candidates.set(id, {
        entry: detail.entry,
        ...searchExcerpt(
          detail,
          input.query,
          position !== undefined ? (lexical ? 'hybrid' : 'semantic') : 'keyword',
          position !== undefined ? { position, length: hit!.excerpt.length } : undefined
        ),
      });
    }
    const results = fuseSearchRanks(
      semantic.map((hit) => hit.id).filter((id) => validSemantic.has(id)),
      keyword.map((hit) => hit.id).filter((id) => validKeyword.has(id)),
      keywordWeights
    )
      .slice(0, limit)
      .map(({ id, score }) => ({ ...candidates.get(id)!, score }));
    return { results, engine: validSemantic.size ? 'openviking' : 'local' };
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
    for (const entry of await this.library.snapshot(owner)) {
      if (!entry.historical || this.purged.has(`history:${entry.id}`)) continue;
      try {
        await this.engine.delete(owner, entry.id);
        this.purged.add(`history:${entry.id}`);
      } catch {
        return;
      }
    }
  }

  start(): void {
    if (!this.stopped || this.settings.enabled === false) return;
    this.stopped = false;
    this.archiveAbort = new AbortController();
    this.schedule(3000);
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      if (!this.indexTimer) this.scheduleDerived('index', 1000);
      if (!this.summaryTimer) this.scheduleDerived('summary', 5000);
      this.running = this.runOnce(false)
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
  private scheduleDerived(kind: 'index' | 'summary', delay: number): void {
    const timer = setTimeout(() => {
      const work = (kind === 'index' ? this.runIndexOnce() : this.runSummaryOnce())
        .catch(() => console.warn(`[knowledge] ${kind} worker will retry`))
        .finally(() => {
          if (kind === 'index') this.indexing = undefined;
          else this.summarizing = undefined;
          if (!this.stopped) this.scheduleDerived(kind, kind === 'index' ? 3000 : 15_000);
        });
      if (kind === 'index') this.indexing = work;
      else this.summarizing = work;
    }, delay);
    timer.unref();
    if (kind === 'index') this.indexTimer = timer;
    else this.summaryTimer = timer;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.archiveAbort.abort();
    clearTimeout(this.timer);
    clearTimeout(this.indexTimer);
    clearTimeout(this.summaryTimer);
    this.indexTimer = undefined;
    this.summaryTimer = undefined;
    const cancellation = this.engine?.cancelPending?.();
    const settled = await Promise.allSettled([
      this.running,
      this.indexing,
      this.summarizing,
      cancellation,
      ...this.keywordWarmups.values(),
    ]);
    this.keywordIndex.clear();
    this.keywordWarmedAt.clear();
    if (settled[3].status === 'rejected') throw settled[3].reason;
  }

  async runOnce(includeDerived = true): Promise<void> {
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
        intervalSeconds: 30,
        lastCompletedAt: this.states.get(ownerKey(owner))?.lastCompletedAt,
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
        if (
          !this.recoveredSummaryOwners.has(ownerKey(owner)) &&
          !this.activeSummary.has(ownerKey(owner))
        ) {
          await this.library.recoverSummaryProgress(owner);
          this.recoveredSummaryOwners.add(ownerKey(owner));
        }
        await this.library.reconcile(owner);
        const existing = new Map(
          (await this.library.snapshot(owner)).map((entry) => [
            `${entry.source}:${entry.sourceId}`,
            entry,
          ])
        );
        for (const entry of existing.values()) {
          if (this.stopped) break;
          if (
            entry.source !== 'codex' ||
            entry.kind !== 'conversation' ||
            entry.historical ||
            entry.humanEdited ||
            (entry.titleProjectionVersion ?? 0) >= 1 ||
            !needsHostTitleRepair(entry.title, entry.sourceId)
          )
            continue;
          const detail = await this.library.get(owner, entry.id);
          if (!detail) continue;
          const title = hostArchiveDisplayTitle(
            detail.markdown,
            entry.sourceId,
            detail.entry.title
          );
          if (
            await this.library.repairImportedTitle(
              owner,
              entry.id,
              detail.contentHash,
              detail.entry.title,
              title
            )
          ) {
            entry.title = title ?? entry.title;
            entry.titleProjectionVersion = 1;
          }
        }
        await this.importDisco(owner, existing, state);
        if (this.settings.host && ownerKey(this.settings.host) === ownerKey(owner)) {
          await this.importHost(owner, this.settings.host, existing, state);
        }
        this.archiveReady.add(ownerKey(owner));
        if (!this.stopped)
          this.states.set(ownerKey(owner), {
            state: 'idle',
            message: '会话与资料已同步',
            processed: state.processed,
            lastCompletedAt: new Date().toISOString(),
            intervalSeconds: 30,
            nextRunAt: new Date(Date.now() + 30_000).toISOString(),
          });
      } catch {
        this.states.set(ownerKey(owner), {
          state: 'error',
          message: '部分资料尚未同步，后台将继续重试',
          processed: state.processed,
        });
      }
    }
    if (includeDerived) {
      await this.runIndexOnce();
      await this.runSummaryOnce();
    }
  }

  async runIndexOnce(): Promise<void> {
    for (const owner of this.knownOwners.values()) {
      if (this.stopped) break;
      const state = this.states.get(ownerKey(owner));
      if (!state) continue;
      try {
        await this.assertWritable(owner);
        await this.purgeDeleted(owner);
        // Extraction runs independently of archive polling and model generation.
        const unparsed = (await this.library.snapshot(owner)).filter(
          (entry) =>
            entry.kind === 'document' &&
            !entry.historical &&
            entry.attachments?.some((file) => file.id) &&
            (!entry.parseStatus ||
              entry.parseStatus === 'pending' ||
              (entry.parseStatus === 'unsupported' &&
                ['.gpx', '.kml'].includes(
                  extname(entry.attachments.at(-1)?.name ?? '').toLowerCase()
                )) ||
              (entry.parseStatus === 'error' &&
                entry.parseRetryable !== false &&
                (!entry.parseRetryAt || Date.parse(entry.parseRetryAt) <= Date.now())))
        );
        for (const entry of unparsed.slice(0, 10)) {
          if (this.stopped) return;
          await extractKnowledgeDocument(
            this.library,
            owner,
            entry.id,
            this.settings.documents
          ).catch(() => undefined);
        }
        await this.indexOwner(owner).catch(() => undefined);
      } catch {}
    }
  }

  async runSummaryOnce(): Promise<void> {
    if (!this.engine || Date.now() - this.lastSummaryAt < 60_000) return;
    const summaryOwners = [...this.knownOwners.values()];
    const candidates: Array<{ owner: KnowledgeOwner; index: number; requested: boolean }> = [];
    for (let offset = 0; offset < summaryOwners.length; offset++) {
      const index = (this.summaryOwnerCursor + offset) % summaryOwners.length;
      const owner = summaryOwners[index];
      if (this.stopped) break;
      if (!this.states.has(ownerKey(owner))) continue;
      try {
        const requested = (await this.library.snapshot(owner)).some(
          (entry) =>
            !entry.historical &&
            !entry.humanEdited &&
            entry.generation &&
            entry.generation.state !== 'complete' &&
            (!entry.generation.retryAt || Date.parse(entry.generation.retryAt) <= Date.now())
        );
        candidates.push({ owner, index, requested });
      } catch {
        // A temporarily unreadable owner's archive must not stall other queues.
      }
    }
    candidates.sort((a, b) => Number(b.requested) - Number(a.requested));
    for (const candidate of candidates) {
      if (this.stopped) break;
      const before = this.lastSummaryAt;
      for (let localBatch = 0; localBatch < 4 && !this.stopped; localBatch++) {
        const result = await this.summarizeOwner(candidate.owner).catch(() => undefined);
        if (result !== 'local') break;
        // Small local inventories need no model cooldown, but yield between owners.
        this.summaryOwnerCursor = (candidate.index + 1) % summaryOwners.length;
      }
      if (this.lastSummaryAt !== before) {
        this.summaryOwnerCursor = (candidate.index + 1) % summaryOwners.length;
        break;
      }
    }
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
        if (previous?.attachments?.some((attachment) => attachment.id)) continue;
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
  }

  private async importHost(
    owner: KnowledgeOwner,
    host: NonNullable<KnowledgeRuntimeConfig['host']>,
    existing: Map<string, KnowledgeEntry>,
    state: NonNullable<KnowledgeLibraryStatus['sync']>
  ): Promise<void> {
    state.message = '正在归档宿主机 Codex 历史';
    const sqliteThreads = await hostSqliteThreads(host.codexHome, {
      signal: this.archiveAbort.signal,
    });
    const sqliteIds = new Set(sqliteThreads.map((thread) => thread.id));
    for (const thread of sqliteThreads) {
      if (this.stopped) return;
      const previous = existing.get(`codex:${thread.id}`);
      const checkpoint = `sqlite:${thread.id}`;
      if (
        previous?.sourceVersion?.signature === thread.signature &&
        (this.checkpoints.get(checkpoint) === thread.signature ||
          (await this.library.hasRawSource(owner, previous.id, previous.sourceVersion.sha256)))
      ) {
        if (Date.now() - (this.hostAttachmentCheckpoints.get(checkpoint) ?? 0) >= 600_000) {
          const references = await this.library.hostReferences(owner, previous.id);
          const detail = references ? await this.library.get(owner, previous.id) : null;
          if (references && detail) {
            const source: HostRolloutSource = {
              ...previous,
              markdown: detail.markdown,
              sessionCwd: thread.cwd,
              sessionCwds: [thread.cwd],
            };
            const attachments = await this.resolveHostReferences(owner, host, source, references);
            await this.importHostAttachments(owner, source, detail, attachments, existing);
            this.hostAttachmentCheckpoints.set(checkpoint, Date.now());
            continue;
          }
        } else continue;
      }
      const stage = join(dirname(knowledgeConfigPath()), 'staging');
      await mkdir(stage, { recursive: true });
      const archivePath = join(stage, `${randomUUID()}.jsonl`);
      try {
        const exported = await exportHostSqliteThread(host.codexHome, thread.id, archivePath, {
          signal: this.archiveAbort.signal,
        });
        if (!exported) continue;
        if (previous?.sourceVersion?.kind === 'codex-rollout')
          await this.library.preserveRawRevision(owner, previous.id);
        const detail = await this.archiveHostSource(
          owner,
          host,
          exported.source,
          exported.references,
          existing
        );
        if (detail) {
          const stream = createReadStream(exported.rawArchive.path);
          try {
            await this.library.putRawSource(owner, detail.entry.id, {
              stream,
              sha256: exported.rawArchive.sha256,
            });
          } finally {
            stream.destroy();
          }
          this.checkpoints.set(checkpoint, exported.source.sourceVersion!.signature!);
          this.hostAttachmentCheckpoints.set(checkpoint, Date.now());
          state.processed = (state.processed ?? 0) + 1;
        }
      } catch {
        this.sourceFailures.get(ownerKey(owner))?.add(`sqlite:${thread.id}`);
      } finally {
        await unlink(archivePath).catch(() => undefined);
      }
    }
    for (const entry of existing.values()) {
      if (entry.source !== 'codex' || !entry.sourceId.includes(':variant:') || entry.humanEdited)
        continue;
      await this.library.markHistorical(owner, entry.id);
    }
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
        if (id && sqliteIds.has(id)) {
          const entry = existing.get(`codex:${id}`);
          if (entry && !this.checkpoints.has(`preserved:${path}`)) {
            const stream = createReadStream(path);
            try {
              await this.library.preserveExternalRawRevision(owner, entry.id, stream);
            } finally {
              stream.destroy();
            }
            this.checkpoints.set(`preserved:${path}`, signature);
          }
          continue;
        }
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
        await this.archiveHostSource(
          owner,
          host,
          source,
          hostAttachmentProvenance(source.rawContent ?? ''),
          existing
        );
        this.checkpoints.set(path, signature);
        this.hostAttachmentCheckpoints.set(path, Date.now());
        state.processed = (state.processed ?? 0) + 1;
      } catch {
        this.sourceFailures.get(ownerKey(owner))?.add(`host:${path}`);
      }
    }
  }

  private async archiveHostSource(
    owner: KnowledgeOwner,
    host: NonNullable<KnowledgeRuntimeConfig['host']>,
    source: HostRolloutSource,
    references: HostAttachmentReference[],
    existing: Map<string, KnowledgeEntry>
  ): Promise<KnowledgeEntryDetail | null> {
    const attachments = await this.resolveHostReferences(owner, host, source, references);
    const unavailable = attachments.filter((attachment) => attachment.status !== 'available');
    if (unavailable.length)
      source.markdown += `\n\n## 附件归档说明\n\n${unavailable.map((item) => `- ${item.reference}：${item.reason}`).join('\n')}\n`;
    const detail = await this.library.upsertSource(owner, source);
    if (detail) {
      existing.set(`codex:${source.sourceId}`, detail.entry);
      await this.importHostAttachments(owner, source, detail, attachments, existing);
      await this.library.hostReferences(owner, detail.entry.id, references);
    }
    return detail;
  }

  private async resolveHostReferences(
    owner: KnowledgeOwner,
    host: NonNullable<KnowledgeRuntimeConfig['host']>,
    source: HostRolloutSource,
    references: HostAttachmentReference[]
  ): Promise<HostAttachmentResolution[]> {
    const roots = host.attachmentRoots ?? [join(host.codexHome, 'attachments')];
    const attachments: HostAttachmentResolution[] = [];
    for (const reference of references) {
      const cwd = await approvedTranscriptCwd(
        reference.cwd ?? source.sessionCwd,
        owner,
        host.codexHome
      );
      const resolution = await resolveHostAttachment(reference, cwd ? [...roots, cwd] : roots, cwd);
      if (
        !attachments.some(
          (item) => item.reference === resolution.reference && item.cwd === resolution.cwd
        )
      )
        attachments.push(resolution);
    }
    return attachments;
  }

  private async importHostAttachments(
    owner: KnowledgeOwner,
    source: HostRolloutSource,
    detail: KnowledgeEntryDetail,
    attachments: HostAttachmentResolution[],
    existing: Map<string, KnowledgeEntry>
  ): Promise<void> {
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
      const current = await this.library.get(owner, document.entry.id);
      if (current) existing.set(`codex:${sourceId}`, current.entry);
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

  private async indexOwner(owner: KnowledgeOwner): Promise<void> {
    if (!this.engine) return;
    const entries = await this.library.snapshot(owner);
    const pending = entries
      .filter(
        (entry) =>
          !entry.historical &&
          entry.indexStatus !== 'indexed' &&
          (!entry.indexRetryAt || Date.parse(entry.indexRetryAt) <= Date.now())
      )
      .sort(
        (a, b) =>
          Number(b.kind === 'note') - Number(a.kind === 'note') ||
          Number(canSummarize(b)) - Number(canSummarize(a)) ||
          (a.indexAttempts ?? 0) - (b.indexAttempts ?? 0) ||
          a.sizeBytes - b.sizeBytes
      );
    for (const entry of pending.slice(0, 20)) {
      if (this.stopped) return;
      const detail = await this.library.get(owner, entry.id);
      if (!detail) continue;
      this.activeIndex.set(ownerKey(owner), entry.title);
      try {
        await this.engine.index(owner, { id: entry.id, content: detail.markdown });
        if (!(await this.finishIndexAttempt(owner, entry.id, detail.contentHash))) continue;
        this.engineStates.set(ownerKey(owner), { status: 'ready' });
      } catch (error) {
        const message =
          error instanceof OpenVikingError ? error.message : '此资料索引失败，将自动重试';
        await this.finishIndexAttempt(owner, entry.id, detail.contentHash, message);
        if (
          error instanceof OpenVikingError &&
          ['UNAVAILABLE', 'UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)
        )
          this.engineStates.set(ownerKey(owner), { status: 'unavailable', message });
        // One broken document must not starve the rest. A down service backs off the worker.
        if (error instanceof OpenVikingError && error.code === 'UNAVAILABLE') return;
      } finally {
        this.activeIndex.delete(ownerKey(owner));
      }
    }
  }

  async organize(
    owner: KnowledgeOwner,
    input: { entryIds: string[]; title?: string; topic?: string; mode: 'manual' | 'automatic' }
  ): Promise<KnowledgeEntryDetail> {
    await this.assertWritable(owner);
    const entries: KnowledgeEntryDetail[] = [];
    for (const id of [...new Set(input.entryIds)]) {
      const detail = await this.library.get(owner, id);
      if (!detail) throw Object.assign(new Error('所选资料不存在或已删除'), { status: 404 });
      entries.push(detail);
    }
    if (!entries.length) throw Object.assign(new Error('请先选择要整理的资料'), { status: 400 });
    if (input.mode === 'automatic' && !this.engine)
      throw Object.assign(new Error('自动整理尚未配置，仍可人工整理'), { status: 503 });
    if (
      input.mode === 'automatic' &&
      entries.some(
        (item) =>
          item.entry.kind === 'document' &&
          (item.entry.attachments?.length || item.entry.parseStatus) &&
          item.entry.parseStatus !== 'parsed'
      )
    )
      throw Object.assign(
        new Error('部分资料尚无可读取正文，请等待解析或选择人工整理；图片和压缩包可保留为来源附件'),
        { status: 400 }
      );
    const title =
      input.title?.trim() ||
      (entries.length === 1 ? entries[0].entry.title : `${input.topic?.trim() || '专题'}整理`);
    const automatic = input.mode === 'automatic';
    const detail = await this.library.upsertSource(owner, {
      source: 'manual',
      sourceId: randomUUID(),
      kind: 'note',
      title,
      automated: automatic,
      expectedSources: entries.map((item) => ({
        id: item.entry.id,
        contentHash: item.contentHash,
      })),
      sourceReferences: entries.map((item) => ({
        id: item.entry.id,
        title: item.entry.title,
        contentHash: item.contentHash,
      })),
      organization: {
        topic: input.topic?.trim() || '未分类',
        level: 'knowledge',
        state: 'draft',
        sourceEntryIds: entries.map((item) => item.entry.id),
      },
      generation: automatic
        ? {
            state: 'queued',
            requestedTitle: input.title?.trim() || undefined,
            message: '已加入后台整理队列，可继续浏览资料',
          }
        : undefined,
      markdown: `# ${title}\n\n${automatic ? '> 已加入自动整理队列，完成后会显示草稿。现在手工编辑保存将接管这篇笔记。' : '## 结论与知识\n\n在这里归纳结论、适用条件和操作方法。\n\n## 待确认\n\n记录冲突或仍需核实的问题。'}\n\n## 来源\n\n${entries.map((item) => `- [${item.entry.title}](/knowledge?entry=${item.entry.id})`).join('\n')}\n`,
    });
    if (!detail) throw new Error('无法建立整理笔记');
    return (await this.library.get(owner, detail.entry.id))!;
  }

  private async summarizeOwner(owner: KnowledgeOwner): Promise<'local' | undefined> {
    if (!this.engine || this.stopped || Date.now() - this.lastSummaryAt < 60_000) return;
    await this.assertWritable(owner);
    const entries = await this.library.snapshot(owner);
    // Explicit requests work even during initial backfill and survive a process restart.
    const requested = entries
      .filter(
        (entry) =>
          !entry.historical &&
          !entry.humanEdited &&
          entry.generation &&
          entry.generation.state !== 'complete' &&
          (!entry.generation.retryAt || Date.parse(entry.generation.retryAt) <= Date.now())
      )
      .sort((a, b) =>
        (a.generation?.lastAttemptAt ?? '').localeCompare(b.generation?.lastAttemptAt ?? '')
      )[0];
    let target = requested ? await this.library.get(owner, requested.id) : null;
    const inputs: KnowledgeEntryDetail[] = [];
    if (target) {
      for (const id of organization(target.entry).sourceEntryIds ?? []) {
        const source = await this.library.get(owner, id);
        if (!source) {
          await this.library.markGeneration(owner, target.entry.id, {
            ...target.entry.generation,
            state: 'failed',
            message: '所选资料中有来源已删除，无法完整整理；可编辑笔记或重新选择资料',
            retryAt: new Date(Date.now() + 86400_000).toISOString(),
          });
          return;
        }
        inputs.push(source);
      }
      if (!inputs.length) {
        await this.library.markGeneration(owner, target.entry.id, {
          state: 'failed',
          message: '原始资料已删除，无法继续自动整理',
          retryAt: new Date(Date.now() + 86400_000).toISOString(),
        });
        return;
      }
    } else {
      if (!this.archiveReady.has(ownerKey(owner))) return;
      const outdatedOverviews = new Set(
        entries
          .filter(
            (entry) =>
              !entry.historical &&
              !entry.humanEdited &&
              entry.summaryMode === 'structured_overview' &&
              entry.summaryFormatVersion !== 1 &&
              organization(entry).level === 'summary' &&
              organization(entry).state === 'draft'
          )
          .map((entry) => entry.derivedFrom?.entryId)
          .filter((id): id is string => Boolean(id))
      );
      // Independent owner/source readiness avoids a permanent all-users/all-files barrier.
      const eligible = entries
        .filter(
          (entry) =>
            !entry.historical &&
            canSummarize(entry) &&
            entry.indexStatus === 'indexed' &&
            (!entry.summaryRetryAt || Date.parse(entry.summaryRetryAt) <= Date.now())
        )
        .sort(
          (a, b) =>
            Number(outdatedOverviews.has(b.id)) - Number(outdatedOverviews.has(a.id)) ||
            (a.summaryAttemptedAt ?? '').localeCompare(b.summaryAttemptedAt ?? '') ||
            Number(isStructuredSummaryCandidate(b)) - Number(isStructuredSummaryCandidate(a)) ||
            Number(b.kind === 'conversation') - Number(a.kind === 'conversation') ||
            (a.summaryAttempts ?? 0) - (b.summaryAttempts ?? 0) ||
            summaryAgeWeek(a) - summaryAgeWeek(b) ||
            a.sizeBytes - b.sizeBytes
        );
      for (const entry of eligible) {
        const source = await this.library.get(owner, entry.id);
        if (
          source &&
          (source.entry.summaryContentHash !== source.contentHash ||
            (outdatedOverviews.has(entry.id) && source.entry.summaryDisposition !== 'archive_only'))
        ) {
          inputs.push(source);
          break;
        }
      }
      if (!inputs.length) return;
    }
    const previousSummaryAt = this.lastSummaryAt;
    this.lastSummaryAt = Date.now();
    const attemptedAt = new Date().toISOString();
    let progressWrites = Promise.resolve();
    let progressSavedAt = 0;
    let progressSavedPhase: string | undefined;
    const recordProgress = (progress: KnowledgeSummaryProgress): void => {
      this.activeSummaryProgress.set(ownerKey(owner), progress);
      const phase = `${progress.stage}:${progress.phase}`;
      if (
        phase === progressSavedPhase &&
        progress.phase !== 'queued' &&
        Date.now() - progressSavedAt < 15_000
      )
        return;
      progressSavedAt = Date.now();
      progressSavedPhase = phase;
      progressWrites = progressWrites
        .then(async () => {
          if (target)
            await this.library.markGeneration(owner, target.entry.id, {
              ...target.entry.generation,
              state: progress.phase === 'queued' ? 'queued' : 'running',
              message: undefined,
              retryAt: undefined,
              lastAttemptAt: attemptedAt,
              progress,
            });
          else
            await this.library.markSummaryProgress(
              owner,
              inputs[0].entry.id,
              inputs[0].contentHash,
              progress,
              attemptedAt
            );
        })
        .catch(() => undefined);
    };
    this.activeSummary.set(ownerKey(owner), target?.entry.title ?? inputs[0].entry.title);
    try {
      if (target)
        await this.library.markGeneration(owner, target.entry.id, {
          ...target.entry.generation,
          state: 'running',
          lastAttemptAt: attemptedAt,
          progress: undefined,
          message: '正在提炼主题、结论和来源',
        });
      else
        await this.library.markSummaryProgress(
          owner,
          inputs[0].entry.id,
          inputs[0].contentHash,
          undefined,
          attemptedAt
        );
      if (this.stopped) {
        if (target)
          await this.library.markGeneration(owner, target.entry.id, {
            ...target.entry.generation,
            state: 'queued',
            message: '后台恢复后继续整理',
          });
        return;
      }
      const summary = await this.engine.summarizeContent(owner, {
        id: target?.entry.id ?? inputs[0].entry.id,
        sources: inputs.map((item) => ({
          id: item.entry.id,
          title: item.entry.title,
          kind: item.entry.kind,
          format:
            item.entry.kind === 'document'
              ? extname(item.entry.attachments?.at(-1)?.name ?? item.entry.title)
                  .slice(1)
                  .toLowerCase()
              : undefined,
          markdown: item.markdown,
          projection:
            !item.entry.humanEdited && item.entry.parseProjection?.contentHash === item.contentHash
              ? item.entry.parseProjection
              : undefined,
        })),
        forceSynthesis: Boolean(target),
        onProgress: recordProgress,
        content: inputs
          .map(
            (item) =>
              `# 来源 ${item.entry.id}：${item.entry.title}\n\n来源：[${item.entry.title}](/knowledge?entry=${item.entry.id})\n\n${item.markdown}`
          )
          .join('\n\n---\n\n'),
        instructions: target
          ? `整理为跨资料的专题知识，归并重复内容，分别保留事实、结论、适用条件和未决问题。用户指定主题：${organization(target.entry).topic}。`
          : undefined,
      });
      await progressWrites;
      for (const source of inputs) {
        const current = await this.library.get(owner, source.entry.id);
        if (!current || current.contentHash !== source.contentHash) {
          if (target)
            await this.library.markGeneration(owner, target.entry.id, {
              ...target.entry.generation,
              state: 'queued',
              message: '原始资料已更新，将按新版本重新整理',
            });
          return;
        }
      }
      if (target) {
        target = await this.library.get(owner, target.entry.id);
        if (!target || target.entry.humanEdited) return;
      }
      const first = inputs[0];
      if ('pending' in summary) {
        recordProgress({ ...summary.progress, phase: 'queued', requestStartedAt: undefined });
        await progressWrites;
        return;
      }
      if (!target && summary.archiveOnly) {
        await this.library.markSummarized(owner, first.entry.id, first.contentHash, {
          disposition: 'archive_only',
          reason: summary.reason || '原始记录已保留，未发现需要单独提炼的知识。',
        });
        return;
      }
      const title =
        target?.entry.generation?.requestedTitle ||
        summary.title?.trim() ||
        target?.entry.title ||
        first.entry.title;
      const topic =
        (target && organization(target.entry).topic !== '未分类'
          ? organization(target.entry).topic
          : summary.topic?.trim()) || '未分类';
      const references = inputs
        .map((item) => `- [${item.entry.title}](/knowledge?entry=${item.entry.id})`)
        .join('\n');
      const saved = await this.library.upsertSource(owner, {
        source: target?.entry.source ?? first.entry.source,
        sourceId: target?.entry.sourceId ?? `summary:${first.entry.id}`,
        kind: 'note',
        title,
        automated: true,
        expectedSources: inputs.map((item) => ({
          id: item.entry.id,
          contentHash: item.contentHash,
        })),
        sourceReferences: inputs.map((item) => ({
          id: item.entry.id,
          title: item.entry.title,
          contentHash: item.contentHash,
        })),
        summaryMode: summary.summaryMode ?? 'model',
        summaryFormatVersion: summary.summaryMode === 'structured_overview' ? 1 : undefined,
        derivedFrom: target
          ? undefined
          : { entryId: first.entry.id, contentHash: first.contentHash },
        organization: {
          topic,
          level: target ? 'knowledge' : 'summary',
          state: 'draft',
          summary: summary.abstract,
          tags: summary.tags,
          sourceEntryIds: inputs.map((item) => item.entry.id),
        },
        generation: { state: 'complete' },
        sourceUrl: `/knowledge?entry=${first.entry.id}`,
        sourceUpdatedAt: first.entry.updatedAt,
        markdown: `# ${title}\n\n> ${summary.summaryMode === 'structured_overview' ? '本地生成的资料概览，描述文件结构与可核实的统计；不代表逐条解读了所有记录。' : '根据所列原始资料整理。'}\n\n${summary.abstract}\n\n${summary.overview}\n\n## 来源\n\n${references}\n`,
        rawContent: `${JSON.stringify({ sources: inputs.map((item) => ({ id: item.entry.id, hash: item.contentHash })), generatedAt: new Date().toISOString(), ...summary })}\n`,
      });
      if (!saved) {
        if (target)
          await this.library.markGeneration(owner, target.entry.id, {
            ...target.entry.generation,
            state: 'queued',
            message: '来源已变化，将按当前资料重新整理',
            progress: undefined,
          });
        return;
      }
      if (!target) {
        await this.library.markSummarized(owner, first.entry.id, first.contentHash);
        await this.library.categorizeSource(owner, first.entry.id, first.contentHash, {
          topic,
          level: 'source',
          state: 'draft',
          summary: summary.abstract,
          tags: summary.tags,
        });
      }
      if (!target && summary.summaryMode === 'structured_overview') {
        this.lastSummaryAt = previousSummaryAt;
        return 'local';
      }
    } catch (error) {
      await progressWrites;
      if (this.stopped && error instanceof OpenVikingError && error.code === 'CANCELLED') {
        const progress = this.activeSummaryProgress.get(ownerKey(owner));
        if (progress) {
          recordProgress({ ...progress, phase: 'queued', requestStartedAt: undefined });
          await progressWrites;
        } else if (target) {
          await this.library.markGeneration(owner, target.entry.id, {
            ...target.entry.generation,
            state: 'queued',
            message: '后台恢复后继续整理',
          });
        }
        return;
      }
      const message =
        error instanceof OpenVikingError ? error.message : '摘要生成未完成，将自动重试';
      if (target) {
        const attempts = (target.entry.generation?.attempts ?? 0) + 1;
        await this.library.markGeneration(owner, target.entry.id, {
          ...target.entry.generation,
          state: 'failed',
          message,
          attempts,
          lastAttemptAt: attemptedAt,
          progress: this.activeSummaryProgress.has(ownerKey(owner))
            ? {
                ...this.activeSummaryProgress.get(ownerKey(owner))!,
                phase: 'queued',
                requestStartedAt: undefined,
              }
            : undefined,
          retryAt: retryDate(attempts, error instanceof OpenVikingError ? error.retryAfterMs : 0),
        });
      } else
        await this.library.markSummaryFailed(
          owner,
          inputs[0].entry.id,
          inputs[0].contentHash,
          message,
          error instanceof OpenVikingError ? error.retryAfterMs : 0
        );
    } finally {
      this.activeSummary.delete(ownerKey(owner));
      this.activeSummaryProgress.delete(ownerKey(owner));
    }
  }
}

function isStructuredSummaryCandidate(entry: KnowledgeEntry): boolean {
  return (
    entry.kind === 'document' &&
    (['.json', '.jsonl', '.ndjson', '.csv', '.tsv', '.html', '.htm'].includes(
      extname(entry.attachments?.at(-1)?.name ?? entry.title).toLowerCase()
    ) ||
      (!entry.humanEdited && entry.parseProjection?.kind === 'geospatial'))
  );
}

function summaryAgeWeek(entry: KnowledgeEntry): number {
  const timestamp = Date.parse(entry.sourceUpdatedAt ?? entry.createdAt);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.floor((Date.now() - timestamp) / 604800_000))
    : Number.MAX_SAFE_INTEGER;
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
