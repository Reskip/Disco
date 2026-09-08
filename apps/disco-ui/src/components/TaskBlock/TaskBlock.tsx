/**
 * TaskBlock - Collapsible task section containing messages
 *
 * Features:
 * - Collapsed: Shows task summary with metadata
 * - Expanded: Shows all messages in the task
 * - Default: Latest task expanded, older collapsed
 * - Progressive disclosure pattern
 * - Groups 3+ sequential tool-only messages into ToolBlock
 */

// TODO: Move normalization to DB or daemon API
import { DownOutlined, FileTextOutlined, UpOutlined } from '@ant-design/icons';
import type { AgenticToolName, DiscoClient, StreamingMessageState } from '@disco-live/client';
import {
  type Message,
  MessageRole,
  type PermissionRequestContent,
  type PermissionScope,
  PermissionStatus,
  type SessionID,
  type Task,
  TaskStatus,
  type User,
} from '@disco-live/client';
import { Alert, Button, Collapse, Flex, Spin, Typography, theme } from 'antd';
import React, { useMemo, useRef, useState } from 'react';
import { getContextWindowGradient } from '../../utils/contextWindow';
import { AgentChain } from '../AgentChain';
import { CompactionBlock } from '../CompactionBlock';
import { CopyableContent } from '../CopyableContent';
import { MessageBlock } from '../MessageBlock';
import { CreatedByTag } from '../metadata/CreatedByTag';
import { ContextWindowPill, ModelPill, ScheduledRunPill, TimerPill, TokenCountPill } from '../Pill';
import { RateLimitBlock } from '../RateLimitBlock';
import { Tag } from '../Tag';
import { TaskStatusIcon } from '../TaskStatusIcon';

const { Paragraph } = Typography;

// Default-param `= new Map()` would mint a fresh Map per render and defeat
// the MessageBlock memos below whenever the prop is omitted.
const EMPTY_USER_MAP = new Map<string, User>();

/**
 * Block types for rendering
 */
export type Block =
  | { type: 'message'; message: Message }
  | { type: 'agent-chain'; messages: Message[] }
  | { type: 'compaction'; messages: Message[] }; // System messages (start + optional complete)

interface TaskBlockProps {
  task: Task;
  agentic_tool?: string;
  sessionModel?: string;
  userById?: Map<string, User>;
  currentUserId?: string;
  isExpanded: boolean;
  /**
   * Called when the user toggles this task's expand state. Receives the
   * `taskId` so the parent can use a single stable callback shared across
   * every TaskBlock — see ConversationView's `handleTaskExpandChange`.
   */
  onExpandChange: (taskId: string, expanded: boolean) => void;
  sessionId?: SessionID | null;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
  branchName?: string;
  isScheduled?: boolean;
  scheduledRunAt?: number;
  streamingMessages?: Map<string, StreamingMessageState>;
  taskMessages: Message[];
  taskMessagesLoaded: boolean;
  onLoadTaskMessages: (taskId: string) => Promise<void> | void;
  onUnloadTaskMessages: (taskId: string) => void;
  teammateEmoji?: string;
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
  /** Authenticated Feathers client, forwarded to MessageBlock → WidgetBlock for inline submission. */
  client?: DiscoClient | null;
  /** Whether this is the most recent task in the session */
  isLatestTask?: boolean;
  /** Render as a continuous conversation without task/branch chrome. */
  simpleMode?: boolean;
}

/**
 * Check if a system message is an SDK status event (rate limit, API wait, or other SDK event).
 * These render via RateLimitBlock instead of the regular MessageBlock.
 */
function isSdkStatusMessage(message: Message): boolean {
  if (message.role !== MessageRole.SYSTEM || !Array.isArray(message.content)) return false;
  return message.content.some(
    (b) => b.type === 'rate_limit' || b.type === 'api_wait' || b.type === 'sdk_event'
  );
}

/** Durable outcome projection; re-renders are inherently idempotent. */
export function isVerifiedRuntimeInterruption(task: Task, isLatestTask = false): boolean {
  return (
    isLatestTask &&
    task.status === TaskStatus.FAILED &&
    task.sdk_failure?.termination === 'verified' &&
    task.termination_request?.cause !== 'user_stop'
  );
}

