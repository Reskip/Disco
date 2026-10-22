import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeOwner,
  KnowledgeSummaryProgress,
} from '@disco/core/types';

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
  summaryRequestTimeoutMs?: number;
  summaryCancelTimeoutMs?: number;
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
  archiveOnly?: boolean;
  reason?: string;
  summaryMode?: 'structured_overview' | 'model';
}

export type KnowledgeSummaryResult =
  | KnowledgeSummary
  | { pending: true; progress: KnowledgeSummaryProgress };

/** Sources are resolved from the same authenticated library by the caller. */
export interface KnowledgeSummarySource {
  id: string;
  title: string;
  kind: KnowledgeKind;
  format?: string;
  markdown: string;
  projection?: KnowledgeEntry['parseProjection'];
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
  SUMMARY_TIMEOUT: '模型响应超时，稍后重试；原文已保留',
  SUMMARY_PROCESS_TIMEOUT: '本轮摘要处理超时，稍后重试；原文与已完成结果已保留',
  SUMMARY_FORMAT_INVALID: '摘要返回格式不完整，将稍后重新整理；原文保持可用',
  SUMMARY_EMPTY: '摘要模型未返回内容，将稍后重新整理',
  SUMMARY_INCOMPLETE: '摘要响应中途结束，将稍后重试；原文已保留',
  SUMMARY_NETWORK: '摘要服务连接失败，将稍后自动重试',
  SUMMARY_SERVICE_UNAVAILABLE: '摘要服务暂时不可用，将稍后自动重试',
  SUMMARY_MODEL_UNAVAILABLE: '当前摘要模型不可用，请检查模型配置',
  SUMMARY_CONFIGURATION: '摘要模型配置不兼容，请检查后台配置',
  SUMMARY_INPUT_TOO_LARGE: '摘要片段超过模型可处理范围，原文与索引保持可用',
  SUMMARY_CONTENT_BLOCKED: '摘要模型未能处理这份资料，原文与索引保持可用',
  SUMMARY_CACHE_UNAVAILABLE: '摘要进度缓存无法写入，请检查存储空间与权限',
  SUMMARY_REDUCTION_FAILED: '资料片段过多且无法合并，请调整整理范围',
  SUMMARY_FAILED: '资料摘要未生成，原文与索引保持可用',
  CANCELLED: '后台处理已暂停，将在下次继续',
  CANCEL_FAILED: '摘要后台进程尚未退出，请稍后检查后台状态',
};

const summaryRetryMs: Record<string, number> = {
  SUMMARY_NETWORK: 30_000,
  SUMMARY_SERVICE_UNAVAILABLE: 30_000,
  SUMMARY_TIMEOUT: 60_000,
  SUMMARY_PROCESS_TIMEOUT: 60_000,
  SUMMARY_FORMAT_INVALID: 300_000,
  SUMMARY_EMPTY: 300_000,
  SUMMARY_INCOMPLETE: 300_000,
  SUMMARY_FAILED: 300_000,
  SUMMARY_RATE_LIMITED: 1_800_000,
  SUMMARY_AUTH_REQUIRED: 3_600_000,
  SUMMARY_MODEL_UNAVAILABLE: 3_600_000,
  SUMMARY_CONFIGURATION: 3_600_000,
  SUMMARY_CACHE_UNAVAILABLE: 3_600_000,
  SUMMARY_CONTENT_BLOCKED: 3_600_000,
  SUMMARY_INPUT_TOO_LARGE: 3_600_000,
  SUMMARY_REDUCTION_FAILED: 3_600_000,
};

export class OpenVikingError extends Error {
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus?: number
  ) {
    super(providerMessages[code] ?? message);
    this.name = 'OpenVikingError';
    this.retryAfterMs = summaryRetryMs[code];
  }
}

function summaryDiagnostic(value: unknown): Record<string, string | number> {
  const input = record(value);
  const result: Record<string, string | number> = {};
  if (
    typeof input?.phase === 'string' &&
    ['stream', 'parse', 'cache', 'configuration', 'prepare', 'reduce', 'cancel'].includes(
      input.phase
    )
  )
    result.phase = input.phase;
  if (
    typeof input?.exceptionType === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(input.exceptionType)
  )
    result.exceptionType = input.exceptionType;
  for (const key of ['responseCharacters', 'jsonPosition']) {
    const count = input?.[key];
    if (
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count >= 0 &&
      count <= 2_000_000
    )
      result[key] = count;
  }
  return result;
}

