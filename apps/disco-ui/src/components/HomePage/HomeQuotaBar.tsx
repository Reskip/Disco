import type { CodexWeeklyQuota } from '@disco/core/types';
import type { DiscoClient } from '@disco-live/client';
import { Card, Progress, Skeleton, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';

const UNAVAILABLE: CodexWeeklyQuota = {
  status: 'unavailable',
  remainingPercent: null,
  resetsAt: null,
};

export function formatQuotaReset(value: string | null): string {
  if (!value) return '重置时间暂不可用';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  return `${part('month')} 月 ${part('day')} 日 ${part('hour')}:${part('minute')} 重置`;
}

export function HomeQuotaBar({
  client,
  connected,
  currentUserId,
}: {
  client: DiscoClient | null;
  connected?: boolean;
  currentUserId?: string;
}) {
  const { token } = theme.useToken();
  const [quota, setQuota] = useState<CodexWeeklyQuota | null>(null);
  useEffect(() => {
    setQuota(null);
    if (!client || !connected || !currentUserId) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const result = await client.service('codex-quota').find();
        if (!disposed) setQuota(result);
      } catch {
        if (!disposed) setQuota(UNAVAILABLE);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    const onVisible = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [client, connected, currentUserId]);
  const remaining = quota?.status === 'ready' ? quota.remainingPercent : null;

  return (
    <Card
      size="small"
      className="disco-home-quota"
      aria-label="本周额度"
      styles={{ body: { padding: '10px 14px' } }}
      style={{ marginBottom: token.marginMD, borderRadius: token.borderRadiusLG }}
    >
      <div className="disco-home-quota-row">
        <Typography.Text
          strong
          className="disco-home-quota-title"
          style={{ whiteSpace: 'nowrap', fontSize: 13 }}
        >
          本周额度
        </Typography.Text>
        <Typography.Text
          type="secondary"
          className="disco-home-quota-value"
          style={{ whiteSpace: 'nowrap', fontSize: 12 }}
        >
          {remaining === null ? (
            quota ? (
              '暂无数据'
            ) : (
              '读取中…'
            )
          ) : (
            <>
              剩余{' '}
              <Typography.Text strong style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(remaining)}
                <span style={{ fontSize: 12 }}>%</span>
              </Typography.Text>
            </>
          )}
        </Typography.Text>
        <div className="disco-home-quota-track" style={{ minWidth: 0, lineHeight: 0 }}>
          {remaining === null ? (
            <Skeleton.Input active={false} block style={{ height: 5, minWidth: 0 }} />
          ) : (
            <Progress
              percent={remaining}
              showInfo={false}
              strokeWidth={5}
              strokeColor={token.colorPrimary}
              trailColor={token.colorFillSecondary}
              aria-label="主额度剩余比例"
            />
          )}
        </div>
        <Typography.Text
          type="secondary"
          className="disco-home-quota-reset"
          style={{ whiteSpace: 'nowrap', fontSize: 12 }}
        >
          {quota?.status === 'ready' ? formatQuotaReset(quota.resetsAt) : ' '}
        </Typography.Text>
      </div>
    </Card>
  );
}
