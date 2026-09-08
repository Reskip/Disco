/**
 * Schedule create / edit modal.
 *
 * Mirrors the structure of `NewSessionModal` for visual + ergonomic
 * consistency:
 *
 * - Primary fields top: name, description, prompt, cron + timezone, agent,
 *   MCP servers.
 * - Ghost `<Collapse>` with two panels for the secondary zone:
 *     1. "Agentic Tool Configuration" — the same preset-or-inline picker
 *        the session modal uses. MCP selection remains a sibling field and
 *        is never persisted inside a preset.
 *     2. "Schedule Settings" — retention + concurrency (schedule-specific).
 *
 * Reuses the same building blocks as `NewSessionModal`:
 * - `AgentSelectionGrid` (with `variant="select"` here vs `cards` there —
 *   schedules don't need to merchandise the agent choice).
 * - `SessionMcpServersField` as a top-level form field.
 * - `AgenticToolConfigurationPicker` plus independent MCP selection.
 * - `getFormValuesFromConfig` / `buildConfigFromFormValues` to translate
 *   between form values and the schedule's `agentic_tool_config` jsonb.
 *
 * Field order for the primary zone follows §6b of the design doc: name +
 * description → prompt → cron + timezone → agent → MCP.
 */

import { DownOutlined } from '@ant-design/icons';
import type {
  Agent,
  AgentID,
  AgenticToolName,
  DiscoClient,
  MCPServer,
  Schedule,
  ScheduleAgenticToolConfig,
  ScheduleCreateData,
  SchedulePatchData,
  User,
} from '@disco-live/client';
import {
  humanizeCron,
  isActiveScheduleAgenticToolConfig,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@disco-live/client';
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Cron } from 'react-js-cron';
import 'react-js-cron/dist/styles.css';
import { getDiscoPortalContainer } from '@/utils/portalContainer';
import { useThemedMessage } from '../../utils/message';
import {
  type AgenticFormValues,
  buildScheduleConfigFromFormValues,
  getFormValuesFromConfig,
  scheduleConfigToDefaultConfig,
} from '../AgenticToolConfigForm';
import {
  AgenticToolConfigurationPicker,
  INLINE_AGENTIC_CONFIGURATION,
} from '../AgenticToolConfigurationPicker';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';

const { TextArea } = Input;
const { Text } = Typography;

// Curated IANA timezone list shown in the timezone AutoComplete; users
// can also type any other IANA zone (validated server-side).
const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
] as const;

function detectBrowserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface ScheduleModalProps {
  open: boolean;
  onClose: () => void;
  /** Persistent Agents the current user may target. */
  agents: Agent[];
  /** Existing schedule when editing; null/undefined when creating. */
  schedule?: Schedule | null;
  /** MCP server catalog. */
  mcpServerById: Map<string, MCPServer>;
  /** Feathers client. */
  client: DiscoClient | null;
  /** Stable owner whose defaults resolve at each run. */
  executionOwner?: User | null;
  /** Authenticated caller; model catalogs are caller-scoped. */
  currentUser?: User | null;
  /** Fires after a successful create OR patch with the saved schedule. */
  onSaved?: (schedule: Schedule) => void;
}

const DEFAULT_CRON = '0 * * * *';
const CRON_LOCALE = {
  everyText: '每',
  emptyMonths: '每月',
  emptyMonthDays: '每月的每天',
  emptyMonthDaysShort: '日期',
  emptyWeekDays: '每周每天',
  emptyWeekDaysShort: '星期',
  emptyHours: '每小时',
  emptyMinutes: '每分钟',
  emptyMinutesForHourPeriod: '每',
  yearOption: '年',
  monthOption: '月',
  weekOption: '周',
  dayOption: '天',
  hourOption: '小时',
  minuteOption: '分钟',
  rebootOption: '重启时',
  prefixPeriod: '每',
  prefixMonths: '在',
  prefixMonthDays: '第',
  prefixWeekDays: '星期',
  prefixWeekDaysForMonthAndYearPeriod: '以及',
  prefixHours: '',
  prefixMinutes: ':',
  prefixMinutesForHourPeriod: '第',
  suffixMinutesForHourPeriod: '分钟',
  errorInvalidCron: 'Cron 表达式无效',
  clearButtonText: '清除',
  weekDays: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
  months: [
    '一月',
    '二月',
    '三月',
    '四月',
    '五月',
    '六月',
    '七月',
    '八月',
    '九月',
    '十月',
    '十一月',
    '十二月',
  ],
};

