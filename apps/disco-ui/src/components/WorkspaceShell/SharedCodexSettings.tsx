import type { DiscoClient, AuthCheckResult, CodexAuthImportResult } from '@disco-live/client';
import { Alert, Button, Popconfirm, Space, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { CodexDeviceSignIn } from '../CodexAuth/CodexDeviceSignIn';
import { CodexImportAuthJson } from '../CodexAuth/CodexImportAuthJson';

type SharedCodexView = 'status' | 'device' | 'import';

export interface SharedCodexSettingsProps {
  client?: DiscoClient | null;
  canManage: boolean;
}

export const SharedCodexSettings: React.FC<SharedCodexSettingsProps> = ({ client, canManage }) => {
  const [probe, setProbe] = useState<AuthCheckResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SharedCodexView>('status');

  const checkConnection = useCallback(async () => {
    if (!client) return;
    setProbing(true);
    setError(null);
    try {
      const result = (await client
        .service('check-auth')
        .create({ tool: 'codex', validateNative: true })) as AuthCheckResult;
      setProbe(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法检查 Codex 连接状态。');
    } finally {
      setProbing(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    void checkConnection();
  }, [checkConnection, client]);

  const markConnected = useCallback((_result?: CodexAuthImportResult) => {
    setProbe({
      status: 'authenticated',
      authenticated: true,
      method: 'oauth',
      hint: 'ChatGPT login connected.',
    });
    setView('status');
    setError(null);
  }, []);

  const removeConnection = useCallback(async () => {
    if (!client || !canManage) return;
    setRemoving(true);
    setError(null);
    try {
      await client.service('codex-auth/logout').create({});
      setProbe({ status: 'unauthenticated', authenticated: false, method: 'oauth' });
      setView('status');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法移除共享 Codex 登录。');
    } finally {
      setRemoving(false);
    }
  }, [canManage, client]);

  const connected = probe?.status === 'authenticated';

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div>
        <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 6 }}>
          共享 Codex 连接
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这台 Disco 服务器只保存一份 Codex 登录。管理员完成绑定后，所有家庭账号都能直接使用，
          无需分别登录。
        </Typography.Paragraph>
      </div>

      {connected ? (
        <Alert type="success" showIcon title="Codex 已连接" description="当前共享登录可供全部账号使用。" />
      ) : probe?.status === 'unauthenticated' ? (
        <Alert
          type="warning"
          showIcon
          title="Codex 尚未连接"
          description="请由管理员使用设备码登录，或导入现有的 auth.json。"
        />
      ) : null}

      {error ? <Alert type="error" showIcon title={error} /> : null}

      <Space wrap>
        <Button loading={probing} disabled={!client} onClick={() => void checkConnection()}>
          重新检查
        </Button>
        {canManage ? (
          <>
            <Button type={view === 'device' ? 'primary' : 'default'} onClick={() => setView('device')}>
              设备码登录
            </Button>
            <Button type={view === 'import' ? 'primary' : 'default'} onClick={() => setView('import')}>
              导入 auth.json
            </Button>
            {connected ? (
              <Popconfirm
                title="移除共享 Codex 登录？"
                description="移除后，所有 Disco 账号都会暂时无法使用 Codex。"
                okText="移除"
                cancelText="取消"
                okButtonProps={{ danger: true, loading: removing }}
                onConfirm={() => void removeConnection()}
              >
                <Button danger loading={removing}>
                  移除连接
                </Button>
              </Popconfirm>
            ) : null}
          </>
        ) : (
          <Typography.Text type="secondary">只有管理员可以更换共享登录。</Typography.Text>
        )}
      </Space>

      {canManage && view === 'device' ? (
        <CodexDeviceSignIn
          client={client ?? null}
          onVerified={markConnected}
          onUseFallback={(target) => {
            if (target === 'import') setView('import');
            else setError('设备码不可用时，请改用导入 auth.json。');
          }}
          autoStart={false}
        />
      ) : null}

      {canManage && view === 'import' ? (
        <CodexImportAuthJson
          client={client ?? null}
          onImported={markConnected}
          submitLabel="导入并共享"
        />
      ) : null}
    </Space>
  );
};
