import { GlobalOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Space, Switch, Typography } from 'antd';
import { useLocale } from '../../contexts/LocaleContext';

export interface CodexNetworkAccessToggleProps {
  /** Value passed by parent Form.Item (legacy `value` or Switch-friendly `checked`) */
  value?: boolean;
  checked?: boolean;
  onChange?: (value: boolean) => void;
  /** Show detailed security warning */
  showWarning?: boolean;
}

/**
 * Toggle for Codex network access configuration
 *
 * Controls [sandbox_workspace_write].network_access in config.toml.
 * Only applies when sandboxMode = 'workspace-write'.
 */
export const CodexNetworkAccessToggle: React.FC<CodexNetworkAccessToggleProps> = ({
  value,
  checked,
  onChange,
  showWarning = true,
}) => {
  const { locale } = useLocale();
  const isChinese = locale === 'zh-CN';
  const isEnabled = typeof checked === 'boolean' ? checked : !!value;

  return (
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Space>
        <Switch
          checked={isEnabled}
          onChange={onChange}
          checkedChildren={<GlobalOutlined />}
          unCheckedChildren={<GlobalOutlined />}
        />
        <Typography.Text strong>
          {isChinese ? '允许访问网络' : 'Enable Network Access'}
        </Typography.Text>
        <Typography.Text type="secondary">
          {isChinese ? '（仅适用于“工作区可写”沙箱）' : '(workspace-write sandbox only)'}
        </Typography.Text>
      </Space>

      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
        {isEnabled
          ? isChinese
            ? '允许发起 HTTP/HTTPS 请求，用于安装依赖和调用 API'
            : 'Allows outbound HTTP/HTTPS requests for package installation and API calls'
          : isChinese
            ? '网络访问已关闭（默认设置）'
            : 'Network access disabled (default, most secure)'}
      </Typography.Text>

      {showWarning && isEnabled && (
        <Alert
          title={isChinese ? '安全提示' : 'Security Warning'}
          description={
            <div>
              {isChinese
                ? '启用网络访问可能带来以下风险：'
                : 'Enabling network access exposes your environment to:'}
              <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
                <li>{isChinese ? '提示词注入攻击' : 'Prompt injection attacks'}</li>
                <li>{isChinese ? '代码或密钥泄露' : 'Data exfiltration of code/secrets'}</li>
                <li>
                  {isChinese
                    ? '引入恶意软件或存在漏洞的依赖'
                    : 'Inclusion of malware or vulnerable dependencies'}
                </li>
              </ul>
              {isChinese ? '仅在可信任务中启用。' : 'Only enable for trusted tasks.'}
            </div>
          }
          type="warning"
          icon={<WarningOutlined />}
          showIcon
          style={{ marginTop: 8 }}
        />
      )}
    </Space>
  );
};
