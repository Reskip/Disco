import { ReloadOutlined } from '@ant-design/icons';
import type { RuntimeCapabilityCatalog, RuntimeCapabilityDefinition } from '@disco/core';
import { Alert, Button, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { type FC, useMemo, useState } from 'react';

const PROVIDER_LABELS: Record<RuntimeCapabilityDefinition['provider'], string> = {
  'codex-native': 'Codex 原生',
  'disco-mcp': 'Disco MCP',
  'client-dynamic': '客户端动态',
  'ui-only': '网页 UI',
};

const EXPOSURE_LABELS: Record<RuntimeCapabilityDefinition['exposure'], string> = {
  'agent-callable': 'Agent 可调用',
  'runtime-internal': '运行时内部',
  'runtime-event': '运行事件',
  'ui-only': '仅网页',
};

const AUDIENCE_LABELS: Record<RuntimeCapabilityDefinition['audiences'][number], string> = {
  standalone: '独立会话',
  agent: '智能体',
  admin: '管理员',
  ui: '网页',
};

export interface RuntimeCapabilitiesPanelProps {
  catalog: RuntimeCapabilityCatalog | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onDismissError: () => void;
}

export const RuntimeCapabilitiesPanel: FC<RuntimeCapabilitiesPanelProps> = ({
  catalog,
  loading,
  error,
  onRefresh,
  onDismissError,
}) => {
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState<'all' | RuntimeCapabilityDefinition['provider']>('all');

  const entries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (catalog?.entries ?? []).filter((entry) => {
      if (provider !== 'all' && entry.provider !== provider) return false;
      if (!query) return true;
      return [
        entry.id,
        entry.name,
        entry.description,
        entry.provider,
        entry.exposure,
        entry.ownership,
        ...entry.audiences,
        ...entry.outputKinds,
        ...entry.dependencies,
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [catalog?.entries, provider, search]);

  return (
    <div className="disco-runtime-capabilities-panel">
      <div className="disco-settings-panel-heading">
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            运行能力目录
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
            直接来自当前后端的真实注册结果，只读展示 Codex、Disco MCP、动态工具和网页能力。
          </Typography.Paragraph>
        </div>
        <Button
          aria-label="刷新运行能力目录"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={onRefresh}
        >
          刷新
        </Button>
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          closable
          message="能力目录加载失败"
          description={error}
          onClose={onDismissError}
        />
      )}

      <div className="disco-runtime-capabilities-toolbar">
        <Input.Search
          allowClear
          aria-label="搜索运行能力"
          placeholder="搜索方法、范围或输出类型"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          aria-label="按提供方筛选运行能力"
          value={provider}
          onChange={setProvider}
          options={[
            { value: 'all', label: '全部提供方' },
            ...Object.entries(PROVIDER_LABELS).map(([value, label]) => ({ value, label })),
          ]}
        />
      </div>

      <div className="disco-runtime-capabilities-summary">
        <Typography.Text strong>{entries.length} 项</Typography.Text>
        {catalog && (
          <Typography.Text type="secondary">
            目录指纹 <Typography.Text code>{catalog.fingerprint.slice(0, 12)}</Typography.Text>
          </Typography.Text>
        )}
      </div>

      <Spin spinning={loading && !catalog} className="disco-runtime-capabilities-loading">
        <div className="disco-runtime-capabilities-list" role="list" aria-label="运行能力目录">
          {entries.map((entry) => (
            <div key={entry.id} className="disco-runtime-capability-row" role="listitem">
              <div className="disco-runtime-capability-main">
                <Space size={6} wrap>
                  <Typography.Text strong>{entry.name}</Typography.Text>
                  <Tag>{PROVIDER_LABELS[entry.provider]}</Tag>
                  <Tag color={entry.exposure === 'agent-callable' ? 'gold' : undefined}>
                    {EXPOSURE_LABELS[entry.exposure]}
                  </Tag>
                </Space>
                <Typography.Text type="secondary" className="disco-runtime-capability-description">
                  {entry.description}
                </Typography.Text>
              </div>
              <div className="disco-runtime-capability-meta">
                <span>{entry.audiences.map((value) => AUDIENCE_LABELS[value]).join('、')}</span>
                <span>归属：{entry.ownership}</span>
                <span>输出：{entry.outputKinds.join(' / ')}</span>
              </div>
            </div>
          ))}
          {!loading && entries.length === 0 && (
            <Typography.Text type="secondary" className="disco-runtime-capabilities-empty">
              没有符合当前筛选条件的能力。
            </Typography.Text>
          )}
        </div>
      </Spin>
    </div>
  );
};
