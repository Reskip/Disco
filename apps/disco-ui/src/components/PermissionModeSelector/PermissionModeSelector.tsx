import {
  EditOutlined,
  ExperimentOutlined,
  LockOutlined,
  SafetyOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { getAgenticToolUIIntegration } from '@disco/agentic-tools/ui';
import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  PermissionMode,
} from '@disco-live/client';
import { getDefaultPermissionMode, mapToCodexPermissionConfig } from '@disco-live/client';
import type { GlobalToken } from 'antd';
import { Flex, Select, Space, Tooltip, Typography, theme } from 'antd';
import type { AppLocale } from '../../contexts/LocaleContext';
import { useLocale } from '../../contexts/LocaleContext';

interface ModeOption {
  mode: PermissionMode;
  label: string;
  description: string;
  icon: React.ReactNode;
  tone: 'danger' | 'success' | 'info' | 'warning';
}

export interface PermissionModeSelectorProps {
  value?: PermissionMode;
  onChange?: (value: PermissionMode) => void;
  agentic_tool?: AgenticToolName;
  /** If true, renders as a compact Select dropdown instead of Radio buttons */
  compact?: boolean;
  /**
   * When in Select (compact) mode, render only the icon in the trigger.
   * Defaults to `false` — trigger shows icon + label so users in roomy
   * contexts (e.g. session settings dropdown) can read the mode name.
   * Set `true` for tight surfaces like the conversation footer where
   * only the icon fits. The tooltip preserves the label either way.
   */
  iconOnly?: boolean;
  /** Render compact selects with plain text labels (useful in popovers/forms). */
  plain?: boolean;
  fullWidth?: boolean;
  /** Size for compact mode */
  size?: 'small' | 'middle' | 'large';
  /** Codex-specific: sandbox mode value */
  codexSandboxMode?: CodexSandboxMode;
  /** Codex-specific: approval policy value */
  codexApprovalPolicy?: CodexApprovalPolicy;
  /** Codex-specific: callback for dual permission changes */
  onCodexChange?: (sandbox: CodexSandboxMode, approval: CodexApprovalPolicy) => void;
}

// Each list is ordered most-oversight → least; the fully-autonomous "bypass"
// mode is always last and rendered in the warning tone. `label` is the human
// name shown to users; `mode` is the raw config value surfaced as muted text.
// Descriptions use the two-part formula: "what runs without asking · best for".

