import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UploadRef } from '@disco/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../server.js';
import { registerFileTools } from './files.js';

type ToolHandler = (args: { files: Array<{ path: string }> }) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function captureHandler(ctx: McpContext, dependencies: Parameters<typeof registerFileTools>[2]) {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: ToolHandler) {
      if (name === 'disco_files_publish') handler = callback;
    },
  } as unknown as McpServer;
  registerFileTools(server, ctx, dependencies);
  if (!handler) throw new Error('disco_files_publish was not registered');
  return handler;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'disco-publish-'));
  roots.push(root);
  const usersRoot = join(root, 'worktrees');
  const userRoot = join(usersRoot, 'user-one');
  const standaloneRoot = join(userRoot, 'standalone');
  const sessionPath = join(standaloneRoot, 'session-one');
  await mkdir(sessionPath, { recursive: true });
  const ctx = {
    app: {},
    db: {},
    userId: 'user-one',
    sessionId: 'session-one',
    authenticatedSession: {
      session_id: 'session-one',
      agentic_tool: 'codex',
      agent_id: null,
      working_directory: sessionPath,
    },
    authenticatedUser: { user_id: 'user-one', username: 'one', role: 'member' },
    baseServiceParams: {
      authenticated: true,
      provider: 'mcp',
      tenant: { tenant_id: 'tenant-one', source: 'auth_claim' },
      user: { user_id: 'user-one', username: 'one', role: 'member' },
    },
  } as unknown as McpContext;
  return { root, usersRoot, userRoot, standaloneRoot, sessionPath, ctx };
}

