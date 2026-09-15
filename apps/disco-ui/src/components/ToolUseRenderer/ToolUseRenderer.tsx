/**
 * ToolUseRenderer - Displays tool invocations and results
 *
 * Renders tool_use and tool_result content blocks with:
 * - Custom renderers for specific tools (via registry)
 * - Tool output/result
 * - Error states
 * - Collapsible input parameters
 *
 * Custom renderers are defined in ./renderers/index.ts
 *
 * Note: This component does NOT use ThoughtChain - parent components
 * (like AgentChain) are responsible for wrapping this in ThoughtChain items.
 */

import type {
  ContentBlock as CoreContentBlock,
  DiffEnrichment,
  DiscoClient,
  Message,
} from '@disco-live/client';
import { Alert, Button, Spin, theme } from 'antd';
import { type FC, useEffect, useState } from 'react';
import { shouldUseAnsiRendering } from '../../utils/ansi';
import { toolResultToDisplayText } from '../../utils/toolResultToDisplayText';
import { CollapsibleText } from '../CollapsibleText';
import { CollapsibleAnsiText } from '../CollapsibleText/CollapsibleAnsiText';
import { ThemedSyntaxHighlighter } from '../ThemedSyntaxHighlighter';
import { getToolRenderer } from './renderers';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  deferred?: CoreContentBlock['deferred'];
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | CoreContentBlock[];
  is_error?: boolean;
  /** Executor-enriched diff data (best-effort, may not be present) */
  diff?: DiffEnrichment;
  deferred?: CoreContentBlock['deferred'];
}

interface ToolUseRendererProps {
  client?: DiscoClient | null;
  /**
   * Tool use block with invocation details
   */
  toolUse: ToolUseBlock;

  /**
   * Optional tool result block
   */
  toolResult?: ToolResultBlock;

  /** Compact Codex-style input/output view used inside the activity timeline. */
  compact?: boolean;
}

function compactInputText(name: string, input: Record<string, unknown>): string {
  const normalizedName = name.toLowerCase();
  if (normalizedName === 'bash' && input.command != null) {
    return Array.isArray(input.command)
      ? input.command.map(String).join(' ')
      : String(input.command);
  }
  if (input.file_path != null) return String(input.file_path);
  if (input.path != null) return String(input.path);
  if (input.query != null) return String(input.query);
  if (input.prompt != null) return String(input.prompt);
  if (Object.keys(input).length === 0) return '无额外输入';
  return JSON.stringify(input, null, 2);
}

export const ToolUseRenderer: FC<ToolUseRendererProps> = (props) => {
  if (props.toolUse.deferred || props.toolResult?.deferred) {
    const key = JSON.stringify([props.toolUse.deferred, props.toolResult?.deferred]);
    return <DeferredToolDetails key={key} {...props} />;
  }
  return <LoadedToolUseRenderer {...props} />;
};

// This component is mounted by the existing collapsed-body boundary only after
// the user opens the action. Never fetch full tool payloads to draw its header.
function DeferredToolDetails({ client, toolUse, toolResult, compact }: ToolUseRendererProps) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    client: DiscoClient;
    toolUse: ToolUseBlock;
    toolResult?: ToolResultBlock;
  } | null>(null);
  const [error, setError] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same failed request.
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(false);
    const messages = new Map<string, Promise<Message>>();
    const resolveBlock = async <T extends ToolUseBlock | ToolResultBlock>(block: T): Promise<T> => {
      if (!block.deferred) return block;
      if (!client) throw new Error('Message client unavailable');
      const { message_id, block_index } = block.deferred;
      let request = messages.get(message_id);
      if (!request) {
        request = client.service('messages').get(message_id);
        messages.set(message_id, request);
      }
      const message = await request;
      const original = Array.isArray(message.content) ? message.content[block_index] : undefined;
      const identity = block.type === 'tool_use' ? 'id' : 'tool_use_id';
      if (
        !original ||
        original.type !== block.type ||
        original.deferred ||
        original[identity] !== (block as unknown as Record<string, unknown>)[identity]
      ) {
        throw new Error('Tool detail no longer matches this action');
      }
      return original as unknown as T;
    };
    Promise.all([resolveBlock(toolUse), toolResult ? resolveBlock(toolResult) : undefined])
      .then(([fullUse, fullResult]) => {
        if (!cancelled && client) setResult({ client, toolUse: fullUse, toolResult: fullResult });
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, toolUse, toolResult, attempt]);

  if (error)
    return (
      <Alert
        type="error"
        title="工具详情加载失败"
        action={
          <Button size="small" onClick={() => setAttempt((value) => value + 1)}>
            重试
          </Button>
        }
      />
    );
  if (!result || result.client !== client)
    return <Spin size="small" aria-label="正在加载工具详情" />;
  return (
    <LoadedToolUseRenderer
      toolUse={result.toolUse}
      toolResult={result.toolResult}
      compact={compact}
    />
  );
}

