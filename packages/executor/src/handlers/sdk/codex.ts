/**
 * Codex SDK Handler
 *
 * Executes prompts using OpenAI Codex SDK with Feathers/WebSocket architecture
 */

import { TOOL_API_KEY_NAMES } from '@disco/agentic-tools';
import type { MessageSource, PermissionMode, SessionID, TaskID } from '@disco/core/types';
import { CodexTool } from '../../sdk-handlers/codex/index.js';
import type { DiscoClient } from '../../services/feathers-client.js';

/**
 * Execute Codex task (Feathers/WebSocket architecture)
 *
 * Used by ephemeral executor - no IPC, direct Feathers client passed in
 */
export async function executeCodexTask(params: {
  client: DiscoClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
}): Promise<void> {
  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  // Execute using base helper with Codex-specific factory
  await executeToolTask({
    ...params,
    apiKeyEnvVar: TOOL_API_KEY_NAMES.codex!,
    toolName: 'codex',
    createTool: (repos, apiKey, useNativeAuth, executorSessionToken) =>
      new CodexTool(
        repos.messages,
        repos.sessions,
        repos.sessionMCP,
        apiKey,
        repos.messagesService,
        repos.tasksService,
        repos.tasksStreamingService,
        useNativeAuth, // Flag for native auth (if applicable)
        repos.mcpServers, // MCPServerRepository for global MCP server resolution
        repos.users,
        repos.mcpOAuthAuthHeaders,
        executorSessionToken,
        repos.agents
      ),
  });
}
