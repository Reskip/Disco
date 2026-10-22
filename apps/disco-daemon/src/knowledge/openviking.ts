import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KnowledgeOwner } from '@disco/core/types';

/** Provision one OpenViking account per authenticated Disco owner. */
export function openVikingAccountId(owner: KnowledgeOwner): string {
  if (!owner.tenantId?.trim() || !owner.userId?.trim()) {
    throw new Error('知识库身份不完整');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([owner.tenantId, owner.userId]))
    .digest('hex');
  return `disco_${digest.slice(0, 32)}`;
}

export interface OpenVikingIdentity {
  owner: KnowledgeOwner;
  accountId: string;
  userId: 'library';
  role: 'user';
  /** This must be an account-bound USER key, never the server root key. */
  apiKey: string;
}

export interface OpenVikingOptions {
  baseUrl: string;
  resolveIdentity: (
    owner: KnowledgeOwner
  ) => OpenVikingIdentity | undefined | Promise<OpenVikingIdentity | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  indexTimeoutMs?: number;
  summaryTimeoutMs?: number;
  summary?: {
    pythonExecutable: string;
    scriptPath: string;
    configPath: string;
    codexAuthFile?: string;
    authStorePath?: string;
  };
}

export interface OpenVikingSearchHit {
  id: string;
  uri: string;
  excerpt: string;
  score?: number;
}

export interface KnowledgeSummary {
  abstract: string;
  overview: string;
  title?: string;
  topic?: string;
  tags?: string[];
}

const providerMessages: Record<string, string> = {
  RESOURCE_BUSY: '索引服务正在处理上一批内容，将稍后重试',
  CONFLICT: '索引服务正在处理上一批内容，将稍后重试',
  UNAVAILABLE: '本地语义索引服务暂时不可用，将自动重试',
  REQUEST_TIMEOUT: '本次索引请求超时，将续传剩余分片',
  INDEX_NOT_READY: '语义索引仍在处理中，将继续检查',
  TASK_NOT_READY: '语义索引仍在处理中，将继续检查',
  TASK_FAILED: '语义索引计算失败，将自动重试',
  PROCESSING_ERROR: '语义索引计算失败，将自动重试',
  SUMMARY_RATE_LIMITED: '摘要额度暂时不足，将稍后自动重试',
  SUMMARY_AUTH_REQUIRED: '摘要账号需要重新登录，原文与索引保持可用',
  SUMMARY_TIMEOUT: '本轮摘要整理尚未完成，将从已完成的片段继续',
  CANCELLED: '后台处理已暂停，将在下次继续',
};

export class OpenVikingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus?: number
  ) {
    super(providerMessages[code] ?? message);
    this.name = 'OpenVikingError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeEntryId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(id)) {
    throw new OpenVikingError('资料编号无效', 'INVALID_ENTRY_ID');
  }
  return id;
}

// Bound each local embedding input; never truncate the portable source archive.
// UTF-8 bytes are deliberately conservative for multilingual model tokenization.
export function splitOpenVikingContent(content: string, maxBytes = 3000): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('Invalid chunk size');
  const chunks: string[] = [];
  let chunk = '';
  let size = 0;
  for (const character of content) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (size + bytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += character;
    size += bytes;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function partName(index: number): string {
  return index === 0 ? 'content.md' : `part-${String(index + 1).padStart(10, '0')}.md`;
}

function isPartName(value: string): boolean {
  return /^(?:content|part-\d{10})\.md$/.test(value);
}

/** Local service only: credentials and archive copies cannot follow a remote URL. */
function localServiceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenVikingError('OpenViking 地址无效', 'INVALID_CONFIGURATION');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new OpenVikingError('OpenViking 必须使用本机服务地址', 'INVALID_CONFIGURATION');
  }
  return url;
}

