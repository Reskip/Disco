/**
 * MessageBlock - Renders individual messages with support for structured content
 *
 * Handles:
 * - Text content (string or TextBlock)
 * - Tool use blocks
 * - Tool result blocks
 * - User vs agent-message styling
 * - User emoji avatars
 */

import { SyncOutlined, WarningOutlined } from '@ant-design/icons';
import { type FileCitationContentBlock, formatFileCitationLocator } from '@disco/core/types';
import {
  type AgenticToolName,
  type ContentBlock as CoreContentBlock,
  type DiffEnrichment,
  type DiscoClient,
  isAgenticToolName,
  type Message,
  type PermissionRequestContent,
  PermissionScope,
  PermissionStatus,
  shortId,
  type User,
} from '@disco-live/client';
import { Button, theme } from 'antd';

import React, { useEffect, useRef, useState } from 'react';
import { MOBILE_WORKSPACE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { getToolDisplayName } from '../../utils/toolDisplayName';
import { toolResultToDisplayText } from '../../utils/toolResultToDisplayText';
import { CollapsibleMarkdown } from '../CollapsibleText/CollapsibleMarkdown';
import { CopyableContent } from '../CopyableContent';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { MissingCredentialPanel } from '../MissingCredentialPanel';
import { PermissionRequestBlock } from '../PermissionRequestBlock';
import { ProviderBillingRecoveryPanel } from '../ProviderBillingRecoveryPanel';
import { SystemMessage } from '../SystemMessage';
import { ThinkingBlock } from '../ThinkingBlock';
import {
  buildBashDescriptionNode,
  deriveToolStatus,
  IMPLICIT_RESULT_TOOLS,
  renderToolStatusIcon,
  shouldExpandToolByDefault,
  ToolBlock,
} from '../ToolBlock';
import { ToolUseRenderer } from '../ToolUseRenderer';
// Side-effect import: registers every built-in widget component with the
// `WidgetBlock` dispatcher (e.g. `env_vars`).
import '../Widgets';
import {
  MessageAttachments,
  MessageFileCitations,
  parseLegacyFileCitations,
  parseMessageAttachments,
} from './MessageAttachments';
import { WidgetBlock } from './WidgetBlock';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | CoreContentBlock[];
  is_error?: boolean;
  diff?: DiffEnrichment;
}

interface TextBlock {
  type: 'text';
  text: string;
}

type MessageSurfaceBlock = TextBlock | FileCitationContentBlock;

function legacyCitationMarker(citation: FileCitationContentBlock): string {
  const locator = formatFileCitationLocator(citation.locator);
  const displayName = citation.presentation?.title || citation.filename;
  return `${displayName}${locator && locator !== displayName ? `（${locator}）` : ''}`;
}

/**
 * The first deployed file-citation contract persisted the readable filename in
 * prose and appended every structured card at the end of the message. Reweave
 * that short-lived live format at render time so existing conversations keep
 * the citation at its original textual marker. Already ordered content is
 * returned untouched.
 */
function restoreTrailingFileCitationOrder(blocks: CoreContentBlock[]): CoreContentBlock[] {
  const firstCitationIndex = blocks.findIndex((block) => block.type === 'file_citation');
  if (firstCitationIndex < 0) return blocks;
  if (blocks.slice(firstCitationIndex).some((block) => block.type !== 'file_citation'))
    return blocks;

  const pending = blocks.slice(firstCitationIndex) as FileCitationContentBlock[];
  const restored: CoreContentBlock[] = [];
  let citationIndex = 0;

  for (const block of blocks.slice(0, firstCitationIndex)) {
    if (block.type !== 'text' || citationIndex >= pending.length) {
      restored.push(block);
      continue;
    }

    let remainingText = (block as unknown as TextBlock).text;
    while (citationIndex < pending.length) {
      const citation = pending[citationIndex]!;
      const marker = legacyCitationMarker(citation);
      let markerIndex = remainingText.indexOf(marker);
      let matchedLength = marker.length;
      if (markerIndex < 0 && marker !== citation.filename) {
        markerIndex = remainingText.indexOf(citation.filename);
        matchedLength = citation.filename.length;
      }
      if (markerIndex < 0) break;
      if (markerIndex > 0) {
        restored.push({ type: 'text', text: remainingText.slice(0, markerIndex) });
      }
      restored.push(citation);
      remainingText = remainingText.slice(markerIndex + matchedLength);
      citationIndex += 1;
    }
    if (remainingText) restored.push({ type: 'text', text: remainingText });
  }

  restored.push(...pending.slice(citationIndex));
  return restored;
}

