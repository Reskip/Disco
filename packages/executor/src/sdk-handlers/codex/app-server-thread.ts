import type {
  Input as CodexInput,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  Usage,
} from '@openai/codex-sdk';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerNotification,
  type CodexDynamicToolOutputContentItem,
} from './app-server-client.js';
import { codexCapacityUserMessage, isCodexCapacityError } from './capacity-error.js';

type ConfigObject = Record<string, unknown>;

export type CodexAppServerThreadItem =
  | ThreadItem
  | {
      id: string;
      type: 'dynamic_tool_call';
      namespace: string | null;
      tool: string;
      arguments: unknown;
      status: 'in_progress' | 'completed' | 'failed';
      content_items?: CodexDynamicToolOutputContentItem[];
      success?: boolean;
    }
  | { id: string; type: 'image_view'; path: string }
  | {
      id: string;
      type: 'image_generation';
      status: 'in_progress' | 'completed' | 'failed';
      revised_prompt?: string;
      result?: string;
      saved_path?: string;
      transparent_background?: boolean;
      failure?: Record<string, unknown>;
    };

type CodexNonItemThreadEvent = Exclude<
  ThreadEvent,
  { type: 'item.started' | 'item.updated' | 'item.completed' }
>;

export type CodexAppServerThreadEvent =
  | CodexNonItemThreadEvent
  | {
      type: 'item.started' | 'item.updated' | 'item.completed';
      item: CodexAppServerThreadItem;
    }
  | { type: 'agent_message_delta'; itemId: string; delta: string }
  | { type: 'context.compacted'; itemId?: string }
  | { type: 'capacity.retrying'; attempt: number; maxAttempts: number; delayMs: number }
  | { type: 'capacity.recovered' }
  | { type: 'turn.interrupted' };

export interface CodexAppServerThreadOptions {
  resumeThreadId?: string;
  threadOptions: ThreadOptions;
  config: ConfigObject;
  /** Named Codex permission profile. Mutually exclusive with legacy sandbox mode. */
  permissionProfile?: string;
  clientOptions?: CodexAppServerClientOptions;
  /** Testable retry policy for transient remote model/service failures. */
  capacityRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    random?: () => number;
  };
}

const DEFAULT_CAPACITY_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 16_000,
  jitterRatio: 0.2,
} as const;

const CAPACITY_CONTINUATION_INPUT = [
  {
    type: 'text',
    text: '继续完成刚才因远端模型繁忙而中断的同一任务。沿用当前会话中已有的上下文和已完成结果，不要重复已经成功执行的命令、工具调用或文件发布。',
    text_elements: [],
  },
] as const;

const warnedUnsupportedAppServerEvents = new Set<string>();

function warnUnsupportedAppServerEvent(kind: 'notification' | 'item', name: string): void {
  const key = `${kind}:${name}`;
  if (!name || warnedUnsupportedAppServerEvents.has(key)) return;
  warnedUnsupportedAppServerEvents.add(key);
  console.warn(`[Codex app-server] Unsupported ${kind} type: ${name}`);
}

function capacityRetryDelayMs(
  attempt: number,
  input: NonNullable<CodexAppServerThreadOptions['capacityRetry']> = {}
): number {
  const baseDelayMs = input.baseDelayMs ?? DEFAULT_CAPACITY_RETRY.baseDelayMs;
  const maxDelayMs = input.maxDelayMs ?? DEFAULT_CAPACITY_RETRY.maxDelayMs;
  const jitterRatio = input.jitterRatio ?? DEFAULT_CAPACITY_RETRY.jitterRatio;
  const random = input.random ?? Math.random;
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve(true);
    }, delayMs);
    const cancel = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function appStatus(value: unknown): 'in_progress' | 'completed' | 'failed' {
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'declined') return 'failed';
  return 'in_progress';
}

function convertMcpResult(value: unknown) {
  const result = record(value);
  if (!result) return undefined;
  return {
    content: Array.isArray(result.content) ? result.content : [],
    _meta: result._meta,
    structured_content: result.structuredContent,
  };
}

