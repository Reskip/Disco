/**
 * Agentic Tool Configuration Form
 *
 * Reusable form section for configuring agentic tool settings:
 * - Model selection (Claude/Codex/Gemini specific)
 * - Permission mode
 * - Codex-specific fields (sandbox, approval, network) — only in full mode
 *
 * Used by session creation, settings, defaults, schedules, gateway channels,
 * forks/spawns, and zone triggers.
 *
 * In compact mode:
 * - PermissionModeSelector renders as a dropdown instead of radio group
 * - Codex-specific fields are omitted (rendered separately via CodexSettingsForm)
 */

import { AGENTIC_TOOL_CAPABILITIES, getAgenticToolModelSelectionError } from '@disco/agentic-tools';
import { getAgenticToolUIIntegration } from '@disco/agentic-tools/ui';
import type { AgenticToolName, DiscoClient } from '@disco-live/client';
import { DEFAULT_CLAUDE_MODEL } from '@disco-live/client';
import { Form, Select } from 'antd';
import { useLocale } from '../../contexts/LocaleContext';
import { CodexNetworkAccessToggle } from '../CodexNetworkAccessToggle';
import { EffortSelector } from '../EffortSelector';
import { ModelSelector } from '../ModelSelector';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  PermissionModeSelector,
} from '../PermissionModeSelector';

export interface AgenticToolConfigFormProps {
  /** The agentic tool being configured */
  agenticTool: AgenticToolName;
  /** Whether to show help text under each field */
  showHelpText?: boolean;
  /**
   * Compact mode for edit contexts (e.g., SessionSettingsModal).
   * - Permission mode renders as a Select dropdown instead of radio group.
   * - Codex-specific fields (sandbox, approval, network) are omitted.
   *   Use CodexSettingsForm separately for those.
   */
  compact?: boolean;
  /**
   * Optional Feathers client. When set, the embedded ModelSelector can fetch
   * dynamic Copilot models via `/copilot-models`. Without it, the picker
   * silently uses the static fallback — fine for forms that don't need
   * dynamic discovery (e.g., default-settings preview, schedule editor).
   */
  client?: DiscoClient | null;
  /**
   * Render the Claude advisor model inline with the model selector. Surfaces
   * that relocate it into their own "Advanced" area pass `false`.
   */
  showAdvisor?: boolean;
}

const MODEL_LABELS: Record<string, string> = {
  codex: 'Codex Model',
  gemini: 'Gemini Model',
  copilot: 'Copilot Model',
  cursor: 'Cursor Model',
};

/** The rendered label of a tool's model/provider selector (defaults to Claude). */
export const modelLabelForTool = (tool: AgenticToolName): string =>
  getAgenticToolUIIntegration(tool)?.modelLabel ?? MODEL_LABELS[tool] ?? 'Claude Model';