// Claude Code permission modes (Claude Agent SDK)
const CLAUDE_CODE_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'Manual',
    description: 'Asks before every tool use · for high-stakes changes',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'plan',
    label: 'Plan',
    description: 'Explores and plans, runs nothing · for scoping work first',
    icon: <ExperimentOutlined />,
    tone: 'info',
  },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    description: 'Auto-approves file edits · for code you review in the diff',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'auto',
    label: 'Auto',
    description: 'Approves routine steps, asks when unsure · for trusted work',
    icon: <SafetyOutlined />,
    tone: 'info',
  },
  {
    mode: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Runs everything without asking · isolated environments only',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Codex permission modes (OpenAI Codex SDK)
const CODEX_MODES: ModeOption[] = [
  {
    mode: 'ask',
    label: 'Untrusted',
    description: 'Only runs trusted read commands · for maximum caution',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'auto',
    label: 'On request',
    description: 'Asks before risky commands · for trusted everyday work',
    icon: <SafetyOutlined />,
    tone: 'success',
  },
  {
    mode: 'on-failure',
    label: 'On failure',
    description: 'Runs commands, asks only when they fail · for fast iteration',
    icon: <EditOutlined />,
    tone: 'warning',
  },
  {
    mode: 'allow-all',
    label: 'Never ask',
    description: 'Runs everything without asking · isolated environments only',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Gemini permission modes (Google Gemini SDK - native ApprovalMode values)
const GEMINI_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'Manual',
    description: 'Asks before every tool use · for high-stakes changes',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'autoEdit',
    label: 'Accept edits',
    description: 'Auto-approves file edits, asks for shell/web · for reviewed code',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'yolo',
    label: 'Bypass permissions',
    description: 'Runs everything without asking · isolated environments only',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Copilot autonomous permission modes.
const COPILOT_MODES: ModeOption[] = [
  {
    mode: 'default',
    label: 'Manual',
    description: 'Proxies every approval to Disco · for high-stakes changes',
    icon: <LockOutlined />,
    tone: 'danger',
  },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    description: 'Auto-approves read/write, asks for shell/MCP · for reviewed code',
    icon: <EditOutlined />,
    tone: 'success',
  },
  {
    mode: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Runs everything without asking · isolated environments only',
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

// Cursor SDK is currently autonomous in Disco: @cursor/sdk does not expose a
// blocking permission callback that we can proxy to the Disco UI. Keep the UI
// honest by showing only the effective mode instead of borrowed Copilot modes.
const CURSOR_MODES: ModeOption[] = [
  {
    mode: 'bypassPermissions',
    label: 'Autonomous',
    description: "Cursor SDK runs on its own · Disco can't intercept approvals yet",
    icon: <UnlockOutlined />,
    tone: 'warning',
  },
];

const ZH_MODE_LABELS: Record<string, string> = {
  Manual: '手动确认',
  Plan: '仅规划',
  'Accept edits': '自动接受编辑',
  Auto: '自动',
  'Bypass permissions': '不询问',
  Untrusted: '不受信任',
  'On request': '按需询问',
  'On failure': '失败时询问',
  'Never ask': '从不询问',
  Autonomous: '自动运行',
};

const ZH_MODE_DESCRIPTIONS: Record<string, string> = {
  'Asks before every tool use · for high-stakes changes': '每次使用工具前都询问 · 适合高风险修改',
  'Explores and plans, runs nothing · for scoping work first':
    '只探索和制定计划，不执行操作 · 适合先确认范围',
  'Auto-approves file edits · for code you review in the diff':
    '自动批准文件编辑 · 适合会检查差异的代码任务',
  'Approves routine steps, asks when unsure · for trusted work':
    '自动执行常规步骤，不确定时询问 · 适合可信任务',
  'Runs everything without asking · isolated environments only':
    '执行所有操作且不询问 · 仅适合可信环境',
  'Only runs trusted read commands · for maximum caution': '仅运行可信的只读命令 · 最谨慎',
  'Asks before risky commands · for trusted everyday work': '风险命令前询问 · 适合日常可信任务',
  'Runs commands, asks only when they fail · for fast iteration':
    '直接运行命令，仅在失败时询问 · 适合快速迭代',
  'Auto-approves file edits, asks for shell/web · for reviewed code':
    '自动批准文件编辑，命令和网页操作仍询问 · 适合会复查的代码任务',
  'Proxies every approval to Disco · for high-stakes changes':
    '所有审批都交给 Disco · 适合高风险修改',
  'Auto-approves read/write, asks for shell/MCP · for reviewed code':
    '自动批准文件读写，命令和 MCP 操作仍询问 · 适合会复查的代码任务',
  "Cursor SDK runs on its own · Disco can't intercept approvals yet":
    'Cursor SDK 自动运行 · Disco 暂时无法拦截审批',
};

const localizeMode = (option: ModeOption, locale: AppLocale): ModeOption =>
  locale === 'zh-CN'
    ? {
        ...option,
        label: ZH_MODE_LABELS[option.label] ?? option.label,
        description: ZH_MODE_DESCRIPTIONS[option.description] ?? option.description,
      }
    : option;

// Codex sandbox mode options
export const CODEX_SANDBOX_MODES = [
  {
    value: 'read-only',
    label: 'read-only',
    description: 'No filesystem writes',
  },
  {
    value: 'workspace-write',
    label: 'workspace-write',
    description: 'Workspace files only (blocks .git/)',
  },
  {
    value: 'danger-full-access',
    label: 'full-access',
    description: 'Full filesystem (including .git/)',
  },
];

// Codex approval policy options
export const CODEX_APPROVAL_POLICIES = [
  {
    value: 'untrusted',
    label: 'untrusted',
    description: 'Ask for every operation',
  },
  {
    value: 'on-request',
    label: 'on-request',
    description: 'Model decides when to ask',
  },
  {
    value: 'on-failure',
    label: 'on-failure',
    description: 'Ask only on failures',
  },
  {
    value: 'never',
    label: 'never',
    description: 'Auto-approve everything',
  },
];

/** Get the mode options for a given agentic tool */
const getModesForTool = (
  tool: PermissionModeSelectorProps['agentic_tool'],
  locale: AppLocale = 'en-US'
): ModeOption[] => {
  const contributedModes = tool ? getAgenticToolUIIntegration(tool)?.permissionModes : undefined;
  if (contributedModes) {
    const icons = {
      lock: <LockOutlined />,
      edit: <EditOutlined />,
      unlock: <UnlockOutlined />,
    };
    return contributedModes.map((option) =>
      localizeMode({ ...option, icon: icons[option.icon] }, locale)
    );
  }
  let modes: ModeOption[];
  switch (tool) {
    case 'codex':
      modes = CODEX_MODES;
      break;
    case 'gemini':
      modes = GEMINI_MODES;
      break;
    case 'copilot':
      modes = COPILOT_MODES;
      break;
    case 'cursor':
      modes = CURSOR_MODES;
      break;
    default:
      modes = CLAUDE_CODE_MODES;
  }
  return modes.map((option) => localizeMode(option, locale));
};

/** Human-readable label for a raw permission mode value (for inline summaries). */
export const getPermissionModeLabel = (
  tool: PermissionModeSelectorProps['agentic_tool'],
  mode: PermissionMode,
  locale: AppLocale = 'en-US'
): string => getModesForTool(tool, locale).find((option) => option.mode === mode)?.label ?? mode;

/** Full option metadata (label/icon/tone) for a mode, for chip-style rendering. */
export const getPermissionModeMeta = (
  tool: PermissionModeSelectorProps['agentic_tool'],
  mode: PermissionMode
): ModeOption | undefined => getModesForTool(tool).find((option) => option.mode === mode);

export const getPermissionModeColor = (tone: ModeOption['tone'], token: GlobalToken): string =>
  getModeColor(tone, token);

const getModeColor = (tone: ModeOption['tone'], token: GlobalToken): string => {
  switch (tone) {
    case 'danger':
      return token.colorError;
    case 'success':
      return token.colorSuccess;
    case 'info':
      return token.colorInfo;
    case 'warning':
      return token.colorWarning;
  }
};

export const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  value,
  onChange,
  agentic_tool = 'claude-code',
  compact = false,
  iconOnly = false,
  plain = false,
  fullWidth = false,
  size = 'middle',
  codexSandboxMode,
  codexApprovalPolicy,
  onCodexChange,
}) => {
  const { locale } = useLocale();
  const { token } = theme.useToken();
  const modes = getModesForTool(agentic_tool, locale);
  const effectiveValue =
    agentic_tool === 'cursor'
      ? 'bypassPermissions'
      : value || getDefaultPermissionMode(agentic_tool);
  // Fill Codex prop defaults from the resolved mode so the dropdown shows
  // the same values the executor will actually run with for a session
  // missing explicit sub-config.
  const codexDefaults = mapToCodexPermissionConfig(effectiveValue);
  const effectiveCodexSandboxMode = codexSandboxMode ?? codexDefaults.sandboxMode;
  const effectiveCodexApprovalPolicy = codexApprovalPolicy ?? codexDefaults.approvalPolicy;

  // Codex dual-control (compact only): sandbox + approval dropdowns
  // (used by SessionPanel for inline Codex controls).
  if (compact && agentic_tool === 'codex' && onCodexChange) {
    return (
      <Space size={4} direction={fullWidth ? 'vertical' : 'horizontal'} style={{ width: '100%' }}>
        <Select
          value={effectiveCodexSandboxMode}
          onChange={(val) => onCodexChange(val, effectiveCodexApprovalPolicy)}
          size={size}
          placeholder={locale === 'zh-CN' ? '沙箱' : 'Sandbox'}
          popupMatchSelectWidth={false}
          style={{
            minWidth: 70,
            width: fullWidth ? '100%' : undefined,
            fontSize: token.fontSizeSM,
          }}
          optionLabelProp="label"
          options={CODEX_SANDBOX_MODES.map(({ value, label, description }) => ({
            label,
            value,
            title:
              locale === 'zh-CN'
                ? value === 'read-only'
                  ? '不能写入文件'
                  : value === 'workspace-write'
                    ? '仅可写入工作区文件'
                    : '可访问完整文件系统'
                : description,
          }))}
          optionRender={(option) => (
            <div style={{ lineHeight: 1.3 }}>
              <div>{option.label}</div>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {option.data.title}
              </Typography.Text>
            </div>
          )}
        />
        <Select
          value={effectiveCodexApprovalPolicy}
          onChange={(val) => onCodexChange(effectiveCodexSandboxMode, val)}
          size={size}
          placeholder={locale === 'zh-CN' ? '审批' : 'Approval'}
          popupMatchSelectWidth={false}
          style={{
            minWidth: 70,
            width: fullWidth ? '100%' : undefined,
            fontSize: token.fontSizeSM,
          }}
          optionLabelProp="label"
          options={CODEX_APPROVAL_POLICIES.map(({ value, label, description }) => ({
            label,
            value,
            title:
              locale === 'zh-CN'
                ? value === 'untrusted'
                  ? '每次操作都询问'
                  : value === 'on-request'
                    ? '由模型判断何时询问'
                    : value === 'on-failure'
                      ? '仅在失败时询问'
                      : '自动批准所有操作'
                : description,
          }))}
          optionRender={(option) => (
            <div style={{ lineHeight: 1.3 }}>
              <div>{option.label}</div>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {option.data.title}
              </Typography.Text>
            </div>
          )}
        />
      </Space>
    );
  }

  // Everything else is one rich Select. Full-width form contexts (non-compact)
  // show the two-part description and the raw mode value; tight toolbar
  // contexts (compact) collapse to an icon or plain label via `iconOnly`/`plain`.
  const effectiveFullWidth = fullWidth || !compact;
  const currentMode = modes.find((m) => m.mode === effectiveValue);
  return (
    <Tooltip
      title={
        currentMode
          ? `${currentMode.label} — ${currentMode.description}`
          : locale === 'zh-CN'
            ? '执行权限'
            : 'Permission mode'
      }
    >
      <Select
        value={effectiveValue}
        onChange={onChange}
        style={{ fontSize: token.fontSizeSM, width: effectiveFullWidth ? '100%' : undefined }}
        size={size}
        popupMatchSelectWidth={false}
        optionLabelProp="label"
        options={modes.map(({ mode, label, description, icon, tone }) => {
          const color = getModeColor(tone, token);
          return {
            label: plain ? (
              label
            ) : iconOnly ? (
              <span style={{ color, fontSize: token.fontSizeSM }}>{icon}</span>
            ) : (
              <Space size={token.marginXXS} style={{ fontSize: token.fontSizeSM }}>
                <span style={{ color }}>{icon}</span>
                <span>{label}</span>
              </Space>
            ),
            value: mode,
            title: description,
          };
        })}
        optionRender={(option) => {
          const modeData = modes.find((m) => m.mode === option.value);
          if (!modeData) return null;
          const color = getModeColor(modeData.tone, token);
          return (
            <Flex
              justify="space-between"
              align="start"
              gap={12}
              style={{ minWidth: iconOnly ? undefined : 260 }}
            >
              <Space size={6} align="start">
                <span style={{ color }}>{modeData.icon}</span>
                {/* whiteSpace:normal lets the two-part description wrap instead
                    of truncating with antd's default option ellipsis. */}
                <div style={{ lineHeight: 1.3, whiteSpace: 'normal' }}>
                  <div style={{ color: modeData.tone === 'warning' ? color : undefined }}>
                    {modeData.label}
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'normal' }}>
                    {modeData.description}
                  </Typography.Text>
                </div>
              </Space>
              {!iconOnly && (
                <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                  {modeData.mode}
                </Typography.Text>
              )}
            </Flex>
          );
        }}
      />
    </Tooltip>
  );
};
