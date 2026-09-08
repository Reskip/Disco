import {
  ClockCircleOutlined,
  PlusOutlined,
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type {
  AgenticToolCapabilities,
  AgenticToolName,
  DiscoClient,
  EffortLevel,
  Session,
} from '@disco-live/client';
import { Button, Segmented, Space, Tooltip } from 'antd';
import React from 'react';
import { MOBILE_COMPOSER_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import type { FollowUpBehavior } from '../../utils/followUpBehavior';
import { getPreferredReasoningEffort } from '../../utils/reasoningEffort';
import { EffortSelector } from '../EffortSelector';
import type { ModelConfig } from '../ModelSelector';
import { ModelSelector } from '../ModelSelector';

export interface SimpleSessionFooterProps {
  session: Session & { agentic_tool: AgenticToolName };
  currentUserId?: string;
  client: DiscoClient | null;
  toolCaps?: AgenticToolCapabilities;
  tokenBreakdown: {
    total: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    cost: number;
  };
  modelConfig?: ModelConfig;
  effortLevel?: EffortLevel;
  serviceTier: 'default' | 'fast';
  isRunning: boolean;
  isStopping: boolean;
  stopRequestInFlight: boolean;
  hasInput: boolean;
  composerAttachmentUploading?: boolean;
  composerAttachmentUploadProgress?: number | null;
  connectionDisabled: boolean;
  promptInputSlot: React.ReactNode;
  onModelConfigChange: (config: ModelConfig) => void;
  onEffortChange: (value: EffortLevel | undefined) => void;
  onServiceTierChange: (value: 'default' | 'fast') => void;
  onAttachFiles: () => void;
  onSendPrompt: (behavior?: FollowUpBehavior) => void;
  onStop: () => void;
}

export const SimpleSessionFooter = React.memo<SimpleSessionFooterProps>(
  ({
    session,
    currentUserId,
    client,
    toolCaps,
    modelConfig,
    effortLevel,
    serviceTier,
    isRunning,
    isStopping,
    stopRequestInFlight,
    hasInput,
    composerAttachmentUploading = false,
    composerAttachmentUploadProgress = null,
    connectionDisabled,
    promptInputSlot,
    onModelConfigChange,
    onEffortChange,
    onServiceTierChange,
    onAttachFiles,
    onSendPrompt,
    onStop,
  }) => {
    const mobileComposer = useMediaQuery(MOBILE_COMPOSER_QUERY);
    const [optimisticServiceTier, setOptimisticServiceTier] = React.useState(serviceTier);

    React.useEffect(() => {
      setOptimisticServiceTier(serviceTier);
    }, [serviceTier, session.session_id]);

    const managedByPreset = Boolean(session.agentic_tool_preset_id);
    const supportsEffort = Boolean(toolCaps?.reasoningEffortLevels?.length);
    const resolvedEffort =
      effortLevel ??
      getPreferredReasoningEffort(
        toolCaps?.reasoningEffortLevels,
        toolCaps?.defaultReasoningEffort
      );
    const sendDisabled = connectionDisabled || !hasInput;
    const showRuntimeAction = isRunning || isStopping || stopRequestInFlight;
    const canQueueDraft =
      !mobileComposer &&
      isRunning &&
      !isStopping &&
      !stopRequestInFlight &&
      hasInput &&
      !connectionDisabled;
    const followUpDescription = '消息会进入队列，当前任务完整结束后再自动开始';

    return (
      <div className={`disco-simple-composer${mobileComposer ? ' is-mobile-simplified' : ''}`}>
        <div className="disco-simple-composer-input">{promptInputSlot}</div>

        <div className="disco-simple-composer-toolbar">
          <Tooltip title="添加文件">
            <Button
              data-testid="upload-bar-btn"
              type="text"
              shape="circle"
              aria-label="添加文件"
              icon={<PlusOutlined />}
              disabled={connectionDisabled || composerAttachmentUploading}
              onClick={onAttachFiles}
            />
          </Tooltip>

          <div data-testid="session-controls" className="disco-simple-composer-controls">
            {!mobileComposer && (
              <div
                className="disco-simple-composer-model"
                title={managedByPreset ? '此会话由预设配置管理' : undefined}
                style={{
                  opacity: managedByPreset ? 0.65 : 1,
                  pointerEvents: managedByPreset ? 'none' : undefined,
                }}
              >
                <ModelSelector
                  value={modelConfig}
                  onChange={onModelConfigChange}
                  agentic_tool={session.agentic_tool}
                  client={client}
                  catalogEnabled={session.created_by === currentUserId}
                  compact
                />
              </div>
            )}

            {!mobileComposer && supportsEffort && toolCaps?.reasoningEffortLevels && (
              <div
                data-testid="effort-bar-control"
                title="思考深度"
                className="disco-simple-composer-effort"
                style={{
                  opacity: managedByPreset ? 0.65 : 1,
                  pointerEvents: managedByPreset ? 'none' : undefined,
                }}
              >
                <EffortSelector
                  value={resolvedEffort}
                  onChange={onEffortChange}
                  levels={toolCaps.reasoningEffortLevels}
                  fallbackValue={resolvedEffort}
                  allowInherited={false}
                  size="middle"
                  compact
                  plain
                />
              </div>
            )}

            {session.agentic_tool === 'codex' && (
              <Segmented
                data-testid="service-tier-control"
                className="disco-service-tier-control"
                size="middle"
                value={optimisticServiceTier}
                disabled={managedByPreset}
                onChange={(value) => {
                  const nextValue = value as 'default' | 'fast';
                  setOptimisticServiceTier(nextValue);
                  onServiceTierChange(nextValue);
                }}
                options={[
                  { label: '普通', value: 'default' },
                  {
                    label: (
                      <Space size={3}>
                        <ThunderboltOutlined />
                        快速
                      </Space>
                    ),
                    value: 'fast',
                  },
                ]}
              />
            )}

            {showRuntimeAction ? (
              canQueueDraft ? (
                <Tooltip title={followUpDescription}>
                  <Button
                    className="disco-follow-up-send-button is-queue"
                    type="primary"
                    shape="circle"
                    aria-label="排队消息"
                    icon={<ClockCircleOutlined />}
                    onClick={() => onSendPrompt('queue')}
                  />
                </Tooltip>
              ) : (
                <Tooltip title="停止当前任务">
                  <Button
                    danger
                    type="primary"
                    shape="circle"
                    aria-label="停止"
                    icon={<StopOutlined />}
                    loading={stopRequestInFlight}
                    onClick={onStop}
                  />
                </Tooltip>
              )
            ) : (
              <Tooltip
                title={
                  composerAttachmentUploading
                    ? `发送并等待附件就绪${
                        composerAttachmentUploadProgress == null
                          ? ''
                          : `（${composerAttachmentUploadProgress}%）`
                      }`
                    : '发送'
                }
              >
                <Button
                  type="primary"
                  shape="circle"
                  aria-label="发送"
                  icon={<SendOutlined />}
                  disabled={sendDisabled}
                  onClick={() => onSendPrompt()}
                />
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    );
  }
);

SimpleSessionFooter.displayName = 'SimpleSessionFooter';
