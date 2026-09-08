/**
 * WidgetBlock — in-conversation widget dispatcher.
 *
 * Switches on `message.metadata.widget.widget_type` and renders the matching
 * widget component. In PR 1 the client-side widget registry is empty; the
 * fallback renders an "Unknown widget type" placeholder so newer servers
 * that ship widget types unknown to an older client degrade gracefully
 * instead of crashing.
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import type { DiscoClient, Message, WidgetMessageMetadata, WidgetType } from '@disco-live/client';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import { Card, Space, Typography, theme } from 'antd';
import type React from 'react';

const { Text } = Typography;

export interface WidgetComponentProps {
  message: Message;
  widget: WidgetMessageMetadata;
  /**
   * Authenticated Feathers client. Widget components MUST submit via
   * `client.service(...).create(...)` rather than raw fetch so the
   * built-in 401 refresh/retry hook applies and tokens stay in sync.
   * `null` if no session is active.
   */
  client: DiscoClient | null;
}

/**
 * Per-widget-type renderers. Each widget type registers itself via
 * `registerWidgetComponent` at module load. PR 1 ships an empty registry;
 * PR 2 (env_vars), PR 3 (confirmation), etc. populate it.
 */
const widgetComponents = new Map<WidgetType, React.FC<WidgetComponentProps>>();

export function registerWidgetComponent(
  type: WidgetType,
  component: React.FC<WidgetComponentProps>
): void {
  widgetComponents.set(type, component);
}

interface WidgetBlockProps {
  message: Message;
  client: DiscoClient | null;
}

/**
 * Render a `type === 'widget_request'` message. Looks up the registered
 * component for `widget.widget_type`; falls back to a forward-compat
 * placeholder.
 */
export const WidgetBlock: React.FC<WidgetBlockProps> = ({ message, client }) => {
  const { token } = theme.useToken();
  const widget = message.metadata?.widget;

  if (!widget) {
    // Defensive: a widget_request message should always have metadata.widget;
    // if it doesn't, render nothing rather than crashing the transcript.
    return null;
  }

  if (widget.status === 'resolving') {
    return (
      <Card
        size="small"
        style={{
          margin: `${token.sizeUnit * 1.5}px 0`,
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorder}`,
        }}
      >
        <Space>
          <ExclamationCircleOutlined style={{ color: token.colorTextSecondary }} />
          <Space direction="vertical" size={0}>
            <Text strong>正在完成请求</Text>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              该请求已在处理中。
            </Text>
          </Space>
        </Space>
      </Card>
    );
  }

  const Component = widgetComponents.get(widget.widget_type);

  if (!Component) {
    return (
      <Card
        size="small"
        style={{
          margin: `${token.sizeUnit * 1.5}px 0`,
          background: token.colorBgContainer,
          border: `1px dashed ${token.colorBorder}`,
        }}
      >
        <Space>
          <ExclamationCircleOutlined style={{ color: token.colorWarning }} />
          <Space direction="vertical" size={0}>
            <Text strong>无法显示该交互控件，请更新客户端</Text>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              AI 请求了 <code>{widget.widget_type}</code> 控件，但当前客户端不支持。 状态：
              {renderStatusBadge(widget.status)}
            </Text>
          </Space>
        </Space>
      </Card>
    );
  }

  return <Component message={message} widget={widget} client={client} />;
};

function renderStatusBadge(status: WidgetMessageMetadata['status']): React.ReactNode {
  switch (status) {
    case 'submitted':
      return (
        <>
          <CheckCircleOutlined /> 已提交
        </>
      );
    case 'dismissed':
      return (
        <>
          <MinusCircleOutlined /> 已关闭
        </>
      );
    case 'already_present':
      return (
        <>
          <CheckCircleOutlined /> 已配置
        </>
      );
    case 'resolving':
      return <Text>处理中</Text>;
    default:
      return <Text>等待中</Text>;
  }
}

/**
 * Public helper used by tests / future PRs to inspect registry state. Not
 * intended for use in production rendering — components should always
 * dispatch through `WidgetBlock`.
 */
export function _listRegisteredWidgetTypes(): WidgetType[] {
  return Array.from(widgetComponents.keys());
}
