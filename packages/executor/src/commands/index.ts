/**
 * Command Router - Routes ExecutorPayload commands to appropriate handlers
 *
 * Each command handler is responsible for:
 * 1. Connecting to daemon via Feathers (if needed)
 * 2. Executing the operation
 * 3. Returning an ExecutorResult
 */

import { ToolRegistry } from '../handlers/sdk/tool-registry.js';
import type {
  AgenticToolInvokePayload,
  ExecutorPayload,
  ExecutorResult,
  PromptPayload,
} from '../payload-types.js';
import { handleCodexAuthFile } from './codex-auth-file.js';
import { handleCodexGenerateTitle } from './codex-generate-title.js';
import { handleCodexLookupTokenPricing } from './codex-lookup-token-pricing.js';
import { handleWorkspaceFilesList } from './workspace-files.js';

export interface CommandOptions {
  /** Dry run mode - don't actually execute */
  dryRun?: boolean;
}

/**
 * Command handler function signature
 */
type CommandHandler<T extends ExecutorPayload> = (
  payload: T,
  options: CommandOptions
) => Promise<ExecutorResult>;

/**
 * Registry of command handlers
 */
const commandHandlers: Map<string, CommandHandler<ExecutorPayload>> = new Map();

export interface InteractiveCommandChannel {
  emit(event: unknown): void;
  read(): Promise<unknown>;
}

type InteractiveCommandHandler<T extends ExecutorPayload> = (
  payload: T,
  options: CommandOptions,
  channel: InteractiveCommandChannel
) => Promise<ExecutorResult>;

const interactiveCommandHandlers = new Map<string, InteractiveCommandHandler<ExecutorPayload>>();

/**
 * Register a command handler
 */
export function registerCommand<T extends ExecutorPayload>(
  command: string,
  handler: CommandHandler<T>
): void {
  commandHandlers.set(command, handler as CommandHandler<ExecutorPayload>);
}

export function registerInteractiveCommand<T extends ExecutorPayload>(
  command: string,
  handler: InteractiveCommandHandler<T>
): void {
  interactiveCommandHandlers.set(command, handler as InteractiveCommandHandler<ExecutorPayload>);
}

export async function executeInteractiveCommand(
  payload: ExecutorPayload,
  options: CommandOptions,
  channel: InteractiveCommandChannel
): Promise<ExecutorResult> {
  const handler = interactiveCommandHandlers.get(payload.command);
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'INTERACTIVE_COMMAND_UNSUPPORTED',
        message: `Command does not support interactive execution: ${payload.command}`,
      },
    };
  }
  return handler(payload, options, channel);
}

/**
 * Execute a command based on the payload
 */
export async function executeCommand(
  payload: ExecutorPayload,
  options: CommandOptions = {}
): Promise<ExecutorResult> {
  const handler = commandHandlers.get(payload.command);

  if (!handler) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `Unknown command: ${payload.command}`,
        details: {
          supportedCommands: Array.from(commandHandlers.keys()),
        },
      },
    };
  }

  try {
    return await handler(payload, options);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    return {
      success: false,
      error: {
        code: 'COMMAND_FAILED',
        message: errorMessage,
        details: {
          command: payload.command,
          stack: errorStack,
        },
      },
    };
  }
}

/**
 * Check if a command is registered
 */
export function hasCommand(command: string): boolean {
  return commandHandlers.has(command);
}

/**
 * Get list of registered commands
 */
export function getRegisteredCommands(): string[] {
  return Array.from(commandHandlers.keys());
}

// ═══════════════════════════════════════════════════════════
// Command Handler Implementations
// ═══════════════════════════════════════════════════════════

/**
 * Prompt command handler - executes agent SDK
 *
 * This is the existing behavior, now wrapped in the new command structure.
 * The actual execution happens through DiscoExecutor.
 */
async function handlePromptCommand(
  payload: PromptPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'prompt',
        sessionId: payload.params.sessionId,
        taskId: payload.params.taskId,
        tool: payload.params.tool,
      },
    };
  }

  // For prompt command, we delegate to the existing DiscoExecutor
  // The CLI handles this specially since it needs to stay running
  // and stream results via WebSocket
  return {
    success: true,
    data: {
      delegateToExecutor: true,
      message: 'Prompt command should be handled by DiscoExecutor',
    },
  };
}

async function handleAgenticToolInvoke(
  payload: AgenticToolInvokePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  return ToolRegistry.executeAuxiliary(payload.params.tool, {
    context: payload.agenticToolContext,
    request: payload.params.request,
    dryRun: options.dryRun,
  });
}

async function handleInteractiveAgenticToolInvoke(
  payload: AgenticToolInvokePayload,
  options: CommandOptions,
  channel: InteractiveCommandChannel
): Promise<ExecutorResult> {
  return ToolRegistry.executeInteractiveAuxiliary(
    payload.params.tool,
    {
      context: payload.agenticToolContext,
      request: payload.params.request,
      dryRun: options.dryRun,
    },
    channel
  );
}

// ═══════════════════════════════════════════════════════════
// Register All Commands
// ═══════════════════════════════════════════════════════════

registerCommand('prompt', handlePromptCommand);
registerCommand('agentic-tool.invoke', handleAgenticToolInvoke);
registerInteractiveCommand('agentic-tool.invoke', handleInteractiveAgenticToolInvoke);
registerCommand('workspace.files.list', handleWorkspaceFilesList);
registerCommand('codex.auth-file', handleCodexAuthFile);
registerCommand('codex.generate-title', handleCodexGenerateTitle);
registerCommand('codex.lookup-token-pricing', handleCodexLookupTokenPricing);
