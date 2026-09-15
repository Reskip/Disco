import {
  ArrowUpOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  OrderedListOutlined,
  UpOutlined,
} from '@ant-design/icons';
import type { DiscoClient, Session, SpawnConfig, Task } from '@disco-live/client';
import { Alert, Button, Tooltip, Typography } from 'antd';
import React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { MOBILE_COMPOSER_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useDiscoStore } from '../../store/discoStore';
import { selectUserById } from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { taskPromptDisplayText } from '../../utils/questionReply';
import { ConversationView } from '../ConversationView';
import { TaskPlanProgress, type TaskPlanViewModel } from '../StickyTodoRenderer';
import type { ComposerAttachment } from './composerAttachments';

export interface PendingComposerSubmission {
  text: string;
  attachments: ComposerAttachment[];
  uploadProgress: number | null;
  activity: 'attachments' | 'steering';
}

export interface SessionPanelContentProps {
  client: DiscoClient | null;
  session: Session;
  teammateEmoji?: string | null;
  currentUserId?: string;
  sessionMcpServerIds?: string[];
  scrollToBottom: (() => void) | null;
  scrollToTop: (() => void) | null;
  setScrollToBottom: (fn: (() => void) | null) => void;
  setScrollToTop: (fn: (() => void) | null) => void;
  queuedTasks: Task[];
  setQueuedTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  onEditQueuedTask: (task: Task) => Promise<void>;
  spawnModalOpen: boolean;
  setSpawnModalOpen: (open: boolean) => void;
  onSpawnModalConfirm: (config: string | Partial<SpawnConfig>) => Promise<void>;
  inputValueRef: React.RefObject<string>;
  isOpen: boolean;
  forceExpandAll?: boolean;
  pendingComposerSubmission?: PendingComposerSubmission | null;
  footerSlot?: React.ReactNode;
}

