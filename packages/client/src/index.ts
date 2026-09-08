/**
 * @disco-live/client — TypeScript client for connecting to the Disco daemon
 *
 * Usage:
 *   import { createClient } from '@disco-live/client';
 *   const client = createClient('http://localhost:3030');
 */

import {
  AGENTIC_TOOL_CAPABILITIES as PRIVATE_AGENTIC_TOOL_CAPABILITIES,
  AGENTIC_TOOL_DISPLAY_NAMES as PRIVATE_AGENTIC_TOOL_DISPLAY_NAMES,
  AGENTIC_TOOL_KEY_CREATION_URL as PRIVATE_AGENTIC_TOOL_KEY_CREATION_URL,
  TOOL_API_KEY_NAMES as PRIVATE_TOOL_API_KEY_NAMES,
} from '@disco/agentic-tools';
import type { DiscoClient as CoreDiscoClient } from '@disco/core/client';
import {
  createClient as createCoreClient,
  createRestClient as createCoreRestClient,
  getApiKeyFromEnv,
  isDaemonRunning,
} from '@disco/core/client';
import type {
  AgenticToolCapabilities,
  AgenticToolName,
  ApiKeyName,
  PersistedAgenticToolName,
} from '@disco/core/types';
import {
  attachReactiveSessionApi,
  type ReactiveDiscoClient,
  type ReactiveLoadedTaskIds,
  type ReactiveMessagesByTask,
  type ReactiveSessionHandle,
  type ReactiveSessionOptions,
  type ReactiveSessionState,
  type ReactiveStreamingMessagesById,
  type ReactiveToolsByTask,
  releaseReactiveSession,
  retainReactiveSession,
  type StreamingMessageState,
  type TaskHydrationMode,
  type ToolExecutionState,
} from './reactive-session';

export type {
  DiscoClient,
  DiscoService,
  ClientInput,
  FindResult,
  LeaderboardService,
  MessagesService,
  SchedulesService,
  ServiceTypes,
  SessionsService,
  TasksService,
} from '@disco/core/client';
export * from '@disco/core/client';

// Preserve the published client contract while keeping registry values package-owned.
export const TOOL_API_KEY_NAMES: Partial<Record<AgenticToolName, ApiKeyName>> =
  PRIVATE_TOOL_API_KEY_NAMES;
export const AGENTIC_TOOL_DISPLAY_NAMES: Record<PersistedAgenticToolName, string> =
  PRIVATE_AGENTIC_TOOL_DISPLAY_NAMES;
export const AGENTIC_TOOL_KEY_CREATION_URL: Partial<Record<AgenticToolName, string>> =
  PRIVATE_AGENTIC_TOOL_KEY_CREATION_URL;
export const AGENTIC_TOOL_CAPABILITIES: Record<AgenticToolName, AgenticToolCapabilities> =
  PRIVATE_AGENTIC_TOOL_CAPABILITIES;
// `shortId` is the canonical display helper (always SHORT_ID_LENGTH chars).
// Use it for any UUID rendered to a user — URLs, pills, logs, notifications.
// `toShortId(id, length)` is the lower-level primitive for rare cases that
// need a non-canonical length (e.g. `findMinimumPrefixLength`).
export { shortId } from '@disco/core/client';
export type { PaginatedResult } from '@disco/core/types';
export * from './models';
export type {
  ReactiveDiscoClient,
  ReactiveLoadedTaskIds,
  ReactiveMessagesByTask,
  ReactiveSessionHandle,
  ReactiveSessionOptions,
  ReactiveSessionState,
  ReactiveStreamingMessagesById,
  ReactiveToolsByTask,
  StreamingMessageState,
  TaskHydrationMode,
  ToolExecutionState,
};

export function createClient(...args: Parameters<typeof createCoreClient>): ReactiveDiscoClient {
  const client = createCoreClient(...args);
  return attachReactiveSessionApi(client as CoreDiscoClient);
}

export async function createRestClient(
  ...args: Parameters<typeof createCoreRestClient>
): Promise<CoreDiscoClient> {
  return createCoreRestClient(...args);
}

export {
  attachReactiveSessionApi,
  getApiKeyFromEnv,
  isDaemonRunning,
  releaseReactiveSession,
  retainReactiveSession,
};
