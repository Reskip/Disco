import { CloseOutlined, EditOutlined } from '@ant-design/icons';
import { AGENTIC_TOOL_CAPABILITIES } from '@disco/agentic-tools';
import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  DiscoClient,
  EffortLevel,
  PermissionMode,
  Session,
  SessionID,
  SpawnConfig,
  Task,
  User,
} from '@disco-live/client';
import {
  getDefaultPermissionMode,
  isAgenticToolName,
  mapToCodexPermissionConfig,
  SessionStatus,
  TaskStatus,
} from '@disco-live/client';
import type { InputRef } from 'antd';
import { Alert, Button, Input, Modal, Space, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { getDiscoPortalContainer } from '@/utils/portalContainer';
import { getDaemonUrl } from '../../config/daemon';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useDiscoStore } from '../../store/discoStore';
import { selectUserById } from '../../store/selectors';
import type { FollowUpBehavior } from '../../utils/followUpBehavior';
import { useThemedMessage } from '../../utils/message';
import { deletePromptDraft, getPromptDraft, savePromptDraft } from '../../utils/promptDrafts';
import { getPreferredReasoningEffort } from '../../utils/reasoningEffort';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { FileUpload } from '../FileUpload';
import { ForkSpawnModal } from '../ForkSpawnModal/ForkSpawnModal';
import type { ModelConfig } from '../ModelSelector';
import { ToolIcon } from '../ToolIcon';
import {
  buildPromptWithAttachments,
  getComposerUploadAccept,
  isBlockingComposerAttachment,
} from './composerAttachments';
import { SessionAttachmentTray } from './SessionAttachmentTray';
import { SessionComposerDropZone } from './SessionComposerDropZone';
import { type PendingComposerSubmission, SessionPanelContent } from './SessionPanelContent';
import { SimpleSessionFooter } from './SimpleSessionFooter';
import { useComposerAttachments } from './useComposerAttachments';

// Re-export PermissionMode from SDK for convenience
export type { PermissionMode };

// ---------------------------------------------------------------------------
// PromptInput — thin wrapper around AutocompleteTextarea that keeps the typed
// text in *local* state so that keystrokes never trigger a parent re-render.
// The parent reads/clears the value imperatively via a ref.
// ---------------------------------------------------------------------------

export interface PromptInputHandle {
  getValue: () => string;
  clear: () => void;
  insertText: (text: string) => void;
  replaceValue: (text: string) => void;
}

interface PromptInputProps {
  sessionId: SessionID;
  getDraft: (id: string) => string;
  saveDraft: (id: string, value: string) => void;
  deleteDraft: (id: string) => void;
  /** Fires only on empty↔non-empty transitions, not every keystroke */
  onHasInputChange: (hasInput: boolean) => void;
  /** Kept in sync so memoized children can read the latest value */
  inputValueRef: React.MutableRefObject<string>;
  /** Called on Enter (without Shift) when there is sendable composer content */
  onSubmit: () => void;
  hasExternalInput?: boolean;
  // Forwarded to AutocompleteTextarea
  placeholder?: string;
  autoSize?: { minRows?: number; maxRows?: number };
  client: DiscoClient | null;
  userById: Map<string, User>;
  onFilesDrop?: (files: File[]) => void;
  filesDropDisabled?: boolean;
  showFilesDropOverlay?: boolean;
  suppressEmptyHighlight?: boolean;
  slashCommands?: string[];
  skills?: string[];
}

const PromptInput = React.forwardRef<PromptInputHandle, PromptInputProps>(
  (
    {
      sessionId,
      getDraft,
      saveDraft,
      deleteDraft,
      onHasInputChange,
      inputValueRef,
      onSubmit,
      hasExternalInput = false,
      placeholder,
      autoSize,
      client,
      userById,
      onFilesDrop,
      filesDropDisabled = false,
      showFilesDropOverlay = true,
      suppressEmptyHighlight = false,
      slashCommands,
      skills,
    },
    ref
  ) => {
    const [value, setValue] = React.useState(() => getDraft(sessionId));
    const valueRef = React.useRef(value);
    const textareaElementRef = React.useRef<HTMLTextAreaElement | null>(null);

    // Keep refs in sync (zero-cost, no re-render)
    valueRef.current = value;
    inputValueRef.current = value;

    const handlePromptChange = React.useCallback(
      (nextValue: string) => {
        valueRef.current = nextValue;
        inputValueRef.current = nextValue;
        setValue(nextValue);
      },
      [inputValueRef]
    );

    // Track empty↔non-empty transitions → notify parent (minimal re-renders)
    const prevHasInput = React.useRef(!!value.trim());
    React.useEffect(() => {
      const has = !!value.trim();
      if (has !== prevHasInput.current) {
        prevHasInput.current = has;
        onHasInputChange(has);
      }
    }, [value, onHasInputChange]);

    // Imperative methods for the parent
    React.useImperativeHandle(
      ref,
      () => ({
        getValue: () => textareaElementRef.current?.value ?? valueRef.current,
        clear: () => {
          valueRef.current = '';
          inputValueRef.current = '';
          if (textareaElementRef.current) {
            textareaElementRef.current.value = '';
          }
          setValue('');
          deleteDraft(sessionId);
        },
        insertText: (text: string) => {
          setValue((prev) => {
            const trimmed = prev.trim();
            const separator = trimmed ? ' ' : '';
            const nextValue = `${trimmed}${separator}${text}`;
            valueRef.current = nextValue;
            inputValueRef.current = nextValue;
            return nextValue;
          });
        },
        replaceValue: (text: string) => {
          valueRef.current = text;
          inputValueRef.current = text;
          setValue(text);
          saveDraft(sessionId, text);
          requestAnimationFrame(() => textareaElementRef.current?.focus());
        },
      }),
      [sessionId, deleteDraft, inputValueRef, saveDraft]
    );

    // Session switch: save old draft, load new one
    const prevSessionId = React.useRef(sessionId);
    React.useEffect(() => {
      if (prevSessionId.current !== sessionId) {
        saveDraft(prevSessionId.current, valueRef.current);
        setValue(getDraft(sessionId));
        prevSessionId.current = sessionId;
      }
    }, [sessionId, saveDraft, getDraft]);

    // Debounced draft persistence (300ms)
    React.useEffect(() => {
      const timer = setTimeout(() => saveDraft(sessionId, value), 300);
      return () => clearTimeout(timer);
    }, [value, sessionId, saveDraft]);

    // Flush draft on unmount so in-flight debounced writes aren't lost.
    // Uses refs to capture the latest values without adding deps that would
    // cause the effect to re-run (we only want the cleanup to fire on unmount).
    const saveDraftRef = React.useRef(saveDraft);
    saveDraftRef.current = saveDraft;
    const sessionIdRef = React.useRef(sessionId);
    sessionIdRef.current = sessionId;
    React.useEffect(() => {
      return () => saveDraftRef.current(sessionIdRef.current, valueRef.current);
    }, []);

    const handleKeyPress = React.useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (valueRef.current.trim() || hasExternalInput) {
            onSubmit();
          }
        }
      },
      [hasExternalInput, onSubmit]
    );

    return (
      <AutocompleteTextarea
        ref={textareaElementRef}
        value={value}
        onChange={handlePromptChange}
        placeholder={placeholder}
        autoSize={autoSize}
        onKeyPress={handleKeyPress}
        client={client}
        sessionId={sessionId}
        userById={userById}
        onFilesDrop={onFilesDrop}
        filesDropDisabled={filesDropDisabled}
        showFilesDropOverlay={showFilesDropOverlay}
        suppressEmptyHighlight={suppressEmptyHighlight}
        slashCommands={slashCommands}
        skills={skills}
        highlightWhenEmpty
      />
    );
  }
);