export const SessionPanelContent = React.memo<SessionPanelContentProps>(
  ({
    client,
    session,
    teammateEmoji = null,
    currentUserId,
    setScrollToBottom,
    setScrollToTop,
    queuedTasks,
    setQueuedTasks,
    onEditQueuedTask,
    isOpen,
    forceExpandAll = false,
    pendingComposerSubmission = null,
    footerSlot = null,
  }) => {
    const mobileComposer = useMediaQuery(MOBILE_COMPOSER_QUERY);
    const { showError } = useThemedMessage();
    const userById = useDiscoStore(selectUserById);
    const { onPermissionDecision, onOpenAgenticToolSettings } = useAppActions();
    const [resumeQueueInFlight, setResumeQueueInFlight] = React.useState(false);
    const [steeringQueueTaskId, setSteeringQueueTaskId] = React.useState<string | null>(null);
    const [editingQueueTaskId, setEditingQueueTaskId] = React.useState<string | null>(null);
    const [deletingQueueTaskId, setDeletingQueueTaskId] = React.useState<string | null>(null);
    const [queueExpanded, setQueueExpanded] = React.useState(true);
    const composerAnchorRef = React.useRef<HTMLDivElement>(null);
    const [taskPlanState, setTaskPlanState] = React.useState<{
      sessionId: string;
      plan: TaskPlanViewModel | null;
    }>({ sessionId: session.session_id, plan: null });
    const taskPlan = taskPlanState.sessionId === session.session_id ? taskPlanState.plan : null;
    const handleTaskPlanChange = React.useCallback(
      (plan: TaskPlanViewModel | null) => {
        setTaskPlanState({ sessionId: session.session_id, plan });
      },
      [session.session_id]
    );
    const taskPlanCanRemainVisible =
      session.status === 'running' ||
      session.status === 'stopping' ||
      session.status === 'awaiting_permission' ||
      session.status === 'awaiting_input';
    React.useEffect(() => {
      if (!taskPlanCanRemainVisible) {
        setTaskPlanState((current) =>
          current.sessionId === session.session_id && current.plan
            ? { sessionId: session.session_id, plan: null }
            : current
        );
      }
    }, [session.session_id, taskPlanCanRemainVisible]);
    const previousQueueLength = React.useRef(queuedTasks.length);
    React.useEffect(() => {
      if (queuedTasks.length > previousQueueLength.current) setQueueExpanded(true);
      previousQueueLength.current = queuedTasks.length;
    }, [queuedTasks.length]);
    const isQueueHeldByFailure = queuedTasks.length > 0 && session.status === 'failed';

    // biome-ignore lint/correctness/useExhaustiveDependencies: Rebind the observer when the session or footer replaces the composer DOM.
    React.useLayoutEffect(() => {
      const composer = composerAnchorRef.current;
      const sessionBody = composer?.closest<HTMLElement>('.disco-session-body');
      if (!composer || !sessionBody) return;

      const updateComposerHeight = () => {
        // offsetHeight stays in the unscaled layout coordinate system. Using
        // getBoundingClientRect() here would feed an already zoomed height back
        // into CSS and move the floating queue/plan too far at 125%/150%.
        const height = Math.ceil(composer.offsetHeight);
        sessionBody.style.setProperty('--disco-session-composer-height', `${height}px`);
      };

      updateComposerHeight();
      const observer =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateComposerHeight);
      observer?.observe(composer);
      return () => {
        observer?.disconnect();
        sessionBody.style.removeProperty('--disco-session-composer-height');
      };
    }, [footerSlot, session.session_id]);

    const handleScrollRef = React.useCallback(
      (scrollBottom: () => void, scrollTop: () => void) => {
        setScrollToBottom(() => scrollBottom);
        setScrollToTop(() => scrollTop);
      },
      [setScrollToBottom, setScrollToTop]
    );

    const resumeQueue = React.useCallback(async () => {
      if (!client || resumeQueueInFlight) return;
      setResumeQueueInFlight(true);
      try {
        await client.service('sessions').patch(session.session_id, { ready_for_prompt: true });
      } catch (error) {
        showError(`继续队列失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setResumeQueueInFlight(false);
      }
    }, [client, resumeQueueInFlight, session.session_id, showError]);

    const steerQueuedTask = React.useCallback(
      async (task: Task) => {
        if (!client || steeringQueueTaskId) return;
        setSteeringQueueTaskId(task.task_id);
        try {
          await client
            .service(`/sessions/${session.session_id}/tasks/queue-steer`)
            .create({ taskId: task.task_id });
          setQueuedTasks((previous) =>
            previous.filter((candidate) => candidate.task_id !== task.task_id)
          );
        } catch (error) {
          showError(`追加失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setSteeringQueueTaskId(null);
        }
      },
      [client, session.session_id, setQueuedTasks, showError, steeringQueueTaskId]
    );

    return (
      <>
        <ConversationView
          client={client}
          sessionId={session.session_id}
          agentic_tool={session.agentic_tool}
          sessionModel={session.model_config?.model}
          userById={userById}
          currentUserId={currentUserId}
          onScrollRef={handleScrollRef}
          onPermissionDecision={onPermissionDecision}
          isScheduled={session.is_scheduled}
          scheduledRunAt={session.scheduled_run_at}
          emptyStateMessage="从下面输入消息，开始这段对话。"
          isActive={isOpen}
          teammateEmoji={teammateEmoji ?? undefined}
          forceExpandAll={forceExpandAll}
          onOpenAgenticToolSettings={onOpenAgenticToolSettings}
          pendingComposerSubmission={pendingComposerSubmission}
          onTaskPlanChange={handleTaskPlanChange}
        />

        {(taskPlan || queuedTasks.length > 0) && (
          <div className="disco-session-floating-dock">
            {taskPlan && (
              <div className="disco-task-plan-anchor">
                <TaskPlanProgress plan={taskPlan} />
              </div>
            )}

            {queuedTasks.length > 0 && (
              <section className="disco-queue-shelf" aria-label="排队消息">
                <button
                  type="button"
                  className="disco-queue-shelf-header"
                  aria-label="排队消息"
                  aria-expanded={queueExpanded}
                  onClick={() => setQueueExpanded((expanded) => !expanded)}
                >
                  <span className="disco-queue-shelf-icon">
                    <OrderedListOutlined />
                  </span>
                  <span className="disco-queue-shelf-title">排队消息</span>
                  <span className="disco-queue-shelf-count">{queuedTasks.length}</span>
                  <span className="disco-queue-shelf-spacer" />
                  {queueExpanded ? <UpOutlined /> : <DownOutlined />}
                </button>
                <div className={`disco-queue-shelf-body${queueExpanded ? ' is-expanded' : ''}`}>
                  <div className="disco-queue-shelf-body-inner">
                    {isQueueHeldByFailure && (
                      <Alert
                        type="warning"
                        showIcon
                        message="上一次运行失败，队列已暂停"
                        description="排队消息仍然保留，可以从下一条继续。"
                        action={
                          <Button
                            size="small"
                            type="primary"
                            loading={resumeQueueInFlight}
                            disabled={!client}
                            onClick={() => void resumeQueue()}
                          >
                            继续
                          </Button>
                        }
                      />
                    )}
                    <div className="disco-queue-list">
                      {queuedTasks.map((task, index) => (
                        <div key={task.task_id} className="disco-queue-item">
                          <span className="disco-queue-item-index">{index + 1}</span>
                          <div className="disco-queue-item-content">
                            <Typography.Text type="secondary">
                              {index === 0 ? '下一条' : `随后第 ${index + 1} 条`}
                            </Typography.Text>
                            <Typography.Text ellipsis title={taskPromptDisplayText(task)}>
                              {taskPromptDisplayText(task)}
                            </Typography.Text>
                          </div>
                          <div className="disco-queue-item-actions">
                            {!mobileComposer &&
                              session.agentic_tool === 'codex' &&
                              session.status === 'running' && (
                                <Tooltip title="改为补充当前任务，不会打断正在执行的步骤">
                                  <Button
                                    type="text"
                                    size="small"
                                    className="disco-queue-steer-button"
                                    aria-label="改为追加提示"
                                    icon={<ArrowUpOutlined />}
                                    loading={steeringQueueTaskId === task.task_id}
                                    disabled={Boolean(
                                      (steeringQueueTaskId &&
                                        steeringQueueTaskId !== task.task_id) ||
                                        editingQueueTaskId ||
                                        deletingQueueTaskId
                                    )}
                                    onClick={() => void steerQueuedTask(task)}
                                  >
                                    追加
                                  </Button>
                                </Tooltip>
                              )}
                            <Button
                              type="text"
                              size="small"
                              aria-label="编辑排队消息"
                              icon={<EditOutlined />}
                              loading={editingQueueTaskId === task.task_id}
                              disabled={Boolean(
                                (editingQueueTaskId && editingQueueTaskId !== task.task_id) ||
                                  deletingQueueTaskId ||
                                  steeringQueueTaskId
                              )}
                              onClick={async () => {
                                setEditingQueueTaskId(task.task_id);
                                try {
                                  await onEditQueuedTask(task);
                                } catch (error) {
                                  showError(
                                    `编辑排队消息失败：${
                                      error instanceof Error ? error.message : String(error)
                                    }`
                                  );
                                } finally {
                                  setEditingQueueTaskId(null);
                                }
                              }}
                            >
                              编辑
                            </Button>
                            <Button
                              type="text"
                              size="small"
                              danger
                              aria-label="删除排队消息"
                              icon={<DeleteOutlined />}
                              loading={deletingQueueTaskId === task.task_id}
                              disabled={Boolean(
                                (deletingQueueTaskId && deletingQueueTaskId !== task.task_id) ||
                                  editingQueueTaskId ||
                                  steeringQueueTaskId
                              )}
                              onClick={async () => {
                                if (!client) return;
                                setDeletingQueueTaskId(task.task_id);
                                try {
                                  await client.service('tasks').remove(task.task_id);
                                  setQueuedTasks((previous) =>
                                    previous.filter(
                                      (candidate) => candidate.task_id !== task.task_id
                                    )
                                  );
                                } catch (error) {
                                  showError(
                                    `删除排队消息失败：${
                                      error instanceof Error ? error.message : String(error)
                                    }`
                                  );
                                } finally {
                                  setDeletingQueueTaskId(null);
                                }
                              }}
                            >
                              删除
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
        {footerSlot && (
          <div ref={composerAnchorRef} className="disco-session-composer-anchor">
            {footerSlot}
          </div>
        )}
      </>
    );
  }
);

SessionPanelContent.displayName = 'SessionPanelContent';
