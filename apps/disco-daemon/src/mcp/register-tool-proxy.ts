import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Tool-registration intercept primitive shared by the MCP server proxies.
 *
 * Each `McpServer.registerTool(name, config, handler)` call goes through
 * `intercept(original, name, config, handler)`, which decides what to do:
 *
 * - silently skip the registration (`readOnlyProxy` does this for mutating
 *   tools when a capability domain is in a read-only tier);
 * - transform `config` / `handler` before forwarding (e.g. add a
 *   `[Deprecated alias]` prefix to the description, log on invocation);
 * - register the tool under multiple names (e.g. mirroring every
 *   registration as a sibling under a different prefix — `readOnlyProxy`
 *   is the only such interceptor today).
 *
 * The proxy uses `Object.create(server)` so it passes `instanceof McpServer`
 * and shares every other method, then overrides only `registerTool`.
 * The cast on `registerTool` is required because the SDK exposes it as an
 * overloaded generic that TypeScript can't represent with the replacement
 * function's signature.
 */

export type ToolConfig = Record<string, unknown>;
export type ToolHandler = (args: unknown, extra?: unknown) => unknown;
export type RegisterTool = (name: string, config: ToolConfig, handler: ToolHandler) => unknown;

export interface DispatchableTool {
  enabled: boolean;
  inputSchema?: {
    safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: unknown };
  };
  handler: ToolHandler;
}

/**
 * Request-local dispatch table for the progressive-discovery facade.
 *
 * The SDK intentionally keeps its registered-tool map private. Keeping our
 * own table avoids depending on that implementation detail and gives
 * disco_execute_tool ordinary, authorization-wrapped Disco operations to call.
 * Native SDK registration independently preserves direct tools/call support.
 */
export class ToolDispatcher {
  private readonly tools = new Map<string, DispatchableTool>();

  register(name: string, config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, {
      enabled: true,
      inputSchema: config.inputSchema as DispatchableTool['inputSchema'],
      handler,
    });
  }

  get(name: string): DispatchableTool | undefined {
    return this.tools.get(name);
  }

  listNames(): string[] {
    return [...this.tools.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  }
}

export function wrapRegisterTool(
  server: McpServer,
  intercept: (
    original: RegisterTool,
    name: string,
    config: ToolConfig,
    handler: ToolHandler
  ) => unknown
): McpServer {
  const proxy = Object.create(server) as McpServer;
  const original = server.registerTool.bind(server) as unknown as RegisterTool;
  (proxy as unknown as { registerTool: RegisterTool }).registerTool = (name, config, handler) =>
    intercept(original, name, config, handler);
  return proxy;
}

/** Capture registrations for the discovery facade while preserving native direct calls. */
export function toolDispatcherProxy(server: McpServer, dispatcher: ToolDispatcher): McpServer {
  return wrapRegisterTool(server, (register, name, config, handler) => {
    dispatcher.register(name, config, handler);
    return register(name, config, handler);
  });
}

/** Skip methods that are not available to the authenticated request audience. */
export function filteredToolRegistrationProxy(
  server: McpServer,
  isAllowed: (name: string) => boolean
): McpServer {
  return wrapRegisterTool(server, (register, name, config, handler) => {
    if (!isAllowed(name)) return undefined;
    return register(name, config, handler);
  });
}
