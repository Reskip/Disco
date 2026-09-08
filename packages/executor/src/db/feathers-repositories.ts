/**
 * Feathers-Backed Repositories
 *
 * Thin repository wrappers that proxy to daemon services via Feathers client.
 * This allows executor code (especially ClaudeTool) to use the repository pattern
 * while actually communicating with the daemon over Feathers/WebSocket.
 */

import type { DiscoClient } from '@disco/core/api';
import type {
  Agent,
  AgentID,
  MCPServer,
  MCPServerFilters,
  MCPServerID,
  Message,
  MessageCreate,
  MessageID,
  Session,
  SessionID,
  SessionMCPServer,
  SessionUpdate,
  TaskID,
  User,
} from '@disco/core/types';
import { MessageRole } from '@disco/core/types';

/**
 * Messages Repository - proxies to 'messages' Feathers service
 */
export class FeathersMessagesRepository {
  constructor(private client: DiscoClient) {}

  /** The daemon may have pre-written the Task's prompt; fetch only that guard row. */
  async findInitialUserMessagesByTaskId(taskId: TaskID): Promise<Message[]> {
    const result = await this.client.service('messages').find({
      query: {
        task_id: taskId,
        role: MessageRole.USER,
        $sort: { index: 1 },
        $limit: 1,
      },
    });
    return Array.isArray(result) ? result : result.data;
  }

  /**
   * Next append index without transferring the session transcript. Indexes can
   * be sparse after deletes, so row count is not a safe replacement for max+1.
   */
  async getNextIndexBySessionId(sessionId: SessionID): Promise<number> {
    const result = await this.client.service('messages').find({
      query: {
        session_id: sessionId,
        $sort: { index: -1 },
        $limit: 1,
        $select: ['index'],
      },
    });
    const messages = Array.isArray(result) ? result : result.data;
    return messages.length > 0 ? messages[0].index + 1 : 0;
  }

  async findById(messageId: MessageID): Promise<Message | null> {
    try {
      const service = this.client.service('messages');
      return await service.get(messageId);
    } catch (_error) {
      return null;
    }
  }

  async create(message: MessageCreate): Promise<Message> {
    const service = this.client.service('messages');
    return await service.create(message);
  }
}

/**
 * Sessions Repository - proxies to 'sessions' Feathers service
 */
export class FeathersSessionsRepository {
  constructor(private client: DiscoClient) {}

  async findById(sessionId: SessionID): Promise<Session | null> {
    try {
      const service = this.client.service('sessions');
      return await service.get(sessionId);
    } catch (_error) {
      return null;
    }
  }

  async update(sessionId: SessionID, data: SessionUpdate): Promise<Session> {
    const service = this.client.service('sessions');
    return await service.patch(sessionId, data);
  }
}

/**
 * Agents Repository - resolves first-class persistent Agent identities.
 */
export class FeathersAgentsRepository {
  constructor(private client: DiscoClient) {}

  async findById(agentId: AgentID | string): Promise<Agent | null> {
    try {
      return await this.client.service('agents').get(agentId);
    } catch (error) {
      const failure = error as {
        code?: unknown;
        name?: unknown;
        className?: unknown;
      };
      if (
        failure?.code === 404 ||
        failure?.name === 'NotFound' ||
        failure?.className === 'not-found'
      ) {
        return null;
      }
      throw error;
    }
  }
}

/**
 * MCP Servers Repository - proxies to 'mcp-servers' Feathers service
 */
export class FeathersMCPServersRepository {
  constructor(private client: DiscoClient) {}

  async findById(mcpServerId: MCPServerID): Promise<MCPServer | null> {
    try {
      const service = this.client.service('mcp-servers');
      return await service.get(mcpServerId);
    } catch (_error) {
      return null;
    }
  }

  async findAll(filters?: MCPServerFilters, forUserId?: string): Promise<MCPServer[]> {
    const service = this.client.service('mcp-servers');
    const query: Record<string, unknown> = { $limit: 1000 };

    // Apply filters
    if (filters?.scope) {
      query.scope = filters.scope;
    }
    if (filters?.scopeId) {
      query.scopeId = filters.scopeId;
    }
    if (filters?.transport) {
      query.transport = filters.transport;
    }
    if (filters?.enabled !== undefined) {
      query.enabled = filters.enabled;
    }
    if (filters?.source) {
      query.source = filters.source;
    }
    if (filters?.usableByUserId) {
      query.usableByUserId = filters.usableByUserId;
    }
    if (filters?.ownerless !== undefined) {
      query.ownerless = filters.ownerless;
    }

    // Pass user ID for per-user OAuth token injection
    // This allows the daemon to inject per-user tokens even when socket auth isn't available
    if (forUserId) {
      query.forUserId = forUserId;
      console.log(`[MCP Client] Adding forUserId to query: ${forUserId}`);
    } else {
      console.log(`[MCP Client] No forUserId provided`);
    }

    console.log(`[MCP Client] Query to daemon:`, JSON.stringify(query));
    const result = await service.find({ query });
    return Array.isArray(result) ? result : result.data;
  }
}

/**
 * Session MCP Servers Repository - proxies to 'session-mcp-servers' Feathers service
 */
export class FeathersSessionMCPServersRepository {
  constructor(private client: DiscoClient) {}

  async findBySessionId(sessionId: SessionID): Promise<SessionMCPServer[]> {
    const service = this.client.service('session-mcp-servers');
    const result = await service.find({
      query: {
        session_id: sessionId,
        $limit: 1000,
      },
    });
    return (Array.isArray(result) ? result : result.data) as SessionMCPServer[];
  }

