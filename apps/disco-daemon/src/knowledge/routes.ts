import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DiscoConfig } from '@disco/core/config';
import {
  assertTenantWritable,
  eq,
  runWithTenantDatabaseScope,
  select,
  type TenantScopeAwareDatabase,
  users,
} from '@disco/core/db';
import type { Application } from '@disco/core/feathers';
import type {
  AuthenticatedParams,
  KnowledgeKind,
  KnowledgeMaterialType,
  KnowledgeOrganization,
  KnowledgeOwner,
  KnowledgeSource,
  User,
} from '@disco/core/types';
import archiver from 'archiver';
import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import multer from 'multer';
import { isExecutorSessionTokenPayload } from '../auth/executor-session-token.js';
import { extractKnowledgeDocument } from './documents.js';
import { KnowledgeConflictError } from './library.js';
import { KnowledgeRuntime, readKnowledgeConfig } from './runtime.js';

interface KnowledgeRequest extends Request {
  feathers?: AuthenticatedParams;
  knowledgeOwner?: KnowledgeOwner;
}
const tokenHash = (text: string) => createHash('sha256').update(text).digest();

/** Host capability cannot select another user, another tenant or non-KB endpoints. */
export function authenticateKnowledgeHost(
  runtime: KnowledgeRuntime,
  authorization: unknown,
  remoteAddress: string | undefined
): KnowledgeOwner | null {
  const host = runtime.settings.host;
  if (!host?.token || host.token.length < 32 || typeof authorization !== 'string') return null;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress ?? '')) return null;
  if (!authorization.startsWith('Bearer ')) return null;
  if (!timingSafeEqual(tokenHash(authorization.slice(7)), tokenHash(host.token))) return null;
  return { tenantId: host.tenantId, userId: host.userId };
}

function ownerOf(req: KnowledgeRequest): KnowledgeOwner {
  if (req.knowledgeOwner) return req.knowledgeOwner;
  const params = req.feathers;
  if (
    !params?.user?.user_id ||
    !params.tenant?.tenant_id ||
    (params.user as Partial<User>).must_change_password
  ) {
    throw Object.assign(new Error('请先登录并完成账号设置'), { status: 401 });
  }
  if (isExecutorSessionTokenPayload(params.authentication?.payload)) {
    throw Object.assign(new Error('执行器请使用会话授权的知识库工具'), { status: 403 });
  }
  return { tenantId: params.tenant.tenant_id, userId: params.user.user_id };
}
function scalar(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function sourceFilter(value: unknown): KnowledgeSource | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'disco' || value === 'codex' || value === 'manual') return value;
  throw Object.assign(new Error('资料来源无效'), { status: 400 });
}
function textField(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw Object.assign(new Error(`${label}必须是文本`), { status: 400 });
  return value;
}
function numberField(value: unknown, fallback: number, max: number): number {
  const number = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
}
const missing = () => Object.assign(new Error('资料不存在或已删除'), { status: 404 });

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string' && allowed.includes(value as T)) return value as T;
  throw Object.assign(new Error(`${label}无效`), { status: 400 });
}

function grouping(value: unknown): KnowledgeOrganization | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Object.assign(new Error('分类无效'), { status: 400 });
  const data = value as Record<string, unknown>;
  const topic = textField(data.topic, '主题').trim();
  const level = choice(data.level, ['source', 'summary', 'knowledge'] as const, '层级');
  const state = choice(data.state, ['draft', 'reviewed'] as const, '确认状态');
  if (
    !topic ||
    !level ||
    !state ||
    (data.tags !== undefined &&
      (!Array.isArray(data.tags) || data.tags.some((tag) => typeof tag !== 'string')))
  )
    throw Object.assign(new Error('请填写完整分类'), { status: 400 });
  return { topic, level, state, tags: data.tags as string[] | undefined };
}

