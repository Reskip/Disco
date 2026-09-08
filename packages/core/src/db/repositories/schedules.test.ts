import type { AgentID, UserID } from '@disco/core/types';
import { describe, expect } from 'vitest';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { AgentRepository } from './agents';
import { ScheduleRepository } from './schedules';
import { UsersRepository } from './users';

async function setup(db: Database) {
  const user = await new UsersRepository(db).create({
    username: `schedule-${Date.now()}-${Math.random()}@example.com`,
    name: 'Schedule Owner',
  });
  const agents = new AgentRepository(db);
  const agent = await agents.create({
    createdBy: user.user_id as UserID,
    displayName: 'Daily Agent',
    workspacePath: `C:/disco/users/${user.user_id}/agents/daily`,
    state: 'ready',
  });
  return {
    user,
    agent,
    agents,
    schedules: new ScheduleRepository(db),
  };
}

function definition(name = 'Daily review') {
  return {
    name,
    cron_expression: '0 9 * * *',
    timezone_mode: 'utc' as const,
    prompt: 'Review at {{schedule.scheduled_time}}',
    agentic_tool_config: { agentic_tool: 'codex' as const },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 5,
  };
}

describe('ScheduleRepository direct ownership', () => {
  dbTest('round-trips Agent and standalone targets without a Branch carrier', async ({ db }) => {
    const ctx = await setup(db);
    const agentSchedule = await ctx.schedules.create({
      ...definition('Agent schedule'),
      agent_id: ctx.agent.agent_id,
      created_by: ctx.user.user_id,
    });
    const standalone = await ctx.schedules.create({
      ...definition('Standalone schedule'),
      agent_id: null,
      created_by: ctx.user.user_id,
    });

    await expect(ctx.schedules.findById(agentSchedule.schedule_id)).resolves.toMatchObject({
      agent_id: ctx.agent.agent_id,
      created_by: ctx.user.user_id,
    });
    await expect(ctx.schedules.findById(standalone.schedule_id)).resolves.toMatchObject({
      agent_id: null,
      created_by: ctx.user.user_id,
    });
    expect(await ctx.schedules.findAll({ agent_id: ctx.agent.agent_id })).toHaveLength(1);
    expect(await ctx.schedules.findAll({ agent_id: null })).toHaveLength(1);
  });

  dbTest('keeps the target immutable across updates', async ({ db }) => {
    const ctx = await setup(db);
    const created = await ctx.schedules.create({
      ...definition(),
      agent_id: ctx.agent.agent_id,
      created_by: ctx.user.user_id,
    });

    const updated = await ctx.schedules.update(created.schedule_id, {
      name: 'Renamed',
      agent_id: null,
    });

    expect(updated.name).toBe('Renamed');
    expect(updated.agent_id).toBe(ctx.agent.agent_id);
  });

  dbTest('queries due schedules independent of Agent target', async ({ db }) => {
    const ctx = await setup(db);
    await ctx.schedules.create({
      ...definition('Due Agent'),
      agent_id: ctx.agent.agent_id,
      created_by: ctx.user.user_id,
      next_run_at: Date.now() - 1_000,
    });
    await ctx.schedules.create({
      ...definition('Future standalone'),
      created_by: ctx.user.user_id,
      next_run_at: Date.now() + 60_000,
    });

    await expect(ctx.schedules.findDue()).resolves.toEqual([
      expect.objectContaining({ name: 'Due Agent', agent_id: ctx.agent.agent_id }),
    ]);
  });

  dbTest('deleting an Agent cascades only its targeted schedules', async ({ db }) => {
    const ctx = await setup(db);
    await ctx.schedules.create({
      ...definition('Agent schedule'),
      agent_id: ctx.agent.agent_id as AgentID,
      created_by: ctx.user.user_id,
    });
    await ctx.schedules.create({
      ...definition('Standalone schedule'),
      created_by: ctx.user.user_id,
    });

    await ctx.agents.delete(ctx.agent.agent_id);

    expect(await ctx.schedules.findAll({ created_by: ctx.user.user_id })).toEqual([
      expect.objectContaining({ name: 'Standalone schedule', agent_id: null }),
    ]);
  });
});
