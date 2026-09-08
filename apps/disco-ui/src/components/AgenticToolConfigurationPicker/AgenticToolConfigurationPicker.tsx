import { InfoCircleOutlined } from '@ant-design/icons';
import type { AgenticToolName, DiscoClient, MCPServer, User } from '@disco-live/client';
import { Alert, Button, Checkbox, Form, Select, Space, Spin, Tooltip, Typography } from 'antd';
import { useEffect } from 'react';
import { useLocale } from '../../contexts/LocaleContext';
import type { AgenticFormValues, AgenticToolConfigFormProps } from '../AgenticToolConfigForm';
import { AgenticToolConfigForm, buildConfigFromFormValues } from '../AgenticToolConfigForm';
import { SessionMcpServersField } from '../MCPServerSelect';
import {
  INLINE_AGENTIC_CONFIGURATION,
  summarizeAgenticConfiguration,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  useAgenticConfigurationSources,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from './useAgenticConfigurationSources';

export { INLINE_AGENTIC_CONFIGURATION } from './useAgenticConfigurationSources';

/** Form field the save-as-default checkbox binds to. Parents read it on submit. */
export const SAVE_AS_DEFAULT_FIELD = 'saveAsDefault';

const PreservedFormValue: React.FC<{ value?: unknown }> = () => null;

interface Props extends Omit<AgenticToolConfigFormProps, 'agenticTool' | 'client'> {
  tool: AgenticToolName;
  client: DiscoClient | null;
  /** Subject-authorized model catalog. Explicit null disables inline model selection. */
  modelCatalogClient?: DiscoClient | null;
  mcpServerById: Map<string, MCPServer>;
  fieldName?: string;
  /**
   * How a reserved default/preset resolves — surfaced as a schedule-run note.
   * `save` (default) shows no banner (the redesign relies on inline resolved
   * summaries); `schedule-run` explains per-run resolution for ScheduleModal.
   */
  defaultResolution?: 'save' | 'schedule-run';
  /** Current user — resolves "My default" and gates the save-as-default checkbox. */
  currentUser?: User | null;
  /** False while a persisted configuration's execution owner is still hydrating. */
  configurationOwnerResolved?: boolean;
  /** Render the MCP servers field inside the picker (default true). */
  renderMcpField?: boolean;
  /** Offer the "Save as my default" checkbox while inline config is active. */
  enableSaveAsDefault?: boolean;
}

/**
 * Persist an inline configuration as the user's default for a tool. Callers
 * invoke this from their own submit handler when the save-as-default checkbox
 * is checked, then create/update the session as usual.
 *
 * Writes under the selected tool key and also sets
 * `default_agentic_selection[tool]` to
 * `{ source: 'inline' }` — otherwise a user whose selection points at a preset
 * or the workspace default would save a config blob the daemon never resolves.
 * The daemon reads this raw key before falling back to the canonical tool key.
 */
export async function persistUserDefaultFromForm(
  client: DiscoClient,
  user: User,
  tool: AgenticToolName,
  values: AgenticFormValues
): Promise<void> {
  const config = buildConfigFromFormValues(tool, values);
  await client.service('users').patch(user.user_id, {
    default_agentic_config: { ...user.default_agentic_config, [tool]: config },
    default_agentic_selection: {
      ...user.default_agentic_selection,
      [tool]: { source: 'inline' as const },
    },
  });
}

/** Tool-scoped preset-or-inline picker shared by every runtime configuration surface. */
export const AgenticToolConfigurationPicker: React.FC<Props> = ({
  tool,
  client,
  modelCatalogClient,
  mcpServerById,
  fieldName = 'agenticToolPresetId',
  defaultResolution = 'save',
  currentUser,
  configurationOwnerResolved = true,
  renderMcpField = true,
  enableSaveAsDefault = false,
  ...formProps
}) => {
  const { locale } = useLocale();
  const isChinese = locale === 'zh-CN';
  const resolvedModelCatalogClient = modelCatalogClient === undefined ? client : modelCatalogClient;
  const catalogUnavailable = tool === 'opencode' && resolvedModelCatalogClient === null;
  const form = Form.useFormInstance();
  const selected = Form.useWatch(fieldName, form);
  const modelConfig = Form.useWatch('modelConfig', form);
  const permissionMode = Form.useWatch('permissionMode', form);
  const {
    inlineAllowed,
    inlineSelectionAllowed,
    presets,
    loading,
    loaded,
    loadError,
    retry,
    isValidSource,
    preferredSource,
    sourceOptions,
    getSourceError,
  } = useAgenticConfigurationSources({
    tool,
    client,
    currentUser,
    allowInlineSelection: !catalogUnavailable,
    preserveInlineSelection: catalogUnavailable && selected === INLINE_AGENTIC_CONFIGURATION,
  });
  const storedInlineSummary = summarizeAgenticConfiguration(
    tool,
    {
      modelConfig,
      permissionMode,
    },
    locale
  );

  useEffect(() => {
    if (!configurationOwnerResolved || !loaded || isValidSource(selected)) return;
    form.setFieldValue(fieldName, preferredSource);
  }, [
    configurationOwnerResolved,
    fieldName,
    form,
    isValidSource,
    loaded,
    preferredSource,
    selected,
  ]);

  const configurationLabel = (
    <Space size={4}>
      <span>{isChinese ? '运行配置' : 'Configuration'}</span>
      <Tooltip
        title={
          isChinese
            ? '预设由管理员管理；“我的默认配置”是创建新会话时使用的个人配置。'
            : 'Presets are admin-managed configs. “My default” is your personal setup applied to new sessions.'
        }
      >
        <InfoCircleOutlined />
      </Tooltip>
    </Space>
  );

  return (
    <>
      <Form.Item
        name={fieldName}
        label={configurationLabel}
        rules={[
          {
            validator: () => {
              const error = getSourceError(selected);
              return error ? Promise.reject(new Error(error)) : Promise.resolve();
            },
          },
        ]}
      >
        <Select
          loading={loading}
          notFoundContent={loading ? <Spin size="small" /> : isChinese ? '暂无预设' : 'No presets'}
          optionLabelProp="labelText"
          options={sourceOptions.map((option) => ({
            value: option.value,
            disabled: option.disabled,
            // Closed control carries the resolved summary — this replaces the banner.
            labelText: option.summary ? `${option.title} · ${option.summary}` : option.title,
            title: option.title,
            summary: option.summary,
          }))}
          optionRender={(option) => (
            <div style={{ lineHeight: 1.3 }}>
              <div>{option.data.title}</div>
              {option.data.summary && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {option.data.summary}
                </Typography.Text>
              )}
            </div>
          )}
        />
      </Form.Item>

      {loadError && (
        <Alert
          type="error"
          showIcon
          title={isChinese ? '无法加载运行配置预设' : 'Unable to load configuration presets'}
          action={
            <Button size="small" onClick={retry}>
              {isChinese ? '重试' : 'Retry'}
            </Button>
          }
        />
      )}

      {catalogUnavailable && (
        <Alert
          type="warning"
          showIcon
          title={
            isChinese
              ? '当前运行账号无法选择 OpenCode 模型'
              : 'OpenCode model selection is unavailable for this execution owner'
          }
          description={
            selected === INLINE_AGENTIC_CONFIGURATION && inlineSelectionAllowed
              ? isChinese
                ? `已保存配置：${storedInlineSummary || '指定的供应商与模型组合'}。当前为只读状态，保存时会保留。`
                : `Stored configuration: ${storedInlineSummary || 'exact provider/model pair'}. It is read-only and will be preserved.`
              : undefined
          }
        />
      )}

      {selected === INLINE_AGENTIC_CONFIGURATION && !inlineAllowed && inlineSelectionAllowed && (
        <>
          <Form.Item name="modelConfig" noStyle>
            <PreservedFormValue />
          </Form.Item>
          <Form.Item name="permissionMode" noStyle>
            <PreservedFormValue />
          </Form.Item>
        </>
      )}

      {!inlineAllowed && !inlineSelectionAllowed && presets.length === 0 && loaded && (
        <Alert
          type="error"
          showIcon
          title={
            isChinese ? '当前没有可用的管理员预设' : 'No administrator-managed preset is available'
          }
        />
      )}

      {/* Schedules resolve reserved defaults/presets at each run — keep #1963's
          per-run note. Save-context surfaces rely on the inline resolved
          summaries instead of a banner (WS3 redesign). */}
      {defaultResolution === 'schedule-run' &&
        selected &&
        selected !== INLINE_AGENTIC_CONFIGURATION && (
          <Alert
            type="info"
            showIcon
            title={
              selected === USER_DEFAULT_AGENTIC_CONFIGURATION
                ? isChinese
                  ? '使用我的默认配置'
                  : 'Using your default'
                : selected === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
                  ? isChinese
                    ? '使用工作区默认配置'
                    : 'Using the workspace default'
                  : isChinese
                    ? '由预设管理'
                    : 'Managed by preset'
            }
            description={
              selected === USER_DEFAULT_AGENTIC_CONFIGURATION
                ? isChinese
                  ? '每次运行计划任务时，使用创建者当时的个人默认配置。'
                  : "Resolved from the schedule creator's current default each time this schedule runs."
                : selected === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
                  ? isChinese
                    ? '每次运行计划任务时，使用当时的工作区默认配置。'
                    : 'Resolved from the current workspace default each time this schedule runs.'
                  : isChinese
                    ? '每次运行计划任务时，使用该预设的最新版本。'
                    : 'The latest version of this preset is used each time this schedule runs.'
            }
          />
        )}

      {selected === INLINE_AGENTIC_CONFIGURATION && inlineAllowed && (
        <>
          <AgenticToolConfigForm
            agenticTool={tool}
            client={resolvedModelCatalogClient}
            {...formProps}
          />
          {enableSaveAsDefault && currentUser && client && (
            <Form.Item
              name={SAVE_AS_DEFAULT_FIELD}
              valuePropName="checked"
              style={{ marginBottom: 8 }}
            >
              <Checkbox>
                {isChinese ? `保存为我的 ${tool} 默认配置` : `Save as my default for ${tool}`}
              </Checkbox>
            </Form.Item>
          )}
        </>
      )}

      {renderMcpField && (
        <SessionMcpServersField
          mcpServerById={mcpServerById}
          showHelpText={formProps.showHelpText}
        />
      )}
    </>
  );
};