interface ThinkingContentBlock {
  type: 'thinking';
  text: string;
  signature?: string;
}

interface MessageBlockProps {
  message:
    | Message
    | (Message & { isStreaming?: boolean; thinkingContent?: string; isThinking?: boolean });
  userById?: Map<string, User>;
  currentUserId?: string;
  isTaskRunning?: boolean; // Whether the task is running (for loading state)
  agentic_tool?: string; // Agentic tool name for showing tool icon
  sessionId?: string | null;
  taskId?: string;
  isFirstPendingPermission?: boolean; // For sequencing permission requests
  isLatestMessage?: boolean; // Whether this is the most recent message (don't collapse by default)
  teammateEmoji?: string; // Emoji override for teammate avatar (replaces tool icon)
  /** Authenticated Feathers client, forwarded to WidgetBlock for inline-form submission. */
  client?: DiscoClient | null;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
}

/** Get short description for a tool call (file path, pattern, command, etc.) */
function getToolDescription(toolUse: ToolUseBlock): string | undefined {
  const { name, input } = toolUse;
  if (typeof input.description === 'string') return input.description;
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path ? String(input.file_path) : undefined;
    case 'Bash':
      return input.description
        ? String(input.description)
        : input.command
          ? String(input.command)
          : undefined;
    case 'Grep':
    case 'Glob':
      return input.pattern ? String(input.pattern) : undefined;
    case 'ToolSearch':
    case 'WebSearch':
    case 'web_search':
      return input.query ? String(input.query) : undefined;
    case 'WebFetch':
      return input.url ? String(input.url) : undefined;
    case 'Agent':
      return input.description ? String(input.description) : undefined;
    case 'Skill':
    case 'SlashCommand':
      return input.skill ? String(input.skill) : input.name ? String(input.name) : undefined;
    case 'Task': {
      if (!input.prompt) return undefined;
      const firstLine = String(input.prompt).trim().split('\n')[0];
      return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      if (todos.length === 0) return undefined;
      const done = todos.filter((t: { status?: string }) => t.status === 'completed').length;
      const inProg = todos.filter((t: { status?: string }) => t.status === 'in_progress').length;
      const parts = [`${done}/${todos.length} done`];
      if (inProg > 0) parts.push(`${inProg} in progress`);
      return parts.join(', ');
    }
    case 'edit_files': {
      const changes = Array.isArray(input.changes) ? input.changes : [];
      if (changes.length === 0) return undefined;
      if (changes.length === 1) {
        const c = changes[0] as { path?: string; kind?: string };
        return `${c.kind || 'update'} ${c.path || ''}`;
      }
      return `${changes.length} files`;
    }
    default:
      return undefined;
  }
}

/**
 * Check if this is a Task tool prompt message (agent-generated, appears as user message)
 *
 * Task tool prompts are user role messages with array content containing text blocks.
 * These are NOT real user messages - they're the prompts the agent sends to subsessions.
 */
function isTaskToolPrompt(message: Message): boolean {
  // Must be user role
  if (message.role !== 'user') return false;

  // Must have array content (not string)
  if (!Array.isArray(message.content)) return false;

  // Must have at least one text block (not tool_result)
  const hasTextBlock = message.content.some((block) => block.type === 'text');
  const hasOnlyTextBlocks = message.content.every(
    (block) => block.type === 'text' || block.type === 'thinking'
  );

  // If it has text blocks and NO tool_result blocks, it's likely a Task prompt
  return hasTextBlock && hasOnlyTextBlocks;
}

/**
 * Check if this is a Task tool result message (should display as agent message)
 */
function isTaskToolResult(message: Message): boolean {
  // Must be user role with array content
  if (message.role !== 'user' || !Array.isArray(message.content)) return false;

  // Check if contains tool_result block
  // Note: We can't easily determine if it's specifically a Task result here,
  // but groupMessagesIntoBlocks ensures only Task results reach this as non-chain messages
  const hasToolResult = message.content.some((block) => block.type === 'tool_result');

  // User messages with tool_results that aren't in agent chains are likely Task results
  return hasToolResult;
}

interface DaemonRestartNoticeProps {
  isGraceful: boolean;
  text: string;
  sessionId?: string | null;
  client?: DiscoClient | null;
  isTaskRunning?: boolean;
}