/** Only counters/states cross the helper telemetry boundary, never model text. */
function summaryProgress(value: unknown): KnowledgeSummaryProgress | undefined {
  const input = record(value);
  if (
    !input ||
    !['queued', 'waiting_model', 'processing'].includes(String(input.phase)) ||
    !['map', 'reduce'].includes(String(input.stage)) ||
    !Number.isSafeInteger(input.completed) ||
    !Number.isSafeInteger(input.total) ||
    Number(input.completed) < 0 ||
    Number(input.total) < 1 ||
    Number(input.completed) > Number(input.total) ||
    Number(input.total) > 1_000_000 ||
    (input.stageLevel !== undefined &&
      (!Number.isSafeInteger(input.stageLevel) ||
        Number(input.stageLevel) < 1 ||
        Number(input.stageLevel) > 1000))
  )
    return undefined;
  if (
    input.phase === 'waiting_model' &&
    (typeof input.requestStartedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(input.requestStartedAt) ||
      !Number.isFinite(Date.parse(input.requestStartedAt)))
  )
    return undefined;
  return {
    phase: input.phase as KnowledgeSummaryProgress['phase'],
    stage: input.stage as KnowledgeSummaryProgress['stage'],
    completed: Number(input.completed),
    total: Number(input.total),
    ...(input.stageLevel !== undefined ? { stageLevel: Number(input.stageLevel) } : {}),
    ...(input.phase === 'waiting_model'
      ? { requestStartedAt: input.requestStartedAt as string }
      : {}),
  };
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
  private readonly summaryRequestTimeoutMs: number;
  private readonly summaryCancelTimeoutMs: number;
  /** Keep accepted work across retries instead of submitting it a second time. */
  private readonly pendingBatches = new Map<string, unknown>();
  private readonly requests = new Set<AbortController>();
  private readonly summaries = new Set<() => Promise<void>>();
  private readonly summariesByEntry = new Map<string, Set<() => Promise<void>>>();
  private readonly summaryExits = new Map<string, Set<Promise<void>>>();
  private cancellationEpoch = 0;

  constructor(private readonly options: OpenVikingOptions) {
    this.baseUrl = localServiceUrl(options.baseUrl);
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.indexTimeoutMs = options.indexTimeoutMs ?? 180_000;
    this.summaryTimeoutMs = options.summaryTimeoutMs ?? 300_000;
    this.summaryRequestTimeoutMs = options.summaryRequestTimeoutMs ?? 180_000;
    this.summaryCancelTimeoutMs = options.summaryCancelTimeoutMs ?? 5000;
  }

  /** Stop only work owned by this client; a later worker pass can safely resume. */
  async cancelPending(): Promise<void> {
    this.cancellationEpoch += 1;
    for (const request of this.requests) request.abort();
    const exits = [...this.summaryExits.values()].flatMap((values) => [...values]);
    const cancellations = [...this.summaries].map((cancel) => cancel());
    await this.waitForSummaryExit([...exits, ...cancellations]);
  }

  private async waitForSummaryExit(work: Promise<void>[]): Promise<void> {
    if (!work.length) return;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new OpenVikingError('摘要进程退出超时', 'CANCEL_FAILED')),
        this.summaryCancelTimeoutMs
      );
      Promise.all(work).then(
        () => {
          clearTimeout(timer);
          done();
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.cancellationEpoch) throw new OpenVikingError('后台处理已暂停', 'CANCELLED');
  }

  private async forgetSummary(owner: KnowledgeOwner, id: string): Promise<void> {
    const scope = openVikingAccountId(owner);
    const entryId = safeEntryId(id);
    const key = `${scope}:${entryId}`;
    const exits = [...(this.summaryExits.get(key) ?? [])];
    const cancellations = [...(this.summariesByEntry.get(key) ?? [])].map((cancel) => cancel());
    // Attach rejection handlers before filesystem work while cancellation runs.
    const cancelled = Promise.all(cancellations);
    void cancelled.catch(() => undefined);
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
      await this.waitForSummaryExit([...exits, cancelled.then(() => undefined)]);
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

  /** Authenticated, read-only connectivity check; no document or model operation. */
  async probe(owner: KnowledgeOwner): Promise<void> {
    await this.identity(owner, true, this.cancellationEpoch);
  }

  private async identity(
    owner: KnowledgeOwner,
    requireHealthy = false,
    expectedEpoch?: number
  ): Promise<OpenVikingIdentity> {
    const accountId = openVikingAccountId(owner);
    const identity = await this.options.resolveIdentity(owner);
    if (expectedEpoch !== undefined) this.assertActive(expectedEpoch);
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
    if (requireHealthy && health.healthy !== true)
      throw new OpenVikingError('语义索引服务尚未就绪', 'UNAVAILABLE');
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
    const epoch = this.cancellationEpoch;
    const identity = await this.identity(owner);
    const root = this.root(owner);
    const targets = options.documentIds?.map((id) => `${root}/${safeEntryId(id)}`);
    const allowed = options.documentIds ? new Set(options.documentIds) : undefined;
    const seen = new Set<string>();
    const hits: OpenVikingSearchHit[] = [];
    const deadline = Date.now() + this.requestTimeoutMs;
    // Ranked chunks from one long conversation must not consume every document
    // candidate. Subsequent rounds exclude whole already-seen documents using
    // the existing per-chunk entry tags, within one overall request deadline.
    for (let round = 0; round < 4 && hits.length < limit; round++) {
      this.assertActive(epoch);
      if (allowed && seen.size >= allowed.size) break;
      const previousSize = seen.size;
      const nodeLimit = Math.max(40, Math.min(200, (limit - hits.length) * 4));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let result: Record<string, unknown> | undefined;
      try {
        result = record(
          await this.request(
            identity,
            '/api/v1/search/find',
            'POST',
            {
              query,
              target_uri: targets ?? root,
              limit: nodeLimit,
              level: 2,
              context_type: 'resource',
              tags: ['disco_index=active'],
              ...(seen.size
                ? {
                    filter: {
                      op: 'must_not',
                      field: 'search_tags',
                      conds: [...seen].map((id) => `disco_entry=${id}`),
                    },
                  }
                : {}),
              read_content: true,
            },
            remaining
          )
        );
      } catch (error) {
        if (!hits.length || (error instanceof OpenVikingError && error.code === 'CANCELLED'))
          throw error;
        break;
      }
      if (!Array.isArray(result?.resources)) {
        throw new OpenVikingError('语义索引返回格式无效', 'INVALID_RESPONSE');
      }
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
      if (seen.size === previousSize || result.resources.length < nodeLimit) break;
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
  async summarize(owner: KnowledgeOwner, id: string): Promise<KnowledgeSummaryResult> {
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
    document: {
      id: string;
      content: string;
      instructions?: string;
      sources?: KnowledgeSummarySource[];
      forceSynthesis?: boolean;
      onProgress?: (progress: KnowledgeSummaryProgress) => void;
    }
  ): Promise<KnowledgeSummaryResult> {
    openVikingAccountId(owner);
    safeEntryId(document.id);
    if (document.sources) {
      if (!document.sources.length)
        throw new OpenVikingError('摘要来源为空', 'SUMMARY_CONFIGURATION');
      for (const source of document.sources) {
        safeEntryId(source.id);
        if (
          typeof source.title !== 'string' ||
          typeof source.markdown !== 'string' ||
          !['conversation', 'document', 'note'].includes(source.kind)
        )
          throw new OpenVikingError('摘要来源信息无效', 'SUMMARY_CONFIGURATION');
      }
    }
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
          stdio: ['pipe', 'pipe', 'pipe'],
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
      let progressBuffer = '';
      let discardingProgressLine = false;
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      let termination: Promise<void> | undefined;
      const jobKey = `${openVikingAccountId(owner)}:${document.id}`;
      const exited = new Promise<void>((done) => child.once('close', () => done()));
      const exits = this.summaryExits.get(jobKey) ?? new Set<Promise<void>>();
      exits.add(exited);
      this.summaryExits.set(jobKey, exits);
      void exited.then(() => {
        exits.delete(exited);
        if (!exits.size) this.summaryExits.delete(jobKey);
      });
      const cancel = () => {
        fail('CANCELLED');
        return termination ?? exited;
      };
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
        clearTimeout(requestTimer);
        if (child.exitCode === null && child.signalCode === null) {
          termination = this.waitForSummaryExit([
            exited,
            new Promise<void>((done, failed) => {
              if (process.platform === 'win32' && child.pid) {
                // A venv launcher owns another Python process. Killing only
                // the wrapper can leave a cloud request alive indefinitely.
                const terminator = spawn(
                  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
                  ['/PID', String(child.pid), '/T', '/F'],
                  {
                    windowsHide: true,
                    shell: false,
                    stdio: 'ignore',
                  }
                );
                terminator.on('error', () =>
                  failed(new OpenVikingError('无法终止摘要进程树', 'CANCEL_FAILED'))
                );
                terminator.on('close', (code) => {
                  if (code === 0) done();
                  else failed(new OpenVikingError('摘要进程树未退出', 'CANCEL_FAILED'));
                });
              } else if (child.kill() || child.exitCode !== null || child.signalCode !== null)
                done();
              else failed(new OpenVikingError('摘要进程未退出', 'CANCEL_FAILED'));
            }),
          ]);
          // Timeouts also terminate a child, without an explicit cancel caller.
          void termination.catch(() => console.warn('[knowledge] 摘要后台进程未能按时退出'));
        }
        reject(new OpenVikingError('资料摘要未生成，原文与索引保持可用', code));
      };
      const timer = setTimeout(() => fail('SUMMARY_PROCESS_TIMEOUT'), this.summaryTimeoutMs);
      const updateProgress = (progress: KnowledgeSummaryProgress) => {
        if (settled) return;
        if (progress.phase === 'waiting_model') {
          // Repeated activity/heartbeats cannot extend an in-flight request.
          requestTimer ??= setTimeout(() => fail('SUMMARY_TIMEOUT'), this.summaryRequestTimeoutMs);
        } else {
          clearTimeout(requestTimer);
          requestTimer = undefined;
        }
        try {
          document.onProgress?.(progress);
        } catch {
          /* UI observers cannot fail a model job. */
        }
      };
      this.summaries.add(cancel);
      const jobs = this.summariesByEntry.get(jobKey) ?? new Set<() => Promise<void>>();
      jobs.add(cancel);
      this.summariesByEntry.set(jobKey, jobs);
      child.on('error', () => fail());
      child.stdin.on('error', () => fail());
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 2_000_000) fail('INVALID_RESPONSE');
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        for (const character of chunk) {
          if (character === '\n') {
            if (!discardingProgressLine) {
              try {
                const event = record(JSON.parse(progressBuffer));
                const progress =
                  event?.type === 'summary_progress' ? summaryProgress(event.progress) : undefined;
                if (progress) updateProgress(progress);
              } catch {
                /* Third-party stderr is not exposed or retained. */
              }
            }
            progressBuffer = '';
            discardingProgressLine = false;
          } else if (!discardingProgressLine) {
            progressBuffer += character;
            if (progressBuffer.length > 4096) {
              progressBuffer = '';
              discardingProgressLine = true;
            }
          }
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          try {
            const response = record(JSON.parse(output));
            const failure = response?.error;
            if (
              typeof failure === 'string' &&
              (Object.hasOwn(summaryRetryMs, failure) || failure === 'CANCELLED')
            ) {
              if (failure !== 'CANCELLED')
                console.warn('[knowledge] 摘要处理未完成', {
                  code: failure,
                  ...summaryDiagnostic(response?.diagnostic),
                });
              return fail(failure);
            }
          } catch {
            /* Only the fixed helper error codes are exposed. */
          }
          return fail();
        }
        try {
          const result = record(JSON.parse(output));
          if (result?.pending === true) {
            const progress = summaryProgress(result.progress);
            if (progress?.phase !== 'queued') return fail('SUMMARY_FORMAT_INVALID');
            updateProgress(progress);
            settled = true;
            release();
            clearTimeout(timer);
            clearTimeout(requestTimer);
            resolve({ pending: true, progress });
            return;
          }
          if (
            typeof result?.abstract !== 'string' ||
            typeof result.overview !== 'string' ||
            !result.overview.trim()
          )
            return fail('SUMMARY_FORMAT_INVALID');
          settled = true;
          release();
          clearTimeout(timer);
          clearTimeout(requestTimer);
          resolve({
            abstract: result.abstract,
            overview: result.overview,
            ...(result.summaryMode === 'structured_overview' || result.summaryMode === 'model'
              ? { summaryMode: result.summaryMode }
              : {}),
            ...(typeof result.title === 'string' ? { title: result.title } : {}),
            ...(typeof result.topic === 'string' ? { topic: result.topic } : {}),
            ...(Array.isArray(result.tags) && result.tags.every((tag) => typeof tag === 'string')
              ? { tags: result.tags as string[] }
              : {}),
            ...(result.archiveOnly === true
              ? {
                  archiveOnly: true,
                  ...(typeof result.reason === 'string'
                    ? { reason: result.reason.slice(0, 300) }
                    : {}),
                }
              : {}),
          });
        } catch {
          fail('SUMMARY_FORMAT_INVALID');
        }
      });
      child.stdin.end(
        JSON.stringify({
          content: document.content,
          instructions: document.instructions,
          sources: document.sources?.map(({ id, title, kind, format, markdown, projection }) => ({
            id,
            title,
            kind,
            format,
            markdown,
            ...(projection
              ? {
                  projection: {
                    kind: projection.kind,
                    version: projection.version,
                    contentHash: projection.contentHash,
                  },
                }
              : {}),
          })),
          forceSynthesis: document.forceSynthesis === true,
          scope: openVikingAccountId(owner),
          entry_id: document.id,
        })
      );
    });
  }
}