/** Administrative provisioning only; never give this root key to the data client. */
export async function provisionOpenVikingOwner(
  baseUrl: string,
  rootKey: string,
  owner: KnowledgeOwner,
  fetcher: typeof fetch = fetch
): Promise<OpenVikingIdentity> {
  const base = localServiceUrl(baseUrl);
  const accountId = openVikingAccountId(owner);
  if (!rootKey?.trim()) throw new OpenVikingError('未配置索引服务管理凭据', 'NOT_CONFIGURED');
  const usersPath = `/api/v1/admin/accounts/${accountId}/users`;
  const keyPath = `${usersPath}/library/key`;
  const allowed = new Set(['/api/v1/admin/accounts', usersPath, keyPath]);
  async function post(
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    if (!allowed.has(path)) throw new OpenVikingError('管理接口不在允许范围内', 'FORBIDDEN');
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method: 'POST',
        headers: { 'X-API-Key': rootKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new OpenVikingError('语义索引服务暂时不可用', 'UNAVAILABLE');
    }
    let envelope: Record<string, unknown> | undefined;
    try {
      envelope = record(await response.json());
    } catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        throw new OpenVikingError('本次索引请求超时', 'REQUEST_TIMEOUT');
      /* handled below */
    }
    if (!response.ok || envelope?.status !== 'ok') {
      const code = record(envelope?.error)?.code;
      throw new OpenVikingError(
        '索引账户初始化失败',
        code === 'ALREADY_EXISTS' ? code : 'PROVISION_FAILED',
        response.status
      );
    }
    return record(envelope.result);
  }
  try {
    await post('/api/v1/admin/accounts', { account_id: accountId, admin_user_id: 'disco-admin' });
  } catch (error) {
    if (!(error instanceof OpenVikingError) || error.code !== 'ALREADY_EXISTS') throw error;
  }
  // A cryptographic per-owner seed makes an interrupted first provisioning safely
  // repeatable. It is not derived from public IDs alone and is never logged.
  const seed = createHmac('sha256', rootKey)
    .update(`disco-knowledge-user-key\0${accountId}`)
    .digest('hex');
  let result: Record<string, unknown> | undefined;
  try {
    result = await post(usersPath, { user_id: 'library', role: 'user', seed });
  } catch (error) {
    if (!(error instanceof OpenVikingError) || error.code !== 'ALREADY_EXISTS') throw error;
    result = await post(keyPath, { seed });
  }
  if (typeof result?.user_key !== 'string' || !result.user_key.trim()) {
    throw new OpenVikingError('索引账户未返回普通用户凭据', 'INVALID_RESPONSE');
  }
  return {
    owner: { ...owner },
    accountId,
    userId: 'library',
    role: 'user',
    apiKey: result.user_key,
  };
}

/**
 * Derived search index only. The portable Markdown library remains authoritative.
 * API contracts: https://docs.openviking.ai/en/api/12-content and /06-retrieval.
 * api_key mode derives ownership from USER keys; identity headers cannot override it.
 */
