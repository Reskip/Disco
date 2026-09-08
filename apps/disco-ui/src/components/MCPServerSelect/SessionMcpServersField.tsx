import type { MCPServer } from '@disco-live/client';
import { Form } from 'antd';
import { mapToArray } from '@/utils/mapHelpers';
import { useLocale } from '../../contexts/LocaleContext';
import { MCPServerSelect } from './MCPServerSelect';

export interface SessionMcpServersFieldProps {
  mcpServerById: Map<string, MCPServer>;
  showHelpText?: boolean;
}

/**
 * MCP servers picker as a first-class form field.
 *
 * Bundles the `Form.Item` shell so callers (NewSessionModal,
 * AgenticToolConfigForm, …)
 * can drop a single component wherever they need MCP selection — primary
 * zone or collapsed advanced section — without duplicating the gate.
 */
export const SessionMcpServersField: React.FC<SessionMcpServersFieldProps> = ({
  mcpServerById,
  showHelpText = false,
}) => {
  const { locale } = useLocale();
  const isChinese = locale === 'zh-CN';
  return (
    <Form.Item
      name="mcpServerIds"
      label={isChinese ? 'MCP 服务' : 'MCP Servers'}
      help={
        showHelpText
          ? isChinese
            ? '选择本次运行可使用的 MCP 服务'
            : 'Select MCP servers to make available in this session'
          : undefined
      }
    >
      <MCPServerSelect
        mcpServers={mapToArray(mcpServerById)}
        placeholder={isChinese ? '未添加 MCP 服务' : 'No MCP servers attached'}
      />
    </Form.Item>
  );
};
