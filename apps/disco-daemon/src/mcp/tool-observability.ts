import type { McpServer } from '@modelcontextprotocol/server';
import { wrapRegisterTool } from './register-tool-proxy.js';
import type { ToolAudience, ToolEntry } from './tool-registry.js';

interface ToolInvocationContext {
  userId: string;
  sessionId?: string;
  agentId?: string;
  audiences: readonly ToolAudience[];
}

export interface ToolInvocationLogRecord {
  event: 'disco_method_call';
  phase: 'started' | 'completed';
  provider: 'disco-mcp';
  method: string;
  domain: string;
  scope: 'account' | 'standalone' | 'agent';
  ownership: string;
  audiences: readonly ToolAudience[];
  user_id: string;
  target: {
    user_id: string;
    session_id?: string;
    agent_id?: string;
    requested_user_id?: string;
  };
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  status?: 'succeeded' | 'failed';
  result_types?: string[];
  error_class?: string;
}

export type ToolInvocationLogSink = (record: ToolInvocationLogRecord) => void;

interface ToolInvocationObserverOptions {
  context: ToolInvocationContext;
  getEntry: (method: string) => ToolEntry | undefined;
  now?: () => number;
  sink?: ToolInvocationLogSink;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 160 ? trimmed : undefined;
}

function firstArgumentString(
  args: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = boundedString(args?.[key]);
    if (value) return value;
  }
  return undefined;
}

function invocationTarget(context: ToolInvocationContext, args: unknown) {
  const values = record(args);
  const requestedUserId = firstArgumentString(values, ['targetUserId', 'userId']);
  const requestedSessionId = firstArgumentString(values, [
    'targetSessionId',
    'sessionId',
    'sourceSessionId',
  ]);
  const requestedAgentId = firstArgumentString(values, ['targetAgentId', 'agentId']);
  return {
    user_id: context.userId,
    ...(requestedSessionId || context.sessionId
      ? { session_id: requestedSessionId ?? context.sessionId }
      : {}),
    ...(requestedAgentId || context.agentId
      ? { agent_id: requestedAgentId ?? context.agentId }
      : {}),
    ...(requestedUserId && requestedUserId !== context.userId
      ? { requested_user_id: requestedUserId }
      : {}),
  };
}

function invocationScope(context: ToolInvocationContext): ToolInvocationLogRecord['scope'] {
  if (context.agentId) return 'agent';
  if (context.sessionId) return 'standalone';
  return 'account';
}

function resultTypes(value: unknown): string[] {
  const result = record(value);
  if (!result) return ['empty'];
  const types = new Set<string>();
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    const type = boundedString(record(item)?.type);
    if (type) types.add(type);
  }
  const structured = record(result.structuredContent);
  const displayKind = boundedString(structured?.display_kind);
  if (displayKind) types.add(displayKind);
  let hasSpecificStructuredType = Boolean(displayKind);
  if (structured?.type === 'disco_file_publication' && Array.isArray(structured.files)) {
    for (const file of structured.files) {
      const displayType = boundedString(record(file)?.displayType);
      if (!displayType) continue;
      types.add(displayType);
      hasSpecificStructuredType = true;
    }
  }
  if (structured && !hasSpecificStructuredType) types.add('structured');
  if (types.size === 0) types.add('empty');
  return [...types].sort();
}

function classifyError(error: unknown): string {
  const value = record(error);
  const code = boundedString(value?.code)?.toLowerCase() ?? '';
  const name = boundedString(value?.name)?.toLowerCase() ?? '';
  const status = Number(value?.status ?? value?.statusCode);
  const signature = `${name} ${code}`;
  if (status === 401 || status === 403 || /forbidden|unauthori|permission/u.test(signature)) {
    return 'authorization';
  }
  if (status === 404 || /not.?found/u.test(signature)) return 'not_found';
  if (status === 409 || /conflict/u.test(signature)) return 'conflict';
  if (status === 408 || status === 504 || /timeout|timed.?out/u.test(signature)) return 'timeout';
  if (status === 429 || /capacity|rate.?limit/u.test(signature)) return 'capacity';
  if (status === 400 || /validation|invalid|bad.?request/u.test(signature)) return 'validation';
  return 'internal';
}

function defaultSink(entry: ToolInvocationLogRecord): void {
  console.info(JSON.stringify(entry));
}

/**
 * Emit one bounded structured start/end record for every Disco MCP method.
 * Arguments, file paths, prompts and result bodies are deliberately excluded;
 * logs retain only authenticated identity, resolved target IDs and result kind.
 */
export function observedToolRegistrationProxy(
  server: McpServer,
  options: ToolInvocationObserverOptions
): McpServer {
  const now = options.now ?? Date.now;
  const sink = options.sink ?? defaultSink;
  return wrapRegisterTool(server, (register, method, config, handler) =>
    register(method, config, async (args, extra) => {
      const startedAtMs = now();
      const entry = options.getEntry(method);
      const base = {
        event: 'disco_method_call' as const,
        provider: 'disco-mcp' as const,
        method,
        domain: entry?.domain ?? 'unknown',
        scope: invocationScope(options.context),
        ownership: entry?.governance.ownership ?? 'context-dependent',
        audiences: entry?.governance.audiences ?? options.context.audiences,
        user_id: options.context.userId,
        target: invocationTarget(options.context, args),
        started_at: new Date(startedAtMs).toISOString(),
      };
      sink({ ...base, phase: 'started' });
      try {
        const result = await Promise.resolve(handler(args, extra));
        const completedAtMs = now();
        const failed = record(result)?.isError === true;
        sink({
          ...base,
          phase: 'completed',
          completed_at: new Date(completedAtMs).toISOString(),
          duration_ms: Math.max(0, completedAtMs - startedAtMs),
          status: failed ? 'failed' : 'succeeded',
          result_types: resultTypes(result),
          ...(failed ? { error_class: 'tool_result_error' } : {}),
        });
        return result;
      } catch (error) {
        const completedAtMs = now();
        sink({
          ...base,
          phase: 'completed',
          completed_at: new Date(completedAtMs).toISOString(),
          duration_ms: Math.max(0, completedAtMs - startedAtMs),
          status: 'failed',
          result_types: ['error'],
          error_class: classifyError(error),
        });
        throw error;
      }
    })
  );
}
