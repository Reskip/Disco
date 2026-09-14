import type { AgentLearningStatus } from '@disco/core/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentLearningInstruction, withAgentLearningReview } from './agent-learning.js';
import type { CodexStreamEvent } from './prompt-service.js';

const status: AgentLearningStatus = {
  fingerprint: 'f',
  pendingUpdates: 0,
  memoryCharacters: 0,
  consolidationDue: false,
  reviews: [],
};
const completion: CodexStreamEvent = {
  type: 'complete',
  threadId: 'thread-1',
  content: [{ type: 'text', text: '用户任务已完成。' }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

async function collect(stream: AsyncGenerator<CodexStreamEvent>) {
  const result: CodexStreamEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

function fixture(
  options: {
    learningStatus?: AgentLearningStatus | null;
    fail?: boolean;
    stopped?: boolean;
    throwOnReview?: boolean;
  } = {}
) {
  const calls: string[] = [];
  const run = async function* (prompt: string): AsyncGenerator<CodexStreamEvent> {
    calls.push(prompt);
    if (calls.length === 1 && options.fail) throw new Error('main failure');
    if (calls.length === 1 && options.stopped) {
      yield { type: 'stopped' };
      return;
    }
    if (calls.length > 1 && options.throwOnReview) throw new Error('review failure');
    yield {
      ...completion,
      content: [{ type: 'text', text: calls.length === 1 ? '用户任务已完成。' : '内部复盘回复' }],
    };
  };
  const config = {
    prompt: '排查并解决问题',
    taskId: 'task-1',
    run,
    loadStatus: vi.fn(async () =>
      options.learningStatus === undefined ? status : options.learningStatus
    ),
    stopped: () => false,
  };
  return { calls, config };
}

describe('bounded end-of-task learning', () => {
  it('supplements a missed review only once and accounts for both turns without a duplicate answer', async () => {
    const { calls, config } = fixture();
    const events = await collect(withAgentLearningReview(config));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('taskId=task-1');
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      content: [],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    });
    expect(JSON.stringify(events)).not.toContain('内部复盘回复');
  });

  it.each([
    { prompt: '你好', learningStatus: status },
    { prompt: '只读排查', learningStatus: status },
    { prompt: '排查', learningStatus: null },
    {
      prompt: '排查',
      learningStatus: {
        ...status,
        reviews: [
          {
            taskId: 'task-1',
            sessionId: 's',
            completedAt: 'now',
            memoryDecision: '无',
            skillDecision: '无',
          },
        ],
      },
    },
  ])(
    'does not supplement trivial, read-only, standalone or already reviewed work: $prompt',
    async ({ prompt, learningStatus }) => {
      const { calls, config } = fixture({ learningStatus });
      await collect(withAgentLearningReview({ ...config, prompt }));
      expect(calls).toHaveLength(1);
    }
  );

  it('checks consolidation even after a short task', async () => {
    const { calls, config } = fixture({ learningStatus: { ...status, consolidationDue: true } });
    await collect(withAgentLearningReview({ ...config, prompt: '谢谢' }));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('已达到记忆整理条件');
  });

  it('does not learn after a failed or stopped turn', async () => {
    const failed = fixture({ fail: true });
    await expect(collect(withAgentLearningReview(failed.config))).rejects.toThrow('main failure');
    expect(failed.calls).toHaveLength(1);
    const stopped = fixture({ stopped: true });
    expect(await collect(withAgentLearningReview(stopped.config))).toEqual([{ type: 'stopped' }]);
    expect(stopped.calls).toHaveLength(1);
  });

  it('preserves successful user work when the review fails', async () => {
    const { config } = fixture({ throwOnReview: true });
    expect((await collect(withAgentLearningReview(config)))[0]).toMatchObject(completion);
  });

  it('bounds review time and forwards a user stop', async () => {
    const { config } = fixture();
    let count = 0;
    const run = async function* (
      _prompt: string,
      controller?: AbortController
    ): AsyncGenerator<CodexStreamEvent> {
      if (++count === 1) {
        yield completion;
        return;
      }
      await new Promise<void>((resolve) =>
        controller?.signal.addEventListener('abort', () => resolve(), { once: true })
      );
      yield { type: 'stopped' };
    };
    const timed = await collect(withAgentLearningReview({ ...config, run, timeoutMs: 5 }));
    expect(timed.some((event) => event.type === 'stopped')).toBe(false);
    count = 0;
    const controller = new AbortController();
    const stream = withAgentLearningReview({ ...config, run, abortController: controller });
    await stream.next();
    await stream.next();
    const next = stream.next();
    controller.abort();
    expect((await next).value).toEqual({ type: 'stopped' });
    await stream.return();
  });

  it('requires verified reusable skills and respects explicit user limits', () => {
    const instruction = buildAgentLearningInstruction('t');
    expect(instruction).toContain('方法得到实际验证');
    expect(instruction).toContain('优先完善已有技能');
    expect(instruction).toContain('不要记录');
  });

  it('surfaces the answer when the user steers a maintenance turn back to their task', async () => {
    const { config } = fixture();
    const events = await collect(
      withAgentLearningReview({ ...config, wasReviewSteered: () => true })
    );
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      content: [{ type: 'text', text: '内部复盘回复' }],
    });
  });

  it('surfaces a provider failure after the user steers the continuation into new work', async () => {
    const { config } = fixture({ throwOnReview: true });
    await expect(
      collect(withAgentLearningReview({ ...config, wasReviewSteered: () => true }))
    ).rejects.toThrow('review failure');
  });

  it('recognizes a managed memory save behind the progressive tool facade', async () => {
    const { config } = fixture();
    let calls = 0;
    const run = async function* (): AsyncGenerator<CodexStreamEvent> {
      calls++;
      yield {
        type: 'tool_complete',
        toolUse: {
          id: 'm',
          name: 'disco_execute_tool',
          input: { tool_name: 'disco_agent_memory_save' },
        },
      };
      yield completion;
    };
    await collect(withAgentLearningReview({ ...config, prompt: '收到', run }));
    expect(calls).toBe(2);
  });

  it('reviews a validation workflow even when it ran in a single command', async () => {
    const { config } = fixture();
    let calls = 0;
    const run = async function* (): AsyncGenerator<CodexStreamEvent> {
      calls++;
      yield { type: 'tool_complete', toolUse: { id: 'c', name: 'exec_command', input: {} } };
      yield completion;
    };
    await collect(withAgentLearningReview({ ...config, prompt: '核验 CSV 数据处理流程', run }));
    expect(calls).toBe(2);
  });
});