function DaemonRestartNotice({
  isGraceful,
  text,
  sessionId,
  client,
  isTaskRunning = false,
}: DaemonRestartNoticeProps) {
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(false);
  const [resumed, setResumed] = useState(false);

  const handleResume = async () => {
    if (!client || !sessionId) return;
    setLoading(true);
    try {
      await client.sessions.prompt(sessionId, '请从 Disco 服务重启前中断的位置继续。');
      setResumed(true);
    } catch (err) {
      console.error('Failed to send resume prompt:', err);
    } finally {
      setLoading(false);
    }
  };

  const showButton = !!client && !!sessionId && !resumed && !isTaskRunning;

  return (
    <SystemMessage
      content={
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span
            style={{
              color: isGraceful ? token.colorInfo : token.colorWarning,
              flexShrink: 0,
              marginTop: 2,
            }}
          >
            {isGraceful ? <SyncOutlined /> : <WarningOutlined />}
          </span>
          <div style={{ fontSize: 13, flex: 1 }}>
            <MarkdownRenderer content={text} />
            {showButton && (
              <Button
                size="small"
                type="primary"
                loading={loading}
                onClick={handleResume}
                style={{ marginTop: 6 }}
              >
                继续
              </Button>
            )}
          </div>
        </div>
      }
    />
  );
}

// Memoized: every text block / tool block of every message in the conversation
// re-rendered on every streaming chunk because TaskBlock's `messages` array
// gets a fresh reference each tick. Default shallow compare is sufficient
// here because callers pass:
//   - `message`: stable per message_id (only the actively streaming message
//     gets a new ref each chunk — correct: it should re-render)
//   - `userById`: from AppUserDataContext (stable across session patches)
//   - `currentUserId`, `agentic_tool`, `sessionId`, `taskId`, `teammateEmoji`,
//     `isTaskRunning`, `isLatestMessage`, `isFirstPending*`: primitives or
//     stable derived values
//   - `onPermissionDecision`, `onInputResponse`: useCallback-wrapped in App.tsx
//     and passed through useMemo'd AppActionsContext
function safeStreamingSliceEnd(value: string, proposedEnd: number): number {
  if (proposedEnd >= value.length) return value.length;
  const prior = value.charCodeAt(proposedEnd - 1);
  const next = value.charCodeAt(proposedEnd);
  return prior >= 0xd800 && prior <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? proposedEnd + 1
    : proposedEnd;
}

/**
 * REST streaming may deliver several words in one network chunk. Reveal that
 * append over a handful of animation frames so prose remains visually
 * continuous, while Streamdown still receives valid partial Markdown and can
 * open code/math containers as soon as their delimiter arrives.
 */
