/**
 * ConversationView - Task-centric conversation interface
 *
 * Displays conversation as collapsible task sections with:
 * - Tasks as primary organization unit
 * - Messages grouped within each task
 * - Tool use blocks properly rendered
 * - Latest task expanded by default
 * - Progressive disclosure for older tasks
 * - Auto-scrolling to latest content
 */

import { FileOutlined } from '@ant-design/icons';
import type {
  AgenticToolName,
  DiscoClient,
  Message,
  PermissionScope,
  SessionID,
  User,
} from '@disco-live/client';
import { TaskStatus } from '@disco-live/client';
import { Alert, Button, Progress, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useStreamingMessagesByTask } from '../../hooks/useStreamingMessagesByTask';
import { BrandMark } from '../BrandMark';
import type { PendingComposerSubmission } from '../SessionPanel/SessionPanelContent';
import { buildTaskPlanViewModel, type TaskPlanViewModel } from '../StickyTodoRenderer';
import { TaskBlock } from '../TaskBlock';

const { Text } = Typography;
const EMPTY_STREAMING_MESSAGES = new Map();
// Default-param `= new Map()` would mint a fresh Map on every render and
// defeat every TaskBlock's React.memo whenever the prop is omitted.
const EMPTY_USER_MAP = new Map<string, User>();
// Shared empty-array sentinel so TaskBlock's `taskMessages` prop keeps a stable
// reference for tasks whose messages haven't been loaded — otherwise `|| []`
// would mint a fresh array on every render and thrash TaskBlock's React.memo.
const EMPTY_MESSAGES: Message[] = [];

export interface ConversationViewProps {
  /**
   * Disco client for fetching messages
   */
  client: DiscoClient | null;

  /**
   * Session ID to fetch messages for
   */
  sessionId: SessionID | null;

  /**
   * Agentic tool name for showing tool icon
   */
  agentic_tool?: string;

  /**
   * Session's default model (to hide redundant model pills)
   */
  sessionModel?: string;

  /**
   * All users for emoji avatars (Map-based)
   */
  userById?: Map<string, User>;

  /**
   * Current user ID for showing emoji
   */
  currentUserId?: string;

  /**
   * Callback to expose scroll functions to parent
   */
  onScrollRef?: (scrollToBottom: () => void, scrollToTop: () => void) => void;

  /**
   * Permission decision handler
   */
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;

  /**
   * Branch name for hiding redundant branch names
   */
  branchName?: string;

  /**
   * Whether this session was created by the scheduler
   */
  isScheduled?: boolean;

  /**
   * Unix timestamp (ms) of when the session was scheduled to run
   */
  scheduledRunAt?: number;

  /**
   * Custom empty state message (for mobile vs desktop contexts)
   */
  emptyStateMessage?: string;

  /**
   * Whether the view is currently visible/active (pauses sockets when false)
   */
  isActive?: boolean;

  /**
   * Session genealogy for showing fork/spawn origin
   */
  genealogy?: {
    forked_from_session_id?: string;
    fork_point_task_id?: string;
    fork_point_message_index?: number;
    parent_session_id?: string;
    spawn_point_task_id?: string;
    spawn_point_message_index?: number;
  };

  /**
   * Emoji override for teammate avatar in message bubbles
   */
  teammateEmoji?: string;

  /**
   * When true, all task blocks are force-expanded (used by in-session search)
   */
  forceExpandAll?: boolean;

  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
  pendingComposerSubmission?: PendingComposerSubmission | null;
  onTaskPlanChange?: (plan: TaskPlanViewModel | null) => void;
}

