import type { DiscoClient } from '@disco-live/client';
import { useCodexModels } from '../../hooks/useCodexModels';
/**
 * EffortSelector - Compact selector for reasoning effort level
 *
 * Effort controls how much reasoning the agent applies to responses.
 * Runtime adapters map the shared value to their native effort option.
 *
 * Levels:
 * - Low: Minimal thinking, fastest responses
 * - Medium: Moderate thinking
 * - High: Deep reasoning
 * - X-High: Extra reasoning depth, below maximum
 * - Max: Highest effort level (model-dependent)
 */

import { BulbOutlined } from '@ant-design/icons';
import type { EffortLevel } from '@disco-live/client';
import { Button, Select, Space, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { type TranslationKey, useLocale } from '../../contexts/LocaleContext';

interface EffortSelectorProps {
  codexModel?: string;
  client?: DiscoClient | null;
  catalogEnabled?: boolean;
  value?: EffortLevel;
  onChange?: (effort: EffortLevel | undefined) => void;
  levels?: readonly EffortLevel[];
  fallbackValue?: EffortLevel;
  allowInherited?: boolean;
  size?: 'small' | 'middle' | 'large';
  compact?: boolean;
  plain?: boolean;
  fullWidth?: boolean;
}

const EFFORT_OPTIONS: {
  value: EffortLevel;
  shortLabel: string;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}[] = [
  {
    value: 'low',
    shortLabel: 'Lo',
    labelKey: 'effortLow',
    descriptionKey: 'effortLowDescription',
  },
  {
    value: 'medium',
    shortLabel: 'Md',
    labelKey: 'effortMedium',
    descriptionKey: 'effortMediumDescription',
  },
  {
    value: 'high',
    shortLabel: 'Hi',
    labelKey: 'effortHigh',
    descriptionKey: 'effortHighDescription',
  },
  {
    value: 'xhigh',
    shortLabel: 'Xh',
    labelKey: 'effortXHigh',
    descriptionKey: 'effortXHighDescription',
  },
  {
    value: 'max',
    shortLabel: 'Mx',
    labelKey: 'effortMax',
    descriptionKey: 'effortMaxDescription',
  },
];

/**
 * EffortSelector - Dropdown for selecting a supported reasoning effort level
 */
export const EffortSelector: React.FC<EffortSelectorProps> = ({
  value,
  codexModel,
  client,
  catalogEnabled = true,
  onChange,
  levels,
  fallbackValue,
  allowInherited = false,
  size = 'middle',
  compact = false,
  plain = false,
  fullWidth = false,
}) => {
  const { token } = theme.useToken();
  const { locale, t } = useLocale();
  const { catalog } = useCodexModels(client, Boolean(codexModel) && catalogEnabled);
  const model = codexModel ? catalog.models.find((item) => item.id === codexModel) : undefined;
  const supported = model?.supportedReasoningEfforts ?? levels;
  const invalid =
    catalog.source === 'dynamic' &&
    Boolean(
      value && model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.includes(value)
    );
  const options = (
    supported ? EFFORT_OPTIONS.filter((option) => supported.includes(option.value)) : EFFORT_OPTIONS
  ).map((option) => ({
    ...option,
    shortLabel: locale === 'zh-CN' ? t(option.labelKey) : option.shortLabel,
    label: t(option.labelKey),
    description: t(option.descriptionKey),
  }));
  const resolvedValue = value ?? model?.defaultReasoningEffort ?? fallbackValue;

  if (value && !options.some((option) => option.value === value)) {
    const original = EFFORT_OPTIONS.find((option) => option.value === value);
    if (original)
      options.unshift({
        ...original,
        shortLabel: t(original.labelKey),
        label: t(original.labelKey),
        description: t(original.descriptionKey),
      });
  }
  return (
    <div>
      <Tooltip title={t('reasoningEffort')}>
        <Select
          value={resolvedValue}
          status={invalid ? 'warning' : undefined}
          onChange={onChange}
          allowClear={allowInherited}
          placeholder={allowInherited ? t('inherited') : undefined}
          size={size}
          style={{
            width: fullWidth ? '100%' : compact ? undefined : 160,
            fontSize: compact ? token.fontSize : undefined,
          }}
          popupMatchSelectWidth={false}
          optionLabelProp="label"
          options={options.map((opt) => ({
            value: opt.value,
            disabled:
              catalog.source === 'dynamic' &&
              Boolean(
                model?.supportedReasoningEfforts &&
                  !model.supportedReasoningEfforts.includes(opt.value)
              ),
            label: plain ? (
              opt.label
            ) : compact ? (
              <span style={{ fontSize: token.fontSize }}>
                <BulbOutlined style={{ fontSize: token.fontSize - 1, marginRight: 2 }} />
                {opt.shortLabel}
              </span>
            ) : (
              <span>
                <BulbOutlined style={{ fontSize: 12, marginRight: 6 }} />
                {locale === 'zh-CN' ? opt.label : `${opt.label} effort`}
              </span>
            ),
          }))}
          optionRender={(option) => {
            const opt = options.find((o) => o.value === option.value);
            return (
              <Space size={6} align="start">
                <BulbOutlined style={{ marginTop: 3 }} />
                <div style={{ lineHeight: 1.3, whiteSpace: 'normal' }}>
                  <div>{opt?.label}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'normal' }}>
                    {opt?.description}
                  </Typography.Text>
                </div>
              </Space>
            );
          }}
        />
      </Tooltip>
      {invalid && (
        <div role="status" style={{ fontSize: token.fontSizeSM, whiteSpace: 'normal' }}>
          <Typography.Text type="warning">该模型不支持当前思考深度，原设置已保留。</Typography.Text>
          {model?.defaultReasoningEffort && (
            <Button
              size="small"
              type="link"
              onClick={() => onChange?.(model.defaultReasoningEffort)}
            >
              更换为 {model.defaultReasoningEffort}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