  async findByMCPServerId(mcpServerId: MCPServerID): Promise<SessionMCPServer[]> {
    const service = this.client.service('session-mcp-servers');
    const result = await service.find({
      query: {
        mcp_server_id: mcpServerId,
        $limit: 1000,
      },
    });
    return (Array.isArray(result) ? result : result.data) as SessionMCPServer[];
  }

  /**
   * List MCP servers for a session with optional enabled filter
   * @param sessionId - Session ID
   * @param enabledOnly - If true, only return enabled servers
   * @returns Array of MCPServer objects
   */
  async listServers(sessionId: SessionID, enabledOnly?: boolean): Promise<MCPServer[]> {
    const service = this.client.service(`/sessions/${sessionId}/mcp-servers`);
    const query: Record<string, unknown> = {};

    if (enabledOnly) {
      query.enabledOnly = true;
    }

    const result = await service.find({ query });
    return (Array.isArray(result) ? result : result.data) as MCPServer[];
  }

  /**
   * List the effective MCP servers for a session (global + session-assigned).
   * Executors use the session-scoped route so session-token callers can receive
   * the raw config needed to launch only their own session's MCP servers.
   */
  async listEffectiveServers(
    sessionId: SessionID,
    enabledOnly?: boolean,
    forUserId?: string
  ): Promise<MCPServer[]> {
    const service = this.client.service(`/sessions/${sessionId}/mcp-servers`);
    const query: Record<string, unknown> = { includeGlobal: true };

    if (enabledOnly) {
      query.enabledOnly = true;
    }
    if (forUserId) {
      query.forUserId = forUserId;
    }

    const result = await service.find({ query });
    return (Array.isArray(result) ? result : result.data) as MCPServer[];
  }

  /**
   * List MCP servers for a session with relationship metadata (added_at timestamp)
   * Used to detect if servers were added after session creation
   * @param sessionId - Session ID
   * @param enabledOnly - If true, only return enabled servers
   * @returns Array of objects with server and metadata
   */
  async listServersWithMetadata(
    sessionId: SessionID,
    enabledOnly = false
  ): Promise<Array<{ server: MCPServer; added_at: number; enabled: boolean }>> {
    const service = this.client.service(`/sessions/${sessionId}/mcp-servers`);
    const query: Record<string, unknown> = { includeMetadata: true };

    if (enabledOnly) {
      query.enabledOnly = true;
    }

    const result = await service.find({ query });
    return (Array.isArray(result) ? result : result.data) as Array<{
      server: MCPServer;
      added_at: number;
      enabled: boolean;
    }>;
  }
}

type MCPOAuthAuthHeaderResult = {
  headers: Record<string, { authorization?: string; error?: string }>;
};

/**
 * MCP OAuth auth headers repository - proxies to the trusted executor route.
 *
 * Session-scoped MCP server reads intentionally redact OAuth access tokens in
 * normal API payloads. Executors use this narrow route to retrieve just the
 * launch-time Authorization header for OAuth servers that are already in the
 * session's effective MCP scope.
 */
export class FeathersMCPOAuthAuthHeadersRepository {
  constructor(private client: DiscoClient) {}

  async getAuthHeaders(
    mcpServerIds: MCPServerID[]
  ): Promise<Record<string, { authorization?: string; error?: string }>> {
    if (mcpServerIds.length === 0) return {};

    const service = this.client.service('mcp-servers/oauth-auth-headers');
    const executorSessionToken = (this.client as DiscoClient & { executorSessionToken?: string })
      .executorSessionToken;
    const result = (await service.create({
      mcp_server_ids: mcpServerIds,
      ...(executorSessionToken ? { executorSessionToken } : {}),
    })) as MCPOAuthAuthHeaderResult;

    return result.headers ?? {};
  }
}

/**
 * Users Repository - proxies to 'users' Feathers service
 */
export class FeathersUsersRepository {
  constructor(private client: DiscoClient) {}

  async findById(userId: string): Promise<User | null> {
    try {
      const service = this.client.service('users');
      return await service.get(userId);
    } catch (_error) {
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Type Aliases for Backward Compatibility
// ═══════════════════════════════════════════════════════════

/**
 * Repository type aliases matching old architecture patterns
 * These allow sdk-handlers to use familiar types during migration
 */
export type MessagesRepository = FeathersMessagesRepository;
export type SessionRepository = FeathersSessionsRepository;
export type AgentRepository = FeathersAgentsRepository;
export type MCPServerRepository = FeathersMCPServersRepository;
export type SessionMCPServerRepository = FeathersSessionMCPServersRepository;
export type MCPOAuthAuthHeadersRepository = FeathersMCPOAuthAuthHeadersRepository;
export type UsersRepository = FeathersUsersRepository;

/**
 * Create all Feathers-backed repositories and services
 */
export function createFeathersBackedRepositories(client: DiscoClient) {
  return {
    // Repositories
    messages: new FeathersMessagesRepository(client),
    sessions: new FeathersSessionsRepository(client),
    agents: new FeathersAgentsRepository(client),
    users: new FeathersUsersRepository(client),
    mcpServers: new FeathersMCPServersRepository(client),
    sessionMCP: new FeathersSessionMCPServersRepository(client),
    mcpOAuthAuthHeaders: new FeathersMCPOAuthAuthHeadersRepository(client),

    // Services (direct Feathers service access)
    // SDK handlers can use these services directly with proper typing
    messagesService: client.service('messages'),
    tasksService: client.service('tasks'),
    tasksStreamingService: client.service('/tasks/streaming'),
    sessionsService: client.service('sessions'),
  };
}