PromptInput.displayName = 'PromptInput';

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// Stable fallback so renders before the reactive session hydrates don't mint
// a fresh array — the memos deriving footer props from `tasks` (and through
// them the memoized SessionFooter) key on its identity.
const EMPTY_TASKS: Task[] = [];

export interface SessionPanelProps {
  client: DiscoClient | null;
  session: Session | null;
  agentEmoji?: string | null;
  currentUserId?: string;
  sessionMcpServerIds?: string[];
  open: boolean;
  onClose: () => void;
  uploadPolicy?: import('@disco/core/types').UploadIngressPolicy;
}

const SessionPanel: React.FC<SessionPanelProps> = ({
  client,
  session,
  agentEmoji = null,
  currentUserId,
  sessionMcpServerIds = [],
  open,
  onClose,
  uploadPolicy,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showInfo, showError } = useThemedMessage();
  const connectionDisabled = useConnectionDisabled();

  // Subscribe only to the entity families this panel needs via narrow store
  // selectors. Streaming session patches are supplied through the shared
  // reactive-session hook; user and MCP updates stay isolated from them.
  const userById = useDiscoStore(selectUserById);

  // Get actions from context
  const { onSendPrompt, onFork, onBtwFork, onUpdateSession } = useAppActions();

  // Click-to-edit session title, inline in the header — see render below.
  // Draft is seeded from the *explicit* title only (not the description
  // fallback getSessionDisplayTitle shows when unset), so entering edit mode
  // never accidentally "sets" a title from the first-prompt fallback text.
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleHovered, setTitleHovered] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const titleInputRef = React.useRef<InputRef | null>(null);
  const startEditingTitle = React.useCallback(() => {
    setTitleDraft(session?.title ?? '');
    setEditingTitle(true);
  }, [session?.title]);
  const saveTitle = React.useCallback(() => {
    setEditingTitle(false);
    if (!session) return;
    const trimmed = titleDraft.trim();
    if (trimmed !== (session.title ?? '')) {
      onUpdateSession?.(session.session_id, { title: trimmed });
    }
  }, [session, titleDraft, onUpdateSession]);
  React.useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

  // "Switch tool" — same underlying chooseAgenticTool action the quick-start
  // empty-state tiles use, just with `replacingSessionId` set. Only offered
  // on a session with zero tasks (never prompted yet): tool is a per-session
  // SDK choice baked into every task, so there's no safe way to change it
  // once a conversation exists — hide the affordance entirely rather than
  // let it fail or silently drop history. (See `canSwitchTool` /
  // `handleSwitchTool` below the early-return, once `session` is narrowed.)

  // App renders this panel without a session key, so a route/back-forward
  // change swaps `session` in place instead of remounting. Reset the transient
  // title-edit and switch-tool UI when the session id changes so a draft title
  // or an open switch modal from the previous session can't bleed into (and
  // then act on) the next one.
  const titleStateSessionId = session?.session_id;
  const prevTitleStateSessionId = React.useRef(titleStateSessionId);
  React.useEffect(() => {
    if (prevTitleStateSessionId.current !== titleStateSessionId) {
      prevTitleStateSessionId.current = titleStateSessionId;
      setEditingTitle(false);
      setTitleDraft('');
    }
  }, [titleStateSessionId]);

  // Tool capabilities — drives which buttons are shown
  const activeAgenticTool =
    session && isAgenticToolName(session.agentic_tool) ? session.agentic_tool : undefined;
  const hasActiveAgenticTool = Boolean(activeAgenticTool);
  const toolCaps = activeAgenticTool ? AGENTIC_TOOL_CAPABILITIES[activeAgenticTool] : undefined;
  const preferredEffort = getPreferredReasoningEffort(
    toolCaps?.reasoningEffortLevels,
    toolCaps?.defaultReasoningEffort
  );

  // Per-session draft storage (localStorage-backed to survive unmounts).
  // Aliased as stable callbacks because they're threaded through props and
  // effect deps below.
  const getDraft = React.useCallback(getPromptDraft, []);
  const saveDraft = React.useCallback(savePromptDraft, []);
  const deleteDraft = React.useCallback(deletePromptDraft, []);

  // Input value lives entirely inside PromptInput (local state).
  // The parent reads it imperatively via promptRef / inputValueRef — no
  // parent re-renders on keystrokes.
  const promptRef = React.useRef<PromptInputHandle>(null);
  const inputValueRef = React.useRef(session ? getDraft(session.session_id) : '');
  const [hasInput, setHasInput] = React.useState(() => !!inputValueRef.current.trim());
  const handleHasInputChange = React.useCallback((v: boolean) => setHasInput(v), []);
  // getDefaultPermissionMode imported from @disco-live/client — canonical
  // per-tool defaults live in core's `getDefaultPermissionMode`. The local
  // shadow that used to live here was stale (missing gemini/opencode/copilot)
  // and silently drifted from the core definition.

  const initialPermissionMode: PermissionMode =
    session?.permission_config?.mode ??
    (session?.agentic_tool && isAgenticToolName(session.agentic_tool)
      ? getDefaultPermissionMode(session.agentic_tool)
      : getDefaultPermissionMode('claude-code'));
  const initialCodexDefaults = mapToCodexPermissionConfig(initialPermissionMode);
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(initialPermissionMode);
  const [, setCodexSandboxMode] = React.useState<CodexSandboxMode>(
    session?.permission_config?.codex?.sandboxMode ?? initialCodexDefaults.sandboxMode
  );
  const [, setCodexApprovalPolicy] = React.useState<CodexApprovalPolicy>(
    session?.permission_config?.codex?.approvalPolicy ?? initialCodexDefaults.approvalPolicy
  );
  const [effortLevel, setEffortLevel] = React.useState<EffortLevel | undefined>(
    session?.model_config?.effort ?? preferredEffort
  );
  const [scrollToBottom, setScrollToBottom] = React.useState<(() => void) | null>(null);
  const [scrollToTop, setScrollToTop] = React.useState<(() => void) | null>(null);
  const [queuedTasks, setQueuedTasks] = React.useState<Task[]>([]);
  const [forkModalOpen, setForkModalOpen] = React.useState(false);
  const [spawnModalOpen, setSpawnModalOpen] = React.useState(false);

  const editQueuedTask = React.useCallback(
    async (task: Task) => {
      if (!client) throw new Error('Disco 尚未连接');

      // Delete on the server first. The repository only removes tasks that are
      // still queued, so a worker winning the dispatch race cannot turn an
      // already-running prompt back into an editable draft.
      await client.service('tasks').remove(task.task_id);
      setQueuedTasks((previous) =>
        previous.filter((candidate) => candidate.task_id !== task.task_id)
      );
      promptRef.current?.replaceValue(task.full_prompt);
    },
    [client]
  );
  const [uploadModalOpen, setUploadModalOpen] = React.useState(false);
  const [advancedUploadInitialFiles, setAdvancedUploadInitialFiles] = React.useState<File[]>([]);
  const [composerDropActive, setComposerDropActive] = React.useState(false);
  const [pendingComposerSend, setPendingComposerSend] = React.useState<{
    sessionId: SessionID;
    generation: number;
    text: string;
    attachmentIds: string[];
    activity: 'attachments' | 'steering';
    taskIdsAtSendStart: string[];
    admittedTaskId?: string;
    admittedMessageId?: string;
    admittedAt?: number;
  } | null>(null);
  const [stopRequestInFlight, setStopRequestInFlight] = React.useState(false);
  const [forceFailTarget, setForceFailTarget] = React.useState<{
    taskId: string;
    terminationRequestedAt: string;
  } | null>(null);
  const [forceFailConfirmation, setForceFailConfirmation] = React.useState('');
  const forceFailInputRef = React.useRef<InputRef | null>(null);
  const reactiveSessionId = session?.session_id ?? null;
  const { state: reactiveSessionState } = useSharedReactiveSession(client, reactiveSessionId, {
    enabled: open,
    reactiveOptions: { taskHydration: 'none' },
  });

  const tasks = reactiveSessionState?.tasks || EMPTY_TASKS;
  React.useEffect(() => {
    if (
      forceFailTarget &&
      !tasks.some(
        (task) =>
          task.task_id === forceFailTarget.taskId &&
          task.status === TaskStatus.STOPPING &&
          task.sdk_failure?.termination === 'unverified' &&
          task.termination_request?.requested_at === forceFailTarget.terminationRequestedAt
      )
    ) {
      setForceFailTarget(null);
      setForceFailConfirmation('');
    }
  }, [forceFailTarget, tasks]);
  const attachmentInputRef = React.useRef<HTMLInputElement>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const composerSessionIdentityRef = React.useRef<{
    sessionId: SessionID | null;
    generation: number;
  }>({
    sessionId: session?.session_id ?? null,
    generation: 0,
  });
  const currentComposerSessionId = session?.session_id ?? null;
  if (composerSessionIdentityRef.current.sessionId !== currentComposerSessionId) {
    composerSessionIdentityRef.current = {
      sessionId: currentComposerSessionId,
      generation: composerSessionIdentityRef.current.generation + 1,
    };
  }
  const {
    attachments: composerAttachments,
    attachmentsRef: composerAttachmentsRef,
    clearAttachments: clearComposerAttachments,
    hasAttachments: hasComposerAttachments,
    addAttachments: addComposerAttachments,
    removeAttachment: removeComposerAttachment,
    uploadAttachments: uploadComposerAttachments,
    uploading: composerAttachmentUploading,
    uploadProgress: composerAttachmentUploadProgress,
    uploadingRef: composerAttachmentUploadingRef,
    sendingRef: composerSendInFlightRef,
    validationError: composerAttachmentValidationError,
    setValidationError: setComposerAttachmentValidationError,
  } = useComposerAttachments({
    sessionId: session?.session_id ?? null,
    userId: currentUserId,
    showError,
    uploadPolicy,
  });
  const composerMountedRef = React.useRef(true);
  React.useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    setPendingComposerSend((pending) =>
      pending && pending.sessionId !== currentComposerSessionId ? null : pending
    );
  }, [currentComposerSessionId]);

  React.useEffect(() => {
    if (!pendingComposerSend) return;

    // The realtime task can arrive before the HTTP /prompt promise resolves.
    // In that race there is not yet an admittedTaskId to match, but keeping the
    // optimistic attachment row would render two simultaneous spinners. A new
    // task in the same session is the durable hand-off point for attachment
    // sends, so retire the optimistic row immediately.
    if (
      pendingComposerSend.activity === 'attachments' &&
      tasks.some((task) => !pendingComposerSend.taskIdsAtSendStart.includes(task.task_id))
    ) {
      setPendingComposerSend(null);
      return;
    }

    if (!pendingComposerSend.admittedAt) return;

    const messageVisible = pendingComposerSend.admittedMessageId
      ? Array.from(reactiveSessionState?.messagesByTask.values() ?? []).some((messages) =>
          messages.some((message) => message.message_id === pendingComposerSend.admittedMessageId)
        )
      : false;
    const taskVisible = pendingComposerSend.admittedTaskId
      ? tasks.some((task) => task.task_id === pendingComposerSend.admittedTaskId)
      : false;
    const steeringHintVisible =
      pendingComposerSend.activity === 'steering' && pendingComposerSend.admittedMessageId
        ? tasks.some((task) =>
            (task.metadata?.steering_hints ?? []).some(
              (hint) => hint.message_id === pendingComposerSend.admittedMessageId
            )
          )
        : false;
    // A steering response reuses the already-visible active task. Treating the
    // mere presence of that task as admission made the optimistic spinner and
    // the real running indicator overlap. Wait for either the steering hint or
    // a real user message (the race-safe fresh-turn fallback) to arrive.
    const admissionVisible =
      pendingComposerSend.activity === 'steering'
        ? steeringHintVisible || messageVisible
        : taskVisible || messageVisible;

    if (admissionVisible) {
      setPendingComposerSend(null);
      return;
    }

    // Realtime delivery normally replaces the optimistic row immediately. Keep
    // a bounded fallback so a disconnected socket cannot leave it stuck.
    const remaining = Math.max(0, pendingComposerSend.admittedAt + 8_000 - Date.now());
    const timeout = window.setTimeout(() => setPendingComposerSend(null), remaining);
    return () => window.clearTimeout(timeout);
  }, [pendingComposerSend, reactiveSessionState?.messagesByTask, tasks]);

  // Fetch queued tasks (post never-lose-prompt: queueing lives on tasks, not messages).
  React.useEffect(() => {
    if (!client || !session) return;

    const fetchQueue = async () => {
      try {
        const response = await client.service(`/sessions/${session.session_id}/tasks/queue`).find();
        const data = (response as { data: Task[] }).data || [];
        setQueuedTasks(data);
      } catch (error) {
        console.error('[SessionPanel] Failed to fetch queue:', error);
      }
    };

    fetchQueue();

    const tasksService = client.service('tasks');

    const handleQueued = (task: Task) => {
      if (task.session_id === session.session_id) {
        setQueuedTasks((prev) => {
          // Deduplicate: optimistic update from enqueue may have already added this task
          if (prev.some((t) => t.task_id === task.task_id)) return prev;
          return [...prev, task].sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0));
        });
      }
    };

    // A queued task drops out of the drawer when its status flips off 'queued'
    // (drained by spawnTaskExecutor → RUNNING, or admin-cancelled to STOPPED).
    const handleTaskPatched = (task: Task) => {
      if (task.session_id !== session.session_id) return;
      if (task.status !== TaskStatus.QUEUED) {
        setQueuedTasks((prev) => prev.filter((t) => t.task_id !== task.task_id));
      }
    };

    const handleTaskRemoved = (task: Task) => {
      if (task.session_id === session.session_id) {
        setQueuedTasks((prev) => prev.filter((t) => t.task_id !== task.task_id));
      }
    };

    tasksService.on('queued', handleQueued);
    tasksService.on('patched', handleTaskPatched);
    tasksService.on('updated', handleTaskPatched);
    tasksService.on('removed', handleTaskRemoved);

    return () => {
      tasksService.off('queued', handleQueued);
      tasksService.off('patched', handleTaskPatched);
      tasksService.off('updated', handleTaskPatched);
      tasksService.off('removed', handleTaskRemoved);
    };
  }, [client, session]);

  // Token breakdown calculation
  const tokenBreakdown = React.useMemo(() => {
    if (!session?.agentic_tool) {
      return { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
    }

    return tasks.reduce(
      (acc, task) => {
        if (!task.normalized_sdk_response) return acc;

        const { tokenUsage, costUsd } = task.normalized_sdk_response;

        return {
          total: acc.total + tokenUsage.totalTokens,
          input: acc.input + tokenUsage.inputTokens,
          output: acc.output + tokenUsage.outputTokens,
          cacheRead: acc.cacheRead + (tokenUsage.cacheReadTokens || 0),
          cacheCreation: acc.cacheCreation + (tokenUsage.cacheCreationTokens || 0),
          cost: acc.cost + (costUsd || 0),
        };
      },
      { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 }
    );
  }, [tasks, session?.agentic_tool]);

  // Update permission mode when session changes
  React.useEffect(() => {
    if (session?.permission_config?.mode) {
      setPermissionMode(session.permission_config.mode);
    } else if (session?.agentic_tool && isAgenticToolName(session.agentic_tool)) {
      setPermissionMode(getDefaultPermissionMode(session.agentic_tool));
    }

    if (session?.agentic_tool === 'codex' && session?.permission_config?.codex) {
      setCodexSandboxMode(session.permission_config.codex.sandboxMode);
      setCodexApprovalPolicy(session.permission_config.codex.approvalPolicy);
    }
  }, [session?.permission_config?.mode, session?.permission_config?.codex, session?.agentic_tool]);

  // Keep explicit overrides distinct from runtime-owned defaults (for example Codex config.toml).
  React.useEffect(() => {
    setEffortLevel(session?.model_config?.effort ?? preferredEffort);
  }, [session?.model_config?.effort, preferredEffort]);

  const stampedEffortSessionsRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (
      !session?.model_config ||
      session.model_config.effort ||
      !preferredEffort ||
      !onUpdateSession ||
      stampedEffortSessionsRef.current.has(session.session_id)
    ) {
      return;
    }
    stampedEffortSessionsRef.current.add(session.session_id);
    onUpdateSession(session.session_id, {
      model_config: {
        ...session.model_config,
        effort: preferredEffort,
        updated_at: new Date().toISOString(),
      },
    });
  }, [onUpdateSession, preferredEffort, session]);

  const isRunning =
    session?.status === SessionStatus.RUNNING || session?.status === SessionStatus.STOPPING;
  const isStopping = session?.status === SessionStatus.STOPPING;

  // SessionFooter is memoized, but its handlers close over per-render state
  // and are defined below the null-session early return, so they can't be
  // useCallback'd directly. Freeze the identities the footer sees with
  // lifetime-stable wrappers that delegate to the latest implementations via
  // a ref (re-pointed each render, right where the impls are defined).
  const footerHandlersRef = React.useRef<{
    onModelConfigChange: (config: ModelConfig) => void;
    onSendPrompt: (behavior?: FollowUpBehavior) => void;
    onStop: () => void;
    onFork: () => void;
    onBtwSend: () => void;
    onSpawnOpen: () => void;
    onAttachFiles: () => void;
    onUploadOpen: () => void;
    onEffortChange: (v: EffortLevel | undefined) => void;
    onServiceTierChange: (v: 'default' | 'fast') => void;
    onPermissionModeChange: (v: PermissionMode) => void;
    onCodexPermissionChange: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) => void;
  } | null>(null);
  const stableFooterHandlers = React.useMemo(
    () => ({
      onModelConfigChange: (config: ModelConfig) =>
        footerHandlersRef.current?.onModelConfigChange(config),
      onSendPrompt: (behavior?: FollowUpBehavior) =>
        footerHandlersRef.current?.onSendPrompt(behavior),
      onStop: () => footerHandlersRef.current?.onStop(),
      onFork: () => footerHandlersRef.current?.onFork(),
      onBtwSend: () => footerHandlersRef.current?.onBtwSend(),
      onSpawnOpen: () => footerHandlersRef.current?.onSpawnOpen(),
      onAttachFiles: () => footerHandlersRef.current?.onAttachFiles(),
      onUploadOpen: () => footerHandlersRef.current?.onUploadOpen(),
      onEffortChange: (v: EffortLevel | undefined) => footerHandlersRef.current?.onEffortChange(v),
      onServiceTierChange: (v: 'default' | 'fast') =>
        footerHandlersRef.current?.onServiceTierChange(v),
      onPermissionModeChange: (v: PermissionMode) =>
        footerHandlersRef.current?.onPermissionModeChange(v),
      onCodexPermissionChange: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) =>
        footerHandlersRef.current?.onCodexPermissionChange(sandbox, approval),
    }),
    []
  );

  const modelConfig: ModelConfig | undefined = React.useMemo(
    () =>
      session?.model_config?.model
        ? {
            mode: session.model_config.mode || 'alias',
            model: session.model_config.model,
            provider: session.model_config.provider,
            advisorModel: session.model_config.advisorModel,
          }
        : undefined,
    [
      session?.model_config?.mode,
      session?.model_config?.model,
      session?.model_config?.provider,
      session?.model_config?.advisorModel,
    ]
  );

  // The composer subtree only depends on composer/draft state — memoize it so
  // ordinary SessionPanel re-renders (reactive-session notifies, store
  // patches) hand the memoized SessionFooter a reference-stable slot.
  const sessionCustomContext = session?.custom_context as Record<string, unknown> | undefined;
  const promptInputSlot = React.useMemo(() => {
    if (!session) return null;
    return (
      <SessionComposerDropZone
        className="disco-composer-input-stack"
        disabled={composerAttachmentUploading}
        onDragActiveChange={setComposerDropActive}
        onFilesDrop={addComposerAttachments}
      >
        {composerAttachmentValidationError && (
          <Alert
            type="error"
            showIcon
            message={composerAttachmentValidationError}
            style={{ marginBottom: 0, borderRadius: token.borderRadius }}
          />
        )}
        <SessionAttachmentTray
          attachments={pendingComposerSend ? [] : composerAttachments}
          disabled={composerAttachmentUploading}
          onRemove={removeComposerAttachment}
        />
        <PromptInput
          ref={promptRef}
          sessionId={session.session_id}
          getDraft={getDraft}
          saveDraft={saveDraft}
          deleteDraft={deleteDraft}
          onHasInputChange={handleHasInputChange}
          inputValueRef={inputValueRef}
          onSubmit={stableFooterHandlers.onSendPrompt}
          hasExternalInput={hasComposerAttachments && !pendingComposerSend}
          placeholder={isRunning ? '输入下一条消息，当前任务完成后自动开始' : '随心输入'}
          autoSize={{ minRows: 3, maxRows: 10 }}
          client={client}
          userById={userById}
          onFilesDrop={addComposerAttachments}
          filesDropDisabled={composerAttachmentUploading}
          showFilesDropOverlay={false}
          suppressEmptyHighlight={composerDropActive}
          slashCommands={
            Array.isArray(sessionCustomContext?.slash_commands)
              ? sessionCustomContext.slash_commands
              : undefined
          }
          skills={
            Array.isArray(sessionCustomContext?.skills) ? sessionCustomContext.skills : undefined
          }
        />
        <input
          ref={attachmentInputRef}
          type="file"
          accept={getComposerUploadAccept()}
          multiple
          disabled={composerAttachmentUploading}
          style={{ display: 'none' }}
          onChange={(event) => {
            addComposerAttachments(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </SessionComposerDropZone>
    );
  }, [
    session,
    sessionCustomContext,
    composerAttachmentUploading,
    composerAttachmentValidationError,
    composerAttachments,
    pendingComposerSend,
    composerDropActive,
    hasComposerAttachments,
    isRunning,
    client,
    userById,
    addComposerAttachments,
    removeComposerAttachment,
    getDraft,
    saveDraft,
    deleteDraft,
    handleHasInputChange,
    stableFooterHandlers,
    token.borderRadius,
  ]);

  // When there's no session, render nothing (panel is collapsed to zero).
  // When open=false, we still render the component tree (hidden) so that
  // antd's CSS-in-JS doesn't garbage-collect component styles.
  if (!session) {
    return null;
  }
  const activeSession = isAgenticToolName(session.agentic_tool)
    ? (session as Session & { agentic_tool: AgenticToolName })
    : null;

  const openAdvancedUpload = (initialFiles: File[] = []) => {
    if (composerAttachmentUploadingRef.current) return;
    setAdvancedUploadInitialFiles(initialFiles);
    setUploadModalOpen(true);
  };

  const handleSendPrompt = async (requestedFollowUpBehavior?: FollowUpBehavior) => {
    if (composerSendInFlightRef.current || connectionDisabled) {
      return;
    }

    composerSendInFlightRef.current = true;
    const sendStartSessionId = session.session_id;
    const sendStartComposerIdentity = composerSessionIdentityRef.current;
    const clearPendingSend = () =>
      setPendingComposerSend((pending) =>
        pending?.sessionId === sendStartSessionId &&
        pending.generation === sendStartComposerIdentity.generation
          ? null
          : pending
      );
    let sendValueForRecovery = '';
    let sendSessionForRecovery: SessionID | null = null;
    try {
      const value = promptRef.current?.getValue() ?? '';
      sendValueForRecovery = value;
      sendSessionForRecovery = sendStartSessionId;
      const attachmentsAtSendStart = composerAttachmentsRef.current;
      const hasAttachments = attachmentsAtSendStart.length > 0;
      const shouldSteer =
        session.agentic_tool === 'codex' &&
        session.status === SessionStatus.RUNNING &&
        !stopRequestInFlight &&
        requestedFollowUpBehavior === 'steer';
      if (!value.trim() && !hasAttachments) return;

      const blockingAttachment = attachmentsAtSendStart.find(isBlockingComposerAttachment);
      if (blockingAttachment) {
        showError(`${blockingAttachment.file.name} 上传失败。请移除失败文件后再发送。`);
        return;
      }

      if (!onSendPrompt) {
        showError('当前页面无法发送消息。');
        return;
      }

      if (hasAttachments || shouldSteer) {
        setPendingComposerSend({
          sessionId: sendStartSessionId,
          generation: sendStartComposerIdentity.generation,
          text: value,
          attachmentIds: attachmentsAtSendStart.map((attachment) => attachment.id),
          activity: hasAttachments ? 'attachments' : 'steering',
          taskIdsAtSendStart: tasks.map((task) => task.task_id),
        });
        promptRef.current?.clear();
        scrollToBottom?.();
      }

      const uploadedFiles = await uploadComposerAttachments(
        attachmentsAtSendStart,
        sendStartSessionId
      );
      const promptAttachments = uploadedFiles;
      const composerStillOwnsSend = () =>
        composerMountedRef.current &&
        composerSessionIdentityRef.current.sessionId === sendStartSessionId &&
        composerSessionIdentityRef.current.generation === sendStartComposerIdentity.generation;
      // Sending while an upload is active freezes the visible message at click
      // time. Text typed afterwards belongs to the next draft and must never be
      // mixed into the attachment-backed prompt that is waiting in the local
      // upload cache.
      const promptToSend = buildPromptWithAttachments(value, promptAttachments);
      if (!promptToSend.trim()) return;

      // Single entry point: /prompt. The daemon decides run-vs-queue based on
      // session state and reports it back via `task.status`. The 'queued'
      // WebSocket event populates the queue panel for queued prompts.
      const sendResult = shouldSteer
        ? await onSendPrompt?.(sendStartSessionId, promptToSend, permissionMode, { steer: true })
        : await onSendPrompt?.(sendStartSessionId, promptToSend, permissionMode);
      if (sendResult === false) {
        clearPendingSend();
        if (composerStillOwnsSend() && value.trim() && !promptRef.current?.getValue().trim()) {
          promptRef.current?.insertText(value);
        } else if (!composerStillOwnsSend() && value.trim() && !getDraft(sendStartSessionId)) {
          saveDraft(sendStartSessionId, value);
        }
        return;
      }

      // The upload/send callbacks belong to the original draft. Remove only
      // the submitted files, including when its view is no longer mounted.
      clearComposerAttachments(attachmentsAtSendStart.map((attachment) => attachment.id));
      setComposerAttachmentValidationError(null);
      if (composerStillOwnsSend()) {
        if (!hasAttachments) promptRef.current?.clear();
      } else if (!hasAttachments && getDraft(sendStartSessionId) === value) {
        // The old composer is no longer live; clear only its saved draft so the
        // successfully sent snapshot does not reappear when the user returns.
        // Never call promptRef.current?.clear() here because it now belongs to
        // a different active session.
        deleteDraft(sendStartSessionId);
      }

      // Re-engage the bottom lock so a scrolled-up user follows their just-sent
      // message and the streaming reply (behavior 3). `scrollToBottom` is the
      // function ConversationView exposed via onScrollRef.
      if (composerStillOwnsSend()) scrollToBottom?.();
      if (sendResult && typeof sendResult === 'object') {
        const admittedTaskId =
          'message' in sendResult ? sendResult.message.task_id : sendResult.taskId;
        const admittedMessageId =
          'message' in sendResult ? sendResult.message.message_id : sendResult.messageId;
        setPendingComposerSend((pending) =>
          pending &&
          pending.sessionId === sendStartSessionId &&
          pending.generation === sendStartComposerIdentity.generation
            ? {
                ...pending,
                admittedTaskId,
                admittedMessageId,
                admittedAt: Date.now(),
              }
            : pending
        );
      } else {
        // Compatibility for embedding callers that still return a boolean.
        clearPendingSend();
      }
    } catch (error) {
      console.error('Composer send failed — keeping prompt and files in composer:', error);
      clearPendingSend();
      const pendingBelongsToCurrentComposer =
        composerMountedRef.current &&
        composerSessionIdentityRef.current.sessionId === sendSessionForRecovery;
      if (
        pendingBelongsToCurrentComposer &&
        (promptRef.current?.getValue() ?? '').trim().length === 0
      ) {
        if (sendValueForRecovery.trim()) promptRef.current?.insertText(sendValueForRecovery);
      } else if (
        !pendingBelongsToCurrentComposer &&
        sendSessionForRecovery &&
        sendValueForRecovery.trim() &&
        !getDraft(sendSessionForRecovery)
      ) {
        saveDraft(sendSessionForRecovery, sendValueForRecovery);
      }
      showError(error instanceof Error ? error.message : '消息发送失败');
    } finally {
      composerSendInFlightRef.current = false;
    }
  };

  const handleStop = async () => {
    if (!session || !client || stopRequestInFlight) return;

    const unverifiedTask = [...tasks]
      .reverse()
      .find(
        (task) =>
          task.status === TaskStatus.STOPPING && task.sdk_failure?.termination === 'unverified'
      );
    if (unverifiedTask?.termination_request) {
      setForceFailConfirmation('');
      setForceFailTarget({
        taskId: unverifiedTask.task_id,
        terminationRequestedAt: unverifiedTask.termination_request.requested_at,
      });
      return;
    }

    // Show feedback immediately if this is a retry
    if (isStopping) {
      showInfo('正在重试停止请求…');
    }

    setStopRequestInFlight(true);
    try {
      await client.service(`sessions/${session.session_id}/stop`).create({});
    } catch (error) {
      console.error('Failed to stop execution:', error);
      showError('停止运行失败，可以再试一次。');
    } finally {
      setStopRequestInFlight(false);
    }
  };

  const handleForceFail = async () => {
    if (
      !session ||
      !client ||
      !forceFailTarget ||
      forceFailConfirmation !== 'STOP' ||
      stopRequestInFlight
    ) {
      return;
    }
    setStopRequestInFlight(true);
    try {
      await client.service(`sessions/${session.session_id}/stop`).create({
        force_unverified: true,
        confirmation: 'STOP',
        task_id: forceFailTarget.taskId,
        termination_requested_at: forceFailTarget.terminationRequestedAt,
      });
      setForceFailTarget(null);
      setForceFailConfirmation('');
    } catch (error) {
      console.error('Failed to force-fail execution:', error);
      showError('强制结束失败，可以再试一次。');
    } finally {
      setStopRequestInFlight(false);
    }
  };

  const handleFork = async () => {
    if (!session) return;
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to fork.'
      );
      return;
    }
    const value = promptRef.current?.getValue() ?? '';
    const promptToSend = value.trim();
    if (!promptToSend) {
      setForkModalOpen(true);
      return;
    }
    try {
      await onFork?.(session.session_id, promptToSend);
      // Only clear the compose box + draft on success, so a failed fork
      // leaves the typed prompt intact for the user to retry.
      promptRef.current?.clear();
    } catch (error) {
      console.error('Fork failed — keeping prompt in compose box:', error);
    }
  };

  const handleForkModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!session) return;
    const prompt = typeof config === 'string' ? config : (config.prompt ?? '');
    if (!prompt) return;
    await onFork?.(session.session_id, prompt);
  };

  const handleBtwSend = async () => {
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to send BTW.'
      );
      return;
    }
    const value = promptRef.current?.getValue() ?? '';
    if (!value.trim() || connectionDisabled) return;
    const promptToSend = value.trim();
    try {
      await onBtwFork?.(session.session_id, promptToSend);
      promptRef.current?.clear();
    } catch (error) {
      console.error('BTW fork failed — keeping prompt in compose box:', error);
    }
  };

  const handleSpawnOpen = () => {
    if (composerAttachmentsRef.current.length > 0) {
      showError(
        'Attachments are only supported for normal Send for now. Remove attachments to spawn.'
      );
      return;
    }
    setSpawnModalOpen(true);
  };

  const handleSpawnModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!session || !client) return;

    // Daemon owns the spawn-subsession meta-prompt template. The UI sends raw
    // `{userPrompt, config}` to /sessions/:id/spawn-prompt, which renders the
    // meta-prompt and forwards it to /sessions/:id/prompt in one round trip.
    //
    // `parentPermissionMode` is the *parent* session's permission mode for the
    // forwarding prompt; the spawn config's `permissionMode` is rendered into
    // the meta-prompt as the *child* session's intended mode. They're distinct
    // — don't reuse one for the other.
    const spawnConfig =
      typeof config === 'string'
        ? { userPrompt: config }
        : {
            userPrompt: config.prompt || '',
            agenticTool: config.agent,
            permissionMode: config.permissionMode,
            modelConfig: config.modelConfig,
            codexSandboxMode: config.codexSandboxMode,
            codexApprovalPolicy: config.codexApprovalPolicy,
            codexNetworkAccess: config.codexNetworkAccess,
            mcpServerIds: config.mcpServerIds,
            callbackConfig: {
              enableCallback: config.enableCallback,
              includeLastMessage: config.includeLastMessage,
              includeOriginalPrompt: config.includeOriginalPrompt,
            },
            extraInstructions: config.extraInstructions,
          };

    await client
      .service(`sessions/${session.session_id}/spawn-prompt`)
      .create({ ...spawnConfig, parentPermissionMode: permissionMode });

    setSpawnModalOpen(false);
    promptRef.current?.clear();
  };

  const handlePermissionModeChange = (newMode: PermissionMode) => {
    setPermissionMode(newMode);

    if (session && onUpdateSession) {
      onUpdateSession(session.session_id, {
        permission_config: {
          ...session.permission_config,
          mode: newMode,
        },
      });
    }
  };

  const handleCodexPermissionChange = (
    sandbox: CodexSandboxMode,
    approval: CodexApprovalPolicy
  ) => {
    setCodexSandboxMode(sandbox);
    setCodexApprovalPolicy(approval);

    if (session && onUpdateSession) {
      onUpdateSession(session.session_id, {
        permission_config: {
          ...session.permission_config,
          codex: {
            ...session.permission_config?.codex,
            sandboxMode: sandbox,
            approvalPolicy: approval,
          },
        },
      });
    }
  };

  const handleEffortChange = (newEffort: EffortLevel | undefined) => {
    setEffortLevel(newEffort);

    if (session?.model_config && onUpdateSession) {
      const nextModelConfig = {
        ...session.model_config,
        updated_at: new Date().toISOString(),
      };
      if (newEffort) nextModelConfig.effort = newEffort;
      else delete nextModelConfig.effort;
      onUpdateSession(session.session_id, { model_config: nextModelConfig });
    }
  };

  const handleServiceTierChange = (serviceTier: 'default' | 'fast') => {
    if (session?.model_config && onUpdateSession) {
      onUpdateSession(session.session_id, {
        model_config: {
          ...session.model_config,
          serviceTier,
          updated_at: new Date().toISOString(),
        },
      });
    }
  };

  const handleModelConfigChange = (newConfig: ModelConfig) => {
    if (session && onUpdateSession) {
      const nextConfig: NonNullable<Session['model_config']> = {
        ...session.model_config,
        mode: newConfig.mode,
        model: newConfig.model,
        ...(newConfig.provider ? { provider: newConfig.provider } : {}),
        updated_at: new Date().toISOString(),
      };
      // Honor the advisor selector's clear action. `model_config` is
      // column-replaced on patch, so we must DELETE the key when the user clears
      // it (allowClear → undefined) — the spread above would otherwise silently
      // carry the previous value forward (root cause of "no way to turn it off").
      if (newConfig.advisorModel) {
        nextConfig.advisorModel = newConfig.advisorModel;
      } else {
        delete nextConfig.advisorModel;
      }
      onUpdateSession(session.session_id, { model_config: nextConfig });
    }
  };

  // Re-point the stable footer wrappers at this render's implementations.
  // Render-phase ref write (instead of the usual useLayoutEffect) because the
  // impls above only exist when `session` is non-null, past the early return.
  footerHandlersRef.current = {
    onModelConfigChange: handleModelConfigChange,
    onSendPrompt: handleSendPrompt,
    onStop: handleStop,
    onFork: handleFork,
    onBtwSend: handleBtwSend,
    onSpawnOpen: handleSpawnOpen,
    onAttachFiles: () => attachmentInputRef.current?.click(),
    onUploadOpen: () => openAdvancedUpload(),
    onEffortChange: handleEffortChange,
    onServiceTierChange: handleServiceTierChange,
    onPermissionModeChange: handlePermissionModeChange,
    onCodexPermissionChange: handleCodexPermissionChange,
  };

  const sessionFooter = activeSession ? (
    <SimpleSessionFooter
      session={activeSession}
      currentUserId={currentUserId}
      tokenBreakdown={tokenBreakdown}
      isRunning={isRunning}
      isStopping={isStopping}
      stopRequestInFlight={stopRequestInFlight}
      hasInput={(hasInput || hasComposerAttachments) && !pendingComposerSend}
      composerAttachmentUploading={composerAttachmentUploading}
      composerAttachmentUploadProgress={composerAttachmentUploadProgress}
      connectionDisabled={connectionDisabled}
      toolCaps={toolCaps}
      effortLevel={effortLevel}
      client={client}
      modelConfig={modelConfig}
      serviceTier={session.model_config?.serviceTier ?? 'default'}
      onModelConfigChange={stableFooterHandlers.onModelConfigChange}
      onSendPrompt={stableFooterHandlers.onSendPrompt}
      onStop={stableFooterHandlers.onStop}
      onAttachFiles={stableFooterHandlers.onAttachFiles}
      onEffortChange={stableFooterHandlers.onEffortChange}
      onServiceTierChange={stableFooterHandlers.onServiceTierChange}
      promptInputSlot={promptInputSlot}
    />
  ) : null;

  const pendingComposerSubmission: PendingComposerSubmission | null = pendingComposerSend
    ? {
        text: pendingComposerSend.text,
        attachments: composerAttachments.filter((attachment) =>
          pendingComposerSend.attachmentIds.includes(attachment.id)
        ),
        uploadProgress: composerAttachmentUploadProgress,
        activity: pendingComposerSend.activity,
      }
    : null;

  return (
    <SessionComposerDropZone
      className="disco-session-panel"
      disabled={composerAttachmentUploading}
      onDragActiveChange={setComposerDropActive}
      onFilesDrop={addComposerAttachments}
      ariaLabel="当前对话文件拖放区域"
      style={{
        width: '100%',
        height: '100%',
        display: open ? 'flex' : 'none',
        flexDirection: 'column',
        background: token.colorBgElevated,
      }}
    >
      {/* Header */}
      <div
        className="disco-session-header"
        style={{
          flexShrink: 0,
          padding: '9px 18px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        {/* Row 1: icon + title + badge + actions, center-aligned */}
        <div
          className="disco-session-header-row"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div
            className="disco-session-header-identity"
            style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, minWidth: 0 }}
          >
            <div className="disco-session-header-icon" style={{ flexShrink: 0 }}>
              {agentEmoji ? (
                <div
                  style={{
                    width: 26,
                    height: 26,
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: 8,
                    background: token.colorFillSecondary,
                    fontSize: 16,
                  }}
                >
                  {agentEmoji}
                </div>
              ) : (
                <ToolIcon tool={session.agentic_tool} size={26} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {editingTitle ? (
                <Input
                  ref={titleInputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveTitle();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingTitle(false);
                    }
                  }}
                  placeholder="未命名对话"
                  aria-label="编辑当前对话标题"
                  maxLength={100}
                  variant="borderless"
                  className="disco-session-title-input"
                  style={{ fontSize: 14, fontWeight: 600, padding: '0 6px' }}
                />
              ) : (
                <Tooltip title="点击重命名">
                  <button
                    type="button"
                    onClick={startEditingTitle}
                    onMouseEnter={() => setTitleHovered(true)}
                    onMouseLeave={() => setTitleHovered(false)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      maxWidth: '100%',
                      cursor: 'text',
                      borderRadius: token.borderRadiusSM,
                      padding: '2px 6px',
                      margin: '-2px -6px',
                      background: titleHovered ? token.colorFillTertiary : 'transparent',
                      transition: 'background 0.15s',
                      border: 'none',
                      font: 'inherit',
                      color: 'inherit',
                      textAlign: 'left',
                    }}
                  >
                    <Typography.Text strong style={{ fontSize: 14, ...getSessionTitleStyles(2) }}>
                      {session.title || session.description
                        ? getSessionDisplayTitle(session, { includeAgentFallback: false })
                        : '未命名对话'}
                    </Typography.Text>
                    <EditOutlined
                      style={{
                        fontSize: 12,
                        color: token.colorTextTertiary,
                        opacity: titleHovered ? 1 : 0,
                        transition: 'opacity 0.15s',
                        flexShrink: 0,
                      }}
                    />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
          <Space size={4}>
            <Tooltip title="返回首页">
              <Button
                type="text"
                icon={<CloseOutlined />}
                onClick={onClose}
                style={{ marginLeft: token.sizeUnit }}
              />
            </Tooltip>
          </Space>
        </div>
      </div>

      {/* Body - Scrollable content */}
      <div
        ref={bodyRef}
        className="disco-session-body"
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          padding: '0 clamp(12px, 2vw, 24px)',
          position: 'relative',
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {!hasActiveAgenticTool && (
            <Alert
              type="warning"
              showIcon
              message="历史会话：原执行环境已移除"
              description="这段会话来自已经移除的实验性 Claude Code CLI 接入。历史内容仍可阅读，但不能继续发送消息或重新运行。"
              style={{ marginBottom: token.marginSM }}
            />
          )}
          <SessionPanelContent
            client={client}
            session={session}
            teammateEmoji={agentEmoji}
            currentUserId={currentUserId}
            sessionMcpServerIds={sessionMcpServerIds}
            scrollToBottom={scrollToBottom}
            scrollToTop={scrollToTop}
            setScrollToBottom={setScrollToBottom}
            setScrollToTop={setScrollToTop}
            queuedTasks={queuedTasks}
            setQueuedTasks={setQueuedTasks}
            onEditQueuedTask={editQueuedTask}
            spawnModalOpen={spawnModalOpen}
            setSpawnModalOpen={setSpawnModalOpen}
            onSpawnModalConfirm={handleSpawnModalConfirm}
            inputValueRef={inputValueRef}
            isOpen={open}
            pendingComposerSubmission={pendingComposerSubmission}
            footerSlot={sessionFooter}
          />
        </div>

        <Modal
          getContainer={getDiscoPortalContainer}
          title="确定强制结束任务吗？"
          open={forceFailTarget !== null}
          okText="强制结束"
          cancelText="取消"
          keyboard
          mask={{ closable: false }}
          confirmLoading={stopRequestInFlight}
          okButtonProps={{
            danger: true,
            disabled: forceFailConfirmation !== 'STOP',
          }}
          cancelButtonProps={{ disabled: stopRequestInFlight }}
          onOk={handleForceFail}
          onCancel={() => {
            if (stopRequestInFlight) return;
            setForceFailTarget(null);
            setForceFailConfirmation('');
          }}
          afterOpenChange={(modalOpen) => {
            if (modalOpen) forceFailInputRef.current?.focus();
          }}
        >
          <Alert
            type="warning"
            showIcon
            title="执行器是否已经停止无法确认"
            description="执行器可能仍在运行并写入项目。强制结束只会把 Disco 中的任务标记为失败并恢复此会话，无法保证系统进程已经终止。"
            style={{ marginBottom: token.marginMD }}
          />
          <Typography.Paragraph>
            输入 <Typography.Text code>STOP</Typography.Text> 后继续。
          </Typography.Paragraph>
          <Input
            ref={forceFailInputRef}
            aria-label="输入 STOP 确认强制结束"
            value={forceFailConfirmation}
            onChange={(event) => setForceFailConfirmation(event.target.value)}
            onPressEnter={() => {
              if (forceFailConfirmation === 'STOP') void handleForceFail();
            }}
            disabled={stopRequestInFlight}
            autoComplete="off"
          />
        </Modal>

        {/* Advanced upload modal preserves the existing file upload flow for
            non-image files and notify-agent options. */}
        <FileUpload
          sessionId={session.session_id}
          daemonUrl={getDaemonUrl()}
          open={uploadModalOpen}
          onClose={() => {
            setUploadModalOpen(false);
            setAdvancedUploadInitialFiles([]);
          }}
          initialFiles={advancedUploadInitialFiles}
          onUploadComplete={(files) => {
            showSuccess(`已上传 ${files.length} 个文件`);
          }}
          onInsertMention={(filepath) => {
            promptRef.current?.insertText(`@${filepath}`);
          }}
        />

        {/* Fork modal — opened when Fork button is clicked with an empty textarea */}
        <ForkSpawnModal
          open={forkModalOpen}
          action="fork"
          session={session}
          currentUser={currentUserId ? (userById.get(currentUserId) ?? null) : null}
          onConfirm={handleForkModalConfirm}
          onCancel={() => setForkModalOpen(false)}
          client={client}
          userById={userById}
        />
      </div>
    </SessionComposerDropZone>
  );
};

// SessionPanel reads only entity-context data (users, MCP servers) and receives
// session/branch as props. Wrapping with React.memo (default shallow compare)
// lets it bail out of re-renders triggered by App's live-context updates as
// long as its props are referentially stable. Callers MUST pass stable
// `onClose` and `sessionMcpServerIds` (use EMPTY_STRING_ARRAY for empty).
export default React.memo(SessionPanel);
