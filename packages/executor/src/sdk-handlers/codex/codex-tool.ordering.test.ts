import type { Message } from '@disco/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { MessagesRepository, SessionRepository } from '../../db/feathers-repositories.js';
import type { MessagesService, TasksService } from '../base/index.js';
import { appendCodexTokenUsageSample, CodexTool } from './codex-tool.js';
import type { CodexStreamEvent } from './prompt-service.js';

vi.mock('../base/diff-enrichment.js', () => ({
  clearEditFilesTurnBaseline: vi.fn(),
  clearToolInvocationState: vi.fn(),
  enrichContentBlocks: vi.fn(),
  refreshEditFilesTurnBaseline: vi.fn(),
  registerEditFilesTurnBaseline: vi.fn(),
  registerToolInvocationStart: vi.fn(),
}));

vi.mock('./prompt-service.js', () => ({
  CodexPromptService: class {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('appendCodexTokenUsageSample', () => {
  it('keeps only the latest cumulative checkpoint in each 30-second bucket', () => {
    const samples: import('@disco/core/types').TokenUsageSample[] = [];
    appendCodexTokenUsageSample(
      samples,
      { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      '2026-08-24T12:00:05.000Z'
    );
    appendCodexTokenUsageSample(
      samples,
      { input_tokens: 180, output_tokens: 20, total_tokens: 200 },
      '2026-08-24T12:00:25.000Z'
    );
    appendCodexTokenUsageSample(
      samples,
      { input_tokens: 260, output_tokens: 30, total_tokens: 290 },
      '2026-08-24T12:00:35.000Z'
    );

    expect(samples).toEqual([
      {
        observedAt: '2026-08-24T12:00:25.000Z',
        inputTokens: 180,
        outputTokens: 20,
        totalTokens: 200,
      },
      {
        observedAt: '2026-08-24T12:00:35.000Z',
        inputTokens: 260,
        outputTokens: 30,
        totalTokens: 290,
      },
    ]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for provider persistence boundary');
}

describe('CodexTool ordered transcript persistence', () => {
  it('shows one localized retry status and removes it after the provider recovers', async () => {
    const created: Array<Partial<Message>> = [];
    const removed: string[] = [];
    const patches: Array<{ id: string; data: Partial<Message> }> = [];
    const messagesService: MessagesService = {
      create: vi.fn(async (data: Partial<Message>) => {
        created.push(data);
        return data as Message;
      }),
      patch: vi.fn(async (id: string, data: Partial<Message>) => {
        patches.push({ id, data });
        return data as Message;
      }),
      remove: vi.fn(async (id: string) => {
        removed.push(id);
        return { message_id: id } as Message;
      }),
    };
    const messagesRepo = {
      findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
      getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
    } as unknown as MessagesRepository;
    const sessionsRepo = {
      findById: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionRepository;
    const tool = new CodexTool(
      messagesRepo,
      sessionsRepo,
      undefined,
      undefined,
      messagesService
    );
    const promptService = {
      async *promptSessionStreaming(): AsyncGenerator<CodexStreamEvent> {
        yield { type: 'capacity_retry', attempt: 1, maxAttempts: 5, delayMs: 1_000 };
        yield { type: 'capacity_retry', attempt: 2, maxAttempts: 5, delayMs: 2_000 };
        yield { type: 'capacity_recovered' };
        yield {
          type: 'complete',
          threadId: 'thread-1',
          content: [{ type: 'text', text: '恢复后完成。' }],
        };
      },
    };
    (tool as unknown as { promptService: typeof promptService }).promptService = promptService;

    await tool.executePromptWithStreaming(
      '018f0000-0000-7000-8000-000000000031' as never,
      '测试自动重试',
      '018f0000-0000-7000-8000-000000000032' as never
    );

    const retryMessage = created.find(message => message.content_preview?.includes('重试 1/5'));
    expect(retryMessage?.content).toEqual([
      { type: 'thinking', text: '模型繁忙，正在重试 1/5' },
    ]);
    expect(patches).toContainEqual({
      id: retryMessage?.message_id,
      data: {
        content: [{ type: 'thinking', text: '模型繁忙，正在重试 2/5' }],
        content_preview: '模型繁忙，正在重试 2/5',
      },
    });
    expect(removed).toEqual([retryMessage?.message_id]);
    expect(created.some(message => message.content_preview === '恢复后完成。')).toBe(true);
  });

  it('keeps one durable retry projection on the same task so a refresh can hydrate it', async () => {
    const sessionId = '018f0000-0000-7000-8000-000000000041' as never;
    const taskId = '018f0000-0000-7000-8000-000000000042' as never;
    const persisted = new Map<string, Partial<Message>>();
    const secondRetryPersisted = deferred<void>();
    const releaseRecovery = deferred<void>();
    const messagesService: MessagesService = {
      create: vi.fn(async (data: Partial<Message>) => {
        persisted.set(String(data.message_id), { ...data });
        return data as Message;
      }),
      patch: vi.fn(async (id: string, data: Partial<Message>) => {
        persisted.set(id, { ...persisted.get(id), ...data });
        if (data.content_preview === '模型繁忙，正在重试 2/5') {
          secondRetryPersisted.resolve();
        }
        return persisted.get(id) as Message;
      }),
      remove: vi.fn(async (id: string) => {
        const removed = persisted.get(id);
        persisted.delete(id);
        return removed as Message;
      }),
    };
    const messagesRepo = {
      findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
      getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
    } as unknown as MessagesRepository;
    const sessionsRepo = {
      findById: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionRepository;
    const tool = new CodexTool(
      messagesRepo,
      sessionsRepo,
      undefined,
      undefined,
      messagesService
    );
    const promptService = {
      async *promptSessionStreaming(): AsyncGenerator<CodexStreamEvent> {
        yield { type: 'capacity_retry', attempt: 1, maxAttempts: 5, delayMs: 1_000 };
        yield { type: 'capacity_retry', attempt: 2, maxAttempts: 5, delayMs: 2_000 };
        await releaseRecovery.promise;
        yield { type: 'capacity_recovered' };
        yield {
          type: 'complete',
          threadId: 'thread-refresh-proof',
          content: [{ type: 'text', text: '恢复后完成。' }],
        };
      },
    };
    (tool as unknown as { promptService: typeof promptService }).promptService = promptService;

    let settled = false;
    const execution = tool
      .executePromptWithStreaming(sessionId, '测试刷新恢复', taskId)
      .then((result) => {
        settled = true;
        return result;
      });

    await secondRetryPersisted.promise;

    // A fresh page obtains this same durable row through the normal message
    // query. The retry is not process-local UI state and does not mint a
    // replacement Task or a second status row on each attempt.
    const hydratedRetryRows = Array.from(persisted.values()).filter((message) =>
      message.content_preview?.startsWith('模型繁忙，正在重试')
    );
    expect(settled).toBe(false);
    expect(hydratedRetryRows).toHaveLength(1);
    expect(hydratedRetryRows[0]).toMatchObject({
      session_id: sessionId,
      task_id: taskId,
      role: 'assistant',
      content_preview: '模型繁忙，正在重试 2/5',
    });

    releaseRecovery.resolve();
    await execution;

    expect(
      Array.from(persisted.values()).filter((message) =>
        message.content_preview?.startsWith('模型繁忙，正在重试')
      )
    ).toHaveLength(0);
    expect(
      Array.from(persisted.values()).some(
        (message) =>
          message.task_id === taskId && message.content_preview === '恢复后完成。'
      )
    ).toBe(true);
  });

  it('persists automatic context compaction as a separate system timeline message', async () => {
    const created: Array<Partial<Message>> = [];
    const messagesService: MessagesService = {
      create: vi.fn(async (data: Partial<Message>) => {
        created.push(data);
        return data as Message;
      }),
      patch: vi.fn(async (_id: string, data: Partial<Message>) => data as Message),
    };
    const messagesRepo = {
      findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
      getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
    } as unknown as MessagesRepository;
    const sessionsRepo = {
      findById: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionRepository;
    const tool = new CodexTool(
      messagesRepo,
      sessionsRepo,
      undefined,
      undefined,
      messagesService
    );
    const promptService = {
      async *promptSessionStreaming(): AsyncGenerator<CodexStreamEvent> {
        yield { type: 'context_compacted', threadId: 'thread-1' };
        yield {
          type: 'complete',
          threadId: 'thread-1',
          content: [{ type: 'text', text: '继续完成。' }],
        };
      },
    };
    (tool as unknown as { promptService: typeof promptService }).promptService = promptService;

    await tool.executePromptWithStreaming(
      '018f0000-0000-7000-8000-000000000021' as never,
      '继续',
      '018f0000-0000-7000-8000-000000000022' as never
    );

    expect(created.map(message => ({ type: message.type, index: message.index }))).toEqual([
      { type: 'user', index: 0 },
      { type: 'system', index: 1 },
      { type: 'assistant', index: 2 },
    ]);
    expect(created[1]?.content).toEqual([
      {
        type: 'system_complete',
        systemType: 'compaction',
        text: '上下文已自动压缩',
      },
    ]);
  });

  it('awaits concurrent tool acknowledgements in provider event order before the final response', async () => {
    const order: string[] = [];
    const firstToolStartAcknowledgement = deferred<Message>();
    const secondToolStartAcknowledgement = deferred<Message>();
    const secondToolResultAcknowledgement = deferred<Message>();
    const firstToolResultAcknowledgement = deferred<Message>();
    let createCount = 0;
    const messagesService: MessagesService = {
      create: vi.fn(async (data: Partial<Message>) => {
        createCount += 1;
        const content = Array.isArray(data.content) ? data.content : [];
        if (createCount === 1) {
          order.push('create:user:0');
          return data as Message;
        }
        const toolUse = content.find((block) => block.type === 'tool_use');
        if (toolUse) {
          const id = String(toolUse.id);
          order.push(`create:${id}:${data.index}`);
          return id === 'tool-1'
            ? firstToolStartAcknowledgement.promise
            : secondToolStartAcknowledgement.promise;
        }
        order.push(`create:assistant:${data.index}`);
        return data as Message;
      }),
      patch: vi.fn(async (_id: string, data: Partial<Message>) => {
        const content = Array.isArray(data.content) ? data.content : [];
        const result = content.find((block) => block.type === 'tool_result');
        const id = String(result?.tool_use_id);
        order.push(`patch:${id}`);
        return (
          id === 'tool-1'
            ? firstToolResultAcknowledgement.promise
            : secondToolResultAcknowledgement.promise
        ).then(() => data as Message);
      }),
    };
    const messagesRepo = {
      findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
      getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
    } as unknown as MessagesRepository;
    const sessionsRepo = {
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as SessionRepository;
    const tool = new CodexTool(
      messagesRepo,
      sessionsRepo,
      undefined,
      undefined,
      messagesService
    );
    const events: CodexStreamEvent[] = [
      {
        type: 'tool_start',
        toolUse: { id: 'tool-1', name: 'WebSearch', input: { query: 'disco' } },
      },
      {
        type: 'tool_start',
        toolUse: { id: 'tool-2', name: 'WebSearch', input: { query: 'socket.io' } },
      },
      {
        type: 'tool_complete',
        toolUse: {
          id: 'tool-2',
          name: 'WebSearch',
          input: { query: 'socket.io' },
          output: 'second projected tool output',
          status: 'completed',
        },
      },
      {
        type: 'tool_complete',
        toolUse: {
          id: 'tool-1',
          name: 'WebSearch',
          input: { query: 'disco' },
          output: 'first projected tool output',
          status: 'completed',
        },
      },
      {
        type: 'complete',
        threadId: '',
        content: [{ type: 'text', text: 'final response' }],
      },
    ];
    const promptService = {
      async *promptSessionStreaming() {
        yield* events;
      },
    };
    (tool as unknown as { promptService: typeof promptService }).promptService = promptService;

    const execution = tool.executePromptWithStreaming(
      '018f0000-0000-7000-8000-000000000001' as never,
      'prompt',
      '018f0000-0000-7000-8000-000000000002' as never
    );

    await waitFor(() => order.includes('create:tool-1:1'));
    expect(order).toEqual(['create:user:0', 'create:tool-1:1']);
    firstToolStartAcknowledgement.resolve({} as Message);

    await waitFor(() => order.includes('create:tool-2:2'));
    expect(order).toEqual(['create:user:0', 'create:tool-1:1', 'create:tool-2:2']);
    secondToolStartAcknowledgement.resolve({} as Message);

    await waitFor(() => order.includes('patch:tool-2'));
    expect(order).toEqual(['create:user:0', 'create:tool-1:1', 'create:tool-2:2', 'patch:tool-2']);
    secondToolResultAcknowledgement.resolve({} as Message);

    await waitFor(() => order.includes('patch:tool-1'));
    expect(order).toEqual([
      'create:user:0',
      'create:tool-1:1',
      'create:tool-2:2',
      'patch:tool-2',
      'patch:tool-1',
    ]);
    firstToolResultAcknowledgement.resolve({} as Message);

    await execution;
    expect(order).toEqual([
      'create:user:0',
      'create:tool-1:1',
      'create:tool-2:2',
      'patch:tool-2',
      'patch:tool-1',
      'create:assistant:3',
    ]);
  });

  it('persists cumulative live token snapshots at most once per 30 seconds', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const messagesService: MessagesService = {
      create: vi.fn(async (data: Partial<Message>) => data as Message),
      patch: vi.fn(async (_id: string, data: Partial<Message>) => data as Message),
    };
    const tasksService: TasksService = {
      get: vi.fn(),
      patch: vi.fn(async (_id, data) => data),
      emit: vi.fn(),
    };
    const messagesRepo = {
      findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
      getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
    } as unknown as MessagesRepository;
    const sessionsRepo = {
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as SessionRepository;
    const tool = new CodexTool(
      messagesRepo,
      sessionsRepo,
      undefined,
      undefined,
      messagesService,
      tasksService
    );
    const events: CodexStreamEvent[] = [
      {
        type: 'usage_snapshot',
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        resolvedModel: 'gpt-5.6-sol',
      },
      {
        type: 'usage_snapshot',
        usage: { input_tokens: 180, output_tokens: 20, total_tokens: 200 },
        resolvedModel: 'gpt-5.6-sol',
      },
      {
        type: 'usage_snapshot',
        usage: { input_tokens: 280, output_tokens: 30, total_tokens: 310 },
        resolvedModel: 'gpt-5.6-sol',
      },
      {
        type: 'complete',
        threadId: '',
        content: [{ type: 'text', text: 'done' }],
      },
    ];
    const promptService = {
      async *promptSessionStreaming() {
        yield events[0];
        now += 10_000;
        yield events[1];
        now += 21_000;
        yield events[2];
        yield events[3];
      },
    };
    (tool as unknown as { promptService: typeof promptService }).promptService = promptService;

    try {
      await tool.executePromptWithStreaming(
        '018f0000-0000-7000-8000-000000000011' as never,
        'prompt',
        '018f0000-0000-7000-8000-000000000012' as never
      );
    } finally {
      nowSpy.mockRestore();
    }

    const usagePatches = vi
      .mocked(tasksService.patch)
      .mock.calls.filter(([, data]) => 'normalized_sdk_response' in data);
    expect(usagePatches).toHaveLength(2);
    expect(usagePatches.map(([, data]) => data.normalized_sdk_response.tokenUsage.totalTokens)).toEqual([
      110, 310,
    ]);
  });
});