export async function registerKnowledgeRoutes(input: {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: DiscoConfig;
  authenticateBrowser: RequestHandler;
}): Promise<KnowledgeRuntime> {
  const runtime = new KnowledgeRuntime(await readKnowledgeConfig(), input.db, input.config);
  input.app.set('knowledgeRuntime', runtime);
  const router = Router();
  // /knowledge itself is the browser page; API children require authentication.
  router.use((req, _res, next) => {
    if (req.path === '/' && ['GET', 'HEAD'].includes(req.method)) next('router');
    else next();
  });
  router.use((req: KnowledgeRequest, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const owner = authenticateKnowledgeHost(
      runtime,
      req.headers.authorization,
      req.socket.remoteAddress
    );
    if (owner) {
      req.knowledgeOwner = owner;
      next();
    } else input.authenticateBrowser(req, res, next);
  });
  router.use(async (req: KnowledgeRequest, _res, next) => {
    try {
      const owner = ownerOf(req);
      const user = await runWithTenantDatabaseScope(input.db, owner.tenantId, (db) =>
        select(db, { id: users.user_id }).from(users).where(eq(users.user_id, owner.userId)).one()
      );
      if (!user) throw missing();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/search') {
        await runWithTenantDatabaseScope(input.db, owner.tenantId, (db) =>
          assertTenantWritable(db, owner.tenantId)
        );
      }
      req.knowledgeOwner = owner;
      runtime.observe(owner);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get('/status', async (req, res) => res.json(await runtime.status(ownerOf(req))));
  router.get('/overview', async (req, res) =>
    res.json(await runtime.library.overview(ownerOf(req)))
  );
  router.get('/entries', async (req, res) => {
    res.json(
      await runtime.library.list(ownerOf(req), {
        query: scalar(req.query.query),
        source: sourceFilter(req.query.source),
        kind: choice<KnowledgeKind>(
          req.query.kind,
          ['conversation', 'document', 'note'],
          '资料类型'
        ),
        materialType: choice<KnowledgeMaterialType>(
          req.query.materialType,
          ['conversation', 'image', 'document', 'file', 'note'],
          '文件类型'
        ),
        level: choice(req.query.level, ['source', 'summary', 'knowledge'] as const, '知识层级'),
        topic: scalar(req.query.topic),
        reviewState: choice(req.query.reviewState, ['draft', 'reviewed'] as const, '确认状态'),
        includeHistory: req.query.includeHistory === 'true',
        offset: numberField(req.query.offset, 0, Number.MAX_SAFE_INTEGER),
        limit: Math.max(1, numberField(req.query.limit, 40, 100)),
      })
    );
  });
  router.post('/search', async (req, res) => {
    const entryIds = req.body?.entryIds;
    if (
      entryIds !== undefined &&
      (!Array.isArray(entryIds) || entryIds.some((id: unknown) => typeof id !== 'string'))
    ) {
      throw Object.assign(new Error('资料范围无效'), { status: 400 });
    }
    res.json(
      await runtime.search(ownerOf(req), {
        query: textField(req.body?.query, '查询'),
        source: sourceFilter(req.body?.source),
        entryIds,
        limit: numberField(req.body?.limit, 8, 20),
      })
    );
  });
  router.get('/entries/:id', async (req, res) => {
    const detail = await runtime.library.get(ownerOf(req), String(req.params.id));
    if (!detail) throw missing();
    res.json(detail);
  });
  router.post('/entries', async (req, res) => {
    const title = textField(req.body?.title, '标题').trim();
    if (!title) throw Object.assign(new Error('请输入标题'), { status: 400 });
    res.status(201).json(
      await runtime.library.upsertSource(ownerOf(req), {
        source: 'manual',
        sourceId: randomUUID(),
        kind: 'note',
        title,
        markdown: textField(req.body?.markdown, '正文'),
        organization: grouping(req.body?.organization) ?? {
          topic: '未分类',
          level: 'knowledge',
          state: 'reviewed',
        },
      })
    );
  });
  router.patch('/entries/:id', async (req, res) => {
    const current = await runtime.library.get(ownerOf(req), String(req.params.id));
    if (!current) throw missing();
    const group = grouping(req.body?.organization);
    const detail = await runtime.library.edit(
      ownerOf(req),
      String(req.params.id),
      textField(req.body?.markdown, '正文'),
      scalar(req.body?.expectedUpdatedAt),
      scalar(req.body?.title),
      group
        ? {
            ...current.entry.organization,
            ...group,
            sourceEntryIds: current.entry.organization?.sourceEntryIds,
          }
        : undefined
    );
    if (!detail) throw missing();
    res.json(await runtime.library.get(ownerOf(req), detail.entry.id));
  });
  router.post('/organize', async (req, res) => {
    const ids = req.body?.entryIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      throw Object.assign(new Error('请选择要整理的资料'), { status: 400 });
    const mode = choice(req.body?.mode, ['manual', 'automatic'] as const, '整理方式');
    if (!mode) throw Object.assign(new Error('请选择整理方式'), { status: 400 });
    res.status(201).json(
      await runtime.organize(ownerOf(req), {
        entryIds: ids,
        title: scalar(req.body?.title),
        topic: scalar(req.body?.topic),
        mode,
      })
    );
  });
  router.delete('/entries/:id', async (req, res) => {
    if (!(await runtime.remove(ownerOf(req), String(req.params.id)))) throw missing();
    res.json({ deleted: true });
  });
  router.get('/entries/:id/attachments/:attachmentId/content', async (req, res) => {
    const result = await runtime.library.openAttachment(
      ownerOf(req),
      String(req.params.id),
      String(req.params.attachmentId)
    );
    if (!result) throw missing();
    res.setHeader('Content-Type', result.attachment.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(result.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.name)}`
    );
    res.once('close', () => result.body.destroy());
    result.body.on('error', () => res.destroy());
    result.body.pipe(res);
  });

  const upload = multer({
    storage: {
      _handleFile(req, file, callback) {
        const owner = ownerOf(req);
        void (async () => {
          const title = Buffer.from(file.originalname, 'latin1').toString('utf8');
          const detail = await runtime.library.upsertSource(owner, {
            source: 'manual',
            sourceId: randomUUID(),
            kind: 'document',
            title,
            markdown: `# ${title}\n\n原文件已归档，正在解析正文。`,
          });
          if (!detail) throw missing();
          await runtime.library.putAttachment(owner, detail.entry.id, {
            name: title,
            stream: file.stream,
            mimeType: file.mimetype,
          });
          callback(null, { knowledgeEntryId: detail.entry.id } as Partial<Express.Multer.File>);
        })().catch((error) => callback(error as Error));
      },
      _removeFile(_req, _file, callback) {
        callback(null);
      },
    },
  });
  router.post('/documents', upload.single('file'), async (req, res) => {
    const id = (req.file as (Express.Multer.File & { knowledgeEntryId?: string }) | undefined)
      ?.knowledgeEntryId;
    if (!id) throw Object.assign(new Error('请选择文件'), { status: 400 });
    const owner = ownerOf(req);
    const result = await extractKnowledgeDocument(
      runtime.library,
      owner,
      id,
      runtime.settings.documents
    );
    const detail = result.detail ?? (await runtime.library.get(owner, id));
    res
      .status(201)
      .json({ ...detail, parsing: { status: result.status, message: result.message } });
  });

  router.get('/export', async (req, res) => {
    const owner = ownerOf(req);
    const controller = new AbortController();
    const archive = archiver('zip', { zlib: { level: 4 }, forceZip64: true });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="disco-knowledge-${new Date().toISOString().slice(0, 10)}.zip"`
    );
    res.once('close', () => {
      controller.abort();
      archive.abort();
    });
    archive.on('error', () => {
      controller.abort();
      res.destroy();
    });
    archive.pipe(res);
    try {
      for await (const file of runtime.library.exportFiles(owner, controller.signal)) {
        archive.append(file.body, { name: file.path });
      }
      await archive.finalize();
    } catch {
      controller.abort();
      archive.abort();
      res.destroy();
    }
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      error instanceof KnowledgeConflictError
        ? 409
        : ((error as { status?: number }).status ?? 500);
    res.status(status).json({
      message:
        status < 500 && error instanceof Error ? error.message : '知识库暂时不可用，请稍后重试',
    });
  });
  // Feathers exposes the underlying Express middleware registration at runtime.
  (input.app as unknown as { use(path: string, handler: RequestHandler): void }).use(
    '/knowledge',
    router
  );
  return runtime;
}
