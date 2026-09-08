import { asc, eq, like } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Agent, AgentID, AgentState, PatchAgentInput, UserID } from '../../types';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { agents, type AgentInsert, type AgentRow } from '../schema';
import {
  attachHiddenTenant,
  currentTenantInsert,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  resolveByShortIdPrefix,
} from './base';

export interface CreateAgentRecord {
  agentId?: AgentID;
  createdBy: UserID;
  displayName: string;
  description?: string | null;
  emoji?: string | null;
  avatarUrl?: string | null;
  workspacePath: string;
  state?: AgentState;
  errorMessage?: string | null;
}

function rowToAgent(row: AgentRow): Agent {
  return attachHiddenTenant(
    {
      agent_id: row.agent_id as AgentID,
      created_by: row.created_by as UserID,
      display_name: row.display_name,
      description: row.description ?? null,
      emoji: row.emoji ?? null,
      avatar_url: row.avatar_url ?? null,
      workspace_path: row.workspace_path,
      state: row.state,
      error_message: row.error_message ?? null,
      archived: Boolean(row.archived),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    },
    row
  );
}

export class AgentRepository {
  constructor(private db: Database) {}

  private resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'Agent', async pattern => {
      const rows = await select(this.db)
        .from(agents)
        .where(like(agents.agent_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((row: AgentRow) => row.agent_id);
    });
  }

  async findAll(ownerUserId?: UserID | string): Promise<Agent[]> {
    const query = select(this.db).from(agents);
    const rows = ownerUserId
      ? await query.where(eq(agents.created_by, ownerUserId)).orderBy(asc(agents.created_at)).all()
      : await query.orderBy(asc(agents.created_at)).all();
    return rows.map(rowToAgent);
  }

  async findById(id: AgentID | string): Promise<Agent | null> {
    let resolved: string;
    try {
      resolved = await this.resolveId(id);
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
    const row = await select(this.db).from(agents).where(eq(agents.agent_id, resolved)).one();
    return row ? rowToAgent(row) : null;
  }

  async findOwnedById(id: AgentID | string, ownerUserId: UserID | string): Promise<Agent | null> {
    const found = await this.findById(id);
    return found?.created_by === ownerUserId ? found : null;
  }

  async create(data: CreateAgentRecord): Promise<Agent> {
    const now = new Date();
    const displayName = data.displayName.trim();
    if (!displayName) throw new Error('Agent display name is required');
    const values: AgentInsert = {
      ...currentTenantInsert(),
      agent_id: data.agentId ?? generateId(),
      created_by: data.createdBy,
      display_name: displayName,
      description: data.description?.trim() || null,
      emoji: data.emoji?.trim() || null,
      avatar_url: data.avatarUrl?.trim() || null,
      workspace_path: data.workspacePath,
      state: data.state ?? 'creating',
      error_message: data.errorMessage ?? null,
      archived: false,
      created_at: now,
      updated_at: now,
    };
    return rowToAgent(await insert(this.db, agents).values(values).returning().one());
  }

  async patch(
    id: AgentID | string,
    data: PatchAgentInput & { state?: AgentState; error_message?: string | null }
  ): Promise<Agent> {
    const current = await this.findById(id);
    if (!current) throw new EntityNotFoundError('Agent', id);
    const displayName = data.display_name?.trim();
    if (data.display_name !== undefined && !displayName) {
      throw new Error('Agent display name is required');
    }
    const row = await update(this.db, agents)
      .set({
        ...(displayName !== undefined ? { display_name: displayName } : {}),
        ...(data.description !== undefined
          ? { description: data.description?.trim() || null }
          : {}),
        ...(data.emoji !== undefined ? { emoji: data.emoji?.trim() || null } : {}),
        ...(data.avatar_url !== undefined
          ? { avatar_url: data.avatar_url?.trim() || null }
          : {}),
        ...(data.archived !== undefined ? { archived: data.archived } : {}),
        ...(data.state !== undefined ? { state: data.state } : {}),
        ...(data.error_message !== undefined ? { error_message: data.error_message } : {}),
        updated_at: new Date(),
      })
      .where(eq(agents.agent_id, current.agent_id))
      .returning()
      .one();
    return rowToAgent(row);
  }

  async delete(id: AgentID | string): Promise<void> {
    const current = await this.findById(id);
    if (!current) throw new EntityNotFoundError('Agent', id);
    await deleteFrom(this.db, agents).where(eq(agents.agent_id, current.agent_id)).run();
  }
}