// ScheduleModal carries schedule-specific fields (cron/tz/retention/etc.)
// plus the shared `AgenticFormValues` shape that AgenticToolConfigForm and
// its helpers read/write. Spreading the shared interface keeps the field
// names in lockstep with NewSessionModal and the agenticConfigHelpers.
interface ScheduleFormValues extends AgenticFormValues {
  mcpServerIds?: string[];
  agenticToolPresetId?: string;
  name?: string;
  description?: string;
  prompt?: string;
  cron_expression?: string;
  timezone_mode?: 'local' | 'utc';
  timezone?: string;
  agenticTool?: AgenticToolName;
  enabled?: boolean;
  retention?: number;
  allow_concurrent_runs?: boolean;
  agentId?: AgentID | null;
}

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  open,
  onClose,
  agents = [],
  schedule,
  mcpServerById,
  client,
  executionOwner,
  currentUser,
  onSaved,
}) => {
  const isEditing = Boolean(schedule?.schedule_id);
  const { showError, showSuccess } = useThemedMessage();
  const [form] = Form.useForm<ScheduleFormValues>();

  // Agent picker is controlled via local state because it drives which
  // fields AgenticToolConfigForm shows (for example runtime-supported effort).
  // The selected value is mirrored into the form as `agenticTool` so save
  // can read it consistently with the rest of the form.
  const configuredConfig = schedule?.agentic_tool_config;
  const configuredActiveConfig = isActiveScheduleAgenticToolConfig(configuredConfig)
    ? configuredConfig
    : undefined;
  const configuredTool = configuredConfig?.agentic_tool;
  const configuredActiveTool = configuredActiveConfig?.agentic_tool;
  const [agentTool, setAgentTool] = useState<AgenticToolName>(configuredActiveTool ?? 'codex');
  const [requiresSupportedToolSelection, setRequiresSupportedToolSelection] = useState(
    Boolean(configuredTool && !configuredActiveTool)
  );
  const [showCronPicker, setShowCronPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const executionOwnerResolved =
    !schedule?.created_by || executionOwner?.user_id === schedule.created_by;

  // Initialize form when modal opens or the schedule prop changes.
  useEffect(() => {
    if (!open) return;
    const persistedConfig = schedule?.agentic_tool_config;
    const activeConfig = isActiveScheduleAgenticToolConfig(persistedConfig)
      ? persistedConfig
      : undefined;
    const persistedTool = persistedConfig?.agentic_tool;
    const activeTool = activeConfig?.agentic_tool;
    const tool = activeTool ?? 'codex';
    const configValues = getFormValuesFromConfig(tool, scheduleConfigToDefaultConfig(activeConfig));
    setAgentTool(tool);
    setRequiresSupportedToolSelection(Boolean(persistedTool && !activeTool));
    setShowCronPicker(false);
    form.resetFields();
    form.setFieldsValue({
      name: schedule?.name ?? '',
      agentId: schedule?.agent_id ?? null,
      description: schedule?.description ?? '',
      prompt: schedule?.prompt ?? '',
      cron_expression: schedule?.cron_expression ?? DEFAULT_CRON,
      timezone_mode: schedule?.timezone_mode ?? 'local',
      timezone: schedule?.timezone ?? detectBrowserTz(),
      agenticTool: tool,
      agenticToolPresetId:
        schedule?.agentic_tool_config?.configuration_reference ??
        schedule?.agentic_tool_config?.preset_id ??
        INLINE_AGENTIC_CONFIGURATION,
      enabled: schedule?.enabled ?? true,
      retention: schedule?.retention ?? 5,
      allow_concurrent_runs: schedule?.allow_concurrent_runs ?? false,
      ...configValues,
      mcpServerIds: schedule?.mcp_server_ids ?? [],
    });
  }, [open, schedule, form]);

  // Reseed AgenticToolConfigForm fields ONLY when the user actually
  // changes the agent — not on mount/open. A useEffect keyed on
  // `agentTool` would clobber the just-loaded saved values on every
  // edit-open (the original ScheduleTab carried the same warning).
  const handleAgentToolChange = (next: AgenticToolName) => {
    if (next === agentTool && !requiresSupportedToolSelection) return;
    setRequiresSupportedToolSelection(false);
    setAgentTool(next);
    const defaults = getFormValuesFromConfig(next);
    form.setFieldsValue({
      ...defaults,
      agenticTool: next,
      agenticToolPresetId: undefined,
      ...(next !== 'codex' && {
        codexSandboxMode: undefined,
        codexApprovalPolicy: undefined,
        codexNetworkAccess: undefined,
      }),
    });
  };

  const cronValue = Form.useWatch('cron_expression', form) ?? DEFAULT_CRON;
  const timezoneModeValue = Form.useWatch('timezone_mode', form) ?? 'local';

  const humanizedCron = useMemo(() => {
    try {
      return humanizeCron(cronValue);
    } catch {
      return null;
    }
  }, [cronValue]);

  const handleSave = async () => {
    if (!client) {
      showError('尚未连接到 Disco 服务');
      return;
    }
    if (requiresSupportedToolSelection) {
      showError('请先选择受支持的执行工具，再保存这个历史计划任务');
      return;
    }
    let values: ScheduleFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (values.timezone_mode === 'local' && !values.timezone) {
      showError('使用本地时间时必须选择时区');
      return;
    }
    // `getFieldsValue(true)` includes fields rendered inside collapsed
    // panels (which validateFields can skip).
    const all = { ...form.getFieldsValue(true), ...values } as ScheduleFormValues;
    const timezoneMode = all.timezone_mode ?? 'local';
    const timezone = all.timezone?.trim();
    if (timezoneMode === 'local' && !timezone) {
      showError('使用本地时间时必须选择时区');
      return;
    }
    let timezoneConfig: { timezone_mode: 'local'; timezone: string } | { timezone_mode: 'utc' };
    if (timezoneMode === 'local') {
      // Guarded above; keep the discriminated create DTO honest without a cast.
      if (!timezone) return;
      timezoneConfig = { timezone_mode: 'local', timezone };
    } else {
      timezoneConfig = { timezone_mode: 'utc' };
    }

    setSaving(true);
    try {
      const payload: ScheduleCreateData = {
        agent_id: all.agentId ?? undefined,
        name: (all.name ?? '').trim(),
        description: all.description?.trim() || undefined,
        prompt: (all.prompt ?? '').trim(),
        cron_expression: all.cron_expression ?? DEFAULT_CRON,
        ...timezoneConfig,
        agentic_tool_config:
          all.agenticToolPresetId === USER_DEFAULT_AGENTIC_CONFIGURATION
            ? {
                agentic_tool: agentTool,
                configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
              }
            : all.agenticToolPresetId === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
              ? {
                  agentic_tool: agentTool,
                  configuration_reference: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
                }
              : all.agenticToolPresetId && all.agenticToolPresetId !== INLINE_AGENTIC_CONFIGURATION
                ? {
                    agentic_tool: agentTool,
                    preset_id: all.agenticToolPresetId as NonNullable<
                      ScheduleAgenticToolConfig['preset_id']
                    >,
                  }
                : buildScheduleConfigFromFormValues(
                    agentTool,
                    {
                      modelConfig: all.modelConfig,
                      effort: all.effort,
                      permissionMode: all.permissionMode,
                      codexSandboxMode: all.codexSandboxMode,
                      codexApprovalPolicy: all.codexApprovalPolicy,
                      codexNetworkAccess: all.codexNetworkAccess,
                    },
                    schedule?.agentic_tool_config
                  ),
        mcp_server_ids: all.mcpServerIds ?? [],
        enabled: all.enabled ?? true,
        retention: all.retention ?? 5,
        allow_concurrent_runs: all.allow_concurrent_runs ?? false,
      };

      let saved: Schedule;
      if (isEditing && schedule?.schedule_id) {
        const { agent_id: _agentId, ...patchPayload } = payload;
        saved = await client
          .service('schedules')
          .patch(schedule.schedule_id, patchPayload satisfies SchedulePatchData);
      } else {
        saved = await client.service('schedules').create(payload);
      }

      showSuccess(isEditing ? '计划任务已更新' : '计划任务已创建');
      onSaved?.(saved);
      onClose();
    } catch (e: unknown) {
      showError(e instanceof Error ? e.message : '保存计划任务失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      getContainer={getDiscoPortalContainer}
      className="disco-schedule-modal"
      title={isEditing ? `编辑计划任务 · ${schedule?.name}` : '新建计划任务'}
      open={open}
      onCancel={onClose}
      width={760}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onClose} disabled={saving}>
          取消
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={saving}
          disabled={requiresSupportedToolSelection}
          onClick={handleSave}
        >
          {isEditing ? '保存' : '创建'}
        </Button>,
      ]}
    >
      {requiresSupportedToolSelection && (
        <Alert
          type="warning"
          showIcon
          title="这个计划任务使用了已移除的执行工具"
          description="原配置已保留，但当前无法运行。请选择受支持的工具并明确保存，以完成迁移。"
          style={{ marginTop: 16 }}
        />
      )}
      <Form form={form} layout="vertical" preserve={false} style={{ marginTop: 16 }}>
        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '请输入计划任务名称' }]}
        >
          <Input placeholder="例如：每小时状态检查" />
        </Form.Item>

        <Form.Item name="description" label="说明（可选）">
          <Input placeholder="说明这个计划任务要做什么" />
        </Form.Item>

        <Form.Item
          name="prompt"
          label="提示词模板"
          rules={[{ required: true, message: '请输入提示词模板' }]}
          help={
            <Text type="secondary" style={{ fontSize: 12 }}>
              可用变量：<code>{'{{schedule.*}}'}</code>；指定智能体时还可用{' '}
              <code>{'{{agent.*}}'}</code>
            </Text>
          }
        >
          <TextArea placeholder="整理本周进展并给出下一步建议。" rows={6} />
        </Form.Item>

        <Form.Item
          name="cron_expression"
          label="Cron 表达式"
          rules={[{ required: true, message: '请输入 Cron 表达式' }]}
          extra={
            <>
              {humanizedCron && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ⓘ {humanizedCron}
                </Text>
              )}
              {showCronPicker && (
                <div className="disco-schedule-cron-picker" style={{ marginTop: 12 }}>
                  <Cron
                    value={cronValue}
                    setValue={(v: string) => form.setFieldValue('cron_expression', v)}
                    clearButton={false}
                    locale={CRON_LOCALE}
                  />
                </div>
              )}
            </>
          }
        >
          <Space.Compact className="disco-schedule-cron-input" style={{ width: '100%' }}>
            <Input
              value={cronValue}
              onChange={(e) => form.setFieldValue('cron_expression', e.target.value)}
              placeholder="0 * * * *"
            />
            <Button onClick={() => setShowCronPicker((s) => !s)}>
              {showCronPicker ? '收起可视化编辑' : '可视化编辑'}
            </Button>
          </Space.Compact>
        </Form.Item>

        <Form.Item name="timezone_mode" label="时区模式">
          <Radio.Group>
            <Radio value="local">本地时间</Radio>
            <Radio value="utc">UTC</Radio>
          </Radio.Group>
        </Form.Item>

        {timezoneModeValue === 'local' && (
          <Form.Item
            name="timezone"
            label="时区"
            rules={[{ required: true, message: '使用本地时间时必须选择时区' }]}
          >
            <AutoComplete
              // AutoComplete lets the user pick from the curated list OR
              // type any other IANA zone. The server-side validator
              // (validateScheduleConfig) rejects unknown zones via
              // Intl.DateTimeFormat, so free entry is safe here.
              options={COMMON_TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
              filterOption={(input, option) =>
                (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
              placeholder="输入或选择 IANA 时区，例如 Asia/Shanghai"
            />
          </Form.Item>
        )}

        <Form.Item
          name="agentId"
          label="运行身份"
          extra={isEditing ? '计划任务的运行身份创建后不可更改。' : undefined}
        >
          <Select
            disabled={isEditing}
            options={[
              { value: null, label: '独立会话（无智能体人格、记忆与专属技能）' },
              ...agents
                .filter((agent) => !agent.archived && agent.state === 'ready')
                .map((agent) => ({
                  value: agent.agent_id,
                  label: `${agent.emoji ? `${agent.emoji} ` : ''}${agent.display_name}`,
                })),
            ]}
          />
        </Form.Item>

        <Form.Item label="执行工具">
          <AgentSelectionGrid
            agents={AVAILABLE_AGENTS}
            selectedAgentId={requiresSupportedToolSelection ? null : agentTool}
            onSelect={(id) => handleAgentToolChange(id as AgenticToolName)}
            variant="select"
            fallbackToFirstVisibleAgent={!isEditing}
          />
        </Form.Item>

        {!requiresSupportedToolSelection && (
          <AgenticToolConfigurationPicker
            tool={agentTool}
            mcpServerById={mcpServerById}
            client={client}
            modelCatalogClient={
              executionOwner?.user_id && executionOwner.user_id === currentUser?.user_id
                ? client
                : null
            }
            defaultResolution="schedule-run"
            currentUser={executionOwner}
            configurationOwnerResolved={executionOwnerResolved}
          />
        )}

        <Collapse
          ghost
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'schedule-settings',
              label: <Typography.Text strong>计划任务设置</Typography.Text>,
              children: (
                <>
                  <Form.Item name="retention" label="保留会话数（0 表示全部保留）">
                    <InputNumber min={0} />
                  </Form.Item>
                  <Form.Item
                    name="allow_concurrent_runs"
                    label="并发运行"
                    extra="只控制同一计划任务的多次运行是否允许重叠。"
                  >
                    <Radio.Group>
                      <Radio value={false}>不允许运行重叠（默认）</Radio>
                      <Radio value={true}>允许运行重叠</Radio>
                    </Radio.Group>
                  </Form.Item>
                </>
              ),
            },
          ]}
          style={{ marginTop: 16 }}
        />

        {!isEditing && (
          <Alert
            style={{ marginTop: 16 }}
            type="info"
            showIcon
            message="默认不补跑错过的任务。"
            description="如果 Disco 服务在计划触发时离线，只会补跑 2 分钟宽限期内最近一次错过的任务，不会批量回填。"
          />
        )}
      </Form>
    </Modal>
  );
};
