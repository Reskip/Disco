import { mkdirSync, rmSync } from 'node:fs';
import { getWorktreesRoot } from '@disco/core/config';
import {
  resolveDiscoAgentWorkspaceDirectory,
  resolveDiscoUserWorkspaceDirectory,
} from '@disco/core';
import {
  AgentRepository,
  generateId,
  getCurrentTenantId,
  SessionRepository,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@disco/core/feathers';
import type {
  Agent,
  AgentID,
  AuthenticatedParams,
  CreateAgentInput,
  PatchAgentInput,
  UserID,
} from '@disco/core/types';
import { ensureAgentProfileScaffoldForWorkspace } from './agent-capabilities.js';

/** Public Agent transport surface. Removal stays explicit because the UI
 * guards it with typed confirmation and the service revalidates that text. */
export const AGENTS_SERVICE_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
] as const;

function actor(params?: AuthenticatedParams): UserID {
  const userId = params?.user?.user_id;
  if (!userId) throw new NotAuthenticated('Authentication required');
  return userId as UserID;
}

export class AgentsService {
  private repository: AgentRepository;
  private sessions: SessionRepository;

  constructor(
    private db: TenantScopeAwareDatabase,
    private worktreesRoot: (tenantId?: string) => string = getWorktreesRoot
  ) {
    this.repository = new AgentRepository(db);
    this.sessions = new SessionRepository(db);
  }

  async find(params?: AuthenticatedParams): Promise<Agent[]> {
    const userId = actor(params);
    const includeArchived = params?.query?.include_archived === true;
    return (await this.repository.findAll(userId)).filter(
      agent => includeArchived || !agent.archived
    );
  }

  async get(id: string, params?: AuthenticatedParams): Promise<Agent> {
    const found = await this.repository.findOwnedById(id, actor(params));
    if (!found) throw new NotFound('Agent not found');
    return found;
  }

  async create(data: CreateAgentInput, params?: AuthenticatedParams): Promise<Agent> {
    const userId = actor(params);
    const displayName = data.display_name?.trim();
    if (!displayName) throw new BadRequest('display_name is required');

    const agentId = generateId() as AgentID;
    const workspacePath = resolveDiscoAgentWorkspaceDirectory(
      resolveDiscoUserWorkspaceDirectory(this.worktreesRoot(getCurrentTenantId()), userId),
      agentId
    );
    const created = await this.repository.create({
      agentId,
      createdBy: userId,
      displayName,
      description: data.description,
      emoji: data.emoji,
      avatarUrl: data.avatar_url,
      workspacePath,
      state: 'creating',
    });

    try {
      mkdirSync(workspacePath, { recursive: true });
      ensureAgentProfileScaffoldForWorkspace({
        workspacePath,
        displayName,
        responsibilities: data.description,
      });
      return await this.repository.patch(created.agent_id, {
        state: 'ready',
        error_message: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.patch(created.agent_id, { state: 'failed', error_message: message });
      throw new BadRequest(`Agent workspace initialization failed: ${message}`);
    }
  }

  async patch(
    id: string,
    data: PatchAgentInput,
    params?: AuthenticatedParams
  ): Promise<Agent> {
    const current = await this.get(id, params);
    const updated = await this.repository.patch(current.agent_id, data);
    if (data.display_name !== undefined || data.description !== undefined) {
      ensureAgentProfileScaffoldForWorkspace({
        workspacePath: updated.workspace_path,
        displayName: updated.display_name,
        responsibilities: updated.description,
      });
    }
    return updated;
  }

  async remove(id: string, params?: AuthenticatedParams): Promise<Agent> {
    const current = await this.get(id, params);
    const confirmation = params?.query?.confirmation;
    const required = `删除智能体 ${current.display_name}`;
    if (confirmation !== required) {
      throw new BadRequest(`Type “${required}” to delete this Agent`);
    }

    const ownedSessions = await this.sessions.findAll({ ownerUserId: current.created_by });
    for (const session of ownedSessions) {
      if (session.agent_id === current.agent_id) {
        await this.sessions.delete(session.session_id);
      }
    }
    rmSync(current.workspace_path, { recursive: true, force: true });
    await this.repository.delete(current.agent_id);
    return current;
  }
}

export function createAgentsService(db: TenantScopeAwareDatabase) {
  return new AgentsService(db);
}
