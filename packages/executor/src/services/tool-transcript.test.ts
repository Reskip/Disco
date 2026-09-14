import type { Message } from '@disco/core/types';
import { describe, expect, it } from 'vitest';
import { EXECUTOR_REQUEST_DATA_BUDGET_BYTES as BUDGET } from './feathers-client.js';
import { prepareToolTranscript } from './tool-transcript.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function message(input: Record<string, unknown>, output?: unknown): Partial<Message> {
  return {
    message_id: '018f0000-0000-7000-8000-000000000001' as never,
    session_id: '018f0000-0000-7000-8000-000000000002' as never,
    task_id: '018f0000-0000-7000-8000-000000000003' as never,
    content_preview: '执行记录',
    content: [
      { type: 'tool_use', id: 'call-1', name: 'disco.disco_execute_tool', input },
      ...(output === undefined
        ? []
        : [
            {
              type: 'tool_result' as const,
              tool_use_id: 'call-1',
              content: output,
              is_error: false,
            },
          ]),
    ],
    tool_uses: [{ id: 'call-1', name: 'disco.disco_execute_tool', input }],
  };
}

describe('prepareToolTranscript', () => {
  it('preserves ordinary records exactly', () => {
    const original = message({ command: 'pwd' }, 'ok');
    expect(prepareToolTranscript(original)).toBe(original);
  });

  it('keeps the full skill-install input once instead of failing at roughly 952 KB', () => {
    const input = {
      tool_name: 'disco_skills_install',
      arguments: { files: [{ relativePath: 'scripts/main.py', content: 'x'.repeat(475_000) }] },
    };
    const original = message(input);
    expect(bytes(original)).toBeGreaterThan(950_000);
    const prepared = prepareToolTranscript(original);
    expect(bytes(prepared)).toBeLessThanOrEqual(BUDGET);
    expect(prepared.tool_uses).toBeUndefined();
    expect(prepared.content).toEqual(original.content);
    expect(original.tool_uses?.[0].input).toBe(input);
  });

  it('includes envelope and Unicode preview bytes in the result budget', () => {
    const original = message({ command: 'read' }, '\\"中文\n'.repeat(100_000));
    original.content_preview = '这是结果预览。'.repeat(30);
    const prepared = prepareToolTranscript(original);
    expect(bytes(prepared)).toBeLessThanOrEqual(BUDGET);
    expect(prepared.content_preview).toBe(original.content_preview);
    expect(JSON.stringify(prepared.content)).toMatch(/truncated|omitted/);
    expect(JSON.stringify(original.content)).not.toMatch(/truncated|omitted/);
  });

  it('reserves the wrapper even when content alone fits the limit', () => {
    const original: Partial<Message> = {
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'x'.repeat(BUDGET - 100) }],
      content_preview: '中'.repeat(200),
    };
    expect(bytes(original.content)).toBeLessThan(BUDGET);
    expect(bytes(original)).toBeGreaterThan(BUDGET);
    expect(bytes(prepareToolTranscript(original))).toBeLessThanOrEqual(BUDGET);
  });

  it('previews a single oversized input without changing the actual invocation', () => {
    const input = {
      tool_name: 'disco_skills_install',
      arguments: { files: [{ content: '汉字😀'.repeat(150_000) }] },
    };
    const original = message(input);
    const prepared = prepareToolTranscript(original);
    expect(bytes(prepared)).toBeLessThanOrEqual(BUDGET);
    const preview = (prepared.content as Array<{ input: Record<string, unknown> }>)[0].input;
    expect(preview.tool_name).toBe('disco_skills_install');
    expect(preview._disco_display_notice).toContain('实际调用使用完整参数');
    expect(preview._disco_input_preview).not.toContain('\uFFFD');
    expect((original.content as Array<{ input: unknown }>)[0].input).toBe(input);
  });

  it('removes a huge optional diff and preserves the tool result state', () => {
    const original = message({ command: 'edit' }, 'ok');
    const blocks = original.content as Array<Record<string, unknown>>;
    blocks[1].diff = { structuredPatch: [{ lines: ['x'.repeat(BUDGET * 2)] }] };
    const prepared = prepareToolTranscript(original);
    expect(bytes(prepared)).toBeLessThanOrEqual(BUDGET);
    const result = (prepared.content as Array<Record<string, unknown>>)[1];
    expect(result.diff).toBeUndefined();
    expect(result.is_error).toBe(false);
    expect(String(result.content)).toContain('省略差异预览');
    expect(blocks[1].diff).toBeDefined();
  });

  it('leaves user messages and assistant prose for the existing guard', () => {
    const original: Partial<Message> = {
      content: [{ type: 'text', text: 'x'.repeat(BUDGET * 2) }],
    };
    expect(prepareToolTranscript(original)).toBe(original);
  });

  it('preserves compatibility references needed to group nested Task messages', () => {
    const original = message({ prompt: 'x'.repeat(475_000) });
    if (!Array.isArray(original.content) || !original.tool_uses) throw new Error('Invalid fixture');
    original.content[0].name = 'Task';
    original.tool_uses[0].name = 'Task';
    const prepared = prepareToolTranscript(original);
    expect(bytes(prepared)).toBeLessThanOrEqual(BUDGET);
    expect(prepared.tool_uses).toHaveLength(1);
    expect(prepared.tool_uses?.[0]).toMatchObject({ id: 'call-1', name: 'Task' });
  });
});