const LoadedToolUseRenderer: FC<ToolUseRendererProps> = ({
  toolUse,
  toolResult,
  compact = false,
}) => {
  const { token } = theme.useToken();
  const { input, name } = toolUse;
  const isError = toolResult?.is_error;

  // Check for custom renderer
  const CustomRenderer = getToolRenderer(name);

  const getResultText = (): string => {
    if (!toolResult) return '';
    return toolResultToDisplayText(toolResult.content);
  };

  // Image viewing is a visual action: its body is always the preview itself,
  // never the generic JSON/path input and textual tool output.
  if (CustomRenderer && name.toLowerCase() === 'viewimage') {
    return (
      <CustomRenderer
        toolUseId={toolUse.id}
        input={input}
        compact={compact}
        result={
          toolResult
            ? {
                content: toolResult.content,
                is_error: toolResult.is_error,
                diff: toolResult.diff,
              }
            : undefined
        }
      />
    );
  }

  if (compact) {
    const resultText = getResultText().trim();
    return (
      <div className="disco-tool-io">
        <div className="disco-tool-io-section">
          <span className="disco-tool-io-label">输入</span>
          <pre>{compactInputText(name, input)}</pre>
        </div>
        <div className={`disco-tool-io-section${isError ? ' is-error' : ''}`}>
          <span className="disco-tool-io-label">{isError ? '输出（失败）' : '输出'}</span>
          <pre>{toolResult ? resultText || '无输出' : '等待结果…'}</pre>
        </div>
      </div>
    );
  }

  // Shared collapsible input parameters block
  const inputParamsBlock = (
    <details style={{ marginTop: token.sizeUnit }}>
      <summary
        style={{
          cursor: 'pointer',
          fontSize: 11,
          color: token.colorTextTertiary,
          userSelect: 'none',
        }}
      >
        Input parameters
      </summary>
      <ThemedSyntaxHighlighter
        language="json"
        PreTag="pre"
        customStyle={{
          marginTop: token.sizeUnit / 2,
          fontSize: 11,
          maxHeight: 300,
          overflow: 'auto',
        }}
      >
        {JSON.stringify(input, null, 2)}
      </ThemedSyntaxHighlighter>
    </details>
  );

  // If custom renderer exists, use it
  if (CustomRenderer) {
    return (
      <div>
        <CustomRenderer
          toolUseId={toolUse.id}
          input={input}
          result={
            toolResult
              ? {
                  content: toolResult.content,
                  is_error: toolResult.is_error,
                  diff: toolResult.diff,
                }
              : undefined
          }
        />
        {inputParamsBlock}
      </div>
    );
  }

  // Otherwise, use default generic renderer
  // Extract text content from tool result
  const resultText = getResultText();
  const hasContent = resultText.trim().length > 0;

  // Detect if we should use ANSI rendering for this tool output
  const useAnsi = shouldUseAnsiRendering(name, resultText);

  // Default generic content renderer (no ThoughtChain wrapper - that's handled by parent)
  return toolResult ? (
    <div>
      {/* Tool result */}
      <div
        style={{
          padding: token.sizeUnit,
          borderRadius: token.borderRadius,
          ...(isError && {
            background: token.colorErrorBg,
            border: `1px solid ${token.colorErrorBorder}`,
          }),
        }}
      >
        {useAnsi ? (
          <CollapsibleAnsiText
            style={{
              fontSize: token.fontSizeSM,
              margin: 0,
              color: token.colorTextSecondary,
              ...((!hasContent && {
                fontStyle: 'italic',
              }) as React.CSSProperties),
            }}
          >
            {hasContent ? resultText : '(no output)'}
          </CollapsibleAnsiText>
        ) : (
          <CollapsibleText
            code
            preserveWhitespace
            style={{
              fontSize: token.fontSizeSM,
              margin: 0,
              color: token.colorTextSecondary,
              ...((!hasContent && {
                fontStyle: 'italic',
              }) as React.CSSProperties),
            }}
          >
            {hasContent ? resultText : '(no output)'}
          </CollapsibleText>
        )}
      </div>

      {/* Tool input parameters (collapsible below result) */}
      {inputParamsBlock}
    </div>
  ) : (
    // No result yet — still show input parameters so users can see what's running
    <div>{inputParamsBlock}</div>
  );
};