export const ConversationView = React.memo<ConversationViewProps>(
  ({
    client,
    sessionId,
    agentic_tool,
    sessionModel,
    userById = EMPTY_USER_MAP,
    currentUserId,
    onScrollRef,
    onPermissionDecision,
    branchName,
    isScheduled,
    scheduledRunAt,
    emptyStateMessage = 'No messages yet. Send a prompt to start the conversation.',
    isActive = true,
    teammateEmoji,
    forceExpandAll = false,
    onOpenAgenticToolSettings,
    pendingComposerSubmission = null,
    onTaskPlanChange,
  }) => {
    // The library owns the bottom lock and user escape detection. Even its
    // "instant" scroll waits for requestAnimationFrame, so layout corrections
    // also need to use that same state synchronously before the browser paints.
    const { scrollRef, contentRef, scrollToBottom, stopScroll, state } = useStickToBottom({
      initial: 'instant',
      resize: 'instant',
    });

    // Public scroll-to-bottom exposed via onScrollRef (button clicks) and the
    // resume-on-send wiring in SessionPanel. Wrap to a plain `() => void` so we
    // don't leak the library's optional ScrollToBottom options to callers.
    const handleScrollToBottom = useCallback(() => {
      // The library's scrollToBottom() sets isAtBottom=true but never clears
      // escapedFromLock, so a prior scroll-up leaves the bottom lock half-engaged:
      // the resize-driven re-pin that follows late/streamed content is gated on
      // isAtBottom, which a stale escapedFromLock keeps flipping back to false.
      // Clearing the escape on an explicit go-to-bottom intent lets the pin
      // survive until the round-tripped/streamed content actually arrives.
      state.escapedFromLock = false;
      state.scrollTop = Math.max(0, state.calculatedTargetScrollTop);
      scrollToBottom({ animation: 'instant' });
    }, [state, scrollToBottom]);

    // Scroll to top. While content is still streaming/growing, the library's
    // persistent observer can re-pin to the bottom before our scrollTop write
    // takes effect, snapping the user right back down. `stopScroll()`
    // synchronously releases the bottom lock (and cancels any in-flight scroll
    // animation) so the scrollTop = 0 sticks.
    const scrollToTop = useCallback(() => {
      stopScroll();
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    }, [scrollRef, stopScroll]);

    // Expose scroll functions to parent
    useEffect(() => {
      if (onScrollRef) {
        onScrollRef(handleScrollToBottom, scrollToTop);
      }
    }, [onScrollRef, handleScrollToBottom, scrollToTop]);

    const { handle: reactiveSession, state: reactiveState } = useSharedReactiveSession(
      client,
      sessionId,
      {
        enabled: isActive,
        reactiveOptions: { taskHydration: 'lazy' },
      }
    );
    const currentReactiveState = reactiveState?.sessionId === sessionId ? reactiveState : null;

    // Queued tasks belong to the queue drawer, not the conversation. They
    // haven't run yet — there's no message_range, no user-message row, no
    // agent output to render — so showing them here as TaskBlocks just
    // duplicates what the queue panel already shows.
    //
    // Memoized so the filtered array's identity is stable across re-renders
    // when the underlying reactive `tasks` list hasn't changed. Without this,
    // every streaming chunk produced a fresh array → every downstream useMemo
    // depending on `tasks` would invalidate and rebuild.
    const tasks = useMemo(
      () => (currentReactiveState?.tasks || []).filter((t) => t.status !== TaskStatus.QUEUED),
      [currentReactiveState?.tasks]
    );
    const questionWidgetsRef = useRef<Message[]>(EMPTY_MESSAGES);
    const questionWidgets = useMemo(() => {
      const next = Array.from(currentReactiveState?.messagesByTask.values() || []).flatMap(
        (messages) =>
          messages.filter(
            (message) =>
              message.type === 'widget_request' &&
              message.metadata?.widget?.widget_type === 'questions'
          )
      );
      const previous = questionWidgetsRef.current;
      // An ordinary message patch must not invalidate every TaskBlock's props.
      if (
        next.length === previous.length &&
        next.every((widget, index) => widget === previous[index])
      ) {
        return previous;
      }
      questionWidgetsRef.current = next;
      return next;
    }, [currentReactiveState?.messagesByTask]);

    // Land at the bottom on panel open / session switch once real content is
    // available. The scroll container itself remains mounted during loading,
    // avoiding the old placeholder→conversation layout swap and visible jump.
    const hasContent = tasks.length > 0 || pendingComposerSubmission !== null;
    useLayoutEffect(() => {
      if (isActive && sessionId && hasContent) {
        handleScrollToBottom();
      }
    }, [isActive, sessionId, hasContent, handleScrollToBottom]);

    const allStreamingMessages =
      currentReactiveState?.streamingMessages || EMPTY_STREAMING_MESSAGES;
    const loading = currentReactiveState ? currentReactiveState.loading : !!sessionId;
    const error = currentReactiveState?.error || null;
    const isTerminalError = !!currentReactiveState?.terminal;
    const [isReloading, setIsReloading] = useState(false);

    const pinBeforePaint = useCallback(() => {
      if (!isActive || !state.isAtBottom || state.escapedFromLock) return;
      const target = Math.max(0, state.calculatedTargetScrollTop);
      if (state.scrollTop !== target) state.scrollTop = target;
    }, [isActive, state]);

    // React commits and late child layout (markdown, images, fonts) can both
    // change height. Correct in ResizeObserver, before paint. Do not pin on
    // every render: the library renders once before its scroll-up handler
    // releases the lock, and pinning then would undo the user's wheel input.
    useLayoutEffect(() => {
      const scroll = scrollRef.current;
      const content = contentRef.current;
      if (error || !isActive || !scroll || !content) return;
      const observer = new ResizeObserver(pinBeforePaint);
      observer.observe(content);
      observer.observe(scroll);
      return () => observer.disconnect();
    }, [contentRef, error, isActive, pinBeforePaint, scrollRef]);

    const streamingMessagesByTask = useStreamingMessagesByTask(allStreamingMessages);

    // Track which tasks are expanded (default: last task expanded)
    const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => {
      if (tasks.length > 0) {
        return new Set([tasks[tasks.length - 1].task_id]);
      }
      return new Set();
    });

    // When a new task arrives (i.e. the *last* task id changes), expand it.
    // If the user is still at the bottom, collapse older tasks and follow the
    // new one; if the user has scrolled away, preserve what they were reading.
    // Following is handled by the library's persistent observer — a new last
    // task while `isAtBottom` re-pins automatically, so we only need to manage
    // the expand state here. We deliberately depend on `lastTaskId` rather than
    // `tasks` so that:
    //   1. unrelated re-renders don't fire this effect (`tasks` still gets
    //      a new reference whenever any task patch lands — the useMemo bails
    //      out only when the *upstream* `reactiveState.tasks` array is
    //      identity-stable), and
    //   2. if the user collapses the current last task, we don't immediately
    //      re-open it — that "auto re-expand on empty" behavior fought the
    //      user and showed up as a flicker.
    const lastTaskId = tasks.length > 0 ? tasks[tasks.length - 1].task_id : null;
    const lastTask = tasks.length > 0 ? tasks[tasks.length - 1] : null;
    const latestTaskPlan = useMemo(() => {
      if (!lastTaskId || !lastTask || !currentReactiveState) return null;
      const persisted = currentReactiveState.messagesByTask.get(lastTaskId) || EMPTY_MESSAGES;
      const streaming = streamingMessagesByTask.get(lastTaskId);
      const persistedWithoutStreaming =
        streaming && streaming.size > 0
          ? persisted.filter((message) => !streaming.has(message.message_id))
          : persisted;
      const merged = (
        [
          ...persistedWithoutStreaming,
          ...(streaming ? Array.from(streaming.values()) : []),
        ] as Message[]
      ).sort((a, b) => a.index - b.index);
      return buildTaskPlanViewModel(merged, lastTask.status);
    }, [currentReactiveState, lastTask, lastTaskId, streamingMessagesByTask]);

    useEffect(() => {
      onTaskPlanChange?.(latestTaskPlan);
    }, [latestTaskPlan, onTaskPlanChange]);

    useEffect(() => {
      if (!isActive || !lastTaskId) return;
      // Read the library's SYNCHRONOUS live state, not the returned `isAtBottom`
      // React value. The returned value lags a render and also counts
      // "near bottom" as pinned — both would mis-classify a user who just
      // scrolled up moments before a task arrives, collapsing the tasks they're
      // reading. `state.escapedFromLock` is mutated synchronously the instant
      // the user scrolls away from the bottom lock, restoring the old
      // `userScrolledUpRef` semantics exactly.
      const userScrolledUp = state.escapedFromLock;
      setExpandedTaskIds((prev) => {
        if (prev.has(lastTaskId)) return prev;
        if (userScrolledUp) {
          // User has scrolled away — just expand the new task, keep older ones
          // visible so we don't disturb what they're reading.
          const next = new Set(prev);
          next.add(lastTaskId);
          return next;
        }
        // At bottom — collapse older tasks and focus the new one.
        return new Set([lastTaskId]);
      });
    }, [isActive, lastTaskId, state]);

    // Handle task expand/collapse. Single stable callback shared by every
    // TaskBlock — the callback takes `taskId` so we don't need to mint a
    // per-task closure (which previously rebuilt on every render and broke
    // TaskBlock's React.memo for the entire task list).
    const handleTaskExpandChange = useCallback((taskId: string, expanded: boolean) => {
      setExpandedTaskIds((prev) => {
        const next = new Set(prev);
        if (expanded) {
          next.add(taskId);
        } else {
          next.delete(taskId);
        }
        return next;
      });
    }, []);

    // Stable load/unload callbacks. The previous inline arrows were minted on
    // every ConversationView render → every TaskBlock saw new `onLoadTaskMessages`
    // / `onUnloadTaskMessages` refs → memo bailout failed for every TaskBlock,
    // including ones whose messages weren't changing.
    const handleLoadTaskMessages = useCallback(
      (taskId: string) => {
        if (!reactiveSession) return;
        return reactiveSession.loadTaskMessages(taskId).then(() => undefined);
      },
      [reactiveSession]
    );

    const handleUnloadTaskMessages = useCallback(
      (taskId: string) => {
        if (!reactiveSession) return;
        reactiveSession.unloadTaskMessages(taskId);
      },
      [reactiveSession]
    );

    // All scroll writes share the library's live lock state, including the
    // pre-paint correction. A user who scrolls up remains free to read history.

    if (error) {
      // Deterministic escape hatch when auto-recovery (socket-reconnect resync,
      // TOKENS_REFRESHED_EVENT listener, visibility-change listener in
      // useSharedReactiveSession) didn't catch the error — e.g. the user
      // returns hours later and the only signal we'd otherwise act on was the
      // socket `connect` event that already happened with stale auth.
      return (
        <Alert
          type="error"
          title="对话加载失败"
          description={error}
          showIcon
          action={
            reactiveSession && currentReactiveState && !isTerminalError ? (
              <Button
                size="small"
                loading={isReloading}
                onClick={async () => {
                  setIsReloading(true);
                  try {
                    await reactiveSession.resync();
                  } finally {
                    setIsReloading(false);
                  }
                }}
              >
                重新加载
              </Button>
            ) : undefined
          }
        />
      );
    }

    return (
      <div
        ref={scrollRef}
        data-testid="conversation-scroll-container"
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '12px 0',
          minHeight: 0,
          overflowAnchor: 'none',
          // Keep the transcript and the fixed composer on the same visual
          // centreline even when Windows reserves space for a vertical
          // scrollbar on the conversation pane.
          scrollbarGutter: 'stable both-edges',
        }}
      >
        <div ref={contentRef} className="disco-conversation-transcript">
          {loading && tasks.length === 0 && !pendingComposerSubmission ? (
            <div
              className="disco-conversation-placeholder is-loading"
              role="status"
              aria-label="正在加载对话"
            >
              <Spin />
            </div>
          ) : tasks.length === 0 && !pendingComposerSubmission ? (
            <div className="disco-conversation-placeholder is-empty" aria-hidden="true">
              <BrandMark size={104} style={{ opacity: 0.42 }} />
              <Text type="secondary">{emptyStateMessage}</Text>
            </div>
          ) : null}
          {/* Task-organized conversation */}
          {tasks.map((task, taskIndex) => (
            <TaskBlock
              key={task.task_id}
              task={task}
              agentic_tool={agentic_tool}
              sessionModel={sessionModel}
              userById={userById}
              currentUserId={currentUserId}
              isExpanded={forceExpandAll || expandedTaskIds.has(task.task_id)}
              onExpandChange={handleTaskExpandChange}
              sessionId={sessionId}
              onPermissionDecision={onPermissionDecision}
              branchName={branchName}
              isScheduled={isScheduled}
              scheduledRunAt={scheduledRunAt}
              streamingMessages={streamingMessagesByTask.get(task.task_id)}
              taskMessages={
                currentReactiveState?.messagesByTask.get(task.task_id) || EMPTY_MESSAGES
              }
              taskMessagesLoaded={!!currentReactiveState?.loadedTaskIds.has(task.task_id)}
              questionWidgets={questionWidgets}
              onLoadTaskMessages={handleLoadTaskMessages}
              onUnloadTaskMessages={handleUnloadTaskMessages}
              teammateEmoji={teammateEmoji}
              isLatestTask={taskIndex === tasks.length - 1}
              client={client}
              onOpenAgenticToolSettings={onOpenAgenticToolSettings}
            />
          ))}
          {pendingComposerSubmission && (
            <div className="disco-pending-composer-submission" aria-live="polite">
              <div className="disco-pending-composer-message">
                {pendingComposerSubmission.attachments.length > 0 && (
                  <div className="disco-pending-composer-attachments">
                    {pendingComposerSubmission.attachments.map((attachment) =>
                      attachment.previewUrl ? (
                        <img
                          key={attachment.id}
                          src={attachment.previewUrl}
                          alt={attachment.file.name}
                        />
                      ) : (
                        <div key={attachment.id} className="disco-pending-composer-file">
                          <FileOutlined />
                          <span>{attachment.file.name}</span>
                        </div>
                      )
                    )}
                  </div>
                )}
                {pendingComposerSubmission.text.trim() && (
                  <div className="disco-pending-composer-text">
                    {pendingComposerSubmission.text}
                  </div>
                )}
              </div>
              <div className="disco-pending-composer-activity">
                <Spin size="small" />
                <Typography.Text type="secondary">
                  {pendingComposerSubmission.activity === 'attachments'
                    ? '正在准备附件，完成后开始处理'
                    : '补充信息正在交给 Agent，不会打断当前任务'}
                </Typography.Text>
                {pendingComposerSubmission.activity === 'attachments' &&
                  pendingComposerSubmission.uploadProgress !== null && (
                    <Progress
                      percent={pendingComposerSubmission.uploadProgress}
                      showInfo={false}
                      size="small"
                      aria-label={`附件上传 ${pendingComposerSubmission.uploadProgress}%`}
                    />
                  )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
);

ConversationView.displayName = 'ConversationView';