/** Presentation policy: keep STOPPING output visible until a durable terminal projection arrives. */
export function shouldRenderLiveTaskProgress(task: Task): boolean {
  return task.status === TaskStatus.RUNNING || task.status === TaskStatus.STOPPING;
}

function RuntimeInterruptionNotice({
  task,
  sessionId,
  client,
}: {
  task: Task;
  sessionId?: SessionID | null;
  client?: DiscoClient | null;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [resumed, setResumed] = useState(false);
  const handleResume = async () => {
    if (!client || !sessionId) return;
    setSubmitting(true);
    try {
      // This deliberately starts a new durable Task. It never attempts to
      // revive the failed Task or reuse its executor ownership.
      await client.sessions.prompt(
        sessionId,
        '请先检查上一个被中断任务的状态，然后从中断处安全地继续。'
      );
      setResumed(true);
    } catch (error) {
      console.error('Failed to resume after runtime interruption:', error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="任务已中断"
      description={
        task.sdk_failure?.reason === 'startup_timeout'
          ? '执行器未能及时启动。Disco 已完成安全检查，现在可以继续发送消息。'
          : 'Disco 与执行器失去连接，完成安全检查后已恢复此会话。'
      }
      action={
        client && sessionId && !resumed ? (
          <Button size="small" type="primary" loading={submitting} onClick={handleResume}>
            作为新任务继续
          </Button>
        ) : undefined
      }
    />
  );
}

function getTaskElapsedMs(task: Task, nowMs = Date.now()): number {
  const isLive = shouldRenderLiveTaskProgress(task);
  if (!isLive && typeof task.duration_ms === 'number' && task.duration_ms > 0) {
    return task.duration_ms;
  }

  const startedAt =
    task.started_at || task.message_range?.start_timestamp || task.created_at || undefined;
  const endedAt = isLive
    ? undefined
    : task.completed_at || task.message_range?.end_timestamp || undefined;
  const start = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  const end = endedAt ? new Date(endedAt).getTime() : nowMs;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
}

function formatTaskElapsed(task: Task, nowMs = Date.now()): string {
  const elapsedMs = getTaskElapsedMs(task, nowMs);

  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${remainingSeconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} 小时 ${remainingMinutes} 分 ${remainingSeconds} 秒`;
}

function TaskTurnStatus({ task }: { task: Task }) {
  const isLive = shouldRenderLiveTaskProgress(task);
  const [nowMs, setNowMs] = useState(() => Date.now());

  React.useEffect(() => {
    if (!isLive) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isLive]);

  return (
    <div className="disco-task-turn-divider" data-testid="task-turn-status">
      <span>
        {isLive ? '处理中' : '已处理'} {formatTaskElapsed(task, nowMs)}
      </span>
    </div>
  );
}

function isAgentChainMessage(message: Message): boolean {
  // EXCEPTION: User messages with ONLY tool_result blocks are part of agent execution
  // (tool results are technically "user" role per Anthropic API, but they're automated responses)
  if (message.role === MessageRole.USER && Array.isArray(message.content)) {
    const hasOnlyToolResults = message.content.every((block) => block.type === 'tool_result');
    if (hasOnlyToolResults) return true; // Part of agent chain, don't break it
  }

  // Only agent messages beyond this point
  if (message.role !== MessageRole.ASSISTANT) return false;

  // String content - this is user-facing response, NOT agent chain
  if (typeof message.content === 'string') {
    return !message.content.trim(); // Empty = not a response
  }

  // Empty content
  if (!message.content) return false;

  // Array content - check what types of blocks we have
  if (Array.isArray(message.content)) {
    const hasTools = message.content.some((block) => block.type === 'tool_use');
    const hasThinking = message.content.some((block) => block.type === 'thinking');
    const hasText = message.content.some((block) => block.type === 'text');

    // SPECIAL: Task tools should display as regular agent messages, not in chain
    const hasOnlyTaskTool =
      message.content.length === 1 &&
      message.content[0].type === 'tool_use' &&
      (message.content[0] as { name?: string }).name === 'Task';

    if (hasOnlyTaskTool) {
      return false; // Show as regular message bubble
    }

    // User-facing text wins over thinking/tool activity. MessageBlock already
    // separates the visible response from its supporting activity.
    if (hasText) return false;

    // Only tools/thinking, no text = pure agent chain
    if (hasTools || hasThinking) return true;

    // Only text blocks = user-facing response
    return false;
  }

  return false;
}

/**
 * Group messages into blocks:
 * - Consecutive agent messages with thoughts/tools → AgentChain
 * - User messages and agent text responses → individual MessageBlocks
 * - Task tool nested operations → AgentChain (grouped by parent_tool_use_id)
 * - Compaction events (system_status + system_complete) → Compaction block
 * - Permission requests are now just messages, rendered inline naturally
 */
export function groupMessagesIntoBlocks(messages: Message[]): Block[] {
  // Separate top-level messages from nested (parent_tool_use_id)
  const topLevel = messages.filter((m) => !m.parent_tool_use_id);
  const nested = messages.filter((m) => m.parent_tool_use_id);

  // Build compaction event map: task_id -> [start_message, complete_message?]
  // We aggregate compaction events that share the same task_id
  const compactionEventsByTask = new Map<string, Message[]>();
  for (const msg of topLevel) {
    if (msg.role === MessageRole.SYSTEM && Array.isArray(msg.content)) {
      const hasCompactionStatus = msg.content.some(
        (b) =>
          (b.type === 'system_status' && 'status' in b && b.status === 'compacting') ||
          (b.type === 'system_complete' && 'systemType' in b && b.systemType === 'compaction')
      );
      if (hasCompactionStatus && msg.task_id) {
        if (!compactionEventsByTask.has(msg.task_id)) {
          compactionEventsByTask.set(msg.task_id, []);
        }
        compactionEventsByTask.get(msg.task_id)!.push(msg);
      }
    }
  }

  // Get set of message IDs that are part of compaction blocks (to skip in main loop)
  const compactionMessageIds = new Set<string>();
  for (const compactionMessages of compactionEventsByTask.values()) {
    for (const msg of compactionMessages) {
      compactionMessageIds.add(msg.message_id);
    }
  }

  // Collect all Task tool use IDs for special handling
  const taskToolIds = new Set<string>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && (block as { name?: string }).name === 'Task') {
          taskToolIds.add((block as { id?: string }).id || '');
        }
      }
    }
  }

  // Group nested messages by parent tool use ID
  const nestedByParent = new Map<string, Message[]>();
  for (const msg of nested) {
    if (!msg.parent_tool_use_id) continue;
    if (!nestedByParent.has(msg.parent_tool_use_id)) {
      nestedByParent.set(msg.parent_tool_use_id, []);
    }
    nestedByParent.get(msg.parent_tool_use_id)!.push(msg);
  }

  // Build map of tool_use_id -> tool_result message for Task tools
  const taskResultsByToolId = new Map<string, Message>();
  for (const msg of topLevel) {
    if (msg.role === MessageRole.USER && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
          if (toolUseId && taskToolIds.has(toolUseId)) {
            taskResultsByToolId.set(toolUseId, msg);
          }
        }
      }
    }
  }

  const blocks: Block[] = [];
  let agentBuffer: Message[] = [];

  for (const msg of topLevel) {
    // Skip compaction messages - they'll be added as aggregated blocks later
    if (compactionMessageIds.has(msg.message_id)) {
      continue;
    }

    // Check if this is a Task tool result (user message with tool_result for a Task tool)
    const isTaskResult =
      msg.role === MessageRole.USER &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (block) =>
          block.type === 'tool_result' &&
          taskToolIds.has((block as { tool_use_id?: string }).tool_use_id || '')
      );

    // Skip Task results - they'll be included with their nested operations below
    if (isTaskResult) {
      continue;
    }

    // Regular message handling
    if (!isAgentChainMessage(msg)) {
      // Flush agent buffer if we have any
      if (agentBuffer.length > 0) {
        blocks.push({ type: 'agent-chain', messages: agentBuffer });
        agentBuffer = [];
      }

      // Add the current message as individual block
      blocks.push({ type: 'message', message: msg });
    } else {
      // Accumulate agent chain messages
      agentBuffer.push(msg);
    }

    // After processing the message, check if it has Task tool uses
    // If so, add nested operations + result as a regular agent-chain
    const taskTools = msg.tool_uses?.filter((t) => t.name === 'Task') || [];
    for (const taskTool of taskTools) {
      const children = nestedByParent.get(taskTool.id) || [];
      const resultMsg = taskResultsByToolId.get(taskTool.id);

      // Combine nested operations with result message
      const chainMessages = [...children];
      if (resultMsg) {
        chainMessages.push(resultMsg);
      }

      if (chainMessages.length > 0) {
        // Flush agent buffer before nested operations
        if (agentBuffer.length > 0) {
          blocks.push({ type: 'agent-chain', messages: agentBuffer });
          agentBuffer = [];
        }

        // Show nested operations + result as a regular agent chain
        blocks.push({ type: 'agent-chain', messages: chainMessages });
      }
    }
  }

  // Flush remaining buffer
  if (agentBuffer.length > 0) {
    blocks.push({ type: 'agent-chain', messages: agentBuffer });
  }

  // Add compaction blocks, inserting them at the correct position based on first message's index
  // Sort compaction events by their first message's index
  const compactionBlocks: Array<{ block: Block; index: number }> = [];
  for (const compactionMessages of compactionEventsByTask.values()) {
    if (compactionMessages.length > 0) {
      // Sort messages within each compaction group (start should come before complete)
      const sortedMessages = [...compactionMessages].sort((a, b) => a.index - b.index);
      compactionBlocks.push({
        block: { type: 'compaction', messages: sortedMessages },
        index: sortedMessages[0].index, // Use first message's index for positioning
      });
    }
  }

  // Insert compaction blocks at their correct positions
  for (const { block, index: compactionIndex } of compactionBlocks) {
    // Find where to insert based on message index
    let insertPosition = 0;
    for (let i = 0; i < blocks.length; i++) {
      const currentBlock = blocks[i];
      const blockIndex =
        currentBlock.type === 'message'
          ? currentBlock.message.index
          : (currentBlock.messages[0]?.index ?? 0);

      if (blockIndex < compactionIndex) {
        insertPosition = i + 1;
      } else {
        break;
      }
    }
    blocks.splice(insertPosition, 0, block);
  }

  // Display-order only: stable-move widget_request blocks to the END of the
  // task's block list so an inline widget (e.g. the gateway token form) renders
  // BELOW the agent's closing text for the same turn — making it the last thing
  // the user sees. Widgets are stamped at tool-call time (mid-turn), so by
  // message index they'd otherwise sort above the agent's closing explanation.
  // Non-widget blocks keep their original order; widget blocks keep their
  // relative order at the end. This touches render order ONLY — message.index /
  // identity (genealogy markers, streaming, React keys) are untouched.
  const isWidgetBlock = (b: Block): boolean =>
    b.type === 'message' && b.message.type === 'widget_request';
  if (blocks.some(isWidgetBlock)) {
    return [...blocks.filter((b) => !isWidgetBlock(b)), ...blocks.filter(isWidgetBlock)];
  }

  return blocks;
}

/**
 * Identity key for reconciling a block across renders — mirrors the React
 * `key` each block type renders with.
 */
function getBlockKey(block: Block): string {
  return block.type === 'message'
    ? `m:${block.message.message_id}`
    : `${block.type}:${block.messages[0]?.message_id || 'unknown'}`;
}

/**
 * Marker value for a block's `data-conversation-block` wrapper. In-session
 * search re-scans on the 'streaming' → 'settled' attribute flip: a message
 * that finishes streaming settles inside the SAME wrapper node (same key), so
 * without the flip its final text would only become findable at the next
 * block mount/unmount.
 */
function getBlockMarker(block: Block): 'streaming' | 'settled' {
  const messages = block.type === 'message' ? [block.message] : block.messages;
  return messages.some((m) => (m as { isStreaming?: boolean }).isStreaming === true)
    ? 'streaming'
    : 'settled';
}

/** Same composition: identical message references in identical order. */
function blocksHaveSameMessages(a: Block, b: Block): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'message' && b.type === 'message') return a.message === b.message;
  const aMessages = (a as { messages: Message[] }).messages;
  const bMessages = (b as { messages: Message[] }).messages;
  if (aMessages.length !== bMessages.length) return false;
  return aMessages.every((msg, i) => msg === bMessages[i]);
}

export function findTurnStatusInsertIndex(blocks: Block[]): number {
  const firstNonUserBlock = blocks.findIndex(
    (block) => block.type !== 'message' || block.message.role !== MessageRole.USER
  );
  return firstNonUserBlock === -1 ? blocks.length : firstNonUserBlock;
}

export function findActiveAgentChainIndex(blocks: Block[]): number {
  return blocks.at(-1)?.type === 'agent-chain' ? blocks.length - 1 : -1;
}

/**
 * A compaction start remains the task's sole visible live activity until its
 * matching completion event arrives. This prevents the generic thinking and
 * tool indicators from showing a second spinner beside compaction.
 */
export function findActiveCompactionIndex(blocks: Block[]): number {
  return blocks.findIndex((block) => {
    if (block.type !== 'compaction') return false;
    const hasStart = block.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (content) =>
            content.type === 'system_status' &&
            'status' in content &&
            content.status === 'compacting'
        )
    );
    const hasComplete = block.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (content) =>
            content.type === 'system_complete' &&
            'systemType' in content &&
            content.systemType === 'compaction'
        )
    );
    return hasStart && !hasComplete;
  });
}

export const TaskBlock = React.memo<TaskBlockProps>(
  ({
    task,
    agentic_tool,
    sessionModel,
    userById = EMPTY_USER_MAP,
    currentUserId,
    isExpanded,
    onExpandChange,
    sessionId,
    onPermissionDecision,
    isScheduled,
    scheduledRunAt,
    streamingMessages,
    taskMessages,
    taskMessagesLoaded,
    onLoadTaskMessages,
    onUnloadTaskMessages,
    teammateEmoji,
    onOpenAgenticToolSettings,
    isLatestTask = false,
    simpleMode = true,
    client = null,
  }) => {
    const { token } = theme.useToken();
    const runtimeLive = shouldRenderLiveTaskProgress(task);

    const [reactiveMessagesLoading, setReactiveMessagesLoading] = React.useState(false);

    React.useEffect(() => {
      if (simpleMode || isExpanded) {
        if (!taskMessagesLoaded) {
          setReactiveMessagesLoading(true);
          Promise.resolve(onLoadTaskMessages(task.task_id))
            .catch((error) => {
              console.error('[TaskBlock] Failed to load task messages:', error);
            })
            .finally(() => {
              setReactiveMessagesLoading(false);
            });
        }
      } else if (onUnloadTaskMessages && taskMessagesLoaded) {
        onUnloadTaskMessages(task.task_id);
      }
    }, [
      isExpanded,
      onLoadTaskMessages,
      onUnloadTaskMessages,
      simpleMode,
      task.task_id,
      taskMessagesLoaded,
    ]);
    const messagesLoading = reactiveMessagesLoading && !taskMessagesLoaded;

    // Convert streaming messages map to array once the reference changes
    const streamingForTask = useMemo(
      () => (streamingMessages ? Array.from(streamingMessages.values()) : []),
      [streamingMessages]
    );

    // Merge task messages with streaming messages (for running tasks)
    const messages = useMemo(() => {
      const dbOnlyMessages =
        streamingMessages && streamingMessages.size > 0
          ? taskMessages.filter((msg) => !streamingMessages.has(msg.message_id))
          : taskMessages;

      return ([...dbOnlyMessages, ...streamingForTask] as Message[]).sort(
        (a, b) => a.index - b.index
      );
    }, [taskMessages, streamingForTask, streamingMessages]);

    // Group messages into blocks, then reconcile against the previous render:
    // a streaming chunk rebuilds `messages` (new array identity) every frame,
    // but only the streamed message's block actually changed. Reusing the
    // previous block objects — and crucially their `messages` arrays, which
    // are minted fresh by groupMessagesIntoBlocks — keeps the props of the
    // memoized AgentChain/CompactionBlock children reference-stable, so the
    // untouched (often large) tool-chain subtrees bail out of re-rendering.
    const prevBlocksRef = useRef<Block[]>([]);
    const blocks = useMemo(() => {
      const next = groupMessagesIntoBlocks(messages);
      const prevByKey = new Map(prevBlocksRef.current.map((b) => [getBlockKey(b), b]));
      const reconciled = next.map((block) => {
        const prev = prevByKey.get(getBlockKey(block));
        return prev && blocksHaveSameMessages(prev, block) ? prev : block;
      });
      prevBlocksRef.current = reconciled;
      return reconciled;
    }, [messages]);

    // Only a chain that is literally the latest chronological block is live.
    // Once the assistant emits user-facing text, the preceding activity group
    // settles; a later tool/thought starts a new AgentChain block.
    const activeAgentChainIndex = useMemo(() => findActiveAgentChainIndex(blocks), [blocks]);
    const activeCompactionIndex = useMemo(() => findActiveCompactionIndex(blocks), [blocks]);
    const compactionInProgress = runtimeLive && activeCompactionIndex >= 0;

    // In the simple conversation layout, the task status belongs to the turn
    // header: immediately after the user's leading message(s), before any
    // activity or assistant response. Tool-result messages are grouped into
    // agent chains, so they cannot accidentally move the header downward.
    const turnStatusInsertIndex = useMemo(() => {
      return findTurnStatusInsertIndex(blocks);
    }, [blocks]);

    const wrapSimpleTurnBlock = (
      block: Block,
      blockIndex: number,
      content: React.ReactNode
    ): React.ReactNode => (
      <React.Fragment key={getBlockKey(block)}>
        {simpleMode && blockIndex === turnStatusInsertIndex && (
          <>
            <TaskTurnStatus task={task} />
            {isVerifiedRuntimeInterruption(task, isLatestTask) && (
              <RuntimeInterruptionNotice task={task} sessionId={sessionId} client={client} />
            )}
          </>
        )}
        {content}
      </React.Fragment>
    );

    // Get normalized SDK response (computed by executor, stored in DB)
    const normalized = task.normalized_sdk_response || null;

    // Use computed context window from database (already summed across tasks since last compaction)
    // If undefined, it means the backend computation failed or hasn't run yet
    const contextSnapshot = normalized?.contextUsageSnapshot;
    const hasContextWindowUsage =
      !!contextSnapshot ||
      (typeof task.computed_context_window === 'number' && task.computed_context_window > 0);
    const contextWindowUsed = task.computed_context_window ?? contextSnapshot?.totalTokens ?? 0;
    const contextWindowLimit = contextSnapshot?.maxTokens ?? normalized?.contextWindowLimit ?? 0;
    const taskHeaderGradient = hasContextWindowUsage
      ? getContextWindowGradient(contextWindowUsed, contextWindowLimit, contextSnapshot, {
          normal: token.colorSuccessBg,
          warning: token.colorWarningBg,
          critical: token.colorErrorBg,
        })
      : undefined;

    // Task header shows when collapsed
    const taskHeader = (
      <Flex gap={token.sizeUnit * 2} style={{ width: '100%' }}>
        {/* Left column: Icons stacked vertically */}
        <Flex
          vertical
          align="center"
          gap={token.sizeUnit / 2}
          style={{ width: 'auto', paddingTop: token.sizeUnit }}
        >
          {isExpanded ? (
            <UpOutlined style={{ color: token.colorPrimary }} />
          ) : (
            <DownOutlined style={{ color: token.colorPrimary }} />
          )}
          <TaskStatusIcon status={task.status} size={16} />
        </Flex>

        {/* Right column: Content */}
        <Flex vertical flex={1} style={{ minWidth: 0 }}>
          {/* Full prompt rendered with one-line CSS ellipsis. The complete
              text stays in the DOM so users can recover it via the
              copy-overlay (matches MessageBlock's pattern) — no tooltip,
              which got in the way of normal hover behavior. */}
          <CopyableContent
            textContent={task.full_prompt || ''}
            // Default offsets place the icon outside the wrapper, but the
            // task header has rounded corners with overflow:hidden which
            // clips it. Pull the icon inside the prompt row instead.
            copyButtonOffset={{ top: 0, right: 0 }}
          >
            <Typography.Text
              ellipsis
              style={{
                marginBottom: token.sizeUnit,
                display: 'block',
                paddingRight: token.sizeUnit * 3,
              }}
            >
              {task.full_prompt || '用户消息'}
            </Typography.Text>
          </CopyableContent>

          {/* Task metadata */}
          <Flex wrap gap={token.sizeUnit}>
            <TimerPill
              status={task.status}
              startedAt={task.started_at || task.message_range?.start_timestamp || task.created_at}
              endedAt={
                task.completed_at ||
                (task.message_range?.end_timestamp !== task.message_range?.start_timestamp
                  ? task.message_range?.end_timestamp
                  : undefined)
              }
              durationMs={task.duration_ms}
              lastExecutorHeartbeatAt={task.last_executor_heartbeat_at}
              latestExecutorPulse={task.latest_executor_pulse}
            />
            {isScheduled && scheduledRunAt && (
              <ScheduledRunPill scheduledRunAt={scheduledRunAt} />
            )}
            {task.created_by && (
              <CreatedByTag
                createdBy={task.created_by}
                currentUserId={currentUserId}
                userById={userById}
                prefix="来自"
              />
            )}
            {normalized && (
              <TokenCountPill
                count={normalized.tokenUsage.totalTokens}
                inputTokens={normalized.tokenUsage.inputTokens}
                outputTokens={normalized.tokenUsage.outputTokens}
                cacheReadTokens={normalized.tokenUsage.cacheReadTokens}
                cacheCreationTokens={normalized.tokenUsage.cacheCreationTokens}
              />
            )}
            {hasContextWindowUsage && (
              <ContextWindowPill
                used={contextWindowUsed}
                limit={contextWindowLimit || 0}
                taskMetadata={{
                  model: task.model,
                  duration_ms: task.duration_ms,
                  agentic_tool,
                  raw_sdk_response: task.raw_sdk_response,
                  normalized_sdk_response: normalized ?? undefined,
                }}
              />
            )}
            {task.model && task.model !== sessionModel && <ModelPill model={task.model} />}
            {task.report && (
              <Tag icon={<FileTextOutlined />} color="green" style={{ fontSize: 11 }}>
                报告
              </Tag>
            )}
          </Flex>
        </Flex>
      </Flex>
    );

    return (
      <div data-task-block={task.task_id}>
        <Collapse
          className={simpleMode ? 'disco-simple-task-collapse' : undefined}
          ghost
          activeKey={simpleMode || isExpanded ? ['task-content'] : []}
          onChange={(keys) => {
            if (!simpleMode) onExpandChange(task.task_id, keys.length > 0);
          }}
          expandIcon={() => null}
          style={{
            background: 'transparent',
            margin: simpleMode ? 0 : `${token.sizeUnit * 3}px 0`,
            border: 'none',
          }}
          items={[
            {
              key: 'task-content',
              label: taskHeader,
              styles: {
                header: {
                  display: simpleMode ? 'none' : undefined,
                  padding: token.sizeUnit * 2,
                  alignItems: 'flex-start',
                  background: taskHeaderGradient || 'transparent',
                  borderRadius: isExpanded ? '8px 8px 0 0' : 8,
                },
                body: {
                  background: 'transparent',
                  padding: simpleMode ? 0 : `${token.sizeUnit * 2}px ${token.sizeUnit * 2}px`,
                },
              },
              children: (
                <div
                  className={simpleMode ? 'disco-task-turn' : undefined}
                  style={{ paddingTop: simpleMode ? 0 : token.sizeUnit }}
                >
                  {!simpleMode && isVerifiedRuntimeInterruption(task, isLatestTask) && (
                    <RuntimeInterruptionNotice task={task} sessionId={sessionId} client={client} />
                  )}
                  {/* Show loading spinner while fetching messages */}
                  {messagesLoading && !compactionInProgress && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        padding: `${token.sizeUnit * 2}px 0`,
                      }}
                    >
                      <Spin size="small" />
                    </div>
                  )}

                  {/* Render all blocks (messages and agent chains). Each block
                      gets a `data-conversation-block` wrapper: in-session
                      search's MutationObserver keys off these boundaries to
                      tell structural transcript changes (new message/chain,
                      task hydration, a block settling after streaming) apart
                      from per-frame streaming churn inside a block. */}
                  {!messagesLoading &&
                    blocks.map((block, blockIndex) => {
                      if (block.type === 'message') {
                        // Find if this is a permission request and if it's the first pending one
                        const isPermissionRequest = block.message.type === 'permission_request';
                        let isFirstPending = false;

                        if (isPermissionRequest) {
                          const content = block.message.content as PermissionRequestContent;
                          if (content.status === PermissionStatus.PENDING) {
                            // Check if this is the first pending permission request
                            isFirstPending = !blocks.slice(0, blockIndex).some((b) => {
                              if (b.type === 'message' && b.message.type === 'permission_request') {
                                const c = b.message.content as PermissionRequestContent;
                                return c.status === PermissionStatus.PENDING;
                              }
                              return false;
                            });
                          }
                        }

                        // Render SDK status messages (rate limit, API wait, etc.) with dedicated component
                        if (isSdkStatusMessage(block.message)) {
                          return wrapSimpleTurnBlock(
                            block,
                            blockIndex,
                            <div
                              key={block.message.message_id}
                              data-conversation-block={getBlockMarker(block)}
                            >
                              <RateLimitBlock message={block.message} agentic_tool={agentic_tool} />
                            </div>
                          );
                        }

                        // Check if this is the latest agent message (last message block)
                        const isLatestMessage =
                          block.message.role === MessageRole.ASSISTANT &&
                          blockIndex === blocks.length - 1;

                        return wrapSimpleTurnBlock(
                          block,
                          blockIndex,
                          <div
                            key={block.message.message_id}
                            data-conversation-block={getBlockMarker(block)}
                          >
                            <MessageBlock
                              message={block.message}
                              agentic_tool={agentic_tool}
                              userById={userById}
                              currentUserId={task.created_by}
                              isTaskRunning={runtimeLive && !compactionInProgress}
                              sessionId={sessionId}
                              onPermissionDecision={onPermissionDecision}
                              isFirstPendingPermission={isFirstPending}
                              isLatestMessage={isLatestMessage}
                              taskId={task.task_id}
                              teammateEmoji={teammateEmoji}
                              client={client}
                              onOpenAgenticToolSettings={onOpenAgenticToolSettings}
                            />
                          </div>
                        );
                      }
                      if (block.type === 'agent-chain') {
                        // Use first message ID as key for agent chain
                        const blockKey = `agent-chain-${block.messages[0]?.message_id || 'unknown'}`;
                        return wrapSimpleTurnBlock(
                          block,
                          blockIndex,
                          <div key={blockKey} data-conversation-block={getBlockMarker(block)}>
                            <AgentChain
                              messages={block.messages}
                              isTaskRunning={runtimeLive && !compactionInProgress}
                              isLatest={isLatestTask && blockIndex === activeAgentChainIndex}
                            />
                          </div>
                        );
                      }
                      if (block.type === 'compaction') {
                        // Render compaction block with aggregated messages
                        const blockKey = `compaction-${block.messages[0]?.message_id || 'unknown'}`;
                        return wrapSimpleTurnBlock(
                          block,
                          blockIndex,
                          <div key={blockKey} data-conversation-block={getBlockMarker(block)}>
                            <CompactionBlock messages={block.messages} />
                          </div>
                        );
                      }
                      return null;
                    })}

                  {!messagesLoading &&
                    simpleMode &&
                    turnStatusInsertIndex === blocks.length && (
                      <>
                        <TaskTurnStatus task={task} />
                        {isVerifiedRuntimeInterruption(task, isLatestTask) && (
                          <RuntimeInterruptionNotice
                            task={task}
                            sessionId={sessionId}
                            client={client}
                          />
                        )}
                      </>
                    )}

                  {/* Show typing indicator whenever the executor may still be live.
                      Marked as a conversation block so its unmount at stream
                      end gives search one final structural re-scan that picks
                      up the finished message text. */}
                  {runtimeLive && activeAgentChainIndex < 0 && !compactionInProgress && (
                    <div data-conversation-block className="disco-task-running-indicator">
                      <Spin size="small" />
                      <Typography.Text type="secondary">正在思考…</Typography.Text>
                    </div>
                  )}

                  {/* Show report if available */}
                  {task.report && (
                    <div style={{ marginTop: token.sizeUnit * 1.5 }}>
                      <Tag icon={<FileTextOutlined />} color="green">
                        任务报告
                      </Tag>
                      <Paragraph
                        style={{
                          marginTop: token.sizeUnit,
                          padding: token.sizeUnit * 1.5,
                          background: token.colorSuccessBg,
                          border: `1px solid ${token.colorSuccessBorder}`,
                          borderRadius: token.borderRadius,
                          fontSize: 13,
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {typeof task.report === 'string'
                          ? task.report
                          : JSON.stringify(task.report, null, 2)}
                      </Paragraph>
                    </div>
                  )}

                  {!simpleMode && !runtimeLive && (
                    <div className="disco-task-turn-divider">
                      <span>已处理 {formatTaskElapsed(task)}</span>
                    </div>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
    );
  }
);

TaskBlock.displayName = 'TaskBlock';