export function convertAppServerThreadItem(value: unknown): CodexAppServerThreadItem | undefined {
  const item = record(value);
  const id = text(item?.id);
  const type = text(item?.type);
  if (!item || !id) return undefined;

  switch (type) {
    case 'agentMessage':
      return { id, type: 'agent_message', text: text(item.text) };
    case 'reasoning': {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter(part => typeof part === 'string')
        : [];
      const content = Array.isArray(item.content)
        ? item.content.filter(part => typeof part === 'string')
        : [];
      return { id, type: 'reasoning', text: [...summary, ...content].join('\n') };
    }
    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: text(item.command),
        aggregated_output: text(item.aggregatedOutput),
        ...(typeof item.exitCode === 'number' ? { exit_code: item.exitCode } : {}),
        status: appStatus(item.status),
      };
    case 'fileChange': {
      const status =
        item.status === 'failed' || item.status === 'declined' ? 'failed' : 'completed';
      const changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }> = Array.isArray(
        item.changes
      )
        ? item.changes.flatMap(
            (
              entry
            ): Array<{
              path: string;
              kind: 'add' | 'delete' | 'update';
            }> => {
              const change = record(entry);
              const changePath = text(change?.path);
              const kind = change?.kind;
              return changePath && (kind === 'add' || kind === 'delete' || kind === 'update')
                ? [{ path: changePath, kind }]
                : [];
            }
          )
        : [];
      return { id, type: 'file_change', changes, status };
    }
    case 'mcpToolCall': {
      const error = record(item.error);
      return {
        id,
        type: 'mcp_tool_call',
        server: text(item.server),
        tool: text(item.tool),
        arguments: item.arguments,
        ...(convertMcpResult(item.result) ? { result: convertMcpResult(item.result) } : {}),
        ...(text(error?.message) ? { error: { message: text(error?.message) } } : {}),
        status: appStatus(item.status),
      };
    }
    case 'dynamicToolCall': {
      const contentItems = Array.isArray(item.contentItems)
        ? item.contentItems.flatMap((candidate): CodexDynamicToolOutputContentItem[] => {
            const content = record(candidate);
            if (content?.type === 'inputText' && typeof content.text === 'string') {
              return [{ type: 'inputText', text: content.text }];
            }
            if (content?.type === 'inputImage' && typeof content.imageUrl === 'string') {
              return [{ type: 'inputImage', imageUrl: content.imageUrl }];
            }
            if (content?.type === 'inputAudio' && typeof content.audioUrl === 'string') {
              return [{ type: 'inputAudio', audioUrl: content.audioUrl }];
            }
            return [];
          })
        : undefined;
      return {
        id,
        type: 'dynamic_tool_call',
        namespace: typeof item.namespace === 'string' ? item.namespace : null,
        tool: text(item.tool),
        arguments: item.arguments,
        status: appStatus(item.status),
        ...(contentItems?.length ? { content_items: contentItems } : {}),
        ...(typeof item.success === 'boolean' ? { success: item.success } : {}),
      };
    }
    case 'webSearch':
      return { id, type: 'web_search', query: text(item.query) };
    case 'imageView':
      return { id, type: 'image_view', path: text(item.path) };
    case 'imageGeneration': {
      const failure = record(item.failure);
      return {
        id,
        type: 'image_generation',
        status: appStatus(item.status),
        ...(text(item.revisedPrompt) ? { revised_prompt: text(item.revisedPrompt) } : {}),
        ...(text(item.result) ? { result: text(item.result) } : {}),
        ...(text(item.savedPath) ? { saved_path: text(item.savedPath) } : {}),
        ...(typeof item.transparentBackground === 'boolean'
          ? { transparent_background: item.transparentBackground }
          : {}),
        ...(failure ? { failure } : {}),
      };
    }
    default:
      return undefined;
  }
}

function convertInput(input: CodexInput): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input, text_elements: [] }];
  }
  return input.map(part =>
    part.type === 'local_image'
      ? { type: 'localImage', path: part.path }
      : { type: 'text', text: part.text, text_elements: [] }
  );
}

