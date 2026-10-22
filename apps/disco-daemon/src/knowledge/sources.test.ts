import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Message } from '@disco/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareHostRolloutSource,
  discoConversationSource,
  hostAttachmentProvenance,
  hostAttachmentReferences,
  hostRolloutFiles,
  hostRolloutIdentity,
  readHostRollout,
  resolveHostAttachment,
  safeHostAttachment,
} from './sources';

describe('knowledge source archives', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'disco-kb-sources-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('preserves Disco line breaks, a long conversation and complete structured tool records', () => {
    const longText = '第一行\n\n第二行🙂\n'.repeat(50_000);
    const messages = [
      {
        message_id: 'message-a',
        session_id: 'session-a',
        index: 1,
        role: 'user',
        timestamp: '2026-10-22T01:00:00Z',
        content: longText,
        metadata: { custom: '保留' },
      },
      {
        message_id: 'message-b',
        session_id: 'session-a',
        index: 2,
        role: 'assistant',
        timestamp: '2026-10-22T01:00:01Z',
        content: [{ type: 'text', text: '完整回答\n第三行' }],
        tool_uses: [
          { id: 'tool-a', name: 'exec', input: { command: '计算' }, output: { rows: [1, 2, 3] } },
        ],
      },
    ] as unknown as Message[];
    const source = discoConversationSource({
      id: 'session-a',
      title: '来源测试',
      updatedAt: '2026-10-22T01:00:02Z',
      messages,
    });
    expect(source.markdown).toContain(longText);
    expect(source.markdown).toContain('完整回答\n第三行');
    expect(
      source
        .rawContent!.trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual(messages);
    expect(Buffer.byteLength(source.rawContent!)).toBeGreaterThan(800_000);
    expect(source.sourceUrl).toBe('/s/session-a/');
  });

  it('reads canonical Codex messages once while retaining all duplicate events and tools in original JSONL', async () => {
    const rows = [
      { type: 'session_meta', payload: { id: 'host-session-a' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '重复事件不重复显示' } },
      {
        type: 'response_item',
        timestamp: '2026-10-22T01:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '第一行\n第二行' }],
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"status"}' },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', output: '工具原始内容'.repeat(100_000) },
      },
      {
        type: 'response_item',
        timestamp: '2026-10-22T01:00:01Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '答案\n尾部' }],
        },
      },
    ];
    const raw = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    const path = join(root, 'rollout.jsonl');
    await writeFile(path, raw);
    const source = await readHostRollout(path);
    expect(await hostRolloutIdentity(path)).toBe('host-session-a');
    expect(source?.rawContent).toBe(raw);
    expect(source?.markdown).toContain('第一行\n第二行');
    expect(source?.markdown).toContain('答案\n尾部');
    expect(source?.markdown).not.toContain('重复事件不重复显示');
    expect(source?.sourceId).toBe('host-session-a');
    expect(source?.kind).toBe('conversation');
  });

  it('includes archived rollouts without scanning config trees or linked directories', async () => {
    const sessionDir = join(root, 'sessions', '2026', '10');
    const archivedDir = join(root, 'archived_sessions');
    const privateDir = join(root, 'private');
    await Promise.all(
      [sessionDir, archivedDir, privateDir].map((path) => mkdir(path, { recursive: true }))
    );
    const active = join(sessionDir, 'active.jsonl');
    const archived = join(archivedDir, 'archived.jsonl');
    await Promise.all(
      [active, archived, join(privateDir, 'credentials.jsonl')].map((path) => writeFile(path, '{}'))
    );
    await writeFile(join(sessionDir, 'auth.json'), '{}');
    await symlink(
      privateDir,
      join(sessionDir, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const paths: string[] = [];
    for await (const path of hostRolloutFiles(root)) paths.push(path);
    expect(paths.sort()).toEqual([active, archived].sort());
  });

  it('allows only canonical attachments under explicitly configured roots and rejects junction escapes', async () => {
    const attachments = join(root, 'attachments');
    const sibling = join(root, 'attachments-other');
    await Promise.all([attachments, sibling].map((path) => mkdir(path)));
    const allowed = join(attachments, '原始资料.txt');
    const denied = join(sibling, 'secret.txt');
    await writeFile(allowed, 'preserve');
    await writeFile(denied, 'private');
    await symlink(
      sibling,
      join(attachments, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    expect(await safeHostAttachment(allowed, [attachments])).toBe(await realpath(allowed));
    expect(await safeHostAttachment(denied, [attachments])).toBeNull();
    expect(
      await safeHostAttachment(join(attachments, '..', 'attachments-other', 'secret.txt'), [
        attachments,
      ])
    ).toBeNull();
    expect(
      await safeHostAttachment(join(attachments, 'escape', 'secret.txt'), [attachments])
    ).toBeNull();
    expect(await safeHostAttachment(attachments, [attachments])).toBeNull();
    expect(await safeHostAttachment(resolve(attachments, 'missing.txt'), [attachments])).toBeNull();
    expect(await readFile(denied, 'utf8')).toBe('private');
  });

  it('collects attachment references from messages without treating command outputs as authorized file paths', () => {
    const attachment = 'C:\\Users\\person\\.codex\\attachments\\123\\photo.png';
    const raw = [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'local_image', path: attachment },
            { type: 'input_text', text: `附件：${attachment}\n` },
          ],
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', output: 'C:\\private\\credentials.json' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    expect(hostAttachmentReferences(raw)).toEqual([attachment]);
  });

  it('uses transcript event times and append proofs rather than copied-file mtime for incrementality', async () => {
    const first = `${JSON.stringify({ type: 'session_meta', timestamp: '2026-09-01T01:00:00Z', payload: { id: 'versioned' } })}\n${JSON.stringify({ type: 'response_item', timestamp: '2026-09-01T01:00:01Z', payload: { type: 'message', role: 'user', content: 'old body' } })}\n`;
    const tail = `${JSON.stringify({ type: 'response_item', timestamp: '2026-09-01T01:00:02Z', payload: { type: 'message', role: 'assistant', content: 'new final answer' } })}\n`;
    const oldPath = join(root, 'old-copy.jsonl');
    const newPath = join(root, 'new-original.jsonl');
    await writeFile(oldPath, first);
    await writeFile(newPath, first + tail);
    await utimes(oldPath, new Date('2030-01-01'), new Date('2030-01-01'));
    const old = (await readHostRollout(oldPath))!;
    const current = (await readHostRollout(newPath))!;
    expect(old.sourceUpdatedAt).toBe('2026-09-01T01:00:01.000Z');
    expect(current.sourceUpdatedAt).toBe('2026-09-01T01:00:02.000Z');
    expect(compareHostRolloutSource(old, current)).toBe('older');
    expect(compareHostRolloutSource(current, old)).toBe('newer');
    await utimes(newPath, new Date('2031-01-01'), new Date('2031-01-01'));
    expect(compareHostRolloutSource((await readHostRollout(newPath))!, current)).toBe('same');
    await writeFile(newPath, first.replace('old body', 'divergent old body') + tail);
    expect(compareHostRolloutSource((await readHostRollout(newPath))!, current)).toBe('conflict');
  });

  it('retains incomplete source bytes and records integrity while a completed tail becomes a newer version', async () => {
    const path = join(root, 'incomplete.jsonl');
    const prefix = `${JSON.stringify({ type: 'session_meta', payload: { id: 'incomplete', cwd: root } })}\n`;
    await writeFile(path, `${prefix}{"type":"event_msg","payload":`);
    const partial = (await readHostRollout(path))!;
    expect(partial.rawContent).toBe(`${prefix}{"type":"event_msg","payload":`);
    expect(partial.sourceVersion).toMatchObject({
      complete: false,
      malformedRecords: 1,
      recordCount: 1,
    });
    expect(partial.sourceUpdatedAt).toBe('1970-01-01T00:00:00.000Z');
    await writeFile(path, `${partial.rawContent}{"type":"agent_message","message":"completed"}}\n`);
    const complete = (await readHostRollout(path))!;
    expect(complete.sourceVersion).toMatchObject({
      complete: true,
      malformedRecords: 0,
      recordCount: 2,
    });
    expect(compareHostRolloutSource(complete, partial)).toBe('newer');
    expect(complete.sessionCwd).toBe(root);
    expect(complete.sessionCwds).toEqual([root]);
  });

  it('collects delivered assistant Markdown files and per-message cwd without harvesting tool output or code examples', async () => {
    const firstCwd = join(root, 'first');
    const secondCwd = join(root, 'second');
    const absolute = join(firstCwd, 'report (final).pdf');
    const encoded = `${firstCwd.replaceAll('\\', '/')}/file%20name.txt`;
    const raw = [
      { type: 'session_meta', payload: { id: 'links', cwd: firstCwd } },
      {
        type: 'response_item',
        timestamp: '2026-10-22T01:00:00Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: `[交付](<${absolute}>)\n![图片](images/photo.png)\n[另一个文件](${encoded}:12)\n[File URL](${pathToFileURL(join(firstCwd, 'file-url.txt')).href})\n[外部链接](https://example.com/private.txt)\n[示例](data:text/plain,secret)\n\`[代码示例](not-a-delivery.txt)\`\n\`\`\`md\n[示例](not-a-delivery-2.txt)\n\`\`\``,
            },
          ],
        },
      },
      { type: 'turn_context', payload: { cwd: secondCwd } },
      {
        type: 'event_msg',
        timestamp: '2026-10-22T01:00:01Z',
        payload: { type: 'agent_message', message: '[最终文件](results/final.csv)' },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', output: '[命令输出链接](private.env)' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    const refs = hostAttachmentReferences(raw);
    expect(refs).toContain(absolute);
    expect(refs).toContain('images/photo.png');
    expect(refs).toContain(`${firstCwd.replaceAll('\\', '/')}/file name.txt`);
    expect(refs).toContain(join(firstCwd, 'file-url.txt'));
    expect(refs).toContain('results/final.csv');
    expect(refs.some((item) => /example|secret|not-a-delivery|private.env/.test(item))).toBe(false);
    const provenance = hostAttachmentProvenance(raw);
    expect(provenance.find((item) => item.reference === 'images/photo.png')).toMatchObject({
      cwd: firstCwd,
      role: 'assistant',
      sourceLine: 2,
    });
    expect(provenance.find((item) => item.reference === 'results/final.csv')).toMatchObject({
      cwd: secondCwd,
      sourceTimestamp: '2026-10-22T01:00:01.000Z',
    });
  });

  it('resolves only explicit visible references under approved roots and keeps missing provenance', async () => {
    const allowed = join(root, 'project');
    await mkdir(allowed);
    await writeFile(join(allowed, 'deliverable.txt'), 'delivered');
    await writeFile(join(root, 'private.txt'), 'not delivered');
    const reference = {
      reference: 'deliverable.txt',
      role: 'assistant' as const,
      origin: 'markdown-link' as const,
      sourceLine: 8,
      cwd: allowed,
    };
    expect(await resolveHostAttachment(reference, [allowed], allowed)).toMatchObject({
      ...reference,
      status: 'available',
      path: await realpath(join(allowed, 'deliverable.txt')),
    });
    // A cwd in transcript metadata is not authorization unless the runtime passes it explicitly.
    expect((await resolveHostAttachment(reference, [allowed])).status).toBe('unresolved');
    expect(
      (
        await resolveHostAttachment(
          { ...reference, reference: '../private.txt' },
          [allowed],
          allowed
        )
      ).status
    ).toBe('outside-roots');
    expect(
      await resolveHostAttachment({ ...reference, reference: 'removed.txt' }, [allowed], allowed)
    ).toMatchObject({
      reference: 'removed.txt',
      role: 'assistant',
      sourceLine: 8,
      status: 'missing',
    });
  });

  it.skipIf(
    process.platform !== 'win32' ||
      parse(tmpdir()).root.toLowerCase() === parse(process.cwd()).root.toLowerCase()
  )('rejects an existing attachment on another Windows volume', async () => {
    const foreignRoot = await mkdtemp(join(process.cwd(), '.kb-cross-volume-'));
    if (!resolve(foreignRoot).startsWith(`${resolve(process.cwd())}\\.kb-cross-volume-`))
      throw new Error('Unexpected test cleanup path');
    try {
      const file = join(foreignRoot, 'private.txt');
      await writeFile(file, 'different drive');
      expect(parse(file).root.toLowerCase()).not.toBe(parse(root).root.toLowerCase());
      expect(await safeHostAttachment(file, [root])).toBeNull();
    } finally {
      await rm(foreignRoot, { recursive: true, force: true });
    }
  });
});
