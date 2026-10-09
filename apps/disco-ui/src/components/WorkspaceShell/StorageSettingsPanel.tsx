import { resolveIntermediateRetentionDays } from '@disco/core/types';
import type { DiscoClient, UpdateUserInput, User } from '@disco-live/client';
import { Alert, Button, Form, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

export function StorageSettingsPanel({
  currentUser,
  client,
  onUpdateUser,
}: {
  currentUser?: User | null;
  client?: DiscoClient | null;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void | Promise<void>;
}) {
  const [days, setDays] = useState(resolveIntermediateRetentionDays(currentUser?.preferences));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const storedDays = resolveIntermediateRetentionDays(currentUser?.preferences);
  useEffect(() => {
    setDays(storedDays);
  }, [storedDays]);

  const save = async () => {
    if (!currentUser || !onUpdateUser) return;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      // Preserve preferences changed in another settings section since this
      // panel opened; a failed read must not overwrite them with stale data.
      const latest = client ? await client.service('users').get(currentUser.user_id) : currentUser;
      await onUpdateUser(currentUser.user_id, {
        preferences: {
          ...latest.preferences,
          storage: { ...latest.preferences?.storage, intermediateRetentionDays: days },
        },
      });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          存储
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          聊天中展示的图片和预览、可下载附件、上传文件及可编辑源文件长期保留。
        </Typography.Paragraph>
      </div>
      <Form layout="vertical">
        <Form.Item
          label="临时文件与缓存保留时间"
          extra="只清理未展示、未提供下载链接的临时中间文件和可再生成的缓存；运行中的任务会跳过。"
        >
          <Select
            aria-label="临时文件与缓存保留时间"
            style={{ width: 'min(100%, 240px)' }}
            value={days}
            disabled={saving}
            onChange={(value) => {
              setDays(value);
              setSaved(false);
            }}
            options={Array.from(new Set([1, 3, 7, 14, 30, 90, days]))
              .filter((value) => value !== 0)
              .sort((a, b) => a - b)
              .map((value) => ({ value, label: `${value} 天` }))
              .concat([{ value: 0, label: '不自动清理' }])}
          />
        </Form.Item>
        <Button
          type="primary"
          loading={saving}
          disabled={!currentUser || !onUpdateUser}
          onClick={() => void save()}
        >
          保存存储设置
        </Button>
      </Form>
      {saved && <Alert type="success" title="存储设置已保存" showIcon />}
      {error && <Alert type="error" title={error} showIcon />}
    </Space>
  );
}