describe('Disco explicit file publication', () => {
  it('publishes a real session-relative file and preserves a Chinese filename', async () => {
    const f = await fixture();
    await writeFile(join(f.sessionPath, '报告.txt'), 'hello');
    const stage = vi.fn(async (input: { name: string; checksum?: string }) => ({
      ref: 'upl_00000000-0000-4000-8000-000000000101' as UploadRef,
      name: input.name,
      mimeType: 'text/plain',
      size: 5,
      checksum: input.checksum,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      provenance: 'browser' as const,
    }));
    const handler = captureHandler(f.ctx, {
      store: { stage } as never,
      repository: { findActiveByChecksum: vi.fn(async () => null) },
      withinTenant: async (_tenant, work) => work(),
    });

    const result = JSON.parse((await handler({ files: [{ path: '报告.txt' }] })).content[0]!.text);

    expect(result).toMatchObject({
      type: 'disco_file_publication',
      published: true,
      sessionId: 'session-one',
      userId: 'user-one',
      files: [
        {
          fileId: 'upl_00000000-0000-4000-8000-000000000101',
          sessionId: 'session-one',
          userId: 'user-one',
          filename: '报告.txt',
          mimeType: 'text/plain',
          size: 5,
          displayType: 'file',
          storage: {
            kind: 'disco-upload',
            ref: 'upl_00000000-0000-4000-8000-000000000101',
            url: 'https://disco.live/_uploads/upl_00000000-0000-4000-8000-000000000101',
          },
        },
      ],
    });
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '报告.txt',
        sizeHint: 5,
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        ttlMs: 0,
      })
    );
  });

  it('returns one normalized result model for image, PDF, audio, video, and files', async () => {
    const f = await fixture();
    const inputs = [
      ['preview.png', 'image'],
      ['document.pdf', 'pdf'],
      ['voice.mp3', 'audio'],
      ['clip.mp4', 'video'],
      ['archive.zip', 'file'],
    ] as const;
    for (const [index, [filename]] of inputs.entries()) {
      await writeFile(join(f.sessionPath, filename), `bytes-${index}`);
    }
    let nextRef = 200;
    const stage = vi.fn(
      async (input: { name: string; mimeType: string; sizeHint?: number; checksum?: string }) => ({
        ref: `upl_00000000-0000-4000-8000-000000000${nextRef++}` as UploadRef,
        name: input.name,
        mimeType: input.mimeType,
        size: input.sizeHint ?? 0,
        checksum: input.checksum,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        provenance: 'browser' as const,
      })
    );
    const handler = captureHandler(f.ctx, {
      store: { stage } as never,
      repository: { findActiveByChecksum: vi.fn(async () => null) },
      withinTenant: async (_tenant, work) => work(),
    });

    const response = await handler({ files: inputs.map(([path]) => ({ path })) });
    const result = JSON.parse(response.content[0]!.text);

    expect(result.files.map((file: { displayType: string }) => file.displayType)).toEqual(
      inputs.map(([, displayType]) => displayType)
    );
    expect(response.structuredContent).toEqual(result);
    expect(
      result.files.every(
        (file: Record<string, unknown>) =>
          file.fileId && file.sessionId === 'session-one' && file.userId === 'user-one'
      )
    ).toBe(true);
    expect(stage).toHaveBeenCalledTimes(5);
  });

  it('coalesces concurrent publication of identical bytes', async () => {
    const f = await fixture();
    await writeFile(join(f.sessionPath, 'same.bin'), 'same bytes');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stage = vi.fn(async () => {
      await waiting;
      return {
        ref: 'upl_00000000-0000-4000-8000-000000000102' as UploadRef,
        name: 'same.bin',
        mimeType: 'application/octet-stream',
        size: 10,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        provenance: 'browser' as const,
      };
    });
    const handler = captureHandler(f.ctx, {
      store: { stage } as never,
      repository: { findActiveByChecksum: vi.fn(async () => null) },
      withinTenant: async (_tenant, work) => work(),
    });

    const first = handler({ files: [{ path: 'same.bin' }] });
    const second = handler({ files: [{ path: 'same.bin' }] });
    await vi.waitFor(() => expect(stage).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(stage).toHaveBeenCalledOnce();
  });

  it('rejects files under another Disco user directory', async () => {
    const f = await fixture();
    const other = join(f.usersRoot, 'user-two', 'standalone', 'session-two');
    await mkdir(other, { recursive: true });
    const forbidden = join(other, 'secret.txt');
    await writeFile(forbidden, 'secret');
    const stage = vi.fn();
    const handler = captureHandler(f.ctx, {
      store: { stage } as never,
      repository: { findActiveByChecksum: vi.fn(async () => null) },
      withinTenant: async (_tenant, work) => work(),
    });

    await expect(handler({ files: [{ path: forbidden }] })).rejects.toThrow(
      '该文件属于其他 Disco 用户，未发布'
    );
    expect(stage).not.toHaveBeenCalled();
  });

  it('allows files from another Session or Agent directory owned by the same user', async () => {
    const f = await fixture();
    const siblingSession = join(f.userRoot, 'agents', 'agent-two', 'sessions', 'session-two');
    await mkdir(siblingSession, { recursive: true });
    const siblingFile = join(siblingSession, 'shared-context.txt');
    await writeFile(siblingFile, 'same user');
    const stage = vi.fn(async (input: { name: string; sizeHint?: number }) => ({
      ref: 'upl_00000000-0000-4000-8000-000000000301' as UploadRef,
      name: input.name,
      mimeType: 'text/plain',
      size: input.sizeHint ?? 0,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      provenance: 'browser' as const,
    }));
    const handler = captureHandler(f.ctx, {
      store: { stage } as never,
      repository: { findActiveByChecksum: vi.fn(async () => null) },
      withinTenant: async (_tenant, work) => work(),
    });

    const result = JSON.parse((await handler({ files: [{ path: siblingFile }] })).content[0]!.text);

    expect(result.files[0]).toMatchObject({
      filename: 'shared-context.txt',
      sessionId: 'session-one',
      userId: 'user-one',
    });
    expect(stage).toHaveBeenCalledOnce();
  });

  it('allows an ordinary local file outside the Disco user directory tree', async () => {
    const f = await fixture();
    const ordinaryDirectory = join(f.root, 'family-project');
    await mkdir(ordinaryDirectory, { recursive: true });
    const ordinaryFile = join(ordinaryDirectory, 'result.txt');
    await writeFile(ordinaryFile, 'ordinary local file');
    const stage = vi.fn(async (input: { name: string; sizeHint?: number }) => ({
      ref: 'upl_00000000-0000-4000-8000-000000000302' as UploadRef,
      name: input.name,
      mimeType: 'text/plain',
      size: input.sizeHint ?? 0,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      provenance: 'browser' as const,
    }));
    const handler = captureHandler(f.ctx, {
      store: { stage } as never,
      repository: { findActiveByChecksum: vi.fn(async () => null) },
      withinTenant: async (_tenant, work) => work(),
    });

    await expect(handler({ files: [{ path: ordinaryFile }] })).resolves.toBeDefined();
    expect(stage).toHaveBeenCalledOnce();
  });

  it('does not create an attachment for a missing file', async () => {
    const f = await fixture();
    const stage = vi.fn();
    const handler = captureHandler(f.ctx, {
      store: { stage } as never,
      repository: { findActiveByChecksum: vi.fn(async () => null) },
      withinTenant: async (_tenant, work) => work(),
    });

    await expect(handler({ files: [{ path: 'missing.pdf' }] })).rejects.toThrow(
      '找不到要发布的文件'
    );
    expect(stage).not.toHaveBeenCalled();
  });
});