function convertUsage(value: unknown): Usage | undefined {
  const notification = record(value);
  const tokenUsage = record(notification?.tokenUsage);
  const last = record(tokenUsage?.last);
  if (!last) return undefined;
  return {
    input_tokens: Number(last.inputTokens) || 0,
    cached_input_tokens: Number(last.cachedInputTokens) || 0,
    cache_write_input_tokens: Number(last.cacheWriteInputTokens) || 0,
    output_tokens: Number(last.outputTokens) || 0,
    reasoning_output_tokens: Number(last.reasoningOutputTokens) || 0,
  };
}

function notificationMatches(
  notification: CodexAppServerNotification,
  threadId: string,
  turnId: string
): boolean {
  const eventThreadId = text(notification.params.threadId);
  const eventTurnId =
    text(notification.params.turnId) || text(record(notification.params.turn)?.id);
  if (eventThreadId && eventThreadId !== threadId) return false;
  if (eventTurnId && eventTurnId !== turnId) return false;
  return true;
}

function isMissingDurableThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bno rollout found for thread id\b|\bthread\b.*\b(?:not found|does not exist)\b/iu.test(
    message
  );
}

/**
 * Thread-shaped adapter over `codex app-server`.
 *
 * Codex still talks to the configured Responses provider over HTTPS/SSE. The
 * app-server process is local stdio IPC and is used because it exposes the
 * assistant delta and interrupt events omitted by the public TypeScript SDK.
 */
export class CodexAppServerThread {
  id: string | null;
  private activeClient: CodexAppServerClient | null = null;
  private activeTurnId: string | null = null;

  constructor(private readonly options: CodexAppServerThreadOptions) {
    this.id = options.resumeThreadId ?? null;
  }

  async runStreamed(
    input: CodexInput,
    turnOptions?: TurnOptions
  ): Promise<{ events: AsyncGenerator<CodexAppServerThreadEvent> }> {
    const client = new CodexAppServerClient(this.options.clientOptions);
    const { threadOptions } = this.options;
    const permissionProfile = this.options.permissionProfile?.trim();
    const configWithoutLegacySandbox = permissionProfile
      ? Object.fromEntries(
          Object.entries(this.options.config).filter(
            ([key]) => key !== 'sandbox_mode' && key !== 'sandbox_workspace_write'
          )
        )
      : this.options.config;
    const appServerParams: Record<string, unknown> = {
      model: threadOptions.model ?? null,
      cwd: threadOptions.workingDirectory ?? null,
      approvalPolicy: threadOptions.approvalPolicy ?? null,
      ...(permissionProfile
        ? { permissions: permissionProfile }
        : { sandbox: threadOptions.sandboxMode ?? null }),
      config: permissionProfile
        ? configWithoutLegacySandbox
        : {
            ...configWithoutLegacySandbox,
            sandbox_workspace_write: {
              ...(record(configWithoutLegacySandbox.sandbox_workspace_write) ?? {}),
              network_access: threadOptions.networkAccessEnabled ?? false,
              ...(threadOptions.additionalDirectories?.length
                ? { writable_roots: threadOptions.additionalDirectories }
                : {}),
            },
          },
    };
    const dynamicToolSpecs = this.options.clientOptions?.dynamicTools?.map(({ spec }) => spec) ?? [];

    let thread: { id: string; result: Record<string, unknown> };
    if (this.options.resumeThreadId) {
      const resumeParams = { threadId: this.options.resumeThreadId, ...appServerParams };
      try {
        thread = await client.resumeThread(resumeParams);
      } catch (error) {
        if (isMissingDurableThreadError(error)) {
          // Disco may move to a dedicated Runtime Home while its database still
          // contains thread ids created by the desktop Codex installation. The
          // old rollout is intentionally unavailable in that isolated home.
          // Start a new durable thread and let the prompt service replace the
          // stored id before streaming the first event.
          thread = await client.startThread({
            ...appServerParams,
            serviceName: 'disco',
            threadSource: 'disco',
            ...(dynamicToolSpecs.length > 0 ? { dynamicTools: dynamicToolSpecs } : {}),
          });
        } else {
          await client.close();
          throw error;
        }
      }
    } else {
      thread = await client.startThread({
        ...appServerParams,
        serviceName: 'disco',
        threadSource: 'disco',
        ...(dynamicToolSpecs.length > 0 ? { dynamicTools: dynamicToolSpecs } : {}),
      });
    }
    this.id = thread.id;

    const convertedInput = convertInput(input);
    const turn = await client.startTurn({
      threadId: thread.id,
      input: convertedInput,
      ...(threadOptions.modelReasoningEffort ? { effort: threadOptions.modelReasoningEffort } : {}),
      ...(turnOptions?.outputSchema ? { outputSchema: turnOptions.outputSchema } : {}),
    });
    this.activeClient = client;
    this.activeTurnId = turn.id;

    return {
      events: this.streamTurn(client, thread.id, turn.id, convertedInput, turnOptions),
    };
  }

