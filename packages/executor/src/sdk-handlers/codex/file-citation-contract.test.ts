import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SessionID } from '@disco/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexFileCitationStreamFilter,
  resolveCodexFileCitations,
} from './file-citation-contract.js';

const cleanupPaths: string[] = [];
const sessionId = '01a05700-0881-723d-bfd1-a75a00000000' as SessionID;
const uploadRef = 'upl_00000000-0000-4000-8000-000000000001';

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((candidate) => rm(candidate, { recursive: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'disco-file-citation-'));
  cleanupPaths.push(root);
  return root;
}

function directive(filePath: string, purpose: 'source' | 'output'): string {
  const escaped = filePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `:codex-file-citation{path="${escaped}" purpose="${purpose}"}`;
}

function visualizationDirective(filePath: string, title = '路线图'): string {
  return `visualize${JSON.stringify({ path: filePath, title, mode: 'wide' })}`;
}

function publicationPayload(file: {
  ref: string;
  filename: string;
  mimeType: string;
  size: number;
}) {
  return {
    type: 'disco_file_publication',
    published: true,
    sessionId,
    userId: 'user-1',
    files: [file],
  };
}

describe('Codex file citation resolution', () => {
  it('reuses the current session staged upload without publishing it again', async () => {
    const root = await workspace();
    const staged = path.join(root, '.disco', 'session-staging', sessionId, uploadRef, '资料.pdf');
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(staged, 'source');
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await resolveCodexFileCitations({
      text: `参考 ${directive(staged, 'source')} 第四页。`,
      workingDirectory: root,
      sessionId,
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: 'token',
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.publicationToolUses).toEqual([]);
    expect(result.citations).toEqual([
      expect.objectContaining({
        filename: '资料.pdf',
        purpose: 'source',
        upload_ref: uploadRef,
        mime_type: 'application/pdf',
        size: 6,
        available: true,
      }),
    ]);
    expect(result.text).toBe('参考 资料.pdf 第四页。');
    expect(result.text).not.toContain(root);
    expect(result.content).toEqual([
      { type: 'text', text: '参考 ' },
      expect.objectContaining({
        type: 'file_citation',
        filename: '资料.pdf',
        upload_ref: uploadRef,
      }),
      { type: 'text', text: ' 第四页。' },
    ]);
  });

  it('publishes output citations through the authenticated Disco method', async () => {
    const root = await workspace();
    const output = path.join(root, 'report.pdf');
    await writeFile(output, 'result');
    const payload = publicationPayload({
      ref: uploadRef,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 6,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'disco-auto-publish-1',
          result: { structuredContent: payload },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await resolveCodexFileCitations({
      text: `已创建 ${directive(output, 'output')}。`,
      workingDirectory: root,
      sessionId,
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: 'token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.publicationToolUses[0]).toMatchObject({
      name: 'disco.disco_files_publish',
      status: 'completed',
      input: { files: [{ path: output }], automatic: true },
    });
    expect(result.citations).toEqual([
      expect.objectContaining({
        filename: 'report.pdf',
        purpose: 'output',
        upload_ref: uploadRef,
        available: true,
      }),
    ]);
    expect(result.text).toBe('已创建 report.pdf。');
    expect(result.content).toEqual([
      { type: 'text', text: '已创建 ' },
      expect.objectContaining({
        type: 'file_citation',
        filename: 'report.pdf',
        purpose: 'output',
      }),
      { type: 'text', text: '。' },
    ]);
  });

  it('does not publish a path twice when the Agent already published it', async () => {
    const root = await workspace();
    const output = path.join(root, 'report.pdf');
    await writeFile(output, 'result');
    const payload = publicationPayload({
      ref: uploadRef,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 6,
    });
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await resolveCodexFileCitations({
      text: directive(output, 'output'),
      workingDirectory: root,
      sessionId,
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: 'token',
      fetchImpl,
      priorToolUses: [
        {
          id: 'published',
          name: 'disco.disco_files_publish',
          input: { files: [{ path: output }] },
          output: JSON.stringify(payload),
          status: 'completed',
        },
      ],
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.publicationToolUses).toEqual([]);
    expect(result.citations[0]).toMatchObject({ upload_ref: uploadRef, available: true });
  });

  it('keeps a safe unavailable card when publication is rejected and deduplicates cards', async () => {
    const root = await workspace();
    const inaccessible = path.join(root, '..', 'user-other', 'private.pdf');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('denied', { status: 403 }));
    const token = directive(inaccessible, 'source');

    const result = await resolveCodexFileCitations({
      text: `${token}\n${token}`,
      workingDirectory: root,
      sessionId,
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: 'token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.citations).toEqual([
      expect.objectContaining({
        filename: 'private.pdf',
        purpose: 'source',
        available: false,
        unavailable_reason: '文件未能发布',
      }),
    ]);
    expect(result.text).toBe('private.pdf\nprivate.pdf');
    expect(result.text).not.toContain('user-other');
  });

  it('publishes a visualization and persists it at the exact reference position', async () => {
    const root = await workspace();
    const output = path.join(root, 'route-map.html');
    await writeFile(output, '<main>route</main>');
    const payload = publicationPayload({
      ref: uploadRef,
      filename: 'route-map.html',
      mimeType: 'text/html',
      size: 18,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'disco-auto-publish-1',
          result: { structuredContent: payload },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await resolveCodexFileCitations({
      text: `开始 ${visualizationDirective(output, '湖滨 5K')} 结束`,
      workingDirectory: root,
      sessionId,
      daemonUrl: 'http://127.0.0.1:3030',
      sessionToken: 'token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.text).toBe('开始 湖滨 5K 结束');
    expect(result.text).not.toContain('visualize');
    expect(result.content).toEqual([
      { type: 'text', text: '开始 ' },
      expect.objectContaining({
        type: 'file_citation',
        filename: 'route-map.html',
        mime_type: 'text/html',
        upload_ref: uploadRef,
        presentation: { type: 'visualization', mode: 'wide', title: '湖滨 5K' },
        available: true,
      }),
      { type: 'text', text: ' 结束' },
    ]);
  });
});

describe('Codex file citation stream filter', () => {
  it('hides a directive split across stream chunks while preserving prose', () => {
    const filter = new CodexFileCitationStreamFilter();

    expect(filter.push('已创建 :codex-file-ci')).toBe('已创建 ');
    expect(filter.push('tation{path="E:/out/report.pdf" purpose="out')).toBe('');
    expect(filter.push('put"}，请查收。')).toBe('，请查收。');
  });

  it('hides a visualize directive split across stream chunks while preserving prose', () => {
    const filter = new CodexFileCitationStreamFilter();

    expect(filter.push('路线：visua')).toBe('路线：');
    expect(filter.push('lize{"path":"E:/out/route.html",')).toBe('');
    expect(filter.push('"title":"路线图"} 完成。')).toBe(' 完成。');
  });
});