function useSmoothStreamingText(value: string, isStreaming: boolean): string {
  const [displayed, setDisplayed] = useState(value);
  const displayedRef = useRef(value);
  const targetRef = useRef(value);
  const frameRef = useRef<number | null>(null);
  const wasStreamingRef = useRef(isStreaming);

  useEffect(() => {
    targetRef.current = value;
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;

    if (!value.startsWith(displayedRef.current) || (!isStreaming && !wasStreaming)) {
      displayedRef.current = value;
      setDisplayed(value);
      return;
    }

    const revealNextFrame = () => {
      const current = displayedRef.current;
      const target = targetRef.current;
      if (!target.startsWith(current)) {
        displayedRef.current = target;
        setDisplayed(target);
        frameRef.current = null;
        return;
      }
      const remaining = target.length - current.length;
      if (remaining <= 0) {
        frameRef.current = null;
        return;
      }
      const step = Math.min(48, Math.max(2, Math.ceil(remaining / 6)));
      const end = safeStreamingSliceEnd(target, current.length + step);
      const next = target.slice(0, end);
      displayedRef.current = next;
      setDisplayed(next);
      frameRef.current = requestAnimationFrame(revealNextFrame);
    };

    if (displayedRef.current !== value && frameRef.current === null) {
      frameRef.current = requestAnimationFrame(revealNextFrame);
    }
  }, [isStreaming, value]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  return displayed;
}

const CODEX_CAPACITY_ERROR_PATTERN =
  /(?:Codex stream error:\s*)?Selected model is at capacity\. Please try a different model\.?/gi;
const CODEX_CAPACITY_ERROR_MESSAGE =
  '所选模型当前繁忙，Disco 已自动重试但仍未恢复。请稍后重试，或切换其他模型。';
const CODEX_CAPACITY_FAILURE_PATTERN =
  /(?:Selected model is at capacity|所选模型当前繁忙|远端模型服务持续繁忙)/i;

function normalizeAssistantErrorText(value: string): string {
  return value.replace(CODEX_CAPACITY_ERROR_PATTERN, CODEX_CAPACITY_ERROR_MESSAGE);
}

function CapacityRecoveryActions({
  client,
  sessionId,
  taskId,
}: {
  client: DiscoClient | null;
  sessionId?: string | null;
  taskId?: string;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retried, setRetried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMobileWorkspace = useMediaQuery(MOBILE_WORKSPACE_QUERY);

  const retryTask = async () => {
    if (!client || !sessionId || !taskId || retrying || retried) return;
    setRetrying(true);
    setError(null);
    try {
      const failedTask = await client.service('tasks').get(taskId);
      const prompt =
        typeof failedTask.full_prompt === 'string' ? failedTask.full_prompt.trim() : '';
      if (!prompt) throw new Error('找不到原始消息');
      await client.sessions.prompt(sessionId, prompt);
      setRetried(true);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setRetrying(false);
    }
  };

  const openModelPicker = () => {
    const trigger = document.querySelector<HTMLElement>(
      '.disco-simple-composer-model .ant-select-selector, [data-testid="model-chip"]'
    );
    if (!trigger) {
      setError('当前模型选择器不可用，请在输入框右下角切换模型。');
      return;
    }
    trigger.focus();
    trigger.click();
  };

  return (
    <div className="disco-capacity-recovery" aria-label="模型繁忙恢复操作">
      {client && sessionId && taskId && (
        <button
          type="button"
          className="disco-capacity-recovery-action"
          disabled={retrying || retried}
          onClick={retryTask}
        >
          {retrying ? '正在重新提交…' : retried ? '已重新提交' : '立即重试'}
        </button>
      )}
      {!isMobileWorkspace && (
        <button type="button" className="disco-capacity-recovery-action" onClick={openModelPicker}>
          切换模型
        </button>
      )}
      {error && <span className="disco-capacity-recovery-error">{error}</span>}
    </div>
  );
}

function MessageTextSurface({
  texts,
  isUser,
  isCallback,
  isStreaming,
  isLatestMessage,
  client,
  sessionId,
  taskId,
}: {
  texts: string[];
  isUser: boolean;
  isCallback: boolean;
  isStreaming: boolean;
  isLatestMessage: boolean;
  client?: DiscoClient | null;
  sessionId?: string | null;
  taskId?: string;
}) {
  const combinedText = texts.join('\n\n');
  const displayText = isUser ? combinedText : normalizeAssistantErrorText(combinedText);
  const isCapacityFailure = !isUser && CODEX_CAPACITY_FAILURE_PATTERN.test(combinedText);
  const smoothText = useSmoothStreamingText(displayText, isStreaming);
  const parsed = parseMessageAttachments(smoothText);
  const legacyCitations = isUser
    ? {
        citations: [],
        visibleText: parsed.visibleText,
        segments: parsed.visibleText
          ? ([{ type: 'text', text: parsed.visibleText }] as MessageSurfaceBlock[])
          : [],
      }
    : parseLegacyFileCitations(parsed.visibleText);
  const renderAsStreaming = isStreaming || smoothText !== displayText;
  const shouldTruncate = isUser && legacyCitations.visibleText.split('\n').length > 16;

  if (
    !legacyCitations.visibleText &&
    parsed.attachments.length === 0 &&
    legacyCitations.citations.length === 0
  ) {
    return null;
  }

  return (
    <div
      className={[
        'disco-message-row',
        isUser ? 'is-user' : 'is-assistant',
        isCallback ? 'is-callback' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className={`disco-message-surface${
          parsed.attachments.length > 0 || legacyCitations.citations.length > 0
            ? ' has-attachments'
            : ''
        }`}
      >
        <MessageAttachments attachments={parsed.attachments} />
        {legacyCitations.segments.map((segment, index) =>
          segment.type === 'file_citation' ? (
            <MessageFileCitations
              key={`citation:${segment.upload_ref ?? segment.filename}:${index}`}
              citations={[segment]}
            />
          ) : segment.text.trim() ? (
            <CopyableContent
              key={`text:${index}`}
              textContent={segment.text}
              copyTooltip="复制消息"
            >
              <div className="disco-message-markdown">
                {shouldTruncate && legacyCitations.segments.length === 1 ? (
                  <CollapsibleMarkdown
                    maxLines={12}
                    defaultExpanded={isLatestMessage}
                    isStreaming={renderAsStreaming}
                  >
                    {segment.text}
                  </CollapsibleMarkdown>
                ) : (
                  <MarkdownRenderer content={segment.text} inline isStreaming={renderAsStreaming} />
                )}
              </div>
            </CopyableContent>
          ) : null
        )}
        {isCapacityFailure && !renderAsStreaming && (
          <CapacityRecoveryActions client={client ?? null} sessionId={sessionId} taskId={taskId} />
        )}
      </div>
    </div>
  );
}

function MessageSurfaceSequence({
  blocks,
  isUser,
  isCallback,
  isStreaming,
  isLatestMessage,
  client,
  sessionId,
  taskId,
}: {
  blocks: MessageSurfaceBlock[];
  isUser: boolean;
  isCallback: boolean;
  isStreaming: boolean;
  isLatestMessage: boolean;
  client?: DiscoClient | null;
  sessionId?: string | null;
  taskId?: string;
}) {
  const groups: Array<
    | { type: 'text'; texts: string[] }
    | { type: 'file_citation'; citations: FileCitationContentBlock[] }
  > = [];
  for (const block of blocks) {
    const previous = groups.at(-1);
    if (block.type === 'text') {
      if (previous?.type === 'text') previous.texts.push(block.text);
      else groups.push({ type: 'text', texts: [block.text] });
    } else if (previous?.type === 'file_citation') {
      previous.citations.push(block);
    } else {
      groups.push({ type: 'file_citation', citations: [block] });
    }
  }

  return (
    <>
      {groups.map((group, index) =>
        group.type === 'text' ? (
          <MessageTextSurface
            key={`text:${index}`}
            texts={group.texts}
            isUser={isUser}
            isCallback={isCallback}
            isStreaming={isStreaming}
            isLatestMessage={isLatestMessage}
            client={client}
            sessionId={sessionId}
            taskId={taskId}
          />
        ) : (
          <div
            key={`citations:${index}`}
            className={[
              'disco-message-row',
              isUser ? 'is-user' : 'is-assistant',
              isCallback ? 'is-callback' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="disco-message-surface has-attachments">
              <MessageFileCitations citations={group.citations} />
            </div>
          </div>
        )
      )}
    </>
  );
}

const MessageBlockInner: React.FC<MessageBlockProps> = ({
  message,
  isTaskRunning = false,
  agentic_tool,
  sessionId,
  taskId,
  isFirstPendingPermission = false,
  isLatestMessage = false,
  onPermissionDecision,
  client = null,
  onOpenAgenticToolSettings,
}) => {
  const { token } = theme.useToken();

  // Handle permission request messages specially
  if (message.type === 'permission_request') {
    const content = message.content as PermissionRequestContent;
    const isPending = content.status === PermissionStatus.PENDING;

    // Only allow interaction with the first pending permission request (sequencing)
    const canInteract = isPending && isFirstPendingPermission;

    return (
      <div style={{ margin: `${token.sizeUnit * 1.5}px 0` }}>
        <PermissionRequestBlock
          message={message}
          content={content}
          isActive={canInteract}
          agenticTool={agentic_tool}
          onApprove={
            canInteract && onPermissionDecision && sessionId && taskId
              ? (messageId, scope) => {
                  onPermissionDecision(sessionId, content.request_id, taskId, true, scope);
                }
              : undefined
          }
          onDeny={
            canInteract && onPermissionDecision && sessionId && taskId
              ? (_messageId) => {
                  onPermissionDecision(
                    sessionId,
                    content.request_id,
                    taskId,
                    false,
                    PermissionScope.ONCE
                  );
                }
              : undefined
          }
          isWaiting={isPending && !isFirstPendingPermission}
        />
      </div>
    );
  }

  // Legacy `input_request` messages (from before AskUserQuestion was disallowed
  // in #1177) are skipped — the interactive widget no longer ships, and the
  // surrounding agent text already carries the question/answer context.
  if (message.type === 'input_request') {
    return null;
  }

  // In-conversation interactive widgets. WidgetBlock looks up the registered
  // component by `metadata.widget.widget_type` and falls back to an
  // "Unknown widget type" placeholder for forward-compat with newer
  // daemons. See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
  if (message.type === 'widget_request') {
    return (
      <div style={{ margin: `${token.sizeUnit * 1.5}px 0` }}>
        <WidgetBlock message={message} client={client} />
      </div>
    );
  }

  // Check if this is a Task tool prompt or result (agent-generated, but has user role)
  const isTaskPrompt = isTaskToolPrompt(message);
  const isTaskResult = isTaskToolResult(message);
  const isSystem = message.role === 'system';
  const isCallback = message.metadata?.is_disco_callback === true;

  // Determine if this should be displayed as user or agent message
  const isUser = message.role === 'user' && !isTaskPrompt && !isTaskResult;
  const isAgent = message.role === 'assistant' || isTaskPrompt || isTaskResult || isSystem;

  // Check if message is currently streaming
  const isStreaming = 'isStreaming' in message && message.isStreaming === true;

  // Determine loading vs typing state:
  // - loading: task is running but no streaming chunks yet (waiting for first token)
  // - typing: streaming has started (we have content)
  const hasContent =
    typeof message.content === 'string'
      ? message.content.trim().length > 0
      : Array.isArray(message.content) && message.content.length > 0;
  const isLoading = isTaskRunning && !hasContent && isAgent;
  const shouldUseTyping = isStreaming && hasContent;

  // Missing-credential failure — show the Connect-AI panel, not the raw error.
  if (
    isSystem &&
    message.metadata?.error_kind === 'missing_credential' &&
    isAgenticToolName(message.metadata?.tool)
  ) {
    return (
      <MissingCredentialPanel
        tool={message.metadata.tool}
        client={client}
        onOpenAgenticToolSettings={onOpenAgenticToolSettings}
      />
    );
  }

  // Provider credit/quota failure — show recovery actions, not the raw result.
  if (
    isSystem &&
    message.metadata?.error_kind === 'provider_credit_exhausted' &&
    isAgenticToolName(message.metadata?.tool)
  ) {
    return (
      <ProviderBillingRecoveryPanel
        tool={message.metadata.tool}
        onOpenAgenticToolSettings={onOpenAgenticToolSettings}
      />
    );
  }

  // Skip rendering if message has no content
  if (!message.content || (typeof message.content === 'string' && message.content.trim() === '')) {
    return null;
  }

  // Skip rendering if message has empty content array (can happen during patch events)
  if (Array.isArray(message.content) && message.content.length === 0) {
    return null;
  }

  // Special handling for system messages
  // Note: Compaction events are now handled by CompactionBlock in TaskBlock grouping
  if (isSystem && message.metadata?.is_btw_result) {
    const btwResponse =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              // biome-ignore lint/suspicious/noExplicitAny: Content block types vary
              .filter((b: any) => b.type === 'text')
              // biome-ignore lint/suspicious/noExplicitAny: Content block types vary
              .map((b: any) => b.text)
              .join('\n\n')
          : '';
    const btwPrompt = message.metadata?.btw_prompt as string | undefined;
    const btwSessionId = message.metadata?.btw_session_id as string | undefined;
    const btwShortId = btwSessionId ? shortId(btwSessionId) : undefined;
    const callerSessionId = message.metadata?.btw_caller_session_id as string | undefined;
    const callerTitle = message.metadata?.btw_caller_title as string | undefined;
    const callerShortId = callerSessionId ? shortId(callerSessionId) : undefined;
    const isRemote = !!callerSessionId;

    // Build markdown content
    const lines: string[] = [];
    if (isRemote) {
      const callerLink = callerTitle
        ? `[${callerTitle} (${callerShortId})](#session/${callerSessionId})`
        : `[${callerShortId}](#session/${callerSessionId})`;
      const forkLink = `[btw (${btwShortId})](#session/${btwSessionId})`;
      lines.push(`From ${callerLink} · ${forkLink}`);
    }
    if (btwPrompt) {
      lines.push(`> ${btwPrompt.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }
    lines.push(btwResponse);
    const markdownContent = lines.join('\n');

    return (
      <div
        style={{
          border: `1px solid ${token.colorWarning}`,
          borderRadius: token.borderRadiusLG,
          padding: '8px 12px',
          margin: '8px 0',
          background: token.colorWarningBg,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: token.colorWarning,
            marginBottom: 4,
          }}
        >
          btw
        </div>
        <MarkdownRenderer content={markdownContent} />
      </div>
    );
  }

  // Daemon restart / crash notice — injected by startup reconciliation.
  // Intentionally low-frequency and user-meaningful; contrast with PR #1116
  // which filtered high-frequency SDK lifecycle noise.
  if (message.type === 'daemon_restart' || message.type === 'daemon_crash') {
    const isGraceful = message.type === 'daemon_restart';
    const text = typeof message.content === 'string' ? message.content : '';
    return (
      <DaemonRestartNotice
        isGraceful={isGraceful}
        text={text}
        sessionId={sessionId}
        client={client}
        isTaskRunning={isTaskRunning}
      />
    );
  }

  if (isSystem && Array.isArray(message.content)) {
    // Other system message types handled elsewhere (e.g., compaction in TaskBlock)
  }

  // Parse content blocks from message, preserving order
  const getContentBlocks = (): {
    thinkingBlocks: string[];
    contentBeforeTools: MessageSurfaceBlock[];
    toolBlocks: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }[];
    contentAfterTools: MessageSurfaceBlock[];
  } => {
    const thinkingBlocks: string[] = [];
    const contentBeforeTools: MessageSurfaceBlock[] = [];
    const contentAfterTools: MessageSurfaceBlock[] = [];
    const toolBlocks: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }[] = [];

    // Handle string content
    if (typeof message.content === 'string') {
      // Add Task tool prefix if this is a Task prompt
      const content = isTaskPrompt ? `[Task Tool]\n${message.content}` : message.content;
      return {
        thinkingBlocks: [],
        contentBeforeTools: [{ type: 'text', text: content }],
        toolBlocks: [],
        contentAfterTools: [],
      };
    }

    // Handle array of content blocks
    if (Array.isArray(message.content)) {
      const toolUseMap = new Map<string, ToolUseBlock>();
      const toolResultMap = new Map<string, ToolResultBlock>();
      const hiddenToolUseIds = new Set<string>();
      let hasSeenTool = false;

      // First pass: collect blocks and track order
      for (const block of restoreTrailingFileCitationOrder(message.content)) {
        if (block.type === 'thinking') {
          const text = (block as unknown as ThinkingContentBlock).text;
          thinkingBlocks.push(text);
        } else if (block.type === 'text') {
          let text = (block as unknown as TextBlock).text;

          // Add Task tool prefix to the first text block if this is a Task prompt
          if (isTaskPrompt && contentBeforeTools.length === 0 && !hasSeenTool) {
            text = `[Task Tool]\n${text}`;
          }

          if (hasSeenTool) {
            contentAfterTools.push({ type: 'text', text });
          } else {
            contentBeforeTools.push({ type: 'text', text });
          }
        } else if (block.type === 'file_citation') {
          const citation = block as FileCitationContentBlock;
          if (hasSeenTool) contentAfterTools.push(citation);
          else contentBeforeTools.push(citation);
        } else if (block.type === 'tool_use') {
          const toolUse = block as unknown as ToolUseBlock;

          // TodoWrite drives the floating task-plan control above the composer.
          // Rendering the same update in the chronological behavior chain is
          // duplicate UI and makes a model bookkeeping event look like work.
          if (toolUse.name === 'TodoWrite') {
            hiddenToolUseIds.add(toolUse.id);
            continue;
          }

          // Special handling: Task tools display as text, not tool blocks
          if (toolUse.name === 'Task') {
            // Store in tool map to check for results later
            toolUseMap.set(toolUse.id, toolUse);
            hasSeenTool = true;
          } else {
            // Regular tools go into tool map
            toolUseMap.set(toolUse.id, toolUse);
            hasSeenTool = true;
          }
        } else if (block.type === 'tool_result') {
          const toolResult = block as unknown as ToolResultBlock;
          if (hiddenToolUseIds.has(toolResult.tool_use_id)) continue;
          toolResultMap.set(toolResult.tool_use_id, toolResult);

          // Special handling: If this is a Task tool result (user message rendered as agent),
          // extract text content and display it
          if (isTaskResult) {
            const resultText = toolResultToDisplayText(toolResult.content);

            if (resultText.trim()) {
              contentBeforeTools.push({ type: 'text', text: resultText });
            }
          }
        }
      }

      // Second pass: match tool_use with tool_result
      // Separate Task tools from regular tools
      for (const [id, toolUse] of toolUseMap.entries()) {
        if (toolUse.name === 'Task') {
          // Task tools: render as text message (spinner is shown in the tool chain)
          const subagentType = toolUse.input.subagent_type || 'Task';
          const description = toolUse.input.description || '';
          const taskText = `🔧 **Task (${subagentType}):** ${description}`;

          contentBeforeTools.push({ type: 'text', text: taskText });
        } else {
          // Regular tools
          toolBlocks.push({
            toolUse,
            toolResult: toolResultMap.get(id),
          });
        }
      }
    }

    return { thinkingBlocks, contentBeforeTools, toolBlocks, contentAfterTools };
  };

  const { thinkingBlocks, contentBeforeTools, toolBlocks, contentAfterTools } = getContentBlocks();

  // Also check for streaming thinking content
  const streamingThinking = 'thinkingContent' in message ? message.thinkingContent : undefined;
  const isThinking = 'isThinking' in message ? message.isThinking : false;

  // Skip rendering if message has no meaningful content
  const hasThinking =
    thinkingBlocks.length > 0 || (streamingThinking && streamingThinking.length > 0);
  const hasContentBefore = contentBeforeTools.some(
    (block) => block.type === 'file_citation' || block.text.trim().length > 0
  );
  const hasContentAfter = contentAfterTools.some(
    (block) => block.type === 'file_citation' || block.text.trim().length > 0
  );
  const hasTools = toolBlocks.length > 0;

  if (!hasThinking && !hasContentBefore && !hasContentAfter && !hasTools) {
    return null;
  }

  // IMPORTANT: For messages with tools AND text:
  // 1. Show thinking first (if any)
  // 2. Show tools next (compact, no bubble)
  // 3. Show text after as a response bubble
  // This matches the expected UX: thought process → actions → results

  return (
    <>
      {/* Thinking blocks (collapsed by default) */}
      {hasThinking && (
        <ThinkingBlock
          content={streamingThinking || thinkingBlocks.join('\n\n')}
          isStreaming={isThinking}
          defaultExpanded={false}
        />
      )}

      {/* Text before tools (if any) - rare but possible */}
      {hasContentBefore && (
        <MessageSurfaceSequence
          blocks={contentBeforeTools}
          isUser={isUser}
          isCallback={isCallback}
          isStreaming={isStreaming || shouldUseTyping || isLoading}
          isLatestMessage={isLatestMessage}
          client={client}
          sessionId={sessionId}
          taskId={taskId}
        />
      )}

      {/* Tools (compact, no bubble) */}
      {hasTools && (
        <div
          style={{
            margin: `${token.sizeUnit * 1.5}px 0`,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {/* Index of last tool with a result — tools after this are potentially running */}
          {(() => {
            let lastResultIndex = -1;
            for (let i = toolBlocks.length - 1; i >= 0; i--) {
              if (toolBlocks[i].toolResult) {
                lastResultIndex = i;
                break;
              }
            }
            return toolBlocks.map(({ toolUse, toolResult }, toolIndex) => {
              const displayName = getToolDisplayName(toolUse.name, toolUse.input);
              const hasImplicitResult = IMPLICIT_RESULT_TOOLS.has(toolUse.name);

              // A tool is potentially still running when no subsequent tool in
              // this message has a result AND this is the latest message.
              // This correctly handles concurrent tool calls (e.g. multiple
              // WebSearch calls) — they all show as "pending" simultaneously.
              const isPotentiallyRunning = toolIndex > lastResultIndex && isLatestMessage;

              const status = deriveToolStatus({
                hasResult: !!toolResult || hasImplicitResult,
                isError: !!toolResult?.is_error,
                isPotentiallyRunning,
                isTaskRunning,
              });
              const icon = renderToolStatusIcon(status);

              const bashNode =
                toolUse.name === 'Bash'
                  ? buildBashDescriptionNode(toolUse.input, token)
                  : undefined;

              return (
                <ToolBlock
                  key={toolUse.id}
                  icon={icon}
                  name={displayName}
                  description={bashNode ? undefined : getToolDescription(toolUse)}
                  descriptionNode={bashNode}
                  status={status}
                  expandedByDefault={shouldExpandToolByDefault(toolUse.name)}
                >
                  <ToolUseRenderer toolUse={toolUse} toolResult={toolResult} />
                </ToolBlock>
              );
            });
          })()}
        </div>
      )}

      {/* Response text after tools */}
      {hasContentAfter && (
        <MessageSurfaceSequence
          blocks={contentAfterTools}
          isUser={false}
          isCallback={isCallback}
          isStreaming={isStreaming || shouldUseTyping || isLoading}
          isLatestMessage={isLatestMessage}
          client={client}
          sessionId={sessionId}
          taskId={taskId}
        />
      )}
    </>
  );
};

export const MessageBlock = React.memo(MessageBlockInner);
MessageBlock.displayName = 'MessageBlock';