export const AgenticToolConfigForm: React.FC<AgenticToolConfigFormProps> = ({
  agenticTool,
  showHelpText = true,
  compact = false,
  client,
  showAdvisor = true,
}) => {
  const { locale } = useLocale();
  const isChinese = locale === 'zh-CN';
  const modelLabel = isChinese
    ? agenticTool === 'opencode'
      ? 'OpenCode 模型供应商'
      : `${agenticTool === 'claude-code' ? 'Claude' : agenticTool === 'codex' ? 'Codex' : agenticTool === 'gemini' ? 'Gemini' : agenticTool === 'copilot' ? 'Copilot' : agenticTool === 'cursor' ? 'Cursor' : agenticTool} 模型`
    : modelLabelForTool(agenticTool);
  const showCodexFields = agenticTool === 'codex' && !compact;
  const toolCapabilities = AGENTIC_TOOL_CAPABILITIES[agenticTool];
  const effortLevels = toolCapabilities.reasoningEffortLevels;

  return (
    <>
      <Form.Item
        name="modelConfig"
        label={modelLabel}
        rules={[
          {
            validator: (_, value) => {
              const error = getAgenticToolModelSelectionError(agenticTool, value);
              return error ? Promise.reject(new Error(error)) : Promise.resolve();
            },
          },
        ]}
        help={
          showHelpText && agenticTool === 'claude-code'
            ? isChinese
              ? `选择要使用的 Claude 模型（默认 ${DEFAULT_CLAUDE_MODEL}）`
              : `Choose which Claude model to use (defaults to ${DEFAULT_CLAUDE_MODEL})`
            : undefined
        }
      >
        <ModelSelector agentic_tool={agenticTool} client={client} showAdvisor={showAdvisor} />
      </Form.Item>

      <Form.Item
        name="permissionMode"
        label={isChinese ? '执行权限' : 'Permission Mode'}
        help={
          showHelpText
            ? isChinese
              ? '控制智能体执行工具时如何请求确认'
              : 'Control how the agent handles tool execution approvals'
            : undefined
        }
      >
        <PermissionModeSelector agentic_tool={agenticTool} compact={compact} fullWidth />
      </Form.Item>

      {effortLevels && (
        <Form.Item
          name="effort"
          label={isChinese ? '思考深度' : 'Reasoning Effort'}
          help={
            showHelpText
              ? toolCapabilities.defaultReasoningEffort
                ? isChinese
                  ? '控制智能体使用多少推理资源'
                  : 'Control how much reasoning the agent applies'
                : isChinese
                  ? '控制智能体使用多少推理资源；继承时使用运行环境配置'
                  : 'Control how much reasoning the agent applies; inherited uses the runtime configuration'
              : undefined
          }
        >
          <EffortSelector
            levels={effortLevels}
            fallbackValue={toolCapabilities.defaultReasoningEffort}
            allowInherited={!toolCapabilities.defaultReasoningEffort}
          />
        </Form.Item>
      )}

      {showCodexFields && (
        <Form.Item
          name="codexSandboxMode"
          label={isChinese ? '沙箱模式' : 'Sandbox Mode'}
          help={
            showHelpText
              ? isChinese
                ? '控制 Codex 可以写入哪些文件'
                : 'Controls where Codex can write files (workspace vs. full access)'
              : undefined
          }
        >
          <Select
            placeholder={isChinese ? '选择沙箱模式' : 'Select sandbox mode'}
            options={CODEX_SANDBOX_MODES.map(({ value, label, description }) => ({
              value,
              label: isChinese
                ? `${value === 'read-only' ? '只读' : value === 'workspace-write' ? '工作区可写' : '完全访问'}（${label}） · ${value === 'read-only' ? '不能写入文件' : value === 'workspace-write' ? '仅可写入工作区文件' : '可访问完整文件系统'}`
                : `${label} · ${description}`,
            }))}
          />
        </Form.Item>
      )}

      {showCodexFields && (
        <Form.Item
          name="codexApprovalPolicy"
          label={isChinese ? '审批策略' : 'Approval Policy'}
          help={
            showHelpText
              ? isChinese
                ? '控制 Codex 在执行命令前是否需要询问'
                : 'Controls whether Codex must ask before executing commands'
              : undefined
          }
        >
          <Select
            placeholder={isChinese ? '选择审批策略' : 'Select approval policy'}
            options={CODEX_APPROVAL_POLICIES.map(({ value, label, description }) => ({
              value,
              label: isChinese
                ? `${value === 'untrusted' ? '每次询问' : value === 'on-request' ? '按需询问' : value === 'on-failure' ? '失败时询问' : '从不询问'}（${label}）`
                : `${label} · ${description}`,
            }))}
          />
        </Form.Item>
      )}

      {showCodexFields && (
        <Form.Item
          name="codexNetworkAccess"
          label={isChinese ? '网络访问' : 'Network Access'}
          help={
            showHelpText
              ? isChinese
                ? '允许发起 HTTP/HTTPS 请求（仅适用于“工作区可写”沙箱）'
                : 'Allow outbound HTTP/HTTPS requests (workspace-write sandbox only)'
              : undefined
          }
          valuePropName="checked"
        >
          <CodexNetworkAccessToggle showWarning={showHelpText} />
        </Form.Item>
      )}
    </>
  );
};
