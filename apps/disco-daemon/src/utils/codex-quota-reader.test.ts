import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { quotaChildEnvironment, readHostCodexRateLimits } from './codex-quota-reader.js';

function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('host quota protocol', () => {
  it('uses the host home without forwarding daemon secrets or task context', () => {
    expect(
      quotaChildEnvironment({
        PATH: 'bin',
        DISCO_HOST_CODEX_HOME: 'C:/host/.codex',
        CODEX_HOME: 'E:/runtime',
        CODEX_THREAD_ID: 'task',
        DATABASE_URL: 'secret',
        OPENAI_API_KEY: 'secret',
      })
    ).toEqual({ PATH: 'bin', CODEX_HOME: 'C:/host/.codex' });
  });
  it('initializes, reads quota, and closes the child without starting a turn', async () => {
    const process = child();
    mocks.spawn.mockReturnValue(process);
    const sent: unknown[] = [];
    process.stdin.on('data', (chunk) => sent.push(JSON.parse(chunk.toString())));
    const pending = readHostCodexRateLimits();
    process.emit('spawn');
    process.stdout.write('{"id":1,"result":{}}\n');
    process.stdout.write('{"id":2,"result":{"rateLimits":null}}\n');
    expect(await pending).toEqual({ rateLimits: null });
    expect(sent).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'disco-quota', version: '1.0.0' } },
      },
      { method: 'initialized', params: {} },
      { id: 2, method: 'account/rateLimits/read' },
    ]);
    expect(mocks.spawn.mock.calls.at(-1)?.[2]).toMatchObject({ windowsHide: true, shell: false });
    expect(process.kill).toHaveBeenCalledOnce();
  });
  it('terminates a hung reader and does not expose provider error content', async () => {
    vi.useFakeTimers();
    const process = child();
    mocks.spawn.mockReturnValue(process);
    const result = readHostCodexRateLimits().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toBe('Codex quota read timed out');
    expect(process.kill).toHaveBeenCalledOnce();
  });
  it('closes after a protocol error without returning its private message', async () => {
    const process = child();
    mocks.spawn.mockReturnValue(process);
    const result = readHostCodexRateLimits().catch((error: Error) => error.message);
    process.stdout.write('{"id":1,"error":{"message":"private login details"}}\n');
    expect(await result).toBe('Codex quota initialization failed');
    expect(process.kill).toHaveBeenCalledOnce();
  });
});
