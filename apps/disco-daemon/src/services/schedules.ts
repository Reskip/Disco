/**
 * Schedules Service
 *
 * Provides REST + WebSocket API for first-class schedules. Uses the
 * DrizzleService adapter with `ScheduleRepository`. RBAC is wired in
 * `register-hooks.ts` scopes every external operation to the creator. A
 * nullable Agent target is validated against the same owner before insert.
 *   - run-now: all (custom REST verb in register-routes.ts)
 *
 * See docs/internal/schedules-first-class-design-2026-05-24.md §4.4.
 */

import { materializeAgenticToolConfiguration } from '@disco/agentic-tools/config';
import {
  AgenticConfigurationResolutionError,
  InvalidScheduleAgenticToolConfigError,
  normalizeScheduleAgenticToolConfig,
  PAGINATION,
} from '@disco/core/config';
import {
  AgentRepository,
  ScheduleRepository,
  type TenantScopeAwareDatabase,
} from '@disco/core/db';
import { BadRequest } from '@disco/core/feathers';
import { isInvalidModelConfigError } from '@disco/core/models';
import type {
  AuthenticatedParams,
  AgentID,
  PersistedScheduleAgenticToolConfig,
  QueryParams,
  Schedule,
  ScheduleAgenticToolConfig,
  ScheduleCreateData,
  SchedulePatchData,
  UserID,
  UUID,
} from '@disco/core/types';
import { SCHEDULE_CREATE_WRITE_FIELDS, SCHEDULE_PATCH_WRITE_FIELDS } from '@disco/core/types';
import { DrizzleService } from '../adapters/drizzle';
import {
  materializedAgenticToolConfigurationToScheduleConfig,
  scheduleAgenticToolConfigToSource,
} from '../utils/agentic-configuration-sources.js';
import { assertServiceWriteFields, pickWriteFields } from '../utils/write-data-boundary.js';

/**
 * Public Schedule transport surface. `update` is deliberately absent so
 * whole-row `PUT` never reaches the inherited DrizzleService implementation.
 */
export const SCHEDULES_SERVICE_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
] as const;

export type ScheduleParams = QueryParams<{
  agent_id?: AgentID | null;
  enabled?: boolean;
  created_by?: UUID;
}> &
  AuthenticatedParams & { schedule?: Schedule };

type PersistedScheduleCreateData = Omit<ScheduleCreateData, 'agentic_tool_config'> & {
  agentic_tool_config?: PersistedScheduleAgenticToolConfig;
  created_by?: Schedule['created_by'];
  next_run_at?: Schedule['next_run_at'];
};

type PersistedSchedulePatchData = Omit<SchedulePatchData, 'agentic_tool_config'> & {
  agentic_tool_config?: PersistedScheduleAgenticToolConfig;
  next_run_at?: Schedule['next_run_at'];
};

type PersistedScheduleWriteData = PersistedScheduleCreateData | PersistedSchedulePatchData;

export class SchedulesService extends DrizzleService<
  Schedule,
  PersistedScheduleWriteData,
  ScheduleParams
> {
  private db: TenantScopeAwareDatabase;
  private agentRepository: AgentRepository;

  constructor(db: TenantScopeAwareDatabase) {
    const repo = new ScheduleRepository(db);
    super(repo, {
      id: 'schedule_id',
      resourceType: 'Schedule',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.db = db;
    this.agentRepository = new AgentRepository(db);
  }

  private async validateConfig(
    config: ScheduleAgenticToolConfig,
    userId?: UserID
  ): Promise<PersistedScheduleAgenticToolConfig> {
    try {
      const materialized = await materializeAgenticToolConfiguration(this.db, {
        tool: config.agentic_tool,
        source: scheduleAgenticToolConfigToSource(config),
        executionOwnerId: userId,
      });
      return materializedAgenticToolConfigurationToScheduleConfig(config, materialized);
    } catch (error) {
      if (error instanceof AgenticConfigurationResolutionError) {
        throw new BadRequest('Selected agentic configuration is not available');
      }
      if (isInvalidModelConfigError(error)) throw new BadRequest(error.message);
      throw error;
    }
  }

  private normalizeConfig(config: PersistedScheduleAgenticToolConfig): ScheduleAgenticToolConfig {
    try {
      return normalizeScheduleAgenticToolConfig(config);
    } catch (error) {
      if (error instanceof InvalidScheduleAgenticToolConfigError) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
  }

  async create(data: ScheduleCreateData, params?: ScheduleParams) {
    const rawData = data as unknown as Record<string, unknown>;
    const prepared = assertServiceWriteFields(
      'Schedule',
      rawData,
      SCHEDULE_CREATE_WRITE_FIELDS,
      params,
      ['created_by', 'next_run_at']
    );
    data = pickWriteFields<ScheduleCreateData>(rawData, SCHEDULE_CREATE_WRITE_FIELDS);

    const creatorId = params?.user?.user_id as UserID | undefined;
    if (data.agent_id) {
      if (!creatorId) throw new BadRequest('An authenticated owner is required for Agent schedules');
      const agent = await this.agentRepository.findOwnedById(data.agent_id, creatorId);
      if (!agent || agent.archived || agent.state !== 'ready') {
        throw new BadRequest('Selected Agent is unavailable');
      }
    }
    const agenticToolConfig = data.agentic_tool_config
      ? await this.validateConfig(this.normalizeConfig(data.agentic_tool_config), creatorId)
      : undefined;
    const trustedCreatedBy =
      creatorId ?? (prepared ? (rawData.created_by as UserID | undefined) : undefined);
    const trustedData: PersistedScheduleCreateData = {
      ...data,
      ...(agenticToolConfig ? { agentic_tool_config: agenticToolConfig } : {}),
      ...(trustedCreatedBy ? { created_by: trustedCreatedBy } : {}),
      ...(prepared && typeof rawData.next_run_at === 'number'
        ? { next_run_at: rawData.next_run_at }
        : {}),
    };
    return super.create(trustedData, params);
  }

  async patch(id: string | null, data: SchedulePatchData, params?: ScheduleParams) {
    const rawData = data as Record<string, unknown>;
    const prepared = assertServiceWriteFields(
      'Schedule',
      rawData,
      SCHEDULE_PATCH_WRITE_FIELDS,
      params,
      ['next_run_at']
    );
    data = pickWriteFields<SchedulePatchData>(rawData, SCHEDULE_PATCH_WRITE_FIELDS);

    let agenticToolConfig: PersistedScheduleAgenticToolConfig | undefined;
    if (data.agentic_tool_config) {
      if (id === null) throw new BadRequest('Schedule configuration cannot be multi-patched');
      const current = params?.schedule ?? (await this.get(id, params));
      agenticToolConfig = await this.validateConfig(
        this.normalizeConfig(data.agentic_tool_config),
        current.created_by as UserID
      );
    }
    const trustedData: PersistedSchedulePatchData = {
      ...data,
      ...(agenticToolConfig ? { agentic_tool_config: agenticToolConfig } : {}),
      ...(prepared && typeof rawData.next_run_at === 'number'
        ? { next_run_at: rawData.next_run_at }
        : {}),
    };
    return super.patch(id, trustedData, params);
  }
}

export function createSchedulesService(db: TenantScopeAwareDatabase): SchedulesService {
  return new SchedulesService(db);
}
