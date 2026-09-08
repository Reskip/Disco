/**
 * PermissionRequestBlock - Displays a permission request awaiting approval
 *
 * Shows:
 * - Tool name and description
 * - Tool input parameters in readable format
 * - Approve/Deny action buttons
 * - Visual indication that system is waiting
 */

import {
  type Message,
  type PermissionRequestContent,
  PermissionScope,
  PermissionStatus,
} from '@disco-live/client';
import { CheckOutlined, ClockCircleOutlined, CloseOutlined, LockOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Radio, Select, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { getToolDisplayName } from '../../utils/toolDisplayName';
import { Tag } from '../Tag';

const { Title, Paragraph } = Typography;

interface PermissionRequestBlockProps {
  message: Message;
  content: PermissionRequestContent;
  isActive: boolean; // true if awaiting decision and can interact
  isWaiting?: boolean; // true if pending but waiting for previous permission
  agenticTool?: string; // Agent type for scope-aware UI
  onApprove?: (messageId: string, scope: PermissionScope) => void;
  onDeny?: (messageId: string) => void;
}

/**
 * Whether the agent supports persistent permission scopes (saved to disk).
 * Claude Code persists to .claude/settings.json; other agents only support session-level.
 */
function supportsPersistentScopes(agenticTool?: string): boolean {
  return agenticTool === 'claude-code' || !agenticTool;
}

export const PermissionRequestBlock: React.FC<PermissionRequestBlockProps> = ({
  message,
  content,
  isActive,
  isWaiting = false,
  agenticTool,
  onApprove,
  onDeny,
}) => {
  const { token } = theme.useToken();
  const [remember, setRemember] = useState<boolean>(false);
  const [rememberScope, setRememberScope] = useState<PermissionScope>(PermissionScope.PROJECT);

  const { tool_name, tool_input, status, approved_at } = content;

  // Determine the state: active, approved, denied, timed out, or waiting
  const isApproved = status === PermissionStatus.APPROVED;
  const isDenied = status === PermissionStatus.DENIED;
  const isTimedOut = status === PermissionStatus.TIMED_OUT;

  // State-based styling
  const getStateStyle = () => {
    if (isWaiting) {
      return {
        background: token.colorFillSecondary,
        border: `1px solid ${token.colorBorder}`,
        opacity: 0.7,
      };
    }
    if (isTimedOut) {
      return {
        background: token.colorWarningBg,
        border: `1px solid ${token.colorWarningBorder}`,
      };
    }
    if (isActive) {
      return {
        background: token.colorWarningBg,
        border: `1px solid ${token.colorWarningBorder}`,
      };
    }
    if (isApproved) {
      return {
        background: token.colorSuccessBg,
        border: `1px solid ${token.colorSuccessBorder}`,
      };
    }
    if (isDenied) {
      return {
        background: token.colorErrorBg,
        border: `1px solid ${token.colorErrorBorder}`,
      };
    }
    return {};
  };

  const getIcon = () => {
    if (isTimedOut)
      return <ClockCircleOutlined style={{ fontSize: 20, color: token.colorWarning }} />;
    if (isActive) return <LockOutlined style={{ fontSize: 20, color: token.colorWarning }} />;
    if (isApproved) return <CheckOutlined style={{ fontSize: 20, color: token.colorSuccess }} />;
    if (isDenied) return <CloseOutlined style={{ fontSize: 20, color: token.colorError }} />;
    return null;
  };

  const getTitle = () => {
    if (isTimedOut) return '权限请求已超时';
    if (isWaiting) return '正在等待上一项权限决定';
    if (isActive) return '需要你的授权';
    if (isApproved) return '已允许';
    if (isDenied) return '已拒绝';
    return '权限请求';
  };

  const getSubtitle = () => {
    if (isTimedOut) return '请让智能体重试';
    if (isActive) return '智能体需要你的允许才能继续';
    if (isApproved && approved_at) {
      return `允许于 ${new Date(approved_at).toLocaleString('zh-CN')}`;
    }
    if (isDenied && approved_at) {
      return `拒绝于 ${new Date(approved_at).toLocaleString('zh-CN')}`;
    }
    return '';
  };

  return (
    <Card
      style={{
        marginTop: token.sizeUnit * 2,
        ...getStateStyle(),
      }}
      styles={{
        body: {
          padding: token.sizeUnit * 2,
        },
      }}
    >
      <Space orientation="vertical" size={token.sizeUnit * 1.5} style={{ width: '100%' }}>
        {/* Header */}
        <Space size={token.sizeUnit}>
          {getIcon()}
          <div>
            <Title level={5} style={{ margin: 0 }}>
              {getTitle()}
            </Title>
            {getSubtitle() && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {getSubtitle()}
              </Typography.Text>
            )}
          </div>
        </Space>

        {/* Tool Details */}
        <div>
          <Space size={token.sizeUnit / 2}>
            <Typography.Text strong>工具：</Typography.Text>
            <Tag color="blue">{getToolDisplayName(tool_name, tool_input)}</Tag>
          </Space>
        </div>

        {/* Tool Input - show only if active or in detailed view */}
        {isActive && Object.keys(tool_input).length > 0 && (
          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              参数：
            </Typography.Text>
            <Descriptions
              size="small"
              column={1}
              bordered
              style={{
                marginTop: token.sizeUnit,
              }}
              items={Object.entries(tool_input).map(([key, value]) => ({
                key,
                label: (
                  <Typography.Text code style={{ fontSize: 11 }}>
                    {key}
                  </Typography.Text>
                ),
                children: (
                  <Paragraph
                    code
                    style={{
                      fontSize: 12,
                      margin: 0,
                      padding: token.sizeUnit,
                      backgroundColor: token.colorBgContainer,
                      borderRadius: token.borderRadius,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                  </Paragraph>
                ),
              }))}
            />
          </div>
        )}

        {/* Timestamp - show only for active requests */}
        {isActive && message.timestamp && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            请求时间：{new Date(message.timestamp).toLocaleString('zh-CN')}
          </Typography.Text>
        )}

        {/* Action Buttons - show only when active */}
        {isActive && onApprove && onDeny && (
          <Space orientation="vertical" size={token.sizeUnit} style={{ width: '100%' }}>
            {/* Radio group for remember choice */}
            {supportsPersistentScopes(agenticTool) && (
              <Radio.Group
                value={remember}
                onChange={(e) => setRemember(e.target.value)}
                style={{ width: '100%' }}
              >
                <Space orientation="vertical" size={token.sizeUnit / 2} style={{ width: '100%' }}>
                  <Radio value={false}>仅允许这一次</Radio>
                  <Space size={token.sizeUnit / 2} style={{ width: '100%', alignItems: 'center' }}>
                    <Radio value={true}>记住此决定：</Radio>
                    <Select
                      value={rememberScope}
                      onChange={setRememberScope}
                      disabled={!remember}
                      style={{ width: 200 }}
                      size="small"
                      options={[
                        { value: PermissionScope.PROJECT, label: '当前项目（.claude/）' },
                        { value: PermissionScope.USER, label: '当前用户（~/.claude/）' },
                        { value: PermissionScope.LOCAL, label: '仅本机（不提交 Git）' },
                      ]}
                    />
                  </Space>
                </Space>
              </Radio.Group>
            )}

            {/* Action buttons */}
            <Space size={token.sizeUnit}>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={() =>
                  onApprove?.(message.message_id, remember ? rememberScope : PermissionScope.ONCE)
                }
                style={{ backgroundColor: token.colorSuccess }}
              >
                允许
              </Button>
              <Button danger icon={<CloseOutlined />} onClick={() => onDeny?.(message.message_id)}>
                拒绝
              </Button>
            </Space>
          </Space>
        )}
      </Space>
    </Card>
  );
};
