import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent, type ReadStream, type Stats } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import type {
  KnowledgeAttachment,
  KnowledgeEntry,
  KnowledgeEntryDetail,
  KnowledgeGeneration,
  KnowledgeLibraryStatus,
  KnowledgeListOptions,
  KnowledgeListResult,
  KnowledgeOrganization,
  KnowledgeOverview,
  KnowledgeOwner,
  KnowledgeParseStatus,
  KnowledgeSourceInput,
  KnowledgeSummaryProgress,
} from '@disco/core/types';
import { canSummarize, materialType, noteType, organization, retryDate } from './organization.js';
import { searchTerms } from './search.js';
import type { HostAttachmentReference } from './sources.js';

interface StoredEntry extends KnowledgeEntry {
  schemaVersion: 1;
  contentHash: string;
  sourceHash: string;
  rawHash?: string;
  indexError?: string;
  diskMtimeMs?: number;
  diskCtimeMs?: number;
  diskSize?: number;
}
interface Tombstone {
  id: string;
  relativePath: string;
  source: string;
  sourceId: string;
  deletedAt: string;
}
interface OwnerState {
  entries: StoredEntry[];
  tombstones: Tombstone[];
  lastReconciledAt?: string;
}

export interface KnowledgeExportFile {
  path: string;
  size: number;
  body: ReadStream;
}

export interface KnowledgeAttachmentInput {
  name: string;
  bytes?: Uint8Array;
  stream?: AsyncIterable<Uint8Array>;
  mimeType?: string;
  sourceUrl?: string;
}

export interface KnowledgeLibraryOptions {
  /** Trusted server-only resolver for an existing per-user executor filesystem boundary. */
  ownerRoot?: (owner: KnowledgeOwner) => string;
}

export class KnowledgeConflictError extends Error {
  constructor() {
    super('资料已被修改，请重新打开后再保存。');
    this.name = 'KnowledgeConflictError';
  }
}

const idPattern = /^kb_[a-f0-9]{64}$/;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const exists = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'EEXIST';
const nowAfter = (old?: string) =>
  new Date(Math.max(Date.now(), (Date.parse(old ?? '') || 0) + 1)).toISOString();
const markdownText = (value: string) => value.replace(/^\uFEFF/, '');
const markdownBytes = (value: string) => Buffer.from(`\uFEFF${markdownText(value)}`, 'utf8');
const publicEntry = (entry: StoredEntry): KnowledgeEntry => {
  const {
    schemaVersion: _schema,
    contentHash: _hash,
    sourceHash: _sourceHash,
    rawHash: _rawHash,
    indexError: _error,
    diskMtimeMs: _mtime,
    diskCtimeMs: _ctime,
    diskSize: _diskSize,
    ...result
  } = entry;
  return {
    ...result,
    materialType: materialType(result),
    organization: organization(result),
    indexMessage: result.indexMessage ?? _error,
  };
};

/**
 * Operator-managed local storage, scoped to a trusted tenant AND user on every call.
 * Markdown, JSONL and metadata are authoritative; there is no irreplaceable index.
 * No path supplied by a user or metadata may cross a symbolic link / junction.
 */
