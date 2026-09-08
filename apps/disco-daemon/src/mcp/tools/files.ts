import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  classifyPublishedFileDisplayType,
  inferPublishedFileMimeType,
  isPathInsideDiscoUserWorkspace,
  resolveDiscoUserWorkspaceRoot,
  UPLOAD_VIRTUAL_URL_PREFIX,
} from '@disco/core';
import { UploadRepository } from '@disco/core/db';
import type {
  DiscoFilePublication,
  TenantID,
  Upload,
  UploadOwner,
  UploadPromptAttachment,
} from '@disco/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getUploadStagingStore } from '../../utils/upload-staging.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

const publicationInFlight = new Map<string, Promise<UploadPromptAttachment>>();

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function assertNotAnotherDiscoUser(userRoot: string, candidate: string): void {
  if (isPathInsideDiscoUserWorkspace(userRoot, candidate)) return;
  const usersRoot = dirname(userRoot);
  const rel = relative(usersRoot, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  const firstSegment = rel.split(sep)[0] ?? '';
  if (/^user-[a-z0-9_-]+$/iu.test(firstSegment)) {
    throw new Error('该文件属于其他 Disco 用户，未发布');
  }
}

export async function resolveFileForPublication(input: {
  workingDirectory: string;
  requestedPath: string;
}): Promise<{ absolutePath: string; userRoot: string }> {
  const userRoot = resolveDiscoUserWorkspaceRoot(input.workingDirectory);
  if (!userRoot) throw new Error('当前会话没有有效的 Disco 用户工作区');
  const candidate = isAbsolute(input.requestedPath)
    ? resolve(input.requestedPath)
    : resolve(input.workingDirectory, input.requestedPath);
  let absolutePath: string;
  try {
    absolutePath = await realpath(candidate);
  } catch {
    throw new Error(`找不到要发布的文件：${input.requestedPath}`);
  }
  assertNotAnotherDiscoUser(userRoot, absolutePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error(`只能发布普通文件：${input.requestedPath}`);
  return { absolutePath, userRoot };
}

interface FileToolDependencies {
  store?: ReturnType<typeof getUploadStagingStore>;
  repository?: Pick<UploadRepository, 'findActiveByChecksum'>;
  withinTenant?: <T>(tenantId: TenantID, work: () => Promise<T>) => Promise<T>;
}

function asAttachment(upload: Upload): UploadPromptAttachment {
  return {
    ref: upload.ref,
    filename: upload.displayName,
    mimeType: upload.mimeType,
    size: upload.size,
  };
}

export function registerFileTools(
  server: McpServer,
  ctx: McpContext,
  dependencies: FileToolDependencies = {}
): void {
  server.registerTool(
    'disco_files_publish',
    {
      description:
        'Publish files that already exist on disk to the current Disco conversation. A filename mentioned in prose is not delivered until this operation succeeds. Supports images, PDF, audio, video, code, documents, archives, and other ordinary files.',
      annotations: { destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe(
                  'Absolute path, or a path relative to the current conversation workspace'
                ),
            })
          )
          .min(1)
          .max(20),
      }),
    },
    async args => {
      const session = ctx.authenticatedSession;
      const tenantId = ctx.baseServiceParams.tenant?.tenant_id;
      if (!session || !ctx.sessionId || !tenantId) {
        throw new Error('发布文件需要当前 Disco 会话和用户上下文');
      }
      const sessionId = ctx.sessionId;
      if (!session.working_directory) throw new Error('当前会话没有有效的工作目录');
      const owner: UploadOwner = {
        tenantId,
        sessionId,
        createdBy: ctx.userId,
        agentId: session.agent_id ?? null,
      };
      const store = dependencies.store ?? getUploadStagingStore();
      const withinTenant =
        dependencies.withinTenant ??
        (<T>(_resolvedTenantId: TenantID, work: () => Promise<T>) =>
          runWithMcpTenantDatabaseScope(ctx, () => work()));

      const published: UploadPromptAttachment[] = [];
      for (const requested of args.files) {
        const { absolutePath } = await resolveFileForPublication({
          workingDirectory: session.working_directory,
          requestedPath: requested.path,
        });
        const fileStat = await stat(absolutePath);
        const checksum = await sha256(absolutePath);
        const lockKey = `${tenantId}:${sessionId}:${checksum}`;
        let pending = publicationInFlight.get(lockKey);
        if (!pending) {
          pending = (async () => {
            const existing = dependencies.repository
              ? await withinTenant(tenantId, () =>
                  dependencies.repository!.findActiveByChecksum(tenantId, owner, checksum)
                )
              : await runWithMcpTenantDatabaseScope(ctx, db =>
                  new UploadRepository(db).findActiveByChecksum(tenantId, owner, checksum)
                );
            if (existing) return asAttachment(existing);
            const metadata = await store.stage({
              owner,
              name: absolutePath.split(/[\\/]/).at(-1) ?? 'file',
              mimeType: inferPublishedFileMimeType(absolutePath),
              provenance: 'browser',
              body: createReadStream(absolutePath),
              sizeHint: fileStat.size,
              checksum,
              ttlMs: 0,
            });
            return {
              ref: metadata.ref,
              filename: metadata.name,
              mimeType: metadata.mimeType,
              size: metadata.size,
            };
          })().finally(() => publicationInFlight.delete(lockKey));
          publicationInFlight.set(lockKey, pending);
        }
        published.push(await pending);
      }

      const publication: DiscoFilePublication = {
        type: 'disco_file_publication',
        published: true,
        sessionId,
        userId: ctx.userId,
        files: published.map(file => ({
          ...file,
          fileId: file.ref,
          sessionId,
          userId: ctx.userId,
          displayType: classifyPublishedFileDisplayType(file.mimeType),
          storage: {
            kind: 'disco-upload',
            ref: file.ref,
            url: `${UPLOAD_VIRTUAL_URL_PREFIX}${file.ref}`,
          },
        })),
      };
      const result = {
        ...publication,
        instruction: '这些文件已经交付；在最终回复中简要说明即可，不要声称未发布的文件已经发送。',
      };
      return {
        ...textResult(result),
        structuredContent: result,
      };
    }
  );
}
