import { describe, expectTypeOf, it } from 'vitest';
import type {
  MessageCreate,
  ScheduleCreateData,
  SchedulePatchData,
} from '../types/index.js';
import { MessageRole } from '../types/index.js';
import type {
  DiscoClient,
  ClientInput,
  MessagesService,
  SchedulesService,
} from './index.js';

type ScheduleCreateInput = Parameters<SchedulesService['create']>[0];
type SchedulePatchInput = Parameters<SchedulesService['patch']>[1];
type ScheduleUpdateInput = Parameters<SchedulesService['update']>[1];
type MessageCreateInput = Parameters<MessagesService['create']>[0];

function assertClientWriteBoundaries(client: DiscoClient): void {
  void client.service('schedules').create({
    agent_id: 'agent-id',
    name: 'Nightly',
    cron_expression: '0 0 * * *',
    timezone_mode: 'utc',
    prompt: 'Run',
    agentic_tool_config: { agentic_tool: 'codex' },
  });

  // Persisted removed tools and runtime-owned output fields are read-only.
  void client.service('schedules').create({
    agent_id: 'agent-id',
    name: 'Nightly',
    cron_expression: '0 0 * * *',
    timezone_mode: 'utc',
    prompt: 'Run',
    // @ts-expect-error claude-code-cli is preserved only on stored Schedule rows.
    agentic_tool_config: { agentic_tool: 'claude-code-cli' },
  });
  void client.service('schedules').create({
    agent_id: 'agent-id',
    name: 'Nightly',
    cron_expression: '0 0 * * *',
    timezone_mode: 'utc',
    prompt: 'Run',
    agentic_tool_config: { agentic_tool: 'codex' },
    // @ts-expect-error created_at is owned by the schedule runtime.
    created_at: '2026-07-28T00:00:00.000Z',
  });

  // @ts-expect-error required create fields cannot be omitted.
  void client.service('schedules').create({ agentic_tool_config: { agentic_tool: 'codex' } });
  // @ts-expect-error local schedule creates require an IANA timezone.
  void client.service('schedules').create({
    name: 'Nightly',
    cron_expression: '0 0 * * *',
    timezone_mode: 'local',
    prompt: 'Run',
    agentic_tool_config: { agentic_tool: 'codex' },
  });
  void client.service('schedules').patch('schedule-id', {
    // @ts-expect-error schedules cannot be retargeted by patch.
    agent_id: 'other-agent',
  });

  // @ts-expect-error public Message CRUD does not expose full replacement.
  void client.service('messages').update('message-id', {});
  // @ts-expect-error public Message patch always targets one exact Message.
  void client.service('messages').patch(null, { content_preview: 'bulk patch' });
  // @ts-expect-error Message ownership cannot change after creation.
  void client.service('messages').patch('message-id', { task_id: 'task-id' });
  void client.service('messages').create({
    session_id: 'session-id',
    task_id: 'task-id',
    type: 'user',
    role: MessageRole.USER,
    index: 0,
    timestamp: '2026-08-14T00:00:00.000Z',
    content_preview: 'Prompt',
    content: 'Prompt',
  });
  // @ts-expect-error Message create requires complete persisted content fields.
  void client.service('messages').create({ session_id: 'session-id', type: 'user' });

  // Provenance is derived from the authenticated transport, not caller input.
  // @ts-expect-error messageSource is daemon-owned provenance.
  void client.sessions.prompt('session-id', 'Prompt', { messageSource: 'gateway' });
  // @ts-expect-error messageSource is daemon-owned provenance.
  void client.tasks.run('task-id', { messageSource: 'gateway' });
}

void assertClientWriteBoundaries;

describe('public service write contracts', () => {
  it('derive client inputs from the active-only DTOs', () => {
    expectTypeOf<ScheduleCreateInput>().toEqualTypeOf<ClientInput<ScheduleCreateData>>();
    expectTypeOf<SchedulePatchInput>().toEqualTypeOf<ClientInput<SchedulePatchData> | null>();
    expectTypeOf<ScheduleUpdateInput>().toEqualTypeOf<never>();
    expectTypeOf<MessageCreateInput>().toEqualTypeOf<ClientInput<MessageCreate>>();
  });
});