export class OpenVikingClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly indexTimeoutMs: number;
  private readonly summaryTimeoutMs: number;
  /** Keep accepted work across retries instead of submitting it a second time. */
  private readonly pendingBatches = new Map<string, unknown>();
  private readonly requests = new Set<AbortController>();
  private readonly summaries = new Set<() => void>();
  private readonly summariesByEntry = new Map<string, Set<() => void>>();
  private readonly summaryExits = new Map<string, Set<Promise<void>>>();
  private cancellationEpoch = 0;

  constructor(private readonly options: OpenVikingOptions) {
    this.baseUrl = localServiceUrl(options.baseUrl);
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.indexTimeoutMs = options.indexTimeoutMs ?? 180_000;
    this.summaryTimeoutMs = options.summaryTimeoutMs ?? 600_000;
  }

  /** Stop only work owned by this client; a later worker pass can safely resume. */
  cancelPending(): void {
    this.cancellationEpoch += 1;
    for (const request of this.requests) request.abort();
    for (const cancel of [...this.summaries]) cancel();
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.cancellationEpoch) throw new OpenVikingError('后台处理已暂停', 'CANCELLED');
  }

  private async forgetSummary(owner: KnowledgeOwner, id: string): Promise<void> {
    const scope = openVikingAccountId(owner);
    const entryId = safeEntryId(id);
    const key = `${scope}:${entryId}`;
    const exits = [...(this.summaryExits.get(key) ?? [])];
    for (const cancel of [...(this.summariesByEntry.get(key) ?? [])]) cancel();
    const settings = this.options.summary;
    if (!settings) return;
    try {
      if (!isAbsolute(settings.configPath)) throw new Error('Invalid cache configuration');
      const base = resolve(dirname(settings.configPath));
      const baseInfo = await lstat(base);
      if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink())
        throw new Error('Unsafe cache base');
      let parent = base;
      for (const part of ['summary-work', scope, '.deleted']) {
        parent = join(parent, part);
        await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe cache parent');
      }
      // A marker prevents a delayed model response from recreating deleted cache.
      await writeFile(join(parent, entryId), '', { flag: 'wx', mode: 0o600 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        }
      );
      if (exits.length)
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(() => reject(new Error('Summary child is still exiting')), 5000);
          Promise.all(exits).then(() => {
            clearTimeout(timer);
            done();
          }, reject);
        });
      const target = resolve(base, 'summary-work', scope, entryId);
      const child = relative(base, target);
      if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
        throw new Error('Unsafe cache target');
      const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe cache target');
        await rm(target, { recursive: true, force: true });
      }
    } catch {
      // A derived-cache filesystem failure must not resurrect the deleted entry
      // or make a completed vector deletion retry forever.
      console.warn('[knowledge] 已删除资料的摘要临时缓存尚未清理');
    }
  }

  private async identity(owner: KnowledgeOwner): Promise<OpenVikingIdentity> {
    const accountId = openVikingAccountId(owner);
    const identity = await this.options.resolveIdentity(owner);
    if (!identity) throw new OpenVikingError('此用户尚未配置语义索引', 'NOT_CONFIGURED');
    if (
      identity.owner.tenantId !== owner.tenantId ||
      identity.owner.userId !== owner.userId ||
      identity.accountId !== accountId ||
      identity.userId !== 'library' ||
      identity.role !== 'user' ||
      !identity.apiKey?.trim()
    ) {
      throw new OpenVikingError('OpenViking 身份配置不匹配', 'IDENTITY_MISMATCH');
    }
    const health = record(
      await this.request(identity, '/health', 'GET', undefined, this.requestTimeoutMs, true)
    );
    if (
      health?.auth_mode !== 'api_key' ||
      health.account_id !== accountId ||
      health.user_id !== 'library' ||
      health.role !== 'user'
    ) {
      throw new OpenVikingError('OpenViking 身份校验失败', 'IDENTITY_MISMATCH');
    }
    return identity;
  }

  private root(owner: KnowledgeOwner): string {
    // The owner prefix is defence in depth if an operator misbinds a credential.
    return `viking://user/library/resources/disco/${openVikingAccountId(owner)}/entries`;
  }

  documentUri(owner: KnowledgeOwner, id: string): string {
    return `${this.root(owner)}/${safeEntryId(id)}/content.md`;
  }

  private async request(
    identity: OpenVikingIdentity,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
    rawEnvelope = false
  ): Promise<unknown> {
    let response: Response;
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method,
        headers: {
          'X-API-Key': identity.apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      this.requests.delete(controller);
      // Do not include provider exception text: it can contain keys, URLs or content.
      const code = controller.signal.aborted
        ? 'CANCELLED'
        : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
          ? 'REQUEST_TIMEOUT'
          : 'UNAVAILABLE';
      throw new OpenVikingError('语义索引服务暂时不可用', code);
    }
    let envelope: Record<string, unknown> | undefined;
    try {
      envelope = record(await response.json());
    } catch (error) {
      if (controller.signal.aborted) throw new OpenVikingError('后台处理已暂停', 'CANCELLED');
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        throw new OpenVikingError('本次索引请求超时', 'REQUEST_TIMEOUT');
      /* handled below */
    } finally {
      this.requests.delete(controller);
    }
    if (controller.signal.aborted) throw new OpenVikingError('后台处理已暂停', 'CANCELLED');
    if (!response.ok || envelope?.status !== 'ok') {
      const error = record(envelope?.error);
      const details = record(error?.details);
      const code =
        error?.code === 'CONFLICT' && details?.conflict_type === 'path_busy'
          ? 'RESOURCE_BUSY'
          : error?.code;
      throw new OpenVikingError(
        '语义索引请求失败',
        typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'PROVIDER_ERROR',
        response.status
      );
    }
    return rawEnvelope ? envelope : envelope.result;
  }

  private async waitForTask(identity: OpenVikingIdentity, value: unknown): Promise<unknown> {
    const epoch = this.cancellationEpoch;
    const taskId = record(value)?.task_id;
    if (taskId === undefined) return value;
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(taskId))
      throw new OpenVikingError('索引维护任务格式无效', 'INVALID_RESPONSE');
    const deadline = Date.now() + this.indexTimeoutMs;
    for (;;) {
      this.assertActive(epoch);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new OpenVikingError('索引维护任务尚未完成', 'TASK_NOT_READY');
      const task = record(
        await this.request(
          identity,
          `/api/v1/tasks/${taskId}`,
          'GET',
          undefined,
          Math.min(this.requestTimeoutMs, remaining)
        )
      );
      if (task?.status === 'completed') return task.result;
      if (task?.status === 'failed' || task?.status === 'cancelled')
        throw new OpenVikingError('索引维护任务失败', 'TASK_FAILED');
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
    }
  }

  async index(
    owner: KnowledgeOwner,
    document: { id: string; content: string }
  ): Promise<{ uri: string }> {
    const epoch = this.cancellationEpoch;
    const uri = this.documentUri(owner, document.id);
    const identity = await this.identity(owner);
    const root = `${this.root(owner)}/${safeEntryId(document.id)}`;
    try {
      await this.request(identity, '/api/v1/fs/mkdir', 'POST', { uri: root });
    } catch (error) {
      if (
        !(error instanceof OpenVikingError) ||
        (error.code !== 'ALREADY_EXISTS' &&
          !(error.code === 'CONFLICT' && error.httpStatus === 409))
      )
        throw error;
    }
    const previousParts = await this.listParts(identity, root);
    const chunks = splitOpenVikingContent(document.content);
    const operations = chunks.map((content, index) => ({
      uri: `${root}/${partName(index)}`,
      content,
      mode: 'replace',
      tags: [`disco_entry=${document.id}`, 'disco_index=active'],
      tag_mode: 'replace',
    }));
    const current = new Set(operations.map((operation) => operation.uri));
    // OpenViking DELETE automatically invokes the parent semantic refresh. Clear
    // obsolete derived chunks with vectors_only instead, preserving phase order.
    for (const previous of previousParts) {
      if (!current.has(previous))
        operations.push({
          uri: previous,
          content: '',
          mode: 'replace',
          tags: [`disco_entry=${document.id}`, 'disco_index=inactive'],
          tag_mode: 'replace',
        });
    }
    // A long archive can contain thousands of chunks. One unbounded batch can hold
    // provider locks beyond the HTTP deadline and collide with its own retry.
    // Bound each transaction and wait for its tracked embedding task separately.
    for (let offset = 0; offset < operations.length; offset += 16) {
      this.assertActive(epoch);
      const batch = operations.slice(offset, offset + 16);
      const key = `${root}/${createHash('sha256').update(JSON.stringify(batch)).digest('hex')}`;
      let accepted = this.pendingBatches.get(key);
      if (!accepted) {
        for (let attempt = 0; ; attempt += 1) {
          this.assertActive(epoch);
          try {
            accepted = await this.request(
              identity,
              '/api/v1/content/batch-write',
              'POST',
              { root_uri: root, operations: batch, processing_mode: 'vectors_only', wait: false },
              this.indexTimeoutMs
            );
            if (record(accepted)?.task_id) this.pendingBatches.set(key, accepted);
            break;
          } catch (error) {
            if (
              !(error instanceof OpenVikingError) ||
              error.code !== 'RESOURCE_BUSY' ||
              attempt >= 2
            )
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
      }
      let completed: unknown;
      try {
        completed = await this.waitForTask(identity, accepted);
      } catch (error) {
        if (error instanceof OpenVikingError && ['TASK_FAILED', 'NOT_FOUND'].includes(error.code))
          this.pendingBatches.delete(key);
        throw error;
      }
      this.pendingBatches.delete(key);
      const result = record(completed);
      // A committed file alone does not prove that its embedding succeeded.
      if (result?.vector_status !== 'complete' && result?.vector_status !== 'skipped') {
        throw new OpenVikingError('资料已保存，语义索引尚未完成', 'INDEX_NOT_READY');
      }
    }
    return { uri };
  }

  private async listParts(identity: OpenVikingIdentity, root: string): Promise<string[]> {
    const epoch = this.cancellationEpoch;
    const parts = new Set<string>();
    let offset = 0;
    for (;;) {
      this.assertActive(epoch);
      const envelope = record(
        await this.request(
          identity,
          `/api/v1/fs/ls?${new URLSearchParams({ uri: root, output: 'original', offset: String(offset), limit: '256', sort_by: 'name', sort_order: 'asc' })}`,
          'GET',
          undefined,
          this.requestTimeoutMs,
          true
        )
      );
      if (!Array.isArray(envelope?.result))
        throw new OpenVikingError('语义索引返回格式无效', 'INVALID_RESPONSE');
      for (const value of envelope.result) {
        const item = record(value);
        if (typeof item?.uri !== 'string' || !item.uri.startsWith(`${root}/`) || item.isDir)
          continue;
        if (isPartName(item.uri.slice(root.length + 1))) parts.add(item.uri);
      }
      if (!envelope.has_more) break;
      if (!envelope.result.length)
        throw new OpenVikingError('语义索引分页未前进', 'INVALID_RESPONSE');
      offset += envelope.result.length;
    }
    return [...parts].sort();
  }

  private async readParts(
    identity: OpenVikingIdentity,
    root: string
  ): Promise<Array<{ uri: string; content: string }>> {
    const epoch = this.cancellationEpoch;
    const uris = await this.listParts(identity, root);
    if (!uris.length) throw new OpenVikingError('资料尚未建立语义索引', 'NOT_FOUND', 404);
    const parts: Array<{ uri: string; content: string }> = [];
    for (let offset = 0; offset < uris.length; offset += 4) {
      this.assertActive(epoch);
      const batch = await Promise.all(
        uris.slice(offset, offset + 4).map(async (uri) => {
          const content = await this.request(
            identity,
            `/api/v1/content/read?${new URLSearchParams({ uri })}`,
            'GET'
          );
          if (typeof content !== 'string')
            throw new OpenVikingError('语义索引返回格式无效', 'INVALID_RESPONSE');
          return { uri, content };
        })
      );
      parts.push(...batch);
    }
    return parts;
  }

  async search(
    owner: KnowledgeOwner,
    options: {
      query: string;
      limit?: number;
      documentIds?: string[];
    }
  ): Promise<OpenVikingSearchHit[]> {
    const query = options.query.trim();
    if (!query || options.documentIds?.length === 0) return [];
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new OpenVikingError('检索条数无效', 'INVALID_LIMIT');
    }
    const identity = await this.identity(owner);
    const root = this.root(owner);
    const targets = options.documentIds?.map((id) => `${root}/${safeEntryId(id)}`);
    const result = record(
      await this.request(identity, '/api/v1/search/find', 'POST', {
        query,
        target_uri: targets ?? root,
        limit,
        level: 2,
        context_type: 'resource',
        tags: ['disco_index=active'],
        read_content: true,
      })
    );
    if (!Array.isArray(result?.resources)) {
      throw new OpenVikingError('语义索引返回格式无效', 'INVALID_RESPONSE');
    }
    const allowed = options.documentIds ? new Set(options.documentIds) : undefined;
    const seen = new Set<string>();
    const hits: OpenVikingSearchHit[] = [];
    for (const value of result.resources) {
      const item = record(value);
      if (typeof item?.uri !== 'string' || !item.uri.startsWith(`${root}/`)) continue;
      const name = item.uri.slice(root.length + 1);
      const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,159})\/(content|part-\d{10})\.md$/.exec(name);
      if (!match || (allowed && !allowed.has(match[1]))) continue;
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({
        id,
        uri: item.uri,
        excerpt:
          typeof item.content === 'string'
            ? item.content
            : typeof item.abstract === 'string'
              ? item.abstract
              : '',
        ...(typeof item.score === 'number' && Number.isFinite(item.score)
          ? { score: item.score }
          : {}),
      });
      if (hits.length === limit) break;
    }
    return hits;
  }

  async read(owner: KnowledgeOwner, id: string): Promise<string> {
    const root = `${this.root(owner)}/${safeEntryId(id)}`;
    const identity = await this.identity(owner);
    return (await this.readParts(identity, root)).map((part) => part.content).join('');
  }

  async delete(owner: KnowledgeOwner, id: string): Promise<void> {
    const uri = `${this.root(owner)}/${safeEntryId(id)}`;
    await this.forgetSummary(owner, id);
    const identity = await this.identity(owner);
    let removal: unknown;
    try {
      removal = await this.request(
        identity,
        `/api/v1/fs?${new URLSearchParams({ uri, recursive: 'true' })}`,
        'DELETE'
      );
    } catch (error) {
      if (!(error instanceof OpenVikingError) || error.httpStatus !== 404) throw error;
      return;
    }
    await this.waitForTask(identity, removal);
  }

  /** Call only from the separate low-speed summary queue after original indexing. */
  async summarize(owner: KnowledgeOwner, id: string): Promise<KnowledgeSummary> {
    const root = `${this.root(owner)}/${safeEntryId(id)}`;
    const identity = await this.identity(owner);
    const parts = await this.readParts(identity, root);
    return this.summarizeContent(owner, {
      id,
      content: parts.map((part) => part.content).join(''),
    });
  }

  /** Explicit/manual synthesis need not wait for a derived semantic index. */
  async summarizeContent(
    owner: KnowledgeOwner,
    document: { id: string; content: string; instructions?: string }
  ): Promise<KnowledgeSummary> {
    openVikingAccountId(owner);
    safeEntryId(document.id);
    const settings = this.options.summary;
    if (!settings) throw new OpenVikingError('摘要模型尚未配置', 'NOT_CONFIGURED');
    if (
      [
        settings.pythonExecutable,
        settings.scriptPath,
        settings.configPath,
        settings.codexAuthFile,
        settings.authStorePath,
      ].some((path) => path !== undefined && !isAbsolute(path))
    )
      throw new OpenVikingError('摘要运行配置必须使用绝对路径', 'INVALID_CONFIGURATION');
    return new Promise((resolve, reject) => {
      const child = spawn(
        settings.pythonExecutable,
        [settings.scriptPath, '--config', settings.configPath],
        {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            NO_PROXY: '127.0.0.1,localhost,::1',
            ...(settings.codexAuthFile
              ? { OPENVIKING_CODEX_BOOTSTRAP_PATH: settings.codexAuthFile }
              : {}),
            ...(settings.authStorePath
              ? { OPENVIKING_CODEX_AUTH_PATH: settings.authStorePath }
              : {}),
          },
        }
      );
      let output = '';
      let settled = false;
      const jobKey = `${openVikingAccountId(owner)}:${document.id}`;
      const exited = new Promise<void>((done) => child.once('close', () => done()));
      const exits = this.summaryExits.get(jobKey) ?? new Set<Promise<void>>();
      exits.add(exited);
      this.summaryExits.set(jobKey, exits);
      void exited.then(() => {
        exits.delete(exited);
        if (!exits.size) this.summaryExits.delete(jobKey);
      });
      const cancel = () => fail('CANCELLED');
      const release = () => {
        this.summaries.delete(cancel);
        const jobs = this.summariesByEntry.get(jobKey);
        jobs?.delete(cancel);
        if (jobs?.size === 0) this.summariesByEntry.delete(jobKey);
      };
      const fail = (code = 'SUMMARY_FAILED') => {
        if (settled) return;
        settled = true;
        release();
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === 'win32' && child.pid) {
            // A Windows venv launcher owns a second Python process. Terminate
            // this specific child tree so a timeout cannot leave a cloud request.
            const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              shell: false,
              stdio: 'ignore',
            });
            terminator.on('error', () => child.kill());
          } else child.kill();
        }
        reject(new OpenVikingError('资料摘要未生成，原文与索引保持可用', code));
      };
      const timer = setTimeout(() => fail('SUMMARY_TIMEOUT'), this.summaryTimeoutMs);
      this.summaries.add(cancel);
      const jobs = this.summariesByEntry.get(jobKey) ?? new Set<() => void>();
      jobs.add(cancel);
      this.summariesByEntry.set(jobKey, jobs);
      child.on('error', () => fail());
      child.stdin.on('error', () => fail());
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 2_000_000) fail('INVALID_RESPONSE');
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          try {
            const failure = record(JSON.parse(output))?.error;
            if (
              failure === 'SUMMARY_RATE_LIMITED' ||
              failure === 'SUMMARY_AUTH_REQUIRED' ||
              failure === 'CANCELLED'
            )
              return fail(failure);
          } catch {
            /* Only the fixed helper error codes are exposed. */
          }
          return fail();
        }
        try {
          const result = record(JSON.parse(output));
          if (
            typeof result?.abstract !== 'string' ||
            typeof result.overview !== 'string' ||
            !result.overview.trim()
          )
            return fail('INVALID_RESPONSE');
          settled = true;
          release();
          clearTimeout(timer);
          resolve({
            abstract: result.abstract,
            overview: result.overview,
            ...(typeof result.title === 'string' ? { title: result.title } : {}),
            ...(typeof result.topic === 'string' ? { topic: result.topic } : {}),
            ...(Array.isArray(result.tags) && result.tags.every((tag) => typeof tag === 'string')
              ? { tags: result.tags as string[] }
              : {}),
          });
        } catch {
          fail('INVALID_RESPONSE');
        }
      });
      child.stdin.end(
        JSON.stringify({
          content: document.content,
          instructions: document.instructions,
          scope: openVikingAccountId(owner),
          entry_id: document.id,
        })
      );
    });
  }
}
