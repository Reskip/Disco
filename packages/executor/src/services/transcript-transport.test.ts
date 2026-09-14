import { createHash } from 'node:crypto';
import type { DiscoClient } from '@disco/core/api';
import { SOCKET_IO_MAX_BUFFER_SIZE_BYTES } from '@disco/core/config';
import type { ExecutorTranscriptRequest, Message } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import { registerExecutorClientHooks } from './feathers-client.js';

const messageId = '018f0000-0000-7000-8000-000000000001';
type Context = { path: string; method: string; data: unknown; id?: string; result?: Message };

function harness(failOnce?: 'append' | 'commit', permanentFailure = false) {
  let hook!: (context: Context) => Promise<Context>;
  const chunks: Buffer[] = [];
  let committed: Message | undefined;
  let failed = false;
  const requests: ExecutorTranscriptRequest[] = [];
  const create = vi.fn(async (request: ExecutorTranscriptRequest) => {
    requests.push(request);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(
      SOCKET_IO_MAX_BUFFER_SIZE_BYTES
    );
    if (request.action === 'abort') return {};
    if (permanentFailure) throw Object.assign(new Error('Permission denied'), { code: 403 });
    if (request.action === 'append') {
      const currentLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (request.offset === currentLength) chunks.push(Buffer.from(request.chunk, 'base64'));
    } else if (!committed) {
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBe(request.totalBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(request.sha256);
      committed = { ...JSON.parse(bytes.toString('utf8')), message_id: request.messageId };
    }
    if (!failed && request.action === failOnce) {
      failed = true;
      throw new Error('operation has timed out');
    }
    return request.action === 'append'
      ? { nextOffset: request.offset + Buffer.from(request.chunk, 'base64').length }
      : { message: committed };
  });
  registerExecutorClientHooks(
    {
      hooks(config: { before: { all: (typeof hook)[] } }) {
        hook = config.before.all[0];
      },
      service(path: string) {
        expect(path).toBe('executor-transcripts');
        return { create };
      },
    } as unknown as DiscoClient,
    'test-executor-proof'
  );
  return { hook, create, requests };
}

describe('lossless executor transcript transport', () => {
  it.each(['create', 'patch'])(
    'saves large %s input, output, diff and prose byte for byte',
    async (method) => {
      const { hook } = harness();
      const input = { files: [{ content: '中文😀\\\n"'.repeat(140_000) }] };
      const data = {
        ...(method === 'create' ? { message_id: messageId } : {}),
        content: [
          { type: 'tool_use', id: 'tool', input },
          {
            type: 'tool_result',
            tool_use_id: 'tool',
            content: '结果'.repeat(500_000),
            diff: '改动'.repeat(400_000),
          },
          { type: 'text', text: '完整正文🪩'.repeat(300_000) },
        ],
        tool_uses: [{ id: 'tool', input }],
      };
      const original = JSON.stringify(data);
      const context = await hook({ path: 'messages', method, id: messageId, data });
      expect(context.result).toEqual({ ...data, message_id: messageId });
      expect(JSON.stringify(data)).toBe(original);
    }
  );

  it.each(['append', 'commit'] as const)(
    'retries a lost %s ACK with the same transfer identity',
    async (action) => {
      const { hook, requests } = harness(action);
      const data = { message_id: messageId, content: 'x'.repeat(951_719) };
      expect((await hook({ path: 'messages', method: 'create', data })).result).toEqual(data);
      const retried = requests.filter((request) => request.action === action).slice(0, 2);
      expect(retried[0]).toEqual(retried[1]);
    }
  );

  it('keeps small writes and other service calls on their original path', async () => {
    const { hook, create } = harness();
    for (const [path, method, data] of [
      ['messages', 'create', { content: 'small' }],
      ['messages', 'find', {}],
      ['sessions', 'create', { content: 'x'.repeat(950_000) }],
    ] as const) {
      const context = { path, method, data };
      expect(await hook(context)).toBe(context);
      expect(context).not.toHaveProperty('result');
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('aborts incomplete staging on permanent errors without hiding failure', async () => {
    const { hook, requests } = harness(undefined, true);
    await expect(
      hook({ path: 'messages', method: 'create', data: { content: 'x'.repeat(950_000) } })
    ).rejects.toThrow('Permission denied');
    expect(requests.map((request) => request.action)).toEqual(['append', 'abort']);
  });
});
