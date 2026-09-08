import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  notifications: [] as Array<{ method: string; params: Record<string, unknown> }>,
  startThread: vi.fn(),
  resumeThread: vi.fn(),
  startTurn: vi.fn(),
  interruptTurn: vi.fn(),
  steerTurn: vi.fn(),
  close: vi.fn(),
}));

vi.mock('./app-server-client.js', () => ({
  CodexAppServerClient: class {
    startThread = clientMocks.startThread;
    resumeThread = clientMocks.resumeThread;
    startTurn = clientMocks.startTurn;
    interruptTurn = clientMocks.interruptTurn;
    steerTurn = clientMocks.steerTurn;
    close = clientMocks.close;

    async *notifications() {
      for (const notification of clientMocks.notifications) yield notification;
    }
  },
}));

import { CodexAppServerThread, convertAppServerThreadItem } from './app-server-thread.js';

describe('Codex app-server thread adapter', () => {
  beforeEach(() => {
    clientMocks.notifications = [];
    clientMocks.startThread.mockReset().mockResolvedValue({ id: 'thread-1', result: {} });
    clientMocks.resumeThread.mockReset().mockResolvedValue({ id: 'thread-1', result: {} });
    clientMocks.startTurn.mockReset().mockResolvedValue({ id: 'turn-1', result: {} });
    clientMocks.interruptTurn.mockReset().mockResolvedValue(undefined);
    clientMocks.steerTurn.mockReset().mockResolvedValue('turn-1');
    clientMocks.close.mockReset().mockResolvedValue(undefined);
  });

  it('converts app-server command and MCP items to the public SDK item shape', () => {
    expect(
      convertAppServerThreadItem({
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'pnpm test',
        aggregatedOutput: 'ok',
        exitCode: 0,
        status: 'completed',
      })
    ).toEqual({
      type: 'command_execution',
      id: 'cmd-1',
      command: 'pnpm test',
      aggregated_output: 'ok',
      exit_code: 0,
      status: 'completed',
    });

    expect(
      convertAppServerThreadItem({
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'disco',
        tool: 'sessions_list',
        arguments: { limit: 2 },
        result: { content: [{ type: 'text', text: 'done' }], structuredContent: { count: 1 } },
        status: 'completed',
      })
    ).toMatchObject({
      type: 'mcp_tool_call',
      id: 'mcp-1',
      server: 'disco',
      tool: 'sessions_list',
      arguments: { limit: 2 },
      result: {
        content: [{ type: 'text', text: 'done' }],
        structured_content: { count: 1 },
      },
      status: 'completed',
    });

    expect(
      convertAppServerThreadItem({
        type: 'dynamicToolCall',
        id: 'dynamic-1',
        namespace: 'media',
        tool: 'preview',
        arguments: { path: 'image.png' },
        status: 'completed',
        contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,AA==' }],
        success: true,
      })
    ).toEqual({
      type: 'dynamic_tool_call',
      id: 'dynamic-1',
      namespace: 'media',
      tool: 'preview',
      arguments: { path: 'image.png' },
      status: 'completed',
      content_items: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,AA==' }],
      success: true,
    });

    expect(
      convertAppServerThreadItem({ type: 'imageView', id: 'image-1', path: 'E:\\result.png' })
    ).toEqual({ type: 'image_view', id: 'image-1', path: 'E:\\result.png' });
    expect(
      convertAppServerThreadItem({
        type: 'imageGeneration',
        id: 'generation-1',
        status: 'completed',
        revisedPrompt: 'gold circle',
        result: 'generated-image-result',
        savedPath: 'E:\\generated.png',
        transparentBackground: true,
        failure: null,
      })
    ).toEqual({
      type: 'image_generation',
      id: 'generation-1',
      status: 'completed',
      revised_prompt: 'gold circle',
      result: 'generated-image-result',
      saved_path: 'E:\\generated.png',
      transparent_background: true,
    });
  });

  it('advertises registered client dynamic tools on a fresh durable thread', async () => {
    clientMocks.notifications = [
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      },
    ];
    const dynamicTool = {
      spec: {
        type: 'function' as const,
        name: 'client_echo',
        description: 'Echo text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      execute: async () => ({
        contentItems: [{ type: 'inputText' as const, text: 'ok' }],
        success: true,
      }),
    };
    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
      clientOptions: { dynamicTools: [dynamicTool] },
    });

    const { events } = await thread.runStreamed('test');
    for await (const _event of events) {
      // Drain the terminal notification.
    }

    expect(clientMocks.startThread).toHaveBeenCalledWith(
      expect.objectContaining({ dynamicTools: [dynamicTool.spec] })
    );
  });

  it('streams assistant deltas and emits the terminal usage event', async () => {
    clientMocks.notifications = [
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: '你' },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: '好' },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-1', text: '你好' },
        },
      },
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: {
            last: {
              inputTokens: 100,
              cachedInputTokens: 80,
              cacheWriteInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 0,
            },
          },
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      },
    ];

    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        model: 'gpt-5.6-luna',
        modelReasoningEffort: 'low',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        networkAccessEnabled: true,
        additionalDirectories: ['E:\\Disco\\data\\disco\\worktrees\\user-1'],
      },
      config: { model_provider: 'disco_openai_https' },
    });
    const { events } = await thread.runStreamed([
      { type: 'text', text: '测试' },
      { type: 'local_image', path: 'E:\\workspace\\image.png' },
    ]);
    const collected = [];
    for await (const event of events) collected.push(event);

    expect(clientMocks.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: '测试', text_elements: [] },
        { type: 'localImage', path: 'E:\\workspace\\image.png' },
      ],
      effort: 'low',
    });
    expect(clientMocks.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'E:\\workspace',
        config: expect.objectContaining({
          sandbox_workspace_write: expect.objectContaining({
            network_access: true,
            writable_roots: ['E:\\Disco\\data\\disco\\worktrees\\user-1'],
          }),
        }),
      })
    );
    expect(collected).toEqual([
      { type: 'turn.started' },
      { type: 'agent_message_delta', itemId: 'msg-1', delta: '你' },
      { type: 'agent_message_delta', itemId: 'msg-1', delta: '好' },
      { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: '你好' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          cache_write_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    expect(clientMocks.close).toHaveBeenCalledOnce();
  });

  it('retries a capacity failure before any assistant or tool output', async () => {
    clientMocks.startTurn
      .mockResolvedValueOnce({ id: 'turn-1', result: {} })
      .mockResolvedValueOnce({ id: 'turn-2', result: {} });
    clientMocks.notifications = [
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          message: 'Selected model is at capacity. Please try a different model.',
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: { message: 'Selected model is at capacity.' },
          },
        },
      },
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-2' } },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'msg-2', delta: '恢复' },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
      },
    ];

    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
      capacityRetry: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    const { events } = await thread.runStreamed('测试容量重试');
    const collected = [];
    for await (const event of events) collected.push(event);

    expect(clientMocks.startTurn).toHaveBeenCalledTimes(2);
    expect(collected).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(collected).not.toContainEqual(expect.objectContaining({ type: 'turn.failed' }));
    expect(collected).toContainEqual({
      type: 'capacity.retrying',
      attempt: 1,
      maxAttempts: 5,
      delayMs: 0,
    });
    expect(collected).toContainEqual({ type: 'capacity.recovered' });
    expect(collected).toContainEqual({
      type: 'agent_message_delta',
      itemId: 'msg-2',
      delta: '恢复',
    });
    expect(collected.at(-1)?.type).toBe('turn.completed');
  });

  it('recovers after multiple transient capacity failures', async () => {
    clientMocks.startTurn
      .mockResolvedValueOnce({ id: 'turn-1', result: {} })
      .mockResolvedValueOnce({ id: 'turn-2', result: {} })
      .mockResolvedValueOnce({ id: 'turn-3', result: {} });
    clientMocks.notifications = [
      ...['turn-1', 'turn-2'].flatMap(turnId => [
        {
          method: 'error',
          params: { threadId: 'thread-1', turnId, message: 'HTTP 503 Service Unavailable' },
        },
        {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: turnId, status: 'failed', error: { message: 'HTTP 503' } },
          },
        },
      ]),
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-3', itemId: 'msg-3', delta: '成功' },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-3', status: 'completed' } },
      },
    ];

    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
      capacityRetry: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    const { events } = await thread.runStreamed('重试直到恢复');
    const collected = [];
    for await (const event of events) collected.push(event);

    expect(clientMocks.startTurn).toHaveBeenCalledTimes(3);
    expect(collected.filter(event => event.type === 'capacity.retrying')).toEqual([
      { type: 'capacity.retrying', attempt: 1, maxAttempts: 5, delayMs: 0 },
      { type: 'capacity.retrying', attempt: 2, maxAttempts: 5, delayMs: 0 },
    ]);
    expect(collected.filter(event => event.type === 'capacity.recovered')).toHaveLength(1);
    expect(collected.at(-1)?.type).toBe('turn.completed');
  });

  it('stops after five retries and returns one localized final failure', async () => {
    clientMocks.startTurn.mockReset();
    for (let attempt = 1; attempt <= 6; attempt++) {
      clientMocks.startTurn.mockResolvedValueOnce({ id: `turn-${attempt}`, result: {} });
    }
    clientMocks.notifications = Array.from({ length: 6 }, (_, index) => {
      const turnId = `turn-${index + 1}`;
      return [
        {
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId,
            message: 'Selected model is at capacity. Please try a different model.',
          },
        },
        {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: turnId,
              status: 'failed',
              error: { message: 'Selected model is at capacity.' },
            },
          },
        },
      ];
    }).flat();

    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
      capacityRetry: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    const { events } = await thread.runStreamed('持续繁忙');
    const collected = [];
    for await (const event of events) collected.push(event);

    expect(clientMocks.startTurn).toHaveBeenCalledTimes(6);
    expect(collected.filter(event => event.type === 'capacity.retrying')).toHaveLength(5);
    expect(collected.at(-1)).toEqual({
      type: 'turn.failed',
      error: {
        message: '远端模型服务持续繁忙，Disco 已完成自动重试但仍未恢复。请立即重试，或切换其他模型。',
      },
    });
  });

  it('continues the same thread without replaying original input after assistant activity', async () => {
    clientMocks.startTurn
      .mockResolvedValueOnce({ id: 'turn-1', result: {} })
      .mockResolvedValueOnce({ id: 'turn-2', result: {} });
    clientMocks.notifications = [
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: '已经开始' },
      },
      {
        method: 'error',
        params: { threadId: 'thread-1', turnId: 'turn-1', message: 'HTTP 503' },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'failed', error: { message: 'HTTP 503' } },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'msg-2', delta: '继续完成' },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
      },
    ];

    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
      capacityRetry: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    const { events } = await thread.runStreamed('不要重复副作用');
    const collected = [];
    for await (const event of events) collected.push(event);

    expect(clientMocks.startTurn).toHaveBeenCalledTimes(2);
    expect(clientMocks.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        threadId: 'thread-1',
        input: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('不要重复已经成功执行'),
          }),
        ],
      })
    );
    expect(clientMocks.startTurn.mock.calls[1]?.[0]?.input).not.toEqual([
      { type: 'text', text: '不要重复副作用', text_elements: [] },
    ]);
    expect(collected).toContainEqual(expect.objectContaining({ type: 'capacity.retrying' }));
    expect(collected.at(-1)?.type).toBe('turn.completed');
  });

  it('continues the same thread without replaying a tool after it has started', async () => {
    clientMocks.startTurn
      .mockResolvedValueOnce({ id: 'turn-1', result: {} })
      .mockResolvedValueOnce({ id: 'turn-2', result: {} });
    clientMocks.notifications = [
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'mcpToolCall',
            id: 'tool-1',
            server: 'disco',
            tool: 'disco_files_publish',
            arguments: { paths: ['result.png'] },
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'mcpToolCall',
            id: 'tool-1',
            server: 'disco',
            tool: 'disco_files_publish',
            arguments: { paths: ['result.png'] },
            status: 'completed',
            result: {
              content: [{ type: 'text', text: 'published' }],
              structuredContent: { published: [{ ref: 'upload-1', fileName: 'result.png' }] },
            },
          },
        },
      },
      {
        method: 'error',
        params: { threadId: 'thread-1', turnId: 'turn-1', message: 'HTTP 503' },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'failed', error: { message: 'HTTP 503' } },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'msg-2', delta: '发布已完成' },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
      },
    ];

    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
      capacityRetry: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    const { events } = await thread.runStreamed('发布后不得重放');
    const collected = [];
    for await (const event of events) collected.push(event);

    expect(clientMocks.startTurn).toHaveBeenCalledTimes(2);
    expect(clientMocks.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        threadId: 'thread-1',
        input: [expect.objectContaining({ text: expect.stringContaining('不要重复已经成功执行') })],
      })
    );
    expect(collected.filter(event => event.type === 'item.started')).toHaveLength(1);
    expect(
      collected.filter(
        event => event.type === 'item.completed' && event.item.type === 'mcp_tool_call'
      )
    ).toHaveLength(1);
    expect(collected).toContainEqual(expect.objectContaining({ type: 'capacity.retrying' }));
    expect(collected.at(-1)?.type).toBe('turn.completed');
  });

  it('reports only the recovered attempt usage after capacity retries', async () => {
    clientMocks.startTurn
      .mockResolvedValueOnce({ id: 'turn-1', result: {} })
      .mockResolvedValueOnce({ id: 'turn-2', result: {} })
      .mockResolvedValueOnce({ id: 'turn-3', result: {} });
    clientMocks.notifications = [
      ...['turn-1', 'turn-2'].flatMap(turnId => [
        {
          method: 'error',
          params: { threadId: 'thread-1', turnId, message: 'HTTP 503 Service Unavailable' },
        },
        {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: turnId, status: 'failed', error: { message: 'HTTP 503' } },
          },
        },
      ]),
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-3',
          tokenUsage: {
            last: {
              inputTokens: 120,
              cachedInputTokens: 80,
              cacheWriteInputTokens: 0,
              outputTokens: 7,
              reasoningOutputTokens: 3,
            },
          },
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-3', status: 'completed' } },
      },
    ];

    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
      capacityRetry: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    const { events } = await thread.runStreamed('重试用量只记一次');
    const collected = [];
    for await (const event of events) collected.push(event);

    expect(collected.filter(event => event.type === 'turn.completed')).toEqual([
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 120,
          cached_input_tokens: 80,
          cache_write_input_tokens: 0,
          output_tokens: 7,
          reasoning_output_tokens: 3,
        },
      },
    ]);
  });

  it('interrupts during retry backoff without starting another turn', async () => {
    clientMocks.notifications = [
      {
        method: 'error',
        params: { threadId: 'thread-1', turnId: 'turn-1', message: 'HTTP 429' },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'failed', error: { message: 'HTTP 429' } },
        },
      },
    ];
    const abortController = new AbortController();
    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
      capacityRetry: { baseDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 },
    });
    const { events } = await thread.runStreamed('重试时停止', { signal: abortController.signal });
    const iterator = events[Symbol.asyncIterator]();
    const retryEvent = await iterator.next();
    expect(retryEvent.value).toMatchObject({ type: 'capacity.retrying', attempt: 1 });
    abortController.abort();
    const interrupted = await iterator.next();

    expect(interrupted.value).toEqual({ type: 'turn.interrupted' });
    expect(clientMocks.startTurn).toHaveBeenCalledTimes(1);
  });

  it('emits one compaction event when app-server reports both compaction surfaces', async () => {
    clientMocks.notifications = [
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'contextCompaction', id: 'compact-1' },
        },
      },
      {
        method: 'thread/compacted',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      },
    ];

    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
    });
    const { events } = await thread.runStreamed('压缩测试');
    const collected = [];
    for await (const event of events) collected.push(event);

    expect(collected.filter(event => event.type === 'context.compacted')).toEqual([
      { type: 'context.compacted', itemId: 'compact-1' },
    ]);
  });

  it('steers the active turn without starting a second turn', async () => {
    clientMocks.notifications = [
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      },
    ];
    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
    });

    const { events } = await thread.runStreamed('开始任务');
    await thread.steer('补充：只修改测试文件');

    expect(clientMocks.steerTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      turnId: 'turn-1',
      input: [{ type: 'text', text: '补充：只修改测试文件', text_elements: [] }],
    });
    expect(clientMocks.startTurn).toHaveBeenCalledTimes(1);

    for await (const _event of events) {
      // Drain the terminal notification so the adapter closes its child.
    }
  });

  it('selects a named permission profile without sending legacy sandbox settings', async () => {
    clientMocks.notifications = [
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      },
    ];
    const thread = new CodexAppServerThread({
      threadOptions: {
        workingDirectory: 'E:\\Disco\\worktrees\\user-reskip\\standalone\\session-1',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccessEnabled: true,
      },
      permissionProfile: 'disco-personal-workspace',
      config: {
        sandbox_mode: 'workspace-write',
        sandbox_workspace_write: { network_access: false },
        permissions: {
          'disco-personal-workspace': {
            filesystem: { ':root': 'write' },
            network: { enabled: true },
          },
        },
      },
    });

    const { events } = await thread.runStreamed('测试权限');
    for await (const _event of events) {
      // Drain the terminal notification.
    }

    const params = clientMocks.startThread.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params.permissions).toBe('disco-personal-workspace');
    expect(params).not.toHaveProperty('sandbox');
    expect(params.config).not.toHaveProperty('sandbox_mode');
    expect(params.config).not.toHaveProperty('sandbox_workspace_write');
    expect(params.config).toMatchObject({
      permissions: {
        'disco-personal-workspace': {
          filesystem: { ':root': 'write' },
          network: { enabled: true },
        },
      },
    });
  });

  it('does not mutate archival state when a durable thread cannot be resumed', async () => {
    clientMocks.resumeThread.mockRejectedValueOnce(
      new Error('Codex app-server request failed: session thread-1 is archived')
    );
    const thread = new CodexAppServerThread({
      resumeThreadId: 'thread-1',
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
    });

    await expect(thread.runStreamed('继续')).rejects.toThrow('session thread-1 is archived');
    expect(clientMocks.resumeThread).toHaveBeenCalledOnce();
    expect(clientMocks.startThread).not.toHaveBeenCalled();
    expect(clientMocks.close).toHaveBeenCalledOnce();
  });

  it('starts a new durable thread when the isolated Runtime Home lacks the old rollout', async () => {
    clientMocks.resumeThread.mockRejectedValueOnce(
      new Error('Codex app-server request failed: no rollout found for thread id desktop-thread-1')
    );
    clientMocks.startThread.mockResolvedValueOnce({ id: 'runtime-thread-2', result: {} });
    clientMocks.notifications = [
      {
        method: 'turn/completed',
        params: { threadId: 'runtime-thread-2', turn: { id: 'turn-1', status: 'completed' } },
      },
    ];

    const thread = new CodexAppServerThread({
      resumeThreadId: 'desktop-thread-1',
      threadOptions: {
        workingDirectory: 'E:\\workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
      config: {},
    });

    const { events } = await thread.runStreamed('继续');
    for await (const _event of events) {
      // Drain the terminal notification so the adapter closes its child.
    }

    expect(clientMocks.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'E:\\workspace',
        serviceName: 'disco',
        threadSource: 'disco',
      })
    );
    expect(clientMocks.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'runtime-thread-2' })
    );
    expect(thread.id).toBe('runtime-thread-2');
  });
});
