import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRolloutUsageMonitor } from './rollout-usage-monitor.js';

const temporaryHomes: string[] = [];

function tokenCountLine({
  timestamp,
  total,
  last,
  input = total,
  output = 0,
  lastInput = last === total ? input : 0,
  lastOutput = last === total ? output : 0,
}: {
  timestamp: string;
  total: number;
  last: number;
  input?: number;
  output?: number;
  lastInput?: number;
  lastOutput?: number;
}): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: output,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: lastInput,
          output_tokens: lastOutput,
          total_tokens: last,
        },
        model_context_window: 272_000,
      },
    },
  });
}

async function createRollout(
  threadId: string,
  contents: string
): Promise<{
  codexHome: string;
  rolloutPath: string;
}> {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'disco-rollout-monitor-'));
  temporaryHomes.push(codexHome);
  const directory = path.join(codexHome, 'sessions', '2026', '08', '24');
  await fs.mkdir(directory, { recursive: true });
  const rolloutPath = path.join(directory, `rollout-test-${threadId}.jsonl`);
  await fs.writeFile(rolloutPath, contents, 'utf8');
  return { codexHome, rolloutPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('CodexRolloutUsageMonitor', () => {
  it('derives the pre-turn baseline from the first current row on an existing thread', async () => {
    const threadId = '01a00000-existing-thread';
    const before = tokenCountLine({
      timestamp: '2026-08-24T10:00:00.000Z',
      total: 1_000,
      last: 250,
      input: 900,
      output: 100,
    });
    const { codexHome, rolloutPath } = await createRollout(threadId, `${before}\n`);
    const monitor = new CodexRolloutUsageMonitor(
      [codexHome],
      Date.parse('2026-08-24T10:01:00.000Z')
    );
    await monitor.primeExistingThread(threadId);

    await fs.appendFile(
      rolloutPath,
      `${tokenCountLine({
        timestamp: '2026-08-24T10:01:30.000Z',
      total: 1_450,
      last: 450,
      input: 1_300,
      output: 150,
      lastInput: 400,
      lastOutput: 50,
      })}\n`,
      'utf8'
    );

    const snapshots = await monitor.poll();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      observedAt: '2026-08-24T10:01:30.000Z',
      usage: {
        input_tokens: 400,
        output_tokens: 50,
        total_tokens: 450,
      },
    });
    expect(monitor.getLatestUsage()?.total_tokens).toBe(450);
  });

  it('handles Codex resetting total_token_usage at a new turn boundary', async () => {
    const threadId = '01a00000-reset-thread';
    const before = tokenCountLine({
      timestamp: '2026-08-24T10:00:00.000Z',
      total: 9_164_632,
      last: 205_079,
      input: 9_115_667,
      output: 48_965,
    });
    const { codexHome, rolloutPath } = await createRollout(threadId, `${before}\n`);
    const monitor = new CodexRolloutUsageMonitor(
      [codexHome],
      Date.parse('2026-08-24T13:05:00.000Z')
    );
    await monitor.primeExistingThread(threadId);

    await fs.appendFile(
      rolloutPath,
      `${tokenCountLine({
        timestamp: '2026-08-24T13:05:55.000Z',
        total: 205_544,
        last: 205_544,
        input: 205_178,
        output: 366,
      })}\n`,
      'utf8'
    );

    const snapshots = await monitor.poll();
    expect(snapshots[0]).toMatchObject({
      usage: {
        input_tokens: 205_178,
        output_tokens: 366,
        total_tokens: 205_544,
      },
    });
  });

  it('derives a fresh-turn baseline and waits for a complete JSONL line', async () => {
    const threadId = '01a00000-fresh-thread';
    const first = tokenCountLine({
      timestamp: '2026-08-24T11:00:10.000Z',
      total: 120,
      last: 120,
      input: 100,
      output: 20,
    });
    const second = tokenCountLine({
      timestamp: '2026-08-24T11:00:45.000Z',
      total: 300,
      last: 180,
      input: 250,
      output: 50,
      lastInput: 150,
      lastOutput: 30,
    });
    const splitAt = Math.floor(second.length / 2);
    const { codexHome, rolloutPath } = await createRollout(
      threadId,
      `${first}\n${second.slice(0, splitAt)}`
    );
    const monitor = new CodexRolloutUsageMonitor(
      [codexHome],
      Date.parse('2026-08-24T11:00:00.000Z')
    );

    const firstPoll = await monitor.poll(threadId);
    expect(firstPoll.map((snapshot) => snapshot.usage.total_tokens)).toEqual([120]);

    await fs.appendFile(rolloutPath, `${second.slice(splitAt)}\n`, 'utf8');
    const secondPoll = await monitor.poll();
    expect(secondPoll.map((snapshot) => snapshot.usage.total_tokens)).toEqual([300]);
  });
});