export class KnowledgeLibrary {
  readonly root: string;
  private static readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    root: string,
    private readonly options: KnowledgeLibraryOptions = {}
  ) {
    if (!isAbsolute(root)) throw new Error('知识库路径必须是绝对路径。');
    this.root = resolve(root);
  }

  ownerPath(owner: KnowledgeOwner): string {
    if (!owner.tenantId?.trim() || !owner.userId?.trim()) throw new Error('缺少知识库归属。');
    if (this.options.ownerRoot) {
      if (
        [owner.tenantId, owner.userId].some(
          (value) => /[\\/:\0]/.test(value) || value === '.' || value === '..'
        )
      )
        throw new Error('知识库归属编号无效。');
      const target = this.options.ownerRoot(owner);
      if (!isAbsolute(target)) throw new Error('知识库用户路径必须是绝对路径。');
      return resolve(target);
    }
    return join(this.root, 'tenants', digest(owner.tenantId), 'users', digest(owner.userId));
  }

  private entryId(owner: KnowledgeOwner, source: string, sourceId: string): string {
    return `kb_${digest(JSON.stringify([owner.tenantId, owner.userId, source, sourceId]))}`;
  }

  private safePath(base: string, file: string): string {
    if (
      !file ||
      file.includes('\\') ||
      file.includes(':') ||
      isAbsolute(file) ||
      file.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('知识库文件路径无效。');
    }
    const target = resolve(base, file);
    const rel = relative(base, target);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel))
      throw new Error('知识库文件超出允许范围。');
    return target;
  }

  /** Check every ancestor, including the configured root, rather than realpath alone. */
  private async assertSafe(target: string): Promise<void> {
    const absolute = resolve(target);
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error('知识库不允许符号链接或目录联接。');
      } catch (error) {
        if (absent(error)) return;
        throw error;
      }
    }
  }

  private async ensureDir(target: string): Promise<void> {
    await this.assertSafe(target);
    await mkdir(target, { recursive: true });
    await this.assertSafe(target);
  }

  private async read(base: string, file: string): Promise<Buffer | null> {
    const target = this.safePath(base, file);
    await this.assertSafe(target);
    let handle: FileHandle | undefined;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!(await handle.stat()).isFile()) throw new Error('知识库文件类型无效。');
      return await handle.readFile();
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async readStream(
    base: string,
    file: string
  ): Promise<{ body: ReadStream; size: number } | null> {
    const target = this.safePath(base, file);
    await this.assertSafe(target);
    let handle: FileHandle | undefined;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('知识库文件类型无效。');
      return { body: handle.createReadStream({ autoClose: true }), size: stat.size };
    } catch (error) {
      await handle?.close();
      if (absent(error)) return null;
      throw error;
    }
  }

  private async atomicWrite(
    base: string,
    file: string,
    content: string | Uint8Array,
    expectedMarkdownHash?: string | null
  ): Promise<void> {
    const target = this.safePath(base, file);
    await this.ensureDir(dirname(target));
    await this.assertSafe(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.assertSafe(target);
      if (expectedMarkdownHash !== undefined) {
        const current = await this.read(base, file);
        const currentHash = current ? digest(markdownText(current.toString('utf8'))) : null;
        if (currentHash !== expectedMarkdownHash) throw new KnowledgeConflictError();
      }
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!absent(error)) throw error;
      });
    }
  }

  private async removeFile(base: string, file: string): Promise<void> {
    const target = this.safePath(base, file);
    await this.assertSafe(target);
    await unlink(target).catch((error) => {
      if (!absent(error)) throw error;
    });
  }

  private async files(base: string, subdirectory: string): Promise<string[]> {
    const target = this.safePath(base, subdirectory);
    await this.assertSafe(target);
    let children: Dirent[];
    try {
      children = await readdir(target, { withFileTypes: true });
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
    const results: string[] = [];
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error('知识库不允许符号链接或目录联接。');
      const file = `${subdirectory}/${child.name}`;
      if (child.isDirectory()) results.push(...(await this.files(base, file)));
      else if (child.isFile()) results.push(file);
    }
    return results;
  }

  private async initialize(owner: KnowledgeOwner): Promise<string> {
    const base = this.ownerPath(owner);
    await this.ensureDir(join(base, '.library'));
    // Resolving both roots also catches differently cased or substituted mount paths.
    const root = await realpath(this.options.ownerRoot ? base : this.root);
    const actual = await realpath(base);
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error('知识库归属路径无效。');
    const identity = await this.read(base, '.library/owner.json');
    if (identity) {
      const stored = JSON.parse(identity.toString('utf8')) as KnowledgeOwner;
      if (stored.tenantId !== owner.tenantId || stored.userId !== owner.userId)
        throw new Error('知识库归属不匹配。');
    } else {
      await this.atomicWrite(
        base,
        '.library/owner.json',
        JSON.stringify({ schemaVersion: 1, ...owner }, null, 2)
      );
    }
    return base;
  }

  /** The file lock coordinates multiple library instances/processes; dead PID locks recover on restart. */
  private async lock(base: string): Promise<() => Promise<void>> {
    const path = this.safePath(base, '.library/write.lock');
    const nonce = randomUUID();
    const deadline = Date.now() + 30_000;
    while (true) {
      await this.assertSafe(path);
      try {
        const candidate = `.library/lock-${nonce}.tmp`;
        const candidatePath = this.safePath(base, candidate);
        const handle = await open(candidatePath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Publishing a complete inode avoids an unrecoverable empty lock after a process crash.
        try {
          await link(candidatePath, path);
        } finally {
          await this.removeFile(base, candidate);
        }
        return async () => {
          const lock = await this.read(base, '.library/write.lock');
          if (lock && (JSON.parse(lock.toString('utf8')) as { nonce: string }).nonce === nonce)
            await this.removeFile(base, '.library/write.lock');
        };
      } catch (error) {
        if (!exists(error)) throw error;
        const lock = await this.read(base, '.library/write.lock');
        if (lock?.length) {
          const { pid } = JSON.parse(lock.toString('utf8')) as { pid: number };
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('知识库锁文件无效。');
          try {
            process.kill(pid, 0);
          } catch (pidError) {
            if ((pidError as NodeJS.ErrnoException).code === 'ESRCH') {
              await this.removeFile(base, '.library/write.lock');
              continue;
            }
          }
        }
        if (Date.now() >= deadline) throw new Error('知识库正在处理其他操作，请稍后重试。');
        await new Promise((done) => setTimeout(done, 25));
      }
    }
  }

  private async exclusive<T>(
    owner: KnowledgeOwner,
    task: (base: string) => Promise<T>
  ): Promise<T> {
    const key = this.ownerPath(owner);
    const previous = KnowledgeLibrary.queues.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const base = await this.initialize(owner);
        const release = await this.lock(base);
        try {
          await this.recover(base);
          return await task(base);
        } finally {
          await release();
        }
      });
    KnowledgeLibrary.queues.set(key, operation);
    try {
      return await operation;
    } finally {
      if (KnowledgeLibrary.queues.get(key) === operation) KnowledgeLibrary.queues.delete(key);
    }
  }

  private validateEntry(entry: StoredEntry): StoredEntry {
    if (
      entry.schemaVersion !== 1 ||
      !idPattern.test(entry.id) ||
      !['disco', 'codex', 'manual'].includes(entry.source) ||
      !['conversation', 'document', 'note'].includes(entry.kind) ||
      typeof entry.sourceId !== 'string' ||
      typeof entry.contentHash !== 'string'
    )
      throw new Error('知识库元数据无效。');
    if (!/^(conversations|documents|notes)\/.+\.md$/i.test(entry.relativePath))
      throw new Error('知识库 Markdown 路径无效。');
    this.safePath(this.root, entry.relativePath);
    return entry;
  }

  private async metadata(base: string, id: string): Promise<StoredEntry | null> {
    if (!idPattern.test(id)) return null;
    const bytes = await this.read(base, `.library/entries/${id}.json`);
    if (!bytes) return null;
    const entry = this.validateEntry(JSON.parse(bytes.toString('utf8')) as StoredEntry);
    if (entry.id !== id) throw new Error('知识库编号不匹配。');
    return entry;
  }

  private async deletedEntries(base: string): Promise<Tombstone[]> {
    const tombstoneBytes = await this.read(base, '.library/tombstones.json');
    const tombstones = tombstoneBytes
      ? (JSON.parse(tombstoneBytes.toString('utf8')) as Tombstone[])
      : [];
    if (
      !Array.isArray(tombstones) ||
      tombstones.some(
        (item) =>
          !idPattern.test(item.id) ||
          !/^(conversations|documents|notes)\/.+\.md$/i.test(item.relativePath)
      )
    )
      throw new Error('知识库删除记录无效。');
    return tombstones;
  }

  private async state(base: string): Promise<OwnerState> {
    const tombstones = await this.deletedEntries(base);
    const deleted = new Set(tombstones.map((item) => item.id));
    const entries: StoredEntry[] = [];
    for (const file of await this.files(base, '.library/entries')) {
      if (!file.endsWith('.json')) continue;
      const value = await this.read(base, file);
      if (!value) continue;
      const entry = this.validateEntry(JSON.parse(value.toString('utf8')) as StoredEntry);
      if (!deleted.has(entry.id)) entries.push(entry);
    }
    const reconciliation = await this.read(base, '.library/reconciled.json');
    return {
      entries,
      tombstones,
      lastReconciledAt: reconciliation
        ? (JSON.parse(reconciliation.toString('utf8')) as { at: string }).at
        : undefined,
    };
  }

  private async save(base: string, entry: StoredEntry): Promise<void> {
    await this.atomicWrite(
      base,
      `.library/entries/${entry.id}.json`,
      JSON.stringify(entry, null, 2)
    );
  }

  /** A crash between Markdown replacement and metadata commit is completed without overwriting edits. */
  private async recover(base: string): Promise<void> {
    for (const file of await this.files(base, '.library/pending')) {
      if (!file.endsWith('.json')) continue;
      const bytes = await this.read(base, file);
      if (!bytes) continue;
      const entry = this.validateEntry(JSON.parse(bytes.toString('utf8')) as StoredEntry);
      const content = await this.read(base, entry.relativePath);
      if (content && digest(markdownText(content.toString('utf8'))) === entry.contentHash)
        await this.save(base, entry);
      await this.removeFile(base, file);
    }
  }

  private async writeMarkdown(
    base: string,
    entry: StoredEntry,
    markdown: string,
    expectedHash: string | null
  ): Promise<void> {
    await this.atomicWrite(
      base,
      `.library/pending/${entry.id}.json`,
      JSON.stringify(entry, null, 2)
    );
    try {
      await this.atomicWrite(base, entry.relativePath, markdownBytes(markdown), expectedHash);
    } catch (error) {
      await this.removeFile(base, `.library/pending/${entry.id}.json`);
      throw error;
    }
    await this.save(base, entry);
    await this.removeFile(base, `.library/pending/${entry.id}.json`);
  }

  private async archiveRevision(base: string, entry: StoredEntry, markdown: string): Promise<void> {
    const hash = digest(markdown);
    const path = `revisions/${entry.id}/${hash}.md`;
    if (!(await this.read(base, path))) await this.atomicWrite(base, path, markdownBytes(markdown));
  }

  private async tombstone(base: string, entry: StoredEntry): Promise<void> {
    const tombstones = await this.deletedEntries(base);
    if (!tombstones.some((item) => item.id === entry.id)) {
      tombstones.push({
        id: entry.id,
        relativePath: entry.relativePath,
        source: entry.source,
        sourceId: entry.sourceId,
        deletedAt: new Date().toISOString(),
      });
      // Persist suppression before deleting bytes so an interrupted deletion cannot resurrect content.
      await this.atomicWrite(base, '.library/tombstones.json', JSON.stringify(tombstones, null, 2));
    }
    await this.eraseEntryFiles(base, entry.id, entry.relativePath);
  }

  private async eraseEntryFiles(base: string, id: string, markdownPath: string): Promise<void> {
    for (const path of [
      markdownPath,
      `sources/${id}.md`,
      `sources/${id}.jsonl`,
      `.library/entries/${id}.json`,
      `.library/pending/${id}.json`,
      `.library/references/${id}.json`,
      `.library/rollouts/${id}.json`,
      ...(await this.files(base, `revisions/${id}`)),
      ...(await this.files(base, `assets/${id}`)),
    ])
      await this.removeFile(base, path);
  }

  private async refreshEntry(
    base: string,
    entry: StoredEntry
  ): Promise<KnowledgeEntryDetail | null> {
    const before = await this.markdownStat(base, entry);
    const bytes = await this.read(base, entry.relativePath);
    if (!bytes) {
      await this.tombstone(base, entry);
      return null;
    }
    const markdown = markdownText(bytes.toString('utf8'));
    const hash = digest(markdown);
    const after = await this.markdownStat(base, entry);
    const stampChanged = !this.sameStamp(entry, after);
    const changed = hash !== entry.contentHash;
    if (hash !== entry.contentHash) {
      if (!entry.humanEdited) {
        const original = await this.read(base, `sources/${entry.id}.md`);
        if (original)
          await this.archiveRevision(base, entry, markdownText(original.toString('utf8')));
      }
      entry.contentHash = hash;
      entry.humanEdited = true;
      entry.summaryDisposition = undefined;
      entry.summaryReason = undefined;
      entry.summaryProgress = undefined;
      entry.summaryAttemptedAt = undefined;
      entry.summaryMessage = undefined;
      entry.summaryRetryAt = undefined;
      entry.updatedAt = nowAfter(entry.updatedAt);
      entry.sizeBytes = Buffer.byteLength(markdown);
      entry.indexStatus = 'pending';
      entry.indexRetryAt = undefined;
      entry.indexMessage = undefined;
      entry.indexError = undefined;
      entry.indexAttempts = undefined;
      entry.organization = { ...organization(entry), summary: undefined, state: 'reviewed' };
      if (entry.generation) entry.generation = { state: 'complete', message: '已由用户接管编辑' };
      const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
      if (heading) entry.title = heading;
      await this.archiveRevision(base, entry, markdown);
    }
    if (
      before &&
      after &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      before.size === after.size
    ) {
      entry.diskMtimeMs = after.mtimeMs;
      entry.diskCtimeMs = after.ctimeMs;
      entry.diskSize = after.size;
    } else {
      // A direct editor changed the file while it was read; make the next scan retry it.
      delete entry.diskMtimeMs;
      delete entry.diskCtimeMs;
      delete entry.diskSize;
    }
    if (changed || stampChanged) await this.save(base, entry);
    return { entry: publicEntry(entry), markdown, contentHash: hash };
  }

  private async markdownStat(base: string, entry: StoredEntry): Promise<Stats | null> {
    const path = this.safePath(base, entry.relativePath);
    await this.assertSafe(path);
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) throw new Error('知识库 Markdown 文件类型无效。');
      return stat;
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  }

  private sameStamp(entry: StoredEntry, stat: Stats | null): boolean {
    return (
      stat !== null &&
      entry.diskMtimeMs === stat.mtimeMs &&
      entry.diskCtimeMs === stat.ctimeMs &&
      entry.diskSize === stat.size
    );
  }

  async upsertSource(
    owner: KnowledgeOwner,
    input: KnowledgeSourceInput
  ): Promise<KnowledgeEntryDetail | null> {
    if (
      !input.sourceId ||
      !['disco', 'codex', 'manual'].includes(input.source) ||
      !['conversation', 'document', 'note'].includes(input.kind)
    )
      throw new Error('知识库来源无效。');
    return this.exclusive(owner, async (base) => {
      const id = this.entryId(owner, input.source, input.sourceId);
      const deleted = new Set((await this.deletedEntries(base)).map((item) => item.id));
      if (deleted.has(id)) return null;
      for (const expected of input.expectedSources ?? []) {
        if (deleted.has(expected.id)) return null;
        const source = await this.metadata(base, expected.id);
        if (
          !source ||
          !(await this.refreshEntry(base, source)) ||
          source.contentHash !== expected.contentHash
        )
          return null;
      }
      let entry = await this.metadata(base, id);
      let current: KnowledgeEntryDetail | null = null;
      if (entry) {
        current = await this.refreshEntry(base, entry);
        if (!current) return null;
      }
      const markdown = markdownText(input.markdown);
      const contentHash = digest(markdown);
      const rawHash = input.rawContent === undefined ? entry?.rawHash : digest(input.rawContent);
      const derivedFrom =
        entry?.humanEdited && entry.derivedFrom
          ? entry.derivedFrom
          : (input.derivedFrom ?? entry?.derivedFrom);
      const sourceVersion = input.sourceVersion ?? entry?.sourceVersion;
      const grouping = entry?.humanEdited
        ? entry.organization
        : (input.organization ?? entry?.organization);
      const attachments = [...(entry?.attachments ?? [])];
      for (const candidate of input.attachments ?? []) {
        const previous = attachments.find(
          (item) =>
            (candidate.id && item.id === candidate.id) ||
            (candidate.sourceUrl && item.sourceUrl === candidate.sourceUrl) ||
            (item.name === candidate.name && item.sizeBytes === candidate.sizeBytes)
        );
        if (!previous) attachments.push(candidate);
      }
      if (
        entry &&
        entry.sourceHash === contentHash &&
        entry.rawHash === rawHash &&
        (entry.humanEdited || entry.title === input.title) &&
        entry.sourceUpdatedAt === input.sourceUpdatedAt &&
        entry.sourceUrl === input.sourceUrl &&
        JSON.stringify(entry.derivedFrom) === JSON.stringify(derivedFrom) &&
        JSON.stringify(entry.sourceVersion) === JSON.stringify(sourceVersion) &&
        (input.titleProjectionVersion === undefined ||
          entry.titleProjectionVersion === input.titleProjectionVersion) &&
        JSON.stringify(entry.organization) === JSON.stringify(grouping) &&
        JSON.stringify(entry.generation) === JSON.stringify(input.generation ?? entry.generation) &&
        JSON.stringify(attachments) === JSON.stringify(entry.attachments ?? [])
      )
        return current;
      const relativePath =
        entry?.relativePath ??
        `${input.kind === 'conversation' ? 'conversations' : input.kind === 'document' ? 'documents' : 'notes'}/${id}.md`;
      // An interrupted first import or a directly created file must not be overwritten blindly.
      const existing = entry ? null : await this.read(base, relativePath);
      const preserved =
        current?.markdown ?? (existing ? markdownText(existing.toString('utf8')) : null);
      const humanEdited =
        entry?.humanEdited ??
        ((input.source === 'manual' && input.kind === 'note' && !derivedFrom && !input.automated) ||
          existing !== null);
      const body = humanEdited && preserved !== null ? preserved : markdown;
      const now = nowAfter(entry?.updatedAt);
      entry = {
        schemaVersion: 1,
        id,
        title: entry?.humanEdited ? entry.title : input.title.trim() || '未命名资料',
        kind: input.kind,
        source: input.source,
        sourceId: input.sourceId,
        createdAt: entry?.createdAt ?? now,
        updatedAt: now,
        relativePath,
        humanEdited,
        sizeBytes: Buffer.byteLength(body),
        contentHash: digest(body),
        sourceHash: contentHash,
        rawHash,
        indexStatus: entry?.contentHash === digest(body) ? entry.indexStatus : 'pending',
        sourceUpdatedAt: input.sourceUpdatedAt,
        sourceUrl: input.sourceUrl,
        attachments: attachments.length ? attachments : undefined,
        derivedFrom,
        summaryContentHash: entry?.summaryContentHash,
        summaryMode: input.summaryMode ?? entry?.summaryMode,
        sourceVersion,
        titleProjectionVersion: input.titleProjectionVersion ?? entry?.titleProjectionVersion,
        parseStatus: entry?.parseStatus,
        parseMessage: entry?.parseMessage,
        parseAttempts: entry?.parseAttempts,
        parseRetryAt: entry?.parseRetryAt,
        organization: grouping,
        generation: entry?.humanEdited ? entry.generation : (input.generation ?? entry?.generation),
        indexMessage: entry?.contentHash === digest(body) ? entry.indexMessage : undefined,
        indexAttempts: entry?.contentHash === digest(body) ? entry.indexAttempts : undefined,
        indexRetryAt: entry?.contentHash === digest(body) ? entry.indexRetryAt : undefined,
        summaryMessage: entry?.contentHash === digest(body) ? entry?.summaryMessage : undefined,
        summaryAttempts: entry?.contentHash === digest(body) ? entry?.summaryAttempts : undefined,
        summaryRetryAt: entry?.contentHash === digest(body) ? entry?.summaryRetryAt : undefined,
        summaryProgress: entry?.contentHash === digest(body) ? entry?.summaryProgress : undefined,
        summaryAttemptedAt:
          entry?.contentHash === digest(body) ? entry?.summaryAttemptedAt : undefined,
        summaryDisposition:
          entry?.contentHash === digest(body) ? entry?.summaryDisposition : undefined,
        summaryReason: entry?.contentHash === digest(body) ? entry?.summaryReason : undefined,
        historical: entry?.historical,
      };
      if (input.rawContent !== undefined)
        await this.atomicWrite(base, `sources/${id}.jsonl`, input.rawContent);
      // Preserve the newest source separately even when its readable rendition was manually edited.
      await this.atomicWrite(base, `sources/${id}.md`, markdownBytes(markdown));
      if (current && current.markdown !== body)
        await this.archiveRevision(base, entry, current.markdown);
      if (humanEdited && preserved !== null) await this.save(base, entry);
      else await this.writeMarkdown(base, entry, body, current?.contentHash ?? null);
      return { entry: publicEntry(entry), markdown: body, contentHash: entry.contentHash };
    });
  }

  async get(owner: KnowledgeOwner, id: string): Promise<KnowledgeEntryDetail | null> {
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return null;
      const entry = await this.metadata(base, id);
      const detail = entry ? await this.refreshEntry(base, entry) : null;
      if (!detail) return null;
      const ids = organization(detail.entry).sourceEntryIds ?? [];
      detail.sources = [];
      const deleted = new Set((await this.deletedEntries(base)).map((item) => item.id));
      for (const sourceId of ids) {
        const source = deleted.has(sourceId) ? null : await this.metadata(base, sourceId);
        detail.sources.push({
          id: sourceId,
          title: source?.title ?? '原始资料已删除',
          kind: source?.kind,
          available: Boolean(source),
        });
      }
      return detail;
    });
  }

  async edit(
    owner: KnowledgeOwner,
    id: string,
    markdown: string,
    expectedUpdatedAt?: string,
    title?: string,
    grouping?: KnowledgeOrganization
  ): Promise<KnowledgeEntryDetail | null> {
    if (title !== undefined && !title.trim()) throw new Error('资料标题不能为空。');
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return null;
      const entry = await this.metadata(base, id);
      if (!entry) return null;
      const current = await this.refreshEntry(base, entry);
      if (!current) return null;
      if (expectedUpdatedAt && entry.updatedAt !== expectedUpdatedAt)
        throw new KnowledgeConflictError();
      const body = markdownText(markdown);
      await this.archiveRevision(base, entry, current.markdown);
      entry.contentHash = digest(body);
      entry.updatedAt = nowAfter(entry.updatedAt);
      entry.sizeBytes = Buffer.byteLength(body);
      entry.humanEdited = true;
      entry.summaryDisposition = undefined;
      entry.summaryReason = undefined;
      entry.summaryProgress = undefined;
      entry.summaryAttemptedAt = undefined;
      entry.summaryMessage = undefined;
      entry.summaryRetryAt = undefined;
      if (title !== undefined) entry.title = title.trim();
      entry.organization = grouping ?? { ...organization(entry), state: 'reviewed' };
      if (body !== current.markdown) entry.organization.summary = undefined;
      if (entry.generation) entry.generation = { state: 'complete', message: '已由用户接管编辑' };
      entry.indexStatus = 'pending';
      entry.indexRetryAt = undefined;
      entry.indexAttempts = undefined;
      entry.indexMessage = undefined;
      entry.indexError = undefined;
      await this.writeMarkdown(base, entry, body, current.contentHash);
      await this.archiveRevision(base, entry, body);
      return { entry: publicEntry(entry), markdown: body, contentHash: entry.contentHash };
    });
  }

  async remove(owner: KnowledgeOwner, id: string): Promise<boolean> {
    return this.exclusive(owner, async (base) => {
      const entry = await this.metadata(base, id);
      if (!entry) return false;
      await this.tombstone(base, entry);
      return true;
    });
  }

  async list(
    owner: KnowledgeOwner,
    options: KnowledgeListOptions = {}
  ): Promise<KnowledgeListResult> {
    return this.exclusive(owner, async (base) =>
      this.listFromState(base, await this.state(base), options)
    );
  }

  private async listFromState(
    base: string,
    state: OwnerState,
    options: KnowledgeListOptions
  ): Promise<KnowledgeListResult> {
    const query = options.query?.trim().toLocaleLowerCase();
    const terms = query ? searchTerms(query) : [];
    const relevance = new Map<string, number>();
    const results: KnowledgeEntry[] = [];
    for (const entry of state.entries) {
      if (entry.historical && !options.includeHistory) continue;
      if (
        (options.kind && entry.kind !== options.kind) ||
        (options.noteType && noteType(entry) !== options.noteType) ||
        (options.source && entry.source !== options.source) ||
        (options.materialType && materialType(entry) !== options.materialType) ||
        (options.level && organization(entry).level !== options.level) ||
        (options.topic && organization(entry).topic !== options.topic) ||
        (options.reviewState && organization(entry).state !== options.reviewState)
      )
        continue;
      // Lists load only metadata. Full Markdown is read for explicit search/open or background reconciliation.
      let result = publicEntry(entry);
      if (query) {
        const detail = await this.refreshEntry(base, entry);
        if (!detail) continue;
        result = detail.entry;
        const body = detail.markdown.toLocaleLowerCase();
        const metadata =
          `${entry.title} ${organization(entry).topic} ${organization(entry).summary ?? ''} ${(organization(entry).tags ?? []).join(' ')}`.toLocaleLowerCase();
        const match = body.indexOf(query);
        const positions = terms.map((term) => body.indexOf(term));
        const bodyMatches = positions.filter((position) => position >= 0).length;
        const metadataMatches = terms.filter((term) => metadata.includes(term)).length;
        if (match < 0 && !metadata.includes(query) && !bodyMatches && !metadataMatches) continue;
        relevance.set(
          entry.id,
          (metadata.includes(query) ? 20 : 0) +
            (match >= 0 ? 10 : 0) +
            metadataMatches * 2 +
            bodyMatches
        );
        const firstMatch =
          match >= 0
            ? match
            : (positions.filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? 0);
        result.snippet = detail.markdown.slice(
          Math.max(0, firstMatch - 60),
          Math.max(0, firstMatch - 60) + 280
        );
      }
      results.push(result);
    }
    results.sort(
      (a, b) =>
        (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0) ||
        (options.sort === 'curated'
          ? Number(b.humanEdited) - Number(a.humanEdited) ||
            Number(noteType(b) === 'knowledge') - Number(noteType(a) === 'knowledge')
          : 0) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id)
    );
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : 0;
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit!)) : 50;
    return { entries: results.slice(offset, offset + limit), total: results.length };
  }

  /** One consistent directory read for the browser's list, facets and progress. */
  async catalog(owner: KnowledgeOwner, options: KnowledgeListOptions = {}) {
    return this.exclusive(owner, async (base) => {
      const state = await this.state(base);
      return {
        ...(await this.listFromState(base, state, options)),
        status: this.summarize(state),
        overview: this.overviewFromEntries(state.entries),
      };
    });
  }

  private summarize(state: OwnerState): KnowledgeLibraryStatus {
    state = { ...state, entries: state.entries.filter((entry) => !entry.historical) };
    return {
      total: state.entries.length,
      conversations: state.entries.filter((entry) => entry.kind === 'conversation').length,
      documents: state.entries.filter((entry) => entry.kind === 'document').length,
      notes: state.entries.filter((entry) => entry.kind === 'note').length,
      humanEdited: state.entries.filter((entry) => entry.humanEdited).length,
      pendingIndex: state.entries.filter((entry) => entry.indexStatus !== 'indexed').length,
      processing: {
        index: {
          pending: state.entries.filter((entry) => entry.indexStatus === 'pending').length,
          indexed: state.entries.filter((entry) => entry.indexStatus === 'indexed').length,
          failed: state.entries.filter((entry) => entry.indexStatus === 'error').length,
          unsupported: state.entries.filter((entry) => entry.parseStatus === 'unsupported').length,
        },
        summary: {
          archivedOnly: state.entries.filter(
            (entry) =>
              entry.summaryDisposition === 'archive_only' &&
              entry.summaryContentHash === entry.contentHash
          ).length,
          pending: state.entries.filter(
            (entry) =>
              (canSummarize(entry) &&
                entry.summaryContentHash !== entry.contentHash &&
                !entry.summaryMessage) ||
              (entry.generation && ['queued', 'running'].includes(entry.generation.state))
          ).length,
          completed: state.entries.filter(
            (entry) =>
              (canSummarize(entry) && entry.summaryContentHash === entry.contentHash) ||
              (!entry.derivedFrom && entry.generation?.state === 'complete')
          ).length,
          failed: state.entries.filter(
            (entry) => entry.summaryMessage || entry.generation?.state === 'failed'
          ).length,
        },
      },
      deleted: state.tombstones.length,
      totalBytes: state.entries.reduce(
        (total, entry) =>
          total +
          entry.sizeBytes +
          (entry.attachments ?? []).reduce(
            (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
            0
          ),
        0
      ),
      lastReconciledAt: state.lastReconciledAt,
    };
  }

  async status(owner: KnowledgeOwner): Promise<KnowledgeLibraryStatus> {
    return this.exclusive(owner, async (base) => this.summarize(await this.state(base)));
  }

  /** Server-internal metadata snapshot, avoiding repeated paginated full scans during ingestion. */
  async snapshot(owner: KnowledgeOwner): Promise<KnowledgeEntry[]> {
    return this.exclusive(owner, async (base) => (await this.state(base)).entries.map(publicEntry));
  }

  async overview(owner: KnowledgeOwner): Promise<KnowledgeOverview> {
    return this.overviewFromEntries(await this.snapshot(owner));
  }

  private overviewFromEntries(entries: KnowledgeEntry[]): KnowledgeOverview {
    const result: KnowledgeOverview = {
      topics: [],
      counts: { source: 0, summary: 0, knowledge: 0 },
      materials: { conversation: 0, document: 0, image: 0, file: 0, note: 0 },
    };
    const topics = new Map<string, number>();
    const noteTopics = new Map<string, number>();
    for (const entry of entries) {
      if (entry.historical) continue;
      const group = organization(entry);
      result.counts[group.level]++;
      result.materials[materialType(entry)]++;
      topics.set(group.topic, (topics.get(group.topic) ?? 0) + 1);
      if (entry.kind === 'note')
        noteTopics.set(group.topic, (noteTopics.get(group.topic) ?? 0) + 1);
    }
    result.topics = [...topics]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
    result.noteTopics = [...noteTopics]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
    return result;
  }

  async markGeneration(
    owner: KnowledgeOwner,
    id: string,
    generation: KnowledgeGeneration
  ): Promise<boolean> {
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return false;
      const entry = await this.metadata(base, id);
      if (!entry || !(await this.refreshEntry(base, entry)) || entry.humanEdited) return false;
      entry.generation = generation;
      await this.save(base, entry);
      return true;
    });
  }

  async repairImportedTitle(
    owner: KnowledgeOwner,
    id: string,
    expectedHash: string,
    previousTitle: string,
    title?: string
  ): Promise<boolean> {
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return false;
      const entry = await this.metadata(base, id);
      if (
        !entry ||
        !(await this.refreshEntry(base, entry)) ||
        entry.humanEdited ||
        entry.historical ||
        entry.source !== 'codex' ||
        entry.kind !== 'conversation' ||
        entry.contentHash !== expectedHash ||
        entry.title !== previousTitle ||
        (entry.titleProjectionVersion ?? 0) >= 1
      )
        return false;
      if (title?.trim()) entry.title = title.trim().slice(0, 100);
      entry.titleProjectionVersion = 1;
      await this.save(base, entry);
      return true;
    });
  }

  /** Preserve pre-migration raw history using a same-volume link, without loading it into memory. */
  async preserveRawRevision(owner: KnowledgeOwner, id: string): Promise<void> {
    await this.exclusive(owner, async (base) => {
      const entry = await this.metadata(base, id);
      if (!entry?.rawHash) return;
      const source = this.safePath(base, `sources/${id}.jsonl`);
      const target = this.safePath(base, `revisions/${id}/${entry.rawHash}.jsonl`);
      await this.assertSafe(source);
      await this.ensureDir(dirname(target));
      await this.assertSafe(target);
      try {
        await link(source, target);
      } catch (error) {
        if (!exists(error) && !absent(error)) throw error;
      }
      const current = await this.refreshEntry(base, entry);
      if (current) await this.archiveRevision(base, entry, current.markdown);
    });
  }

  async hasRawSource(owner: KnowledgeOwner, id: string, sha256: string): Promise<boolean> {
    return this.exclusive(owner, async (base) => {
      const entry = await this.metadata(base, id);
      if (!entry || entry.rawHash !== sha256) return false;
      const path = this.safePath(base, `sources/${id}.jsonl`);
      await this.assertSafe(path);
      const info = await lstat(path).catch(() => null);
      return Boolean(
        info?.isFile() && (!entry.sourceVersion || info.size === entry.sourceVersion.byteLength)
      );
    });
  }

  async hostReferences(
    owner: KnowledgeOwner,
    id: string,
    references?: HostAttachmentReference[]
  ): Promise<HostAttachmentReference[] | null> {
    return this.exclusive(owner, async (base) => {
      if (!idPattern.test(id) || !(await this.metadata(base, id))) return null;
      const file = `.library/references/${id}.json`;
      if (references) await this.atomicWrite(base, file, JSON.stringify(references));
      const bytes = await this.read(base, file);
      if (!bytes) return null;
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(value) || value.some((ref) => !ref || typeof ref.reference !== 'string'))
        return null;
      return value as HostAttachmentReference[];
    });
  }

  /** Preserve the original rollout once when migrating to the SQLite projection. */
  async preserveExternalRawRevision(
    owner: KnowledgeOwner,
    id: string,
    stream: AsyncIterable<Uint8Array>
  ): Promise<void> {
    await this.exclusive(owner, async (base) => {
      if (!idPattern.test(id) || !(await this.metadata(base, id))) return;
      if (await this.read(base, `.library/rollouts/${id}.json`)) return;
      const temporary = `revisions/${id}/${randomUUID()}.partial`;
      await this.ensureDir(dirname(this.safePath(base, temporary)));
      const handle = await open(this.safePath(base, temporary), 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      try {
        for await (const chunk of stream) {
          hash.update(chunk);
          size += chunk.length;
          await handle.writeFile(chunk);
        }
        const sha256 = hash.digest('hex');
        await handle.sync();
        await handle.close();
        const target = `revisions/${id}/${sha256}.jsonl`;
        await this.assertSafe(this.safePath(base, target));
        if (
          await this.readStream(base, target).then((file) => {
            file?.body.destroy();
            return Boolean(file);
          })
        )
          await this.removeFile(base, temporary);
        else await rename(this.safePath(base, temporary), this.safePath(base, target));
        await this.atomicWrite(
          base,
          `.library/rollouts/${id}.json`,
          JSON.stringify({ sha256, size })
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        await this.removeFile(base, temporary);
        throw error;
      }
    });
  }

  async markHistorical(owner: KnowledgeOwner, id: string): Promise<void> {
    await this.exclusive(owner, async (base) => {
      const entry = await this.metadata(base, id);
      if (!entry || !(await this.refreshEntry(base, entry)) || entry.humanEdited) return;
      entry.historical = true;
      await this.save(base, entry);
    });
  }

  /** Raw archives can exceed V8's string limit. Stream, verify, then atomically publish. */
  async putRawSource(
    owner: KnowledgeOwner,
    id: string,
    input: { stream: AsyncIterable<Uint8Array>; sha256: string }
  ): Promise<void> {
    await this.exclusive(owner, async (base) => {
      const entry = await this.metadata(base, id);
      if (!entry || !(await this.refreshEntry(base, entry))) return;
      const temporary = `sources/${id}.${randomUUID()}.partial`;
      const target = `sources/${id}.jsonl`;
      await this.ensureDir(dirname(this.safePath(base, target)));
      const handle = await open(this.safePath(base, temporary), 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        for await (const chunk of input.stream) {
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        if (hash.digest('hex') !== input.sha256) throw new Error('原始归档校验失败');
        await handle.sync();
        await handle.close();
        await this.assertSafe(this.safePath(base, target));
        await rename(this.safePath(base, temporary), this.safePath(base, target));
        entry.rawHash = input.sha256;
        await this.save(base, entry);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await this.removeFile(base, temporary);
        throw error;
      }
    });
  }

  async markSummaryFailed(
    owner: KnowledgeOwner,
    id: string,
    hash: string,
    message: string,
    minimumRetryMs = 0
  ): Promise<void> {
    await this.exclusive(owner, async (base) => {
      const entry = await this.metadata(base, id);
      if (!entry || !(await this.refreshEntry(base, entry)) || entry.contentHash !== hash) return;
      entry.summaryMessage = message;
      if (entry.summaryProgress)
        entry.summaryProgress = {
          ...entry.summaryProgress,
          phase: 'queued',
          requestStartedAt: undefined,
        };
      entry.summaryAttempts = (entry.summaryAttempts ?? 0) + 1;
      entry.summaryRetryAt = retryDate(entry.summaryAttempts, minimumRetryMs);
      await this.save(base, entry);
    });
  }

  async markSummaryProgress(
    owner: KnowledgeOwner,
    id: string,
    hash: string,
    progress: KnowledgeSummaryProgress | undefined,
    attemptedAt: string
  ): Promise<boolean> {
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return false;
      const entry = await this.metadata(base, id);
      if (!entry || !(await this.refreshEntry(base, entry)) || entry.contentHash !== hash)
        return false;
      entry.summaryProgress = progress;
      entry.summaryAttemptedAt = attemptedAt;
      entry.summaryMessage = undefined;
      entry.summaryRetryAt = undefined;
      await this.save(base, entry);
      return true;
    });
  }

  async recoverSummaryProgress(owner: KnowledgeOwner): Promise<void> {
    await this.exclusive(owner, async (base) => {
      for (const entry of (await this.state(base)).entries) {
        let changed = false;
        if (entry.summaryProgress && entry.summaryProgress.phase !== 'queued') {
          entry.summaryProgress = {
            ...entry.summaryProgress,
            phase: 'queued',
            requestStartedAt: undefined,
          };
          changed = true;
        }
        if (entry.generation?.state === 'running' && !entry.humanEdited) {
          entry.generation = {
            ...entry.generation,
            state: 'queued',
            message: '后台已恢复，将继续整理',
            progress: entry.generation.progress
              ? { ...entry.generation.progress, phase: 'queued', requestStartedAt: undefined }
              : undefined,
          };
          changed = true;
        }
        if (changed) await this.save(base, entry);
      }
    });
  }

  async categorizeSource(
    owner: KnowledgeOwner,
    id: string,
    hash: string,
    grouping: KnowledgeOrganization
  ): Promise<void> {
    await this.exclusive(owner, async (base) => {
      const entry = await this.metadata(base, id);
      if (
        !entry ||
        !(await this.refreshEntry(base, entry)) ||
        entry.humanEdited ||
        entry.contentHash !== hash
      )
        return;
      entry.organization = {
        ...grouping,
        level: 'source',
        state: 'draft',
        sourceEntryIds: undefined,
      };
      await this.save(base, entry);
    });
  }

  async listDeletedIds(owner: KnowledgeOwner): Promise<string[]> {
    return this.exclusive(owner, async (base) =>
      (await this.deletedEntries(base)).map((entry) => entry.id)
    );
  }

  async markSummarized(
    owner: KnowledgeOwner,
    id: string,
    contentHash: string,
    result?: { disposition: 'summarized' | 'archive_only'; reason?: string }
  ): Promise<boolean> {
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return false;
      const entry = await this.metadata(base, id);
      if (!entry || !(await this.refreshEntry(base, entry)) || entry.contentHash !== contentHash)
        return false;
      entry.summaryContentHash = contentHash;
      entry.summaryDisposition = result?.disposition ?? 'summarized';
      entry.summaryReason = result?.reason;
      entry.summaryMessage = undefined;
      entry.summaryRetryAt = undefined;
      entry.summaryAttempts = undefined;
      entry.summaryProgress = undefined;
      entry.summaryAttemptedAt = undefined;
      await this.save(base, entry);
      return true;
    });
  }

  async reconcile(owner: KnowledgeOwner): Promise<KnowledgeLibraryStatus> {
    const snapshot = await this.exclusive(owner, async (base) => this.state(base));
    // Yield the owner lock between small batches so historical scans cannot monopolize interactive edits.
    for (let offset = 0; offset < snapshot.tombstones.length; offset += 10) {
      await this.exclusive(owner, async (base) => {
        for (const tombstone of snapshot.tombstones.slice(offset, offset + 10))
          await this.eraseEntryFiles(base, tombstone.id, tombstone.relativePath);
      });
    }
    for (let offset = 0; offset < snapshot.entries.length; offset += 10) {
      await this.exclusive(owner, async (base) => {
        for (const item of snapshot.entries.slice(offset, offset + 10)) {
          const entry = await this.metadata(base, item.id);
          if (!entry) continue;
          const stat = await this.markdownStat(base, entry);
          if (!stat) await this.tombstone(base, entry);
          else if (!this.sameStamp(entry, stat)) await this.refreshEntry(base, entry);
        }
      });
    }
    const unknown = await this.exclusive(owner, async (base) => {
      const state = await this.state(base);
      const known = new Set(
        [...state.entries, ...state.tombstones].map((entry) => entry.relativePath)
      );
      const paths: string[] = [];
      for (const directory of ['notes', 'documents', 'conversations'])
        paths.push(...(await this.files(base, directory)));
      return paths.filter((path) => path.toLowerCase().endsWith('.md') && !known.has(path));
    });
    for (let offset = 0; offset < unknown.length; offset += 10) {
      await this.exclusive(owner, async (base) => {
        const tombstones = await this.deletedEntries(base);
        for (const path of unknown.slice(offset, offset + 10)) {
          if (tombstones.some((item) => item.relativePath === path)) continue;
          const sourceId = `file:${path}`;
          const id = this.entryId(owner, 'manual', sourceId);
          if (tombstones.some((item) => item.id === id) || (await this.metadata(base, id)))
            continue;
          // A source import may have registered its generated filename after the scan snapshot.
          const generatedId = path.split('/').at(-1)!.replace(/\.md$/i, '');
          if (idPattern.test(generatedId) && (await this.metadata(base, generatedId))) continue;
          const bytes = await this.read(base, path);
          if (!bytes) continue;
          const markdown = markdownText(bytes.toString('utf8'));
          const timestamp = new Date().toISOString();
          const entry: StoredEntry = {
            schemaVersion: 1,
            id,
            title:
              /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ??
              path.split('/').at(-1)!.replace(/\.md$/i, ''),
            kind: path.startsWith('documents/')
              ? 'document'
              : path.startsWith('conversations/')
                ? 'conversation'
                : 'note',
            source: 'manual',
            sourceId,
            createdAt: timestamp,
            updatedAt: timestamp,
            humanEdited: true,
            relativePath: path,
            sizeBytes: Buffer.byteLength(markdown),
            contentHash: digest(markdown),
            sourceHash: digest(markdown),
            indexStatus: 'pending',
          };
          await this.save(base, entry);
          await this.archiveRevision(base, entry, markdown);
          await this.refreshEntry(base, entry);
        }
      });
    }
    return this.exclusive(owner, async (base) => {
      await this.atomicWrite(
        base,
        '.library/reconciled.json',
        JSON.stringify({ at: new Date().toISOString() })
      );
      return this.summarize(await this.state(base));
    });
  }

  async markIndexed(
    owner: KnowledgeOwner,
    id: string,
    contentHash?: string,
    error?: string
  ): Promise<boolean> {
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return false;
      const entry = await this.metadata(base, id);
      if (
        !entry ||
        !(await this.refreshEntry(base, entry)) ||
        (contentHash && entry.contentHash !== contentHash)
      )
        return false;
      entry.indexStatus = error ? 'error' : 'indexed';
      entry.indexError = error;
      entry.indexMessage = error;
      entry.indexAttempts = error ? (entry.indexAttempts ?? 0) + 1 : undefined;
      entry.indexRetryAt = error ? retryDate(entry.indexAttempts!) : undefined;
      await this.save(base, entry);
      return true;
    });
  }

  /** Persist extraction progress without changing a human-authored document or its edit version. */
  async markParsed(
    owner: KnowledgeOwner,
    id: string,
    status: KnowledgeParseStatus,
    message?: string
  ): Promise<boolean> {
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return false;
      const entry = await this.metadata(base, id);
      if (entry?.kind !== 'document' || !(await this.refreshEntry(base, entry))) return false;
      entry.parseStatus = status;
      entry.parseMessage = message;
      entry.parseAttempts = status === 'error' ? (entry.parseAttempts ?? 0) + 1 : undefined;
      entry.parseRetryAt =
        status === 'error' ? retryDate(entry.parseAttempts!, 5 * 60_000) : undefined;
      await this.save(base, entry);
      return true;
    });
  }

  async putAttachment(
    owner: KnowledgeOwner,
    id: string,
    input: KnowledgeAttachmentInput
  ): Promise<KnowledgeAttachment | null> {
    if ((input.bytes === undefined) === (input.stream === undefined))
      throw new Error('附件必须提供一种内容来源。');
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return null;
      const entry = await this.metadata(base, id);
      if (!entry || !(await this.refreshEntry(base, entry))) return null;
      const temporary = `assets/${id}/${randomUUID()}.partial`;
      const temporaryPath = this.safePath(base, temporary);
      await this.ensureDir(dirname(temporaryPath));
      const handle = await open(temporaryPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let sizeBytes = 0;
      try {
        const chunks = input.stream ?? [input.bytes!];
        for await (const chunk of chunks) {
          if (!(chunk instanceof Uint8Array)) throw new Error('附件内容必须是二进制数据。');
          hash.update(chunk);
          sizeBytes += chunk.byteLength;
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } catch (error) {
        await handle.close();
        await this.removeFile(base, temporary);
        throw error;
      }
      await handle.close();
      const attachmentId = hash.digest('hex');
      const extension = extname(input.name);
      const safeExtension = /^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : '';
      const previous = entry.attachments?.find((item) => item.id === attachmentId);
      const path =
        previous?.relativePath && this.validAttachmentPath(id, attachmentId, previous.relativePath)
          ? previous.relativePath
          : `assets/${id}/${attachmentId}${safeExtension}`;
      try {
        const target = this.safePath(base, path);
        await this.assertSafe(target);
        const stat = await lstat(target).catch((error) => {
          if (absent(error)) return null;
          throw error;
        });
        if (stat?.isFile() && stat.size === sizeBytes) await this.removeFile(base, temporary);
        else await rename(temporaryPath, target);
      } finally {
        await this.removeFile(base, temporary);
      }
      const attachment: KnowledgeAttachment = {
        id: attachmentId,
        name: input.name,
        relativePath: path,
        sizeBytes,
        mimeType: input.mimeType,
        sourceUrl: input.sourceUrl,
      };
      entry.attachments = [
        ...(entry.attachments ?? []).filter(
          (item) =>
            item.id !== attachmentId &&
            (item.id || !input.sourceUrl || item.sourceUrl !== input.sourceUrl)
        ),
        attachment,
      ];
      if (!previous && entry.kind === 'document') {
        entry.parseStatus = 'pending';
        entry.parseMessage = undefined;
        entry.parseAttempts = undefined;
        entry.parseRetryAt = undefined;
      }
      entry.updatedAt = nowAfter(entry.updatedAt);
      await this.save(base, entry);
      return attachment;
    });
  }

  async getAttachment(
    owner: KnowledgeOwner,
    id: string,
    attachmentId: string
  ): Promise<{ attachment: KnowledgeAttachment; bytes: Uint8Array } | null> {
    const opened = await this.openAttachment(owner, id, attachmentId);
    if (!opened) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
    return { attachment: opened.attachment, bytes: Buffer.concat(chunks) };
  }

  private validAttachmentPath(id: string, attachmentId: string, path: string): boolean {
    return new RegExp(`^assets/${id}/${attachmentId}(?:\\.[a-zA-Z0-9]{1,16})?$`).test(path);
  }

  async openMarkdown(
    owner: KnowledgeOwner,
    id: string
  ): Promise<{ title: string; body: ReadStream; size: number } | null> {
    return this.exclusive(owner, async (base) => {
      if ((await this.deletedEntries(base)).some((item) => item.id === id)) return null;
      const entry = await this.metadata(base, id);
      if (!entry) return null;
      const result = await this.readStream(base, entry.relativePath);
      return result ? { title: entry.title, ...result } : null;
    });
  }

  async openAttachment(
    owner: KnowledgeOwner,
    id: string,
    attachmentId: string
  ): Promise<{ attachment: KnowledgeAttachment; body: ReadStream; size: number } | null> {
    return this.exclusive(owner, async (base) => {
      if (
        !/^[a-f0-9]{64}$/.test(attachmentId) ||
        (await this.deletedEntries(base)).some((item) => item.id === id)
      )
        return null;
      const entry = await this.metadata(base, id);
      if (!entry) return null;
      const attachment = entry.attachments?.find((item) => item.id === attachmentId);
      if (
        !attachment?.relativePath ||
        !this.validAttachmentPath(id, attachmentId, attachment.relativePath)
      )
        return null;
      const result = await this.readStream(base, attachment.relativePath);
      return result ? { attachment, ...result } : null;
    });
  }

  /** Holds the owner write lock while the consumer reads; cancelling iteration releases it. */
  async *exportFiles(
    owner: KnowledgeOwner,
    signal?: AbortSignal
  ): AsyncGenerator<KnowledgeExportFile> {
    const key = this.ownerPath(owner);
    const previous = KnowledgeLibrary.queues.get(key) ?? Promise.resolve();
    let unlockQueue!: () => void;
    const gate = new Promise<void>((done) => {
      unlockQueue = done;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    KnowledgeLibrary.queues.set(key, queued);
    await previous.catch(() => undefined);
    let release: (() => Promise<void>) | undefined;
    let activeStream: ReadStream | undefined;
    const abort = () => activeStream?.destroy(new Error('知识库导出已取消。'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const base = await this.initialize(owner);
      release = await this.lock(base);
      await this.recover(base);
      for (const directory of [
        '.library',
        'notes',
        'documents',
        'conversations',
        'sources',
        'revisions',
        'assets',
      ]) {
        for (const path of await this.files(base, directory)) {
          signal?.throwIfAborted();
          if (
            path === '.library/write.lock' ||
            path.startsWith('.library/pending/') ||
            path.endsWith('.tmp') ||
            path.endsWith('.partial')
          )
            continue;
          const stream = await this.readStream(base, path);
          if (!stream) continue;
          activeStream = stream.body;
          const consumed = finished(activeStream);
          // The HTTP consumer can abort before requesting the iterator's next item.
          void consumed.catch(() => undefined);
          yield { path, ...stream };
          await consumed;
          activeStream = undefined;
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      activeStream?.destroy();
      try {
        await release?.();
      } finally {
        unlockQueue();
        if (KnowledgeLibrary.queues.get(key) === queued) KnowledgeLibrary.queues.delete(key);
      }
    }
  }
}