  async steer(input: CodexInput): Promise<void> {
    const deadline = Date.now() + 15_000;
    while ((!this.activeClient || !this.id || !this.activeTurnId) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const client = this.activeClient;
    const threadId = this.id;
    const turnId = this.activeTurnId;
    if (!client || !threadId || !turnId) {
      throw new Error('Codex turn is not ready to receive additional guidance');
    }
    await client.steerTurn({ threadId, turnId, input: convertInput(input) });
  }

  private async *streamTurn(
    client: CodexAppServerClient,
    threadId: string,
    initialTurnId: string,
    input: ReturnType<typeof convertInput>,
    turnOptions?: TurnOptions
  ): AsyncGenerator<CodexAppServerThreadEvent> {
    const signal = turnOptions?.signal;
    let turnId = initialTurnId;
    let latestUsage: Usage | undefined;
    let interruptError: unknown;
    let contextCompactionEmitted = false;
    let capacityError: string | null = null;
    let capacityRetryCount = 0;
    let capacityRetryActive = false;
    let retryInput = input;
    let continuationMode = false;
    let hasSubstantiveActivity = false;
    const maxCapacityRetries =
      this.options.capacityRetry?.maxAttempts ?? DEFAULT_CAPACITY_RETRY.maxAttempts;
    const interrupt = () => {
      void client.interruptTurn(threadId, turnId).catch(error => {
        interruptError = error;
        // Wake a notification iterator that would otherwise remain blocked
        // after a failed interrupt request.
        void client.close();
      });
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    if (signal?.aborted) interrupt();

    try {
      for await (const notification of client.notifications()) {
        if (!notificationMatches(notification, threadId, turnId)) continue;

        switch (notification.method) {
          case 'turn/started':
            yield { type: 'turn.started' };
            break;
          case 'item/agentMessage/delta': {
            const delta = text(notification.params.delta);
            if (delta) {
              if (capacityRetryActive) {
                capacityRetryActive = false;
                yield { type: 'capacity.recovered' };
              }
              hasSubstantiveActivity = true;
              yield {
                type: 'agent_message_delta',
                itemId: text(notification.params.itemId),
                delta,
              };
            }
            break;
          }
          case 'item/started':
          case 'item/completed': {
            const rawItem = record(notification.params.item);
            if (capacityRetryActive) {
              capacityRetryActive = false;
              yield { type: 'capacity.recovered' };
            }
            hasSubstantiveActivity = true;
            if (
              notification.method === 'item/completed' &&
              rawItem?.type === 'contextCompaction' &&
              !contextCompactionEmitted
            ) {
              contextCompactionEmitted = true;
              yield {
                type: 'context.compacted',
                ...(text(rawItem.id) ? { itemId: text(rawItem.id) } : {}),
              };
            }
            const item = convertAppServerThreadItem(rawItem);
            if (item) {
              yield {
                type: notification.method === 'item/started' ? 'item.started' : 'item.completed',
                item,
              };
            } else if (
              typeof rawItem?.type === 'string' &&
              rawItem.type !== 'contextCompaction'
            ) {
              warnUnsupportedAppServerEvent('item', rawItem.type);
            }
            break;
          }
          case 'thread/compacted':
            if (!contextCompactionEmitted) {
              contextCompactionEmitted = true;
              yield { type: 'context.compacted' };
            }
            break;
          case 'turn/plan/updated': {
            const plan = Array.isArray(notification.params.plan) ? notification.params.plan : [];
            const items = plan.flatMap(entry => {
              const step = record(entry);
              const stepText = text(step?.step);
              return stepText ? [{ text: stepText, completed: step?.status === 'completed' }] : [];
            });
            if (items.length > 0) {
              if (capacityRetryActive) {
                capacityRetryActive = false;
                yield { type: 'capacity.recovered' };
              }
              hasSubstantiveActivity = true;
              yield {
                type: 'item.updated',
                item: { id: `plan-${turnId}`, type: 'todo_list', items },
              };
            }
            break;
          }
          case 'thread/tokenUsage/updated':
            latestUsage = convertUsage(notification.params) ?? latestUsage;
            break;
          case 'error':
            if (isCodexCapacityError(notification.params)) {
              capacityError =
                text(notification.params.message) ||
                text(record(notification.params.error)?.message) ||
                'Selected model is at capacity';
              break;
            }
            yield {
              type: 'error',
              message:
                text(notification.params.message) ||
                text(record(notification.params.error)?.message) ||
                'Codex app-server stream error',
            };
            break;
          case 'turn/completed': {
            const turn = record(notification.params.turn);
            const status = text(turn?.status);
            if (status === 'interrupted' || signal?.aborted) {
              yield { type: 'turn.interrupted' };
            } else if (status === 'failed') {
              const error = record(turn?.error);
              const failureMessage =
                text(error?.message) || text(error?.additionalDetails) || 'Codex turn failed';
              const failedForCapacity =
                capacityError !== null || isCodexCapacityError(failureMessage);
              const nextAttempt = capacityRetryCount + 1;
              const canRetry = nextAttempt <= maxCapacityRetries;
              const retryDelay = canRetry
                ? capacityRetryDelayMs(nextAttempt, this.options.capacityRetry)
                : undefined;
              if (failedForCapacity && retryDelay !== undefined && canRetry) {
                yield {
                  type: 'capacity.retrying',
                  attempt: nextAttempt,
                  maxAttempts: maxCapacityRetries,
                  delayMs: retryDelay,
                };
                if (!(await waitForRetry(retryDelay, signal))) {
                  yield { type: 'turn.interrupted' };
                  return;
                }
                capacityRetryCount = nextAttempt;
                if (hasSubstantiveActivity || continuationMode) {
                  continuationMode = true;
                  retryInput = CAPACITY_CONTINUATION_INPUT.map(part => ({ ...part }));
                } else {
                  retryInput = input;
                }
                const retryTurn = await client.startTurn({
                  threadId,
                  input: retryInput,
                  ...(this.options.threadOptions.modelReasoningEffort
                    ? { effort: this.options.threadOptions.modelReasoningEffort }
                    : {}),
                  ...(turnOptions?.outputSchema ? { outputSchema: turnOptions.outputSchema } : {}),
                });
                turnId = retryTurn.id;
                this.activeTurnId = retryTurn.id;
                latestUsage = undefined;
                capacityError = null;
                contextCompactionEmitted = false;
                capacityRetryActive = true;
                hasSubstantiveActivity = false;
                continue;
              }
              yield {
                type: 'turn.failed',
                error: {
                  message: failedForCapacity ? codexCapacityUserMessage() : failureMessage,
                },
              };
            } else {
              if (capacityRetryActive) {
                capacityRetryActive = false;
                yield { type: 'capacity.recovered' };
              }
              yield {
                type: 'turn.completed',
                usage: latestUsage ?? {
                  input_tokens: 0,
                  cached_input_tokens: 0,
                  cache_write_input_tokens: 0,
                  output_tokens: 0,
                  reasoning_output_tokens: 0,
                },
              };
            }
            return;
          }
          default:
            warnUnsupportedAppServerEvent('notification', notification.method);
            break;
        }
      }

      if (interruptError) throw interruptError;
      if (capacityError) throw new Error(codexCapacityUserMessage());
      throw new Error('Codex app-server notification stream ended before turn completion');
    } finally {
      signal?.removeEventListener('abort', interrupt);
      if (this.activeClient === client) {
        this.activeClient = null;
        this.activeTurnId = null;
      }
      await client.close();
    }
  }
}
